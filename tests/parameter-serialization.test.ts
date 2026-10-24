/**
 * Query and cookie parameter serialization (OpenAPI style/explode) in generated
 * servers. A stdio Node server and an in-process Cloudflare Worker call a local
 * upstream that records the raw query string and Cookie header of every request.
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
import type { OpenAPIV3 } from 'openapi-types';
import { extractToolsFromApi } from '../src/parser/extract-tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

interface Seen {
  path: string;
  rawQuery: string;
  cookie?: string;
}

interface Upstream {
  url: string;
  requests: Seen[];
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      requests.push({
        path: q === -1 ? raw : raw.slice(0, q),
        rawQuery: q === -1 ? '' : raw.slice(q + 1),
        cookie: req.headers.cookie,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
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

const stringArray = { type: 'array', items: { type: 'string' } } as const;

function serializationSpec(upstream: string): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Serialization', version: '1.0.0' },
    servers: [{ url: upstream }],
    components: {
      securitySchemes: {
        cookieauth: { type: 'apiKey', in: 'cookie', name: 'api_token' },
      },
    },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            // No style/explode: OpenAPI defaults to form + explode true.
            { name: 'tag', in: 'query', schema: stringArray },
            { name: 'ids', in: 'query', explode: false, schema: stringArray },
            {
              name: 'pipes',
              in: 'query',
              style: 'pipeDelimited',
              explode: false,
              schema: stringArray,
            },
            {
              name: 'spaces',
              in: 'query',
              style: 'spaceDelimited',
              explode: false,
              schema: stringArray,
            },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            {
              name: 'filter',
              in: 'query',
              style: 'deepObject',
              explode: true,
              schema: { type: 'object', properties: { color: { type: 'string' } } },
            },
            { name: 'session_id', in: 'cookie', schema: { type: 'string' } },
            { name: 'prefs', in: 'cookie', explode: false, schema: stringArray },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/secure': {
        get: {
          operationId: 'secureItems',
          security: [{ cookieauth: [] }],
          parameters: [{ name: 'session_id', in: 'cookie', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  } as OpenAPIV3.Document;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

let upstream: Upstream;
let workdir: string;
let nodeClient: Client;
const targets: { label: string; call: CallTool }[] = [];

function generate(specPath: string, outDir: string, args: string[] = []): void {
  execFileSync('node', [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-serialization-'));
  const specPath = path.join(workdir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(serializationSpec(upstream.url), null, 2));

  const nodeDir = path.join(workdir, 'node');
  generate(specPath, nodeDir);
  execFileSync('node', [tscEntry, '-p', path.join(nodeDir, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  nodeClient = new Client({ name: 'serialization-test', version: '1.0.0' });
  await nodeClient.connect(
    new StdioClientTransport({
      command: 'node',
      args: [path.join(nodeDir, 'build', 'index.js')],
      cwd: nodeDir,
      stderr: 'pipe',
      env: { ...getDefaultEnvironment(), API_KEY_COOKIEAUTH: 'key-123' },
    })
  );
  targets.push({
    label: 'node',
    call: (name, args) => nodeClient.callTool({ name, arguments: args }) as Promise<ToolResult>,
  });

  const workerDir = path.join(workdir, 'worker');
  generate(specPath, workerDir, ['--transport', 'cloudflare-worker']);
  const worker = (await import(pathToFileURL(path.join(workerDir, 'src', 'index.ts')).href))
    .default as { fetch(request: Request, env: Record<string, string>): Promise<Response> };
  targets.push({
    label: 'worker',
    call: async (name, args) => {
      const res = await worker.fetch(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }),
        { COOKIEAUTH_API_KEY: 'key-123' }
      );
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : text).result as ToolResult;
    },
  });
}, 120_000);

afterAll(async () => {
  await nodeClient?.close();
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

async function lastRequest(
  call: CallTool,
  label: string,
  name: string,
  args: Record<string, unknown>
): Promise<Seen> {
  const before = upstream.requests.length;
  const result = await call(name, args);
  expect(result.isError ?? false, `${label}: ${JSON.stringify(result.content)}`).toBe(false);
  expect(upstream.requests.length, label).toBe(before + 1);
  return upstream.requests[before];
}

describe('execution metadata', () => {
  it('records style and explode only when they differ from the OpenAPI defaults', () => {
    const tool = extractToolsFromApi(serializationSpec('https://api.test')).find(
      (t) => t.name === 'listItems'
    );
    expect(tool?.executionParameters).toEqual([
      { name: 'tag', in: 'query' },
      { name: 'ids', in: 'query', explode: false },
      { name: 'pipes', in: 'query', style: 'pipeDelimited' },
      { name: 'spaces', in: 'query', style: 'spaceDelimited' },
      { name: 'q', in: 'query' },
      { name: 'filter', in: 'query', style: 'deepObject', explode: true },
      { name: 'session_id', in: 'cookie' },
      { name: 'prefs', in: 'cookie', explode: false },
    ]);
  });

  it('leaves path and header parameters without serialization hints', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a/{id}': {
          get: {
            operationId: 'a',
            parameters: [
              { name: 'id', in: 'path', required: true, explode: true, schema: stringArray },
              { name: 'x-trace', in: 'header', schema: { type: 'string' } },
              { name: 'csv', in: 'query', style: 'form', explode: true, schema: stringArray },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    expect(extractToolsFromApi(spec)[0].executionParameters).toEqual([
      { name: 'id', in: 'path' },
      { name: 'x-trace', in: 'header' },
      { name: 'csv', in: 'query' },
    ]);
  });
});

describe('query parameter serialization', () => {
  it('repeats the key for arrays by default (form, explode true)', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'listItems', { tag: ['red', 'blue'] });
      expect(seen.rawQuery, label).toBe('tag=red&tag=blue');
    }
  });

  it('joins arrays with commas for explode: false', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'listItems', { ids: ['1', '2'] });
      expect(seen.rawQuery, label).toBe('ids=1%2C2');
      expect(new URLSearchParams(seen.rawQuery).getAll('ids'), label).toEqual(['1,2']);
    }
  });

  it('joins pipeDelimited and spaceDelimited arrays with | and a space', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'listItems', {
        pipes: ['a', 'b'],
        spaces: ['c', 'd'],
      });
      const params = new URLSearchParams(seen.rawQuery);
      expect(params.getAll('pipes'), label).toEqual(['a|b']);
      expect(params.getAll('spaces'), label).toEqual(['c d']);
    }
  });

  it('sends scalars unchanged and deepObject objects as name[key]', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'listItems', {
        q: 'hello world',
        filter: { color: 'red' },
      });
      expect(seen.rawQuery, label).toBe('q=hello+world&filter%5Bcolor%5D=red');
    }
  });
});

describe('cookie parameters', () => {
  it('sends cookie parameters in the Cookie header, percent-encoded', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'listItems', {
        session_id: 'sess 123',
        prefs: ['a', 'b'],
      });
      expect(seen.rawQuery, label).toBe('');
      expect(seen.cookie, label).toBe('session_id=sess%20123; prefs=a%2Cb');
    }
  });

  it('keeps both a cookie parameter and an apiKey cookie credential', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'secureItems', { session_id: 'sess-123' });
      const pairs = (seen.cookie ?? '').split('; ').sort();
      expect(pairs, label).toEqual(['api_token=key-123', 'session_id=sess-123']);
    }
  });

  it('sends only the credential cookie when no cookie parameter is given', async () => {
    for (const { label, call } of targets) {
      const seen = await lastRequest(call, label, 'secureItems', {});
      expect(seen.cookie, label).toBe('api_token=key-123');
    }
  });
});

describe('every Node transport', () => {
  it('serializes query and cookie parameters the same way', () => {
    const specPath = path.join(workdir, 'spec.json');
    for (const transport of ['web', 'streamable-http']) {
      const dir = path.join(workdir, `node-${transport}`);
      generate(specPath, dir, ['--transport', transport]);
      const index = fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8');
      expect(index, transport).toContain('function serializeParameter(');
      expect(index, transport).toContain("param.in === 'cookie'");
      expect(index, transport).not.toContain("value.join(',')");
    }
  });
});
