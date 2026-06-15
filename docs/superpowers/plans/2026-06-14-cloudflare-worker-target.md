# Cloudflare Worker Deploy Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--transport cloudflare-worker` target that emits a complete, deployable Cloudflare Workers MCP project (Streamable HTTP at `/mcp` via `createMcpHandler`).

**Architecture:** A new `cloudflare-worker` value on `TransportType`. A single new generator file (`src/generator/cloudflare-worker.ts`) emits all Worker files. `src/index.ts` gets an early branch that writes the Worker project and returns before any Node-target generation runs — so existing stdio/web/streamable-http output is byte-for-byte unchanged. Tool extraction (`extractToolsFromApi`) and tool-map serialization (`generateToolDefinitionMap`) are reused; request execution is reimplemented Workers-native (global `fetch`, build-time-emitted zod, no `eval`, no `node:https`).

**Tech Stack:** TypeScript, Cloudflare Agents SDK (`agents/mcp`), `@modelcontextprotocol/sdk`, `json-schema-to-zod` (generate-time), Wrangler, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-cloudflare-worker-target-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `src/types/index.ts` | Modify | Add `'cloudflare-worker'` to `TransportType`. |
| `src/generator/cloudflare-worker.ts` | Create | All Worker-file generators: index, tools, wrangler.jsonc, .dev.vars.example, package.json, tsconfig, README. |
| `src/generator/index.ts` | Modify | Re-export the new generator. |
| `src/index.ts` | Modify | CLI help text + early `cloudflare-worker` branch that writes the project and returns. |
| `tests/unit.test.ts` | Modify | Unit assertions on emitted Worker files + Node-output regression guard. |
| `tests/integration.test.ts` | Modify | Generate Worker project, `npm i`, `wrangler deploy --dry-run` with `tsc --noEmit` fallback. |
| `README.md` | Modify | Document `--transport cloudflare-worker`. |
| `CHANGELOG.md` | Modify | `[4.1.0]` Added entry. |
| `package.json` | Modify | Version bump to 4.1.0. |

---

## Task 1: Add `cloudflare-worker` to TransportType

**Files:**
- Modify: `src/types/index.ts:12`
- Test: `tests/unit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit.test.ts` (inside the top-level describe, near other type/extraction tests):

```ts
import { generateCloudflareWorkerFiles } from '../src/generator/cloudflare-worker.js';

describe('cloudflare-worker target', () => {
  it('exposes a generator that returns the expected file set', () => {
    const files = generateCloudflareWorkerFiles(
      // minimal stub: empty tools, name/version
      { tools: [], serverName: 'test-mcp', serverVersion: '0.1.0', securitySchemes: undefined, baseUrl: 'https://api.example.com' }
    );
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        '.dev.vars.example',
        'README.md',
        'package.json',
        'src/index.ts',
        'src/tools.ts',
        'tsconfig.json',
        'wrangler.jsonc',
      ].sort()
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "cloudflare-worker target"`
Expected: FAIL — `Cannot find module '../src/generator/cloudflare-worker.js'` (module not created yet).

- [ ] **Step 3: Make the minimal type change**

In `src/types/index.ts`, change line 12 from:

```ts
export type TransportType = 'stdio' | 'web' | 'streamable-http';
```

to:

```ts
export type TransportType = 'stdio' | 'web' | 'streamable-http' | 'cloudflare-worker';
```

- [ ] **Step 4: Leave the test failing for now**

The test still fails (module not created). That's expected — Task 2 creates it. Do not commit yet.

- [ ] **Step 5: Commit the type change alone**

```bash
git add src/types/index.ts
git commit -m "feat: add cloudflare-worker to TransportType"
```

---

## Task 2: Create the Cloudflare Worker generator module

**Files:**
- Create: `src/generator/cloudflare-worker.ts`
- Modify: `src/generator/index.ts`
- Test: `tests/unit.test.ts` (test from Task 1)

This module is the heart of the feature. It exports one orchestration function returning an array of `{ path, content }`, plus the per-file generators. All emitted code is Workers-native: global `fetch`, no `node:https`/`process.env`, no runtime `eval`.

- [ ] **Step 1: Create the module with the file-set contract and types**

Create `src/generator/cloudflare-worker.ts`:

```ts
/**
 * Generator for a Cloudflare Workers MCP server project.
 *
 * Emits a complete, deployable Worker that serves the generated MCP server over
 * Streamable HTTP at /mcp using the Cloudflare Agents SDK `createMcpHandler`.
 * Reuses tool extraction + the shared tool-definition-map serialization; the
 * request-execution path is reimplemented Workers-native (global fetch, no
 * node:https) and argument validation uses build-time-emitted zod (no runtime eval).
 */
import { OpenAPIV3 } from 'openapi-types';
import { McpToolDefinition } from '../types/index.js';
import { generateToolDefinitionMap } from '../utils/code-gen.js';

/** A single generated file, relative to the output project root. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** Inputs needed to generate the full Worker project. */
export interface CloudflareWorkerGenInput {
  tools: McpToolDefinition[];
  serverName: string;
  serverVersion: string;
  securitySchemes: OpenAPIV3.ComponentsObject['securitySchemes'];
  baseUrl: string;
}

/**
 * Generate every file for the Worker project. Returned paths are relative to the
 * output directory (e.g. "src/index.ts").
 */
export function generateCloudflareWorkerFiles(input: CloudflareWorkerGenInput): GeneratedFile[] {
  return [
    { path: 'src/index.ts', content: generateWorkerIndex(input) },
    { path: 'src/tools.ts', content: generateWorkerToolsFile(input) },
    { path: 'wrangler.jsonc', content: generateWranglerConfig(input) },
    { path: '.dev.vars.example', content: generateDevVarsExample(input) },
    { path: 'package.json', content: generateWorkerPackageJson(input) },
    { path: 'tsconfig.json', content: generateWorkerTsconfig() },
    { path: 'README.md', content: generateWorkerReadme(input) },
  ];
}
```

- [ ] **Step 2: Add the `src/tools.ts` generator (reuses serialization, adds zod shapes)**

Append to `src/generator/cloudflare-worker.ts`. This reuses `generateToolDefinitionMap` for the embedded map and emits a `zodShape` per tool built at generate time from the JSON Schema's top-level properties (so no runtime eval is needed; the MCP SDK consumes a plain zod-shape object).

```ts
import { jsonSchemaToZod } from 'json-schema-to-zod';

/**
 * Build a zod *shape source string* (the object passed as the 3rd arg to
 * server.tool) from a tool's JSON Schema. We emit `{ propName: z.<...>, ... }`.
 * Each property's zod is produced at generate time via json-schema-to-zod, so the
 * Worker ships real zod with no runtime eval.
 */
function generateZodShapeSource(tool: McpToolDefinition): string {
  const schema = tool.inputSchema;
  if (typeof schema === 'boolean' || !schema || typeof schema !== 'object') return '{}';
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  const required = new Set(
    Array.isArray((schema as { required?: string[] }).required)
      ? (schema as { required?: string[] }).required!
      : []
  );
  if (!properties || Object.keys(properties).length === 0) return '{}';

  const entries = Object.entries(properties).map(([key, propSchema]) => {
    // json-schema-to-zod emits a full `z....` expression for the sub-schema.
    let zodExpr: string;
    try {
      zodExpr = jsonSchemaToZod(propSchema as object);
    } catch {
      zodExpr = 'z.any()';
    }
    // Strip a leading "z.object(...)" wrapper artifact is unnecessary here since
    // propSchema is a single property; json-schema-to-zod returns the bare expr.
    if (!required.has(key)) zodExpr = `${zodExpr}.optional()`;
    return `    ${JSON.stringify(key)}: ${zodExpr}`;
  });

  return `{\n${entries.join(',\n')}\n  }`;
}

export function generateWorkerToolsFile(input: CloudflareWorkerGenInput): string {
  const mapEntries = generateToolDefinitionMap(input.tools, input.securitySchemes);
  const shapeEntries = input.tools
    .map((t) => `  [${JSON.stringify(t.name)}, ${generateZodShapeSource(t)}],`)
    .join('\n');

  return `/**
 * Tool definitions + zod input shapes for the generated MCP Worker.
 * Generated by openapi-mcp-generator. Do not edit by hand.
 */
import { z } from 'zod';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  method: string;
  pathTemplate: string;
  executionParameters: { name: string; in: string }[];
  requestBodyContentType?: string;
  securityRequirements: any[];
  tags: string[];
  deprecated: boolean;
}

export const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([
${mapEntries}
]);

/** Build-time zod input shapes, keyed by tool name (consumed by server.tool). */
export const toolZodShapes: Map<string, Record<string, z.ZodTypeAny>> = new Map([
${shapeEntries}
]);
`;
}
```

- [ ] **Step 3: Add the `src/index.ts` generator (verified createMcpHandler signature)**

Append. Uses the verified `createMcpHandler(server, options?)` signature and `executeApiTool` defined in the same emitted file.

```ts
export function generateWorkerIndex(input: CloudflareWorkerGenInput): string {
  return `/**
 * Cloudflare Worker MCP server (Streamable HTTP at /mcp).
 * Generated by openapi-mcp-generator. Deploy with: npx wrangler deploy
 */
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolDefinitionMap, toolZodShapes, type McpToolDefinition } from './tools.js';

const SERVER_NAME = ${JSON.stringify(input.serverName)};
const SERVER_VERSION = ${JSON.stringify(input.serverVersion)};

export interface Env {
  /** Upstream API base URL (set in wrangler.jsonc vars or as a secret). */
  API_BASE_URL?: string;
  /** Secrets are injected at runtime via \`wrangler secret put\`. */
  [key: string]: string | undefined;
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const [name, def] of toolDefinitionMap) {
    const shape = toolZodShapes.get(name) ?? {};
    server.tool(name, def.description, shape, (args: Record<string, unknown>) =>
      executeApiTool(def, args, env)
    );
  }
  return server;
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    createMcpHandler(createServer(env), { route: '/mcp' })(request, env, ctx),
} satisfies ExportedHandler<Env>;

const DEFAULT_BASE_URL = ${JSON.stringify(input.baseUrl)};

/** Execute one tool by issuing the upstream HTTP request via global fetch. */
async function executeApiTool(
  def: McpToolDefinition,
  args: Record<string, unknown>,
  env: Env
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const baseUrl = (env.API_BASE_URL || DEFAULT_BASE_URL || '').replace(/\\/+$/, '');
    // Substitute path params.
    let pathName = def.pathTemplate;
    const queryParams = new URLSearchParams();
    let bodyArg: unknown;

    for (const p of def.executionParameters) {
      const value = args[p.name];
      if (value === undefined || value === null) continue;
      if (p.in === 'path') {
        pathName = pathName.replace(
          new RegExp('\\\\{' + p.name + '\\\\}', 'g'),
          encodeURIComponent(String(value))
        );
      } else if (p.in === 'query') {
        if (Array.isArray(value)) queryParams.set(p.name, value.map(String).join(','));
        else queryParams.set(p.name, String(value));
      } else if (p.in === 'header') {
        // collected below into headers
      }
    }
    if ('requestBody' in args) bodyArg = (args as { requestBody?: unknown }).requestBody;

    const url = new URL(baseUrl + pathName);
    queryParams.forEach((v, k) => url.searchParams.set(k, v));

    const headers: Record<string, string> = { accept: 'application/json' };
    for (const p of def.executionParameters) {
      if (p.in === 'header' && args[p.name] != null) headers[p.name] = String(args[p.name]);
    }

    let body: string | undefined;
    if (bodyArg !== undefined && def.requestBodyContentType) {
      headers['content-type'] = def.requestBodyContentType;
      body =
        def.requestBodyContentType.includes('json') ? JSON.stringify(bodyArg) : String(bodyArg);
    }

    applyAuth(def, env, headers, url);

    const response = await fetch(url.toString(), { method: def.method.toUpperCase(), headers, body });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: \`Upstream API error \${response.status}: \${text}\` }],
      };
    }
    const pretty = contentType.includes('json')
      ? safePrettyJson(text)
      : text;
    return { content: [{ type: 'text', text: pretty }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text', text: \`Tool execution failed: \${message}\` }] };
  }
}

function safePrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Inject auth from env per the tool's security requirements. */
function applyAuth(
  def: McpToolDefinition,
  env: Env,
  headers: Record<string, string>,
  url: URL
): void {
  // securityRequirements is an array of { schemeName: scopes[] } objects.
  for (const requirement of def.securityRequirements) {
    for (const schemeName of Object.keys(requirement)) {
      const upper = schemeName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      // Bearer / generic token.
      const token = env[\`\${upper}_TOKEN\`] ?? env.API_TOKEN;
      if (token) {
        headers['authorization'] = \`Bearer \${token}\`;
        return;
      }
      // API key (header by convention; falls back to query \`apiKey\`).
      const apiKey = env[\`\${upper}_API_KEY\`] ?? env.API_KEY;
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        return;
      }
      // Basic auth.
      const user = env[\`\${upper}_USERNAME\`] ?? env.API_USERNAME;
      if (user != null) {
        const pass = env[\`\${upper}_PASSWORD\`] ?? env.API_PASSWORD ?? '';
        headers['authorization'] = 'Basic ' + btoa(\`\${user}:\${pass}\`);
        return;
      }
    }
  }
}
`;
}
```

- [ ] **Step 4: Add wrangler.jsonc, .dev.vars.example, package.json, tsconfig, README generators**

Append:

```ts
export function generateWranglerConfig(input: CloudflareWorkerGenInput): string {
  // compatibility_date pinned to a known-good date; nodejs_compat enables Node built-ins
  // some MCP/zod code paths expect. vars holds non-secret config only.
  return `{
  // Cloudflare Worker config. Docs: https://developers.cloudflare.com/workers/wrangler/configuration/
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(input.serverName)},
  "main": "src/index.ts",
  "compatibility_date": "2025-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  // Non-secret config. Secrets (API keys, tokens, passwords) must be set with
  // \`wrangler secret put <NAME>\` and are never stored here.
  "vars": {
    "API_BASE_URL": ${JSON.stringify(input.baseUrl)}
  }
}
`;
}

export function generateDevVarsExample(input: CloudflareWorkerGenInput): string {
  const lines = ['# Local development secrets for `wrangler dev`. Copy to `.dev.vars`.', '#', '# In production set these with: wrangler secret put <NAME>', ''];
  const schemes = input.securitySchemes ?? {};
  const names = Object.keys(schemes);
  if (names.length === 0) {
    lines.push('# This API declares no security schemes. Add secrets here if your API needs them, e.g.:');
    lines.push('# API_KEY="your-key"');
  } else {
    for (const name of names) {
      const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const scheme = schemes[name] as OpenAPIV3.SecuritySchemeObject;
      if (scheme && 'type' in scheme && scheme.type === 'http' && scheme.scheme === 'basic') {
        lines.push(`${upper}_USERNAME="..."`, `${upper}_PASSWORD="..."`);
      } else if (scheme && 'type' in scheme && scheme.type === 'http') {
        lines.push(`${upper}_TOKEN="..."`);
      } else {
        lines.push(`${upper}_API_KEY="..."`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function generateWorkerPackageJson(input: CloudflareWorkerGenInput): string {
  const data = {
    name: input.serverName,
    version: input.serverVersion,
    description: `Cloudflare Worker MCP server generated from OpenAPI spec for ${input.serverName}`,
    private: true,
    type: 'module',
    scripts: {
      dev: 'wrangler dev',
      deploy: 'wrangler deploy',
      'cf-typegen': 'wrangler types',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.10.0',
      agents: '^0.0.80',
      zod: '^3.24.3',
    },
    devDependencies: {
      '@cloudflare/workers-types': '^4.20250601.0',
      typescript: '^5.8.3',
      wrangler: '^4.0.0',
    },
  };
  return JSON.stringify(data, null, 2) + '\n';
}

export function generateWorkerTsconfig(): string {
  const data = {
    compilerOptions: {
      target: 'es2022',
      module: 'es2022',
      moduleResolution: 'bundler',
      lib: ['es2022'],
      types: ['@cloudflare/workers-types'],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  };
  return JSON.stringify(data, null, 2) + '\n';
}

export function generateWorkerReadme(input: CloudflareWorkerGenInput): string {
  const schemes = Object.keys(input.securitySchemes ?? {});
  const secretLines =
    schemes.length === 0
      ? '   (This API declares no security schemes — add any secrets your API needs.)'
      : schemes
          .map((n) => {
            const upper = n.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            return `   npx wrangler secret put ${upper}_API_KEY   # or _TOKEN / _USERNAME+_PASSWORD`;
          })
          .join('\n');
  return `# ${input.serverName}

A remote MCP server for **${input.serverName}**, generated by [openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator) and ready to deploy on Cloudflare Workers.

It serves the Model Context Protocol over **Streamable HTTP** at \`/mcp\`.

## Deploy

1. Install dependencies:

   \`\`\`bash
   npm install
   \`\`\`

2. Set your upstream API secrets (encrypted, per-Worker):

\`\`\`bash
${secretLines}
\`\`\`

3. Deploy to your own Cloudflare account (Wrangler will prompt you to log in):

   \`\`\`bash
   npx wrangler deploy
   \`\`\`

   Your server will be live at \`https://${input.serverName}.<your-subdomain>.workers.dev/mcp\`.

## Local development

\`\`\`bash
cp .dev.vars.example .dev.vars   # fill in your secrets
npm run dev                      # http://localhost:8787/mcp
\`\`\`

## Configuration

- Non-secret config (e.g. \`API_BASE_URL\`) lives in \`wrangler.jsonc\` under \`vars\`.
- Secrets (API keys, tokens, passwords) are set with \`wrangler secret put\` and never committed.

## Connect a client

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or, from Claude Desktop, the [mcp-remote](https://www.npmjs.com/package/mcp-remote) proxy pointed at your \`/mcp\` URL.
`;
}
```

- [ ] **Step 5: Re-export from the generator index**

Add to `src/generator/index.ts` (after the existing exports):

```ts
export * from './cloudflare-worker.js';
```

- [ ] **Step 6: Run the Task 1 unit test to verify it passes**

Run: `npx vitest run -t "cloudflare-worker target"`
Expected: PASS (the seven expected paths are returned).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/generator/cloudflare-worker.ts src/generator/index.ts tests/unit.test.ts
git commit -m "feat: add Cloudflare Worker generator module"
```

---

## Task 3: Add content-assertion unit tests for the generated files

**Files:**
- Test: `tests/unit.test.ts`

These tests lock the Workers-native invariants (no eval, no node:https, vars/secret split, correct SDK imports).

- [ ] **Step 1: Write the failing tests**

Add inside the `describe('cloudflare-worker target', ...)` block:

```ts
import { getToolsFromOpenApi } from '../src/api.js';
import path from 'node:path';

const PETSTORE = path.join(__dirname, 'fixtures', 'real-petstore.json');

it('generates Workers-native index.ts (verified createMcpHandler usage, no node/eval)', async () => {
  const tools = await getToolsFromOpenApi(PETSTORE, { dereference: true });
  const files = generateCloudflareWorkerFiles({
    tools,
    serverName: 'petstore-mcp',
    serverVersion: '1.0.0',
    securitySchemes: undefined,
    baseUrl: 'https://petstore3.swagger.io/api/v3',
  });
  const index = files.find((f) => f.path === 'src/index.ts')!.content;

  expect(index).toContain("import { createMcpHandler } from 'agents/mcp'");
  expect(index).toContain("import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'");
  expect(index).toContain("{ route: '/mcp' }");
  expect(index).toContain('await fetch(');
  // Workers-native invariants:
  expect(index).not.toContain('node:https');
  expect(index).not.toContain('process.env');
  expect(index).not.toMatch(/\beval\s*\(/);
});

it('embeds tool names and build-time zod shapes in tools.ts (no runtime eval)', async () => {
  const tools = await getToolsFromOpenApi(PETSTORE, { dereference: true });
  const files = generateCloudflareWorkerFiles({
    tools,
    serverName: 'petstore-mcp',
    serverVersion: '1.0.0',
    securitySchemes: undefined,
    baseUrl: 'https://petstore3.swagger.io/api/v3',
  });
  const toolsFile = files.find((f) => f.path === 'src/tools.ts')!.content;

  expect(tools.length).toBeGreaterThan(0);
  expect(toolsFile).toContain(JSON.stringify(tools[0].name));
  expect(toolsFile).toContain('export const toolDefinitionMap');
  expect(toolsFile).toContain('export const toolZodShapes');
  expect(toolsFile).toContain("import { z } from 'zod'");
  expect(toolsFile).not.toMatch(/\beval\s*\(/);
});

it('wrangler.jsonc keeps secrets out and uses nodejs_compat + vars', () => {
  const files = generateCloudflareWorkerFiles({
    tools: [],
    serverName: 'petstore-mcp',
    serverVersion: '1.0.0',
    securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    baseUrl: 'https://petstore3.swagger.io/api/v3',
  });
  const wrangler = files.find((f) => f.path === 'wrangler.jsonc')!.content;
  const devVars = files.find((f) => f.path === '.dev.vars.example')!.content;

  expect(wrangler).toContain('"nodejs_compat"');
  expect(wrangler).toContain('"API_BASE_URL"');
  expect(wrangler).toContain('"main": "src/index.ts"');
  // No secret values ever land in wrangler.jsonc.
  expect(wrangler).not.toMatch(/API_KEY/i);
  // .dev.vars.example documents the secret instead.
  expect(devVars).toContain('APIKEYAUTH_API_KEY');
});
```

- [ ] **Step 2: Run to verify they pass (or surface real bugs)**

Run: `npx vitest run -t "cloudflare-worker target"`
Expected: all PASS. If `tools.ts` lacks a zod import or the index uses `process.env`, fix the generator in `src/generator/cloudflare-worker.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add tests/unit.test.ts
git commit -m "test: assert Workers-native invariants for cloudflare-worker output"
```

---

## Task 4: Wire the CLI branch in src/index.ts

**Files:**
- Modify: `src/index.ts` (help text near line 69-71; new early branch after `serverVersion` is computed, before `generateMcpServerCode` at line 213)
- Test: `tests/integration.test.ts` (Task 5 covers the e2e; this task adds the wiring + a smoke import)

- [ ] **Step 1: Update the `--transport` help text**

In `src/index.ts`, replace the `-t, --transport` option description (line ~70):

```ts
  .option(
    '-t, --transport <type>',
    'Server transport type: "stdio", "web", "streamable-http", or "cloudflare-worker" (default: "stdio")'
  )
```

- [ ] **Step 2: Add the import**

Near the other generator imports at the top of `src/index.ts` (the `from './generator/index.js'` block), add `generateCloudflareWorkerFiles` to the import list:

```ts
  generateCustomAuthStub,
  generateCloudflareWorkerFiles,
} from './generator/index.js';
```

- [ ] **Step 3: Add the early cloudflare-worker branch**

In `runGenerator`, immediately after `const serverVersion = ...` (line ~211, before `console.error('Generating server code...')`), insert:

```ts
    // Cloudflare Worker target: emit a self-contained Workers project and return
    // early. None of the Node-target generation below runs, so existing
    // stdio/web/streamable-http output is unaffected.
    if (options.transport === 'cloudflare-worker') {
      // Warn about flags that do not apply to the Worker target.
      for (const [flag, present] of [
        ['--header-passthrough', Array.isArray(options.headerPassthrough) && options.headerPassthrough.length > 0],
        ['--custom-auth', Boolean(options.customAuth)],
        ['--port', options.port !== undefined],
        ['--insecure', Boolean(options.insecure)],
        ['--generate-lib', Boolean(options.generateLib)],
      ] as const) {
        if (present) {
          console.error(`Warning: ${flag} is not supported with --transport cloudflare-worker; ignoring.`);
        }
      }

      console.error('Generating Cloudflare Worker project...');
      const tools = extractToolsFromApi(api, options.defaultInclude ?? true, options.maxToolNameLength ?? 64);
      const resolvedBaseUrl = determineBaseUrl(api, options.baseUrl) || '';
      const files = generateCloudflareWorkerFiles({
        tools,
        serverName,
        serverVersion,
        securitySchemes: api.components?.securitySchemes,
        baseUrl: resolvedBaseUrl,
      });

      await fs.mkdir(srcDir, { recursive: true });
      for (const file of files) {
        const dest = path.join(outputDir, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.content);
        console.error(` -> Created ${dest}`);
      }

      console.error('\n---');
      console.error(`Cloudflare Worker MCP project '${serverName}' generated at: ${outputDir}`);
      console.error('\nNext steps:');
      console.error(`1. cd ${outputDir}`);
      console.error(`2. npm install`);
      console.error(`3. Set secrets: npx wrangler secret put <NAME>  (see README.md / .dev.vars.example)`);
      console.error(`4. Deploy: npx wrangler deploy`);
      console.error('---');
      return;
    }

```

- [ ] **Step 4: Add the two needed imports if missing**

`extractToolsFromApi` and `determineBaseUrl` must be imported in `src/index.ts`. Check the top of the file; if absent, add:

```ts
import { extractToolsFromApi } from './parser/extract-tools.js';
import { determineBaseUrl } from './utils/url.js';
```

Run: `grep -n "extractToolsFromApi\|determineBaseUrl" src/index.ts` — add only the ones not already imported.

- [ ] **Step 5: Build and typecheck**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 6: Manual smoke test**

```bash
node bin/openapi-mcp-generator.js -i tests/fixtures/real-petstore.json -o /tmp/cf-smoke --transport cloudflare-worker --force
ls /tmp/cf-smoke /tmp/cf-smoke/src
```
Expected: `wrangler.jsonc`, `package.json`, `tsconfig.json`, `.dev.vars.example`, `README.md` at root; `index.ts`, `tools.ts` in `src/`. No Node-target files (`.env.example`, `jest.config.js`, `.eslintrc.json`) present.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire --transport cloudflare-worker into the CLI"
```

---

## Task 5: Integration test — generate, install, dry-run deploy

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Add a new test to `tests/integration.test.ts`, mirroring the existing temp-dir + bin-entry pattern already used in that file (reuse its `cliEntry`/temp-dir helpers; do not invent new ones — read the file first and match its style):

```ts
it('generates a Cloudflare Worker project that builds', async () => {
  const outDir = path.join(repoRoot, `.test-tmp-cf-${Date.now()}`);
  try {
    execFileSync('node', [
      cliEntry,
      '-i', path.join(__dirname, 'fixtures', 'real-petstore.json'),
      '-o', outDir,
      '--transport', 'cloudflare-worker',
      '--force',
    ], { stdio: 'pipe' });

    // Files exist.
    for (const rel of ['wrangler.jsonc', 'package.json', 'tsconfig.json', 'src/index.ts', 'src/tools.ts']) {
      expect(fs.existsSync(path.join(outDir, rel)), `${rel} should exist`).toBe(true);
    }

    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: outDir, stdio: 'pipe' });

    // Prefer wrangler dry-run (real Workers bundler); fall back to tsc if it can't run offline.
    try {
      execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist'], { cwd: outDir, stdio: 'pipe' });
    } catch {
      execFileSync('npx', ['tsc', '--noEmit'], { cwd: outDir, stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}, 180_000);
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration.test.ts -t "Cloudflare Worker project"`
Expected: PASS. (First run installs deps + bundles; allow up to the 180s timeout.)

- [ ] **Step 3: If wrangler dry-run fails on a real bundling error, fix the generator**

If `wrangler deploy --dry-run` reports a real error (e.g. an unresolved import or invalid `wrangler.jsonc`), fix `src/generator/cloudflare-worker.ts` and re-run. The fallback to `tsc` only covers the offline-CI case, not genuine bundling bugs — do not let a real bundling error hide behind the fallback. Verify by running the wrangler command manually in the temp dir if needed.

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: integration test for cloudflare-worker target (dry-run deploy)"
```

---

## Task 6: Docs, CHANGELOG, version bump

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json:3`

- [ ] **Step 1: Document the flag in README**

In `README.md`, find the transport/usage section (search for `--transport` or `streamable-http`). Add a subsection:

```markdown
### Cloudflare Worker target

Generate a deployable Cloudflare Workers MCP server (Streamable HTTP at `/mcp`):

```bash
openapi-mcp-generator -i ./openapi.json -o ./my-mcp-worker --transport cloudflare-worker
cd my-mcp-worker
npm install
npx wrangler secret put API_KEY   # set upstream API secrets (see .dev.vars.example)
npx wrangler deploy               # logs into YOUR Cloudflare account and deploys
```

The generated project uses the Cloudflare Agents SDK (`createMcpHandler`), runs on the free
Workers tier (no Durable Objects), keeps non-secret config in `wrangler.jsonc` `vars`, and
reads secrets from the `env` binding. `--header-passthrough`, `--custom-auth`, `--port`,
`--insecure`, and `--generate-lib` do not apply to this target and are ignored with a warning.
```

- [ ] **Step 2: Add CHANGELOG entry**

In `CHANGELOG.md`, add above `## [4.0.1]`:

```markdown
## [4.1.0] - 2026-06-14

### Added

- `--transport cloudflare-worker`: generate a complete, deployable Cloudflare Workers
  MCP server that serves Streamable HTTP at `/mcp` via the Cloudflare Agents SDK
  (`createMcpHandler`). The user deploys with `npx wrangler deploy`, signing into their
  own Cloudflare account. Non-secret config goes in `wrangler.jsonc` `vars`; secrets are
  set with `wrangler secret put` and read from the `env` binding. Tool extraction and
  naming (including 64-char abbreviation) are shared with the existing targets; argument
  validation uses build-time-emitted zod (no runtime `eval`) and requests use the global
  `fetch` (no Node `https`). Existing stdio/web/streamable-http output is unchanged.
```

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "4.0.1"` to `"version": "4.1.0"`.

- [ ] **Step 4: Full validation suite**

Run:
```bash
npm run build && npm test && npm run format.check
```
Expected: build clean, all tests pass, format clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: document cloudflare-worker target; bump to 4.1.0"
```

---

## Task 7: Final regression guard — existing targets unchanged

**Files:**
- Test: verification only (no new files)

- [ ] **Step 1: Generate one project per existing transport and confirm no diff in shape**

```bash
node bin/openapi-mcp-generator.js -i tests/fixtures/real-petstore.json -o /tmp/reg-stdio --force
node bin/openapi-mcp-generator.js -i tests/fixtures/real-petstore.json -o /tmp/reg-web --transport web --force
node bin/openapi-mcp-generator.js -i tests/fixtures/real-petstore.json -o /tmp/reg-http --transport streamable-http --force
ls /tmp/reg-stdio /tmp/reg-stdio/src
```
Expected: stdio still emits `src/index.ts`, `package.json`, `.env.example`, `jest.config.js`, etc. — unchanged from before this feature. The cloudflare-worker branch is isolated by the early `return`, so these are untouched.

- [ ] **Step 2: Confirm the full test suite is green**

Run: `npm test`
Expected: all tests pass, including the pre-existing unit/integration tests.

- [ ] **Step 3: Clean up temp dirs**

```bash
rm -rf /tmp/reg-stdio /tmp/reg-web /tmp/reg-http /tmp/cf-smoke
```

---

## Self-Review Notes

- **Spec coverage:** CLI surface (T1, T4) · generated file set (T2) · createMcpHandler verified signature (T2 step 3) · no-eval/build-time zod (T2 step 2, T3) · Workers-native fetch/no node:https (T2 step 3, T3) · vars/secret hybrid (T2 step 4, T3) · warn-and-ignore inapplicable flags (T4 step 3) · runtime error handling (T2 step 3, `executeApiTool` try/catch + non-2xx) · unit + integration tests incl. dry-run + tsc fallback (T3, T5) · docs/CHANGELOG/version (T6) · Node-target regression guard (T4 step 6, T7). All spec sections map to a task.
- **Type consistency:** `generateCloudflareWorkerFiles` / `CloudflareWorkerGenInput` / `GeneratedFile` used identically across T1–T5. `toolDefinitionMap` + `toolZodShapes` defined in `src/tools.ts` (T2 step 2) and consumed in `src/index.ts` (T2 step 3). `executeApiTool(def, args, env)` signature consistent.
- **Version assumptions to verify at execution:** the `agents` SDK version (`^0.0.80`), `wrangler` (`^4`), and `@cloudflare/workers-types` date tag are best-known at plan time — T5's `npm install` + dry-run will surface any drift; bump to whatever the registry resolves if install fails. The `createMcpHandler` *signature* is verified; only the package *version pin* is provisional.
