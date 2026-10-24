# OpenAPI to MCP Generator (openapi-mcp-generator)

[![npm version](https://img.shields.io/npm/v/openapi-mcp-generator.svg)](https://www.npmjs.com/package/openapi-mcp-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub repository](https://img.shields.io/badge/GitHub-harsha--iiiv/openapi--mcp--generator-blue.svg)](https://github.com/harsha-iiiv/openapi-mcp-generator)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/harsha-iiiv/openapi-mcp-generator)

Generate [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers from OpenAPI specifications.

This CLI tool automates the generation of MCP-compatible servers that proxy requests to existing REST APIs—enabling AI agents and other MCP clients to seamlessly interact with your APIs using your choice of transport methods.

---

## ✨ Features

- 🔧 **OpenAPI 3.0 Support**: Converts any OpenAPI 3.0+ spec into an MCP-compatible server.
- 🔁 **Proxy Behavior**: Proxies calls to your original REST API while validating request structure and security.
- 🔐 **Authentication Support**: API keys, Bearer tokens, Basic auth, and OAuth2 supported via environment variables.
- 🧪 **Zod Validation**: Automatically generates Zod schemas from OpenAPI definitions for runtime input validation.
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
| `--force`                |       | Overwrite existing files in the output directory without confirmation                                                                          | `false`                           |

> **Configuring the API base URL at runtime:** the generated server reads
> `API_BASE_URL` from the environment (`.env`), overriding the value baked in
> from the OpenAPI `servers` list. The port resolves from `--port`, then the
> `PORT` env var, then `3000`.

## 📦 Programmatic API

You can also use this package programmatically in your Node.js applications:

```javascript
import { getToolsFromOpenApi } from 'openapi-mcp-generator';

// Extract MCP tool definitions from an OpenAPI spec
const tools = await getToolsFromOpenApi('./petstore.json');

// With options
const filteredTools = await getToolsFromOpenApi('https://example.com/api-spec.json', {
  baseUrl: 'https://api.example.com',
  dereference: true,
  excludeOperationIds: ['deletePet'],
  filterFn: (tool) => tool.method.toLowerCase() === 'get',
});
```

For full documentation of the programmatic API, see [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md).

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

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `axios` - HTTP client for API requests
- `zod` - Runtime validation
- `json-schema-to-zod` - Convert JSON Schema to Zod
- Transport-specific deps (Hono, uuid, etc.)

---

## 📡 Transport Modes

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

- Stateful JSON-RPC over HTTP POST requests
- Session management using HTTP headers
- Proper HTTP response status codes
- Built-in error handling
- Compatibility with MCP StreamableHTTPClientTransport
- Browser playground at `/`
- Built with lightweight Hono framework

### Cloudflare Worker

Generates a complete, deployable [Cloudflare Workers](https://developers.cloudflare.com/workers/) project that serves the MCP server over **Streamable HTTP at `/mcp`** using the MCP SDK's `WebStandardStreamableHTTPServerTransport` directly (no extra framework dependency). Deploy it to your own Cloudflare account with one command:

```bash
openapi-mcp-generator --input ./openapi.json --output ./my-mcp-worker --transport cloudflare-worker
cd my-mcp-worker
npm install
npx wrangler secret put API_KEY   # set upstream API secrets (see .dev.vars.example)
npx wrangler deploy               # Wrangler logs into YOUR Cloudflare account and deploys
```

Highlights:

- Stateless, runs on the free Workers tier (no Durable Objects or KV). A fresh MCP server + transport is created per request (required by MCP SDK ≥ 1.26).
- Lean dependencies: just `@modelcontextprotocol/sdk` and `zod` — no extra agent framework.
- Non-secret config (e.g. `API_BASE_URL`) lives in `wrangler.jsonc` under `vars`; secrets are set with `wrangler secret put` and read from the `env` binding — never committed.
- Workers-native runtime: global `fetch` (no Node `https`), and argument validation uses build-time-emitted zod (no runtime `eval`).
- Auth is scheme-aware: API key (header/query/cookie), HTTP basic/bearer, OpenID Connect tokens, and OAuth2 client-credentials are derived from `env` secrets, following OpenAPI security requirement semantics (see [Securing HTTP servers](#-securing-http-servers)).
- `--inbound-auth bearer` protects `/mcp` with a token from `wrangler secret put MCP_AUTH_TOKEN`; `--header-passthrough` forwards per-user upstream keys from the client.
- `--custom-auth`, `--port`, `--insecure`, `--generate-lib`, and `--oauth-creds-in-body` do not apply to this target and are ignored with a warning.

Local development: `cp .dev.vars.example .dev.vars`, fill in secrets, then `npm run dev` (serves `http://localhost:8787/mcp`). Connect with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or, from Claude Desktop, via [mcp-remote](https://www.npmjs.com/package/mcp-remote).

### Transport Comparison

| Feature            | stdio               | web (SSE)         | streamable-http    | cloudflare-worker       |
| ------------------ | ------------------- | ----------------- | ------------------ | ----------------------- |
| Protocol           | JSON-RPC over stdio | JSON-RPC over SSE | JSON-RPC over HTTP | Streamable HTTP at /mcp |
| Connection         | Persistent          | Persistent        | Request/response   | Request/response        |
| Bidirectional      | Yes                 | Yes               | Yes (stateful)     | Yes                     |
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

| Auth Type  | Variable Format                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- |
| API Key    | `API_KEY_<SCHEME_NAME>`                                                                            |
| Bearer     | `BEARER_TOKEN_<SCHEME_NAME>`                                                                       |
| Basic Auth | `BASIC_USERNAME_<SCHEME_NAME>`, `BASIC_PASSWORD_<SCHEME_NAME>`                                     |
| OAuth2     | `OAUTH_CLIENT_ID_<SCHEME_NAME>`, `OAUTH_CLIENT_SECRET_<SCHEME_NAME>`, `OAUTH_SCOPES_<SCHEME_NAME>` |
| OpenID     | `OPENID_TOKEN_<SCHEME_NAME>`                                                                       |

When an operation lists several security requirements, the first one whose schemes are all
configured is used. OAuth2 tokens are requested with the operation's scopes unless
`OAUTH_SCOPES_<SCHEME_NAME>` overrides them. The Cloudflare Worker target reads the same
credentials from Wrangler secrets named `<SCHEME_NAME>_API_KEY`, `<SCHEME_NAME>_TOKEN`,
`<SCHEME_NAME>_USERNAME`/`_PASSWORD` and `<SCHEME_NAME>_CLIENT_ID`/`_CLIENT_SECRET` (see the
generated `.dev.vars.example`).

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
- Streamable HTTP and SSE sessions are bound to the token that opened them; replaying a session
  ID with another token is answered `404`.
- Clients that accept custom headers (Claude Code, Cursor, VS Code, MCP Inspector, `mcp-remote`)
  send the token directly. Claude.ai and ChatGPT connectors use OAuth or no auth; put those
  behind an OAuth-capable gateway.

**Let each user bring their own upstream key** with `--header-passthrough X-API-Key`: the listed
headers are forwarded per request, so the server stores no shared secret. A forwarded header
satisfies the security scheme whose credential travels in it, so the other schemes of an AND
requirement are still applied from server configuration. Passthrough cannot forward
`Authorization` while `--inbound-auth bearer` is on, because that header carries the MCP token.

**Idle sessions.** `streamable-http` servers close sessions idle longer than
`MCP_SESSION_IDLE_TIMEOUT` seconds (default 1800, `0` disables), so clients that disconnect
without `DELETE` do not hold memory. A session with an open stream or a request in flight is
not idle. A returning client gets `404` and starts a new session.

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

- Node.js v20 or later

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
