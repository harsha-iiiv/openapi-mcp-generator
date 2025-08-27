/**
 * Generator for web server code for the MCP server using Hono with SSE streaming
 */

/**
 * Generates web server code for the MCP server (using Hono and SSE)
 *
 * @param port Server port (default: 3000)
 * @returns Generated code for the web server
 */
export function generateWebServerCode(port: number = 3000): string {
  return `
/**
* Web server setup for HTTP-based MCP communication using Hono
*/
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { v4 as uuid } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { JSONRPCMessage, JSONRPCMessageSchema, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

/**
* Custom SSE Transport implementation using Hono's streaming API
*/
class SSETransport implements Transport {
private _sessionId: string;
private stream: SSEStreamingApi;
private messageUrl: string;

onclose?: () => void;
onerror?: (error: Error) => void;
onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

constructor(messageUrl: string, stream: SSEStreamingApi) {
  this._sessionId = uuid();
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
      // Parse and validate the message
      const parsedMessage = JSONRPCMessageSchema.parse(body);
      
      // Forward to the message handler
      if (this.onmessage) {
        this.onmessage(parsedMessage, {requestInfo: {headers: c.req.header()}});
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
* @param server The MCP Server instance
* @param port The port to listen on (default: ${port})
* @returns The Hono app instance
*/
export async function setupWebServer(server: Server, port = ${port}) {
// Create Hono app
const app = new Hono();

// Enable CORS
app.use('*', cors());

// Store active SSE transports by session ID
const transports: {[sessionId: string]: SSETransport} = {};

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
    
    // Store the transport
    transports[sessionId] = transport;
    
    // Set up cleanup on transport close
    transport.onclose = () => {
      console.error(\`SSE connection closed for session \${sessionId}\`);
      delete transports[sessionId];
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
      
      // Connect to the MCP server
      await server.connect(transport);
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
  
  if (!transport) {
    return c.json({ error: 'No active session found with the provided sessionId' }, 404);
  }
  
  return transport.handlePostMessage(c);
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
  console.error(\`MCP Web Server running at http://localhost:\${info.port}\`);
  console.error(\`- SSE Endpoint: http://localhost:\${info.port}/sse\`);
  console.error(\`- Messages Endpoint: http://localhost:\${info.port}/api/messages?sessionId=YOUR_SESSION_ID\`);
  console.error(\`- Health Check: http://localhost:\${info.port}/health\`);
});

return app;
}
`;
}

/**
 * Generates HTML client for testing the MCP server
 *
 * @param serverName The name of the MCP server
 * @returns HTML content for the test client
 */
export function generateTestClientHtml(serverName: string): string {
  // HTML client remains the same
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${serverName} MCP Test Client</title>
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
<h1>${serverName} MCP Test Client</h1>
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
  let eventSource = null;
  let apiEndpoint = '/api/messages'; // default endpoint
  
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
  
  // Connect to SSE endpoint
  function connect() {
    statusEl.textContent = 'Connecting...';
    log('INFO', 'Connecting to SSE endpoint...');
    
    // Close existing connection if any
    if (eventSource) {
      eventSource.close();
      log('INFO', 'Closed existing connection');
    }
    
    eventSource = new EventSource('/sse');
    
    eventSource.onopen = () => {
      log('INFO', 'SSE connection opened');
      statusEl.textContent = 'Connected, waiting for session ID...';
    };
    
    eventSource.onerror = (error) => {
      log('ERROR', \`SSE connection error: \${error}\`);
      statusEl.textContent = 'Connection error. Reconnecting in 3s...';
      setTimeout(connect, 3000);
    };
    
    // Listen for the endpoint event
    eventSource.addEventListener('endpoint', (event) => {
      apiEndpoint = event.data;
      log('INFO', \`API endpoint received: \${apiEndpoint}\`);
    });
    
    // Listen for the session event
    eventSource.addEventListener('session', (event) => {
      log('INFO', \`Session data received: \${event.data}\`);
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'session_id') {
          sessionId = data.session_id;
          statusEl.textContent = \`Connected (Session ID: \${sessionId})\`;
          userInput.disabled = false;
          sendButton.disabled = false;
          userInput.focus();
          appendMessage('system', \`Connected with session ID: \${sessionId}\`);
          log('INFO', \`Received session ID: \${sessionId}\`);
        }
      } catch (error) {
        log('ERROR', \`Error parsing session data: \${error.message}\`);
      }
    });
    
    // Listen for regular messages
    eventSource.addEventListener('message', (event) => {
      log('RAW', event.data);
      
      try {
        const data = JSON.parse(event.data);
        
        // The MCP SSE transport sends messages in jsonrpc format
        // Check if this is a notification with clientInfo containing sessionId
        if (data.method === 'notification' && data.params?.clientInfo?.sessionId) {
          if (!sessionId) {
            sessionId = data.params.clientInfo.sessionId;
            statusEl.textContent = \`Connected (Session ID: \${sessionId})\`;
            userInput.disabled = false;
            sendButton.disabled = false;
            userInput.focus();
            appendMessage('system', \`Connected with session ID: \${sessionId}\`);
            log('INFO', \`Received session ID from MCP notification: \${sessionId}\`);
          }
          return;
        }
        
        // Handle jsonrpc responses
        if (data.jsonrpc === '2.0' && data.result) {
          appendMessage('server', JSON.stringify(data.result, null, 2));
          userInput.focus();
          return;
        }
        
        // Handle normal server messages with content
        if (data.content) {
          appendMessage('server', JSON.stringify(data, null, 2));
          userInput.focus();
        } else {
          log('INFO', \`Received other message: \${JSON.stringify(data)}\`);
        }
      } catch (error) {
        log('ERROR', \`Error parsing SSE message: \${error.message}\`);
        appendMessage('system', \`Error parsing message: \${event.data}\`);
      }
    });
    
    return eventSource;
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
      
      // Use the endpoint provided by the server, or fall back to the default
      const endpoint = apiEndpoint || \`/api/messages?sessionId=\${sessionId}\`;
      const fullEndpoint = apiEndpoint.includes('?') ? 
        \`\${apiEndpoint}&sessionId=\${sessionId}\` : 
        \`\${apiEndpoint}?sessionId=\${sessionId}\`;
      
      const response = await fetch(fullEndpoint, {
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
      } else {
        log('INFO', \`Request sent successfully\`);
        // Note: We don't handle the response content here because the response
        // will come through the SSE connection, not this fetch response
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
  
  // Connect on page load
  appendMessage('system', 'Connecting to server...');
  connect();
  
  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (eventSource) eventSource.close();
  });
</script>
</body>
</html>`;
}
