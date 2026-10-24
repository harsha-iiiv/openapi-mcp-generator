/**
 * Runs the relay on Node for local testing, without wrangler:
 *
 *   node relay/dev-server.mjs            # http://127.0.0.1:8787
 *   PORT=9000 ALLOWED_ORIGINS="http://localhost:5173" node relay/dev-server.mjs
 *
 * Needs Node 22.18 or later (it imports the TypeScript source directly). The
 * Workers Rate Limiting binding does not exist here, so nothing is rate limited.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { createRelay } from './src/index.ts';

/** Serves a relay on 127.0.0.1. Resolves with { url, close() }. */
export function startRelayServer({ port = 0, env = {}, fetch, log } = {}) {
  const relay = createRelay({ fetch, log });
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
        signal: controller.signal,
      });
      const response = await relay.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) {
        for await (const chunk of response.body) {
          if (controller.signal.aborted) break;
          res.write(chunk);
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT || 8787);
  const env = process.env.ALLOWED_ORIGINS ? { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS } : {};
  const { url } = await startRelayServer({ port, env });
  console.log(`MCP relay listening on ${url}`);
}
