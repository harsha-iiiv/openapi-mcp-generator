/**
 * The playground's protocol client (playground/mcp-client.js) against the MCP
 * reference server (@modelcontextprotocol/server-everything), over Streamable
 * HTTP, HTTP+SSE and the relay: tools, resources, prompts, completion, logging,
 * elicitation, sampling, roots, progress, cancellation and custom headers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  McpClient,
  McpCancelledError,
  McpError,
  validateHeaders,
  parseWwwAuthenticate,
  bearerChallenge,
  explainHttpError,
} from '../playground/mcp-client.js';
import { createRelay } from '../relay/src/index.ts';

// The reference server logs every request to stdout; keep test output readable.
const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
const quietErr = vi.spyOn(console, 'error').mockImplementation(() => {});

interface Running {
  base: string;
  close(): Promise<void>;
}

async function startEverything(kind: 'streamableHttp' | 'sse'): Promise<Running> {
  const mod = await import(`@modelcontextprotocol/server-everything/dist/transports/${kind}.js`);
  const created = mod.createApp();
  const app = created.app ?? created;
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await created.shutdown?.().catch?.(() => {});
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const text = (result: any): string =>
  (result?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

const until = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A client wired like the playground: real hooks for every server request. */
function playgroundClient(url: string, extra: Record<string, unknown> = {}) {
  const requests: any[] = [];
  const notifications: any[] = [];
  const traffic: any[] = [];
  const client = new McpClient({
    url,
    roots: [{ uri: 'file:///workspace/demo', name: 'Demo' }],
    onServerRequest: async (msg: any) => {
      requests.push(msg);
      if (msg.method === 'elicitation/create') {
        return {
          action: 'accept',
          content: { name: 'Ada', check: true, email: 'ada@example.com', integer: 7 },
        };
      }
      if (msg.method === 'sampling/createMessage') {
        return {
          role: 'assistant',
          content: { type: 'text', text: 'A reply typed by a human.' },
          model: 'human',
          stopReason: 'endTurn',
        };
      }
      return undefined;
    },
    onNotification: (msg: any) => notifications.push(msg),
    onTraffic: (e: any) => traffic.push(e),
    ...extra,
  });
  return { client, requests, notifications, traffic };
}

afterAll(() => {
  quiet.mockRestore();
  quietErr.mockRestore();
});

describe('client helpers', () => {
  it('validates custom headers and refuses the ones the client manages', () => {
    expect(validateHeaders({ 'X-API-Key': ' k ', Authorization: 'Bearer t' })).toEqual({
      'x-api-key': 'k',
      authorization: 'Bearer t',
    });
    for (const name of ['content-type', 'Accept', 'mcp-session-id', 'MCP-Protocol-Version']) {
      expect(() => validateHeaders({ [name]: 'x' }), name).toThrow(/managed by the client/);
    }
    expect(() => validateHeaders({ 'bad name': 'x' })).toThrow(/not a valid header name/);
    expect(() => validateHeaders({ 'x-a': 'one\r\ntwo' })).toThrow(/line break/);
    expect(() =>
      validateHeaders([
        ['x-a', '1'],
        ['X-A', '2'],
      ])
    ).toThrow(/set twice/);
  });

  it('parses WWW-Authenticate challenges', () => {
    const header =
      'Bearer realm="mcp", error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write", Basic realm="x"';
    const all = parseWwwAuthenticate(header);
    expect(all.map((c) => c.scheme)).toEqual(['bearer', 'basic']);
    expect(bearerChallenge(header)).toMatchObject({
      scheme: 'bearer',
      error: 'invalid_token',
      scope: 'read write',
      resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    });
    expect(bearerChallenge('Bearer')).toMatchObject({ scheme: 'bearer' });
    expect(bearerChallenge(null)).toBeUndefined();
  });

  it('speaks about generated servers or remote servers depending on where it runs', () => {
    expect(explainHttpError(401, '', {})).toContain('MCP_AUTH_TOKEN');
    const hosted = explainHttpError(401, '', {
      mode: 'hosted',
      challenge: { scheme: 'bearer', resourceMetadata: 'https://x/' },
    });
    expect(hosted).toContain('OAuth');
    expect(hosted).not.toContain('MCP_AUTH_TOKEN');
    expect(explainHttpError(403, 'Origin not allowed', { mode: 'hosted' })).toContain('relay');
    expect(explainHttpError(403, 'Origin not allowed', {})).toContain('MCP_ALLOWED_ORIGINS');
  });

  it('flags OAuth on a hosted 401 and relay on a hosted network failure', async () => {
    const oauth = new McpClient({
      url: 'https://mcp.example.com/mcp',
      hints: 'hosted',
      fetch: async () =>
        new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
    });
    const e1: any = await oauth.connect().catch((e) => e);
    expect(e1.status).toBe(401);
    expect(e1.oauth).toBe(true);
    expect(e1.challenge.resourceMetadata).toContain('oauth-protected-resource');
    const offline = new McpClient({
      url: 'https://mcp.example.com/mcp',
      hints: 'hosted',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const e2: any = await offline.connect().catch((e) => e);
    expect(e2.name).toBe('McpNetworkError');
    expect(e2.relaySuggested).toBe(true);
  });

  it('asks the auth provider once on 401, then retries with the new token', async () => {
    let token = 'old';
    const seen: string[] = [];
    const client = new McpClient({
      url: 'https://mcp.example.com/mcp',
      auth: {
        getAccessToken: async () => token,
        onUnauthorized: async () => {
          token = 'new';
          return true;
        },
      },
      fetch: async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).authorization;
        seen.push(auth);
        if (auth !== 'Bearer new') return new Response('', { status: 401 });
        const body = JSON.parse(String(init.body));
        if (!body.id) return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 's', version: '1' },
          },
        });
      },
    });
    await client.connect();
    expect(seen.slice(0, 2)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('builds curl with env placeholders, never secret values', () => {
    const client = new McpClient({
      url: 'https://mcp.example.com/mcp',
      token: 'sekrit',
      hints: 'hosted',
      headers: { 'x-api-key': 'hunter2' },
    });
    const command = client.curl('tools/list', {});
    expect(command).toContain('-H "x-api-key: $X_API_KEY"');
    expect(command).toContain('$ACCESS_TOKEN');
    expect(command).not.toContain('sekrit');
    expect(command).not.toContain('hunter2');
  });
});

describe('client vs server-everything: Streamable HTTP', () => {
  let server: Running;
  let url: string;

  beforeAll(async () => {
    server = await startEverything('streamableHttp');
    url = `${server.base}/mcp`;
  });

  afterAll(async () => {
    await server?.close();
  });

  it('declares real client capabilities and keeps a session', async () => {
    const { client, traffic } = playgroundClient(url);
    const init = await client.connect();
    expect(init.capabilities.resources).toBeTruthy();
    expect(client.sessionId).toBeTruthy();
    const sent = traffic.find((e) => e.message?.method === 'initialize').message;
    expect(sent.params.capabilities).toEqual({
      roots: { listChanged: true },
      sampling: {},
      elicitation: { form: {}, url: {} },
    });
    // Capability-gated tools are registered once the server sees them.
    const tools = await until(async () => {
      const list = await client.listTools();
      return list.some((t: any) => t.name === 'trigger-sampling-request') ? list : undefined;
    });
    const names = tools.map((t: any) => t.name);
    for (const name of ['get-roots-list', 'trigger-elicitation-request', 'echo']) {
      expect(names).toContain(name);
    }
    await client.close();
  });

  it('sends custom headers to the server', async () => {
    const { client } = playgroundClient(url, { headers: { 'Mcp-Param-Region': 'eu-west' } });
    await client.connect();
    const result = await client.callTool('get-header-params', { region: 'eu-west' });
    expect(result.structuredContent).toMatchObject({ region: 'eu-west', regionHeader: 'eu-west' });
    await client.close();
  });

  it('lists, reads and subscribes to resources, and completes template arguments', async () => {
    const { client, notifications } = playgroundClient(url);
    await client.connect();
    const resources = await client.listResources();
    expect(resources.length).toBeGreaterThan(0);
    const read = await client.readResource(resources[0].uri);
    expect(read.contents[0].uri).toBe(resources[0].uri);
    const templates = await client.listResourceTemplates();
    expect(templates.length).toBeGreaterThan(0);
    const template = templates.find((t: any) => /\{resourceId\}/.test(t.uriTemplate));
    expect(template).toBeTruthy();
    const completion = await client.complete(
      { type: 'ref/resource', uri: template.uriTemplate },
      { name: 'resourceId', value: '1' }
    );
    expect(Array.isArray(completion.values)).toBe(true);
    // Subscribe, then have the server announce an update.
    const target = resources[0].uri;
    await client.subscribeResource(target);
    await client.callTool('trigger-resource-update', { uri: target }).catch(() => {});
    await until(() =>
      notifications.find(
        (n) => n.method === 'notifications/resources/updated' && n.params.uri === target
      )
    );
    await client.unsubscribeResource(target);
    await client.close();
  });

  it('lists and gets prompts, with context-aware completion', async () => {
    const { client } = playgroundClient(url);
    await client.connect();
    const prompts = await client.listPrompts();
    expect(prompts.map((p: any) => p.name)).toContain('completable-prompt');
    const ref = { type: 'ref/prompt', name: 'completable-prompt' };
    const departments = await client.complete(ref, { name: 'department', value: 'Eng' });
    expect(departments.values).toEqual(['Engineering']);
    const names = await client.complete(
      ref,
      { name: 'name', value: '' },
      { department: 'Engineering' }
    );
    expect(names.values).toEqual(['Alice', 'Bob', 'Charlie']);
    const prompt = await client.getPrompt('completable-prompt', {
      department: 'Engineering',
      name: 'Alice',
    });
    expect(prompt.messages[0].content.text).toContain('Alice');
    await client.close();
  });

  it('sets the log level and receives log messages', async () => {
    const { client, notifications } = playgroundClient(url);
    await client.connect();
    await client.setLoggingLevel('debug');
    await client.callTool('trigger-log-messages', {});
    const logs = await until(() => {
      const found = notifications.filter((n) => n.method === 'notifications/message');
      return found.length ? found : undefined;
    });
    expect(logs[0].params.level).toBeTruthy();
    await client.close();
  });

  it('answers elicitation, sampling and roots requests through the hook', async () => {
    const { client, requests } = playgroundClient(url);
    await client.connect();
    await until(async () =>
      (await client.listTools()).some((t: any) => t.name === 'trigger-sampling-request')
    );

    const elicited = await client.callTool('trigger-elicitation-request', {});
    const ask = requests.find((r) => r.method === 'elicitation/create');
    expect(ask.params.requestedSchema.type).toBe('object');
    expect(ask.params.requestedSchema.properties.name).toBeTruthy();
    expect(text(elicited)).toContain('Ada');

    const sampled = await client.callTool('trigger-sampling-request', {
      prompt: 'Hi',
      maxTokens: 20,
    });
    const sample = requests.find((r) => r.method === 'sampling/createMessage');
    expect(sample.params.maxTokens).toBe(20);
    expect(text(sampled)).toContain('A reply typed by a human.');

    const roots = await client.callTool('get-roots-list', {});
    expect(text(roots)).toContain('file:///workspace/demo');

    // Changing roots notifies the server, which asks again.
    const before = requests.filter((r) => r.method === 'roots/list').length;
    await client.setRoots([{ uri: 'file:///other', name: 'Other' }]);
    const again = await client.callTool('get-roots-list', {});
    expect(text(again)).toContain('file:///other');
    expect(requests.filter((r) => r.method === 'roots/list').length).toBeGreaterThan(before);
    await client.close();
  });

  it('answers -32601 for requests without a handler', async () => {
    const client = new McpClient({ url, capabilities: { elicitation: { form: {} } } });
    const traffic: any[] = [];
    client.onTraffic = (e: any) => traffic.push(e);
    await client.connect();
    await until(async () =>
      (await client.listTools()).some((t: any) => t.name === 'trigger-elicitation-request')
    );
    await client.callTool('trigger-elicitation-request', {}).catch(() => {});
    const reply = traffic.find((e) => e.direction === 'out' && e.message?.error);
    expect(reply.message.error.code).toBe(-32601);
    await client.close();
  });

  it('reports progress and cancels a running call', async () => {
    const { client, traffic } = playgroundClient(url);
    await client.connect();
    const progress: any[] = [];
    const done = await client.callTool(
      'trigger-long-running-operation',
      { duration: 0.6, steps: 3 },
      { onProgress: (p: any) => progress.push(p) }
    );
    expect(text(done)).toContain('completed');
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress[0].total).toBe(3);

    const controller = new AbortController();
    const running = client.callTool(
      'trigger-long-running-operation',
      { duration: 10, steps: 10 },
      { onProgress: () => controller.abort(), signal: controller.signal }
    );
    await expect(running).rejects.toBeInstanceOf(McpCancelledError);
    const cancelled = await until(() =>
      traffic.find((e) => e.direction === 'out' && e.message?.method === 'notifications/cancelled')
    );
    expect(typeof cancelled.message.params.requestId).toBe('number');
    // The session still works afterwards.
    expect(await client.ping()).toEqual({});
    await client.close();
  });

  it('works through the relay', async () => {
    const relay = createRelay({
      log: () => {},
      fetch: (target, init) => fetch(target.replace('https://everything.test', server.base), init),
    });
    const { client, requests } = playgroundClient('https://everything.test/mcp', {
      relayUrl: 'https://relay.test/',
      headers: { 'Mcp-Param-Region': 'ap-south' },
      fetch: (input: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set('origin', 'https://mcp.pidata.tech');
        return relay.fetch(new Request(input, { ...init, headers }));
      },
    });
    await client.connect();
    expect(client.sessionId).toBeTruthy();
    const header = await client.callTool('get-header-params', { region: 'ap-south' });
    expect(header.structuredContent.regionHeader).toBe('ap-south');
    await until(async () =>
      (await client.listTools()).some((t: any) => t.name === 'trigger-elicitation-request')
    );
    const elicited = await client.callTool('trigger-elicitation-request', {});
    expect(text(elicited)).toContain('Ada');
    expect(requests.some((r) => r.method === 'elicitation/create')).toBe(true);
    await client.close();
  });
});

describe('client vs server-everything: HTTP+SSE', () => {
  let server: Running;

  beforeAll(async () => {
    server = await startEverything('sse');
  });

  afterAll(async () => {
    await server?.close();
  });

  it('connects over HTTP+SSE and answers server requests on the stream', async () => {
    const { client, requests } = playgroundClient(`${server.base}/sse`, { transport: 'sse' });
    await client.connect();
    expect(client.transport).toBe('sse');
    expect(client.messageUrl).toContain('/message?sessionId=');
    const tools = await until(async () => {
      const list = await client.listTools();
      return list.some((t: any) => t.name === 'trigger-elicitation-request') ? list : undefined;
    });
    expect(tools.length).toBeGreaterThan(5);
    const elicited = await client.callTool('trigger-elicitation-request', {});
    expect(text(elicited)).toContain('Ada');
    expect(requests.some((r) => r.method === 'elicitation/create')).toBe(true);
    const progress: any[] = [];
    await client.callTool(
      'trigger-long-running-operation',
      { duration: 0.3, steps: 2 },
      { onProgress: (p: any) => progress.push(p) }
    );
    expect(progress).toHaveLength(2);
    await client.close();
  });

  it('auto-detects HTTP+SSE when the Streamable HTTP POST gets a 4xx', async () => {
    const { client } = playgroundClient(`${server.base}/sse`, { transport: 'auto' });
    await client.connect();
    expect(client.transport).toBe('sse');
    expect((await client.listTools()).length).toBeGreaterThan(5);
    await client.close();
  });

  it('works over HTTP+SSE through the relay, posting to the target endpoint', async () => {
    const targets: string[] = [];
    const relay = createRelay({
      log: () => {},
      fetch: (target, init) => {
        targets.push(`${init.method} ${target}`);
        return fetch(target.replace('https://everything.test', server.base), init);
      },
    });
    const { client } = playgroundClient('https://everything.test/sse', {
      transport: 'auto',
      relayUrl: 'https://relay.test/',
      fetch: (input: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set('origin', 'https://mcp.pidata.tech');
        return relay.fetch(new Request(input, { ...init, headers }));
      },
    });
    await client.connect();
    expect(client.transport).toBe('sse');
    expect(client.messageUrl).toMatch(/^https:\/\/everything\.test\/message\?sessionId=/);
    expect((await client.listTools()).length).toBeGreaterThan(5);
    expect(targets.some((t) => t.startsWith('POST https://everything.test/message'))).toBe(true);
    await client.close();
  });

  it('refuses an SSE endpoint on another origin', async () => {
    const client = new McpClient({
      url: 'https://mcp.example.com/sse',
      transport: 'sse',
      fetch: async () =>
        new Response('event: endpoint\ndata: https://evil.example.net/steal\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    await expect(client.connect()).rejects.toThrow(/another origin/);
  });
});

describe('client: JSON-RPC errors', () => {
  it('surfaces server errors as McpError', async () => {
    const server = await startEverything('streamableHttp');
    try {
      const client = new McpClient({ url: `${server.base}/mcp` });
      await client.connect();
      const error = await client.request('no/such/method', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(-32601);
      await client.close();
    } finally {
      await server.close();
    }
  });
});
