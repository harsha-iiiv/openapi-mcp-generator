/**
 * OAuth2 resource owner password grant in generated Node servers: password-only
 * schemes request a token with grant_type=password, authenticating the client the
 * same way as the client credentials grant when a secret is configured, sending
 * only client_id for a public client, and failing closed without a username and
 * password. A local token endpoint records every token request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface TokenRequest {
  form: Record<string, string>;
  authorization?: string;
}

interface Upstream {
  url: string;
  requests: { path: string; authorization?: string }[];
  tokenRequests: TokenRequest[];
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const requests: Upstream['requests'] = [];
  const tokenRequests: TokenRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/oauth/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        tokenRequests.push({ form, authorization: req.headers.authorization });
        res.end(
          JSON.stringify({
            access_token: `issued-for-${form.username ?? 'client'}`,
            expires_in: 3600,
          })
        );
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

function passwordSpec(upstream: string): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Password Grant', version: '1.0.0' },
    servers: [{ url: upstream }],
    components: {
      securitySchemes: {
        legacy: {
          type: 'oauth2',
          flows: {
            password: { tokenUrl: `${upstream}/oauth/token`, scopes: { read: 'read' } },
          },
        },
      },
    },
    paths: {
      '/reports': {
        get: {
          operationId: 'listReports',
          security: [{ legacy: ['read'] }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  } as OpenAPIV3.Document;
}

let upstream: Upstream;
let workdir: string;
let specPath: string;
const builds: Record<string, string> = {};

function build(name: string, args: string[]): string {
  const outDir = path.join(workdir, name);
  execFileSync('node', [cliEntry, '--input', specPath, '--output', outDir, '--force', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  execFileSync('node', [tscEntry, '-p', path.join(outDir, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return outDir;
}

interface Session {
  call(): Promise<{ isError?: boolean; content: { text: string }[] }>;
  stderr(): string;
  close(): Promise<void>;
}

/** Starts the generated stdio server with only the given credentials in its environment. */
async function start(outDir: string, env: Record<string, string>): Promise<Session> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(outDir, 'build', 'index.js')],
    cwd: outDir,
    stderr: 'pipe',
    env: { ...getDefaultEnvironment(), ...env },
  });
  let log = '';
  transport.stderr?.on('data', (chunk) => (log += String(chunk)));
  const client = new Client({ name: 'password-grant-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    call: () =>
      client.callTool({ name: 'listReports', arguments: {} }) as Promise<{
        isError?: boolean;
        content: { text: string }[];
      }>,
    stderr: () => log,
    close: () => client.close(),
  };
}

const login = { OAUTH_USERNAME_LEGACY: 'alice', OAUTH_PASSWORD_LEGACY: 'pa55word' };

beforeAll(async () => {
  upstream = await startUpstream();
  workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-password-grant-'));
  specPath = path.join(workdir, 'password-grant.json');
  fs.writeFileSync(specPath, JSON.stringify(passwordSpec(upstream.url), null, 2));
  builds.header = build('node-header', []);
  builds.body = build('node-body', ['--oauth-creds-in-body']);
}, 120_000);

afterAll(async () => {
  await upstream?.close();
  if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
});

describe('OAuth2 password grant (generated Node server)', () => {
  it('requests a token with grant_type=password, scopes and Basic client authentication', async () => {
    const session = await start(builds.header, {
      ...login,
      OAUTH_CLIENT_ID_LEGACY: 'cid',
      OAUTH_CLIENT_SECRET_LEGACY: 'csecret',
    });
    try {
      const before = upstream.tokenRequests.length;
      const result = await session.call();
      expect(result.isError ?? false).toBe(false);
      const grants = upstream.tokenRequests.slice(before);
      expect(grants).toHaveLength(1);
      expect(grants[0].form).toEqual({
        grant_type: 'password',
        username: 'alice',
        password: 'pa55word',
        scope: 'read',
      });
      expect(grants[0].authorization).toBe(
        'Basic ' + Buffer.from('cid:csecret').toString('base64')
      );
      expect(upstream.requests.at(-1)).toEqual({
        path: '/reports',
        authorization: 'Bearer issued-for-alice',
      });

      // The token is cached: a second call makes no new token request.
      await session.call();
      expect(upstream.tokenRequests.length).toBe(before + 1);

      // Credentials, tokens and the token URL never reach the logs.
      const log = session.stderr();
      expect(log).toContain("Requesting OAuth2 token for 'legacy'");
      for (const secret of ['pa55word', 'csecret', 'issued-for-alice', '/oauth/token']) {
        expect(log).not.toContain(secret);
      }
    } finally {
      await session.close();
    }
  }, 60_000);

  it('sends client credentials in the form with --oauth-creds-in-body', async () => {
    const session = await start(builds.body, {
      ...login,
      OAUTH_CLIENT_ID_LEGACY: 'cid',
      OAUTH_CLIENT_SECRET_LEGACY: 'csecret',
    });
    try {
      const before = upstream.tokenRequests.length;
      expect((await session.call()).isError ?? false).toBe(false);
      const [grant] = upstream.tokenRequests.slice(before);
      expect(grant.form).toEqual({
        grant_type: 'password',
        username: 'alice',
        password: 'pa55word',
        scope: 'read',
        client_id: 'cid',
        client_secret: 'csecret',
      });
      expect(grant.authorization).toBeUndefined();
    } finally {
      await session.close();
    }
  }, 60_000);

  it('sends only client_id for a public client, and no client authentication without one', async () => {
    const publicClient = await start(builds.header, { ...login, OAUTH_CLIENT_ID_LEGACY: 'cid' });
    try {
      const before = upstream.tokenRequests.length;
      expect((await publicClient.call()).isError ?? false).toBe(false);
      const [grant] = upstream.tokenRequests.slice(before);
      expect(grant.form).toEqual({
        grant_type: 'password',
        username: 'alice',
        password: 'pa55word',
        scope: 'read',
        client_id: 'cid',
      });
      expect(grant.authorization).toBeUndefined();
    } finally {
      await publicClient.close();
    }

    const noClient = await start(builds.header, login);
    try {
      const before = upstream.tokenRequests.length;
      expect((await noClient.call()).isError ?? false).toBe(false);
      const [grant] = upstream.tokenRequests.slice(before);
      expect(grant.form).toEqual({
        grant_type: 'password',
        username: 'alice',
        password: 'pa55word',
        scope: 'read',
      });
      expect(grant.authorization).toBeUndefined();
    } finally {
      await noClient.close();
    }
  }, 60_000);

  it('fails closed without a username and password, naming the variables', async () => {
    const session = await start(builds.header, {
      OAUTH_USERNAME_LEGACY: 'alice',
      OAUTH_CLIENT_ID_LEGACY: 'cid',
      OAUTH_CLIENT_SECRET_LEGACY: 'csecret',
    });
    try {
      const tokensBefore = upstream.tokenRequests.length;
      const callsBefore = upstream.requests.length;
      const result = await session.call();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Missing credentials for 'listReports': set OAUTH_TOKEN_LEGACY (or OAUTH_USERNAME_LEGACY " +
          'and OAUTH_PASSWORD_LEGACY). Required security: [legacy (scopes: read)].'
      );
      // Client credentials alone never trigger a client_credentials grant for this scheme.
      expect(upstream.tokenRequests.length).toBe(tokensBefore);
      expect(upstream.requests.length).toBe(callsBefore);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('uses OAUTH_TOKEN_<SCHEME> over the username and password', async () => {
    const session = await start(builds.header, { ...login, OAUTH_TOKEN_LEGACY: 'own-token' });
    try {
      const before = upstream.tokenRequests.length;
      expect((await session.call()).isError ?? false).toBe(false);
      expect(upstream.requests.at(-1)?.authorization).toBe('Bearer own-token');
      expect(upstream.tokenRequests.length).toBe(before);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('documents the password-grant variables in the OAuth2 docs and .env.example', () => {
    const docs = fs.readFileSync(
      path.join(builds.header, 'docs', 'oauth2-configuration.md'),
      'utf8'
    );
    const envExample = fs.readFileSync(path.join(builds.header, '.env.example'), 'utf8');
    for (const doc of [docs, envExample]) {
      expect(doc).toContain('OAUTH_USERNAME_LEGACY');
      expect(doc).toContain('OAUTH_PASSWORD_LEGACY');
      expect(doc).toContain('OAUTH_TOKEN_LEGACY');
    }
  });
});
