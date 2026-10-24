# OpenAPI to MCP Generator (openapi-mcp-generator)

[![npm version](https://img.shields.io/npm/v/openapi-mcp-generator.svg)](https://www.npmjs.com/package/openapi-mcp-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub repository](https://img.shields.io/badge/GitHub-harsha--iiiv/openapi--mcp--generator-blue.svg)](https://github.com/harsha-iiiv/openapi-mcp-generator)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/harsha-iiiv/openapi-mcp-generator)

Generate [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers from OpenAPI specifications.

This CLI tool automates the generation of MCP-compatible servers that proxy requests to existing REST APIs—enabling AI agents and other MCP clients to seamlessly interact with your APIs using your choice of transport methods.

---

## ✨ Features

- 🔧 **OpenAPI 3.x Support**: Converts any OpenAPI 3.0 or 3.1 spec into an MCP-compatible server (convert Swagger 2.0 first).
- 🔁 **Proxy Behavior**: Proxies calls to your original REST API while validating request structure and security.
- 🔐 **Authentication Support**: API keys, Bearer tokens, Basic auth, and OAuth2 supported via environment variables; calls fail closed when required credentials are missing.
- 🧪 **JSON Schema Validation**: Arguments are validated against each tool's JSON Schema 2020-12 input schema (no code generation, no `eval`).
- 🏷️ **Annotations and Structured Output**: Tools carry titles and read-only/destructive/idempotent hints, and JSON object responses come back as `structuredContent` (optionally with a declared `outputSchema`).
- ⚙️ **Typed Server**: Fully typed, maintainable TypeScript code output.
- 🔌 **Multiple Transports**: Communicate over stdio, SSE via Hono, or StreamableHTTP.
- 🧰 **Project Scaffold**: Generates a complete Node.js project with `tsconfig.json`, `package.json`, and entry point.
- 🧪 **Built-in HTML Test Clients**: Test API interactions visually in your browser (for web-based transports).

---

## 🚀 Installation

```bash
npm install -g openapi-mcp-generator
```

> You can also use `yarn global add openapi-mcp-generator` or `pnpm add -g openapi-mcp-generator`

---

## ⬆️ Upgrading to 5.0

5.0 generates servers on the MCP TypeScript SDK v2 and supports MCP 2026-07-28 alongside 2025-era clients. Generated projects change, so upgrade deliberately:

1. Commit your generated project, then regenerate with the same flags: `npx openapi-mcp-generator@5 -i ./openapi.json -o ./my-mcp --force`. `--force` overwrites generated files, including your edits.
2. Use Node.js 22.19 or later to run the generator (generated projects need Node.js 22 or later), then run `npm install`. `@modelcontextprotocol/sdk` is replaced by `@modelcontextprotocol/server` (`^2.4.0`), and `zod`, `json-schema-to-zod`, `dotenv` and `uuid` by `@cfworker/json-schema`.
3. Update customized code to import from `@modelcontextprotocol/server` (stdio helpers from `@modelcontextprotocol/server/stdio`).
4. Streamable HTTP and Worker servers are stateless: no `mcp-session-id`, and `GET` and `DELETE` on `/mcp` return `405`. Tool calls over `POST` are unaffected.
5. Missing upstream credentials now fail closed with an error naming the variables to set; `MCP_ALLOW_MISSING_CREDENTIALS=true` restores the old behavior.
6. An unknown tool name is now a JSON-RPC `-32602` error. Integers stay integers, `readOnly` properties leave request inputs, and schema defaults are no longer injected.
7. Swagger 2.0 specs are refused: convert them with `npx swagger2openapi swagger.json -o openapi.json`.
8. Credential variables, Worker secret names, `--inbound-auth`, `--header-passthrough` and `MCP_ALLOWED_ORIGINS` are unchanged.

Not ready yet? Stay on 4.x with `npx openapi-mcp-generator@4`. Full notes: [CHANGELOG.md](./CHANGELOG.md).

---

## 🛠 Usage

```bash
# Generate an MCP server (stdio)
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir

# Generate an MCP web server with SSE
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --transport=web --port=3000

# Generate an MCP StreamableHTTP server
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --transport=streamable-http --port=3000

# Generate a deployable Cloudflare Worker MCP server
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --transport=cloudflare-worker
```

The [`examples/`](./examples) folder holds the Swagger Petstore generated with 5.0 for stdio
(`petstore-mcp`), web (`pet-store-sse`) and StreamableHTTP (`pet-store-streamable-http`).

### CLI Options

| Option                   | Alias | Description                                                                                                                                    | Default                           |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `--input`                | `-i`  | Path or URL to OpenAPI specification (YAML or JSON)                                                                                            | **Required**                      |
| `--output`               | `-o`  | Directory to output the generated MCP project                                                                                                  | **Required**                      |
| `--server-name`          | `-n`  | Name of the MCP server (`package.json:name`)                                                                                                   | OpenAPI title or `mcp-api-server` |
| `--server-version`       | `-v`  | Version of the MCP server (`package.json:version`)                                                                                             | OpenAPI version or `1.0.0`        |
| `--base-url`             | `-b`  | Base URL for API requests. Required if OpenAPI `servers` missing or ambiguous.                                                                 | Auto-detected if possible         |
| `--transport`            | `-t`  | Transport mode: `"stdio"` (default), `"web"`, `"streamable-http"`, or `"cloudflare-worker"`                                                    | `"stdio"`                         |
| `--port`                 | `-p`  | Port for web-based transports                                                                                                                  | `3000`                            |
| `--default-include`      |       | Default behavior for x-mcp filtering. Accepts `true` or `false` (case-insensitive). `true` = include by default, `false` = exclude by default. | `true`                            |
| `--allow-external-refs`  |       | Allow resolving external `http(s)` `$ref` references in the spec. Disabled by default to prevent SSRF during parsing.                          | `false`                           |
| `--max-tool-name-length` |       | Maximum length for generated tool names (Claude Desktop caps at 64). Longer names are truncated with a hash suffix.                            | `64`                              |
| `--header-passthrough`   |       | Comma-separated inbound header names to forward to the upstream API (web, streamable-http, cloudflare-worker). Enables per-user API keys.      | _(none)_                          |
| `--inbound-auth`         |       | Inbound auth for HTTP transports: `none` or `bearer`. With `bearer`, clients must send `Authorization: Bearer <token>` (`MCP_AUTH_TOKEN`).     | `none`                            |
| `--insecure`             | `-k`  | Allow insecure HTTPS connections (skip TLS certificate verification) in the generated server.                                                  | `false`                           |
| `--generate-lib`         |       | Generate library-style output: export `main()` instead of auto-invoking it, omitting signal/cleanup wiring.                                    | `false`                           |
| `--custom-auth`          |       | Generate an editable `src/auth.ts` hook (`applyCustomAuth`) called before built-in auth; return `true` to skip built-in auth.                  | `false`                           |
| `--oauth-creds-in-body`  |       | Send OAuth2 client credentials in the token request body instead of the Basic `Authorization` header.                                          | `false`                           |
| `--include-tags`         |       | Comma-separated tags: generate only operations with one of them (case-insensitive).                                                            | _(all)_                           |
| `--exclude-tags`         |       | Comma-separated tags: skip operations with any of them. Exclusions win over inclusions.                                                        | _(none)_                          |
| `--include-operations`   |       | Comma-separated operationIds or tool names to generate. Combined with `--include-tags` as a union.                                             | _(all)_                           |
| `--exclude-operations`   |       | Comma-separated operationIds or tool names to skip. Exclusions win over inclusions.                                                            | _(none)_                          |
| `--output-schema`        |       | Declare each tool's `outputSchema` from its 2xx JSON response schema (objects only) and reject responses that do not match it.                 | `false`                           |
| `--force`                |       | Overwrite existing files in the output directory without confirmation                                                                          | `false`                           |

> **Configuring the API base URL at runtime:** the generated server reads
> `API_BASE_URL` from the environment (`.env`), overriding the value baked in
> from the OpenAPI `servers` list. The port resolves from `--port`, then the
> `PORT` env var, then `3000`.
>
> **Per-operation and per-path servers:** an operation's `servers[0]` wins over its path item's,
> which wins over the root server, with server variables set to their defaults. An absolute
> operation or path server is used even when `API_BASE_URL` is set; a relative one resolves
> against the active base URL (`"v2"` appends a segment, `"/v2"` replaces the path).

## 📦 Programmatic API

The package also exports the parser the CLI uses, so you can turn an OpenAPI document into MCP tool
definitions inside your own Node.js code:

```typescript
import { getToolsFromOpenApi } from 'openapi-mcp-generator';

// From a local file or a URL
const tools = await getToolsFromOpenApi('./petstore.json', { dereference: true });

// With options
const readOnlyPetTools = await getToolsFromOpenApi(
  'https://petstore3.swagger.io/api/v3/openapi.json',
  {
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    dereference: true,
    includeTags: ['pet'],
    excludeOperations: ['deletePet'],
    filterFn: (tool) => tool.annotations?.readOnlyHint === true,
  }
);

for (const tool of readOnlyPetTools) {
  console.log(`${tool.name}: ${tool.method.toUpperCase()} ${tool.pathTemplate}`);
}
```

### `getToolsFromOpenApi(spec, options?)`

`spec` is a file path, an http(s) URL or an already parsed `OpenAPIV3.Document`. The function
returns `Promise<McpToolDefinition[]>`. Swagger 2.0 documents are rejected; convert them first
(`npx swagger2openapi swagger.json -o openapi.json`).

| Option                                    | Description                                                                                                                    | Default |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `baseUrl`                                 | Override the base URL from the spec's `servers`                                                                                |         |
| `dereference`                             | Resolve `$ref`s before extracting tools. Without it, referenced schemas stay unresolved and a warning is logged for each one   | `false` |
| `includeTags` / `excludeTags`             | Keep only, or drop, operations with these tags (case-insensitive)                                                              |         |
| `includeOperations` / `excludeOperations` | Keep only, or drop, these operations (operationId or tool name). Same rules as the CLI flags: includes combine, exclusions win |         |
| `excludeOperationIds`                     | Drop these operationIds (older option, applied after the filters above)                                                        |         |
| `filterFn`                                | Custom predicate `(tool) => boolean`, applied last                                                                             |         |
| `defaultInclude`                          | Whether operations without an `x-mcp` extension are included                                                                   | `true`  |
| `allowExternalRefs`                       | Allow external http(s) `$ref`s. Off by default so parsing cannot be used for SSRF                                              | `false` |
| `maxToolNameLength`                       | Maximum generated tool name length (Claude Desktop allows 64)                                                                  | `64`    |

Filters apply after `x-mcp` filtering. To parse the document yourself, pass the result in:

```typescript
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3 } from 'openapi-types';
import { getToolsFromOpenApi } from 'openapi-mcp-generator';

const api = (await SwaggerParser.dereference('./openapi.yaml')) as OpenAPIV3.Document;
const tools = await getToolsFromOpenApi(api);
```

### Tool definitions

```typescript
interface McpToolDefinition {
  name: string; // unique tool name
  title?: string; // x-mcp-title, else the operation summary
  description: string;
  inputSchema: JSONSchema7 | boolean; // JSON Schema 2020-12 for the tool arguments
  method: string; // get, post, ...
  pathTemplate: string; // e.g. /pet/{petId}
  parameters: OpenAPIV3.ParameterObject[];
  executionParameters: { name: string; in: string }[];
  requestBodyContentType?: string;
  serverUrl?: string; // operation or path-item server, variables resolved
  securityRequirements: OpenAPIV3.SecurityRequirementObject[];
  operationId: string;
  tags?: string[];
  deprecated?: boolean;
  annotations?: McpToolAnnotations; // readOnlyHint, destructiveHint, idempotentHint, openWorldHint
  outputSchema?: JSONSchema7; // lowest 2xx application/json response, when it is an object
}
```

`inputSchema` keeps `integer` types, turns `example` into `examples` and leaves out `readOnly`
properties. Annotations come from the HTTP method (GET and HEAD are read-only, DELETE is
destructive, PUT and DELETE are idempotent) and can be overridden per operation with
`x-mcp-annotations`. At runtime, each returned tool also carries `baseUrl`, the resolved base URL or an
empty string. `McpToolDefinition` does not declare it yet, so TypeScript code needs a cast to
read it.

More filters:

```typescript
const spec = './petstore.json';

// Only GET operations
await getToolsFromOpenApi(spec, { dereference: true, filterFn: (tool) => tool.method === 'get' });

// Only operations that require authentication
await getToolsFromOpenApi(spec, {
  dereference: true,
  filterFn: (tool) => tool.securityRequirements.length > 0,
});

// Read-only user endpoints, without two specific operations
await getToolsFromOpenApi(spec, {
  dereference: true,
  excludeOperationIds: ['deleteUser', 'updateUser'],
  filterFn: (tool) =>
    tool.pathTemplate.startsWith('/user') && tool.annotations?.readOnlyHint === true,
});
```

---

## 🧱 Project Structure

The generated project includes:

```
<output_directory>/
├── .gitignore
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts
│   └── [transport-specific-files]
└── public/          # web and streamable-http: the browser playground
    ├── index.html, playground.js, playground.css, mcp-client.js
    └── playground.config.json
```

Core dependencies:

- `@modelcontextprotocol/server` - MCP protocol implementation (SDK v2)
- `@cfworker/json-schema` - JSON Schema 2020-12 validation of tool arguments (and outputs with `--output-schema`)
- `axios` - HTTP client for API requests
- Transport-specific deps (`hono`, `@hono/node-server`)

`.env` is loaded with Node's built-in `process.loadEnvFile()`; no `dotenv` dependency.

---

## 📡 Transport Modes

Generated servers speak **MCP 2026-07-28** (stateless requests, `server/discover`) and keep
serving **2025-era clients** that open with `initialize`, using the MCP TypeScript SDK v2. The
`web` (SSE) transport stays on the 2025-era protocol because the specification deprecates
HTTP+SSE; prefer `streamable-http` for new deployments.

### Stdio (Default)

Communicates with MCP clients via standard input/output. Ideal for local development or integration with LLM tools.

### Web Server with SSE

Launches a fully functional HTTP server with:

- Server-Sent Events (SSE) for bidirectional messaging
- REST endpoint for client → server communication
- Browser playground at `/`
- Multi-connection support
- Built with lightweight Hono framework

### StreamableHTTP

Implements the MCP StreamableHTTP transport which offers:

- Stateless JSON-RPC over HTTP: every request gets a fresh server, so it scales behind any load
  balancer
- Serves MCP 2026-07-28 and 2025-era clients (2025-era clients run without sessions; GET and
  DELETE answer `405`)
- Proper HTTP response status codes
- Built-in error handling
- Compatibility with MCP StreamableHTTPClientTransport
- Browser playground at `/`
- Built with lightweight Hono framework

### Cloudflare Worker

Generates a complete, deployable [Cloudflare Workers](https://developers.cloudflare.com/workers/) project that serves the MCP server over **Streamable HTTP at `/mcp`** using `createMcpHandler` from `@modelcontextprotocol/server` (no extra framework dependency). Deploy it to your own Cloudflare account with one command:

```bash
openapi-mcp-generator --input ./openapi.json --output ./my-mcp-worker --transport cloudflare-worker
cd my-mcp-worker
npm install
npx wrangler secret put API_KEY   # set upstream API secrets (see .dev.vars.example)
npx wrangler deploy               # Wrangler logs into YOUR Cloudflare account and deploys
```

Highlights:

- Stateless, runs on the free Workers tier (no Durable Objects or KV). A fresh MCP server is created per request.
- Lean dependencies: just `@modelcontextprotocol/server` and `@cfworker/json-schema` — no extra agent framework.
- Non-secret config (e.g. `API_BASE_URL`) lives in `wrangler.jsonc` under `vars`; secrets are set with `wrangler secret put` and read from the `env` binding — never committed.
- Workers-native runtime: global `fetch` (no Node `https`), and arguments are validated against the JSON Schema with `@cfworker/json-schema` (no code generation, no `eval`).
- Auth is scheme-aware: API key (header/query/cookie), HTTP basic/bearer, OpenID Connect tokens, and OAuth2 client-credentials are derived from `env` secrets, following OpenAPI security requirement semantics (see [Securing HTTP servers](#-securing-http-servers)).
- `--inbound-auth bearer` protects `/mcp` with a token from `wrangler secret put MCP_AUTH_TOKEN`; `--header-passthrough` forwards per-user upstream keys from the client.
- `--custom-auth`, `--port`, `--insecure`, `--generate-lib`, and `--oauth-creds-in-body` do not apply to this target and are ignored with a warning.

Local development: `cp .dev.vars.example .dev.vars`, uncomment and fill in the secrets you use, then `npm run dev` (serves `http://localhost:8787/mcp`). Connect with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or, from Claude Desktop, via [mcp-remote](https://www.npmjs.com/package/mcp-remote).

### Transport Comparison

| Feature            | stdio               | web (SSE)         | streamable-http    | cloudflare-worker       |
| ------------------ | ------------------- | ----------------- | ------------------ | ----------------------- |
| Protocol           | JSON-RPC over stdio | JSON-RPC over SSE | JSON-RPC over HTTP | Streamable HTTP at /mcp |
| Connection         | Persistent          | Persistent        | Request/response   | Request/response        |
| Bidirectional      | Yes                 | Yes               | Yes (stateless)    | Yes                     |
| Multiple clients   | No                  | Yes               | Yes                | Yes                     |
| Browser compatible | No                  | Yes               | Yes                | Yes                     |
| Firewall friendly  | No                  | Yes               | Yes                | Yes                     |
| Load balancing     | No                  | Limited           | Yes                | Yes (edge)              |
| Status codes       | No                  | Limited           | Full HTTP codes    | Full HTTP codes         |
| Headers            | No                  | Limited           | Full HTTP headers  | Full HTTP headers       |
| Browser playground | No                  | Yes               | Yes                | Yes                     |
| Hosting            | Local               | Self-hosted       | Self-hosted        | Cloudflare (serverless) |

---

## 🔐 Environment Variables for Authentication

Configure auth credentials in your environment:

| Auth Type  | Variable Format                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| API Key    | `API_KEY_<SCHEME_NAME>`                                                                                                            |
| Bearer     | `BEARER_TOKEN_<SCHEME_NAME>`                                                                                                       |
| Basic Auth | `BASIC_USERNAME_<SCHEME_NAME>`, `BASIC_PASSWORD_<SCHEME_NAME>`                                                                     |
| OAuth2     | `OAUTH_TOKEN_<SCHEME_NAME>`, or `OAUTH_CLIENT_ID_<SCHEME_NAME>`, `OAUTH_CLIENT_SECRET_<SCHEME_NAME>`, `OAUTH_SCOPES_<SCHEME_NAME>` |
| OpenID     | `OPENID_TOKEN_<SCHEME_NAME>`                                                                                                       |

For OAuth2, `OAUTH_TOKEN_<SCHEME_NAME>` is a token you already have and works for every flow.
Otherwise the server fetches a token: with the client ID and secret when the scheme has a client
credentials flow or, when it has only a password flow, with `OAUTH_USERNAME_<SCHEME_NAME>` and
`OAUTH_PASSWORD_<SCHEME_NAME>` (plus the client ID, and the secret for a confidential client, when
the token endpoint needs them).

When an operation lists several security requirements, the first one whose schemes are all
configured is used. If none can be satisfied (a forwarded `--header-passthrough` header counts)
and the operation does not allow anonymous access with an empty `{}` requirement, the tool
**fails closed**: it does not call the API and returns an error naming what to set, for example
`Missing credentials for 'getPet': set API_KEY_PETSTORE_AUTH.` Set
`MCP_ALLOW_MISSING_CREDENTIALS=true` (a Worker var for Workers) to send such requests without
credentials instead. OAuth2 tokens are requested with the operation's scopes unless
`OAUTH_SCOPES_<SCHEME_NAME>` overrides them. The Cloudflare Worker target reads the same
credentials from Wrangler secrets named `<SCHEME_NAME>_API_KEY`, `<SCHEME_NAME>_TOKEN`,
`<SCHEME_NAME>_USERNAME`/`_PASSWORD` and `<SCHEME_NAME>_CLIENT_ID`/`_CLIENT_SECRET` (see the
generated `.dev.vars.example`). For OAuth2, `<SCHEME_NAME>_TOKEN` holds a token you already have
and works for every flow; the Worker fetches a token from the client ID and secret only when the
scheme declares a client credentials flow.

---

## 🧩 Generated tools

- **Input schemas** are JSON Schema 2020-12 mapped from your OpenAPI schemas: `integer`, `format`,
  `pattern`, enums and `allOf`/`anyOf`/`oneOf` are kept, `nullable` becomes a `null` type, `example`
  becomes `examples`, and `readOnly` properties are left out of request inputs.
- **Validation:** arguments are checked against that schema before any request is sent. Problems come
  back as a tool error the model can fix, for example
  `Invalid arguments for tool 'getPet': /petId: Instance type "string" is invalid. Expected "integer".`
  Arguments are passed through as given: schema defaults are not injected.
- **Errors:** invalid arguments, missing credentials and upstream failures are tool errors
  (`isError: true`); an unknown tool name is a JSON-RPC `-32602` protocol error, as the MCP
  2026-07-28 specification requires.
- **Titles and annotations:** the title is the operation's `x-mcp-title`, else its summary. Hints follow
  the HTTP method: `GET`/`HEAD`/`OPTIONS` are read-only; `POST` is not destructive and not idempotent;
  `PUT` and `DELETE` are destructive and idempotent; `PATCH` is destructive and not idempotent; all are
  open-world. Override individual hints per operation:

  ```yaml
  paths:
    /pets/{id}:
      delete:
        x-mcp-title: Remove a pet
        x-mcp-annotations:
          destructiveHint: false # a soft delete
  ```

- **Structured output:** a JSON response that is an object is also returned as `structuredContent`.
  With `--output-schema`, each tool declares the schema of its lowest 2xx `application/json` response
  as `outputSchema` (object schemas only, `writeOnly` properties removed) and every response is
  validated against it; a response that does not match becomes a tool error that still shows the raw
  body. Leave it off if your spec does not describe real responses accurately.
- **Server instructions:** the spec's `info.description` (trimmed, up to 2000 characters) is sent to
  clients as the server instructions.

---

## 🔒 Securing HTTP servers

Generated `web`, `streamable-http` and `cloudflare-worker` servers expose a network endpoint.
If they also hold upstream credentials, anyone who reaches the endpoint can spend them, so the
generator warns when you generate such a server without protection.

**Require a token** with `--inbound-auth bearer`:

```bash
openapi-mcp-generator -i openapi.json -o my-mcp -t streamable-http --inbound-auth bearer
openssl rand -hex 32   # put the value in .env as MCP_AUTH_TOKEN (Workers: wrangler secret put MCP_AUTH_TOKEN)
```

- Every MCP request must send `Authorization: Bearer <token>`; others get `401` before any tool
  runs. `/health` stays public.
- Tokens are read at runtime, never written into generated files, and compared in constant time.
  Rotate without downtime with `MCP_AUTH_TOKENS=new-token,old-token`.
- With no token configured the server fails closed with `503`.
- SSE sessions are bound to the token that opened them; replaying a session ID with another
  token is answered `404`. Streamable HTTP is stateless and checks the token on every request.
- Clients that accept custom headers (Claude Code, Cursor, VS Code, MCP Inspector, `mcp-remote`)
  send the token directly. Claude.ai and ChatGPT connectors use OAuth or no auth; put those
  behind an OAuth-capable gateway.

**Let each user bring their own upstream key** with `--header-passthrough X-API-Key`: the listed
headers are forwarded per request, so the server stores no shared secret. A forwarded header
satisfies the security scheme whose credential travels in it, so the other schemes of an AND
requirement are still applied from server configuration. Passthrough cannot forward
`Authorization` while `--inbound-auth bearer` is on, because that header carries the MCP token.

**Browser origins.** Node HTTP servers reject browser requests whose `Origin` is not loopback
or listed in `MCP_ALLOWED_ORIGINS` (comma-separated), which blocks DNS-rebinding attacks on
servers running on your machine. MCP clients that send no `Origin` header are unaffected.

`--inbound-auth` has no effect on `stdio`: a stdio server has no network endpoint, and only the
process that launches it can talk to it.

Found a vulnerability? See [SECURITY.md](./SECURITY.md).

---

## 🔎 Filtering Endpoints with OpenAPI Extensions

You can control which operations are exposed as MCP tools using a vendor extension flag `x-mcp`. This extension is supported at the root, path, and operation levels. By default, endpoints are included unless explicitly excluded.

- Extension: `x-mcp: true | false`
- Default: `true` (include by default)
- Precedence: operation > path > root (first non-undefined wins)
- CLI option: `--default-include false` to change default to exclude by default

Examples:

```yaml
# Optional root-level default
x-mcp: true

paths:
  /pets:
    x-mcp: false # exclude all ops under /pets
    get:
      x-mcp: true # include this operation anyway

  /users/{id}:
    get:
      # no x-mcp -> included by default
```

This uses standard OpenAPI extensions (x-… fields). See the [OpenAPI Extensions guide](https://swagger.io/docs/specification/v3_0/openapi-extensions/) for details.

Note: `x-mcp` must be a boolean or the strings `"true"`/`"false"` (case-insensitive). Other values are ignored in favor of higher-precedence or default behavior.

### Filtering from the command line

Large APIs can be curated without editing the spec:

```bash
openapi-mcp-generator -i openapi.json -o my-mcp \
  --include-tags pets,store --exclude-operations deletePet
```

- `--include-tags` / `--exclude-tags` match operation tags case-insensitively.
- `--include-operations` / `--exclude-operations` match the operationId or the generated tool name.
- Filters apply after `x-mcp` and `--default-include`, so they never bring back an excluded
  operation. Include lists combine (an operation is kept if it matches any), and exclusions always win.
- The programmatic API accepts the same filters: `includeTags`, `excludeTags`, `includeOperations`,
  `excludeOperations`.

---

## ▶️ Running the Generated Server

```bash
cd path/to/output/dir
npm install

# Run in stdio mode
npm start

# Run in web server mode
npm run start:web

# Run in StreamableHTTP mode
npm run start:http
```

### 🧪 Browser playground

Servers generated for `web`, `streamable-http` and `cloudflare-worker` serve a playground at `/`
(`http://localhost:<port>/`, or `http://localhost:8787/` with `npm run dev` for a Worker). It lists
the tools, builds a form for each one from its input schema, runs it and shows every JSON-RPC
message, with copy-as-curl and ready-made configs for Claude Code, Cursor and VS Code. If the server
was generated with `--inbound-auth bearer`, paste the value of `MCP_AUTH_TOKEN`; it stays in the
browser tab.

- The page is served from the server's own origin with a strict Content-Security-Policy, so local
  testing needs no CORS or `MCP_ALLOWED_ORIGINS` changes. Server output is always rendered as text.
- The same open-source page is hosted at [mcp.pidata.tech/playground](https://mcp.pidata.tech/playground)
  for deployed servers. Generated Workers answer CORS so it (and other browser clients) can reach
  them; for Node servers, add the page's origin to `MCP_ALLOWED_ORIGINS`.
- Set `MCP_PLAYGROUND=off` (Node) or the `MCP_PLAYGROUND` var to `"off"` (Worker) to stop serving it,
  for example in production.
- stdio servers have no HTTP endpoint; test them with the
  [MCP Inspector](https://github.com/modelcontextprotocol/inspector).

---

## ⚠️ Requirements

- Node.js 22.19 or later to run the generator; generated projects require Node.js 22 or later (Node 20 reached end of life in April 2026)

---

## Star History

<a href="https://star-history.dera.page/#harsha-iiiv/openapi-mcp-generator&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date" />
 </picture>
</a>

## 🤝 Contributing

Contributions are welcome!

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Run `npm run format.write` to format your code
4. Commit your changes: `git commit -m "Add amazing feature"`
5. Push and open a PR

📌 Repository: [github.com/harsha-iiiv/openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator)

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for full details.
