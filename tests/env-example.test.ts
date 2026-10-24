/**
 * Example environment files must never configure credentials by themselves: a
 * placeholder copied unchanged would count as a credential and be sent upstream.
 * Copying .env.example to .env (or .dev.vars.example to .dev.vars) unchanged must
 * leave secured tools failing closed without calling the API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { OpenAPIV3 } from 'openapi-types';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

interface Upstream {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(new URL(req.url ?? '/', 'http://localhost').pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'issued', expires_in: 3600 }));
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

function placeholderSpec(upstream: string): OpenAPIV3.Document {
  const op = (operationId: string, scheme: string) => ({
    get: {
      operationId,
      security: [{ [scheme]: [] }],
      responses: { '200': { description: 'ok' } },
    },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Placeholder Credentials', version: '1.0.0' },
    servers: [{ url: upstream }],
    components: {
      securitySchemes: {
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
        basicAuth: { type: 'http', scheme: 'basic' },
        oidc: { type: 'openIdConnect', openIdConnectUrl: `${upstream}/.well-known/openid` },
        machine: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: `${upstream}/oauth/token`, scopes: {} } },
        },
        legacy: {
          type: 'oauth2',
          flows: { password: { tokenUrl: `${upstream}/oauth/token`, scopes: {} } },
        },
      },
    },
    paths: {
      '/key': op('withApiKey', 'apiKeyAuth'),
      '/bearer': op('withBearer', 'bearerAuth'),
      '/basic': op('withBasic', 'basicAuth'),
      '/oidc': op('withOidc', 'oidc'),
      '/machine': op('withClientCredentials', 'machine'),
      '/legacy': op('withPassword', 'legacy'),
    },
  } as OpenAPIV3.Document;
}

const securedTools = [
  'withApiKey',
  'withBearer',
  'withBasic',
  'withOidc',
  'withClientCredentials',
  'withPassword',
];
const credentialKey =
  /^(API_KEY_|BEARER_TOKEN_|BASIC_|OAUTH_|OPENID_|MCP_AUTH_TOKEN)|_(API_KEY|TOKEN|USERNAME|PASSWORD|CLIENT_ID|CLIENT_SECRET|TOKEN_URL)$/;

let upstream: Upstream;
let workdir: string;
let specPath: string;

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-env-example-'));
  specPath = path.join(workdir, 'placeholders.json');
  fs.writeFileSync(specPath, JSON.stringify(placeholderSpec(upstream.url), null, 2));
});

afterAll(async () => {
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

function generate(outDir: string, args: string[]): void {
  execFileSync('node', [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('generated .env.example placeholders (Node)', () => {
  let outDir: string;
  let client: Client;

  beforeAll(async () => {
    outDir = path.join(workdir, 'node');
    generate(outDir, []);
    execFileSync('node', [tscEntry, '-p', path.join(outDir, 'tsconfig.json')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    // Copy the example unchanged; the generated server loads .env from its cwd.
    fs.copyFileSync(path.join(outDir, '.env.example'), path.join(outDir, '.env'));
    client = new Client({ name: 'env-example-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [path.join(outDir, 'build', 'index.js')],
        cwd: outDir,
        stderr: 'pipe',
        env: getDefaultEnvironment(),
      })
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it('sets no credential variable and keeps the names visible as comments', () => {
    const example = fs.readFileSync(path.join(outDir, '.env.example'), 'utf8');
    const parsed = parseEnv(example);
    expect(Object.keys(parsed).filter((k) => credentialKey.test(k))).toEqual([]);
    expect(example).toMatch(/^# API_KEY_APIKEYAUTH=your_api_key_here$/m);
    expect(example).toMatch(/^# BEARER_TOKEN_BEARERAUTH=/m);
    expect(example).toMatch(/^# BASIC_USERNAME_BASICAUTH=/m);
    expect(example).toMatch(/^# OPENID_TOKEN_OIDC=/m);
    expect(example).toMatch(/^# OAUTH_TOKEN_MACHINE=/m);
    expect(example).toMatch(/^# Uncomment the variables for the schemes you use/m);
  });

  it('fails closed for every secured tool when .env is the unchanged example', async () => {
    const before = upstream.requests.length;
    for (const name of securedTools) {
      const result = (await client.callTool({ name, arguments: {} })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(
        new RegExp(`^Missing credentials for '${name}'`)
      );
    }
    // Neither the API nor the token endpoint was called.
    expect(upstream.requests.length).toBe(before);
  });
});

describe('generated .dev.vars.example placeholders (Worker)', () => {
  let outDir: string;
  let worker: {
    fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
  };

  beforeAll(async () => {
    outDir = path.join(workdir, 'worker');
    generate(outDir, ['--transport', 'cloudflare-worker', '--inbound-auth', 'bearer']);
    worker = (await import(pathToFileURL(path.join(outDir, 'src', 'index.ts')).href)).default;
  });

  it('sets no secret, including the inbound token', () => {
    const parsed = parseEnv(fs.readFileSync(path.join(outDir, '.dev.vars.example'), 'utf8'));
    expect(Object.keys(parsed).filter((k) => credentialKey.test(k))).toEqual([]);
  });

  it('fails closed for every secured tool when .dev.vars is the unchanged example', async () => {
    const env = {
      ...parseEnv(fs.readFileSync(path.join(outDir, '.dev.vars.example'), 'utf8')),
      // The inbound token is a separate, deliberate setting.
      MCP_AUTH_TOKEN: 'inbound',
    };
    const before = upstream.requests.length;
    for (const name of securedTools) {
      const res = await worker.fetch(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer inbound',
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
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      const result = JSON.parse(line ? line.slice(6) : text).result;
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(
        new RegExp(`^Missing credentials for '${name}'`)
      );
    }
    expect(upstream.requests.length).toBe(before);
  });
});
