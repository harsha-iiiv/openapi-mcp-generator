/**
 * Runtime behavior of generated servers, exercised end to end with the official
 * MCP clients of both protocol eras (SDK v1 for 2025-era, SDK v2 pinned to
 * 2026-07-28) against a stdio Node server and an in-process Cloudflare Worker.
 * A local mock upstream API records every request it receives.
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHttpTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdioTransport } from '@modelcontextprotocol/client/stdio';
import type { OpenAPIV3 } from 'openapi-types';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

// --- mock upstream ------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface Upstream {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Echoes every request as JSON (or as an array/text for a few special paths). */
function startUpstream(): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const record = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      };
      requests.push(record);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: record.method, path: record.path, query: record.query, body }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    })
  );
}

/** A small API that exercises validation, schema fidelity and response handling. */
function featureSpec(upstream: string): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Feature Matrix', version: '1.0.0' },
    servers: [{ url: upstream }],
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          summary: 'Get a pet',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['available', 'pending', 'sold'] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/pets': {
        post: {
          operationId: 'createPet',
          summary: 'Create a pet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    age: { type: 'integer', minimum: 0 },
                    owner: {
                      type: 'object',
                      properties: { email: { type: 'string', format: 'email' } },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  } as OpenAPIV3.Document;
}

// --- harness ------------------------------------------------------------------

interface CallResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
}

interface AnyClient {
  label: string;
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
  listTools(): Promise<{ tools: any[] }>;
  close(): Promise<void>;
}

function wrap(label: string, client: Client | ModernClient): AnyClient {
  return {
    label,
    callTool: (name, args) => client.callTool({ name, arguments: args }) as Promise<CallResult>,
    listTools: () => client.listTools() as Promise<{ tools: any[] }>,
    close: () => client.close(),
  };
}

function writeSpec(dir: string, spec: OpenAPIV3.Document): string {
  const specPath = path.join(dir, `${spec.info.title.replace(/\W+/g, '-')}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  return specPath;
}

function generate(specPath: string, outDir: string, args: string[] = []): void {
  execFileSync('node', [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/** Generates and starts every target for a spec, connecting a client of each era to each. */
async function connectAll(
  workdir: string,
  name: string,
  spec: OpenAPIV3.Document,
  options: { args?: string[]; env?: Record<string, string> } = {}
): Promise<AnyClient[]> {
  const specPath = writeSpec(workdir, spec);
  const env = options.env ?? {};

  const nodeDir = path.join(workdir, `${name}-node`);
  generate(specPath, nodeDir, options.args);
  execFileSync('node', [tscEntry, '-p', path.join(nodeDir, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const stdioParams = {
    command: 'node',
    args: [path.join(nodeDir, 'build', 'index.js')],
    cwd: nodeDir,
    stderr: 'pipe' as const,
    env: { ...getDefaultEnvironment(), ...env },
  };
  const nodeLegacy = new Client({ name: 'runtime-test', version: '1.0.0' });
  await nodeLegacy.connect(new StdioClientTransport(stdioParams));
  const nodeModern = new ModernClient(
    { name: 'runtime-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await nodeModern.connect(new ModernStdioTransport(stdioParams));

  const workerDir = path.join(workdir, `${name}-worker`);
  generate(specPath, workerDir, ['--transport', 'cloudflare-worker', ...(options.args ?? [])]);
  const worker = (await import(pathToFileURL(path.join(workerDir, 'src', 'index.ts')).href))
    .default as { fetch(request: Request, env: Record<string, string>): Promise<Response> };
  const workerFetch = (url: string | URL, init?: RequestInit) =>
    worker.fetch(new Request(url, init), env);
  const workerLegacy = new Client({ name: 'runtime-test', version: '1.0.0' });
  await workerLegacy.connect(
    new StreamableHTTPClientTransport(new URL('https://worker.test/mcp'), { fetch: workerFetch })
  );
  const workerModern = new ModernClient(
    { name: 'runtime-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await workerModern.connect(
    new ModernHttpTransport(new URL('https://worker.test/mcp'), { fetch: workerFetch })
  );
  expect(nodeModern.getProtocolEra()).toBe('modern');
  expect(workerModern.getProtocolEra()).toBe('modern');

  return [
    wrap('node/2025', nodeLegacy),
    wrap('node/2026-07-28', nodeModern),
    wrap('worker/2025', workerLegacy),
    wrap('worker/2026-07-28', workerModern),
  ];
}

const textOf = (result: CallResult) => result.content.map((c) => c.text ?? '').join('\n');

// --- shared state ---------------------------------------------------------------

let upstream: Upstream;
let workdir: string;

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-runtime-'));
});

afterAll(async () => {
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

// --- argument validation ----------------------------------------------------------

describe('argument validation with JSON Schema (no eval)', () => {
  let clients: AnyClient[] = [];

  beforeAll(async () => {
    clients = await connectAll(workdir, 'validation', featureSpec(upstream.url));
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) await client.close();
  });

  it('passes valid arguments through unchanged and injects no defaults', async () => {
    for (const client of clients) {
      const before = upstream.requests.length;
      const result = await client.callTool('getPet', { petId: 7, status: 'sold' });
      expect(result.isError ?? false, client.label).toBe(false);
      const seen = upstream.requests.slice(before);
      expect(seen.length, client.label).toBe(1);
      expect(seen[0].path).toBe('/pets/7');
      // The schema default (limit: 20) is documentation, not a value to send.
      expect(seen[0].query, client.label).toEqual({ status: 'sold' });
    }
  });

  it('rejects invalid arguments as a readable tool error without calling the API', async () => {
    for (const client of clients) {
      const before = upstream.requests.length;
      const result = await client.callTool('getPet', { petId: 'seven', status: 'lost' });
      expect(result.isError, client.label).toBe(true);
      const text = textOf(result);
      expect(text, client.label).toMatch(/^Invalid arguments for tool 'getPet': /);
      expect(text, client.label).toContain('/petId: Instance type "string" is invalid.');
      expect(text, client.label).toContain('/status: Instance does not match any of');
      // All errors are reported, joined with "; ", without redundant summaries.
      expect(text.split('; ').length, client.label).toBe(2);
      expect(upstream.requests.length, client.label).toBe(before);
    }
  });

  it('reports missing required arguments and nested request-body errors by location', async () => {
    for (const client of clients) {
      const missing = await client.callTool('getPet', {});
      expect(missing.isError, client.label).toBe(true);
      expect(textOf(missing), client.label).toContain(
        '(root): Instance does not have required property "petId".'
      );

      const nested = await client.callTool('createPet', {
        requestBody: { name: 'Rex', owner: { email: 'not-an-email' } },
      });
      expect(nested.isError, client.label).toBe(true);
      expect(textOf(nested), client.label).toContain(
        '/requestBody/owner/email: String does not match format "email".'
      );

      const ok = await client.callTool('createPet', {
        requestBody: { name: 'Rex', owner: { email: 'rex@example.com' } },
      });
      expect(ok.isError ?? false, client.label).toBe(false);
      expect(upstream.requests.at(-1)?.body, client.label).toEqual({
        name: 'Rex',
        owner: { email: 'rex@example.com' },
      });
    }
  });
});
