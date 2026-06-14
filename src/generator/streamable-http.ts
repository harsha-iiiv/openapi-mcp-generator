/**
 * Generator for StreamableHTTP server code for the MCP server using Hono
 */

/**
 * Generates StreamableHTTP server code for the MCP server
 *
 * @param port Server port (default: 3000)
 * @returns Generated code for the StreamableHTTP server
 */
export function generateStreamableHttpCode(port: number = 3000): string {
  return `
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { v4 as uuid } from 'uuid';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InitializeRequestSchema, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
import { toReqRes, toFetchResponse } from 'fetch-to-node';

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

// Constants
const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";

/**
 * StreamableHTTP MCP Server handler
 */
class MCPStreamableHttpServer {
  server: Server;
  // Store active transports by session ID
  transports: {[sessionId: string]: StreamableHTTPServerTransport} = {};
  
  constructor(server: Server) {
    this.server = server;
  }
  
  /**
   * Handle GET requests (typically used for static files)
   */
  async handleGetRequest(c: any) {
    console.error("GET request received - StreamableHTTP transport only supports POST");
    return c.text('Method Not Allowed', 405, {
      'Allow': 'POST'
    });
  }
  
  /**
   * Handle POST requests (all MCP communication)
   */
  async handlePostRequest(c: any) {
    const sessionId = c.req.header(SESSION_ID_HEADER_NAME);
    console.error(\`POST request received \${sessionId ? 'with session ID: ' + sessionId : 'without session ID'}\`);

    // Capture inbound headers so configured ones can be forwarded to the
    // upstream API by executeApiTool (header passthrough, issue #55).
    try {
      const inbound: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.header())) {
        if (typeof v === 'string') inbound[k.toLowerCase()] = v;
      }
      (globalThis as any).__mcpInboundHeaders = inbound;
    } catch {
      // Non-fatal: passthrough simply won't apply if headers can't be read.
    }

    try {
      const body = await c.req.json();
      
      // Convert Fetch Request to Node.js req/res
      const { req, res } = toReqRes(c.req.raw);
      
      // Reuse existing transport if we have a session ID
      if (sessionId && this.transports[sessionId]) {
        const transport = this.transports[sessionId];
        
        // Handle the request with the transport
        await transport.handleRequest(req, res, body);
        
        // Cleanup when the response ends
        res.on('close', () => {
          console.error(\`Request closed for session \${sessionId}\`);
        });
        
        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }
      
      // Create new transport for initialize requests
      if (!sessionId && this.isInitializeRequest(body)) {
        console.error("Creating new StreamableHTTP transport for initialize request");
        
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => uuid(),
        });
        
        // Add error handler for debug purposes
        transport.onerror = (err) => {
          console.error('StreamableHTTP transport error:', err);
        };
        
        // Connect the transport to the MCP server
        await this.server.connect(transport);
        
        // Handle the request with the transport
        await transport.handleRequest(req, res, body);
        
        // Store the transport if we have a session ID
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          console.error(\`New session established: \${newSessionId}\`);
          this.transports[newSessionId] = transport;
          
          // Set up clean-up for when the transport is closed
          transport.onclose = () => {
            console.error(\`Session closed: \${newSessionId}\`);
            delete this.transports[newSessionId];
          };
        }
        
        // Cleanup when the response ends
        res.on('close', () => {
          console.error(\`Request closed for new session\`);
        });
        
        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }
      
      // Invalid request (no session ID and not initialize)
      return c.json(
        this.createErrorResponse("Bad Request: invalid session ID or method."),
        400
      );
    } catch (error) {
      console.error('Error handling MCP request:', error);
      return c.json(
        this.createErrorResponse("Internal server error."),
        500
      );
    }
  }
  
  /**
   * Create a JSON-RPC error response
   */
  private createErrorResponse(message: string): JSONRPCError {
    return {
      jsonrpc: JSON_RPC,
      error: {
        code: -32000,
        message: message,
      },
      id: uuid(),
    };
  }
  
  /**
   * Check if the request is an initialize request
   */
  private isInitializeRequest(body: any): boolean {
    const isInitial = (data: any) => {
      const result = InitializeRequestSchema.safeParse(data);
      return result.success;
    };
    
    if (Array.isArray(body)) {
      return body.some(request => isInitial(request));
    }
    
    return isInitial(body);
  }
}

/**
 * Sets up a web server for the MCP server using StreamableHTTP transport
 * 
 * @param server The MCP Server instance
 * @param port The port to listen on (default: ${port})
 * @returns The Hono app instance
 */
export async function setupStreamableHttpServer(server: Server, port = ${port}) {
  // Create Hono app
  const app = new Hono();
  
  // Enable CORS
  app.use('*', cors());
  
  // Create MCP handler
  const mcpHandler = new MCPStreamableHttpServer(server);
  
  // Add a simple health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });
  
  // Main MCP endpoint supporting both GET and POST
  app.get("/mcp", (c) => mcpHandler.handleGetRequest(c));
  app.post("/mcp", (c) => mcpHandler.handlePostRequest(c));
  
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
