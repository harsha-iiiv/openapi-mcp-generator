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
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";${contextImport}${headerStoreImport}${generateNodeInboundAuthImports(inboundAuth)}

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

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
  
  // Enable CORS and expose the session header to browser clients
  app.use('*', cors({ exposeHeaders: ['mcp-session-id'] }));
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
  
  // Static files for the web client (if any)
  app.get('/*', async (c) => {
    const filePath = c.req.path === '/' ? '/index.html' : c.req.path;
    try {
      // Use Node.js fs to serve static files
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const publicPath = path.join(__dirname, '..', '..', 'public');
      const fullPath = path.join(publicPath, filePath);
      
      // Simple security check to prevent directory traversal
      if (!fullPath.startsWith(publicPath)) {
        return c.text('Forbidden', 403);
      }
      
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(fullPath);
          
          // Set content type based on file extension
          const ext = path.extname(fullPath).toLowerCase();
          let contentType = 'text/plain';
          
          switch (ext) {
            case '.html': contentType = 'text/html'; break;
            case '.css': contentType = 'text/css'; break;
            case '.js': contentType = 'text/javascript'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
            case '.jpg': contentType = 'image/jpeg'; break;
            case '.svg': contentType = 'image/svg+xml'; break;
          }
          
          return new Response(content, {
            headers: { 'Content-Type': contentType }
          });
        }
      } catch (err) {
        // File not found or other error
        return c.text('Not Found', 404);
      }
    } catch (err) {
      console.error('Error serving static file:', err);
      return c.text('Internal Server Error', 500);
    }
    
    return c.text('Not Found', 404);
  });
  
  // Start the server
  serve({
    fetch: app.fetch,
    port
  }, (info) => {
    console.error(\`MCP StreamableHTTP Server running at http://localhost:\${info.port}\`);
    console.error(\`- MCP Endpoint: http://localhost:\${info.port}/mcp\`);
    console.error(\`- Health Check: http://localhost:\${info.port}/health\`);
  });
  
  return app;
}
`;
}

/**
 * Generates HTML client page for testing the MCP StreamableHTTP server
 *
 * @param serverName The name of the MCP server
 * @returns HTML content for the test client
 */
export function generateStreamableHttpClientHtml(serverName: string): string {
  // HTML client remains the same
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverName} MCP StreamableHTTP Test Client</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      line-height: 1.5;
    }
    h1 { margin-bottom: 10px; }
    .container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 150px);
    }
    #conversation {
      flex: 1;
      border: 1px solid #ccc;
      overflow-y: auto;
      margin-bottom: 10px;
      padding: 10px;
      border-radius: 5px;
    }
    .input-area {
      display: flex;
      margin-bottom: 20px;
    }
    #userInput {
      flex: 1;
      padding: 8px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 5px 0 0 5px;
    }
    #sendButton {
      padding: 8px 16px;
      background-color: #4CAF50;
      color: white;
      border: none;
      cursor: pointer;
      border-radius: 0 5px 5px 0;
    }
    #sendButton:hover { background-color: #45a049; }
    .message {
      margin-bottom: 10px;
      padding: 8px 12px;
      border-radius: 5px;
    }
    .user {
      background-color: #e7f4ff;
      align-self: flex-end;
    }
    .server {
      background-color: #f1f1f1;
    }
    .system {
      background-color: #fffde7;
      color: #795548;
      font-style: italic;
    }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    code {
      background-color: #f8f8f8;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .status { 
      color: #666;
      font-style: italic;
      margin-bottom: 10px;
    }
    #debug {
      margin-top: 20px;
      background-color: #f8f8f8;
      padding: 10px;
      border-radius: 5px;
      display: none;
    }
    .debug-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #showDebug {
      margin-top: 10px;
      padding: 5px 10px;
      cursor: pointer;
      background-color: #f1f1f1;
      border: 1px solid #ccc;
      border-radius: 3px;
    }
    #debugLog {
      max-height: 200px;
      overflow-y: auto;
      background-color: #111;
      color: #0f0;
      font-family: monospace;
      padding: 5px;
      margin-top: 10px;
    }
    .clear-debug {
      padding: 3px 8px;
      background-color: #f44336;
      color: white;
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>${serverName} MCP StreamableHTTP Test Client</h1>
  <p class="status" id="status">Disconnected</p>
  
  <div class="container">
    <div id="conversation"></div>
    
    <div class="input-area">
      <input type="text" id="userInput" placeholder="Type a message..." disabled>
      <button id="sendButton" disabled>Send</button>
    </div>
  </div>
  
  <button id="showDebug">Show Debug Console</button>
  
  <div id="debug">
    <div class="debug-controls">
      <h3>Debug Console</h3>
      <button class="clear-debug" id="clearDebug">Clear</button>
    </div>
    <div id="debugLog"></div>
  </div>
  
  <script>
    const conversation = document.getElementById('conversation');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const statusEl = document.getElementById('status');
    const showDebugBtn = document.getElementById('showDebug');
    const debugDiv = document.getElementById('debug');
    const debugLog = document.getElementById('debugLog');
    const clearDebugBtn = document.getElementById('clearDebug');
    
    let sessionId = null;
    let messageId = 1;
    
    // Debug logging
    function log(type, message) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
      const entry = document.createElement('div');
      entry.innerHTML = \`<span style="color:#aaa;">\${timestamp}</span> <span style="color:#58a6ff;">\${type}:</span> \${message}\`;
      debugLog.appendChild(entry);
      debugLog.scrollTop = debugLog.scrollHeight;
      console.log(\`\${type}: \${message}\`);
    }
    
    // Toggle debug console
    showDebugBtn.addEventListener('click', () => {
      if (debugDiv.style.display === 'block') {
        debugDiv.style.display = 'none';
        showDebugBtn.textContent = 'Show Debug Console';
      } else {
        debugDiv.style.display = 'block';
        showDebugBtn.textContent = 'Hide Debug Console';
      }
    });
    
    // Clear debug logs
    clearDebugBtn.addEventListener('click', () => {
      debugLog.innerHTML = '';
    });
    
    // Initialize the MCP connection
    async function initialize() {
      statusEl.textContent = 'Connecting...';
      log('INFO', 'Initializing MCP connection...');
      
      try {
        const requestBody = {
          jsonrpc: '2.0',
          id: messageId++,
          method: 'initialize',
          params: {
            clientName: 'MCP StreamableHTTP Test Client',
            clientVersion: '1.0.0',
            capabilities: {}
          }
        };
        
        log('REQUEST', JSON.stringify(requestBody));
        
        const response = await fetch('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          log('ERROR', \`Error response: \${response.status} \${response.statusText} \${errorText}\`);
          appendMessage('system', \`Error: \${response.status} \${response.statusText}\\n\${errorText}\`);
          statusEl.textContent = 'Connection error. Try again.';
          return;
        }
        
        // Get session ID from response headers
        sessionId = response.headers.get('mcp-session-id');
        
        if (!sessionId) {
          log('ERROR', 'No session ID in response headers');
          appendMessage('system', 'Error: No session ID in response headers');
          statusEl.textContent = 'Connection error. Try again.';
          return;
        }
        
        // Process response body
        const data = await response.json();
        log('RESPONSE', JSON.stringify(data));
        
        if (data.result) {
          appendMessage('server', JSON.stringify(data.result, null, 2));
        }
        
        // Enable UI
        statusEl.textContent = \`Connected (Session ID: \${sessionId})\`;
        userInput.disabled = false;
        sendButton.disabled = false;
        userInput.focus();
        appendMessage('system', \`Connected with session ID: \${sessionId}\`);
        
        // Get list of tools
        await listTools();
      } catch (error) {
        log('ERROR', \`Error during initialization: \${error.message}\`);
        appendMessage('system', \`Error during initialization: \${error.message}\`);
        statusEl.textContent = 'Connection error. Try again.';
      }
    }
    
    // Get list of available tools
    async function listTools() {
      try {
        const requestBody = {
          jsonrpc: '2.0',
          id: messageId++,
          method: 'listTools',
          params: {}
        };
        
        log('REQUEST', JSON.stringify(requestBody));
        
        const response = await fetch('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'mcp-session-id': sessionId
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          log('ERROR', \`Error listing tools: \${response.status} \${response.statusText} \${errorText}\`);
          return;
        }
        
        const data = await response.json();
        log('TOOLS', JSON.stringify(data));
        
        if (data.result?.tools && Array.isArray(data.result.tools)) {
          appendMessage('system', \`Available tools: \${data.result.tools.map(t => t.name).join(', ')}\`);
        }
      } catch (error) {
        log('ERROR', \`Error listing tools: \${error.message}\`);
      }
    }
    
    // Send a message to the server
    async function sendMessage() {
      const text = userInput.value.trim();
      if (!text || !sessionId) return;
      
      appendMessage('user', text);
      userInput.value = '';
      
      log('INFO', \`Sending message: \${text}\`);
      
      try {
        const parts = text.split(' ');
        const toolName = parts[0];
        
        const requestBody = {
          jsonrpc: '2.0',
          id: messageId++,
          method: 'callTool',
          params: {
            name: toolName,
            arguments: parseArguments(text)
          }
        };
        
        log('REQUEST', JSON.stringify(requestBody));
        
        const response = await fetch('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'mcp-session-id': sessionId
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          log('ERROR', \`Error response: \${response.status} \${response.statusText} \${errorText}\`);
          appendMessage('system', \`Error: \${response.status} \${response.statusText}\\n\${errorText}\`);
          return;
        }
        
        const data = await response.json();
        log('RESPONSE', JSON.stringify(data));
        
        if (data.error) {
          appendMessage('system', \`Error: \${data.error.code} - \${data.error.message}\`);
        } else if (data.result) {
          appendMessage('server', JSON.stringify(data.result, null, 2));
        }
      } catch (error) {
        log('ERROR', \`Error sending message: \${error.message}\`);
        appendMessage('system', \`Error sending message: \${error.message}\`);
      }
    }
    
    // Try to parse arguments from user input
    // Format: toolName param1=value1 param2=value2
    function parseArguments(text) {
      const parts = text.split(' ');
      if (parts.length <= 1) return {};
      
      const args = {};
      // Skip the first part (tool name) and process the rest
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const equalsIndex = part.indexOf('=');
        
        if (equalsIndex > 0) {
          const key = part.substring(0, equalsIndex);
          const value = part.substring(equalsIndex + 1);
          
          // Try to parse as number or boolean if possible
          if (value === 'true') args[key] = true;
          else if (value === 'false') args[key] = false;
          else if (!isNaN(Number(value))) args[key] = Number(value);
          else args[key] = value;
        }
      }
      
      return args;
    }
    
    // Add a message to the conversation
    function appendMessage(sender, text) {
      const messageDiv = document.createElement('div');
      messageDiv.className = \`message \${sender}\`;
      
      // Format as code block if it looks like JSON
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text;
        pre.appendChild(code);
        messageDiv.appendChild(pre);
      } else {
        messageDiv.textContent = text;
      }
      
      conversation.appendChild(messageDiv);
      conversation.scrollTop = conversation.scrollHeight;
    }
    
    // Event listeners
    sendButton.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
    
    // Initialize on page load
    appendMessage('system', 'Initializing MCP connection...');
    initialize();
  </script>
</body>
</html>`;
}
