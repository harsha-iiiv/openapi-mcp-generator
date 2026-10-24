/**
 * The browser playground (playground/) shipped with generated HTTP servers.
 *
 * The playground's protocol client (playground/mcp-client.js) is the same file
 * the browser loads, so these tests drive it directly against real generated
 * servers: Node streamable-http and web (SSE) processes, and the Worker module
 * in-process. They also check how each target serves the page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpenAPIV3 } from 'openapi-types';

import { McpClient, McpHttpError, SseParser, MAX_SSE_BUFFER } from '../playground/mcp-client.js';
import { extractToolsFromApi } from '../src/parser/extract-tools.js';
import { generateCloudflareWorkerFiles } from '../src/generator/cloudflare-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const playgroundDir = path.join(repoRoot, 'playground');
const token = 'playground-test-token';

// --- helpers ---------------------------------------------------------------------

interface Upstream {
  url: string;
  close(): Promise<void>;
}

/** Upstream API that echoes what it received. */
function startUpstream(): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: body ? JSON.parse(body) : null,
        })
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    })
  );
}

function petsSpec(upstream: string): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: upstream }],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['pets'],
          summary: 'List pets',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['available', 'sold'] },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
        post: {
          operationId: 'createPet',
          tags: ['pets'],
          summary: 'Create a pet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' }, age: { type: 'integer' } },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          tags: ['pets'],
          summary: 'Get a pet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function generate(specPath: string, outDir: string, args: string[]): void {
  execFileSync('node', [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('node', [tscEntry, '-p', path.join(outDir, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function startServer(outDir: string, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn('node', [path.join(outDir, 'build', 'index.js')], {
    cwd: outDir,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${env.PORT}/health`)).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

const firstText = (result: any): string => String(result?.content?.[0]?.text ?? '');

// --- shared state -------------------------------------------------------------------

let upstream: Upstream;
let workdir: string;
let specPath: string;
let api: OpenAPIV3.Document;
const children: ChildProcess[] = [];

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-playground-'));
  api = petsSpec(upstream.url);
  specPath = path.join(workdir, 'pets.json');
  fs.writeFileSync(specPath, JSON.stringify(api, null, 2));
});

afterAll(async () => {
  for (const child of children) await stopServer(child);
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

// --- tests ---------------------------------------------------------------------------

describe('SseParser', () => {
  it('parses events split across chunks, multi-line data, comments and CRLF', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\r\nevent: endpoint\r\ndata: /api/mess')).toEqual([]);
    const events = parser.push('ages?sessionId=1\r\n\r\ndata: {"a":\ndata: 1}\n\n');
    expect(events).toEqual([
      { event: 'endpoint', data: '/api/messages?sessionId=1', id: undefined },
      { event: 'message', data: '{"a":\n1}', id: undefined },
    ]);
  });
});

describe('playground client: hostile or broken responses', () => {
  it('rejects an unterminated SSE event larger than 1 MiB', () => {
    const parser = new SseParser();
    expect(() => parser.push('data: ' + 'x'.repeat(MAX_SSE_BUFFER + 1))).toThrow(
      /larger than 1 MiB/
    );
    // The parser recovers for the next event.
    expect(parser.push('data: ok\n\n')).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('rejects a complete SSE event larger than 1 MiB before parsing it', () => {
    const parser = new SseParser();
    expect(() => parser.push('data: ' + 'x'.repeat(MAX_SSE_BUFFER + 1) + '\n\n')).toThrow(
      /larger than 1 MiB/
    );
    expect(parser.push('data: ok\n\n')).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('explains a successful response that is not JSON', async () => {
    const client = new McpClient({
      url: 'http://127.0.0.1:1/mcp',
      fetch: async () =>
        new Response('<html>not mcp</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await expect(client.connect()).rejects.toThrow(/something other than JSON/);
  });

  it('reports a body that stalls past the timeout as a timeout, not a raw AbortError', async () => {
    const client = new McpClient({
      url: 'http://127.0.0.1:1/mcp',
      timeoutMs: 200,
      fetch: async (_input: unknown, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError'))
            );
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(client.connect()).rejects.toThrow(/No response within/);
  });
});

describe('playground: streamable-http (Node)', () => {
  let outDir: string;
  let port: number;
  let base: string;

  beforeAll(async () => {
    outDir = path.join(workdir, 'node-http');
    generate(specPath, outDir, ['--transport', 'streamable-http', '--inbound-auth', 'bearer']);
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    children.push(await startServer(outDir, { PORT: String(port), MCP_AUTH_TOKEN: token }));
  }, 120_000);

  it('copies the playground files and writes a config for this endpoint', () => {
    for (const file of ['index.html', 'playground.css', 'playground.js', 'mcp-client.js']) {
      expect(fs.readFileSync(path.join(outDir, 'public', file), 'utf8')).toBe(
        fs.readFileSync(path.join(playgroundDir, file), 'utf8')
      );
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(outDir, 'public', 'playground.config.json'), 'utf8')
    );
    expect(config).toMatchObject({
      transport: 'streamable-http',
      endpoint: '/mcp',
      inboundAuth: 'bearer',
    });
    expect(fs.readFileSync(path.join(outDir, '.env.example'), 'utf8')).toMatch(
      /^MCP_PLAYGROUND=$/m
    );
  });

  it('serves the playground with strict headers, and nothing else from disk', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('playground.js');
    const script = await fetch(`${base}/mcp-client.js`);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const config = await (await fetch(`${base}/playground.config.json`)).json();
    expect(config.endpoint).toBe('/mcp');
    for (const probe of [
      '/package.json',
      '/src/index.ts',
      '/build/index.js',
      '/public/index.html',
      '/..%2fpackage.json',
      '/.env',
    ]) {
      expect((await fetch(`${base}${probe}`)).status, probe).toBe(404);
    }
  });

  it('connects, lists and calls tools with the bearer token', async () => {
    const traffic: any[] = [];
    const client = new McpClient({
      url: `${base}/mcp`,
      token,
      onTraffic: (e: any) => traffic.push(e),
    });
    const init = await client.connect();
    expect(init.serverInfo.name).toBeTruthy();
    expect(client.sessionId).toBeTruthy();
    const tools = await client.listTools();
    expect(tools.map((t: any) => t.name).sort()).toEqual(['createPet', 'getPet', 'listPets']);
    const pet = await client.callTool('getPet', { petId: 7 });
    expect(pet.isError).toBeFalsy();
    expect(firstText(pet)).toContain('/pets/7');
    const created = await client.callTool('createPet', { requestBody: { name: 'Nori', age: 2 } });
    expect(firstText(created)).toContain('"name": "Nori"');
    expect(traffic.some((e) => e.direction === 'out' && e.message?.method === 'tools/call')).toBe(
      true
    );
    expect(traffic.some((e) => e.direction === 'in' && e.message?.result)).toBe(true);
    await client.close();
  });

  it('explains a missing or wrong token', async () => {
    const missing = new McpClient({ url: `${base}/mcp` });
    const error = await missing.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpHttpError);
    expect((error as McpHttpError).status).toBe(401);
    expect((error as McpHttpError).hint).toContain('MCP_AUTH_TOKEN');
    const wrong = await new McpClient({ url: `${base}/mcp`, token: 'nope' })
      .connect()
      .catch((e: unknown) => e);
    expect((wrong as McpHttpError).hint).toContain('rejected');
  });

  it('explains a browser origin the server does not allow', async () => {
    const client = new McpClient({
      url: `${base}/mcp`,
      token,
      headers: { origin: 'https://evil.example' },
    });
    const error = (await client.connect().catch((e: unknown) => e)) as McpHttpError;
    expect(error.status).toBe(403);
    expect(error.hint).toContain('MCP_ALLOWED_ORIGINS');
  });

  it('builds a curl command that reproduces a call without leaking the token', async () => {
    const client = new McpClient({ url: `${base}/mcp`, token });
    await client.connect();
    const command = client.curl('tools/call', { name: 'getPet', arguments: { petId: 1 } });
    expect(command).toContain(`${base}/mcp`);
    expect(command).toContain(`mcp-session-id: ${client.sessionId}`);
    expect(command).toContain('$MCP_AUTH_TOKEN');
    expect(command).not.toContain(token);
    await client.close();
  });

  it('starts a new session when the old one is gone', async () => {
    const client = new McpClient({ url: `${base}/mcp`, token });
    await client.connect();
    const first = client.sessionId;
    await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': first! },
    });
    const result = await client.callTool('getPet', { petId: 3 });
    expect(firstText(result)).toContain('/pets/3');
    expect(client.sessionId).not.toBe(first);
    await client.close();
  });

  it('MCP_PLAYGROUND=off stops serving the page but not MCP', async () => {
    const offPort = await freePort();
    children.push(
      await startServer(outDir, {
        PORT: String(offPort),
        MCP_AUTH_TOKEN: token,
        MCP_PLAYGROUND: 'off',
      })
    );
    expect((await fetch(`http://127.0.0.1:${offPort}/`)).status).toBe(404);
    const client = new McpClient({ url: `http://127.0.0.1:${offPort}/mcp`, token });
    await client.connect();
    expect((await client.listTools()).length).toBe(3);
    await client.close();
  });
});

describe('playground: web (SSE, Node)', () => {
  let base: string;

  beforeAll(async () => {
    const outDir = path.join(workdir, 'node-web');
    generate(specPath, outDir, ['--transport', 'web']);
    const config = JSON.parse(
      fs.readFileSync(path.join(outDir, 'public', 'playground.config.json'), 'utf8')
    );
    expect(config).toMatchObject({ transport: 'sse', endpoint: '/sse', inboundAuth: 'none' });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    children.push(await startServer(outDir, { PORT: String(port) }));
  }, 120_000);

  it('serves the page and works over HTTP+SSE', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    const client = new McpClient({ url: `${base}/sse`, transport: 'sse' });
    await client.connect();
    expect(client.serverInfo?.name).toBeTruthy();
    const tools = await client.listTools();
    expect(tools).toHaveLength(3);
    const result = await client.callTool('listPets', { status: 'sold' });
    expect(firstText(result)).toContain('"status": "sold"');
    await client.close();
  });
});

describe('playground and CORS: cloudflare-worker', () => {
  let worker: {
    fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
  };
  const env = { MCP_AUTH_TOKEN: token };

  beforeAll(async () => {
    const outDir = path.join(workdir, 'worker');
    const files = generateCloudflareWorkerFiles({
      tools: extractToolsFromApi(api),
      serverName: 'pets',
      serverVersion: '1.0.0',
      baseUrl: upstream.url,
      inboundAuth: 'bearer',
      headerPassthrough: ['X-API-Key'],
    });
    for (const file of files) {
      const dest = path.join(outDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content);
    }
    worker = (await import(pathToFileURL(path.join(outDir, 'src', 'index.ts')).href)).default;
  });

  it('serves the playground at / with security headers, unless MCP_PLAYGROUND is off', async () => {
    const page = await worker.fetch(new Request('https://worker.test/'), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toBe(fs.readFileSync(path.join(playgroundDir, 'index.html'), 'utf8'));
    const config = await (
      await worker.fetch(new Request('https://worker.test/playground.config.json'), env)
    ).json();
    expect(config).toMatchObject({ endpoint: '/mcp', inboundAuth: 'bearer' });
    const off = await worker.fetch(new Request('https://worker.test/'), {
      ...env,
      MCP_PLAYGROUND: 'off',
    });
    expect(off.status).toBe(404);
  });

  it('answers CORS preflight and adds CORS headers to MCP responses, including errors', async () => {
    const preflight = await worker.fetch(
      new Request('https://worker.test/mcp', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://mcp.pidata.tech',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type, x-api-key',
        },
      }),
      env
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const allowed = preflight.headers.get('access-control-allow-headers') ?? '';
    for (const name of [
      'authorization',
      'content-type',
      'mcp-session-id',
      'mcp-protocol-version',
      'x-api-key',
    ]) {
      expect(allowed).toContain(name);
    }
    const denied = await worker.fetch(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://mcp.pidata.tech' },
        body: '{}',
      }),
      env
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
    expect(denied.headers.get('access-control-expose-headers')).toContain('www-authenticate');
  });

  it('works with the playground client', async () => {
    const client = new McpClient({
      url: 'https://worker.test/mcp',
      token,
      fetch: (input: string, init: RequestInit) => worker.fetch(new Request(input, init), env),
    });
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((t: any) => t.name).sort()).toEqual(['createPet', 'getPet', 'listPets']);
    const result = await client.callTool('getPet', { petId: 42 });
    expect(firstText(result)).toContain('/pets/42');
    await client.close();
  });
});
