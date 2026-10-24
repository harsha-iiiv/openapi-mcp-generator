/**
 * Browser playground shipped inside generated HTTP servers.
 *
 * The playground lives in the repository's top-level `playground/` directory as
 * plain files (index.html, playground.css, playground.js, mcp-client.js). The
 * same files are hosted at https://mcp.pidata.tech/playground for deployed
 * servers; generated servers serve them same-origin at `/`, so local testing
 * needs no CORS or MCP_ALLOWED_ORIGINS changes.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InboundAuthMode } from '../types/index.js';

/** Files copied into generated projects, in serving order. */
export const PLAYGROUND_FILES = [
  { file: 'index.html', type: 'text/html; charset=utf-8' },
  { file: 'playground.css', type: 'text/css; charset=utf-8' },
  { file: 'playground.js', type: 'text/javascript; charset=utf-8' },
  { file: 'mcp-client.js', type: 'text/javascript; charset=utf-8' },
] as const;

/** Security headers for every playground response. The page talks only to its own origin. */
export const PLAYGROUND_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache',
};

export interface PlaygroundConfig {
  transport: 'streamable-http' | 'sse';
  endpoint: string;
  inboundAuth: InboundAuthMode;
}

function playgroundDir(): URL {
  // src/generator/playground.ts and dist/generator/playground.js both sit two
  // levels below the package root, where `playground/` lives.
  return new URL('../../playground/', import.meta.url);
}

/** Reads the playground files from the package. */
export function readPlaygroundAssets(): { file: string; type: string; content: string }[] {
  const dir = playgroundDir();
  return PLAYGROUND_FILES.map(({ file, type }) => ({
    file,
    type,
    content: fs.readFileSync(fileURLToPath(new URL(file, dir)), 'utf8'),
  }));
}

/** The JSON the page reads at startup to know where and how to connect. */
export function generatePlaygroundConfig(config: PlaygroundConfig): string {
  return JSON.stringify({ ...config, generatedBy: 'openapi-mcp-generator' }, null, 2) + '\n';
}

/**
 * Hono routes for Node HTTP transports: serve the playground from ./public with
 * strict security headers. MCP_PLAYGROUND=off turns the page off.
 */
export function generateNodePlaygroundRoutes(): string {
  const files = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ...PLAYGROUND_FILES.filter((f) => f.file !== 'index.html').map((f) => [
      '/' + f.file,
      f.file,
      f.type,
    ]),
    ['/playground.config.json', 'playground.config.json', 'application/json; charset=utf-8'],
  ];
  return `
// --- Browser playground --------------------------------------------------------
// Open http://localhost:<port>/ to list and call tools from a browser. The same
// page is hosted at https://mcp.pidata.tech/playground for deployed servers.
// Set MCP_PLAYGROUND=off to stop serving it.
const PLAYGROUND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PLAYGROUND_ROUTES: Record<string, [string, string]> = ${JSON.stringify(
    Object.fromEntries(files.map(([route, file, type]) => [route, [file, type]])),
    null,
    2
  )};
const PLAYGROUND_HEADERS: Record<string, string> = ${JSON.stringify(PLAYGROUND_SECURITY_HEADERS, null, 2)};
`;
}

/** Route registrations, placed after the MCP routes. */
export function generateNodePlaygroundMount(appVar = 'app'): string {
  return `
  // Browser playground (static files from ./public). MCP_PLAYGROUND=off disables it.
  for (const [route, [file, type]] of Object.entries(PLAYGROUND_ROUTES)) {
    ${appVar}.get(route, async (c) => {
      if ((process.env.MCP_PLAYGROUND ?? '').toLowerCase() === 'off') return c.notFound();
      try {
        const body = await readFile(path.join(PLAYGROUND_DIR, file), 'utf8');
        return new Response(body, { headers: { 'Content-Type': type, ...PLAYGROUND_HEADERS } });
      } catch {
        return c.notFound();
      }
    });
  }
`;
}

/** Imports the Node playground routes need. */
export function generateNodePlaygroundImports(): string {
  return `
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';`;
}

/** src/playground.ts for the Worker target: the same files, embedded as strings. */
export function generateWorkerPlaygroundModule(config: PlaygroundConfig): string {
  const assets = readPlaygroundAssets();
  const entries: Record<string, { type: string; body: string }> = {};
  const index = assets.find((a) => a.file === 'index.html')!;
  entries['/'] = { type: index.type, body: index.content };
  for (const asset of assets) entries['/' + asset.file] = { type: asset.type, body: asset.content };
  entries['/playground.config.json'] = {
    type: 'application/json; charset=utf-8',
    body: generatePlaygroundConfig(config),
  };
  return `/**
 * Browser playground served by this Worker at /. Generated by openapi-mcp-generator
 * from its open-source playground; the same page is hosted at
 * https://mcp.pidata.tech/playground. Set the MCP_PLAYGROUND var to "off" to disable.
 */
export const PLAYGROUND_FILES: Record<string, { type: string; body: string }> = ${JSON.stringify(entries, null, 2)};

export const PLAYGROUND_HEADERS: Record<string, string> = ${JSON.stringify(PLAYGROUND_SECURITY_HEADERS, null, 2)};
`;
}
