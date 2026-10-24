/**
 * Browser OAuth for MCP (playground/oauth.js) against an in-test protected
 * resource and authorization server: discovery fallbacks, client registration
 * choice (CIMD, DCR, manual), PKCE, the resource parameter, token exchange,
 * refresh, and the hand-off to McpClient.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { McpClient, McpHttpError } from '../playground/mcp-client.js';
import {
  OAuthClient,
  OAuthError,
  canonicalResource,
  authorizationServerUrls,
  protectedResourceUrls,
  selectScope,
  createPkce,
} from '../playground/oauth.js';

const REDIRECT = 'https://mcp.pidata.tech/playground/oauth-callback.html';
const CIMD = 'https://mcp.pidata.tech/playground/oauth-client.json';
const SERVER = 'https://mcp.test/mcp';

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

interface WorldOptions {
  challengeMetadata?: boolean;
  prmAt?: 'path' | 'root' | 'none';
  issuer?: string;
  asAt?: 'oauth' | 'oidc-insert' | 'oidc-append';
  cimd?: boolean;
  dcr?: boolean;
  pkce?: boolean;
  scope?: string;
  issuerClaim?: string;
  prmResource?: string;
  expiresIn?: number;
}

/** A protected MCP server plus its authorization server, all behind one fake fetch. */
function world(opts: WorldOptions = {}) {
  const o = {
    challengeMetadata: true,
    prmAt: 'path',
    issuer: 'https://auth.test/tenant',
    asAt: 'oauth',
    cimd: false,
    dcr: true,
    pkce: true,
    expiresIn: 3600,
    ...opts,
  } as Required<WorldOptions>;
  const log: string[] = [];
  const codes = new Map<string, any>();
  const refreshTokens = new Map<string, any>();
  const issued = new Set<string>();
  let registrations = 0;
  let tokenCalls: URLSearchParams[] = [];
  const issuerUrl = new URL(o.issuer);
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, '');
  const asMetadata: Record<string, unknown> = {
    issuer: o.issuerClaim ?? o.issuer,
    authorization_endpoint: `${issuerUrl.origin}/authorize`,
    token_endpoint: `${issuerUrl.origin}/token`,
    response_types_supported: ['code'],
  };
  if (o.pkce) asMetadata.code_challenge_methods_supported = ['S256'];
  if (o.dcr) asMetadata.registration_endpoint = `${issuerUrl.origin}/register`;
  if (o.cimd) asMetadata.client_id_metadata_document_supported = true;
  const asPath = {
    oauth: `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    'oidc-insert': `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    'oidc-append': `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
  }[o.asAt];
  const prmUrl =
    o.prmAt === 'path'
      ? 'https://mcp.test/.well-known/oauth-protected-resource/mcp'
      : 'https://mcp.test/.well-known/oauth-protected-resource';

  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    log.push(`${method} ${url.origin}${url.pathname}`);
    const headers = new Headers(init.headers);
    if (url.href === SERVER) {
      const auth = headers.get('authorization') ?? '';
      if (!issued.has(auth.replace('Bearer ', ''))) {
        const params = [`realm="mcp"`];
        if (o.challengeMetadata) params.push(`resource_metadata="${prmUrl}"`);
        if (o.scope) params.push(`scope="${o.scope}"`);
        return new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { 'www-authenticate': `Bearer ${params.join(', ')}` },
        });
      }
      const body = JSON.parse(String(init.body));
      if (!('id' in body)) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'secure', version: '1' },
              }
            : { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] },
      });
    }
    if (o.prmAt !== 'none' && url.href === prmUrl) {
      return Response.json({
        resource: o.prmResource ?? SERVER,
        authorization_servers: [o.issuer],
        scopes_supported: ['mcp:read', 'mcp:write'],
      });
    }
    if (url.href === asPath) return Response.json(asMetadata);
    if (url.href === `${issuerUrl.origin}/register` && method === 'POST' && o.dcr) {
      registrations++;
      const body = JSON.parse(String(init.body));
      expect(body.redirect_uris).toEqual([REDIRECT]);
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body.client_name).toBe('MCP Playground');
      return Response.json({ client_id: `dcr-${registrations}`, ...body }, { status: 201 });
    }
    if (url.href === `${issuerUrl.origin}/token` && method === 'POST') {
      expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init.body));
      tokenCalls.push(form);
      const issue = (client_id: string, resource: string) => {
        const access = `at-${Math.random().toString(36).slice(2)}`;
        const refresh = `rt-${Math.random().toString(36).slice(2)}`;
        issued.add(access);
        refreshTokens.set(refresh, { client_id, resource });
        return Response.json({
          access_token: access,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: o.expiresIn,
        });
      };
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.client_id !== form.get('client_id') ||
          grant.redirect_uri !== form.get('redirect_uri') ||
          grant.resource !== form.get('resource')
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return issue(grant.client_id, grant.resource);
      }
      if (form.get('grant_type') === 'refresh_token') {
        const grant = refreshTokens.get(form.get('refresh_token') ?? '');
        refreshTokens.delete(form.get('refresh_token') ?? '');
        if (!grant || grant.resource !== form.get('resource')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return issue(grant.client_id, grant.resource);
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    return new Response('not found', { status: 404 });
  };

  /** The "browser": validates the authorization request and returns a code. */
  const authorize = async (authUrl: string, { state }: { state: string }) => {
    const u = new URL(authUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${issuerUrl.origin}/authorize`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(state);
    const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`;
    codes.set(code, {
      challenge: u.searchParams.get('code_challenge'),
      client_id: u.searchParams.get('client_id'),
      redirect_uri: u.searchParams.get('redirect_uri'),
      resource: u.searchParams.get('resource'),
      scope: u.searchParams.get('scope'),
    });
    lastAuthorization = u;
    return { code, state };
  };
  let lastAuthorization: URL | undefined;

  return {
    fetch: fetchImpl,
    authorize,
    log,
    get registrations() {
      return registrations;
    },
    get tokenCalls() {
      return tokenCalls;
    },
    get lastAuthorization() {
      return lastAuthorization!;
    },
    expireAll: () => issued.clear(),
  };
}

function oauthFor(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  return new OAuthClient({
    serverUrl: SERVER,
    redirectUri: REDIRECT,
    clientMetadataUrl: CIMD,
    clientUri: 'https://mcp.pidata.tech/playground/',
    fetch: w.fetch,
    sessionStorage: memory(),
    localStorage: memory(),
    openAuthorization: w.authorize,
    ...extra,
  });
}

async function challengeFrom(w: ReturnType<typeof world>) {
  const client = new McpClient({ url: SERVER, hints: 'hosted', fetch: w.fetch });
  const error = (await client.connect().catch((e: unknown) => e)) as McpHttpError;
  expect(error).toBeInstanceOf(McpHttpError);
  return error;
}

describe('oauth helpers', () => {
  it('builds well-known URLs in the order the spec requires', () => {
    expect(protectedResourceUrls('https://a.test/public/mcp')).toEqual([
      'https://a.test/.well-known/oauth-protected-resource/public/mcp',
      'https://a.test/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceUrls('https://a.test/')).toEqual([
      'https://a.test/.well-known/oauth-protected-resource',
    ]);
    expect(authorizationServerUrls('https://auth.test/tenant1')).toEqual([
      'https://auth.test/.well-known/oauth-authorization-server/tenant1',
      'https://auth.test/.well-known/openid-configuration/tenant1',
      'https://auth.test/tenant1/.well-known/openid-configuration',
    ]);
    expect(authorizationServerUrls('https://auth.test')).toEqual([
      'https://auth.test/.well-known/oauth-authorization-server',
      'https://auth.test/.well-known/openid-configuration',
    ]);
  });

  it('canonicalizes resources and selects scopes', () => {
    expect(canonicalResource('HTTPS://MCP.Example.com/mcp#x')).toBe('https://mcp.example.com/mcp');
    expect(canonicalResource('https://mcp.example.com/')).toBe('https://mcp.example.com');
    expect(selectScope({ scope: 'a b' }, { scopes_supported: ['c'] })).toBe('a b');
    expect(selectScope({}, { scopes_supported: ['c', 'd'] })).toBe('c d');
    expect(selectScope(undefined, {})).toBeUndefined();
  });

  it('creates S256 PKCE pairs', async () => {
    const { verifier, challenge, method } = await createPkce();
    expect(method).toBe('S256');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('oauth: discovery', () => {
  it('follows resource_metadata from the 401 and uses the challenge scope', async () => {
    const w = world({ scope: 'mcp:read' });
    const error = await challengeFrom(w);
    expect(error.oauth).toBe(true);
    const plan = await oauthFor(w).discover(error.challenge);
    expect(plan.resourceMetadataUrl).toBe(
      'https://mcp.test/.well-known/oauth-protected-resource/mcp'
    );
    expect(plan.issuer).toBe('https://auth.test/tenant');
    expect(plan.authorizationEndpoint).toBe('https://auth.test/authorize');
    expect(plan.resource).toBe(SERVER);
    expect(plan.scope).toBe('mcp:read');
    expect(plan.registration).toBe('dcr');
  });

  it('falls back to the root well-known URL and to OpenID discovery', async () => {
    const w = world({ challengeMetadata: false, prmAt: 'root', asAt: 'oidc-append' });
    const error = await challengeFrom(w);
    const plan = await oauthFor(w).discover(error.challenge);
    expect(plan.scope).toBe('mcp:read mcp:write');
    const gets = w.log.filter((l) => l.startsWith('GET'));
    expect(gets).toEqual([
      'GET https://mcp.test/.well-known/oauth-protected-resource/mcp',
      'GET https://mcp.test/.well-known/oauth-protected-resource',
      'GET https://auth.test/.well-known/oauth-authorization-server/tenant',
      'GET https://auth.test/.well-known/openid-configuration/tenant',
      'GET https://auth.test/tenant/.well-known/openid-configuration',
    ]);
  });

  it('refuses servers without PKCE, a mismatched issuer or another resource', async () => {
    for (const opts of [
      { pkce: false },
      { issuerClaim: 'https://evil.test/tenant' },
      { prmResource: 'https://other.test/mcp' },
    ]) {
      const w = world(opts);
      const error = await challengeFrom(w);
      await expect(
        oauthFor(w).discover(error.challenge),
        JSON.stringify(opts)
      ).rejects.toBeInstanceOf(OAuthError);
    }
  });
});

describe('oauth: client registration', () => {
  it('uses the Client ID Metadata Document when the server supports it', async () => {
    const w = world({ cimd: true });
    const oauth = oauthFor(w);
    const plan = await oauth.discover((await challengeFrom(w)).challenge);
    expect(plan.registration).toBe('cimd');
    await oauth.signIn(plan.challenge);
    expect(w.lastAuthorization.searchParams.get('client_id')).toBe(CIMD);
    expect(w.registrations).toBe(0);
  });

  it('registers dynamically once and reuses the registration', async () => {
    const w = world();
    const local = memory();
    const first = oauthFor(w, { localStorage: local });
    await first.signIn((await challengeFrom(w)).challenge);
    expect(w.lastAuthorization.searchParams.get('client_id')).toBe('dcr-1');
    const second = oauthFor(w, { localStorage: local });
    await second.signIn((await challengeFrom(w)).challenge);
    expect(w.registrations).toBe(1);
    expect(w.lastAuthorization.searchParams.get('client_id')).toBe('dcr-1');
  });

  it('asks for a client id when neither CIMD nor DCR is available', async () => {
    const w = world({ dcr: false });
    const challenge = (await challengeFrom(w)).challenge;
    const plan = await oauthFor(w).discover(challenge);
    expect(plan.needsClientId).toBe(true);
    await expect(oauthFor(w).signIn(challenge)).rejects.toMatchObject({
      code: 'client_id_required',
    });
    const manual = oauthFor(w, { clientId: 'registered-by-hand' });
    await manual.signIn(challenge);
    expect(w.lastAuthorization.searchParams.get('client_id')).toBe('registered-by-hand');
  });
});

describe('oauth: sign-in, tokens and refresh', () => {
  it('sends PKCE, state, resource and scope, exchanges the code and connects', async () => {
    const w = world({ scope: 'mcp:read' });
    const oauth = oauthFor(w);
    const error = await challengeFrom(w);
    const tokens = await oauth.signIn(error.challenge);
    const auth = w.lastAuthorization;
    expect(auth.searchParams.get('resource')).toBe(SERVER);
    expect(auth.searchParams.get('scope')).toBe('mcp:read');
    expect(auth.searchParams.get('redirect_uri')).toBe(REDIRECT);
    const exchange = w.tokenCalls[0];
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('resource')).toBe(SERVER);
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.access_token).toMatch(/^at-/);
    expect(oauth.hasToken()).toBe(true);

    const client = new McpClient({
      url: SERVER,
      hints: 'hosted',
      auth: oauth.provider(),
      fetch: w.fetch,
    });
    await client.connect();
    expect((await client.listTools())[0].name).toBe('whoami');
  });

  it('rejects a callback whose state does not match', async () => {
    const w = world();
    const oauth = oauthFor(w, {
      openAuthorization: async (url: string) => {
        await w.authorize(url, { state: new URL(url).searchParams.get('state')! });
        return { code: 'whatever', state: 'forged' };
      },
    });
    await expect(oauth.signIn((await challengeFrom(w)).challenge)).rejects.toThrow(
      /state mismatch/
    );
  });

  it('refreshes an expiring token before use, and once after a 401', async () => {
    const w = world({ expiresIn: 30 });
    const oauth = oauthFor(w);
    const first = await oauth.signIn((await challengeFrom(w)).challenge);
    // expires_in 30 s is inside the one-minute window: the next use refreshes.
    const next = await oauth.getAccessToken();
    expect(next).not.toBe(first.access_token);
    expect(w.tokenCalls.at(-1)!.get('grant_type')).toBe('refresh_token');
    expect(w.tokenCalls.at(-1)!.get('resource')).toBe(SERVER);

    const longLived = world();
    const oauth2 = oauthFor(longLived);
    await oauth2.signIn((await challengeFrom(longLived)).challenge);
    longLived.expireAll(); // the server forgets every token: the next call gets a 401
    const client = new McpClient({
      url: SERVER,
      hints: 'hosted',
      auth: oauth2.provider(),
      fetch: longLived.fetch,
    });
    await client.connect();
    expect(
      longLived.tokenCalls.filter((f) => f.get('grant_type') === 'refresh_token')
    ).toHaveLength(1);
  });

  it('routes OAuth requests through the relay when asked, and never retries a token request there', async () => {
    const w = world();
    const viaRelay: string[] = [];
    const relayed = oauthFor(w, {
      relayUrl: 'https://relay.test/',
      useRelay: true,
      fetch: (url: string, init: RequestInit) => {
        if (url === 'https://relay.test/') {
          const target = (init.headers as Record<string, string>)['x-mcp-target'];
          viaRelay.push(target);
          return w.fetch(target, init);
        }
        throw new TypeError('direct requests are blocked in this test');
      },
    });
    await relayed.signIn((await challengeFrom(w)).challenge);
    expect(viaRelay).toContain('https://auth.test/token');
    expect(viaRelay).toContain('https://auth.test/register');

    // Direct mode: discovery may fall back to the relay, the token request may not.
    const w2 = world();
    const relayHits: string[] = [];
    const direct = oauthFor(w2, {
      relayUrl: 'https://relay.test/',
      fetch: (url: string, init: RequestInit) => {
        if (url === 'https://relay.test/') {
          const target = (init.headers as Record<string, string>)['x-mcp-target'];
          relayHits.push(target);
          return w2.fetch(target, init);
        }
        if (url.endsWith('/token')) throw new TypeError('CORS');
        return w2.fetch(url, init);
      },
    });
    const error = await direct.signIn((await challengeFrom(w2)).challenge).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).relaySuggested).toBe(true);
    expect(relayHits).not.toContain('https://auth.test/token');
  });
});
