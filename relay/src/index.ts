/**
 * MCP relay: a small Cloudflare Worker that lets a browser page talk to MCP
 * servers that do not send CORS headers for it.
 *
 * Contract: send GET, POST or DELETE to `/` with the real target in the
 * `x-mcp-target` header (an absolute https URL). The relay forwards the method,
 * body and headers (minus hop-by-hop, cookies, Origin, Referer and proxy
 * headers), streams the response back (Server-Sent Events flow incrementally),
 * and adds CORS headers for the allowed origins.
 *
 * It stores nothing and logs only the method, target host, status and duration.
 * No runtime dependencies. Part of openapi-mcp-generator (MIT).
 */

export const TARGET_HEADER = 'x-mcp-target';
export const DEFAULT_ALLOWED_ORIGINS = 'https://mcp.pidata.tech';
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
export const MAX_STREAM_MS = 15 * 60 * 1000;
export const MAX_REDIRECTS = 5;

const EXPOSED_HEADERS = [
  'mcp-session-id',
  'mcp-protocol-version',
  'www-authenticate',
  'retry-after',
  'content-type',
  'location',
];

const ALLOWED_METHODS = ['GET', 'POST', 'DELETE'];
const ALLOWED_CONTENT_TYPES = ['application/json', 'application/x-www-form-urlencoded'];

/** Request headers that never reach the target. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'origin',
  'referer',
  'host',
  'content-length',
  'accept-encoding',
  'forwarded',
  'via',
  'x-real-ip',
  'true-client-ip',
  'priority',
  TARGET_HEADER,
]);
const STRIPPED_REQUEST_PREFIXES = ['cf-', 'x-forwarded-', 'sec-', 'access-control-'];

/** Response headers that never reach the browser. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'set-cookie2',
  'content-length',
  'content-encoding',
  'alt-svc',
  'strict-transport-security',
]);
const STRIPPED_RESPONSE_PREFIXES = ['access-control-', 'cf-'];

/** The subset of the Workers Rate Limiting binding the relay uses. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Comma- or space-separated origins allowed to use the relay. */
  ALLOWED_ORIGINS?: string;
  /** Workers Rate Limiting binding (per client IP). Optional. */
  RATE_LIMITER?: RateLimiter;
}

export interface LogEntry {
  method: string;
  host: string;
  status: number;
  ms: number;
}

export interface RelayOptions {
  /** The fetch used for upstream requests (injected in tests). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Receives one entry per relayed request. Never headers or bodies. */
  log?: (entry: LogEntry) => void;
  /** Longest a relayed response may stream, in ms. */
  maxStreamMs?: number;
}

export interface Relay {
  fetch(request: Request, env?: Env): Promise<Response>;
}

// --- target validation -------------------------------------------------------------

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Whether an IPv4 address is private, loopback, link-local, CGNAT, reserved or multicast. */
export function isBlockedIPv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Parses an IPv6 address (no brackets) into eight 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    // Rewrite an embedded IPv4 tail (::ffff:1.2.3.4) as two hex groups.
    const v4 = ipv4Parts(maybeV4);
    if (!v4 || lastColon === -1) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups = [...head, ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some((g) => Number.isNaN(g))) return null;
  const total = groups.length;
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total > 7) return null;
  const zeros = new Array(8 - total).fill(0);
  const headNums = groups.slice(0, head.length);
  const restNums = groups.slice(head.length);
  return halves.length === 2 ? [...headNums, ...zeros, ...restNums] : [...headNums, ...restNums];
}

/** Whether an IPv6 address is loopback, unspecified, ULA, link-local, multicast or maps to a blocked IPv4. */
export function isBlockedIPv6(groups: number[]): boolean {
  const allZeroUntil = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (allZeroUntil(8)) return true; // ::
  if (allZeroUntil(7) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  const embedded = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64)
  if (allZeroUntil(5) && (groups[5] === 0xffff || groups[5] === 0)) return isBlockedIPv4(embedded);
  if (first === 0x64 && groups[1] === 0xff9b) return isBlockedIPv4(embedded);
  return false;
}

/**
 * Validates the forwarding target. Returns the parsed URL or a reason it is
 * refused: https only, default port, no credentials, and no hosts that point
 * at private networks (IP literals in private ranges, localhost, *.local,
 * *.internal, single-label names).
 */
export function checkTarget(raw: string | null): URL | string {
  if (!raw) return `Missing the ${TARGET_HEADER} header.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${TARGET_HEADER} is not an absolute URL.`;
  }
  if (url.protocol !== 'https:') return 'Only https targets are relayed.';
  if (url.username || url.password) return 'Targets cannot contain credentials.';
  if (url.port !== '') return 'Only the default https port (443) is relayed.';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const groups = parseIPv6(host.slice(1, -1));
    if (!groups || isBlockedIPv6(groups)) return 'Private or reserved addresses are not relayed.';
    return url;
  }
  const v4 = ipv4Parts(host);
  if (v4) {
    return isBlockedIPv4(v4) ? 'Private or reserved addresses are not relayed.' : url;
  }
  if (!host.includes('.')) return 'Single-label hosts are not relayed.';
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.lan')
  ) {
    return 'Local and internal hostnames are not relayed.';
  }
  return url;
}

// --- helpers ---------------------------------------------------------------------------

export function parseAllowedOrigins(value: string | undefined): string[] {
  return String(value ?? DEFAULT_ALLOWED_ORIGINS)
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': EXPOSED_HEADERS.join(', '),
    vary: 'Origin',
  };
}

function json(status: number, error: string, origin?: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(origin ? corsHeaders(origin) : {}),
      ...extra,
    },
  });
}

function strippedRequest(name: string): boolean {
  return (
    STRIPPED_REQUEST_HEADERS.has(name) || STRIPPED_REQUEST_PREFIXES.some((p) => name.startsWith(p))
  );
}

function strippedResponse(name: string): boolean {
  return (
    STRIPPED_RESPONSE_HEADERS.has(name) ||
    STRIPPED_RESPONSE_PREFIXES.some((p) => name.startsWith(p))
  );
}

/** Reads a request body, refusing more than `limit` bytes. Returns null when too large. */
async function readLimited(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// --- the relay ---------------------------------------------------------------------------

export function createRelay(options: RelayOptions = {}): Relay {
  const upstreamFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const log = options.log ?? ((entry: LogEntry) => console.log(JSON.stringify({ relay: entry })));
  const maxStreamMs = options.maxStreamMs ?? MAX_STREAM_MS;

  return {
    async fetch(request: Request, env: Env = {}): Promise<Response> {
      const started = Date.now();
      const url = new URL(request.url);
      const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
      const origin = (request.headers.get('origin') ?? '').replace(/\/+$/, '');
      const target = request.headers.get(TARGET_HEADER);

      if (url.pathname !== '/') return json(404, 'Not found.');
      if (!origin && request.method === 'GET' && !target) {
        return new Response(
          'MCP relay for browser clients. See https://github.com/harsha-iiiv/openapi-mcp-generator/tree/main/relay\n',
          { headers: { 'content-type': 'text/plain; charset=utf-8' } }
        );
      }
      if (!origin || !allowed.includes(origin)) {
        return json(403, 'This origin may not use the relay.');
      }

      if (request.method === 'OPTIONS') {
        const method = (request.headers.get('access-control-request-method') ?? '').toUpperCase();
        if (method && !ALLOWED_METHODS.includes(method)) {
          return json(405, `The relay does not forward ${method}.`, origin);
        }
        const requested = (request.headers.get('access-control-request-headers') ?? '')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h && HEADER_TOKEN.test(h));
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(origin),
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers': [...new Set([...requested, TARGET_HEADER])].join(', '),
            'access-control-max-age': '600',
          },
        });
      }

      if (!ALLOWED_METHODS.includes(request.method)) {
        return json(405, `The relay does not forward ${request.method}.`, origin);
      }

      if (env.RATE_LIMITER) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return json(429, 'Too many requests through the relay. Wait a minute.', origin, {
            'retry-after': '60',
          });
        }
      }

      const checked = checkTarget(target);
      if (typeof checked === 'string') return json(400, checked, origin);

      // Body rules: JSON or form bodies on POST only, at most 1 MiB.
      let body: Uint8Array | undefined;
      if (request.method === 'POST') {
        const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.includes(type)) {
          return json(415, 'The relay forwards only JSON and form-encoded bodies.', origin);
        }
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > MAX_REQUEST_BYTES) {
          return json(413, 'Request bodies are limited to 1 MiB.', origin);
        }
        if (request.body) {
          const read = await readLimited(request.body, MAX_REQUEST_BYTES);
          if (!read) return json(413, 'Request bodies are limited to 1 MiB.', origin);
          body = read;
        }
      } else if (request.body && (await readLimited(request.body, 0)) === null) {
        return json(400, `${request.method} requests cannot carry a body.`, origin);
      }

      const headers = new Headers();
      request.headers.forEach((value, name) => {
        if (!strippedRequest(name.toLowerCase())) headers.set(name, value);
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), maxStreamMs);
      let current = checked;
      let method = request.method;
      let upstream: Response | undefined;
      const finish = (status: number) =>
        log({ method: request.method, host: checked.host, status, ms: Date.now() - started });

      try {
        for (let hop = 0; ; hop++) {
          upstream = await upstreamFetch(current.href, {
            method,
            headers,
            body: method === 'POST' ? body : undefined,
            redirect: 'manual',
            signal: controller.signal,
          });
          if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
          const location = upstream.headers.get('location');
          await upstream.body?.cancel().catch(() => {});
          if (!location) {
            clearTimeout(timer);
            finish(502);
            return json(502, 'The target sent a redirect without a Location.', origin);
          }
          const next = new URL(location, current);
          if (next.origin !== current.origin) {
            clearTimeout(timer);
            finish(502);
            return json(
              502,
              `The target redirected to another origin (${next.origin}). The relay follows same-origin redirects only; use that URL directly.`,
              origin
            );
          }
          if (hop + 1 >= MAX_REDIRECTS) {
            clearTimeout(timer);
            finish(502);
            return json(502, 'Too many redirects.', origin);
          }
          if (upstream.status === 303) method = 'GET';
          else if ((upstream.status === 301 || upstream.status === 302) && method === 'POST') {
            clearTimeout(timer);
            finish(502);
            return json(
              502,
              `The target answered POST with ${upstream.status} to ${next.pathname}. Use that URL directly.`,
              origin
            );
          }
          current = next;
        }
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        finish(timedOut ? 504 : 502);
        return json(
          timedOut ? 504 : 502,
          timedOut ? 'The target did not answer in time.' : 'Could not reach the target server.',
          origin
        );
      }

      const declaredSize = Number(upstream.headers.get('content-length') ?? '0');
      if (declaredSize > MAX_RESPONSE_BYTES) {
        clearTimeout(timer);
        await upstream.body?.cancel().catch(() => {});
        finish(502);
        return json(502, 'The response is larger than 20 MiB.', origin);
      }

      const responseHeaders = new Headers();
      upstream.headers.forEach((value, name) => {
        if (!strippedResponse(name.toLowerCase())) responseHeaders.set(name, value);
      });
      for (const [name, value] of Object.entries(corsHeaders(origin))) {
        responseHeaders.set(name, value);
      }
      finish(upstream.status);

      if (!upstream.body || [204, 205, 304].includes(upstream.status)) {
        await upstream.body?.cancel().catch(() => {});
        clearTimeout(timer);
        return new Response(null, { status: upstream.status, headers: responseHeaders });
      }
      // Stream through, counting bytes; stop at the size cap or the time cap.
      let sent = 0;
      const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          sent += chunk.byteLength;
          if (sent > MAX_RESPONSE_BYTES) {
            controller.abort();
            ctrl.error(new Error('The response is larger than 20 MiB.'));
            return;
          }
          ctrl.enqueue(chunk);
        },
        flush() {
          clearTimeout(timer);
        },
      });
      upstream.body.pipeTo(limiter.writable).catch(() => clearTimeout(timer));
      return new Response(limiter.readable, { status: upstream.status, headers: responseHeaders });
    },
  };
}

export default createRelay();
