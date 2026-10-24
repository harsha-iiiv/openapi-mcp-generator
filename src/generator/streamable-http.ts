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
import { createMcpHandler, type Server } from "@modelcontextprotocol/server";${contextImport}${headerStoreImport}${generateNodeInboundAuthImports(inboundAuth)}${generateNodePlaygroundImports()}

// Import server configuration constants
import { SERVER_NAME, SERVER_VERSION } from './index.js';

${generateNodePlaygroundRoutes()}
/** Creates a fresh MCP server instance for one request. */
type ServerFactory = () => Server;

/** Hono context variables set by middleware. */
type AppEnv = { Variables: { inboundPrincipal?: string } };
${generateNodeOriginGuard()}${generateNodeInboundAuthMiddleware(inboundAuth)}${collectHeadersFn}
/**
 * Sets up a web server for the MCP server using StreamableHTTP transport
 * 
 * @param createServer Factory returning a fresh MCP server for each request
 * @param port The port to listen on (default: ${port})
 * @returns The Hono app instance
 */
export async function setupStreamableHttpServer(createServer: ServerFactory, port = ${port}) {
  // Create Hono app
  const app = new Hono<AppEnv>();
  
  // Enable CORS: request headers such as Mcp-Method and Mcp-Name are reflected, and the
  // MCP response headers are exposed to browser clients such as the playground.
  app.use('*', cors({ exposeHeaders: ['mcp-protocol-version', 'www-authenticate'] }));
${generateNodeInboundAuthMounts(inboundAuth, ['/mcp'])}
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
  app.all('/mcp', (c) => ${withHeaders('mcpHandler.fetch(c.req.raw)')});
  
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
