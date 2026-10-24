/**
 * Generator for web server code for the MCP server using Hono with SSE streaming
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
 * Generates web server code for the MCP server (using Hono and SSE)
 *
 * @param port Server port (default: 3000)
 * @param enableHeaderPassthrough Forward configured inbound headers upstream (issue #55)
 * @param inboundAuth Require a bearer token on /sse and /api/messages (issue #80)
 * @returns Generated code for the web server
 */
export function generateWebServerCode(
  port: number = 3000,
  enableHeaderPassthrough: boolean = false,
  inboundAuth: InboundAuthMode = 'none'
): string {
  const headerStoreImport = enableHeaderPassthrough
    ? `\nimport { inboundHeaderStore } from './index.js';`
    : '';
  return `
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
import { SERVER_NAME, SERVER_VERSION } from './index.js';${headerStoreImport}${generateNodeInboundAuthImports(inboundAuth)}${generateNodePlaygroundImports()}
${generateNodePlaygroundRoutes()}${generateNodeOriginGuard()}${generateNodeInboundAuthMiddleware(inboundAuth)}
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
    console.error(\`SSE connection aborted for session \${this._sessionId}\`);
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
    data: \`\${this.messageUrl}?sessionId=\${this._sessionId}\`
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
* @param port The port to listen on (default: ${port})
* @returns The Hono app instance
*/
export async function setupWebServer(createServer: () => Server, port = ${port}) {
// Create Hono app
const app = new Hono<{ Variables: { inboundPrincipal?: string } }>();

// Enable CORS and expose auth challenges to browser clients
app.use('*', cors({ exposeHeaders: ['www-authenticate'] }));
${generateNodeInboundAuthMounts(inboundAuth, ['/sse', '/api/messages'])}
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
    
    console.error(\`New SSE connection established: \${sessionId}\`);
    
    // Store the transport and bind the session to the opening credential
    transports[sessionId] = transport;
    principals[sessionId] = c.get('inboundPrincipal');
    
    // Set up cleanup on transport close
    transport.onclose = () => {
      console.error(\`SSE connection closed for session \${sessionId}\`);
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
      console.error(\`Error connecting transport for session \${sessionId}:\`, error);
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
${
  enableHeaderPassthrough
    ? `
  // Capture inbound headers into request-scoped storage so configured ones can
  // be forwarded to the upstream API by executeApiTool (header passthrough,
  // issue #55). AsyncLocalStorage keeps this per-request — no cross-request leak.
  const __inbound: Record<string, string> = {};
  try {
    for (const [k, v] of Object.entries(c.req.header())) {
      if (typeof v === 'string') __inbound[k.toLowerCase()] = v;
    }
  } catch {
    // Non-fatal: passthrough simply won't apply if headers can't be read.
  }
  return inboundHeaderStore.run(__inbound, () => transport.handlePostMessage(c));`
    : `
  return transport.handlePostMessage(c);`
}
});

${generateNodePlaygroundMount('app')}
// Start the server
serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.error(\`MCP Web Server running at http://localhost:\${info.port}\`);
  console.error(\`- SSE Endpoint: http://localhost:\${info.port}/sse\`);
  console.error(\`- Messages Endpoint: http://localhost:\${info.port}/api/messages?sessionId=YOUR_SESSION_ID\`);
  console.error(\`- Health Check: http://localhost:\${info.port}/health\`);
  console.error(\`- Playground: http://localhost:\${info.port}/\`);
});

return app;
}
`;
}
