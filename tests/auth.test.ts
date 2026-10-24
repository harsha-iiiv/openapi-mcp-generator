/**
 * Behavioral tests for upstream security semantics (#81), inbound
 * authentication (#80) and Worker header passthrough (#55).
 *
 * These generate real projects from a security-matrix spec, then exercise them:
 * the Worker modules are imported directly and driven with fetch-style requests;
 * Node servers are compiled with the repo's TypeScript and run as processes
 * against a local mock upstream API that records what it receives.
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { extractToolsFromApi } from '../src/parser/extract-tools.js';
import { generateCloudflareWorkerFiles } from '../src/generator/cloudflare-worker.js';
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
}

interface Upstream {
  url: string;
  requests: RecordedRequest[];
  tokenRequests: { scope: string | null; authorization?: string }[];
  close(): Promise<void>;
}

/** Local upstream API + OAuth token endpoint that records every request. */
function startUpstream(): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const tokenRequests: { scope: string | null; authorization?: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/oauth/token') {
        const scope = new URLSearchParams(body).get('scope');
        tokenRequests.push({ scope, authorization: req.headers.authorization });
        if (scope?.includes('admin')) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('token server refused');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `tok-${(scope ?? 'none').replace(/\s+/g, '+')}`,
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
        return;
      }
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: url.pathname }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        tokenRequests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    })
  );
}

/** Security-matrix spec: every operation exercises one requirement shape. */
function securitySpec(upstream: string): OpenAPIV3.Document {
  const op = (operationId: string, security?: OpenAPIV3.SecurityRequirementObject[]) => ({
    get: {
      operationId,
      summary: operationId,
      ...(security !== undefined ? { security } : {}),
      responses: { '200': { description: 'ok' } },
    },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Security Matrix', version: '1.0.0' },
    servers: [{ url: upstream }],
    components: {
      securitySchemes: {
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        apiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
        basicAuth: { type: 'http', scheme: 'basic' },
        oidc: {
          type: 'openIdConnect',
          openIdConnectUrl: `${upstream}/.well-known/openid-configuration`,
        },
        oauth: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: `${upstream}/oauth/token`,
              scopes: { read: 'read', write: 'write', admin: 'admin' },
            },
          },
        },
      },
    },
    paths: {
      '/and': op('andRequirement', [{ apiKeyHeader: [], oauth: ['read'] }]),
      '/or': op('orAlternatives', [{ bearerAuth: [] }, { apiKeyQuery: [] }]),
      '/incomplete': op('incompleteAnd', [{ apiKeyHeader: [], basicAuth: [] }]),
      '/fallback': op('fallbackAfterIncomplete', [
        { apiKeyHeader: [], basicAuth: [] },
        { apiKeyQuery: [] },
      ]),
      '/optional': op('optionalAuth', [{}, { apiKeyHeader: [] }]),
      '/public': op('publicEndpoint', []),
      '/scoped': op('scopedOauth', [{ oauth: ['read', 'write'] }]),
      '/token-failure': op('tokenFailure', [{ apiKeyHeader: [], oauth: ['admin'] }]),
      '/conflict': op('conflictingSchemes', [
        { bearerAuth: [], oauth: ['read'] },
        { apiKeyQuery: [] },
      ]),
      '/oidc': op('openIdOnly', [{ oidc: [] }]),
    },
  } as OpenAPIV3.Document;
}

/** Credentials the upstream saw for the last request to a path. */
function lastRequest(upstream: Upstream, p: string): RecordedRequest {
  const hits = upstream.requests.filter((r) => r.path === p);
  expect(hits.length, `no upstream request to ${p}`).toBeGreaterThan(0);
  return hits[hits.length - 1];
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

function runCli(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync('node', [cliEntry, ...args], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (e: any) {
    return { status: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
}

function generateWithCli(specPath: string, outDir: string, args: string[]): string {
  const result = execFileSync(
    'node',
    [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return result;
}

/** Compile a generated Node project with the repo's TypeScript (deps resolve from the repo root). */
function buildGenerated(outDir: string): void {
  execFileSync('node', [tscEntry, '-p', path.join(outDir, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

function startNodeServer(outDir: string, env: Record<string, string>): ChildProcess {
  return spawn('node', [path.join(outDir, 'build', 'index.js')], {
    cwd: outDir,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'auth-test', version: '1.0.0' },
  },
};

/** Reads a JSON-RPC message from a JSON or SSE MCP response. */
async function readJsonRpc(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

// --- shared state -------------------------------------------------------------

let upstream: Upstream;
let workdir: string;
let specPath: string;
let api: OpenAPIV3.Document;

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-auth-'));
  api = securitySpec(upstream.url);
  specPath = path.join(workdir, 'security-matrix.json');
  fs.writeFileSync(specPath, JSON.stringify(api, null, 2));
});

afterAll(async () => {
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

/** Writes the Worker project for the matrix spec and returns its directory. */
function writeWorker(
  name: string,
  extra: { inboundAuth?: 'none' | 'bearer'; headerPassthrough?: string[] } = {}
): string {
  const outDir = path.join(workdir, name);
  const files = generateCloudflareWorkerFiles({
    tools: extractToolsFromApi(api),
    serverName: 'security-matrix',
    serverVersion: '1.0.0',
    securitySchemes: api.components?.securitySchemes,
    baseUrl: upstream.url,
    ...extra,
  });
  for (const file of files) {
    const dest = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content);
  }
  return outDir;
}

// --- #81: cloudflare-worker upstream auth -----------------------------------

describe('#81 security requirements: cloudflare-worker runtime', () => {
  let applyAuth: (
    reqs: Record<string, string[]>[] | undefined,
    env: Record<string, string | undefined>,
    headers: Record<string, string>,
    url: URL
  ) => Promise<string[] | null>;
  const tools = () => extractToolsFromApi(api);
  const requirementsFor = (operationId: string) =>
    tools().find((t) => t.operationId === operationId)!.securityRequirements as Record<
      string,
      string[]
    >[];
  const baseEnv = {
    APIKEYHEADER_API_KEY: 'header-key',
    APIKEYQUERY_API_KEY: 'query-key',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
  };

  async function call(operationId: string, env: Record<string, string | undefined> = baseEnv) {
    const headers: Record<string, string> = {};
    const url = new URL(`${upstream.url}/x`);
    const applied = await applyAuth(requirementsFor(operationId), env, headers, url);
    return { applied, headers, query: Object.fromEntries(url.searchParams) };
  }

  beforeAll(async () => {
    const outDir = writeWorker('worker-auth');
    const mod = await import(pathToFileURL(path.join(outDir, 'src', 'upstream-auth.ts')).href);
    applyAuth = mod.applyAuth;
  });

  it('applies every scheme of an AND requirement and forwards its scopes', async () => {
    const before = upstream.tokenRequests.length;
    const { applied, headers } = await call('andRequirement');
    expect(applied).toEqual(['apiKeyHeader', 'oauth']);
    expect(headers['x-api-key']).toBe('header-key');
    expect(headers['authorization']).toBe('Bearer tok-read');
    expect(upstream.tokenRequests.slice(before).map((t) => t.scope)).toEqual(['read']);
  });

  it('never sends a partial AND group', async () => {
    const { applied, headers, query } = await call('incompleteAnd');
    expect(applied).toBeNull();
    expect(headers).toEqual({});
    expect(query).toEqual({});
  });

  it('falls through to the next alternative (OR)', async () => {
    const or = await call('orAlternatives');
    expect(or.applied).toEqual(['apiKeyQuery']);
    expect(or.query).toEqual({ api_key: 'query-key' });
    expect(or.headers['authorization']).toBeUndefined();

    const fallback = await call('fallbackAfterIncomplete');
    expect(fallback.applied).toEqual(['apiKeyQuery']);
    expect(fallback.headers['x-api-key']).toBeUndefined();
  });

  it('prefers a satisfiable alternative over optional {} and sends nothing when only {} fits', async () => {
    expect((await call('optionalAuth')).headers['x-api-key']).toBe('header-key');
    const none = await call('optionalAuth', {});
    expect(none.applied).toBeNull();
    expect(none.headers).toEqual({});
  });

  it('treats a failed token request as an unsatisfied requirement', async () => {
    const { applied, headers } = await call('tokenFailure');
    expect(applied).toBeNull();
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('caches client-credentials tokens per scope set', async () => {
    const before = upstream.tokenRequests.length;
    await call('scopedOauth');
    await call('scopedOauth');
    const scopes = upstream.tokenRequests.slice(before).map((t) => t.scope);
    // 'read write' fetched at most once; the earlier 'read' token is not reused for it.
    expect(scopes.filter((s) => s === 'read write').length).toBeLessThanOrEqual(1);
    expect((await call('scopedOauth')).headers['authorization']).toBe('Bearer tok-read+write');
  });

  it('skips a requirement whose schemes collide on one header', async () => {
    const { applied, headers } = await call('conflictingSchemes', {
      ...baseEnv,
      BEARERAUTH_TOKEN: 'bearer-token',
    });
    expect(applied).toEqual(['apiKeyQuery']);
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends an OpenID Connect token from <SCHEME>_TOKEN', async () => {
    const { headers } = await call('openIdOnly', { OIDC_TOKEN: 'oidc-token' });
    expect(headers['authorization']).toBe('Bearer oidc-token');
    expect((await call('openIdOnly', {})).applied).toBeNull();
  });
});

// --- #80 / #55: cloudflare-worker inbound auth + header passthrough ------------

describe('#80 inbound auth and #55 header passthrough: cloudflare-worker', () => {
  let worker: {
    fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
  };
  let openWorker: typeof worker;

  const mcpRequest = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('https://worker.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const protectedDir = writeWorker('worker-protected', {
      inboundAuth: 'bearer',
      headerPassthrough: ['X-API-Key'],
    });
    worker = (await import(pathToFileURL(path.join(protectedDir, 'src', 'index.ts')).href)).default;
    const openDir = writeWorker('worker-open');
    openWorker = (await import(pathToFileURL(path.join(openDir, 'src', 'index.ts')).href)).default;
  });

  it('rejects requests without a valid bearer token before any MCP processing', async () => {
    const env = { MCP_AUTH_TOKEN: 'correct-token' };
    const missing = await worker.fetch(mcpRequest(initializeBody), env);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect((await missing.json()).error.code).toBe(-32001);

    const wrong = await worker.fetch(
      mcpRequest(initializeBody, { authorization: 'Bearer nope' }),
      env
    );
    expect(wrong.status).toBe(401);
  });

  it('fails closed with 503 when no token is configured', async () => {
    const res = await worker.fetch(
      mcpRequest(initializeBody, { authorization: 'Bearer anything' }),
      {}
    );
    expect(res.status).toBe(503);
  });

  it('accepts the configured token and rotated token lists', async () => {
    const ok = await worker.fetch(
      mcpRequest(initializeBody, { authorization: 'Bearer correct-token' }),
      { MCP_AUTH_TOKEN: 'correct-token' }
    );
    expect(ok.status).toBe(200);
    expect((await readJsonRpc(ok)).result.serverInfo.name).toBe('security-matrix');

    const rotated = await worker.fetch(
      mcpRequest(initializeBody, { authorization: 'Bearer old-token' }),
      { MCP_AUTH_TOKENS: 'new-token, old-token' }
    );
    expect(rotated.status).toBe(200);
  });

  it('forwards passthrough headers per request, overriding env credentials', async () => {
    const env = {
      MCP_AUTH_TOKEN: 'correct-token',
      APIKEYHEADER_API_KEY: 'server-key',
      OAUTH_CLIENT_ID: 'client-id',
      OAUTH_CLIENT_SECRET: 'client-secret',
    };
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'andRequirement', arguments: {} },
        },
        {
          authorization: 'Bearer correct-token',
          'x-api-key': 'user-key',
          'mcp-protocol-version': '2025-06-18',
        }
      ),
      env
    );
    expect(res.status).toBe(200);
    const message = await readJsonRpc(res);
    expect(message.result.isError ?? false).toBe(false);
    const seen = lastRequest(upstream, '/and');
    expect(seen.headers['x-api-key']).toBe('user-key');
    expect(seen.headers['authorization']).toBe('Bearer tok-read');
  });

  it('keeps the endpoint public by default (no --inbound-auth)', async () => {
    const res = await openWorker.fetch(mcpRequest(initializeBody), {});
    expect(res.status).toBe(200);
  });
});

// --- #81: Node runtime (stdio, end to end) -----------------------------------

describe('#81 security requirements: generated Node server (stdio)', () => {
  let client: Client;

  beforeAll(async () => {
    const outDir = path.join(workdir, 'node-stdio');
    generateWithCli(specPath, outDir, []);
    buildGenerated(outDir);
    client = new Client({ name: 'auth-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [path.join(outDir, 'build', 'index.js')],
        cwd: outDir,
        stderr: 'pipe',
        env: {
          ...getDefaultEnvironment(),
          API_KEY_APIKEYHEADER: 'header-key',
          API_KEY_APIKEYQUERY: 'query-key',
          OAUTH_CLIENT_ID_OAUTH: 'client-id',
          OAUTH_CLIENT_SECRET_OAUTH: 'client-secret',
        },
      })
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  const callTool = (name: string) => client.callTool({ name, arguments: {} });

  it('applies AND groups completely, with the operation scopes', async () => {
    const before = upstream.tokenRequests.length;
    await callTool('andRequirement');
    const seen = lastRequest(upstream, '/and');
    expect(seen.headers['x-api-key']).toBe('header-key');
    expect(seen.headers['authorization']).toBe('Bearer tok-read');
    expect(upstream.tokenRequests.slice(before).map((t) => t.scope)).toContain('read');
  });

  it('never sends a partial AND group, and falls back to the next alternative', async () => {
    await callTool('incompleteAnd');
    const incomplete = lastRequest(upstream, '/incomplete');
    expect(incomplete.headers['x-api-key']).toBeUndefined();
    expect(incomplete.headers['authorization']).toBeUndefined();

    await callTool('fallbackAfterIncomplete');
    const fallback = lastRequest(upstream, '/fallback');
    expect(fallback.query.api_key).toBe('query-key');
    expect(fallback.headers['x-api-key']).toBeUndefined();

    await callTool('orAlternatives');
    expect(lastRequest(upstream, '/or').query.api_key).toBe('query-key');
  });

  it('handles optional {}, explicit no-auth and failed token requests', async () => {
    await callTool('optionalAuth');
    expect(lastRequest(upstream, '/optional').headers['x-api-key']).toBe('header-key');

    await callTool('publicEndpoint');
    const pub = lastRequest(upstream, '/public');
    expect(pub.headers['x-api-key']).toBeUndefined();
    expect(pub.query.api_key).toBeUndefined();

    await callTool('tokenFailure');
    const failed = lastRequest(upstream, '/token-failure');
    expect(failed.headers['x-api-key']).toBeUndefined();
    expect(failed.headers['authorization']).toBeUndefined();
  });

  it('requests a token for the full scope set of the operation', async () => {
    await callTool('scopedOauth');
    expect(lastRequest(upstream, '/scoped').headers['authorization']).toBe('Bearer tok-read+write');
  });
});

// --- #80: Node HTTP transports -------------------------------------------------

describe('#80 inbound auth: generated Node HTTP servers', () => {
  const token = 'node-inbound-token';
  let httpDir: string;
  let webDir: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    httpDir = path.join(workdir, 'node-http');
    generateWithCli(specPath, httpDir, [
      '--transport',
      'streamable-http',
      '--inbound-auth',
      'bearer',
    ]);
    buildGenerated(httpDir);
    webDir = path.join(workdir, 'node-web');
    generateWithCli(specPath, webDir, ['--transport', 'web', '--inbound-auth', 'bearer']);
    buildGenerated(webDir);
  }, 120_000);

  afterAll(async () => {
    for (const child of children) await stopServer(child);
  });

  it('documents the token in .env.example without writing a value', () => {
    const envExample = fs.readFileSync(path.join(httpDir, '.env.example'), 'utf8');
    expect(envExample).toMatch(/^MCP_AUTH_TOKEN=$/m);
    const transport = fs.readFileSync(path.join(httpDir, 'src', 'streamable-http.ts'), 'utf8');
    expect(transport).not.toContain(token);
    expect(transport).toContain("app.use('/mcp', requireInboundAuth)");
  });

  it('streamable-http: 401 without a token, MCP works with it, /health stays public', async () => {
    const port = await freePort();
    const child = startNodeServer(httpDir, {
      PORT: String(port),
      MCP_AUTH_TOKEN: token,
      API_BASE_URL: upstream.url,
    });
    children.push(child);
    await waitForHealth(port, child);

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeBody),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain('Bearer');

    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify(initializeBody),
    });
    expect(wrong.status).toBe(401);

    const client = new Client({ name: 'auth-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('publicEndpoint');
    await client.close();
  }, 60_000);

  it('streamable-http: serves concurrent sessions and binds each to its opening token', async () => {
    const port = await freePort();
    const child = startNodeServer(httpDir, {
      PORT: String(port),
      MCP_AUTH_TOKENS: 'token-a,token-b',
      API_BASE_URL: upstream.url,
    });
    children.push(child);
    await waitForHealth(port, child);

    const connect = async (tok: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tok}` } },
      });
      const client = new Client({ name: `client-${tok}`, version: '1.0.0' });
      await client.connect(transport);
      return { client, transport };
    };
    // Two live sessions at once: each gets its own server instance.
    const [a, b] = await Promise.all([connect('token-a'), connect('token-b')]);
    const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(toolsA.tools.length).toBeGreaterThan(0);
    expect(toolsB.tools.length).toBe(toolsA.tools.length);

    // Replaying session A's id with token B is answered as an unknown session.
    const hijack = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer token-b',
        'mcp-session-id': a.transport.sessionId ?? '',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(hijack.status).toBe(404);

    // Session A still works for its own token.
    expect((await a.client.listTools()).tools.length).toBe(toolsA.tools.length);
    await Promise.all([a.client.close(), b.client.close()]);
  }, 60_000);

  it('streamable-http: fails closed (503) when MCP_AUTH_TOKEN is missing', async () => {
    const port = await freePort();
    const child = startNodeServer(httpDir, { PORT: String(port), API_BASE_URL: upstream.url });
    children.push(child);
    await waitForHealth(port, child);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(503);
  }, 60_000);

  it('web (SSE): protects /sse and /api/messages', async () => {
    const port = await freePort();
    const child = startNodeServer(webDir, {
      PORT: String(port),
      MCP_AUTH_TOKEN: token,
      API_BASE_URL: upstream.url,
    });
    children.push(child);
    await waitForHealth(port, child);

    expect((await fetch(`http://127.0.0.1:${port}/sse`)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/messages?sessionId=x`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(401);

    const controller = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  }, 60_000);
});

// --- CLI behavior ---------------------------------------------------------------

describe('#80 CLI options', () => {
  it('rejects unknown --inbound-auth modes', () => {
    const res = runCli([
      '-i',
      specPath,
      '-o',
      path.join(workdir, 'bad-mode'),
      '--inbound-auth',
      'basic',
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Expected "none" or "bearer"');
  });

  it('refuses to forward the Authorization header while inbound auth is on', () => {
    const res = runCli([
      '-i',
      specPath,
      '-o',
      path.join(workdir, 'leak'),
      '--transport',
      'streamable-http',
      '--inbound-auth',
      'bearer',
      '--header-passthrough',
      'Authorization',
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('cannot be combined with --inbound-auth bearer');
    expect(fs.existsSync(path.join(workdir, 'leak'))).toBe(false);
  });

  it('documents stdio as out of scope and generates no token check', () => {
    const outDir = path.join(workdir, 'stdio-note');
    const result = runCliCapture(['-i', specPath, '-o', outDir, '--inbound-auth', 'bearer']);
    expect(result).toContain('A stdio server has no network endpoint');
    expect(fs.readFileSync(path.join(outDir, 'src', 'index.ts'), 'utf8')).not.toContain(
      'createInboundAuthMiddleware'
    );
    expect(fs.readFileSync(path.join(outDir, '.env.example'), 'utf8')).not.toContain(
      'MCP_AUTH_TOKEN'
    );
  });

  it('warns when an HTTP server would hold upstream credentials without inbound auth', () => {
    const result = runCliCapture([
      '-i',
      specPath,
      '-o',
      path.join(workdir, 'warn'),
      '--transport',
      'streamable-http',
    ]);
    expect(result).toContain('Pass --inbound-auth bearer');
  });

  it('generates a Worker with inbound auth + passthrough that type-checks against workers-types', () => {
    const outDir = path.join(workdir, 'worker-typecheck');
    runCliCapture([
      '-i',
      specPath,
      '-o',
      outDir,
      '--transport',
      'cloudflare-worker',
      '--inbound-auth',
      'bearer',
      '--header-passthrough',
      'X-API-Key,Host',
    ]);
    const index = fs.readFileSync(path.join(outDir, 'src', 'index.ts'), 'utf8');
    expect(index).toContain('checkInboundAuth(request, env)');
    expect(index).toContain('const PASSTHROUGH_HEADERS: string[] = ["x-api-key"]');
    expect(fs.readFileSync(path.join(outDir, '.dev.vars.example'), 'utf8')).toContain(
      'MCP_AUTH_TOKEN'
    );
    expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf8')).toContain(
      'wrangler secret put MCP_AUTH_TOKEN'
    );

    fs.writeFileSync(
      path.join(outDir, 'tsconfig.check.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['es2022'],
          types: ['@cloudflare/workers-types'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      })
    );
    execFileSync('node', [tscEntry, '-p', path.join(outDir, 'tsconfig.check.json')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }, 60_000);
});

/** Runs the CLI (with --force) and returns its stderr, where it logs progress. */
function runCliCapture(args: string[]): string {
  const result = spawnSync('node', [cliEntry, ...args, '--force'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stderr;
}
