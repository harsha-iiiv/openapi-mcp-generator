/**
 * oauth.js: browser OAuth for MCP servers, following the MCP authorization
 * spec (2025-11-25). Dependency-free; runs in browsers and Node 18+.
 *
 * Flow: 401 WWW-Authenticate resource_metadata (or the well-known protected
 * resource URLs) -> authorization server metadata (RFC 8414, then OpenID
 * Connect discovery) -> a client id (Client ID Metadata Document, else Dynamic
 * Client Registration, else one the user enters) -> PKCE S256 + state +
 * resource (RFC 8707) + scope -> sign-in popup -> callback page -> token
 * exchange -> refresh.
 *
 * Tokens live in sessionStorage per server URL (gone when the tab closes);
 * dynamic registrations in localStorage per issuer and redirect URI.
 * Part of openapi-mcp-generator's playground (MIT).
 */

import { McpHttpError, RELAY_TARGET_HEADER, bearerChallenge } from './mcp-client.js';

export const CALLBACK_MESSAGE_TYPE = 'mcp-oauth-callback';
export const CALLBACK_CHANNEL = 'mcp-playground-oauth';
const TOKEN_PREFIX = 'mcp-oauth-tokens:';
const CLIENT_PREFIX = 'mcp-oauth-client:';

/** An OAuth problem, with a plain-language message. */
export class OAuthError extends Error {
  constructor(message, { code, relaySuggested = false } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.relaySuggested = relaySuggested;
  }
}

// --- small helpers -------------------------------------------------------------------

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32) {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  return base64url(data);
}

/** PKCE verifier and S256 challenge (RFC 7636). */
export async function createPkce() {
  const verifier = randomString(32);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' };
}

/** The canonical URI of an MCP server (RFC 8707): no fragment, no trailing slash. */
export function canonicalResource(url) {
  const u = new URL(url);
  u.hash = '';
  let href = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
  if (u.pathname === '/' && !u.search) href = href.slice(0, -1);
  else if (href.endsWith('/') && !u.search) href = href.slice(0, -1);
  return href;
}

/** Whether a protected resource identifier covers the server URL (same origin, path prefix). */
export function resourceCovers(resource, serverUrl) {
  try {
    const r = new URL(resource);
    const s = new URL(serverUrl);
    if (r.origin.toLowerCase() !== s.origin.toLowerCase()) return false;
    const rp = r.pathname.endsWith('/') ? r.pathname : `${r.pathname}/`;
    const sp = s.pathname.endsWith('/') ? s.pathname : `${s.pathname}/`;
    return sp.startsWith(rp);
  } catch {
    return false;
  }
}

/** Well-known protected resource metadata URLs, in the order the spec requires. */
export function protectedResourceUrls(serverUrl) {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const urls = [];
  if (path) urls.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** Authorization server metadata URLs for an issuer, in the order the spec requires. */
export function authorizationServerUrls(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  if (path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server${path}`,
      `${u.origin}/.well-known/openid-configuration${path}`,
      `${u.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`,
  ];
}

/** Scope to request: the challenge's (authoritative), else the resource's scopes_supported. */
export function selectScope(challenge, resourceMetadata) {
  if (challenge?.scope) return challenge.scope;
  const supported = resourceMetadata?.scopes_supported;
  if (Array.isArray(supported) && supported.length) return supported.join(' ');
  return undefined;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function safeStorage(name) {
  try {
    const s = globalThis[name];
    if (s) {
      const probe = '__mcp_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    }
  } catch {
    // storage blocked (private mode, sandboxed frame)
  }
  return memoryStorage();
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- the popup ---------------------------------------------------------------------------

/**
 * Opens the authorization URL in a popup and resolves with { code, state, iss }
 * from the callback page. Messages are accepted only from this page's own
 * origin and for this state (postMessage, with a BroadcastChannel fallback for
 * providers whose pages sever window.opener).
 */
export function openAuthorizationPopup(
  url,
  { state, timeoutMs = 10 * 60 * 1000, signal, popup: opened } = {}
) {
  return new Promise((resolve, reject) => {
    // A window opened earlier, inside the click handler, is not blocked as a pop-up.
    let popup = opened && !opened.closed ? opened : null;
    if (popup) popup.location.href = url;
    else popup = globalThis.open(url, 'mcp-oauth', 'popup,width=520,height=720');
    if (!popup) {
      reject(
        new OAuthError('The sign-in window was blocked. Allow pop-ups for this site and retry.')
      );
      return;
    }
    let channel;
    const done = (fn, value) => {
      clearTimeout(timer);
      globalThis.removeEventListener('message', onMessage);
      channel?.close();
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const accept = (data) => {
      if (!data || data.type !== CALLBACK_MESSAGE_TYPE || data.state !== state) return false;
      if (data.error) {
        done(
          reject,
          new OAuthError(
            data.error === 'access_denied'
              ? 'Sign-in was cancelled.'
              : `Sign-in failed: ${data.error_description || data.error}`,
            { code: data.error }
          )
        );
      } else {
        done(resolve, { code: data.code, state: data.state, iss: data.iss });
      }
      try {
        popup.close();
      } catch {
        // cross-origin-opener-policy may forbid it
      }
      return true;
    };
    const onMessage = (event) => {
      if (event.origin !== globalThis.location.origin) return;
      accept(event.data);
    };
    const onAbort = () => {
      try {
        popup.close();
      } catch {
        // ignore
      }
      done(reject, new OAuthError('Sign-in was cancelled.', { code: 'cancelled' }));
    };
    globalThis.addEventListener('message', onMessage);
    if (typeof globalThis.BroadcastChannel === 'function') {
      channel = new BroadcastChannel(CALLBACK_CHANNEL);
      channel.onmessage = (event) => accept(event.data);
    }
    signal?.addEventListener?.('abort', onAbort);
    const timer = setTimeout(
      () => done(reject, new OAuthError('Sign-in timed out.', { code: 'timeout' })),
      timeoutMs
    );
  });
}

// --- the client ----------------------------------------------------------------------------

/**
 * OAuth for one MCP server URL.
 *
 *   const oauth = new OAuthClient({ serverUrl, redirectUri, clientMetadataUrl });
 *   await oauth.signIn(challenge);           // opens the popup
 *   new McpClient({ url: serverUrl, auth: oauth.provider() });
 *
 * Options: serverUrl, redirectUri, clientMetadataUrl (CIMD client id), clientName,
 * clientUri, clientId (manual), fetch, relayUrl + useRelay (send OAuth requests
 * through the relay; also used as a fallback for discovery and registration when
 * the browser blocks a direct request), sessionStorage, localStorage,
 * openAuthorization(url, { state }) => Promise<{ code, state, iss }>.
 */
export class OAuthClient {
  constructor(options = {}) {
    this.serverUrl = new URL(options.serverUrl).href;
    this.redirectUri = options.redirectUri;
    this.clientMetadataUrl = options.clientMetadataUrl || '';
    this.clientName = options.clientName || 'MCP Playground';
    this.clientUri = options.clientUri || '';
    this.manualClientId = options.clientId || '';
    this.relayUrl = options.relayUrl || '';
    this.useRelay = Boolean(options.useRelay && this.relayUrl);
    this.allowRelayFallback = options.allowRelayFallback !== false && Boolean(this.relayUrl);
    const f = options.fetch || globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
    this.session = options.sessionStorage || safeStorage('sessionStorage');
    this.local = options.localStorage || safeStorage('localStorage');
    this.openAuthorization =
      options.openAuthorization || ((url, opts) => openAuthorizationPopup(url, opts));
    this.discovery = null;
    this.refreshing = null;
  }

  get tokenKey() {
    return TOKEN_PREFIX + canonicalResource(this.serverUrl);
  }

  /** Stored tokens for this server, or null. */
  get tokens() {
    return readJson(this.session, this.tokenKey);
  }

  hasToken() {
    return Boolean(this.tokens?.access_token);
  }

  signOut() {
    this.session.removeItem(this.tokenKey);
  }

  /** A fetch for OAuth endpoints: direct, or through the relay. */
  async oauthFetch(url, init = {}, { fallback = true } = {}) {
    const viaRelay = (target) =>
      this.fetchImpl(this.relayUrl, {
        ...init,
        headers: { ...(init.headers || {}), [RELAY_TARGET_HEADER]: target },
      });
    if (this.useRelay) return viaRelay(url);
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (fallback && this.allowRelayFallback) return viaRelay(url);
      throw new OAuthError(
        `The browser could not reach ${new URL(url).origin}: it does not allow requests from this site.${
          this.relayUrl ? ' Turn on the relay and try again.' : ''
        }`,
        { relaySuggested: true }
      );
    }
  }

  /** GETs JSON metadata. Returns null on a non-2xx or non-JSON answer; throws when unreachable. */
  async getJson(url) {
    const res = await this.oauthFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      await res.body?.cancel?.().catch?.(() => {});
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Tries URLs in order; returns the first accepted document. Rethrows a network failure only if nothing was found. */
  async firstJson(urls, accept) {
    let networkError;
    for (const url of urls) {
      let metadata;
      try {
        metadata = await this.getJson(url);
      } catch (error) {
        networkError = networkError || error;
        continue;
      }
      if (metadata && typeof metadata === 'object' && accept(metadata)) return { url, metadata };
    }
    if (networkError) throw networkError;
    return null;
  }

  /** Protected resource metadata: the challenge's URL first, then the well-known URLs. */
  async discoverProtectedResource(challenge) {
    const candidates = [];
    if (challenge?.resourceMetadata) candidates.push(challenge.resourceMetadata);
    for (const url of protectedResourceUrls(this.serverUrl)) {
      if (!candidates.includes(url)) candidates.push(url);
    }
    const found = await this.firstJson(candidates, () => true);
    if (found?.metadata.resource && !resourceCovers(found.metadata.resource, this.serverUrl)) {
      throw new OAuthError(
        `The server's metadata names another resource (${found.metadata.resource}). Refusing to sign in.`
      );
    }
    return found;
  }

  async discoverAuthorizationServer(issuer) {
    const found = await this.firstJson(authorizationServerUrls(issuer), (m) =>
      Boolean(m.authorization_endpoint && m.token_endpoint)
    );
    const strip = (v) => String(v || '').replace(/\/+$/, '');
    if (found?.metadata.issuer && strip(found.metadata.issuer) !== strip(issuer)) {
      throw new OAuthError(
        `The authorization server says it is ${found.metadata.issuer}, not ${issuer}. Refusing to sign in.`
      );
    }
    return found;
  }

  /**
   * Runs discovery and picks how to identify this client. Does not register
   * or open anything. Returns the plan the sign-in will follow.
   */
  async discover(challenge) {
    const prm = await this.discoverProtectedResource(challenge);
    let issuer;
    let legacy = false;
    if (prm?.metadata?.authorization_servers?.length) {
      issuer = prm.metadata.authorization_servers[0];
    } else {
      // 2025-03-26 servers: no protected resource metadata, the server origin is the issuer.
      issuer = new URL(this.serverUrl).origin;
      legacy = true;
    }
    const as = await this.discoverAuthorizationServer(issuer);
    if (!as) {
      throw new OAuthError(
        prm
          ? `Could not read the authorization server metadata for ${issuer}.`
          : 'This server does not publish OAuth metadata, so the playground cannot sign in. Use a bearer token or headers instead.'
      );
    }
    const methods = as.metadata.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes('S256')) {
      throw new OAuthError(
        'The authorization server does not advertise PKCE (S256), which MCP requires. Refusing to sign in.'
      );
    }
    let registration = 'manual';
    if (this.manualClientId) registration = 'manual';
    else if (as.metadata.client_id_metadata_document_supported === true && this.clientMetadataUrl)
      registration = 'cimd';
    else if (as.metadata.registration_endpoint) registration = 'dcr';
    const resource = prm?.metadata?.resource
      ? prm.metadata.resource
      : canonicalResource(this.serverUrl);
    this.discovery = {
      challenge,
      resourceMetadataUrl: prm?.url,
      resourceMetadata: prm?.metadata,
      issuer,
      legacy,
      authorizationServerUrl: as.url,
      authorizationServer: as.metadata,
      authorizationEndpoint: as.metadata.authorization_endpoint,
      tokenEndpoint: as.metadata.token_endpoint,
      registration,
      needsClientId: registration === 'manual' && !this.manualClientId,
      resource,
      scope: selectScope(challenge, prm?.metadata),
    };
    return this.discovery;
  }

  clientKey(issuer) {
    return `${CLIENT_PREFIX}${issuer}|${this.redirectUri}`;
  }

  /** The client id (and secret, if a registration returned one) to use with this server. */
  async ensureClient(plan) {
    if (this.manualClientId) return { client_id: this.manualClientId };
    if (plan.registration === 'cimd') return { client_id: this.clientMetadataUrl };
    if (plan.registration !== 'dcr') {
      throw new OAuthError(
        'This authorization server needs a client ID. Enter one registered for this redirect URI.',
        { code: 'client_id_required' }
      );
    }
    const key = this.clientKey(plan.issuer);
    const saved = readJson(this.local, key);
    const now = Math.floor(Date.now() / 1000);
    if (
      saved?.client_id &&
      !(saved.client_secret_expires_at && saved.client_secret_expires_at < now)
    ) {
      return saved;
    }
    const body = {
      client_name: this.clientName,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    if (this.clientUri) body.client_uri = this.clientUri;
    if (plan.scope) body.scope = plan.scope;
    const res = await this.oauthFetch(plan.authorizationServer.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new OAuthError(
        `Client registration failed (HTTP ${res.status}): ${oauthErrorText(text)}`
      );
    }
    let client;
    try {
      client = JSON.parse(text);
    } catch {
      throw new OAuthError('Client registration returned something other than JSON.');
    }
    if (!client.client_id) throw new OAuthError('Client registration returned no client_id.');
    const record = {
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_secret_expires_at: client.client_secret_expires_at,
      token_endpoint_auth_method: client.token_endpoint_auth_method || 'none',
    };
    this.local.setItem(key, JSON.stringify(record));
    return record;
  }

  /** Builds the authorization URL. Returns { url, state, verifier, client }. */
  async prepareAuthorization(plan = this.discovery) {
    if (!plan) throw new OAuthError('Run discovery first.');
    const client = await this.ensureClient(plan);
    const pkce = await createPkce();
    const state = randomString(16);
    const url = new URL(plan.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('resource', plan.resource);
    if (plan.scope) url.searchParams.set('scope', plan.scope);
    return { url: url.href, state, verifier: pkce.verifier, client };
  }

  /** Full sign-in: discovery, client id, popup, token exchange. Resolves with the tokens. */
  async signIn(challenge, { signal, popup } = {}) {
    const plan = await this.discover(challenge ?? this.discovery?.challenge);
    const auth = await this.prepareAuthorization(plan);
    const callback = await this.openAuthorization(auth.url, { state: auth.state, signal, popup });
    if (!callback || callback.state !== auth.state) {
      throw new OAuthError('The sign-in response did not match this request (state mismatch).');
    }
    if (
      plan.authorizationServer.authorization_response_iss_parameter_supported &&
      callback.iss &&
      callback.iss.replace(/\/+$/, '') !==
        String(plan.authorizationServer.issuer || plan.issuer).replace(/\/+$/, '')
    ) {
      throw new OAuthError('The sign-in response came from a different authorization server.');
    }
    const tokens = await this.tokenRequest(plan, auth.client, {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: this.redirectUri,
      code_verifier: auth.verifier,
    });
    return tokens;
  }

  async tokenRequest(plan, client, params) {
    const form = new URLSearchParams({ ...params, resource: plan.resource });
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (client.client_secret && client.token_endpoint_auth_method === 'client_secret_basic') {
      headers.authorization = `Basic ${btoa(
        `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`
      )}`;
    } else {
      form.set('client_id', client.client_id);
      if (client.client_secret) form.set('client_secret', client.client_secret);
    }
    // A code or rotating refresh token is single-use: never resend it through the
    // relay after a direct attempt that may already have reached the server.
    const res = await this.oauthFetch(
      plan.tokenEndpoint,
      { method: 'POST', headers, body: form.toString() },
      { fallback: false }
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new OAuthError(
        `The token request failed (HTTP ${res.status}): ${oauthErrorText(text)}`,
        {
          code: safeJson(text)?.error,
        }
      );
    }
    const body = safeJson(text);
    if (!body || !body.access_token)
      throw new OAuthError('The token response had no access_token.');
    const previous = this.tokens;
    const record = {
      access_token: body.access_token,
      token_type: body.token_type || 'Bearer',
      refresh_token:
        body.refresh_token ||
        (params.grant_type === 'refresh_token' ? previous?.refresh_token : undefined),
      scope: body.scope || plan.scope,
      expires_at: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : undefined,
      client_id: client.client_id,
      issuer: plan.issuer,
      token_endpoint: plan.tokenEndpoint,
      resource: plan.resource,
      client_secret: client.client_secret,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    };
    this.session.setItem(this.tokenKey, JSON.stringify(record));
    return record;
  }

  /** Uses the refresh token. Resolves with new tokens, or null when there is none. */
  async refresh() {
    const tokens = this.tokens;
    if (!tokens?.refresh_token) return null;
    if (this.refreshing) return this.refreshing;
    const plan = {
      issuer: tokens.issuer,
      tokenEndpoint: tokens.token_endpoint,
      resource: tokens.resource,
      scope: tokens.scope,
    };
    const client = {
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      token_endpoint_auth_method: tokens.token_endpoint_auth_method,
    };
    this.refreshing = this.tokenRequest(plan, client, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    })
      .catch((error) => {
        // An invalid refresh token means signing in again.
        if (error instanceof OAuthError && error.code === 'invalid_grant') this.signOut();
        throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** The access token, refreshed first when it expires within a minute. */
  async getAccessToken() {
    const tokens = this.tokens;
    if (!tokens?.access_token) return undefined;
    if (tokens.expires_at && tokens.expires_at - Date.now() < 60_000 && tokens.refresh_token) {
      try {
        return (await this.refresh())?.access_token;
      } catch {
        return tokens.access_token;
      }
    }
    return tokens.access_token;
  }

  /**
   * An auth provider for McpClient: sends the access token and, on a 401,
   * refreshes once (an expired token) before giving up. A 401 that needs
   * a new sign-in surfaces as McpHttpError with .oauth set.
   */
  provider() {
    let refreshedFor = null;
    return {
      getAccessToken: () => this.getAccessToken(),
      hasToken: () => this.hasToken(),
      onUnauthorized: async ({ challenge }) => {
        if (challenge?.error === 'insufficient_scope') return false;
        const tokens = this.tokens;
        if (!tokens?.refresh_token || refreshedFor === tokens.access_token) return false;
        refreshedFor = tokens.access_token;
        try {
          return Boolean(await this.refresh());
        } catch {
          return false;
        }
      },
    };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function oauthErrorText(text) {
  const body = safeJson(text);
  if (body && (body.error_description || body.error)) {
    return body.error_description ? `${body.error}: ${body.error_description}` : body.error;
  }
  return String(text || '').slice(0, 200) || 'no details';
}

/** Opens an empty sign-in window synchronously (call it inside a click handler). */
export function openBlankPopup() {
  const popup = globalThis.open('', 'mcp-oauth', 'popup,width=520,height=720');
  try {
    if (popup) {
      popup.document.title = 'Signing in…';
      popup.document.body.style.font = '14px system-ui, sans-serif';
      popup.document.body.textContent = 'Finding the sign-in page…';
    }
  } catch {
    // a reused window on another origin
  }
  return popup;
}

/** Re-export for callers that only import this module. */
export { bearerChallenge, McpHttpError };
