/**
 * Inbound authentication for generated Node HTTP servers (issue #80).
 *
 * Emitted into the web (SSE) and streamable-http transports when the generator
 * runs with `--inbound-auth bearer`. The token is never written into generated
 * files: it is read at runtime from MCP_AUTH_TOKENS (comma-separated, for
 * rotation) or MCP_AUTH_TOKEN, after dotenv has loaded `.env`.
 */
import { InboundAuthMode } from '../types/index.js';

/** True when generated HTTP servers must require a bearer token. */
export function isInboundAuthEnabled(mode?: InboundAuthMode): boolean {
  return mode === 'bearer';
}

/** Top-of-module imports needed by the Node inbound-auth middleware. */
export function generateNodeInboundAuthImports(mode?: InboundAuthMode): string {
  if (!isInboundAuthEnabled(mode)) return '';
  return `
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';`;
}

/** Module-level Hono middleware factory for bearer-token inbound auth. */
export function generateNodeInboundAuthMiddleware(mode?: InboundAuthMode): string {
  if (!isInboundAuthEnabled(mode)) return '';
  return `
/**
 * Inbound authentication (generated with --inbound-auth bearer).
 *
 * Every MCP request must carry "Authorization: Bearer <token>". Accepted tokens are
 * read when the server starts from MCP_AUTH_TOKENS (comma-separated, for rotation)
 * or MCP_AUTH_TOKEN. With no token configured the endpoint fails closed (503).
 * Requests are rejected before any MCP message is processed, so unauthenticated
 * callers can neither list nor call tools. /health stays public.
 */
function createInboundAuthMiddleware(): MiddlewareHandler<{ Variables: { inboundPrincipal?: string } }> {
  const tokens = (process.env.MCP_AUTH_TOKENS ?? process.env.MCP_AUTH_TOKEN ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const digests = tokens.map((token) => createHash('sha256').update(token).digest());
  if (digests.length === 0) {
    console.error('Inbound auth is enabled but MCP_AUTH_TOKEN is not set: MCP requests will be refused with 503.');
  }
  return async (c, next) => {
    if (digests.length === 0) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Inbound authentication is enabled but no MCP_AUTH_TOKEN is configured on the server.' },
          id: null,
        },
        503
      );
    }
    const match = /^Bearer[ \\t]+(\\S+)[ \\t]*$/i.exec(c.req.header('authorization') ?? '');
    if (match) {
      const presented = createHash('sha256').update(match[1]).digest();
      let authorized = false;
      for (const digest of digests) {
        // Check every configured token so timing does not reveal which one matched.
        if (timingSafeEqual(presented, digest)) authorized = true;
      }
      if (authorized) {
        // Sessions are bound to this credential (digest only, never the token).
        c.set('inboundPrincipal', presented.toString('hex'));
        await next();
        return;
      }
    }
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <token>".' }, id: null },
      401,
      { 'WWW-Authenticate': 'Bearer realm="mcp"' }
    );
  };
}
`;
}

/**
 * `app.use(...)` lines protecting the given routes (empty when disabled).
 * Must be emitted after CORS (so preflight requests are answered) and before
 * the route handlers.
 */
export function generateNodeInboundAuthMounts(
  mode: InboundAuthMode | undefined,
  routes: string[]
): string {
  if (!isInboundAuthEnabled(mode)) return '';
  const mounts = routes.map((route) => `  app.use('${route}', requireInboundAuth);`).join('\n');
  return `
  // Inbound authentication (--inbound-auth bearer); /health stays public.
  const requireInboundAuth = createInboundAuthMiddleware();
${mounts}
`;
}

/** .env.example block documenting the inbound token (empty when disabled). */
export function generateInboundAuthEnvDoc(mode?: InboundAuthMode): string {
  if (!isInboundAuthEnabled(mode)) return '';
  return `
# Inbound authentication (--inbound-auth bearer)
# MCP clients must send: Authorization: Bearer <token>
# Generate a token with: openssl rand -hex 32
# To rotate without downtime, set MCP_AUTH_TOKENS=new-token,old-token instead.
MCP_AUTH_TOKEN=
`;
}
