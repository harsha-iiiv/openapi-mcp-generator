/**
 * MCP playground: browse a server's tools, fill a form generated from each
 * input schema, call it and inspect every JSON-RPC message.
 *
 * Part of openapi-mcp-generator (MIT). No dependencies, no third-party requests,
 * and every server-supplied string is rendered as text, never as HTML.
 */
import { McpClient, McpError, McpHttpError } from './mcp-client.js';

const VERSION = '1.0.0';
const MAX_TRAFFIC = 400;
const JSON_RENDER_LIMIT = 400_000;

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

const state = {
  config: null,
  client: null,
  tools: [],
  selected: null,
  fields: [],
  rawMode: false,
  running: false,
  argsByTool: new Map(),
  resultsByTool: new Map(),
  traffic: [],
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

// --- helpers -------------------------------------------------------------------

function storageKey() {
  return `mcp-playground-token:${endpointUrl()}`;
}

function endpointUrl() {
  const raw = state.config.hosted ? $('url').value.trim() : state.config.endpoint;
  try {
    return new URL(raw || '/mcp', location.href).href;
  } catch {
    return raw;
  }
}

function transportValue() {
  return state.config.hosted ? $('transport').value : state.config.transport;
}

function transportLabel(transport) {
  return transport === 'sse' ? 'HTTP+SSE' : 'Streamable HTTP';
}

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('status-text').textContent = text;
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

// --- connection -----------------------------------------------------------------

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
    ...config,
  };
  if (config.hosted) {
    const params = new URLSearchParams(location.search);
    config.endpoint = params.get('url') || localStorage.getItem('mcp-playground-url') || '';
    if (params.get('transport') === 'sse') config.transport = 'sse';
  }
  return config;
}

function setupConnectForm() {
  const { config } = state;
  if (config.hosted) {
    $('url-field').hidden = false;
    $('transport-field').hidden = false;
    $('endpoint-row').hidden = true;
    $('url').value = config.endpoint;
    $('transport').value = config.transport;
  } else {
    $('endpoint').textContent = endpointUrl();
    $('transport-name').textContent = transportLabel(config.transport);
  }
  if (config.inboundAuth === 'none') {
    $('token-field').hidden = true;
  } else if (config.inboundAuth === 'bearer') {
    $('token-hint').textContent = 'required by this server';
  }
  const remembered = sessionStorage.getItem(storageKey());
  if (remembered) {
    $('token').value = remembered;
    $('remember').checked = true;
  }
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

async function connect() {
  const url = endpointUrl();
  const transport = transportValue();
  const token = $('token-field').hidden ? '' : $('token').value.trim();
  const errorBox = $('connect-error');
  errorBox.hidden = true;

  if (state.config.hosted) {
    if (!/^https?:\/\//i.test($('url').value.trim())) {
      errorBox.textContent =
        'Enter the full server URL, starting with https:// (or http://localhost).';
      errorBox.hidden = false;
      return;
    }
    localStorage.setItem('mcp-playground-url', $('url').value.trim());
    const params = new URLSearchParams(location.search);
    params.set('url', $('url').value.trim());
    if (transport === 'sse') params.set('transport', 'sse');
    else params.delete('transport');
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
  }
  if ($('remember').checked && token) sessionStorage.setItem(storageKey(), token);
  else sessionStorage.removeItem(storageKey());

  $('btn-connect').disabled = true;
  setStatus('connecting', 'Connecting…');
  const client = new McpClient({
    url,
    transport,
    token,
    clientInfo: { name: 'mcp-playground', version: VERSION },
    onTraffic: addTraffic,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    state.client = client;
    state.tools = tools;
    showWorkspace();
  } catch (error) {
    await client.close().catch(() => {});
    setStatus('error', 'Not connected');
    errorBox.textContent = describeError(error);
    errorBox.hidden = false;
  } finally {
    $('btn-connect').disabled = false;
  }
}

function describeError(error) {
  if (error instanceof McpHttpError) return error.hint || error.message;
  if (error instanceof McpError) return `${error.message} (JSON-RPC ${error.code})`;
  return error && error.message ? error.message : String(error);
}

async function disconnect() {
  await state.client?.close().catch(() => {});
  state.client = null;
  state.tools = [];
  state.selected = null;
  $('workspace').hidden = true;
  $('connect').hidden = false;
  $('btn-clients').hidden = true;
  $('btn-disconnect').hidden = true;
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
  ]
    .filter(Boolean)
    .join(' · ');
  document.title = `${name} · MCP playground`;
  setStatus('connected', 'Connected');
  $('connect').hidden = true;
  $('workspace').hidden = false;
  $('btn-clients').hidden = false;
  $('btn-disconnect').hidden = false;
  $('search').value = '';
  renderToolList();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const initial = state.tools.find((t) => t.name === fromHash) || state.tools[0];
  if (initial) selectTool(initial, { focus: false });
  else {
    $('empty').hidden = false;
    $('empty').firstElementChild.textContent = 'This server exposes no tools.';
  }
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
  document
    .querySelector(`.tool-item[data-name="${CSS.escape(next.name)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
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
  for (const item of document.querySelectorAll('.tool-item')) {
    item.setAttribute('aria-selected', String(item.dataset.name === tool.name));
  }
  const { prose, tags } = parseDescription(tool.description);
  $('empty').hidden = true;
  $('tool').hidden = false;
  $('tool-name').textContent = tool.name;
  $('tool-desc').textContent = prose;
  const tagBox = $('tool-tags');
  tagBox.replaceChildren(...tags.map((t) => h('span', { class: 'chip', text: t })));
  const ann = tool.annotations || {};
  if (ann.readOnlyHint) tagBox.append(h('span', { class: 'chip', text: 'read-only' }));
  if (ann.destructiveHint) tagBox.append(h('span', { class: 'chip', text: 'destructive' }));
  $('btn-raw').setAttribute('aria-pressed', 'false');
  $('raw').hidden = true;
  $('fields').hidden = false;
  $('form-error').textContent = '';
  buildFields(tool.inputSchema || {}, state.argsByTool.get(tool.name));
  const previous = state.resultsByTool.get(tool.name);
  if (previous) renderResult(previous);
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
  const type = primaryType(schema) || 'any';
  return schema.format ? `${type} · ${schema.format}` : type;
}

/** A plausible example value for a schema, used to seed JSON fields. */
function exampleFor(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 5) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const variant = schema.oneOf?.[0] || schema.anyOf?.[0];
  if (variant) return exampleFor(variant, depth + 1);
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...schema.allOf.map((s) => exampleFor(s, depth + 1)).filter((v) => v && typeof v === 'object')
    );
  }
  switch (primaryType(schema)) {
    case 'object': {
      const out = {};
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      const keys = Object.keys(props);
      const chosen = required.size ? keys.filter((k) => required.has(k)) : keys.slice(0, 8);
      for (const key of chosen) out[key] = exampleFor(props[key], depth + 1);
      return out;
    }
    case 'array':
      return [exampleFor(schema.items || {}, depth + 1)].filter((v) => v !== null);
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

function buildFields(schema, saved) {
  const box = $('fields');
  box.replaceChildren();
  state.fields = [];
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
    const prop = props[name] || {};
    const kind = fieldKind(prop);
    const id = `f-${index}`;
    const isRequired = required.has(name);
    let input;
    if (kind === 'enum' || kind === 'boolean') {
      const options = kind === 'boolean' ? [true, false] : prop.enum;
      input = h(
        'select',
        { id },
        h('option', { value: '', text: isRequired ? 'Choose…' : '(not set)' }),
        options.map((v) => h('option', { value: String(v), text: String(v) }))
      );
    } else if (
      kind === 'list' ||
      kind === 'json' ||
      (kind === 'string' && (prop.maxLength || 0) > 200)
    ) {
      input = h('textarea', {
        id,
        rows: kind === 'json' ? 6 : 3,
        spellcheck: 'false',
        placeholder: kind === 'list' ? 'One value per line' : kind === 'json' ? 'JSON' : undefined,
      });
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
      kind === 'json'
        ? h(
            'div',
            { class: 'param-tools' },
            h('button', {
              type: 'button',
              class: 'btn ghost small',
              text: 'Insert example',
              onclick: () => {
                input.value = JSON.stringify(exampleFor(prop), null, 2);
                input.focus();
              },
            })
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
  else if (field.kind === 'json') field.input.value = JSON.stringify(value, null, 2);
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
      if (field.kind === 'json') {
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

async function runTool() {
  if (state.running || !state.selected || !state.client) return;
  const { args, error } = currentArgs();
  $('form-error').textContent = error || '';
  if (error) return;
  const tool = state.selected;
  state.argsByTool.set(tool.name, args);
  state.running = true;
  $('btn-run').disabled = true;
  $('result').hidden = false;
  $('result').dataset.running = 'true';
  $('result-status').replaceChildren(h('span', { text: `Calling ${tool.name}…` }));

  const firstId = state.client.nextId;
  const started = performance.now();
  let result;
  let failure;
  try {
    result = await state.client.callTool(tool.name, args);
  } catch (err) {
    failure = err;
  }
  const ms = Math.round(performance.now() - started);
  const exchange = findExchange(firstId);
  const record = { tool: tool.name, args, result, failure, ms, exchange };
  state.resultsByTool.set(tool.name, record);
  state.running = false;
  $('btn-run').disabled = false;
  if (state.selected?.name === tool.name) renderResult(record);
}

function findExchange(firstId) {
  const out = [...state.traffic]
    .reverse()
    .find(
      (e) => e.direction === 'out' && e.message?.method === 'tools/call' && e.message.id >= firstId
    );
  if (!out) return {};
  const back = state.traffic.find(
    (e) => e.direction === 'in' && e.message && e.message.id === out.message.id
  );
  const httpError = !back
    ? [...state.traffic].reverse().find((e) => e.direction === 'in' && e.status >= 400)
    : null;
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
      failure instanceof McpHttpError
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
  for (const button of document.querySelectorAll('.tabs [role="tab"]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  $('result-output').hidden = tab !== 'output';
  $('result-rpc').hidden = tab !== 'rpc';
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
    const suffix = msg.method === 'tools/call' && msg.params?.name ? ` · ${msg.params.name}` : '';
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
  const auth = Boolean(client.token) || state.config.inboundAuth === 'bearer';
  const sse = client.transport === 'sse';
  const cursor = {
    mcpServers: {
      [name]: { url, ...(auth ? { headers: { Authorization: 'Bearer YOUR_TOKEN' } } : {}) },
    },
  };
  const vscode = {
    ...(auth
      ? {
          inputs: [
            {
              type: 'promptString',
              id: 'mcp-token',
              description: 'MCP_AUTH_TOKEN',
              password: true,
            },
          ],
        }
      : {}),
    servers: {
      [name]: {
        type: sse ? 'sse' : 'http',
        url,
        ...(auth ? { headers: { Authorization: 'Bearer ${input:mcp-token}' } } : {}),
      },
    },
  };
  return [
    {
      title: 'Claude Code',
      code: `claude mcp add --transport ${sse ? 'sse' : 'http'} ${name} ${url}${auth ? ' \\\n  --header "Authorization: Bearer $MCP_AUTH_TOKEN"' : ''}`,
    },
    { title: 'Cursor', note: '.cursor/mcp.json', code: JSON.stringify(cursor, null, 2) },
    { title: 'VS Code', note: '.vscode/mcp.json', code: JSON.stringify(vscode, null, 2) },
    {
      title: 'MCP Inspector',
      code: 'npx @modelcontextprotocol/inspector',
      foot: `Choose ${sse ? 'SSE' : 'Streamable HTTP'}, enter ${url}${auth ? ' and add the Authorization header' : ''}.`,
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
  $('btn-close-clients').addEventListener('click', () => $('clients').close());
  $('clients').addEventListener('click', (event) => {
    if (event.target === $('clients')) $('clients').close();
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
  for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  $('btn-clear').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.traffic = [];
    $('traffic-list').replaceChildren();
    $('traffic-count').textContent = '';
  });
  $('kbd-hint').replaceChildren(
    h('kbd', { text: isMac ? '⌘' : 'Ctrl' }),
    ' ',
    h('kbd', { text: 'Enter' })
  );
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('tool').hidden) {
      event.preventDefault();
      runTool();
    } else if (event.key === '/' && !typing && !$('workspace').hidden) {
      event.preventDefault();
      $('search').focus();
    }
  });
}

async function init() {
  state.config = await loadConfig();
  setupConnectForm();
  wire();
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
