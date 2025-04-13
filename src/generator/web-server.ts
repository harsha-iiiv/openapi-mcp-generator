/**
 * Generator for web server code for the MCP server
 */

/**
 * Generates web server code for the MCP server (using Express and SSE)
 * 
 * @param port Server port (default: 3000)
 * @returns Generated code for the web server
 */
export function generateWebServerCode(port: number = 3000): string {
    return `
/**
 * Web server setup for HTTP-based MCP communication
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

/**
 * Sets up a web server for the MCP server using Server-Sent Events (SSE)
 * 
 * @param server The MCP Server instance
 * @param port The port to listen on (default: ${port})
 * @returns The Express app instance
 */
export async function setupWebServer(server: Server, port = ${port}) {
  // Create Express app
  const app = express();
  
  // Enable CORS
  app.use(cors());
  
  // Parse JSON requests
  app.use(express.json());
  
  // Add a simple health check endpoint
  app.get('/health', (_, res) => {
    res.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });
  
  // Store active SSE transports by session ID
  const transports: {[sessionId: string]: SSEServerTransport} = {};
  
  // SSE endpoint for clients to connect to
  app.get("/sse", async (req: Request, res: Response) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Enable CORS for SSE
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    
    // Send initial comment to establish connection
    res.write(':\\n\\n');
    
    // Create new transport for this client
    const transport = new SSEServerTransport('/api/messages', res);
    const sessionId = transport.sessionId;
    
    console.error(\`New SSE connection established: \${sessionId}\`);
    transports[sessionId] = transport;
    
    // Clean up on connection close
    req.on('close', () => {
      console.error(\`SSE connection closed: \${sessionId}\`);
      delete transports[sessionId];
    });
    
    // Connect the transport to the MCP server
    try {
      await server.connect(transport);
    } catch (error) {
      console.error(\`Error connecting transport for session \${sessionId}:\`, error);
      // Don't try to send errors to the client here, as headers may already be sent
    }
  });
  
  // API endpoint for clients to send messages
  app.post("/api/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
      return res.status(400).send('Missing sessionId query parameter');
    }
    
    const transport = transports[sessionId];
    
    if (!transport) {
      return res.status(404).send('No active session found with the provided sessionId');
    }
    
    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(\`Error handling message for session \${sessionId}:\`, error);
      
      // If the response hasn't been sent yet, send an error response
      if (!res.headersSent) {
        res.status(500).send('Internal server error processing message');
      }
    }
  });
  
  // Static files for the web client (if any)
  app.use(express.static('public'));
  
  // Start the server
  app.listen(port, () => {
    console.error(\`MCP Web Server running at http://localhost:\${port}\`);
    console.error(\`- SSE Endpoint: http://localhost:\${port}/sse\`);
    console.error(\`- Messages Endpoint: http://localhost:\${port}/api/messages?sessionId=YOUR_SESSION_ID\`);
    console.error(\`- Health Check: http://localhost:\${port}/health\`);
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
      
      // Handle all SSE events
      eventSource.onmessage = (event) => {
        log('RAW', event.data);
        
        try {
          const data = JSON.parse(event.data);
          
          // The MCP SSE transport sends messages in jsonrpc format
          // Check if this is a notification with clientInfo containing sessionId
          if (data.method === 'notification' && data.params?.clientInfo?.sessionId) {
            sessionId = data.params.clientInfo.sessionId;
            statusEl.textContent = \`Connected (Session ID: \${sessionId})\`;
            userInput.disabled = false;
            sendButton.disabled = false;
            userInput.focus();
            appendMessage('system', \`Connected with session ID: \${sessionId}\`);
            log('INFO', \`Received session ID from MCP notification: \${sessionId}\`);
            return;
          }
          
          // Check for legacy session_id format (our custom format)
          if (data.type === 'session_id') {
            sessionId = data.session_id;
            statusEl.textContent = \`Connected (Session ID: \${sessionId})\`;
            userInput.disabled = false;
            sendButton.disabled = false;
            userInput.focus();
            appendMessage('system', \`Connected with session ID: \${sessionId}\`);
            log('INFO', \`Received session ID from legacy format: \${sessionId}\`);
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
      };
      
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
        
        const response = await fetch(\`/api/messages?sessionId=\${sessionId}\`, {
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