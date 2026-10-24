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
  if (!isInboundAuthEnabled(mode)) return `\nimport type { MiddlewareHandler } from 'hono';`;
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
 * Origin validation for generated Node HTTP servers (always on).
 *
 * The MCP Streamable HTTP binding requires servers to validate the Origin header
 * to prevent DNS rebinding: a web page that rebinds its hostname to 127.0.0.1
 * could otherwise drive a local server, and the upstream credentials it holds,
 * from the user's browser. Requests without Origin (non-browser MCP clients)
 * pass; browser requests must come from a loopback origin or one listed in
 * MCP_ALLOWED_ORIGINS.
 */
export function generateNodeOriginGuard(): string {
  return `
/**
 * DNS-rebinding protection: rejects browser requests from origins that are not
 * loopback and not listed in MCP_ALLOWED_ORIGINS (comma-separated, exact origins
 * such as https://app.example.com). Requests without an Origin header pass.
 */
function createOriginGuard(): MiddlewareHandler {
  const allowed = new Set(
    (process.env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\\/+$/, ''))
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
      if (!loopbackHosts.has(host) && !allowed.has(origin.replace(/\\/+$/, ''))) {
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
`;
}

/**
 * `app.use(...)` lines guarding the MCP routes: the Origin check always, and the
 * bearer-token check when inbound auth is enabled. Must be emitted after CORS
 * (so preflight requests are answered) and before the route handlers.
 */
export function generateNodeInboundAuthMounts(
  mode: InboundAuthMode | undefined,
  routes: string[]
): string {
  const originMounts = routes.map((route) => `  app.use('${route}', originGuard);`).join('\n');
  const authBlock = isInboundAuthEnabled(mode)
    ? `
  // Inbound authentication (--inbound-auth bearer); /health stays public.
  const requireInboundAuth = createInboundAuthMiddleware();
${routes.map((route) => `  app.use('${route}', requireInboundAuth);`).join('\n')}
`
    : '';
  return `
  // DNS-rebinding protection: browser requests need a loopback or allowed origin.
  const originGuard = createOriginGuard();
${originMounts}
${authBlock}`;
}

/** .env.example block for browser origins allowed by the Origin check (Node HTTP transports). */
export function generateAllowedOriginsEnvDoc(): string {
  return `
# Browser origins allowed to call the MCP endpoint, comma-separated (for example
# https://app.example.com). Loopback origins are always allowed, and clients that
# send no Origin header (most MCP clients) are unaffected.
MCP_ALLOWED_ORIGINS=
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
