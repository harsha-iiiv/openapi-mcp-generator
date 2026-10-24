/**
 * Live smoke test for the universal playground (not part of CI: it calls real
 * third-party MCP servers). Starts the relay locally, then drives the
 * playground's client (playground/mcp-client.js) and OAuth discovery
 * (playground/oauth.js) from Node.
 *
 *   node scripts/playground-smoke.mjs
 *
 * Needs Node 22.18 or later (the relay is imported as TypeScript source). It
 * never signs in: OAuth rows stop once the authorization endpoint is known.
 */
import { McpClient, McpHttpError } from '../playground/mcp-client.js';
import { OAuthClient } from '../playground/oauth.js';
import { startRelayServer } from '../relay/dev-server.mjs';

const ORIGIN = 'https://mcp.pidata.tech';
const REDIRECT = `${ORIGIN}/playground/oauth-callback.html`;
const CIMD = `${ORIGIN}/playground/oauth-client.json`;

const relay = await startRelayServer({ log: () => {} });
// Requests to the relay carry the page's Origin, as a browser would.
const browserFetch = (url, init = {}) => {
  const headers = new Headers(init.headers);
  if (String(url).startsWith(relay.url)) headers.set('origin', ORIGIN);
  return fetch(url, { ...init, headers });
};

const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
};

async function mcpRow(name, url, { viaRelay = false, transport = 'auto' } = {}) {
  const started = Date.now();
  const client = new McpClient({
    url,
    transport,
    hints: 'hosted',
    relayUrl: viaRelay ? relay.url : '',
    fetch: browserFetch,
    timeoutMs: 30_000,
    listen: false,
  });
  try {
    const init = await client.connect();
    const tools = await client.listTools();
    const caps = Object.keys(init.capabilities || {}).join(', ');
    await client.close();
    return {
      server: name,
      route: viaRelay ? 'relay' : 'direct',
      result: `OK ${client.transport}, ${init.protocolVersion}, ${tools.length} tools`,
      detail: `${init.serverInfo?.name ?? ''} ${init.serverInfo?.version ?? ''}; caps: ${caps}`,
      ms: Date.now() - started,
    };
  } catch (error) {
    await client.close().catch(() => {});
    return {
      server: name,
      route: viaRelay ? 'relay' : 'direct',
      result: error instanceof McpHttpError ? `HTTP ${error.status}` : error.name,
      detail: error.message + (error.oauth ? ' [oauth]' : ''),
      ms: Date.now() - started,
      error,
    };
  }
}

async function oauthRow(name, url, { viaRelay = false } = {}) {
  const started = Date.now();
  const first = await mcpRow(name, url, { viaRelay });
  if (!(first.error instanceof McpHttpError) || first.error.status !== 401) {
    return { ...first, result: `expected 401, got ${first.result}` };
  }
  const oauth = new OAuthClient({
    serverUrl: url,
    redirectUri: REDIRECT,
    clientMetadataUrl: CIMD,
    clientUri: `${ORIGIN}/playground/`,
    relayUrl: relay.url,
    useRelay: viaRelay,
    fetch: browserFetch,
    sessionStorage: memory(),
    localStorage: memory(),
  });
  try {
    const plan = await oauth.discover(first.error.challenge);
    let reach = '';
    try {
      const res = await fetch(plan.authorizationEndpoint, { redirect: 'manual' });
      reach = `GET authorize: ${res.status}`;
      await res.body?.cancel();
    } catch (error) {
      reach = `GET authorize failed: ${error.message}`;
    }
    return {
      server: name,
      route: viaRelay ? 'relay' : 'direct',
      result: `401 -> ${plan.registration.toUpperCase()} at ${new URL(plan.authorizationEndpoint).host}`,
      detail: `PRM ${plan.resourceMetadataUrl ? new URL(plan.resourceMetadataUrl).pathname : '(none, legacy)'}; issuer ${plan.issuer}; resource ${plan.resource}; scope ${plan.scope ?? '(none)'}; ${reach}`,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      server: name,
      route: viaRelay ? 'relay' : 'direct',
      result: `discovery failed`,
      detail: error.message,
      ms: Date.now() - started,
    };
  }
}

const rows = [];
rows.push(await mcpRow('DeepWiki', 'https://mcp.deepwiki.com/mcp'));
rows.push(await mcpRow('Context7', 'https://mcp.context7.com/mcp'));
rows.push(await mcpRow('Exa', 'https://mcp.exa.ai/mcp'));
rows.push(await mcpRow('GitMCP', 'https://gitmcp.io/facebook/react'));
rows.push(
  await mcpRow('Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', { viaRelay: true })
);
rows.push(await mcpRow('DeepWiki', 'https://mcp.deepwiki.com/mcp', { viaRelay: true }));
rows.push(await oauthRow('Sentry', 'https://mcp.sentry.dev/mcp', { viaRelay: true }));
rows.push(await oauthRow('Linear', 'https://mcp.linear.app/mcp'));
rows.push(await oauthRow('Notion', 'https://mcp.notion.com/mcp'));
rows.push(await oauthRow('Atlassian', 'https://mcp.atlassian.com/v1/mcp'));
rows.push(await oauthRow('Stripe', 'https://mcp.stripe.com', { viaRelay: true }));

console.log('| Server | Route | Result | Detail | ms |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.server} | ${r.route} | ${r.result} | ${String(r.detail).replace(/\|/g, '/')} | ${r.ms} |`
  );
}
await relay.close();
process.exit(0);
