/**
 * Cloudflare Worker OAuth2: a pre-acquired <SCHEME>_TOKEN works for every flow, and
 * the Worker requests a client-credentials token only for schemes that declare a
 * clientCredentials flow. The generated Worker modules are imported directly and
 * driven with fetch-style requests against a local upstream and token endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpenAPIV3 } from 'openapi-types';
import { extractToolsFromApi } from '../src/parser/extract-tools.js';
import { generateCloudflareWorkerFiles } from '../src/generator/cloudflare-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

interface Upstream {
  url: string;
  requests: { path: string; authorization?: string }[];
  tokenRequests: { body: string }[];
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const requests: Upstream['requests'] = [];
  const tokenRequests: Upstream['tokenRequests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/token')) {
        tokenRequests.push({ body });
        const scope = new URLSearchParams(body).get('scope') ?? 'none';
        res.end(JSON.stringify({ access_token: `fetched-${scope}`, expires_in: 3600 }));
        return;
      }
      requests.push({ path: url.pathname, authorization: req.headers.authorization });
      res.end(JSON.stringify({ ok: true }));
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

function oauthSpec(upstream: string): OpenAPIV3.Document {
  const op = (operationId: string, security: OpenAPIV3.SecurityRequirementObject[]) => ({
    get: { operationId, security, responses: { '200': { description: 'ok' } } },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Worker OAuth2', version: '1.0.0' },
    servers: [{ url: upstream }],
    components: {
      securitySchemes: {
        implicitOnly: {
          type: 'oauth2',
          flows: {
            implicit: {
              authorizationUrl: `${upstream}/authorize`,
              scopes: { read: 'read' },
            },
          },
        },
        passwordOnly: {
          type: 'oauth2',
          flows: { password: { tokenUrl: `${upstream}/password/token`, scopes: {} } },
        },
        machine: {
          type: 'oauth2',
          flows: {
            clientCredentials: { tokenUrl: `${upstream}/oauth/token`, scopes: { read: 'read' } },
          },
        },
      },
    },
    paths: {
      '/implicit': op('implicitOp', [{ implicitOnly: ['read'] }]),
      '/password': op('passwordOp', [{ passwordOnly: [] }]),
      '/machine': op('machineOp', [{ machine: ['read'] }]),
    },
  } as OpenAPIV3.Document;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

let upstream: Upstream;
let workdir: string;
let api: OpenAPIV3.Document;
let worker: {
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
};

async function callTool(name: string, env: Record<string, string>): Promise<ToolResult> {
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
        params: { name, arguments: {} },
      }),
    }),
    env
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text).result as ToolResult;
}

const hits = (p: string) => upstream.requests.filter((r) => r.path === p);

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-worker-oauth2-'));
  api = oauthSpec(upstream.url);
  const files = generateCloudflareWorkerFiles({
    tools: extractToolsFromApi(api),
    serverName: 'worker-oauth2',
    serverVersion: '1.0.0',
    securitySchemes: api.components?.securitySchemes,
    baseUrl: upstream.url,
  });
  for (const file of files) {
    const dest = path.join(workdir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content);
  }
  worker = (await import(pathToFileURL(path.join(workdir, 'src', 'index.ts')).href)).default;
});

afterAll(async () => {
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

describe('cloudflare-worker OAuth2 credentials', () => {
  it('sends a pre-acquired token for an implicit-only scheme without a token request', async () => {
    const tokensBefore = upstream.tokenRequests.length;
    const result = await callTool('implicitOp', {
      IMPLICITONLY_TOKEN: 'user-token',
      // Client credentials must not trigger a grant the scheme does not declare.
      IMPLICITONLY_CLIENT_ID: 'id',
      IMPLICITONLY_CLIENT_SECRET: 'secret',
      IMPLICITONLY_TOKEN_URL: `${upstream.url}/oauth/token`,
    });
    expect(result.isError ?? false).toBe(false);
    expect(hits('/implicit').at(-1)?.authorization).toBe('Bearer user-token');
    expect(upstream.tokenRequests.length).toBe(tokensBefore);
  });

  it('fails closed for an implicit-only scheme without a token, naming only the token secret', async () => {
    const tokensBefore = upstream.tokenRequests.length;
    const callsBefore = hits('/implicit').length;
    const result = await callTool('implicitOp', {
      IMPLICITONLY_CLIENT_ID: 'id',
      IMPLICITONLY_CLIENT_SECRET: 'secret',
      IMPLICITONLY_TOKEN_URL: `${upstream.url}/oauth/token`,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Missing credentials for 'implicitOp': set IMPLICITONLY_TOKEN (wrangler secret put <NAME>)."
    );
    expect(upstream.tokenRequests.length).toBe(tokensBefore);
    expect(hits('/implicit').length).toBe(callsBefore);
  });

  it('never requests a token for a password-only scheme', async () => {
    const tokensBefore = upstream.tokenRequests.length;
    const missing = await callTool('passwordOp', {
      PASSWORDONLY_CLIENT_ID: 'id',
      PASSWORDONLY_CLIENT_SECRET: 'secret',
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('set PASSWORDONLY_TOKEN (wrangler');
    const ok = await callTool('passwordOp', { PASSWORDONLY_TOKEN: 'pw-token' });
    expect(ok.isError ?? false).toBe(false);
    expect(hits('/password').at(-1)?.authorization).toBe('Bearer pw-token');
    expect(upstream.tokenRequests.length).toBe(tokensBefore);
  });

  it('still fetches a client-credentials token, and a pre-acquired token wins', async () => {
    const tokensBefore = upstream.tokenRequests.length;
    const fetched = await callTool('machineOp', {
      MACHINE_CLIENT_ID: 'id',
      MACHINE_CLIENT_SECRET: 'secret',
    });
    expect(fetched.isError ?? false).toBe(false);
    expect(hits('/machine').at(-1)?.authorization).toBe('Bearer fetched-read');
    const grants = upstream.tokenRequests.slice(tokensBefore);
    expect(grants.length).toBe(1);
    expect(new URLSearchParams(grants[0].body).get('grant_type')).toBe('client_credentials');

    const preAcquired = await callTool('machineOp', { MACHINE_TOKEN: 'own-token' });
    expect(preAcquired.isError ?? false).toBe(false);
    expect(hits('/machine').at(-1)?.authorization).toBe('Bearer own-token');
    expect(upstream.tokenRequests.length).toBe(tokensBefore + 1);
  });

  it('names the token and the client credentials for a client-credentials scheme', async () => {
    const result = await callTool('machineOp', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Missing credentials for 'machineOp': set MACHINE_TOKEN (or MACHINE_CLIENT_ID and " +
        'MACHINE_CLIENT_SECRET) (wrangler secret put <NAME>).'
    );
  });

  it('documents the token secret per flow in .dev.vars.example and the README', () => {
    const devVars = fs.readFileSync(path.join(workdir, '.dev.vars.example'), 'utf8');
    const readme = fs.readFileSync(path.join(workdir, 'README.md'), 'utf8');
    for (const doc of [devVars, readme]) {
      expect(doc).toContain('IMPLICITONLY_TOKEN');
      expect(doc).not.toContain('IMPLICITONLY_CLIENT_ID');
      expect(doc).toContain('PASSWORDONLY_TOKEN');
      expect(doc).not.toContain('PASSWORDONLY_CLIENT_ID');
      expect(doc).toContain('MACHINE_TOKEN');
      expect(doc).toContain('MACHINE_CLIENT_ID');
      expect(doc).toContain('MACHINE_CLIENT_SECRET');
      expect(doc).not.toContain('MACHINE_TOKEN_URL');
    }
    expect(readme).toContain('npx wrangler secret put IMPLICITONLY_TOKEN');
  });

  it('type-checks against workers-types', () => {
    fs.writeFileSync(
      path.join(workdir, 'tsconfig.check.json'),
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
    execFileSync('node', [tscEntry, '-p', path.join(workdir, 'tsconfig.check.json')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }, 60_000);
});
