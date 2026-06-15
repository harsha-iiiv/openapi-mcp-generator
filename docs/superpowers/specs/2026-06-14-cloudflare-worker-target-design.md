# Design: Cloudflare Worker deploy target

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Target version:** 4.1.0 (minor — additive, zero breaking changes)
**Issue/source:** User request — "deploy MCP servers on Cloudflare with one click, sign in with their own account." Based on Cloudflare's "Build a Remote MCP server" guide.

## Summary

Add a new `--transport cloudflare-worker` target to `openapi-mcp-generator`. It emits a
complete, deployable Cloudflare Workers project that serves the generated MCP server over
**Streamable HTTP** at `/mcp` using the Cloudflare Agents SDK `createMcpHandler()`
(stateless). The user deploys with `npx wrangler deploy`; Wrangler's own OAuth handles
"sign in with your own Cloudflare account." This tool generates code only — no hosting on
our side.

This is **option A** of a three-option monetization analysis (A: generate CF project;
B: + Deploy-to-Workers button; C: hosted SaaS). A is the open-source engine and the
foundation the eventual hosted product (C) would reuse. B and C are explicitly out of
scope for this spec and become their own spec/plan cycles.

## Goals

- A new `TransportType` value `cloudflare-worker`, purely additive to the existing
  `stdio | web | streamable-http` targets, which remain byte-for-byte unchanged.
- Generated project deploys with `wrangler deploy` and runs on the free Workers tier
  (no Durable Objects, no KV).
- Reuse the existing tool-extraction pipeline (names, 64-char abbreviation, JSON schemas,
  metadata) and tool-map serialization. Reimplement only the request-execution path,
  which must be Workers-native.
- Upstream-API credentials sourced the Cloudflare-native way: non-secret config in
  `wrangler.jsonc` `vars`; secrets via `wrangler secret put` exposed on the `env` binding.

## Non-goals (this release)

- No OAuth **to Cloudflare** in the generated code — that is Wrangler's responsibility.
- No Durable Objects / KV / stateful `McpAgent` variant. Our tools are stateless API
  proxies; `createMcpHandler()` is the correct fit.
- No "Deploy to Workers" button or self-contained git-repo packaging (that is option B).
- No hosted "paste a URL → deploy to your account" service (that is option C).
- `--header-passthrough` and `--custom-auth` are **not supported** in
  `cloudflare-worker` mode in this release. If passed, warn to stderr and ignore rather
  than emit broken code.

## Architecture

### CLI surface

- `TransportType = 'stdio' | 'web' | 'streamable-http' | 'cloudflare-worker'`.
- `--transport cloudflare-worker` selects the new target. Help text updated.
- Flags that don't apply to Workers (`--header-passthrough`, `--custom-auth`, `--port`)
  produce a clear stderr warning and are ignored.

### Generated project layout (into the existing `-o <dir>`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry. `export default { fetch }` builds a `createMcpHandler()` registering every tool, served at `/mcp`. |
| `src/tools.ts` | Embedded tool-definition map (reuses `generateToolDefinitionMap`) + build-time-emitted zod validators. |
| `wrangler.jsonc` | `name`, `main`, `compatibility_date`, `compatibility_flags: ["nodejs_compat"]`, and `vars` for non-secret config (API base URL, OAuth token URL/scopes). |
| `.dev.vars.example` | Documents local secrets (`API_KEY=...`); user copies to `.dev.vars`. |
| `package.json` | Workers-flavored: deps `@modelcontextprotocol/sdk`, `agents`; devDeps `wrangler`, `@cloudflare/workers-types`, `typescript`; scripts `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `cf-typegen`. |
| `tsconfig.json` | `@cloudflare/workers-types`, `module: esnext`, bundler resolution. |
| `README.md` | Deploy story: `npm i` → `wrangler secret put` → `wrangler deploy` → connect via MCP Inspector / `mcp-remote`. |

### Reuse vs. new

- **Reused as-is:** `extractToolsFromApi` (`src/parser/extract-tools.ts`) and
  `generateToolDefinitionMap` (`src/utils/code-gen.ts`).
- **New, Workers-native:** request execution using global `fetch` (no `node:https`),
  argument validation **without `eval`** (see below), auth injection reading from `env`.

This split is not a preference — it is required. The Node targets validate args at runtime
via `eval(jsonSchemaToZod(schema))` and use Node `https`. Workers forbid `eval` and have no
`node:https`, so the execution path must be rewritten regardless.

## Detailed design

### Generated `src/index.ts` (shape)

```ts
import { createMcpHandler } from "agents/mcp";
import { toolDefinitionMap, type McpToolDefinition } from "./tools.js";

const SERVER_NAME = "<server-name>";
const SERVER_VERSION = "<server-version>";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(
      { name: SERVER_NAME, version: SERVER_VERSION },
      (server) => {
        for (const [name, def] of toolDefinitionMap) {
          server.tool(name, def.description, def.zodShape, (args) =>
            executeApiTool(def, args, env)
          );
        }
      },
      { route: "/mcp" }
    );
    return handler(request, env, ctx);
  },
};
```

> Implementation note: the exact `createMcpHandler` import path and signature must be
> confirmed against the installed `agents` SDK version during implementation (verify via
> Context7 / the package's types). The shape above reflects the Cloudflare guide; the
> plan's first step is to pin the SDK version and confirm the API.

### Validation — no runtime `eval`

The Node target runs `eval(jsonSchemaToZod(schema))` at runtime. Workers forbid this.
Resolution: run `jsonSchemaToZod` **at generate time** and emit the resulting zod *source*
into `src/tools.ts`. The Worker ships real zod (same validation behavior and error messages
users already get from the Node targets) with zero runtime code generation. Reuses the
`json-schema-to-zod` dependency the generator already imports.

### `executeApiTool(def, args, env)` (Workers-native)

1. Substitute path params into `def.pathTemplate`; append query params from
   `def.executionParameters`.
2. Build headers; inject auth from `env` per `def.securityRequirements`:
   - `apiKey` → header or query param.
   - `http` bearer → `Authorization: Bearer ${env.TOKEN}`.
   - `http` basic → base64-encoded `env.USER:env.PASS` (empty password allowed, per
     RFC 7617, matching the 4.0.0 fix).
   - `oauth2` client-credentials → fetch a token from the configured token URL
     (token URL/scopes in `wrangler.jsonc` `vars`; client secret in `env`).
3. `fetch(url, { method, headers, body })` — global fetch, no `node:https`.
4. Parse the response (JSON vs text by `content-type`) and return MCP `content`.

### Credential split (the approved hybrid)

- **Non-secret** (API base URL, OAuth token URL, scopes) → `wrangler.jsonc` `vars`
  (visible, version-controlled).
- **Secret** (API keys, OAuth client secret, basic-auth password) → `wrangler secret put`
  → read from `env`. Never in code or `wrangler.jsonc`.

This mirrors the existing `.env` split in the Node targets.

## Generator code structure

- New `src/generator/cloudflare-worker.ts` exporting:
  `generateCloudflareWorkerIndex(...)`, `generateCloudflareToolsFile(...)`,
  `generateWranglerConfig(...)`, `generateCloudflareDevVarsExample(...)`,
  `generateCloudflareReadme(...)`. Exported through `src/generator/index.ts`
  (matches the one-file-per-target pattern).
- `src/index.ts` gains a `cloudflare-worker` branch writing these files. Worker-flavored
  `package.json` / `tsconfig.json` get their own generator paths (or a `transport` switch
  inside the existing functions) so Node output is unchanged.

## Error handling

**Generator side:**
- `cloudflare-worker` + inapplicable flag (`--header-passthrough`, `--custom-auth`,
  `--port`) → clear stderr warning, flag ignored.
- A security scheme that can't be mapped to a Worker auth path → emit a `// TODO:` note in
  the README secrets section so the user knows what to set.

**Generated runtime:**
- `executeApiTool` wraps `fetch` in try/catch and returns MCP error *content* (not a thrown
  500) on failure.
- Non-2xx upstream responses surface status + body text as tool error content.
- Missing required `env` secret → a clear "secret X not configured" message.

## Testing

**Unit (`tests/unit.test.ts`):**
- Generate a Worker from `real-petstore.json` and `sample-api.json`; assert
  `src/index.ts` / `src/tools.ts` / `wrangler.jsonc` contain expected tool names, the
  `vars`/secret split, `nodejs_compat`, **no `eval`**, and **no `node:https` / `process.env`**.
- Regression guard: assert the existing Node targets' output is unchanged.

**Integration (`tests/integration.test.ts`):**
- Generate the Worker project under a temp dir, `npm i`, then `wrangler deploy --dry-run`
  (compiles + bundles against the real Workers runtime without deploying or needing CF
  credentials).
- Skip gracefully if `wrangler` cannot run offline in CI, falling back to `tsc --noEmit`.

## Versioning & docs

- `minor` bump → **4.1.0** (additive, zero breaking changes).
- README: new section documenting `--transport cloudflare-worker` and the deploy flow.
- CHANGELOG: `Added` entry under `[4.1.0]`.
- `--transport` help text lists the new value.

## Open implementation questions (resolve during planning, not blocking the spec)

1. Exact `createMcpHandler` import path/signature in the pinned `agents` SDK version —
   confirm before writing the template.
2. Whether `wrangler deploy --dry-run` runs in the project's CI environment offline; if
   not, the integration test falls back to `tsc --noEmit`.
