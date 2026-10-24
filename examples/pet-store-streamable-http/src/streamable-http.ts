
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createMcpHandler, type Server } from "@modelcontextprotocol/server";
import type { MiddlewareHandler } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';


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

/** Creates a fresh MCP server instance for one request. */
type ServerFactory = () => Server;

/** Hono context variables set by middleware. */
type AppEnv = { Variables: { inboundPrincipal?: string } };

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
 * Sets up a web server for the MCP server using StreamableHTTP transport
 * 
 * @param createServer Factory returning a fresh MCP server for each request
 * @param port The port to listen on (default: 3000)
 * @returns The Hono app instance
 */
export async function setupStreamableHttpServer(createServer: ServerFactory, port = 3000) {
  // Create Hono app
  const app = new Hono<AppEnv>();
  
  // Enable CORS: request headers such as Mcp-Method and Mcp-Name are reflected, and the
  // MCP response headers are exposed to browser clients such as the playground.
  app.use('*', cors({ exposeHeaders: ['mcp-protocol-version', 'www-authenticate'] }));

  // DNS-rebinding protection: browser requests need a loopback or allowed origin.
  const originGuard = createOriginGuard();
  app.use('/mcp', originGuard);

  // One handler serves both protocol eras per request: MCP 2026-07-28
  // (server/discover, per-request metadata) and 2025-era clients through
  // stateless serving. Every request gets a fresh server, so nothing is shared
  // between clients and the server scales behind any load balancer.
  const mcpHandler = createMcpHandler(() => createServer(), {
    onerror: (error) => console.error('MCP request error:', error),
  });
  
  // Add a simple health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });
  
  // MCP endpoint
  app.all('/mcp', (c) => mcpHandler.fetch(c.req.raw));
  

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
    console.error(`MCP StreamableHTTP Server running at http://localhost:${info.port}`);
    console.error(`- MCP Endpoint: http://localhost:${info.port}/mcp`);
    console.error(`- Health Check: http://localhost:${info.port}/health`);
    console.error(`- Playground: http://localhost:${info.port}/`);
  });
  
  return app;
}
