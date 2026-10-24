/**
 * The MCP relay (relay/src/index.ts): CORS, header filtering, SSRF guards,
 * size caps, streaming and redirects. The worker's fetch handler runs
 * in-process with an injected upstream fetch.
 */
import { describe, it, expect } from 'vitest';

import {
  createRelay,
  checkTarget,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  type LogEntry,
} from '../relay/src/index.ts';

const ORIGIN = 'https://mcp.pidata.tech';
const RELAY = 'https://relay.test/';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function setup(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    Response.json({ ok: true }),
  options: { maxStreamMs?: number } = {}
) {
  const seen: Seen[] = [];
  const logs: LogEntry[] = [];
  const relay = createRelay({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = init.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
      seen.push({ url, method: String(init.method), headers, body });
      return handler(url, init);
    },
    log: (entry) => logs.push(entry),
    ...options,
  });
  return { relay, seen, logs };
}

function relayRequest(target: string | null, init: RequestInit & { origin?: string | null } = {}) {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.set('origin', origin);
  if (target) headers.set('x-mcp-target', target);
  return new Request(RELAY, { ...init, headers });
}

describe('relay: CORS', () => {
  it('answers preflight for allowed origins and reflects requested headers', async () => {
    const { relay } = setup();
    const res = await relay.fetch(
      relayRequest(null, {
        method: 'OPTIONS',
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers':
            'authorization, content-type, x-api-key, mcp-protocol-version, x-mcp-target',
        },
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
    const allowed = res.headers.get('access-control-allow-headers') ?? '';
    for (const name of ['authorization', 'content-type', 'x-api-key', 'x-mcp-target']) {
      expect(allowed).toContain(name);
    }
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  it('refuses other origins and requests without an Origin', async () => {
    const { relay, seen } = setup();
    const evil = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { method: 'POST', origin: 'https://evil.test' })
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const none = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { method: 'DELETE', origin: null })
    );
    expect(none.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('honours ALLOWED_ORIGINS', async () => {
    const { relay } = setup();
    const env = { ALLOWED_ORIGINS: 'https://a.test, http://localhost:5173' };
    const ok = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { origin: 'http://localhost:5173' }),
      env
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const denied = await relay.fetch(relayRequest('https://mcp.example.com/mcp'), env);
    expect(denied.status).toBe(403);
  });
});

describe('relay: forwarding', () => {
  it('forwards method, body and safe headers; strips Origin, cookies and proxy headers', async () => {
    const { relay, seen } = setup(
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'abc',
            'set-cookie': 'track=1',
            'access-control-allow-origin': '*',
            'www-authenticate':
              'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"',
          },
        })
    );
    const res = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp?x=1', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer secret',
          'x-api-key': 'k',
          'mcp-session-id': 'abc',
          'mcp-protocol-version': '2025-11-25',
          cookie: 'session=1',
          referer: 'https://mcp.pidata.tech/playground/',
          'cf-connecting-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          'sec-fetch-mode': 'cors',
        },
      })
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const up = seen[0];
    expect(up.url).toBe('https://mcp.example.com/mcp?x=1');
    expect(up.method).toBe('POST');
    expect(up.body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(up.headers).toMatchObject({
      authorization: 'Bearer secret',
      'x-api-key': 'k',
      'mcp-session-id': 'abc',
      'mcp-protocol-version': '2025-11-25',
      'content-type': 'application/json',
    });
    for (const name of [
      'origin',
      'cookie',
      'referer',
      'cf-connecting-ip',
      'x-forwarded-for',
      'sec-fetch-mode',
      'x-mcp-target',
    ]) {
      expect(up.headers[name], name).toBeUndefined();
    }
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
    expect(res.headers.get('access-control-expose-headers')).toContain('www-authenticate');
    expect(res.headers.get('mcp-session-id')).toBe('abc');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('forwards GET and DELETE without a body and passes error statuses through', async () => {
    const { relay, seen } = setup((url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response('no', { status: 405 })
    );
    const get = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { headers: { accept: 'text/event-stream' } })
    );
    expect(get.status).toBe(405);
    expect(await get.text()).toBe('no');
    const del = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { method: 'DELETE' })
    );
    expect(del.status).toBe(204);
    expect(seen.map((s) => s.method)).toEqual(['GET', 'DELETE']);
  });

  it('logs only method, host, status and duration', async () => {
    const { relay, logs } = setup();
    await relay.fetch(
      relayRequest('https://mcp.example.com/secret/path?token=abc', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      })
    );
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['host', 'method', 'ms', 'status']);
    expect(logs[0]).toMatchObject({ method: 'POST', host: 'mcp.example.com', status: 200 });
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('rate limits per client IP when the binding is present', async () => {
    const { relay, seen } = setup();
    const keys: string[] = [];
    const env = {
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const res = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { headers: { 'cf-connecting-ip': '9.9.9.9' } }),
      env
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(keys).toEqual(['9.9.9.9']);
    expect(seen).toHaveLength(0);
  });

  it('reports unreachable targets as 502', async () => {
    const { relay } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const res = await relay.fetch(relayRequest('https://mcp.example.com/mcp'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Could not reach/);
  });
});

describe('relay: SSRF guards', () => {
  it('rejects non-https, odd ports, credentials, private IPs and internal names', async () => {
    const { relay, seen } = setup();
    for (const target of [
      'http://mcp.example.com/mcp',
      'https://mcp.example.com:8443/mcp',
      'https://user:pass@mcp.example.com/mcp',
      'https://127.0.0.1/mcp',
      'https://2130706433/',
      'https://10.1.2.3/',
      'https://172.20.0.1/',
      'https://192.168.1.1/',
      'https://100.64.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[fd00::1]/',
      'https://[fe80::1]/',
      'https://localhost/',
      'https://app.localhost/',
      'https://printer.local/',
      'https://metadata.google.internal/',
      'https://intranet/',
      'not a url',
    ]) {
      const res = await relay.fetch(relayRequest(target));
      expect(res.status, target).toBe(400);
    }
    const missing = await relay.fetch(relayRequest(null));
    expect(missing.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('accepts public hosts and public IP literals', () => {
    expect(checkTarget('https://mcp.deepwiki.com/mcp')).toBeInstanceOf(URL);
    expect(checkTarget('https://8.8.8.8/mcp')).toBeInstanceOf(URL);
    expect(checkTarget('https://[2606:4700::1111]/mcp')).toBeInstanceOf(URL);
    expect(checkTarget('https://mcp.example.com:443/mcp')).toBeInstanceOf(URL);
  });
});

describe('relay: size caps and content types', () => {
  it('refuses bodies over 1 MiB, with or without Content-Length', async () => {
    const { relay, seen } = setup();
    const big = '{"x":"' + 'a'.repeat(MAX_REQUEST_BYTES) + '"}';
    const declared = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', {
        method: 'POST',
        body: big,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(declared.status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const streamed = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', {
        method: 'POST',
        body: stream,
        headers: { 'content-type': 'application/json' },
        // @ts-expect-error duplex is required by Node for stream bodies
        duplex: 'half',
      })
    );
    expect(streamed.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('forwards only JSON and form bodies, and no body on DELETE', async () => {
    const { relay, seen } = setup();
    const text = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', {
        method: 'POST',
        body: 'hello',
        headers: { 'content-type': 'text/plain' },
      })
    );
    expect(text.status).toBe(415);
    const form = await relay.fetch(
      relayRequest('https://auth.example.com/token', {
        method: 'POST',
        body: 'grant_type=authorization_code&code=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    );
    expect(form.status).toBe(200);
    expect(seen[0].body).toBe('grant_type=authorization_code&code=x');
    const del = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', {
        method: 'DELETE',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(del.status).toBe(400);
    expect(seen).toHaveLength(1);
  });

  it('refuses responses over 20 MiB, declared or streamed', async () => {
    const declared = setup(
      () =>
        new Response('x', {
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        })
    );
    const res = await declared.relay.fetch(relayRequest('https://mcp.example.com/mcp'));
    expect(res.status).toBe(502);

    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const streamed = setup(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (sent > MAX_RESPONSE_BYTES + chunk.byteLength) return c.close();
              sent += chunk.byteLength;
              c.enqueue(chunk);
            },
          })
        )
    );
    const big = await streamed.relay.fetch(relayRequest('https://mcp.example.com/mcp'));
    expect(big.status).toBe(200);
    await expect(big.arrayBuffer()).rejects.toThrow();
  });
});

describe('relay: streaming and redirects', () => {
  it('streams SSE incrementally', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const encoder = new TextEncoder();
    const { relay } = setup(
      () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(encoder.encode('event: message\ndata: {"n":1}\n\n'));
              await gate;
              c.enqueue(encoder.encode('event: message\ndata: {"n":2}\n\n'));
              c.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    );
    const res = await relay.fetch(
      relayRequest('https://mcp.example.com/mcp', { headers: { accept: 'text/event-stream' } })
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // The first event arrives while the upstream is still holding the second.
    expect(first).toContain('"n":1');
    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('"n":2');
  });

  it('ends a stream at the time cap', async () => {
    const { relay } = setup(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(': open\n\n'));
              init.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        ),
      { maxStreamMs: 50 }
    );
    const res = await relay.fetch(relayRequest('https://mcp.example.com/mcp'));
    await expect(res.text()).rejects.toThrow();
  });

  it('follows same-origin redirects only', async () => {
    const { relay, seen } = setup((url) => {
      if (url.endsWith('/old')) {
        return new Response(null, { status: 307, headers: { location: '/mcp' } });
      }
      if (url.endsWith('/away')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.net/mcp' },
        });
      }
      return Response.json({ at: url });
    });
    const same = await relay.fetch(
      relayRequest('https://mcp.example.com/old', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(same.status).toBe(200);
    expect((await same.json()).at).toBe('https://mcp.example.com/mcp');
    expect(seen.map((s) => [s.method, s.body])).toEqual([
      ['POST', '{"a":1}'],
      ['POST', '{"a":1}'],
    ]);
    const cross = await relay.fetch(relayRequest('https://mcp.example.com/away'));
    expect(cross.status).toBe(502);
    expect((await cross.json()).error).toMatch(/another origin/);
    expect(seen.some((s) => s.url.includes('elsewhere'))).toBe(false);
  });
});
