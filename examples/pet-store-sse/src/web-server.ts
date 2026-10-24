
/**
* Web server setup for HTTP-based MCP communication using Hono
*/
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCMessage,
  type Server,
  type Transport,
} from "@modelcontextprotocol/server";
import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';
import type { MiddlewareHandler } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Browser playground --------------------------------------------------------
// Open http://localhost:<port>/ to list and call tools from a browser. The same
// page is hosted at https://mcp.pidata.tech/playground for deployed servers.
// Set MCP_PLAYGROUND=off to stop serving it.
const PLAYGROUND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PLAYGROUND_ROUTES: Record<string, [string, string]> = {
  "/": [
    "index.html",
    "text/html; charset=utf-8"
  ],
  "/index.html": [
    "index.html",
    "text/html; charset=utf-8"
  ],
  "/playground.css": [
    "playground.css",
    "text/css; charset=utf-8"
  ],
  "/playground.js": [
    "playground.js",
    "text/javascript; charset=utf-8"
  ],
  "/mcp-client.js": [
    "mcp-client.js",
    "text/javascript; charset=utf-8"
  ],
  "/playground.config.json": [
    "playground.config.json",
    "application/json; charset=utf-8"
  ]
};
const PLAYGROUND_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-cache"
};

/**
 * DNS-rebinding protection: rejects browser requests from origins that are not
 * loopback and not listed in MCP_ALLOWED_ORIGINS (comma-separated, exact origins
 * such as https://app.example.com). Requests without an Origin header pass.
 */
function createOriginGuard(): MiddlewareHandler {
  const allowed = new Set(
    (process.env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let host = '';
      try {
        host = new URL(origin).hostname;
      } catch {
        // "null" and malformed origins fall through to the rejection below.
      }
      if (!loopbackHosts.has(host) && !allowed.has(origin.replace(/\/+$/, ''))) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Forbidden: origin not allowed (set MCP_ALLOWED_ORIGINS).' },
            id: null,
          },
          403
        );
      }
    }
    await next();
  };
}

/**
* Custom SSE Transport implementation using Hono's streaming API
*/
class SSETransport implements Transport {
private _sessionId: string;
private stream: SSEStreamingApi;
private messageUrl: string;

onclose?: () => void;
onerror?: (error: Error) => void;
onmessage?: (message: JSONRPCMessage) => void;

constructor(messageUrl: string, stream: SSEStreamingApi) {
  this._sessionId = randomUUID();
  this.stream = stream;
  this.messageUrl = messageUrl;
  
  // Set up stream abort handler
  this.stream.onAbort(() => {
    console.error(`SSE connection aborted for session ${this._sessionId}`);
    this.close();
  });
}

get sessionId(): string {
  return this._sessionId;
}

async start(): Promise<void> {
  if (this.stream.closed) {
    throw new Error('SSE transport already closed!');
  }
  
  // Send the endpoint information
  await this.stream.writeSSE({
    event: 'endpoint',
    data: `${this.messageUrl}?sessionId=${this._sessionId}`
  });
  
  // Send session ID and connection info in a format the client can understand
  await this.stream.writeSSE({
    event: 'session',
    data: JSON.stringify({ 
      type: 'session_id', 
      session_id: this._sessionId 
    })
  });
  
  // Send a welcome notification
  await this.send({
    jsonrpc: "2.0",
    method: "notification",
    params: {
      type: "welcome",
      clientInfo: {
        sessionId: this._sessionId,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION
      }
    }
  });
}

async handlePostMessage(c: Context): Promise<Response> {
  if (this.stream?.closed) {
    return c.text('SSE connection closed', 400);
  }
  
  try {
    // Parse and validate the message
    const body = await c.req.json();
    
    try {
      // Validate the message shape (the server validates method parameters)
      if (
        !isJSONRPCRequest(body) &&
        !isJSONRPCNotification(body) &&
        !isJSONRPCResponse(body) &&
        !isJSONRPCErrorResponse(body)
      ) {
        throw new Error('Not a JSON-RPC message');
      }
      const parsedMessage: JSONRPCMessage = body;
      
      // Forward to the message handler
      if (this.onmessage) {
        this.onmessage(parsedMessage);
        return c.text('Accepted', 202);
      } else {
        return c.text('No message handler defined', 500);
      }
    } catch (error) {
      if (this.onerror) {
        this.onerror(error instanceof Error ? error : new Error(String(error)));
      }
      console.error('Error parsing message:', error);
      return c.text('Invalid message format', 400);
    }
  } catch (error) {
    if (this.onerror) {
      this.onerror(error instanceof Error ? error : new Error(String(error)));
    }
    console.error('Error processing request:', error);
    return c.text('Error processing message', 400);
  }
}

async close(): Promise<void> {
  if (this.stream && !this.stream.closed) {
    this.stream.abort();
  }
  
  if (this.onclose) {
    this.onclose();
  }
}

async send(message: JSONRPCMessage): Promise<void> {
  if (this.stream.closed) {
    throw new Error('Not connected');
  }
  
  await this.stream.writeSSE({
    event: 'message',
    data: JSON.stringify(message)
  });
}
}

/**
* Sets up a web server for the MCP server using Server-Sent Events (SSE)
* 
* @param createServer Factory returning a fresh MCP server for each SSE connection
* @param port The port to listen on (default: 3000)
* @returns The Hono app instance
*/
export async function setupWebServer(createServer: () => Server, port = 3000) {
// Create Hono app
const app = new Hono<{ Variables: { inboundPrincipal?: string } }>();

// Enable CORS and expose auth challenges to browser clients
app.use('*', cors({ exposeHeaders: ['www-authenticate'] }));

  // DNS-rebinding protection: browser requests need a loopback or allowed origin.
  const originGuard = createOriginGuard();
  app.use('/sse', originGuard);
  app.use('/api/messages', originGuard);

// Store active SSE transports by session ID, with the credential digest that opened each
const transports: {[sessionId: string]: SSETransport} = {};
const principals: {[sessionId: string]: string | undefined} = {};

// Add a simple health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
});

// SSE endpoint for clients to connect to
app.get("/sse", (c) => {
  return streamSSE(c, async (stream) => {
    // Create SSE transport
    const transport = new SSETransport('/api/messages', stream);
    const sessionId = transport.sessionId;
    
    console.error(`New SSE connection established: ${sessionId}`);
    
    // Store the transport and bind the session to the opening credential
    transports[sessionId] = transport;
    principals[sessionId] = c.get('inboundPrincipal');
    
    // Set up cleanup on transport close
    transport.onclose = () => {
      console.error(`SSE connection closed for session ${sessionId}`);
      delete transports[sessionId];
      delete principals[sessionId];
    };
    
    // Make the transport available to the MCP server
    try {
      transport.onmessage = async (message: JSONRPCMessage) => {
        try {
          // The server will automatically send a response via the transport 
          // if the message has an ID (i.e., it's a request, not a notification)
        } catch (error) {
          console.error('Error handling MCP message:', error);
        }
      };
      
      // Each SSE connection gets its own server instance (SDK >= 1.26 allows one
      // transport per server).
      await createServer().connect(transport);
    } catch (error) {
      console.error(`Error connecting transport for session ${sessionId}:`, error);
    }
    
    // Keep the stream open until aborted
    while (!stream.closed) {
      await stream.sleep(1000);
    }
  });
});

// API endpoint for clients to send messages
app.post("/api/messages", async (c) => {
  const sessionId = c.req.query('sessionId');

  if (!sessionId) {
    return c.json({ error: 'Missing sessionId query parameter' }, 400);
  }

  const transport = transports[sessionId];

  // Unknown session, or a different credential than the one that opened it.
  if (!transport || principals[sessionId] !== c.get('inboundPrincipal')) {
    return c.json({ error: 'No active session found with the provided sessionId' }, 404);
  }

  return transport.handlePostMessage(c);
});


  // Browser playground (static files from ./public). MCP_PLAYGROUND=off disables it.
  for (const [route, [file, type]] of Object.entries(PLAYGROUND_ROUTES)) {
    app.get(route, async (c) => {
      if ((process.env.MCP_PLAYGROUND ?? '').toLowerCase() === 'off') return c.notFound();
      try {
        const body = await readFile(path.join(PLAYGROUND_DIR, file), 'utf8');
        return new Response(body, { headers: { 'Content-Type': type, ...PLAYGROUND_HEADERS } });
      } catch {
        return c.notFound();
      }
    });
  }

// Start the server
serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.error(`MCP Web Server running at http://localhost:${info.port}`);
  console.error(`- SSE Endpoint: http://localhost:${info.port}/sse`);
  console.error(`- Messages Endpoint: http://localhost:${info.port}/api/messages?sessionId=YOUR_SESSION_ID`);
  console.error(`- Health Check: http://localhost:${info.port}/health`);
  console.error(`- Playground: http://localhost:${info.port}/`);
});

return app;
}
