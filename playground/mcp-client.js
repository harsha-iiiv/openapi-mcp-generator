/**
 * mcp-client.js: a small, dependency-free MCP client for browsers and Node 18+.
 *
 * Part of openapi-mcp-generator's playground (MIT). It speaks the 2025-era MCP
 * protocol (initialize handshake) over Streamable HTTP and the older HTTP+SSE
 * transport, detects which one a server uses, and supports:
 *
 * - auth: none, a bearer token, custom headers, or a pluggable provider (OAuth)
 * - an optional relay (`relayUrl`) for servers that refuse browser requests
 * - client capabilities: roots, sampling and elicitation, answered through hooks
 * - tools, resources, prompts, completion, logging, progress and cancellation
 *
 * Every JSON-RPC message is reported through onTraffic. The same file runs in
 * generated servers, on https://mcp.pidata.tech/playground and in the
 * generator's own tests.
 */

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// TODO(2026-07-28): the stateless era (server/discover, per-request _meta, in-band
// input_required results) is not implemented here. Dual-era servers, including
// this generator's 5.x output, still answer the 2025-era initialize handshake.

/** Logging levels, lowest to highest (MCP LoggingLevel). */
export const LOGGING_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

/** Headers the client manages itself. Custom headers cannot override them. */
export const RESERVED_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'x-mcp-target',
];

/** The header that tells the relay where to forward a request. */
export const RELAY_TARGET_HEADER = 'x-mcp-target';

/** A JSON-RPC error returned by the server (or raised by a request handler). */
export class McpError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** An HTTP-level failure, with a plain-language hint for people. */
export class McpHttpError extends Error {
  constructor(status, body, hint, extra = {}) {
    super(hint || `HTTP ${status}`);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
    this.hint = hint;
    /** Parsed WWW-Authenticate challenge on a 401/403, if any. */
    this.challenge = extra.challenge;
    /** True when the server asks for OAuth sign-in. */
    this.oauth = Boolean(extra.oauth);
    /** True when retrying through the relay may help. */
    this.relaySuggested = Boolean(extra.relaySuggested);
  }
}

/** The request never got an HTTP answer: offline, DNS, TLS, or blocked by CORS. */
export class McpNetworkError extends Error {
  constructor(message, { relaySuggested = false } = {}) {
    super(message);
    this.name = 'McpNetworkError';
    this.relaySuggested = relaySuggested;
  }
}

/** The caller cancelled a request (AbortSignal or cancel()). */
export class McpCancelledError extends Error {
  constructor(reason = 'Cancelled') {
    super(reason);
    this.name = 'McpCancelledError';
  }
}

/** Largest unterminated SSE event the parser will hold, so a stream cannot exhaust memory. */
export const MAX_SSE_BUFFER = 1024 * 1024;

/** Incremental parser for text/event-stream bodies. */
export class SseParser {
  constructor() {
    this.buffer = '';
  }

  /** Feeds decoded text and returns the complete events it contained. */
  push(text) {
    this.buffer += text.replace(/\r\n?/g, '\n');
    const events = [];
    let boundary;
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      // Check complete events too, before slicing or parsing them.
      if (boundary > MAX_SSE_BUFFER) {
        this.buffer = '';
        throw new Error('The server sent an SSE event larger than 1 MiB.');
      }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = parseEventBlock(block);
      if (event) events.push(event);
    }
    if (this.buffer.length > MAX_SSE_BUFFER) {
      this.buffer = '';
      throw new Error('The server sent an SSE event larger than 1 MiB.');
    }
    return events;
  }
}

function parseEventBlock(block) {
  let event = 'message';
  const data = [];
  let id;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

const isResponse = (msg) =>
  msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg);
const isServerRequest = (msg) =>
  msg && typeof msg === 'object' && 'id' in msg && typeof msg.method === 'string';
const isNotification = (msg) =>
  msg && typeof msg === 'object' && !('id' in msg) && typeof msg.method === 'string';

function browserOrigin() {
  try {
    return globalThis.location && globalThis.location.origin !== 'null'
      ? globalThis.location.origin
      : '';
  } catch {
    return '';
  }
}

// --- headers ---------------------------------------------------------------------

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Validates custom headers and returns them with lowercase names. Throws on an
 * invalid name or value, or on a header the client manages itself.
 */
export function validateHeaders(headers = {}) {
  const out = {};
  const entries = Array.isArray(headers) ? headers : Object.entries(headers || {});
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName ?? '').trim();
    if (!name) throw new Error('Header names cannot be empty.');
    if (!HEADER_NAME.test(name)) throw new Error(`"${name}" is not a valid header name.`);
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.includes(lower)) {
      throw new Error(`The ${lower} header is managed by the client and cannot be set.`);
    }
    const value = String(rawValue ?? '');
    if (/[\r\n\0]/.test(value)) throw new Error(`The value of ${lower} contains a line break.`);
    if (lower in out) throw new Error(`The ${lower} header is set twice.`);
    out[lower] = value.trim();
  }
  return out;
}

/** The environment-variable placeholder used for a header in curl commands. */
export function headerEnvName(name) {
  const parts = String(name)
    .toUpperCase()
    .split(/[^A-Z0-9]/)
    .filter(Boolean);
  return parts.join('_') || 'HEADER';
}

/**
 * Parses a WWW-Authenticate header into challenges:
 * [{ scheme: 'bearer', params: { resource_metadata, scope, error, ... } }].
 */
export function parseWwwAuthenticate(header) {
  const challenges = [];
  const text = String(header || '');
  let i = 0;
  const skip = () => {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
  };
  const token = () => {
    const start = i;
    while (i < text.length && /[!#$%&'*+.^_`|~0-9A-Za-z-]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  let current = null;
  while (i < text.length) {
    skip();
    const start = i;
    const word = token();
    if (!word) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === ' ') j++;
    if (text[j] === '=' && current) {
      // auth-param: name=value or name="quoted"
      i = j + 1;
      while (i < text.length && text[i] === ' ') i++;
      let value = '';
      if (text[i] === '"') {
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < text.length) i++;
          value += text[i++];
        }
        i++;
      } else {
        const vs = i;
        while (i < text.length && text[i] !== ',' && text[i] !== ' ') i++;
        value = text.slice(vs, i);
      }
      current.params[word.toLowerCase()] = value;
    } else if (text[j] === '=' && !current) {
      i = j + 1;
    } else {
      // a new scheme (possibly followed by token68)
      current = { scheme: word.toLowerCase(), params: {} };
      challenges.push(current);
      i = start + word.length;
    }
  }
  return challenges;
}

/** The Bearer challenge (or the first one) from a WWW-Authenticate header. */
export function bearerChallenge(header) {
  const all = parseWwwAuthenticate(header);
  if (all.length === 0) return undefined;
  const bearer = all.find((c) => c.scheme === 'bearer') || all[0];
  return {
    scheme: bearer.scheme,
    resourceMetadata: bearer.params.resource_metadata,
    scope: bearer.params.scope,
    error: bearer.params.error,
    errorDescription: bearer.params.error_description,
    realm: bearer.params.realm,
  };
}

// --- hints -----------------------------------------------------------------------

/**
 * Turns an HTTP failure into something a person can act on.
 * mode 'generated' speaks about a generated server's settings (MCP_AUTH_TOKEN,
 * MCP_ALLOWED_ORIGINS); mode 'hosted' speaks about any remote server.
 */
export function explainHttpError(
  status,
  body,
  { hasToken = false, hadSession = false, mode = 'generated', challenge, viaRelay = false } = {}
) {
  const text = String(body || '');
  const hosted = mode === 'hosted';
  if (status === 401) {
    if (!hosted) {
      return hasToken
        ? 'The server rejected this token. Check it matches MCP_AUTH_TOKEN (or one of MCP_AUTH_TOKENS).'
        : 'This server requires a bearer token. Paste the value of MCP_AUTH_TOKEN.';
    }
    const oauth = Boolean(
      challenge && (challenge.resourceMetadata || challenge.scheme === 'bearer')
    );
    if (hasToken) {
      return challenge?.error === 'invalid_token' || !oauth
        ? 'The server rejected these credentials. Check the token, or sign in with OAuth if the server offers it.'
        : 'The server rejected these credentials. Sign in again.';
    }
    return oauth
      ? 'This server uses OAuth: Sign in to continue.'
      : 'This server requires credentials. Add a bearer token or the headers it expects.';
  }
  if (status === 403 && challenge?.error === 'insufficient_scope') {
    return 'The token lacks a permission this request needs. Sign in again to grant it.';
  }
  if (status === 403 && /origin/i.test(text)) {
    if (hosted && !viaRelay) {
      return 'The server refuses requests from this site. Retry through the relay.';
    }
    const origin = browserOrigin();
    return origin
      ? `The server does not accept browser requests from ${origin}. Add it to MCP_ALLOWED_ORIGINS on the server, then reconnect.`
      : 'The server does not accept requests from this origin. Add it to MCP_ALLOWED_ORIGINS.';
  }
  if (status === 404 && hadSession) {
    return 'The session expired or the server restarted. Reconnect to start a new one.';
  }
  if (status === 404) return 'Nothing answers at this URL. Check the endpoint path (usually /mcp).';
  if (status === 405) return 'This endpoint does not accept that request method.';
  if (status === 406) return 'The server could not satisfy the Accept header.';
  if (status === 429)
    return 'The server (or the relay) is rate limiting requests. Wait a moment and retry.';
  if (status === 503 && /token/i.test(text) && !hosted) {
    return 'Inbound auth is on, but the server has no MCP_AUTH_TOKEN set. Set it and restart the server.';
  }
  const detail = extractErrorMessage(text);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const err = parsed && parsed.error;
    if (typeof err === 'string') return parsed.error_description || err;
    return (err && (err.message || JSON.stringify(err))) || parsed.message || '';
  } catch {
    return text.slice(0, 200);
  }
}

function networkHint(url, { mode = 'generated', viaRelay = false, relayUrl = '' } = {}) {
  let target = '';
  try {
    target = new URL(url).origin;
  } catch {
    target = String(url);
  }
  if (viaRelay) {
    let relay = relayUrl;
    try {
      relay = new URL(relayUrl).origin;
    } catch {
      // keep as given
    }
    return `Could not reach the relay at ${relay}. Check the relay URL and that it allows this site.`;
  }
  const origin = browserOrigin();
  if (mode === 'hosted' && origin && target && origin !== target) {
    return `Could not reach ${target} from this browser. The server may be down, or it does not allow browser requests (CORS). Retry through the relay.`;
  }
  if (origin && target && origin !== target) {
    return `Could not reach ${target}. The server may be down, or the browser blocked the request: check that it allows CORS from ${origin}, that it is served over HTTPS (or is localhost), and any local network permission prompt.`;
  }
  return `Could not reach ${target || 'the server'}. Is it running?`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Default capabilities for the hooks a client was given (2025-11-25 schema shapes). */
function defaultCapabilities({ roots, onServerRequest }) {
  const caps = {};
  if (roots || onServerRequest) caps.roots = { listChanged: true };
  if (onServerRequest) {
    caps.sampling = {};
    caps.elicitation = { form: {}, url: {} };
  }
  return caps;
}

/**
 * MCP client over Streamable HTTP ('streamable-http'), HTTP+SSE ('sse'), or
 * whichever the server speaks ('auto').
 *
 *   const client = new McpClient({ url: 'http://localhost:3000/mcp', token });
 *   await client.connect();
 *   const tools = await client.listTools();
 *   const result = await client.callTool('getPetById', { petId: 1 });
 *
 * Options:
 *   url, transport ('streamable-http' | 'sse' | 'auto'), token (bearer),
 *   headers (custom request headers), auth ({ getAccessToken, onUnauthorized }),
 *   relayUrl (forward every request through a relay), hints ('generated' | 'hosted'),
 *   roots (array answered to roots/list), onServerRequest (async (request, { signal })
 *   => result, for sampling/createMessage, elicitation/create, roots/list),
 *   onNotification (message => void), capabilities (override the declared ones),
 *   listen (open the optional GET stream for server messages; default true),
 *   clientInfo, timeoutMs, onTraffic, fetch.
 */
/** A GET listen stream open at least this long counts as healthy when it ends. */
const LISTEN_STABLE_MS = 30_000;
/** Reconnect attempts for GET listen streams that close right after opening. */
const LISTEN_MAX_RETRIES = 5;

export class McpClient {
  constructor(options = {}) {
    const base = globalThis.location ? globalThis.location.href : undefined;
    this.url = new URL(options.url || '/mcp', base).href;
    this.requestedTransport = ['sse', 'auto'].includes(options.transport)
      ? options.transport
      : 'streamable-http';
    this.transport = this.requestedTransport === 'sse' ? 'sse' : 'streamable-http';
    this.token = options.token || '';
    this.headers = validateHeaders(options.headers || {});
    this.auth = options.auth || null;
    this.relayUrl = options.relayUrl ? new URL(options.relayUrl, base).href : '';
    this.hints = options.hints === 'hosted' ? 'hosted' : 'generated';
    this.roots = Array.isArray(options.roots) ? options.roots.slice() : null;
    this.onServerRequest = options.onServerRequest || null;
    this.onNotification = options.onNotification || (() => {});
    this.capabilities =
      options.capabilities ||
      defaultCapabilities({ roots: this.roots, onServerRequest: this.onServerRequest });
    this.listen = options.listen !== false;
    this.clientInfo = options.clientInfo || { name: 'mcp-playground', version: '1.0.0' };
    this.timeoutMs = options.timeoutMs || 60_000;
    this.onTraffic = options.onTraffic || (() => {});
    const f = options.fetch || globalThis.fetch;
    this.fetch = (input, init) => f(input, init);
    this.nextId = 1;
    this.serverRequests = new Map();
    this.reset();
  }

  reset() {
    this.connected = false;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.serverInfo = undefined;
    this.serverCapabilities = undefined;
    this.instructions = undefined;
    this.sseAbort?.abort();
    this.sseAbort = undefined;
    this.listenAbort?.abort();
    this.listenAbort = undefined;
    this.messageUrl = undefined;
    for (const pending of this.pending?.values() ?? []) {
      pending.reject(new Error('Disconnected'));
    }
    this.pending = new Map();
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
  }

  /**
   * Runs the initialize handshake. Returns the server's initialize result.
   * With transport 'auto', a 4xx answer to the Streamable HTTP POST falls back
   * to HTTP+SSE, as the spec's backwards-compatibility section describes.
   */
  async connect() {
    this.reset();
    if (this.requestedTransport === 'sse') {
      this.transport = 'sse';
      await this.openSse();
      return this.initialize();
    }
    this.transport = 'streamable-http';
    try {
      return await this.initialize();
    } catch (error) {
      const fallback =
        this.requestedTransport === 'auto' &&
        error instanceof McpHttpError &&
        [400, 404, 405].includes(error.status);
      if (!fallback) throw error;
      this.reset();
      this.transport = 'sse';
      try {
        await this.openSse();
        return await this.initialize();
      } catch (sseError) {
        this.reset();
        this.transport = 'streamable-http';
        // Neither transport worked: report the more informative failure.
        throw sseError instanceof McpHttpError && [404, 405].includes(sseError.status)
          ? error
          : sseError;
      }
    }
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: this.capabilities,
      clientInfo: this.clientInfo,
    });
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      this.reset();
      throw new Error(
        `The server chose protocol ${result.protocolVersion}, which this client does not support.`
      );
    }
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    this.serverCapabilities = result.capabilities || {};
    this.instructions = result.instructions;
    await this.notify('notifications/initialized');
    this.connected = true;
    if (this.transport === 'streamable-http' && this.sessionId && this.listen) {
      this.openListenStream();
    }
    return result;
  }

  // --- methods -----------------------------------------------------------------

  /** Follows nextCursor pagination and returns every item under `key`. */
  async paginate(method, key, params = {}) {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, cursor ? { ...params, cursor } : params);
      items.push(...(result[key] || []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  /** Lists every tool, following pagination cursors. */
  listTools() {
    return this.paginate('tools/list', 'tools');
  }

  /**
   * Calls a tool. Options: onProgress({ progress, total, message }) adds a
   * progress token; signal (AbortSignal) cancels with notifications/cancelled.
   */
  callTool(name, args = {}, options = {}) {
    return this.request('tools/call', { name, arguments: args }, options);
  }

  listResources() {
    return this.paginate('resources/list', 'resources');
  }

  listResourceTemplates() {
    return this.paginate('resources/templates/list', 'resourceTemplates');
  }

  readResource(uri, options) {
    return this.request('resources/read', { uri }, options);
  }

  subscribeResource(uri) {
    return this.request('resources/subscribe', { uri });
  }

  unsubscribeResource(uri) {
    return this.request('resources/unsubscribe', { uri });
  }

  listPrompts() {
    return this.paginate('prompts/list', 'prompts');
  }

  getPrompt(name, args = {}, options) {
    return this.request('prompts/get', { name, arguments: args }, options);
  }

  /**
   * Asks for argument completions. ref is { type: 'ref/prompt', name } or
   * { type: 'ref/resource', uri }. Returns { values, total?, hasMore? }.
   */
  async complete(ref, argument, contextArguments) {
    const params = { ref, argument };
    if (contextArguments && Object.keys(contextArguments).length) {
      params.context = { arguments: contextArguments };
    }
    const result = await this.request('completion/complete', params);
    return result.completion || { values: [] };
  }

  setLoggingLevel(level) {
    return this.request('logging/setLevel', { level });
  }

  ping() {
    return this.request('ping');
  }

  /** Replaces the roots answered to roots/list and tells the server they changed. */
  async setRoots(roots) {
    this.roots = Array.isArray(roots) ? roots.slice() : [];
    if (this.connected && this.capabilities.roots?.listChanged) {
      await this.notify('notifications/roots/list_changed');
    }
  }

  /**
   * Sends a request and resolves with its result (throws McpError on a JSON-RPC
   * error). Options: onProgress, signal, timeoutMs, resetTimeoutOnProgress (default true).
   */
  async request(method, params, options = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (options.onProgress) {
      params = { ...(params || {}), _meta: { ...(params?._meta || {}), progressToken: id } };
    }
    if (params !== undefined) message.params = params;
    let response;
    try {
      response = await this.exchange(message, options);
    } catch (error) {
      // A Streamable HTTP session can expire (idle timeout, server restart):
      // start a new one once and retry, unless this was the handshake itself.
      if (
        !options.retried &&
        method !== 'initialize' &&
        error instanceof McpHttpError &&
        error.status === 404 &&
        this.transport === 'streamable-http' &&
        this.sessionId
      ) {
        await this.connect();
        return this.request(method, params, { ...options, retried: true });
      }
      throw error;
    }
    if (response.error) {
      throw new McpError(
        response.error.message || 'Request failed',
        response.error.code,
        response.error.data
      );
    }
    return response.result;
  }

  async notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    await this.send(message);
  }

  /** Ends the session. Errors are ignored: the server may already be gone. */
  async close() {
    if (this.transport === 'streamable-http' && this.sessionId) {
      try {
        const res = await this.httpRequest(this.url, { method: 'DELETE' });
        await res.body?.cancel?.().catch?.(() => {});
      } catch {
        // ignore
      }
    }
    this.reset();
  }

  /**
   * A copy-pasteable curl command for one request. Secrets stay as environment
   * variables: $MCP_AUTH_TOKEN (or $ACCESS_TOKEN) and one variable per custom header.
   * curl talks to the server directly, so the relay is never part of it.
   */
  curl(method, params) {
    const message = { jsonrpc: '2.0', id: 1, method };
    if (params !== undefined) message.params = params;
    const target = this.transport === 'sse' ? this.messageUrl || this.url : this.url;
    const parts = [`curl -sN ${shellQuote(target)}`, `-H 'content-type: application/json'`];
    if (this.transport === 'streamable-http') {
      parts.push(`-H 'accept: application/json, text/event-stream'`);
      if (this.sessionId) parts.push(`-H ${shellQuote(`mcp-session-id: ${this.sessionId}`)}`);
      if (this.protocolVersion)
        parts.push(`-H ${shellQuote(`mcp-protocol-version: ${this.protocolVersion}`)}`);
    }
    const tokenVar = this.hints === 'hosted' ? 'ACCESS_TOKEN' : 'MCP_AUTH_TOKEN';
    const hasAuth = Boolean(this.token || this.auth);
    for (const name of Object.keys(this.headers)) {
      if (hasAuth && name === 'authorization') continue;
      parts.push(`-H "${name}: $${headerEnvName(name)}"`);
    }
    if (hasAuth) parts.push(`-H "authorization: Bearer $${tokenVar}"`);
    parts.push(`-d ${shellQuote(JSON.stringify(message))}`);
    return parts.join(' \\\n  ');
  }

  // --- internals -------------------------------------------------------------

  async authHeaders() {
    if (this.auth && typeof this.auth.getAccessToken === 'function') {
      const token = await this.auth.getAccessToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    }
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** Headers for a request to the MCP server (before any relay header). */
  async requestHeaders(extra = {}) {
    const headers = { ...this.headers, ...(await this.authHeaders()), ...extra };
    if (this.transport === 'streamable-http') {
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return headers;
  }

  emit(direction, message, info = {}) {
    try {
      this.onTraffic({ direction, message, at: Date.now(), ...info });
    } catch {
      // a broken listener must not break the client
    }
  }

  /**
   * One HTTP request to the MCP server (directly or through the relay), with
   * auth headers and one retry after the auth provider handles a 401.
   */
  async httpRequest(url, { method = 'GET', body, extraHeaders = {}, signal } = {}, authRetried) {
    const headers = await this.requestHeaders(extraHeaders);
    let res;
    try {
      res = await this.rawFetch(url, { method, headers, body, signal });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new McpNetworkError(
        networkHint(url, {
          mode: this.hints,
          viaRelay: Boolean(this.relayUrl),
          relayUrl: this.relayUrl,
        }),
        { relaySuggested: this.hints === 'hosted' && !this.relayUrl }
      );
    }
    if (res.status === 401 && !authRetried && this.auth?.onUnauthorized) {
      const challenge = bearerChallenge(res.headers.get('www-authenticate'));
      let retry = false;
      try {
        retry = await this.auth.onUnauthorized({ status: 401, challenge, url: this.url });
      } catch {
        retry = false;
      }
      if (retry) {
        await res.body?.cancel?.().catch?.(() => {});
        return this.httpRequest(url, { method, body, extraHeaders, signal }, true);
      }
    }
    return res;
  }

  /** fetch, or fetch through the relay with the target in x-mcp-target. */
  rawFetch(url, init) {
    if (!this.relayUrl) return this.fetch(url, init);
    return this.fetch(this.relayUrl, {
      ...init,
      headers: { ...init.headers, [RELAY_TARGET_HEADER]: url },
    });
  }

  async failFromResponse(res) {
    const body = await res.text().catch(() => '');
    const challenge = bearerChallenge(res.headers.get('www-authenticate'));
    const hint = explainHttpError(res.status, body, {
      hasToken: Boolean(this.token) || Boolean(this.auth?.hasToken?.()),
      hadSession: Boolean(this.sessionId),
      mode: this.hints,
      challenge,
      viaRelay: Boolean(this.relayUrl),
    });
    const oauth =
      this.hints === 'hosted' &&
      (res.status === 401 || challenge?.error === 'insufficient_scope') &&
      Boolean(challenge && (challenge.resourceMetadata || challenge.scheme === 'bearer'));
    const relaySuggested =
      this.hints === 'hosted' && !this.relayUrl && res.status === 403 && /origin/i.test(body);
    const error = new McpHttpError(res.status, body, hint, { challenge, oauth, relaySuggested });
    this.emit('in', null, { status: res.status, error: error.message });
    throw error;
  }

  timeoutError() {
    return new Error(`No response within ${Math.round(this.timeoutMs / 1000)} s.`);
  }

  /** Sends a request and waits for its response, from whichever stream carries it. */
  exchange(message, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    let settled = false;
    let timer;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      this.pending.delete(message.id);
      options.signal?.removeEventListener?.('abort', onAbort);
    };
    const entry = {
      resolve: (msg) => {
        if (settled) return;
        cleanup();
        resolveFn(msg);
      },
      reject: (error) => {
        if (settled) return;
        cleanup();
        controller.abort();
        rejectFn(error);
      },
      onProgress: options.onProgress,
      armTimer: () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          this.sendCancelled(message, 'Request timed out');
          entry.reject(new Error(`No response within ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs);
      },
      resetOnProgress: options.resetTimeoutOnProgress !== false,
      get settled() {
        return settled;
      },
    };
    const onAbort = () => {
      if (settled) return;
      this.sendCancelled(message, 'Cancelled by the user');
      entry.reject(new McpCancelledError());
    };
    if (options.signal?.aborted) {
      entry.reject(new McpCancelledError());
      return promise;
    }
    options.signal?.addEventListener?.('abort', onAbort);
    this.pending.set(message.id, entry);
    entry.armTimer();
    this.emit('out', message);
    const sending =
      this.transport === 'sse'
        ? this.postSse(message, controller.signal)
        : this.postStreamable(message, entry, controller.signal);
    sending.catch((error) => {
      if (settled) return;
      if (error && error.name === 'AbortError') entry.reject(this.timeoutError());
      else entry.reject(error);
    });
    return promise;
  }

  /** Sends notifications/cancelled for a request (never for initialize). */
  sendCancelled(message, reason) {
    if (message.method === 'initialize') return;
    this.notify('notifications/cancelled', { requestId: message.id, reason }).catch(() => {});
  }

  /** Sends a notification or a response (no reply expected). */
  async send(message) {
    this.emit('out', message);
    if (this.transport === 'sse') return this.postSse(message);
    const res = await this.httpRequest(this.url, {
      method: 'POST',
      body: JSON.stringify(message),
      extraHeaders: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
    });
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    if (!res.ok) await this.failFromResponse(res);
    await res.body?.cancel?.().catch?.(() => {});
  }

  /** Turns a failure while reading a successful response body into a readable message. */
  bodyReadError(error, expectedJson = false) {
    if (error && error.name === 'AbortError') return this.timeoutError();
    if (expectedJson && error instanceof SyntaxError) {
      return new Error(
        'The server answered with something other than JSON. Check the endpoint URL (usually /mcp).'
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async postStreamable(message, entry, signal) {
    const res = await this.httpRequest(this.url, {
      method: 'POST',
      body: JSON.stringify(message),
      extraHeaders: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      signal,
    });
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    if (!res.ok) await this.failFromResponse(res);
    if (res.status === 202) {
      // The response will arrive on the GET stream, if the server keeps one.
      await res.body?.cancel?.().catch?.(() => {});
      return;
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      try {
        await this.pumpSse(res, { status: res.status, until: () => entry.settled });
      } catch (error) {
        throw this.bodyReadError(error);
      }
      if (!entry.settled) throw new Error('The stream ended before the server responded.');
      return;
    }
    let payload;
    try {
      payload = await res.json();
    } catch (error) {
      throw this.bodyReadError(error, true);
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const msg of messages) this.dispatch(msg, { status: res.status });
    if (!entry.settled) throw new Error('The server answered without a response to this request.');
  }

  /** Reads an SSE body, dispatching every message, until it ends or until() is true. */
  async pumpSse(res, { status, until = () => false, onEvent } = {}) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (onEvent && onEvent(event)) continue;
          if (event.event !== 'message') continue;
          const msg = this.parseMessage(event.data);
          if (!msg) continue;
          this.dispatch(msg, { status });
        }
        if (until()) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  parseMessage(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** Routes one incoming message: a response, a server request, or a notification. */
  dispatch(msg, info = {}) {
    if (Array.isArray(msg)) {
      for (const item of msg) this.dispatch(item, info);
      return;
    }
    this.emit('in', msg, info);
    if (isResponse(msg)) {
      if (!isServerRequest(msg)) this.pending.get(msg.id)?.resolve(msg);
      return;
    }
    if (isServerRequest(msg)) {
      this.answerServerRequest(msg);
      return;
    }
    if (isNotification(msg)) this.handleNotification(msg);
  }

  handleNotification(msg) {
    const params = msg.params || {};
    if (msg.method === 'notifications/progress') {
      for (const entry of this.pending.values()) {
        // progress tokens are this client's request ids
        if (entry.onProgress && this.pendingIdOf(entry) === params.progressToken) {
          if (entry.resetOnProgress) entry.armTimer();
          try {
            entry.onProgress({
              progress: params.progress,
              total: params.total,
              message: params.message,
            });
          } catch {
            // ignore listener errors
          }
        }
      }
    } else if (msg.method === 'notifications/cancelled') {
      const controller = this.serverRequests.get(params.requestId);
      if (controller) {
        controller.abort(params.reason);
        this.serverRequests.delete(params.requestId);
      }
    }
    try {
      this.onNotification(msg);
    } catch {
      // a broken listener must not break the client
    }
  }

  pendingIdOf(entry) {
    for (const [id, value] of this.pending) if (value === entry) return id;
    return undefined;
  }

  /**
   * Answers a server-to-client request: ping always; others through
   * onServerRequest, then the built-in roots list; anything else is -32601.
   */
  async answerServerRequest(msg) {
    const controller = new AbortController();
    this.serverRequests.set(msg.id, controller);
    let reply;
    try {
      let result;
      if (msg.method === 'ping') result = {};
      else if (this.onServerRequest) {
        result = await this.onServerRequest(msg, { signal: controller.signal });
      }
      if (result === undefined && msg.method === 'roots/list' && this.roots) {
        result = { roots: this.roots };
      }
      if (result === undefined) {
        throw new McpError(`The client does not support ${msg.method}`, -32601);
      }
      reply = { jsonrpc: '2.0', id: msg.id, result };
    } catch (error) {
      reply = {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: error instanceof McpError && typeof error.code === 'number' ? error.code : -32603,
          message: error && error.message ? error.message : String(error),
          ...(error instanceof McpError && error.data !== undefined ? { data: error.data } : {}),
        },
      };
    } finally {
      this.serverRequests.delete(msg.id);
    }
    // The server cancelled this request: it no longer expects an answer.
    if (controller.signal.aborted) return;
    this.send(reply).catch(() => {});
  }

  /**
   * Opens the optional GET stream that carries server messages outside any
   * request (list changes, resource updates, logs). A server without one
   * answers 405, which is fine.
   */
  async openListenStream(attempt = 0) {
    const controller = new AbortController();
    this.listenAbort = controller;
    let res;
    try {
      res = await this.httpRequest(this.url, {
        method: 'GET',
        extraHeaders: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch {
      return;
    }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/event-stream')) {
      await res.body?.cancel?.().catch?.(() => {});
      return;
    }
    const openedAt = Date.now();
    try {
      await this.pumpSse(res, { status: res.status });
    } catch {
      // aborted on disconnect, or the stream broke
    }
    // Proxies and load balancers close idle streams (Cloudflare after about 100 s), so a
    // stream that stayed open a while starts a fresh retry budget. Streams that close at
    // once keep counting, and the client gives up after LISTEN_MAX_RETRIES of those.
    const retry = Date.now() - openedAt >= LISTEN_STABLE_MS ? 0 : attempt;
    if (this.connected && this.listenAbort === controller && retry < LISTEN_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      if (this.connected && this.listenAbort === controller) this.openListenStream(retry + 1);
    }
  }

  // --- HTTP+SSE (the older transport, used by --transport=web) ---------------

  async openSse() {
    this.sseAbort = new AbortController();
    const res = await this.httpRequest(this.url, {
      method: 'GET',
      extraHeaders: { accept: 'text/event-stream' },
      signal: this.sseAbort.signal,
    });
    if (!res.ok) await this.failFromResponse(res);
    let resolveEndpoint;
    let rejectEndpoint;
    const endpoint = new Promise((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    endpoint.catch(() => {});
    const timer = setTimeout(
      () => rejectEndpoint(new Error('The SSE stream sent no endpoint event.')),
      this.timeoutMs
    );
    let failure;
    const pump = async () => {
      try {
        await this.pumpSse(res, {
          onEvent: (event) => {
            if (event.event !== 'endpoint') return false;
            // The endpoint resolves against the server URL, never the relay.
            const next = new URL(event.data.trim(), this.url);
            if (next.origin !== new URL(this.url).origin) {
              rejectEndpoint(
                new Error(`The server sent an endpoint on another origin (${next.origin}).`)
              );
              this.sseAbort?.abort();
              return true;
            }
            this.messageUrl = next.href;
            resolveEndpoint();
            return true;
          },
        });
      } catch (error) {
        // Aborted, network failure, or an oversized event: keep the reason for pending calls.
        if (error && error.name !== 'AbortError') failure = error;
      }
      clearTimeout(timer);
      rejectEndpoint(failure || new Error('The SSE stream closed before it sent an endpoint.'));
      this.connected = false;
      for (const pending of this.pending.values())
        pending.reject(failure || new Error('The SSE stream closed.'));
      this.pending.clear();
    };
    pump();
    await endpoint;
    clearTimeout(timer);
  }

  async postSse(message, signal) {
    if (!this.messageUrl) throw new Error('Not connected.');
    const res = await this.httpRequest(this.messageUrl, {
      method: 'POST',
      body: JSON.stringify(message),
      extraHeaders: { 'content-type': 'application/json' },
      signal,
    });
    if (!res.ok) await this.failFromResponse(res);
    await res.body?.cancel?.().catch?.(() => {});
  }
}
