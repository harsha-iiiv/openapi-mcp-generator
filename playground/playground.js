/**
 * MCP playground: connect to an MCP server from the browser, browse and call
 * its tools, resources and prompts, answer its requests (elicitation,
 * sampling, roots) and inspect every JSON-RPC message.
 *
 * Part of openapi-mcp-generator (MIT). No dependencies, no third-party requests,
 * and every server-supplied string is rendered as text, never as HTML. In a
 * generated server it talks only to its own origin; the hosted page
 * (https://mcp.pidata.tech/playground) can reach any remote server, sign in
 * with OAuth and route through the relay.
 */
import {
  McpClient,
  McpError,
  McpHttpError,
  McpNetworkError,
  McpCancelledError,
  validateHeaders,
} from './mcp-client.js';

const VERSION = '1.1.0';
const MAX_TRAFFIC = 400;
const MAX_LOGS = 500;
const JSON_RENDER_LIMIT = 400_000;
const HOSTED_CALLBACK = 'oauth-callback.html';
const HOSTED_CLIENT_DOC = 'oauth-client.json';

/** Public servers that work from a browser, offered as one-click examples on the hosted page. */
const EXAMPLES = [
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp' },
  { name: 'GitMCP (React)', url: 'https://gitmcp.io/facebook/react' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp' },
];

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder. Text children are always text nodes. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    const area = h('textarea', { class: 'mono', 'aria-hidden': 'true' });
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? label : 'Copy failed: select the text instead');
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clock(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function slug(name) {
  return (
    String(name || 'mcp-server')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp-server'
  );
}

/** Splits a generated description into prose and its "(Tags: a, b)" line. */
function parseDescription(text) {
  const tags = [];
  const prose = String(text || '')
    .replace(/\n?\(Tags: ([^)]*)\)\s*$/, (_, list) => {
      tags.push(
        ...list
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      );
      return '';
    })
    .trim();
  return { prose, tags };
}

function summaryOf(tool) {
  const { prose } = parseDescription(tool.description);
  const first = prose.split('\n')[0];
  return first.length > 110 ? `${first.slice(0, 107)}…` : first;
}

// --- JSON rendering (text nodes only) ------------------------------------------

function jsonView(value) {
  const pre = h('pre', { class: 'code' });
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length > JSON_RENDER_LIMIT) {
    pre.textContent = serialized;
    return pre;
  }
  const span = (cls, text) => h('span', { class: cls, text });
  const walk = (val, indent) => {
    if (val === null || typeof val === 'number' || typeof val === 'boolean') {
      pre.append(span('j-lit', String(val)));
    } else if (typeof val === 'string') {
      pre.append(span('j-str', JSON.stringify(val)));
    } else if (Array.isArray(val)) {
      if (val.length === 0) return pre.append(span('j-punc', '[]'));
      pre.append(span('j-punc', '['), '\n');
      val.forEach((item, i) => {
        pre.append(indent + '  ');
        walk(item, indent + '  ');
        pre.append(i < val.length - 1 ? span('j-punc', ',') : '', '\n');
      });
      pre.append(indent, span('j-punc', ']'));
    } else if (typeof val === 'object') {
      const keys = Object.keys(val);
      if (keys.length === 0) return pre.append(span('j-punc', '{}'));
      pre.append(span('j-punc', '{'), '\n');
      keys.forEach((key, i) => {
        pre.append(indent + '  ', span('j-key', JSON.stringify(key)), span('j-punc', ': '));
        walk(val[key], indent + '  ');
        pre.append(i < keys.length - 1 ? span('j-punc', ',') : '', '\n');
      });
      pre.append(indent, span('j-punc', '}'));
    } else {
      pre.append(String(val));
    }
  };
  walk(value, '');
  return pre;
}

function textView(text) {
  return h('pre', { class: 'code', text });
}

/** Renders a text block: pretty JSON when it is JSON, with an optional first-line caption. */
function richText(text) {
  const trimmed = String(text).trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      return [jsonView(JSON.parse(trimmed))];
    } catch {
      // not JSON
    }
  }
  const match = /^([^\n[{]{1,160}?)\s*([[{][\s\S]*)$/.exec(trimmed);
  if (match) {
    try {
      return [
        h('p', { class: 'block-caption', text: match[1].trim() }),
        jsonView(JSON.parse(match[2])),
      ];
    } catch {
      // not JSON
    }
  }
  return [textView(text)];
}

// --- state -----------------------------------------------------------------------

const state = {
  config: null,
  client: null,
  view: 'tools',
  tools: [],
  selected: null,
  fields: [],
  rawMode: false,
  running: null, // { controller } while a tool call runs
  argsByTool: new Map(),
  resultsByTool: new Map(),
  traffic: [],
  resources: [],
  templates: [],
  selectedResource: null,
  subscriptions: new Set(),
  prompts: [],
  selectedPrompt: null,
  logs: [],
  roots: [],
  oauth: null,
  oauthModule: null,
  serverRequests: [],
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

function hosted() {
  return Boolean(state.config?.hosted);
}

function endpointUrl() {
  const raw = hosted() ? $('url').value.trim() : state.config.endpoint;
  try {
    return new URL(raw || '/mcp', location.href).href;
  } catch {
    return raw;
  }
}

function transportValue() {
  return hosted() ? $('transport').value : state.config.transport;
}

function transportLabel(transport) {
  return transport === 'sse' ? 'HTTP+SSE' : 'Streamable HTTP';
}

function authMode() {
  if (!hosted()) return 'bearer';
  return document.querySelector('input[name="auth"]:checked')?.value || 'none';
}

function setAuthMode(mode) {
  const input = document.querySelector(`input[name="auth"][value="${mode}"]`);
  if (input) input.checked = true;
  syncAuthFields();
}

function relayUrl() {
  if (!hosted() || !state.config.relayUrl || !$('use-relay').checked) return '';
  return state.config.relayUrl;
}

function storageKey(kind = 'token') {
  return `mcp-playground-${kind}:${endpointUrl()}`;
}

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
}

// --- connection form ----------------------------------------------------------------

async function loadConfig() {
  let config = {};
  try {
    const res = await fetch('playground.config.json', { cache: 'no-store' });
    if (res.ok) config = await res.json();
  } catch {
    // served without a config: assume the defaults below
  }
  config = {
    transport: 'streamable-http',
    endpoint: '/mcp',
    inboundAuth: 'unknown',
    hosted: false,
    relayUrl: '',
    ...config,
  };
  if (config.hosted) {
    const params = new URLSearchParams(location.search);
    config.endpoint = params.get('url') || localStorage.getItem('mcp-playground-url') || '';
    const transport = params.get('transport');
    config.transport = ['sse', 'streamable-http'].includes(transport) ? transport : 'auto';
    config.useRelay = params.get('relay') === '1';
  }
  return config;
}

function headerRow(
  container,
  { name = '', value = '' } = {},
  { valueLabel = 'Value', secret = true } = {}
) {
  const nameInput = h('input', {
    type: 'text',
    class: 'mono-input',
    placeholder: container.id === 'root-rows' ? 'file:///path/to/project' : 'x-api-key',
    'aria-label': container.id === 'root-rows' ? 'Root URI' : 'Header name',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  nameInput.value = name;
  const valueInput = h('input', {
    type: secret ? 'password' : 'text',
    placeholder: valueLabel,
    'aria-label': valueLabel,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  valueInput.value = value;
  const row = h(
    'div',
    { class: 'header-row' },
    nameInput,
    valueInput,
    h('button', {
      type: 'button',
      class: 'btn ghost small icon',
      'aria-label': 'Remove',
      title: 'Remove',
      text: '×',
      onclick: () => {
        row.remove();
        if (container.id === 'header-rows') syncAuthFields();
      },
    })
  );
  container.append(row);
  return nameInput;
}

function rowsOf(container) {
  return [...container.querySelectorAll('.header-row')]
    .map((row) => {
      const [name, value] = row.querySelectorAll('input');
      return [name.value.trim(), value.value];
    })
    .filter(([name, value]) => name || value);
}

function syncAuthFields() {
  if (!hosted()) {
    $('headers-field').hidden = false;
    const noRows = $('header-rows').children.length === 0;
    $('headers-label').hidden = noRows;
    $('remember-row').hidden = $('token-field').hidden && noRows;
    return;
  }
  const mode = authMode();
  $('token-field').hidden = mode !== 'bearer';
  $('headers-field').hidden = mode !== 'headers';
  $('headers-label').hidden = false;
  $('oauth-field').hidden = mode !== 'oauth';
  $('remember-row').hidden = mode === 'none' || mode === 'oauth';
  if (mode === 'headers' && $('header-rows').children.length === 0) headerRow($('header-rows'));
  renderOAuthStatus();
}

function setupConnectForm() {
  const { config } = state;
  if (config.hosted) {
    $('url-field').hidden = false;
    $('transport-field').hidden = false;
    $('endpoint-row').hidden = true;
    $('auth-field').hidden = false;
    $('url').value = config.endpoint;
    $('transport').value = config.transport;
    $('connect-title').textContent = 'Try any MCP server from your browser.';
    $('connect-lede').textContent =
      'Paste a remote server URL. The playground lists its tools, resources and prompts, signs in with OAuth when the server asks, and shows exactly what goes over the wire. Nothing to install.';
    $('token').placeholder = 'Paste an access token';
    $('token-hint').textContent = 'sent as Authorization: Bearer';
    $('connect-fine').replaceChildren(
      'Open source, part of ',
      h('a', {
        href: 'https://github.com/harsha-iiiv/openapi-mcp-generator',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'openapi-mcp-generator',
      }),
      '. Credentials stay in this tab and go only to the server (or the relay, if you turn it on).'
    );
    const examples = $('examples');
    examples.hidden = false;
    for (const example of EXAMPLES) {
      examples.append(
        h('button', {
          type: 'button',
          class: 'example',
          text: example.name,
          onclick: () => {
            $('url').value = example.url;
            setAuthMode('none');
            connect();
          },
        })
      );
    }
    if (config.relayUrl) {
      $('relay-field').hidden = false;
      try {
        $('relay-host').textContent = new URL(config.relayUrl).host;
      } catch {
        $('relay-host').textContent = config.relayUrl;
      }
      $('use-relay').checked = Boolean(config.useRelay);
    }
    $('redirect-uri').textContent = new URL(HOSTED_CALLBACK, location.href).href;
    for (const input of document.querySelectorAll('input[name="auth"]')) {
      input.addEventListener('change', syncAuthFields);
    }
    $('url').addEventListener('change', () => {
      state.oauth = null;
      renderOAuthStatus();
    });
    $('btn-signin').addEventListener('click', async () => {
      if (await signIn()) connect();
    });
    $('btn-signout').addEventListener('click', () => {
      state.oauth?.signOut();
      renderOAuthStatus();
    });
  } else {
    $('endpoint').textContent = endpointUrl();
    $('transport-name').textContent = transportLabel(config.transport);
    if (config.inboundAuth === 'none') {
      $('token-field').hidden = true;
    } else if (config.inboundAuth === 'bearer') {
      $('token-hint').textContent = 'required by this server';
    }
  }
  const remembered = sessionStorage.getItem(storageKey());
  if (remembered) {
    $('token').value = remembered;
    $('remember').checked = true;
  }
  try {
    const savedHeaders = JSON.parse(sessionStorage.getItem(storageKey('headers')) || '[]');
    for (const [name, value] of savedHeaders) headerRow($('header-rows'), { name, value });
    if (savedHeaders.length) {
      $('remember').checked = true;
      if (config.hosted && !remembered) setAuthMode('headers');
    }
  } catch {
    // ignore a corrupt entry
  }
  if (config.hosted && remembered) setAuthMode('bearer');
  try {
    state.roots = JSON.parse(localStorage.getItem('mcp-playground-roots') || '[]');
  } catch {
    state.roots = [];
  }
  syncAuthFields();
  $('btn-add-header').addEventListener('click', () => {
    headerRow($('header-rows')).focus();
    syncAuthFields();
  });
  $('btn-reveal').addEventListener('click', () => {
    const input = $('token');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btn-reveal').textContent = show ? 'Hide' : 'Show';
    $('btn-reveal').setAttribute('aria-pressed', String(show));
  });
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
}

// --- OAuth (hosted only) -----------------------------------------------------------

async function oauthFor(url) {
  if (!state.oauthModule) state.oauthModule = await import('./oauth.js');
  const canonical = url;
  if (!state.oauth || state.oauth.serverUrl !== new URL(canonical).href) {
    state.oauth = new state.oauthModule.OAuthClient({
      serverUrl: canonical,
      redirectUri: new URL(HOSTED_CALLBACK, location.href).href,
      clientMetadataUrl:
        state.config.oauthClientMetadataUrl || new URL(HOSTED_CLIENT_DOC, location.href).href,
      clientUri: new URL('./', location.href).href,
      clientName: 'MCP Playground',
      clientId: $('client-id').value.trim(),
      relayUrl: state.config.relayUrl || '',
      useRelay: Boolean(relayUrl()),
    });
  }
  state.oauth.manualClientId = $('client-id').value.trim();
  state.oauth.useRelay = Boolean(relayUrl());
  return state.oauth;
}

function renderOAuthStatus() {
  if (!hosted()) return;
  const oauth = state.oauth;
  const tokens = oauth?.tokens;
  const signedIn = Boolean(tokens?.access_token);
  $('btn-signout').hidden = !signedIn;
  $('btn-signin').textContent = signedIn ? 'Sign in again' : 'Sign in';
  $('oauth-status').textContent = signedIn
    ? `Signed in${tokens.issuer ? ` with ${new URL(tokens.issuer).host}` : ''}${
        tokens.scope ? ` (scope: ${tokens.scope})` : ''
      }. The token stays in this tab.`
    : 'Sign in with the server’s own login. The playground identifies itself, uses PKCE and keeps the token in this tab only.';
}

/** Runs the OAuth sign-in. Must be called from a click so the popup is allowed. */
async function signIn(challenge) {
  const url = endpointUrl();
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
    showConnectError(new Error('Enter the server URL first (https://…).'));
    return false;
  }
  const popup = (state.oauthModule?.openBlankPopup || openBlank)();
  setAuthMode('oauth');
  $('btn-signin').disabled = true;
  setStatus('connecting', 'Signing in…');
  try {
    const oauth = await oauthFor(url);
    // Without a 401 in hand, ask the server once so its WWW-Authenticate challenge
    // (resource metadata URL, scope) guides discovery.
    const hint = challenge || (await probeChallenge(url)) || state.lastChallenge;
    await oauth.signIn(hint, { popup });
    renderOAuthStatus();
    setStatus('idle', 'Signed in');
    return true;
  } catch (error) {
    try {
      popup?.close();
    } catch {
      // ignore
    }
    setStatus('error', 'Not connected');
    if (error.code === 'client_id_required') $('oauth-advanced').open = true;
    showConnectError(error);
    return false;
  } finally {
    $('btn-signin').disabled = false;
  }
}

async function probeChallenge(url) {
  const probe = new McpClient({
    url,
    transport: transportValue(),
    hints: 'hosted',
    relayUrl: relayUrl(),
    listen: false,
    timeoutMs: 20_000,
    onTraffic: addTraffic,
  });
  try {
    await probe.connect();
    await probe.close();
    return undefined;
  } catch (error) {
    return error instanceof McpHttpError ? error.challenge : undefined;
  }
}

function openBlank() {
  return window.open('', 'mcp-oauth', 'popup,width=520,height=720');
}

// --- connecting ------------------------------------------------------------------------

function showConnectError(error) {
  const box = $('connect-error');
  $('connect-error-text').textContent = describeError(error);
  const actions = $('connect-error-actions');
  actions.replaceChildren();
  if (hosted() && error instanceof McpHttpError && error.oauth) {
    state.lastChallenge = error.challenge;
    actions.append(
      h('button', {
        type: 'button',
        class: 'btn primary small',
        text: 'Sign in',
        onclick: async () => {
          if (await signIn(error.challenge)) connect();
        },
      })
    );
  }
  const relayHelps =
    hosted() &&
    state.config.relayUrl &&
    !relayUrl() &&
    (error instanceof McpNetworkError || error?.relaySuggested);
  if (relayHelps) {
    actions.append(
      h('button', {
        type: 'button',
        class: 'btn ghost small',
        text: 'Retry through the relay',
        onclick: () => {
          $('use-relay').checked = true;
          if (state.oauth) state.oauth.useRelay = true;
          connect();
        },
      })
    );
  }
  actions.hidden = actions.children.length === 0;
  box.hidden = false;
}

function updateShareUrl() {
  if (!hosted()) return;
  const params = new URLSearchParams(location.search);
  params.set('url', $('url').value.trim());
  const transport = transportValue();
  if (transport !== 'auto') params.set('transport', transport);
  else params.delete('transport');
  if (relayUrl()) params.set('relay', '1');
  else params.delete('relay');
  history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
}

function shareLink() {
  const params = new URLSearchParams();
  params.set('url', $('url').value.trim());
  const transport = transportValue();
  if (transport !== 'auto') params.set('transport', transport);
  if (relayUrl()) params.set('relay', '1');
  return `${location.origin}${location.pathname}?${params}`;
}

async function connect() {
  const url = endpointUrl();
  const transport = transportValue();
  $('connect-error').hidden = true;
  const mode = authMode();

  if (hosted()) {
    if (!/^https?:\/\//i.test($('url').value.trim())) {
      showConnectError(
        new Error('Enter the full server URL, starting with https:// (or http://localhost).')
      );
      return;
    }
    localStorage.setItem('mcp-playground-url', $('url').value.trim());
    updateShareUrl();
  }

  let headers = {};
  if (!hosted() || mode === 'headers') {
    try {
      headers = validateHeaders(rowsOf($('header-rows')));
    } catch (error) {
      showConnectError(error);
      return;
    }
  }
  const token =
    (!hosted() && !$('token-field').hidden) || mode === 'bearer' ? $('token').value.trim() : '';
  if ($('remember').checked && token) sessionStorage.setItem(storageKey(), token);
  else sessionStorage.removeItem(storageKey());
  const headerRows = rowsOf($('header-rows'));
  if ($('remember').checked && headerRows.length && (!hosted() || mode === 'headers')) {
    sessionStorage.setItem(storageKey('headers'), JSON.stringify(headerRows));
  } else sessionStorage.removeItem(storageKey('headers'));

  let auth = null;
  if (hosted() && mode === 'oauth') {
    const oauth = await oauthFor(url);
    auth = oauth.provider();
  }

  $('btn-connect').disabled = true;
  setStatus('connecting', relayUrl() ? 'Connecting through the relay…' : 'Connecting…');
  const client = new McpClient({
    url,
    transport,
    token,
    headers,
    auth,
    relayUrl: relayUrl(),
    hints: hosted() ? 'hosted' : 'generated',
    roots: state.roots,
    onServerRequest: handleServerRequest,
    onNotification: handleNotification,
    clientInfo: { name: 'mcp-playground', title: 'MCP Playground', version: VERSION },
    onTraffic: addTraffic,
  });
  try {
    await client.connect();
    state.client = client;
    await loadServerLists();
    showWorkspace();
  } catch (error) {
    await client.close().catch(() => {});
    if (state.client === client) state.client = null;
    setStatus('error', 'Not connected');
    showConnectError(error);
  } finally {
    $('btn-connect').disabled = false;
  }
}

/** Loads tools, resources and prompts for whatever the server declares. */
async function loadServerLists() {
  const { client } = state;
  const caps = client.serverCapabilities || {};
  const tasks = [];
  // Tools are listed even when undeclared: some servers omit the capability.
  tasks.push(
    client.listTools().then(
      (tools) => (state.tools = tools),
      (error) => {
        if (caps.tools) throw error;
        state.tools = [];
      }
    )
  );
  state.resources = [];
  state.templates = [];
  state.prompts = [];
  if (caps.resources) {
    tasks.push(
      client
        .listResources()
        .then((r) => (state.resources = r))
        .catch(() => {})
    );
    tasks.push(
      client
        .listResourceTemplates()
        .then((t) => (state.templates = t))
        .catch(() => {})
    );
  }
  if (caps.prompts) {
    tasks.push(
      client
        .listPrompts()
        .then((p) => (state.prompts = p))
        .catch(() => {})
    );
  }
  await Promise.all(tasks);
}

function describeError(error) {
  if (error instanceof McpHttpError) return error.hint || error.message;
  if (error instanceof McpError) return `${error.message} (JSON-RPC ${error.code})`;
  return error && error.message ? error.message : String(error);
}

async function disconnect() {
  state.running?.controller.abort();
  closeServerRequests();
  await state.client?.close().catch(() => {});
  state.client = null;
  state.tools = [];
  state.selected = null;
  state.resources = [];
  state.templates = [];
  state.prompts = [];
  state.subscriptions.clear();
  state.selectedResource = null;
  state.selectedPrompt = null;
  state.argsByTool.clear();
  state.resultsByTool.clear();
  $('workspace').hidden = true;
  $('connect').hidden = false;
  $('btn-clients').hidden = true;
  $('btn-disconnect').hidden = true;
  $('btn-share').hidden = true;
  $('server-name').textContent = 'MCP playground';
  $('server-meta').textContent = '';
  document.title = 'MCP playground';
  setStatus('idle', 'Not connected');
}

function showWorkspace() {
  const { client } = state;
  const info = client.serverInfo || {};
  const name = info.title || info.name || 'MCP server';
  $('server-name').textContent = name;
  $('server-meta').textContent = [
    info.version && `v${info.version}`,
    client.protocolVersion,
    transportLabel(client.transport),
    client.relayUrl && 'via relay',
  ]
    .filter(Boolean)
    .join(' · ');
  document.title = `${name} · MCP playground`;
  setStatus('connected', 'Connected');
  $('connect').hidden = true;
  $('workspace').hidden = false;
  $('btn-clients').hidden = false;
  $('btn-disconnect').hidden = false;
  $('btn-share').hidden = !hosted();
  $('search').value = '';
  renderViewTabs();
  renderToolList();
  renderResourceList();
  renderPromptList();
  renderLogNote();
  renderRoots();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const initial = state.tools.find((t) => t.name === fromHash) || state.tools[0];
  if (initial) selectTool(initial, { focus: false });
  else {
    $('empty').hidden = false;
    $('tool').hidden = true;
    $('empty').firstElementChild.textContent = 'This server exposes no tools.';
  }
  const caps = client.serverCapabilities || {};
  if (!state.tools.length && (caps.resources || caps.prompts)) {
    selectView(caps.resources ? 'resources' : 'prompts');
  } else selectView('tools');
}

// --- views ---------------------------------------------------------------------------------

const VIEWS = ['tools', 'resources', 'prompts', 'logs', 'raw'];

function renderViewTabs() {
  const caps = state.client?.serverCapabilities || {};
  $('vt-resources').hidden = !caps.resources;
  $('vt-prompts').hidden = !caps.prompts;
  $('vt-tools').hidden =
    !caps.tools && state.tools.length === 0 && Boolean(caps.resources || caps.prompts);
  $('n-tools').textContent = state.tools.length ? String(state.tools.length) : '';
  $('n-resources').textContent =
    state.resources.length + state.templates.length
      ? String(state.resources.length + state.templates.length)
      : '';
  $('n-prompts').textContent = state.prompts.length ? String(state.prompts.length) : '';
  $('n-logs').textContent = state.logs.length ? String(state.logs.length) : '';
}

function selectView(view, { focus = false } = {}) {
  if (!VIEWS.includes(view)) view = 'tools';
  state.view = view;
  for (const name of VIEWS) {
    const tab = $(`vt-${name}`);
    const selected = name === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`view-${name}`).hidden = !selected;
  }
  if (focus) $(`vt-${view}`).focus();
}

// --- tool list --------------------------------------------------------------------

function filteredTools() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) return state.tools;
  return state.tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(q) ||
      String(tool.description || '')
        .toLowerCase()
        .includes(q)
  );
}

function renderToolList() {
  const list = $('tool-list');
  list.replaceChildren();
  const tools = filteredTools();
  const total = state.tools.length;
  $('tool-count').textContent =
    tools.length === total
      ? `${total} tool${total === 1 ? '' : 's'}`
      : `${tools.length} of ${total} tools`;
  const groups = new Map();
  for (const tool of tools) {
    const tag = parseDescription(tool.description).tags[0] || '';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(tool);
  }
  const showGroups = groups.size > 1 || (groups.size === 1 && !groups.has(''));
  for (const [tag, items] of groups) {
    if (showGroups) list.append(h('div', { class: 'group', text: tag || 'Other' }));
    for (const tool of items) {
      list.append(
        h(
          'button',
          {
            type: 'button',
            class: 'tool-item',
            role: 'option',
            'aria-selected': String(state.selected?.name === tool.name),
            'data-name': tool.name,
            onclick: () => selectTool(tool),
          },
          h('span', { class: 'tool-item-name', text: tool.name }),
          summaryOf(tool) ? h('span', { class: 'tool-item-desc', text: summaryOf(tool) }) : null
        )
      );
    }
  }
  if (tools.length === 0) list.append(h('p', { class: 'count', text: 'No tools match.' }));
}

function moveSelection(step) {
  const tools = filteredTools();
  if (tools.length === 0) return;
  const index = tools.findIndex((t) => t.name === state.selected?.name);
  const next = tools[Math.min(tools.length - 1, Math.max(0, index + step))];
  selectTool(next, { focus: false });
  $('tool-list')
    .querySelector(`.tool-item[data-name="${CSS.escape(next.name)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

// --- schemas -------------------------------------------------------------------------------

/** Resolves local $ref pointers (#/$defs/..., #/definitions/...) against the root schema. */
function deref(schema, root, depth = 0) {
  if (!schema || typeof schema !== 'object') return {};
  if (depth > 10) return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#')) {
    const path = schema.$ref
      .slice(1)
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = root;
    for (const key of path) target = target && typeof target === 'object' ? target[key] : undefined;
    const { $ref, ...rest } = schema;
    return deref({ ...(target || {}), ...rest }, root, depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((s) => deref(s, root, depth + 1));
    const { allOf, ...rest } = schema;
    const merged = { ...rest };
    for (const part of parts) {
      for (const [key, value] of Object.entries(part)) {
        if (key === 'properties') merged.properties = { ...(merged.properties || {}), ...value };
        else if (key === 'required')
          merged.required = [...new Set([...(merged.required || []), ...value])];
        else if (!(key in merged)) merged[key] = value;
      }
    }
    return merged;
  }
  return schema;
}

/** Normalizes a property schema: resolves refs and simplifies nullable or const-only unions. */
function normalizeProp(prop, root) {
  const schema = deref(prop, root);
  const list = schema.oneOf || schema.anyOf;
  if (!Array.isArray(list) || schema.type) return schema;
  const variants = list.map((v) => deref(v, root));
  const nonNull = variants.filter((v) => !(v.type === 'null' || v.const === null));
  const { oneOf, anyOf, ...rest } = schema;
  if (nonNull.length === 1)
    return { ...nonNull[0], ...rest, nullable: nonNull.length < variants.length };
  if (nonNull.length && nonNull.every((v) => 'const' in v && typeof v.const !== 'object')) {
    return { ...rest, enum: nonNull.map((v) => v.const), enumNames: nonNull.map((v) => v.title) };
  }
  return { ...rest, variants: nonNull };
}

function variantLabel(variant, index) {
  if (variant.title) return variant.title;
  const type = primaryType(variant);
  if (type === 'object' && variant.properties) {
    const keys = Object.keys(variant.properties).slice(0, 3).join(', ');
    return `object { ${keys}${Object.keys(variant.properties).length > 3 ? ', …' : ''} }`;
  }
  return type || `option ${index + 1}`;
}

// --- tool detail and form --------------------------------------------------------------

function selectTool(tool, { focus = true } = {}) {
  if (state.selected && !state.rawMode) {
    const { args } = collectArgs({ lenient: true });
    state.argsByTool.set(state.selected.name, args);
  } else if (state.selected && state.rawMode) {
    try {
      state.argsByTool.set(state.selected.name, JSON.parse($('raw-args').value || '{}'));
    } catch {
      // keep the previous value
    }
  }
  state.selected = tool;
  state.rawMode = false;
  history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}#${encodeURIComponent(tool.name)}`
  );
  for (const item of $('tool-list').querySelectorAll('.tool-item')) {
    item.setAttribute('aria-selected', String(item.dataset.name === tool.name));
  }
  const { prose, tags } = parseDescription(tool.description);
  $('empty').hidden = true;
  $('tool').hidden = false;
  $('tool-name').textContent = tool.title && tool.title !== tool.name ? `${tool.name}` : tool.name;
  $('tool-desc').textContent = prose;
  const tagBox = $('tool-tags');
  tagBox.replaceChildren(...tags.map((t) => h('span', { class: 'chip', text: t })));
  if (tool.title && tool.title !== tool.name)
    tagBox.prepend(h('span', { class: 'chip', text: tool.title }));
  const ann = tool.annotations || {};
  if (ann.readOnlyHint) tagBox.append(h('span', { class: 'chip', text: 'read-only' }));
  if (ann.destructiveHint) tagBox.append(h('span', { class: 'chip', text: 'destructive' }));
  $('btn-raw').setAttribute('aria-pressed', 'false');
  $('raw').hidden = true;
  $('fields').hidden = false;
  $('form-error').textContent = '';
  buildFields(tool.inputSchema || {}, state.argsByTool.get(tool.name));
  const previous = state.resultsByTool.get(tool.name);
  const runningHere = state.running && state.running.tool === tool.name;
  $('btn-run').disabled = Boolean(state.running);
  $('btn-cancel').hidden = !runningHere;
  if (runningHere) {
    $('result-output').replaceChildren();
    showRunning(tool.name);
  } else if (previous) renderResult(previous);
  else $('result').hidden = true;
  if (focus) $('fields').querySelector('input, select, textarea')?.focus();
}

function primaryType(schema) {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type) return type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return undefined;
}

function fieldKind(schema) {
  if (!schema || typeof schema !== 'object') return 'json';
  if (Array.isArray(schema.variants)) return 'union';
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v !== 'object')
  ) {
    return 'enum';
  }
  const type = primaryType(schema);
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') return type;
  if (type === 'string') return 'string';
  if (type === 'array') {
    const items = schema.items || {};
    const itemType = primaryType(items);
    if (['string', 'number', 'integer', 'boolean'].includes(itemType) || Array.isArray(items.enum))
      return 'list';
  }
  return 'json';
}

function typeLabel(schema, kind) {
  if (kind === 'list') return `${primaryType(schema.items || {}) || 'value'}[]`;
  if (kind === 'enum') return 'enum';
  if (kind === 'union') return 'one of';
  const type = primaryType(schema) || 'any';
  const base = schema.format ? `${type} · ${schema.format}` : type;
  return schema.nullable ? `${base} | null` : base;
}

/** A plausible example value for a schema, used to seed JSON fields. */
function exampleFor(schema, depth = 0, root = schema) {
  schema = deref(schema, root);
  if (!schema || typeof schema !== 'object' || depth > 5) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const variant = schema.variants?.[0] || schema.oneOf?.[0] || schema.anyOf?.[0];
  if (variant) return exampleFor(variant, depth + 1, root);
  switch (primaryType(schema)) {
    case 'object': {
      const out = {};
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      const keys = Object.keys(props);
      const chosen = required.size ? keys.filter((k) => required.has(k)) : keys.slice(0, 8);
      for (const key of chosen) out[key] = exampleFor(props[key], depth + 1, root);
      return out;
    }
    case 'array':
      return [exampleFor(schema.items || {}, depth + 1, root)].filter((v) => v !== null);
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    case 'string':
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
      return '';
    default:
      return null;
  }
}

function buildFields(rootSchema, saved) {
  const box = $('fields');
  box.replaceChildren();
  state.fields = [];
  const schema = deref(rootSchema, rootSchema);
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const names = Object.keys(props).sort(
    (a, b) => Number(required.has(b)) - Number(required.has(a))
  );
  if (names.length === 0) {
    box.append(h('p', { class: 'no-args', text: 'This tool takes no arguments.' }));
    return;
  }
  names.forEach((name, index) => {
    const prop = normalizeProp(props[name] || {}, rootSchema);
    const kind = fieldKind(prop);
    const id = `f-${index}`;
    const isRequired = required.has(name);
    let input;
    let picker = null;
    if (kind === 'enum' || kind === 'boolean') {
      const options = kind === 'boolean' ? [true, false] : prop.enum;
      input = h(
        'select',
        { id },
        h('option', { value: '', text: isRequired ? 'Choose…' : '(not set)' }),
        options.map((v, i) =>
          h('option', {
            value: String(v),
            text: prop.enumNames?.[i] ? `${prop.enumNames[i]} (${v})` : String(v),
          })
        )
      );
    } else if (
      kind === 'list' ||
      kind === 'json' ||
      kind === 'union' ||
      (kind === 'string' && (prop.maxLength || 0) > 200)
    ) {
      input = h('textarea', {
        id,
        rows: kind === 'json' || kind === 'union' ? 6 : 3,
        spellcheck: 'false',
        placeholder:
          kind === 'list' ? 'One value per line' : kind === 'string' ? undefined : 'JSON',
      });
      if (kind === 'union') {
        picker = h(
          'select',
          {
            class: 'variant-picker',
            'aria-label': `${name}: choose a shape`,
            onchange: () => {
              const variant = prop.variants[Number(picker.value)];
              if (variant) {
                input.value = JSON.stringify(exampleFor(variant, 0, rootSchema), null, 2);
                input.focus();
              }
            },
          },
          h('option', { value: '', text: 'Insert a shape…' }),
          prop.variants.map((v, i) => h('option', { value: String(i), text: variantLabel(v, i) }))
        );
      }
    } else {
      const type =
        kind === 'integer' || kind === 'number'
          ? 'number'
          : prop.format === 'date'
            ? 'date'
            : prop.format === 'password'
              ? 'password'
              : 'text';
      input = h('input', {
        id,
        type,
        step: kind === 'integer' ? '1' : kind === 'number' ? 'any' : undefined,
        min: prop.minimum,
        max: prop.maximum,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder:
          prop.example !== undefined
            ? String(prop.example)
            : prop.format === 'date-time'
              ? '2026-01-01T00:00:00Z'
              : undefined,
      });
    }
    const errorEl = h('p', { class: 'param-error', id: `${id}-error` });
    input.setAttribute('aria-describedby', `${id}-error`);
    const tools =
      kind === 'json' || kind === 'union'
        ? h(
            'div',
            { class: 'param-tools' },
            picker,
            kind === 'json'
              ? h('button', {
                  type: 'button',
                  class: 'btn ghost small',
                  text: 'Insert example',
                  onclick: () => {
                    input.value = JSON.stringify(exampleFor(prop, 0, rootSchema), null, 2);
                    input.focus();
                  },
                })
              : null
          )
        : null;
    box.append(
      h(
        'div',
        { class: 'field' },
        h(
          'label',
          { for: id, class: 'param-label' },
          h('span', { class: 'param-name', text: name }),
          isRequired ? h('span', { class: 'param-req', text: 'required' }) : null,
          h('span', { class: 'param-type', text: typeLabel(prop, kind) })
        ),
        prop.description ? h('p', { class: 'param-desc', text: prop.description }) : null,
        input,
        tools,
        errorEl
      )
    );
    const field = { name, prop, kind, required: isRequired, input, errorEl };
    state.fields.push(field);
    const initial = saved && name in saved ? saved[name] : prop.default;
    if (initial !== undefined) setFieldValue(field, initial);
  });
}

function setFieldValue(field, value) {
  if (value === undefined || value === null) return;
  if (field.kind === 'list')
    field.input.value = Array.isArray(value) ? value.join('\n') : String(value);
  else if (field.kind === 'json' || field.kind === 'union')
    field.input.value = JSON.stringify(value, null, 2);
  else field.input.value = String(value);
}

function coerce(raw, kind, schema) {
  if (kind === 'integer' || kind === 'number') {
    const n = Number(raw);
    if (raw === '' || Number.isNaN(n)) throw new Error('Enter a number.');
    if (kind === 'integer' && !Number.isInteger(n)) throw new Error('Enter a whole number.');
    return n;
  }
  if (kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error('Enter true or false.');
  }
  if (kind === 'enum') {
    const match = (schema.enum || []).find((v) => String(v) === raw);
    if (match === undefined) throw new Error('Choose one of the listed values.');
    return match;
  }
  return raw;
}

/** Reads the form into an arguments object, with per-field errors. */
function collectArgs({ lenient = false } = {}) {
  const args = {};
  let errors = 0;
  for (const field of state.fields) {
    const raw = field.input.value;
    field.errorEl.textContent = '';
    field.input.removeAttribute('aria-invalid');
    const fail = (message) => {
      errors++;
      if (!lenient) {
        field.errorEl.textContent = message;
        field.input.setAttribute('aria-invalid', 'true');
      }
    };
    if (raw.trim() === '') {
      if (field.required) fail('Required.');
      continue;
    }
    try {
      if (field.kind === 'json' || field.kind === 'union') {
        try {
          args[field.name] = JSON.parse(raw);
        } catch (error) {
          throw new Error(`Invalid JSON: ${error.message}`);
        }
      } else if (field.kind === 'list') {
        const items = field.prop.items || {};
        const itemKind = fieldKind(items);
        args[field.name] = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) =>
            coerce(line, itemKind === 'list' || itemKind === 'json' ? 'string' : itemKind, items)
          );
      } else {
        args[field.name] = coerce(
          field.kind === 'string' ? raw : raw.trim(),
          field.kind,
          field.prop
        );
      }
    } catch (error) {
      fail(error.message);
    }
  }
  return { args, errors };
}

function readRawArgs() {
  const text = $('raw-args').value.trim() || '{}';
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `Invalid JSON: ${error.message}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Arguments must be a JSON object.' };
  }
  return { args: value };
}

function toggleRaw() {
  $('form-error').textContent = '';
  if (!state.rawMode) {
    const { args } = collectArgs({ lenient: true });
    $('raw-args').value = JSON.stringify(args, null, 2);
    state.rawMode = true;
    $('fields').hidden = true;
    $('raw').hidden = false;
    $('btn-raw').setAttribute('aria-pressed', 'true');
    $('raw-args').focus();
    return;
  }
  const { args, error } = readRawArgs();
  if (error) {
    $('form-error').textContent = error;
    return;
  }
  const known = new Set(state.fields.map((f) => f.name));
  const extra = Object.keys(args).filter((k) => !known.has(k));
  for (const field of state.fields) {
    field.input.value = '';
    setFieldValue(field, args[field.name]);
  }
  state.rawMode = false;
  $('fields').hidden = false;
  $('raw').hidden = true;
  $('btn-raw').setAttribute('aria-pressed', 'false');
  if (extra.length) $('form-error').textContent = `Not in the schema, dropped: ${extra.join(', ')}`;
}

function currentArgs() {
  if (state.rawMode) return readRawArgs();
  const { args, errors } = collectArgs();
  return errors ? { error: `Fix ${errors} field${errors === 1 ? '' : 's'} above.` } : { args };
}

// --- running a tool -----------------------------------------------------------------

function showRunning(name) {
  $('result').hidden = false;
  $('result').dataset.running = 'true';
  const progress = state.running?.progress;
  const bar = $('progress-bar');
  if (progress && progress.total) {
    bar.hidden = false;
    $('progress-fill').style.width =
      `${Math.min(100, (progress.progress / progress.total) * 100)}%`;
  } else {
    bar.hidden = true;
  }
  const detail = progress
    ? ` · ${progress.progress}${progress.total ? ` / ${progress.total}` : ''}${
        progress.message ? ` · ${progress.message}` : ''
      }`
    : '';
  $('result-status').replaceChildren(h('span', { text: `Calling ${name}…${detail}` }));
}

async function runTool() {
  if (state.running || !state.selected || !state.client) return;
  const { args, error } = currentArgs();
  $('form-error').textContent = error || '';
  if (error) return;
  const tool = state.selected;
  state.argsByTool.set(tool.name, args);
  const controller = new AbortController();
  state.running = { tool: tool.name, controller, progress: null };
  $('btn-run').disabled = true;
  $('btn-cancel').hidden = false;
  $('result-output').replaceChildren();
  $('result-rpc').replaceChildren();
  selectTab('output');
  showRunning(tool.name);

  const firstId = state.client.nextId;
  const started = performance.now();
  let result;
  let failure;
  try {
    result = await state.client.callTool(tool.name, args, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!state.running) return;
        state.running.progress = progress;
        if (state.selected?.name === tool.name) showRunning(tool.name);
      },
    });
  } catch (err) {
    failure = err;
  }
  const ms = Math.round(performance.now() - started);
  const exchange = findExchange(firstId);
  const record = { tool: tool.name, args, result, failure, ms, exchange };
  state.resultsByTool.set(tool.name, record);
  state.running = null;
  $('btn-run').disabled = false;
  $('btn-cancel').hidden = true;
  $('progress-bar').hidden = true;
  if (state.selected?.name === tool.name) renderResult(record);
}

function cancelTool() {
  state.running?.controller.abort();
}

function findExchange(firstId) {
  // Ids restart at 1 on every connection and the traffic log survives a reconnect,
  // so only entries recorded after this call can belong to it.
  let index = -1;
  for (let i = state.traffic.length - 1; i >= 0; i--) {
    const e = state.traffic[i];
    if (e.direction === 'out' && e.message?.method === 'tools/call' && e.message.id >= firstId) {
      index = i;
      break;
    }
  }
  if (index === -1) return {};
  const out = state.traffic[index];
  const after = state.traffic.slice(index + 1);
  // A server-to-client request can reuse the id; a reply never has a method.
  const back = after.find(
    (e) => e.direction === 'in' && e.message && !e.message.method && e.message.id === out.message.id
  );
  const httpError = !back ? after.find((e) => e.direction === 'in' && e.status >= 400) : null;
  return { request: out.message, response: back?.message, httpError };
}

function renderResult(record) {
  const box = $('result');
  box.hidden = false;
  box.dataset.running = 'false';
  const status = $('result-status');
  const out = $('result-output');
  out.replaceChildren();
  const { result, failure, ms } = record;
  if (failure) {
    const label =
      failure instanceof McpCancelledError
        ? 'Cancelled'
        : failure instanceof McpHttpError
          ? `HTTP ${failure.status}`
          : failure instanceof McpError
            ? `JSON-RPC error ${failure.code}`
            : 'Request failed';
    status.replaceChildren(h('span', { class: 'bad', text: label }), ` · ${ms} ms`);
    out.append(h('p', { class: 'notice', text: describeError(failure) }));
    if (failure instanceof McpError && failure.data !== undefined)
      out.append(jsonView(failure.data));
    if (failure instanceof McpHttpError && failure.body) out.append(...richText(failure.body));
  } else {
    const size = formatBytes(new TextEncoder().encode(JSON.stringify(result)).length);
    status.replaceChildren(
      result.isError
        ? h('span', { class: 'bad', text: 'Tool error' })
        : h('span', { class: 'ok', text: '✓ Completed' }),
      ` · ${ms} ms · ${size}`
    );
    if (result.isError) {
      out.append(
        h('p', {
          class: 'notice',
          text: 'The tool reported an error. For generated servers this usually means the upstream API answered with an error status or could not be reached.',
        })
      );
    }
    for (const block of result.content || []) out.append(...renderBlock(block));
    if (result.structuredContent !== undefined) {
      out.append(
        h('p', { class: 'block-caption', text: 'structuredContent' }),
        jsonView(result.structuredContent)
      );
    }
    if (!(result.content || []).length && result.structuredContent === undefined) {
      out.append(h('p', { class: 'no-args', text: 'The tool returned no content.' }));
    }
  }
  const rpc = $('result-rpc');
  rpc.replaceChildren();
  const { request, response, httpError } = record.exchange || {};
  rpc.append(
    h('p', { class: 'block-caption', text: 'Request' }),
    request ? jsonView(request) : textView('(not captured)')
  );
  rpc.append(
    h('p', { class: 'block-caption', text: 'Response' }),
    response
      ? jsonView(response)
      : httpError
        ? textView(`HTTP ${httpError.status}: ${httpError.error || ''}`)
        : textView('(no response)')
  );
}

function renderBlock(block) {
  if (!block || typeof block !== 'object') return [jsonView(block)];
  if (block.type === 'text') return richText(block.text ?? '');
  if (
    block.type === 'image' &&
    /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(block.mimeType || '') &&
    block.data
  ) {
    return [
      h('img', {
        class: 'result-img',
        alt: 'Image returned by the tool',
        src: `data:${block.mimeType};base64,${block.data}`,
      }),
    ];
  }
  if (block.type === 'resource' && block.resource) {
    const res = block.resource;
    return [
      h('p', {
        class: 'block-caption',
        text: `resource · ${res.uri || ''}${res.mimeType ? ` · ${res.mimeType}` : ''}`,
      }),
      res.text !== undefined
        ? richText(res.text)
        : textView(`(binary, ${formatBytes((res.blob || '').length * 0.75)})`),
    ].flat();
  }
  if (block.type === 'resource_link') {
    return [
      h('p', { class: 'block-caption', text: `resource link · ${block.uri || ''}` }),
      jsonView(block),
    ];
  }
  if (block.type === 'audio') {
    return [
      h('p', { class: 'block-caption', text: `audio · ${block.mimeType || ''} (not played here)` }),
    ];
  }
  return [jsonView(block)];
}

function resultText() {
  const record = state.selected && state.resultsByTool.get(state.selected.name);
  if (!record) return '';
  if (record.failure) return describeError(record.failure);
  const texts = (record.result.content || []).filter((b) => b.type === 'text').map((b) => b.text);
  return texts.length ? texts.join('\n\n') : JSON.stringify(record.result, null, 2);
}

function selectTab(tab) {
  for (const button of document.querySelectorAll('.result .tabs [role="tab"]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  $('result-output').hidden = tab !== 'output';
  $('result-rpc').hidden = tab !== 'rpc';
}

// --- completion-aware inputs ------------------------------------------------------------

let datalistSeq = 0;

/**
 * A text input that asks the server for completion/complete suggestions while
 * typing (when the server declares completions). context() returns the other
 * arguments already filled in.
 */
function completingInput({ id, ref, argName, context, placeholder, value = '' }) {
  const input = h('input', {
    id,
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder,
  });
  input.value = value;
  if (!state.client?.serverCapabilities?.completions) return { input, list: null };
  const listId = `complete-${++datalistSeq}`;
  const list = h('datalist', { id: listId });
  input.setAttribute('list', listId);
  let timer;
  let seq = 0;
  const ask = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const completion = await state.client.complete(
          ref,
          { name: argName, value: input.value },
          context()
        );
        if (mine !== seq) return;
        list.replaceChildren(
          ...(completion.values || []).slice(0, 100).map((v) => h('option', { value: v }))
        );
      } catch {
        // completion is best-effort
      }
    }, 180);
  };
  input.addEventListener('input', ask);
  input.addEventListener('focus', ask);
  return { input, list };
}

// --- resources ------------------------------------------------------------------------------

function renderResourceList() {
  const list = $('resource-list');
  list.replaceChildren();
  const { resources, templates } = state;
  $('resource-count').textContent =
    `${resources.length} resource${resources.length === 1 ? '' : 's'} · ${templates.length} template${templates.length === 1 ? '' : 's'}`;
  const item = (kind, entry, label, sub) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tool-item',
        role: 'option',
        'aria-selected': String(
          state.selectedResource?.kind === kind && state.selectedResource.entry === entry
        ),
        onclick: () => selectResource(kind, entry),
      },
      h('span', { class: 'tool-item-name', text: label }),
      sub ? h('span', { class: 'tool-item-desc', text: sub }) : null
    );
  if (resources.length) list.append(h('div', { class: 'group', text: 'Resources' }));
  for (const r of resources) {
    list.append(item('resource', r, r.title || r.name || r.uri, r.uri));
  }
  if (templates.length) list.append(h('div', { class: 'group', text: 'Templates' }));
  for (const t of templates) {
    list.append(item('template', t, t.title || t.name || t.uriTemplate, t.uriTemplate));
  }
  if (!resources.length && !templates.length) {
    list.append(h('p', { class: 'count', text: 'This server lists no resources.' }));
  }
}

/** Variable names in an RFC 6570 URI template. */
function templateVariables(template) {
  const names = [];
  for (const match of String(template).matchAll(/\{([^}]+)\}/g)) {
    for (const part of match[1].replace(/^[+#./;?&]/, '').split(',')) {
      const name = part.replace(/[:*].*$/, '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Expands an RFC 6570 template (levels 1 to 3, no prefix or explode modifiers). */
function expandTemplate(template, values) {
  const enc = (v, reserved) =>
    reserved
      ? encodeURI(String(v)).replace(/%25([0-9A-F]{2})/gi, '%$1')
      : encodeURIComponent(String(v));
  return String(template).replace(/\{([^}]+)\}/g, (_, expr) => {
    const op = /^[+#./;?&]/.test(expr) ? expr[0] : '';
    const names = (op ? expr.slice(1) : expr)
      .split(',')
      .map((p) => p.replace(/[:*].*$/, '').trim());
    const defined = names.filter((n) => values[n] !== undefined && values[n] !== '');
    if (!defined.length) return '';
    const reserved = op === '+' || op === '#';
    const parts = defined.map((n) => {
      const v = enc(values[n], reserved);
      return op === ';' || op === '?' || op === '&' ? `${n}=${v}` : v;
    });
    const sep = { '': ',', '+': ',', '#': ',', '.': '.', '/': '/', ';': ';', '?': '&', '&': '&' }[
      op
    ];
    const prefix = { '': '', '+': '', '#': '#', '.': '.', '/': '/', ';': ';', '?': '?', '&': '&' }[
      op
    ];
    return prefix + parts.join(sep);
  });
}

function selectResource(kind, entry) {
  state.selectedResource = { kind, entry };
  renderResourceList();
  const box = $('resource-detail');
  box.replaceChildren();
  const caps = state.client.serverCapabilities?.resources || {};
  const article = h('article', { class: 'tool' });
  box.append(article);
  const title = entry.title || entry.name || entry.uri || entry.uriTemplate;
  const tags = h('div', { class: 'tags' });
  if (entry.mimeType) tags.append(h('span', { class: 'chip', text: entry.mimeType }));
  if (kind === 'template') tags.append(h('span', { class: 'chip', text: 'template' }));
  if (entry.size !== undefined)
    tags.append(h('span', { class: 'chip', text: formatBytes(entry.size) }));
  const actions = h('div', { class: 'tool-actions' });
  article.append(
    h(
      'header',
      { class: 'tool-head' },
      h('div', { class: 'tool-title' }, h('h2', { text: title }), tags),
      actions
    ),
    h('p', { class: 'desc', text: entry.description || '' }),
    h(
      'p',
      { class: 'uri' },
      h('code', { text: kind === 'template' ? entry.uriTemplate : entry.uri })
    )
  );
  const output = h('div', { class: 'result-body' });
  const resultBox = h('section', { class: 'result', hidden: true }, output);
  const read = async (uri) => {
    resultBox.hidden = false;
    output.replaceChildren(h('p', { class: 'no-args', text: `Reading ${uri}…` }));
    try {
      const result = await state.client.readResource(uri);
      output.replaceChildren(...renderContents(result.contents || []));
    } catch (error) {
      output.replaceChildren(h('p', { class: 'notice', text: describeError(error) }));
    }
  };
  if (kind === 'resource') {
    actions.append(
      h('button', {
        type: 'button',
        class: 'btn ghost small',
        text: 'Copy URI',
        onclick: () => copy(entry.uri, 'URI copied'),
      })
    );
    if (caps.subscribe) {
      const subscribed = state.subscriptions.has(entry.uri);
      const toggle = h('button', {
        type: 'button',
        class: 'btn ghost small',
        'aria-pressed': String(subscribed),
        text: subscribed ? 'Subscribed' : 'Subscribe',
        onclick: async () => {
          const on = state.subscriptions.has(entry.uri);
          try {
            if (on) await state.client.unsubscribeResource(entry.uri);
            else await state.client.subscribeResource(entry.uri);
            if (on) state.subscriptions.delete(entry.uri);
            else state.subscriptions.add(entry.uri);
            toggle.setAttribute('aria-pressed', String(!on));
            toggle.textContent = on ? 'Subscribe' : 'Subscribed';
            toast(on ? 'Unsubscribed' : 'Subscribed: updates appear in Logs');
          } catch (error) {
            toast(describeError(error));
          }
        },
      });
      actions.append(toggle);
    }
    article.append(
      h(
        'div',
        { class: 'run' },
        h('button', {
          type: 'button',
          class: 'btn primary',
          text: 'Read',
          onclick: () => read(entry.uri),
        })
      ),
      resultBox
    );
    state.rereadResource = (uri) => {
      if (uri === entry.uri && state.selectedResource?.entry === entry) read(uri);
    };
    read(entry.uri);
    return;
  }
  // A template: one input per variable, with server-side completion.
  const names = templateVariables(entry.uriTemplate);
  const inputs = {};
  const form = h('form', { class: 'tool-form', novalidate: true });
  const fields = h('div', { class: 'fields' });
  const preview = h('code', { class: 'preview' });
  const values = () =>
    Object.fromEntries(Object.entries(inputs).map(([n, i]) => [n, i.value.trim()]));
  const updatePreview = () => (preview.textContent = expandTemplate(entry.uriTemplate, values()));
  names.forEach((name, index) => {
    const id = `tv-${index}`;
    const { input, list } = completingInput({
      id,
      ref: { type: 'ref/resource', uri: entry.uriTemplate },
      argName: name,
      context: () => {
        const v = values();
        delete v[name];
        return Object.fromEntries(Object.entries(v).filter(([, x]) => x));
      },
    });
    input.addEventListener('input', updatePreview);
    inputs[name] = input;
    fields.append(
      h(
        'div',
        { class: 'field' },
        h(
          'label',
          { for: id, class: 'param-label' },
          h('span', { class: 'param-name', text: name })
        ),
        input,
        list
      )
    );
  });
  if (!names.length)
    fields.append(h('p', { class: 'no-args', text: 'This template has no variables.' }));
  form.append(
    fields,
    h('p', { class: 'param-desc' }, 'URI: ', preview),
    h('div', { class: 'run' }, h('button', { type: 'submit', class: 'btn primary', text: 'Read' }))
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const missing = names.filter((n) => !inputs[n].value.trim());
    if (missing.length) {
      toast(`Fill in ${missing.join(', ')}`);
      inputs[missing[0]].focus();
      return;
    }
    read(expandTemplate(entry.uriTemplate, values()));
  });
  updatePreview();
  article.append(form, resultBox);
  state.rereadResource = null;
}

/** Renders resources/read contents: text (pretty JSON when JSON), images, other binaries. */
function renderContents(contents) {
  if (!contents.length) return [h('p', { class: 'no-args', text: 'No contents.' })];
  const out = [];
  for (const c of contents) {
    out.push(
      h('p', {
        class: 'block-caption',
        text: `${c.uri || ''}${c.mimeType ? ` · ${c.mimeType}` : ''}`,
      })
    );
    if (typeof c.text === 'string') {
      out.push(...richText(c.text));
    } else if (typeof c.blob === 'string') {
      const size = Math.floor((c.blob.length * 3) / 4);
      if (/^image\/(png|jpe?g|gif|webp)$/i.test(c.mimeType || '')) {
        out.push(
          h('img', {
            class: 'result-img',
            alt: c.uri || 'image',
            src: `data:${c.mimeType};base64,${c.blob}`,
          })
        );
      } else {
        out.push(
          h(
            'p',
            { class: 'no-args' },
            `Binary, ${formatBytes(size)}. `,
            h('a', {
              href: `data:${c.mimeType || 'application/octet-stream'};base64,${c.blob}`,
              download: (c.uri || 'resource').split('/').pop() || 'resource',
              text: 'Download',
            })
          )
        );
      }
    } else {
      out.push(jsonView(c));
    }
  }
  return out;
}

// --- prompts --------------------------------------------------------------------------------

function renderPromptList() {
  const list = $('prompt-list');
  list.replaceChildren();
  $('prompt-count').textContent =
    `${state.prompts.length} prompt${state.prompts.length === 1 ? '' : 's'}`;
  for (const prompt of state.prompts) {
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: 'tool-item',
          role: 'option',
          'aria-selected': String(state.selectedPrompt?.name === prompt.name),
          onclick: () => selectPrompt(prompt),
        },
        h('span', { class: 'tool-item-name', text: prompt.name }),
        prompt.title || prompt.description
          ? h('span', { class: 'tool-item-desc', text: prompt.title || prompt.description })
          : null
      )
    );
  }
  if (!state.prompts.length)
    list.append(h('p', { class: 'count', text: 'This server lists no prompts.' }));
}

function selectPrompt(prompt) {
  state.selectedPrompt = prompt;
  renderPromptList();
  const box = $('prompt-detail');
  const article = h('article', { class: 'tool' });
  box.replaceChildren(article);
  const args = prompt.arguments || [];
  const inputs = {};
  const fields = h('div', { class: 'fields' });
  const values = () =>
    Object.fromEntries(
      Object.entries(inputs)
        .map(([n, i]) => [n, i.value])
        .filter(([, v]) => v !== '')
    );
  args.forEach((arg, index) => {
    const id = `pa-${index}`;
    const { input, list } = completingInput({
      id,
      ref: { type: 'ref/prompt', name: prompt.name },
      argName: arg.name,
      context: () => {
        const v = values();
        delete v[arg.name];
        return v;
      },
    });
    inputs[arg.name] = input;
    fields.append(
      h(
        'div',
        { class: 'field' },
        h(
          'label',
          { for: id, class: 'param-label' },
          h('span', { class: 'param-name', text: arg.name }),
          arg.required ? h('span', { class: 'param-req', text: 'required' }) : null,
          arg.title ? h('span', { class: 'param-type', text: arg.title }) : null
        ),
        arg.description ? h('p', { class: 'param-desc', text: arg.description }) : null,
        input,
        list
      )
    );
  });
  if (!args.length)
    fields.append(h('p', { class: 'no-args', text: 'This prompt takes no arguments.' }));
  const output = h('div', { class: 'result-body' });
  const resultBox = h('section', { class: 'result', hidden: true }, output);
  const error = h('span', { class: 'form-error', role: 'alert' });
  const form = h(
    'form',
    { class: 'tool-form', novalidate: true },
    fields,
    h(
      'div',
      { class: 'run' },
      h('button', { type: 'submit', class: 'btn primary', text: 'Get prompt' }),
      error
    )
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const missing = args.filter((a) => a.required && !inputs[a.name].value);
    error.textContent = missing.length ? `Required: ${missing.map((a) => a.name).join(', ')}` : '';
    if (missing.length) return;
    resultBox.hidden = false;
    output.replaceChildren(h('p', { class: 'no-args', text: 'Getting prompt…' }));
    try {
      const result = await state.client.getPrompt(prompt.name, values());
      output.replaceChildren(
        ...(result.description ? [h('p', { class: 'param-desc', text: result.description })] : []),
        ...(result.messages || []).flatMap((m) => [
          h('p', { class: 'block-caption', text: m.role }),
          ...renderBlock(m.content),
        ])
      );
    } catch (err) {
      output.replaceChildren(h('p', { class: 'notice', text: describeError(err) }));
    }
  });
  article.append(
    h(
      'header',
      { class: 'tool-head' },
      h(
        'div',
        { class: 'tool-title' },
        h('h2', { text: prompt.name }),
        prompt.title
          ? h('div', { class: 'tags' }, h('span', { class: 'chip', text: prompt.title }))
          : null
      )
    ),
    h('p', { class: 'desc', text: prompt.description || '' }),
    form,
    resultBox
  );
}

// --- logs and notifications -------------------------------------------------------------------

function renderLogNote() {
  const caps = state.client?.serverCapabilities || {};
  $('log-level').disabled = !caps.logging;
  $('log-note').textContent = caps.logging
    ? 'Log messages the server sends (notifications/message), plus other server events.'
    : 'This server does not declare logging. Server events (list changes, resource updates) still appear here.';
}

function addLog(entry) {
  state.logs.push({ at: Date.now(), ...entry });
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  const list = $('log-list');
  list.append(logRow(state.logs[state.logs.length - 1]));
  while (list.children.length > MAX_LOGS) list.firstElementChild.remove();
  $('n-logs').textContent = String(state.logs.length);
  if (!$('view-logs').hidden) list.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function logRow(entry) {
  const data = entry.data;
  const body =
    typeof data === 'string'
      ? h('span', { class: 'log-text', text: data })
      : data === undefined
        ? null
        : jsonView(data);
  return h(
    'li',
    { class: `log-row ${entry.kind}`, 'data-kind': entry.kind },
    h('span', { class: 't-time', text: clock(entry.at) }),
    h('span', { class: `level level-${entry.level || 'event'}`, text: entry.level || 'event' }),
    h(
      'div',
      { class: 'log-body' },
      entry.logger || entry.title
        ? h('span', { class: 'log-logger', text: entry.title || entry.logger })
        : null,
      body
    )
  );
}

async function handleNotification(msg) {
  const params = msg.params || {};
  switch (msg.method) {
    case 'notifications/message':
      addLog({ kind: 'log', level: params.level, logger: params.logger, data: params.data });
      return;
    case 'notifications/progress':
      return; // shown on the running call
    case 'notifications/tools/list_changed':
      addLog({ kind: 'event', title: 'Tools changed', data: 'Reloaded the tool list.' });
      try {
        state.tools = await state.client.listTools();
        renderToolList();
        renderViewTabs();
      } catch {
        // keep the old list
      }
      return;
    case 'notifications/resources/list_changed':
      addLog({ kind: 'event', title: 'Resources changed', data: 'Reloaded the resource list.' });
      try {
        [state.resources, state.templates] = await Promise.all([
          state.client.listResources(),
          state.client.listResourceTemplates().catch(() => state.templates),
        ]);
        renderResourceList();
        renderViewTabs();
      } catch {
        // keep the old list
      }
      return;
    case 'notifications/prompts/list_changed':
      addLog({ kind: 'event', title: 'Prompts changed', data: 'Reloaded the prompt list.' });
      try {
        state.prompts = await state.client.listPrompts();
        renderPromptList();
        renderViewTabs();
      } catch {
        // keep the old list
      }
      return;
    case 'notifications/resources/updated':
      addLog({ kind: 'event', title: 'Resource updated', data: params.uri });
      state.rereadResource?.(params.uri);
      return;
    case 'notifications/cancelled':
      addLog({
        kind: 'event',
        title: 'Server cancelled a request',
        data: `${params.requestId ?? ''}${params.reason ? `: ${params.reason}` : ''}`,
      });
      return;
    case 'notifications/elicitation/complete':
      addLog({ kind: 'event', title: 'Elicitation complete', data: params.elicitationId });
      return;
    default:
      addLog({ kind: 'event', title: msg.method, data: msg.params });
  }
}

// --- requests from the server (elicitation, sampling) --------------------------------------------

/**
 * Hook for McpClient: elicitation and sampling wait for a person in a dialog;
 * roots/list falls through to the client's roots; anything else is unsupported.
 */
function handleServerRequest(msg, { signal }) {
  if (msg.method !== 'elicitation/create' && msg.method !== 'sampling/createMessage') {
    return undefined;
  }
  if (msg.method === 'sampling/createMessage' && msg.params?.tools) {
    throw new McpError('This client does not support tool use in sampling.', -32602);
  }
  return new Promise((resolve, reject) => {
    const item = { msg, resolve, reject, signal };
    state.serverRequests.push(item);
    signal.addEventListener('abort', () => {
      const index = state.serverRequests.indexOf(item);
      if (index === -1) return;
      state.serverRequests.splice(index, 1);
      resolve(undefined);
      if (index === 0) {
        toast('The server cancelled its request');
        $('server-request').close();
        nextServerRequest();
      } else updateQueueChip();
    });
    if (state.serverRequests.length === 1) nextServerRequest();
    else updateQueueChip();
  });
}

function updateQueueChip() {
  const waiting = state.serverRequests.length - 1;
  $('sr-queue').hidden = waiting <= 0;
  $('sr-queue').textContent = `${waiting} more waiting`;
}

function closeServerRequests() {
  for (const item of state.serverRequests) item.resolve(undefined);
  state.serverRequests = [];
  if ($('server-request').open) $('server-request').close();
}

function finishServerRequest(item, settle) {
  const index = state.serverRequests.indexOf(item);
  if (index !== -1) state.serverRequests.splice(index, 1);
  settle();
  $('server-request').close();
  nextServerRequest();
}

function nextServerRequest() {
  const item = state.serverRequests[0];
  if (!item) return;
  updateQueueChip();
  const dialog = $('server-request');
  const body = $('sr-body');
  const actions = $('sr-actions');
  body.replaceChildren();
  actions.replaceChildren();
  const button = (text, cls, onclick) =>
    h('button', { type: 'button', class: `btn ${cls}`, text, onclick });
  if (item.msg.method === 'elicitation/create') renderElicitation(item, body, actions, button);
  else renderSampling(item, body, actions, button);
  dialog.oncancel = (event) => {
    event.preventDefault();
    if (item.msg.method === 'elicitation/create') {
      finishServerRequest(item, () => item.resolve({ action: 'cancel' }));
    } else {
      finishServerRequest(item, () =>
        item.reject(new McpError('User rejected sampling request', -1))
      );
    }
  };
  if (!dialog.open) dialog.showModal();
  body.querySelector('input, select, textarea, button')?.focus();
}

function renderElicitation(item, body, actions, button) {
  const params = item.msg.params || {};
  $('sr-title').textContent =
    params.mode === 'url' ? 'The server asks you to open a page' : 'The server asks for input';
  body.append(h('p', { class: 'sr-message', text: params.message || '' }));
  if (params.mode === 'url') {
    let host = '';
    try {
      host = new URL(params.url).host;
    } catch {
      host = '';
    }
    body.append(
      h(
        'p',
        { class: 'param-desc' },
        'Opens ',
        h('strong', { text: host || 'an unknown site' }),
        ':'
      ),
      h('p', { class: 'uri' }, h('code', { text: params.url || '' })),
      h('p', {
        class: 'fine-inline',
        text: 'Only continue if you trust this server and the page it opens.',
      })
    );
    actions.append(
      button('Cancel', 'ghost', () =>
        finishServerRequest(item, () => item.resolve({ action: 'cancel' }))
      ),
      button('Decline', 'ghost', () =>
        finishServerRequest(item, () => item.resolve({ action: 'decline' }))
      ),
      button('Open page', 'primary', () => {
        try {
          const url = new URL(params.url);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            window.open(url.href, '_blank', 'noopener,noreferrer');
          }
        } catch {
          // invalid URL: accept without opening
        }
        finishServerRequest(item, () => item.resolve({ action: 'accept' }));
      })
    );
    return;
  }
  const schema = params.requestedSchema || { properties: {} };
  const required = new Set(schema.required || []);
  const getters = [];
  const fields = h('div', { class: 'fields' });
  Object.entries(schema.properties || {}).forEach(([name, prop], index) => {
    const id = `el-${index}`;
    const label = h(
      'label',
      { for: id, class: 'param-label' },
      h('span', { class: 'param-name', text: prop.title || name }),
      required.has(name) ? h('span', { class: 'param-req', text: 'required' }) : null,
      prop.title ? h('span', { class: 'param-type', text: name }) : null
    );
    const error = h('p', { class: 'param-error' });
    let control;
    let get;
    const options = Array.isArray(prop.oneOf)
      ? prop.oneOf.map((o) => [o.const, o.title || o.const])
      : Array.isArray(prop.enum)
        ? prop.enum.map((v, i) => [v, prop.enumNames?.[i] || v])
        : null;
    if (prop.type === 'array') {
      const items = prop.items || {};
      const choices = Array.isArray(items.anyOf)
        ? items.anyOf.map((o) => [o.const, o.title || o.const])
        : (items.enum || []).map((v) => [v, v]);
      const defaults = new Set(prop.default || []);
      const boxes = choices.map(([value, text]) => {
        const box = h('input', { type: 'checkbox', value });
        box.checked = defaults.has(value);
        return h('label', { class: 'check' }, box, ` ${text}`);
      });
      control = h('div', { id, class: 'choices', role: 'group' }, boxes);
      get = () => {
        const picked = boxes
          .map((l) => l.firstChild)
          .filter((b) => b.checked)
          .map((b) => b.value);
        if (prop.minItems !== undefined && picked.length < prop.minItems)
          throw new Error(`Pick at least ${prop.minItems}.`);
        if (prop.maxItems !== undefined && picked.length > prop.maxItems)
          throw new Error(`Pick at most ${prop.maxItems}.`);
        return picked.length || required.has(name) ? picked : undefined;
      };
    } else if (options) {
      control = h(
        'select',
        { id },
        h('option', { value: '', text: required.has(name) ? 'Choose…' : '(not set)' }),
        options.map(([value, text]) => h('option', { value, text }))
      );
      if (prop.default !== undefined) control.value = prop.default;
      get = () => control.value || undefined;
    } else if (prop.type === 'boolean') {
      control = h('input', { id, type: 'checkbox' });
      control.checked = Boolean(prop.default);
      get = () => control.checked;
    } else if (prop.type === 'number' || prop.type === 'integer') {
      control = h('input', {
        id,
        type: 'number',
        step: prop.type === 'integer' ? '1' : 'any',
        min: prop.minimum,
        max: prop.maximum,
      });
      if (prop.default !== undefined) control.value = String(prop.default);
      get = () => {
        if (control.value === '') return undefined;
        const n = Number(control.value);
        if (Number.isNaN(n)) throw new Error('Enter a number.');
        if (prop.type === 'integer' && !Number.isInteger(n))
          throw new Error('Enter a whole number.');
        if (prop.minimum !== undefined && n < prop.minimum)
          throw new Error(`At least ${prop.minimum}.`);
        if (prop.maximum !== undefined && n > prop.maximum)
          throw new Error(`At most ${prop.maximum}.`);
        return n;
      };
    } else {
      const type = { email: 'email', uri: 'url', date: 'date' }[prop.format] || 'text';
      control = h('input', {
        id,
        type,
        autocomplete: 'off',
        placeholder: prop.format === 'date-time' ? '2026-01-01T00:00:00Z' : undefined,
      });
      if (prop.default !== undefined) control.value = String(prop.default);
      get = () => {
        const v = control.value;
        if (v === '') return undefined;
        if (prop.minLength !== undefined && v.length < prop.minLength)
          throw new Error(`At least ${prop.minLength} characters.`);
        if (prop.maxLength !== undefined && v.length > prop.maxLength)
          throw new Error(`At most ${prop.maxLength} characters.`);
        if (prop.format === 'email' && !/^[^@\s]+@[^@\s]+$/.test(v))
          throw new Error('Enter an email address.');
        if (prop.format === 'uri') {
          try {
            new URL(v);
          } catch {
            throw new Error('Enter a full URL.');
          }
        }
        return v;
      };
    }
    getters.push({ name, get, error, control });
    fields.append(
      h(
        'div',
        { class: 'field' },
        label,
        prop.description ? h('p', { class: 'param-desc', text: prop.description }) : null,
        control,
        error
      )
    );
  });
  body.append(
    fields,
    h('p', {
      class: 'fine-inline',
      text: 'Servers must not ask for passwords or secrets this way. Decline if this looks wrong.',
    })
  );
  actions.append(
    button('Cancel', 'ghost', () =>
      finishServerRequest(item, () => item.resolve({ action: 'cancel' }))
    ),
    button('Decline', 'ghost', () =>
      finishServerRequest(item, () => item.resolve({ action: 'decline' }))
    ),
    button('Submit', 'primary', () => {
      const content = {};
      let failed = false;
      for (const g of getters) {
        g.error.textContent = '';
        try {
          const value = g.get();
          if (value === undefined && required.has(g.name)) throw new Error('Required.');
          if (value !== undefined) content[g.name] = value;
        } catch (error) {
          g.error.textContent = error.message;
          failed = true;
        }
      }
      if (!failed) finishServerRequest(item, () => item.resolve({ action: 'accept', content }));
    })
  );
}

function renderSampling(item, body, actions, button) {
  const params = item.msg.params || {};
  $('sr-title').textContent = 'The server asks for an LLM completion';
  body.append(
    h('p', {
      class: 'sr-message',
      text: 'The playground has no model. Read the request and type the reply the server should get.',
    })
  );
  const meta = [`maxTokens ${params.maxTokens}`];
  if (params.temperature !== undefined) meta.push(`temperature ${params.temperature}`);
  if (params.modelPreferences?.hints?.length)
    meta.push(`model hints ${params.modelPreferences.hints.map((m) => m.name).join(', ')}`);
  body.append(h('p', { class: 'block-caption', text: meta.join(' · ') }));
  if (params.systemPrompt) {
    body.append(h('p', { class: 'block-caption', text: 'system' }), textView(params.systemPrompt));
  }
  for (const message of params.messages || []) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    body.append(h('p', { class: 'block-caption', text: message.role }));
    for (const block of blocks) body.append(...renderBlock(block));
  }
  const reply = h('textarea', { id: 'sr-reply', rows: 5, spellcheck: 'true' });
  const model = h('input', { id: 'sr-model', type: 'text', autocomplete: 'off' });
  model.value = 'human';
  body.append(
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { for: 'sr-reply', class: 'param-label' },
        h('span', { class: 'param-name', text: 'Reply (assistant)' })
      ),
      reply
    ),
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { for: 'sr-model', class: 'param-label' },
        h('span', { class: 'param-name', text: 'Model name' })
      ),
      model
    )
  );
  actions.append(
    button('Reject', 'ghost', () =>
      finishServerRequest(item, () =>
        item.reject(new McpError('User rejected sampling request', -1))
      )
    ),
    button('Send reply', 'primary', () =>
      finishServerRequest(item, () =>
        item.resolve({
          role: 'assistant',
          content: { type: 'text', text: reply.value },
          model: model.value.trim() || 'human',
          stopReason: 'endTurn',
        })
      )
    )
  );
}

// --- raw requests and roots ---------------------------------------------------------------------

const RAW_METHODS = [
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
  'notifications/roots/list_changed',
];

function readRawParams() {
  const text = $('raw-params').value.trim();
  if (!text) return { params: undefined };
  try {
    const params = JSON.parse(text);
    if (params === null || typeof params !== 'object')
      return { error: 'Params must be a JSON object or array.' };
    return { params };
  } catch (error) {
    return { error: `Invalid JSON: ${error.message}` };
  }
}

async function sendRaw() {
  if (!state.client) return;
  const method = $('raw-method').value.trim();
  const { params, error } = readRawParams();
  $('raw-error').textContent = error || (method ? '' : 'Enter a method.');
  if (error || !method) return;
  const out = $('raw-result');
  out.hidden = false;
  out.replaceChildren(h('p', { class: 'no-args', text: `Sending ${method}…` }));
  const started = performance.now();
  try {
    if ($('raw-notify').checked) {
      await state.client.notify(method, params);
      out.replaceChildren(
        h('p', { class: 'no-args', text: 'Notification sent (no response expected).' })
      );
      return;
    }
    const result = await state.client.request(method, params);
    out.replaceChildren(
      h('p', {
        class: 'block-caption',
        text: `result · ${Math.round(performance.now() - started)} ms`,
      }),
      jsonView(result)
    );
  } catch (err) {
    out.replaceChildren(
      h('p', { class: 'notice', text: describeError(err) }),
      ...(err instanceof McpError && err.data !== undefined ? [jsonView(err.data)] : [])
    );
  }
}

function renderRoots() {
  const box = $('root-rows');
  box.replaceChildren();
  for (const root of state.roots) {
    headerRow(
      box,
      { name: root.uri, value: root.name || '' },
      { valueLabel: 'Name', secret: false }
    );
  }
}

async function applyRoots() {
  const rows = rowsOf($('root-rows'));
  const roots = [];
  for (const [uri, name] of rows) {
    if (!uri) continue;
    if (!/^file:\/\//i.test(uri)) {
      toast('Root URIs must start with file://');
      return;
    }
    roots.push(name.trim() ? { uri, name: name.trim() } : { uri });
  }
  state.roots = roots;
  localStorage.setItem('mcp-playground-roots', JSON.stringify(roots));
  try {
    await state.client?.setRoots(roots);
    toast(`${roots.length} root${roots.length === 1 ? '' : 's'} applied`);
  } catch (error) {
    toast(describeError(error));
  }
}

// --- traffic -------------------------------------------------------------------------

function addTraffic(entry) {
  state.traffic.push(entry);
  if (state.traffic.length > MAX_TRAFFIC) state.traffic.shift();
  const list = $('traffic-list');
  list.append(trafficRow(entry));
  while (list.children.length > MAX_TRAFFIC) list.firstElementChild.remove();
  $('traffic-count').textContent =
    `${state.traffic.length} message${state.traffic.length === 1 ? '' : 's'}`;
  if ($('traffic').open) list.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function trafficLabel(entry) {
  const msg = entry.message;
  if (!msg)
    return { text: `HTTP ${entry.status}${entry.error ? ` · ${entry.error}` : ''}`, bad: true };
  if (msg.method) {
    const suffix =
      (msg.method === 'tools/call' || msg.method === 'prompts/get') && msg.params?.name
        ? ` · ${msg.params.name}`
        : msg.method === 'resources/read' && msg.params?.uri
          ? ` · ${msg.params.uri}`
          : '';
    return { text: `${msg.method}${suffix}`, bad: false };
  }
  if (msg.error)
    return { text: `error #${msg.id} · ${msg.error.message || msg.error.code}`, bad: true };
  if (msg.result?.isError) return { text: `result #${msg.id} · tool error`, bad: true };
  return { text: `result #${msg.id}`, bad: false };
}

function trafficRow(entry) {
  const { text, bad } = trafficLabel(entry);
  const size = entry.message ? formatBytes(JSON.stringify(entry.message).length) : '';
  const row = h('li', { class: 'traffic-row' });
  const button = h(
    'button',
    { type: 'button', 'aria-expanded': 'false' },
    h('span', { class: 't-time', text: clock(entry.at) }),
    h('span', {
      class: `t-dir ${entry.direction}`,
      text: entry.direction === 'out' ? '↑' : '↓',
      'aria-label': entry.direction === 'out' ? 'sent' : 'received',
    }),
    h('span', { class: `t-label${bad ? ' bad' : ''}`, text }),
    h('span', { class: 't-meta', text: size })
  );
  let detail = null;
  button.addEventListener('click', () => {
    if (detail) {
      detail.remove();
      detail = null;
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    detail = entry.message ? jsonView(entry.message) : textView(entry.error || '');
    row.append(detail);
    button.setAttribute('aria-expanded', 'true');
  });
  row.append(button);
  return row;
}

// --- client snippets -------------------------------------------------------------------

function snippetList() {
  const client = state.client;
  const url = client.url;
  const name = slug(client.serverInfo?.name);
  const oauth = Boolean(client.auth);
  const auth = !oauth && (Boolean(client.token) || state.config.inboundAuth === 'bearer');
  const custom = Object.keys(client.headers || {});
  const sse = client.transport === 'sse';
  const headerObject = (style) => {
    const out = {};
    if (auth)
      out.Authorization = style === 'vscode' ? 'Bearer ${input:mcp-token}' : 'Bearer YOUR_TOKEN';
    for (const header of custom)
      out[header] = style === 'vscode' ? `\${input:${header}}` : 'YOUR_VALUE';
    return Object.keys(out).length ? { headers: out } : {};
  };
  const cursor = { mcpServers: { [name]: { url, ...headerObject('cursor') } } };
  const inputs = [];
  if (auth)
    inputs.push({
      type: 'promptString',
      id: 'mcp-token',
      description: 'Access token',
      password: true,
    });
  for (const header of custom)
    inputs.push({ type: 'promptString', id: header, description: header, password: true });
  const vscode = {
    ...(inputs.length ? { inputs } : {}),
    servers: { [name]: { type: sse ? 'sse' : 'http', url, ...headerObject('vscode') } },
  };
  const claudeHeaders = [
    ...(auth
      ? [`--header "Authorization: Bearer ${hosted() ? '$ACCESS_TOKEN' : '$MCP_AUTH_TOKEN'}"`]
      : []),
    ...custom.map(
      (header) => `--header "${header}: $${header.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}"`
    ),
  ];
  return [
    {
      title: 'Claude Code',
      code: `claude mcp add --transport ${sse ? 'sse' : 'http'} ${name} ${url}${claudeHeaders.map((x) => ` \\\n  ${x}`).join('')}`,
      foot: oauth ? 'This server uses OAuth: the client opens the sign-in page itself.' : undefined,
    },
    { title: 'Cursor', note: '.cursor/mcp.json', code: JSON.stringify(cursor, null, 2) },
    { title: 'VS Code', note: '.vscode/mcp.json', code: JSON.stringify(vscode, null, 2) },
    {
      title: 'MCP Inspector',
      code: 'npx @modelcontextprotocol/inspector',
      foot: `Choose ${sse ? 'SSE' : 'Streamable HTTP'}, enter ${url}${auth || custom.length ? ' and add the same headers' : ''}.`,
    },
  ];
}

function openClients() {
  const box = $('client-snippets');
  box.replaceChildren(
    ...snippetList().map((s) =>
      h(
        'section',
        { class: 'snippet' },
        h(
          'div',
          { class: 'snippet-head' },
          h(
            'span',
            { class: 'snippet-title' },
            s.title,
            s.note ? h('span', { class: 'snippet-note', text: s.note }) : null
          ),
          h('button', {
            type: 'button',
            class: 'btn ghost small',
            text: 'Copy',
            onclick: () => copy(s.code),
          })
        ),
        h('pre', { text: s.code }),
        s.foot ? h('p', { class: 'snippet-foot', text: s.foot }) : null
      )
    ),
    h('p', {
      class: 'snippet-foot',
      text: 'Claude.ai connects from Anthropic’s cloud, so it needs a public HTTPS URL. A static bearer token can only be added there by a Team or Enterprise owner; other plans need OAuth or an open server.',
    })
  );
  $('clients').showModal();
}

// --- wiring -----------------------------------------------------------------------------

function wire() {
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-clients').addEventListener('click', openClients);
  $('btn-share').addEventListener('click', () => copy(shareLink(), 'Link copied (no credentials)'));
  $('btn-close-clients').addEventListener('click', () => $('clients').close());
  $('clients').addEventListener('click', (event) => {
    if (event.target === $('clients')) $('clients').close();
  });
  for (const tab of document.querySelectorAll('#views [role="tab"]')) {
    tab.addEventListener('click', () => selectView(tab.dataset.view));
  }
  $('views').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const visible = VIEWS.filter((v) => !$(`vt-${v}`).hidden);
    const index = visible.indexOf(state.view);
    const next =
      event.key === 'Home'
        ? visible[0]
        : event.key === 'End'
          ? visible[visible.length - 1]
          : visible[
              (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length
            ];
    event.preventDefault();
    selectView(next, { focus: true });
  });
  $('search').addEventListener('input', renderToolList);
  $('search').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      $('tool-list').focus();
      moveSelection(state.selected ? 0 : 1);
    } else if (event.key === 'Enter') {
      const first = filteredTools()[0];
      if (first) selectTool(first);
    }
  });
  $('tool-list').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && state.selected) {
      event.preventDefault();
      $('fields').querySelector('input, select, textarea')?.focus();
    }
  });
  $('tool-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runTool();
  });
  $('btn-cancel').addEventListener('click', cancelTool);
  $('btn-raw').addEventListener('click', toggleRaw);
  $('btn-curl').addEventListener('click', () => {
    const { args, error } = currentArgs();
    if (error) {
      $('form-error').textContent = error;
      return;
    }
    copy(
      state.client.curl('tools/call', { name: state.selected.name, arguments: args }),
      'curl command copied'
    );
  });
  $('btn-copy-result').addEventListener('click', () => copy(resultText()));
  for (const tab of document.querySelectorAll('.result .tabs [role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  $('btn-clear').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.traffic = [];
    $('traffic-list').replaceChildren();
    $('traffic-count').textContent = '';
  });
  $('log-level').addEventListener('change', async () => {
    const level = $('log-level').value;
    if (!level || !state.client) return;
    try {
      await state.client.setLoggingLevel(level);
      toast(`Log level: ${level}`);
    } catch (error) {
      toast(describeError(error));
    }
  });
  $('log-events').addEventListener('change', () => {
    $('log-list').classList.toggle('hide-events', !$('log-events').checked);
  });
  $('btn-clear-logs').addEventListener('click', () => {
    state.logs = [];
    $('log-list').replaceChildren();
    $('n-logs').textContent = '';
  });
  $('raw-methods').replaceChildren(...RAW_METHODS.map((m) => h('option', { value: m })));
  $('raw-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendRaw();
  });
  $('btn-raw-curl').addEventListener('click', () => {
    const { params, error } = readRawParams();
    if (error) {
      $('raw-error').textContent = error;
      return;
    }
    copy(state.client.curl($('raw-method').value.trim(), params), 'curl command copied');
  });
  $('btn-add-root').addEventListener('click', () =>
    headerRow($('root-rows'), {}, { valueLabel: 'Name', secret: false }).focus()
  );
  $('btn-save-roots').addEventListener('click', applyRoots);
  $('kbd-hint').replaceChildren(
    h('kbd', { text: isMac ? '⌘' : 'Ctrl' }),
    ' ',
    h('kbd', { text: 'Enter' })
  );
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ($('server-request').open || $('clients').open) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      if (!$('workspace').hidden && state.view === 'tools' && !$('tool').hidden) {
        event.preventDefault();
        runTool();
      } else if (!$('workspace').hidden && state.view === 'raw') {
        event.preventDefault();
        sendRaw();
      }
    } else if (event.key === '/' && !typing && !$('workspace').hidden && state.view === 'tools') {
      event.preventDefault();
      $('search').focus();
    }
  });
}

async function init() {
  state.config = await loadConfig();
  setupConnectForm();
  wire();
  if (state.config.hosted) {
    // Load OAuth support ahead of a click, so the sign-in window opens instantly.
    import('./oauth.js')
      .then((mod) => {
        state.oauthModule = mod;
        if (authMode() === 'oauth' && endpointUrl())
          oauthFor(endpointUrl()).then(renderOAuthStatus);
      })
      .catch(() => {});
  }
  const canAutoConnect =
    !state.config.hosted && (state.config.inboundAuth === 'none' || Boolean($('token').value));
  if (canAutoConnect) connect();
  else
    ($('token-field').hidden
      ? $('btn-connect')
      : state.config.hosted
        ? $('url')
        : $('token')
    ).focus();
}

init();
