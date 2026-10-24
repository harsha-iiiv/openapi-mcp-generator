/**
 * mcp-client.js: a small, dependency-free MCP client for browsers and Node 18+.
 *
 * Part of openapi-mcp-generator's playground (MIT). It speaks the 2025-era MCP
 * protocol over Streamable HTTP and the older HTTP+SSE transport, sends an
 * optional bearer token, and reports every JSON-RPC message through onTraffic.
 * The same file runs in generated servers, on https://mcp.pidata.tech/playground
 * and in the generator's own tests.
 */

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** A JSON-RPC error returned by the server. */
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
  constructor(status, body, hint) {
    super(hint || `HTTP ${status}`);
    this.name = 'McpHttpError';
    this.status = status;
    this.body = body;
    this.hint = hint;
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

function browserOrigin() {
  try {
    return globalThis.location && globalThis.location.origin !== 'null'
      ? globalThis.location.origin
      : '';
  } catch {
    return '';
  }
}

/** Turns an HTTP failure into something a person can act on. */
export function explainHttpError(status, body, { hasToken = false, hadSession = false } = {}) {
  const text = String(body || '');
  if (status === 401) {
    return hasToken
      ? 'The server rejected this token. Check it matches MCP_AUTH_TOKEN (or one of MCP_AUTH_TOKENS).'
      : 'This server requires a bearer token. Paste the value of MCP_AUTH_TOKEN.';
  }
  if (status === 403 && /origin/i.test(text)) {
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
  if (status === 503 && /token/i.test(text)) {
    return 'Inbound auth is on, but the server has no MCP_AUTH_TOKEN set. Set it and restart the server.';
  }
  const detail = extractErrorMessage(text);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return (parsed && parsed.error && (parsed.error.message || parsed.error)) || '';
  } catch {
    return text.slice(0, 200);
  }
}

function networkHint(url) {
  let target = '';
  try {
    target = new URL(url).origin;
  } catch {
    target = String(url);
  }
  const origin = browserOrigin();
  if (origin && target && origin !== target) {
    return `Could not reach ${target}. The server may be down, or the browser blocked the request: check that it allows CORS from ${origin}, that it is served over HTTPS (or is localhost), and any local network permission prompt.`;
  }
  return `Could not reach ${target || 'the server'}. Is it running?`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * MCP client over Streamable HTTP ('streamable-http') or HTTP+SSE ('sse').
 *
 *   const client = new McpClient({ url: 'http://localhost:3000/mcp', token });
 *   await client.connect();
 *   const tools = await client.listTools();
 *   const result = await client.callTool('getPetById', { petId: 1 });
 */
export class McpClient {
  constructor(options = {}) {
    const base = globalThis.location ? globalThis.location.href : undefined;
    this.url = new URL(options.url || '/mcp', base).href;
    this.transport = options.transport === 'sse' ? 'sse' : 'streamable-http';
    this.token = options.token || '';
    this.headers = { ...(options.headers || {}) };
    this.clientInfo = options.clientInfo || { name: 'mcp-playground', version: '1.0.0' };
    this.timeoutMs = options.timeoutMs || 60_000;
    this.onTraffic = options.onTraffic || (() => {});
    const f = options.fetch || globalThis.fetch;
    this.fetch = (input, init) => f(input, init);
    this.nextId = 1;
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
    this.messageUrl = undefined;
    for (const pending of this.pending?.values() ?? []) {
      pending.reject(new Error('Disconnected'));
    }
    this.pending = new Map();
  }

  /** Runs the initialize handshake. Returns the server's initialize result. */
  async connect() {
    this.reset();
    if (this.transport === 'sse') await this.openSse();
    const result = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
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
    return result;
  }

  /** Lists every tool, following pagination cursors. */
  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  /** Sends a request and resolves with its result (throws McpError on a JSON-RPC error). */
  async request(method, params, { retried = false } = {}) {
    const message = { jsonrpc: '2.0', id: this.nextId++, method };
    if (params !== undefined) message.params = params;
    let response;
    try {
      response = await this.send(message);
    } catch (error) {
      // A Streamable HTTP session can expire (idle timeout, server restart):
      // start a new one once and retry, unless this was the handshake itself.
      if (
        !retried &&
        method !== 'initialize' &&
        error instanceof McpHttpError &&
        error.status === 404 &&
        this.transport === 'streamable-http' &&
        this.sessionId
      ) {
        await this.connect();
        return this.request(method, params, { retried: true });
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
    await this.send(message, { expectResponse: false });
  }

  /** Ends the session. Errors are ignored: the server may already be gone. */
  async close() {
    if (this.transport === 'streamable-http' && this.sessionId) {
      try {
        await this.fetch(this.url, { method: 'DELETE', headers: this.requestHeaders() });
      } catch {
        // ignore
      }
    }
    this.reset();
  }

  /** A copy-pasteable curl command for one request (token left as $MCP_AUTH_TOKEN). */
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
    if (this.token) parts.push(`-H "authorization: Bearer $MCP_AUTH_TOKEN"`);
    for (const [name, value] of Object.entries(this.headers))
      parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
    parts.push(`-d ${shellQuote(JSON.stringify(message))}`);
    return parts.join(' \\\n  ');
  }

  // --- internals -------------------------------------------------------------

  requestHeaders(extra = {}) {
    const headers = { ...this.headers, ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
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

  send(message, { expectResponse = true } = {}) {
    this.emit('out', message);
    return this.transport === 'sse'
      ? this.sendSse(message, expectResponse)
      : this.sendStreamable(message, expectResponse);
  }

  async httpFetch(url, init) {
    try {
      return await this.fetch(url, init);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`No response within ${Math.round(this.timeoutMs / 1000)} s.`);
      }
      throw new Error(networkHint(url));
    }
  }

  /** Turns a failure while reading a successful response body into a readable message. */
  bodyReadError(error, expectedJson = false) {
    if (error && error.name === 'AbortError') {
      return new Error(`No response within ${Math.round(this.timeoutMs / 1000)} s.`);
    }
    if (expectedJson && error instanceof SyntaxError) {
      return new Error(
        'The server answered with something other than JSON. Check the endpoint URL (usually /mcp).'
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async failFromResponse(res) {
    const body = await res.text().catch(() => '');
    const error = new McpHttpError(
      res.status,
      body,
      explainHttpError(res.status, body, {
        hasToken: Boolean(this.token),
        hadSession: Boolean(this.sessionId),
      })
    );
    this.emit('in', null, { status: res.status, error: error.message });
    throw error;
  }

  async sendStreamable(message, expectResponse) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.httpFetch(this.url, {
        method: 'POST',
        headers: this.requestHeaders({
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        }),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = res.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      if (!res.ok) await this.failFromResponse(res);
      if (!expectResponse || res.status === 202) {
        await res.body?.cancel?.().catch?.(() => {});
        return null;
      }
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        try {
          return await this.readStreamFor(res, message.id);
        } catch (error) {
          throw this.bodyReadError(error);
        }
      }
      let payload;
      try {
        payload = await res.json();
      } catch (error) {
        throw this.bodyReadError(error, true);
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      let match;
      for (const msg of messages) {
        this.emit('in', msg, { status: res.status });
        if (isResponse(msg) && msg.id === message.id) match = msg;
      }
      if (!match) throw new Error('The server answered without a response to this request.');
      return match;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads an SSE response body until the response with this id arrives. */
  async readStreamFor(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          const msg = this.parseMessage(event.data);
          if (!msg) continue;
          this.emit('in', msg, { status: res.status });
          if (isResponse(msg) && msg.id === id) return msg;
          if (isServerRequest(msg)) this.answerServerRequest(msg);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new Error('The stream ended before the server responded.');
  }

  parseMessage(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** Answers server-to-client requests: ping succeeds, anything else is unsupported. */
  answerServerRequest(msg) {
    const reply =
      msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `The playground does not support ${msg.method}` },
          };
    this.send(reply, { expectResponse: false }).catch(() => {});
  }

  // --- HTTP+SSE (the older transport, used by --transport=web) ---------------

  async openSse() {
    this.sseAbort = new AbortController();
    const res = await this.httpFetch(this.url, {
      headers: this.requestHeaders({ accept: 'text/event-stream' }),
      signal: this.sseAbort.signal,
    });
    if (!res.ok) await this.failFromResponse(res);
    let resolveEndpoint;
    let rejectEndpoint;
    const endpoint = new Promise((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    const timer = setTimeout(
      () => rejectEndpoint(new Error('The SSE stream sent no endpoint event.')),
      this.timeoutMs
    );
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let failure;
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.event === 'endpoint') {
              this.messageUrl = new URL(event.data.trim(), this.url).href;
              resolveEndpoint();
              continue;
            }
            if (event.event !== 'message') continue;
            const msg = this.parseMessage(event.data);
            if (!msg) continue;
            this.emit('in', msg);
            if (isResponse(msg) && this.pending.has(msg.id)) {
              this.pending.get(msg.id).resolve(msg);
              this.pending.delete(msg.id);
            } else if (isServerRequest(msg)) {
              this.answerServerRequest(msg);
            }
          }
        }
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

  async sendSse(message, expectResponse) {
    if (!this.messageUrl) throw new Error('Not connected.');
    let waiter;
    if (expectResponse) {
      waiter = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(message.id);
          reject(new Error(`No response within ${Math.round(this.timeoutMs / 1000)} s.`));
        }, this.timeoutMs);
        this.pending.set(message.id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    }
    const abandon = (error) => {
      if (!expectResponse) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      waiter.catch(() => {});
      entry?.reject(error);
    };
    let res;
    try {
      res = await this.httpFetch(this.messageUrl, {
        method: 'POST',
        headers: this.requestHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(message),
      });
      if (!res.ok) await this.failFromResponse(res);
    } catch (error) {
      abandon(error);
      throw error;
    }
    await res.body?.cancel?.().catch?.(() => {});
    return expectResponse ? waiter : null;
  }
}
