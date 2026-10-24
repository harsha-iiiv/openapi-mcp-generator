/**
 * Generator for StreamableHTTP server code for the MCP server using Hono
 */
import { InboundAuthMode } from '../types/index.js';
import {
  generateNodeInboundAuthImports,
  generateNodeInboundAuthMiddleware,
  generateNodeInboundAuthMounts,
  generateNodeOriginGuard,
} from './inbound-auth.js';
import {
  generateNodePlaygroundImports,
  generateNodePlaygroundMount,
  generateNodePlaygroundRoutes,
} from './playground.js';

/**
 * Generates StreamableHTTP server code for the MCP server
 *
 * @param port Server port (default: 3000)
 * @param enableHeaderPassthrough Forward configured inbound headers upstream (issue #55)
 * @param inboundAuth Require a bearer token on /mcp (issue #80)
 * @returns Generated code for the StreamableHTTP server
 */
export function generateStreamableHttpCode(
  port: number = 3000,
  enableHeaderPassthrough: boolean = false,
  inboundAuth: InboundAuthMode = 'none'
): string {
  const headerStoreImport = enableHeaderPassthrough
    ? `\nimport { inboundHeaderStore } from './index.js';`
    : '';
  const contextImport = enableHeaderPassthrough ? `\nimport type { Context } from 'hono';` : '';
  const collectHeadersFn = enableHeaderPassthrough
    ? `
/**
 * Snapshot of this request's headers for header passthrough (issue #55). Stored in
 * request-scoped AsyncLocalStorage, so concurrent requests never see each other's.
 */
function collectInboundHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}
`
    : '';
  // Wrap a transport call so executeApiTool can read this request's headers.
  const withHeaders = (call: string) =>
    enableHeaderPassthrough
      ? `inboundHeaderStore.run(collectInboundHeaders(c), () => ${call})`
      : call;
  return `
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";${contextImport}${headerStoreImport}${generateNodeInboundAuthImports(inboundAuth)}${generateNodePlaygroundImports()}

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

${generateNodePlaygroundRoutes()}
/** Creates a fresh MCP server instance; one per session (SDK >= 1.26). */
type ServerFactory = () => Server;

/** Hono context variables set by middleware. */
type AppEnv = { Variables: { inboundPrincipal?: string } };

/** An open MCP session: its transport and the credential digest that opened it. */
interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  principal?: string;
  /** When the session last finished a request (ms), for closing abandoned sessions. */
  lastSeen: number;
  /** Requests and streams in flight, including an open GET stream; never idle while > 0. */
  active: number;
}

/** Default idle time after which an open session is closed: 30 minutes. */
const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 1800;

/**
 * Idle timeout for sessions in milliseconds, from MCP_SESSION_IDLE_TIMEOUT (seconds).
 * 0 disables it; a missing or invalid value uses the 30-minute default.
 */
function sessionIdleTimeoutMs(): number {
  const raw = (process.env.MCP_SESSION_IDLE_TIMEOUT ?? '').trim();
  if (raw === '') return DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.error('Ignoring invalid MCP_SESSION_IDLE_TIMEOUT "' + raw + '"; using ' + DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS + ' seconds.');
    return DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  }
  return seconds * 1000;
}
${generateNodeOriginGuard()}${generateNodeInboundAuthMiddleware(inboundAuth)}${collectHeadersFn}
/**
 * Returns the response with a body that calls \`done\` once, when the body ends, fails or
 * is cancelled (the client disconnected). This tracks the full life of an SSE stream.
 */
function onBodyDone(res: Response, done: () => void): Response {
  if (!res.body) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** JSON-RPC error body for transport-level failures. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

/** True when a request body is, or contains, an initialize request. */
function containsInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((message) => isInitializeRequest(message)) : isInitializeRequest(body);
}

/**
 * Sets up a web server for the MCP server using StreamableHTTP transport
 * 
 * @param createServer Factory returning a fresh MCP server for each session
 * @param port The port to listen on (default: ${port})
 * @returns The Hono app instance
 */
export async function setupStreamableHttpServer(createServer: ServerFactory, port = ${port}) {
  // Create Hono app
  const app = new Hono<AppEnv>();
  
  // Enable CORS and expose the MCP response headers to browser clients
  app.use('*', cors({ exposeHeaders: ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate'] }));
${generateNodeInboundAuthMounts(inboundAuth, ['/mcp'])}
  // Open sessions by ID. Each session owns its own server instance, so
  // concurrent clients never share protocol state.
  const sessions = new Map<string, Session>();

  // Clients that disconnect without DELETE never close their session, so idle
  // sessions are closed (MCP_SESSION_IDLE_TIMEOUT seconds, default 30 minutes; 0
  // disables). A client that comes back gets 404 and starts a new session.
  const idleTimeoutMs = sessionIdleTimeoutMs();
  if (idleTimeoutMs > 0) {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        // A session with an open stream or request in flight is in use, not idle.
        if (session.active > 0 || now - session.lastSeen < idleTimeoutMs) continue;
        console.error(\`Closing idle session: \${id}\`);
        sessions.delete(id);
        session.transport.close().catch((err) => console.error('Error closing idle session:', err));
      }
    }, Math.max(1000, Math.min(idleTimeoutMs, 60_000)));
    sweep.unref();
  }
  
  // Add a simple health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });
  
  // MCP endpoint: POST carries messages, GET opens the server-to-client stream,
  // DELETE ends the session.
  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id');
    const principal = c.get('inboundPrincipal');

    if (sessionId) {
      const session = sessions.get(sessionId);
      // Unknown session, or a different credential than the one that opened it:
      // answer exactly as if the session did not exist.
      if (!session || session.principal !== principal) {
        return c.json(jsonRpcError(-32001, 'Session not found'), 404);
      }
      // Count the request until its response body ends, so a long-lived GET stream or
      // slow tool call keeps the session out of the idle sweep.
      session.active += 1;
      session.lastSeen = Date.now();
      const release = () => {
        session.active -= 1;
        session.lastSeen = Date.now();
      };
      let response: Response;
      try {
        response = await ${withHeaders('session.transport.handleRequest(c.req.raw)')};
      } catch (err) {
        release();
        throw err;
      }
      return onBodyDone(response, release);
    }

    if (c.req.method !== 'POST') {
      return c.json(jsonRpcError(-32000, 'Bad Request: missing mcp-session-id header.'), 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonRpcError(-32700, 'Parse error: invalid JSON.'), 400);
    }
    if (!containsInitialize(body)) {
      return c.json(jsonRpcError(-32000, 'Bad Request: no valid session ID or initialize request.'), 400);
    }

    // New session: a fresh server + transport pair, bound to the opening credential.
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        console.error(\`New session established: \${id}\`);
        sessions.set(id, { transport, principal, lastSeen: Date.now(), active: 0 });
      },
      onsessionclosed: (id) => {
        console.error(\`Session closed: \${id}\`);
        sessions.delete(id);
      },
    });
    transport.onerror = (err) => {
      console.error('StreamableHTTP transport error:', err);
    };
    // Every close path (DELETE, idle timeout, shutdown) releases the session. Set
    // before connect(), which chains this handler with the server's own.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
    };
    const server = createServer();
    await server.connect(transport);
    return ${withHeaders('transport.handleRequest(c.req.raw, { parsedBody: body })')};
  });
  
${generateNodePlaygroundMount('app')}
  // Start the server
  serve({
    fetch: app.fetch,
    port
  }, (info) => {
    console.error(\`MCP StreamableHTTP Server running at http://localhost:\${info.port}\`);
    console.error(\`- MCP Endpoint: http://localhost:\${info.port}/mcp\`);
    console.error(\`- Health Check: http://localhost:\${info.port}/health\`);
    console.error(\`- Playground: http://localhost:\${info.port}/\`);
  });
  
  return app;
}
`;
}
