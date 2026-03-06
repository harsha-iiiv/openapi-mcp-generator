# OpenAPI to MCP Generator (openapi-mcp-generator)

[![npm version](https://img.shields.io/npm/v/openapi-mcp-generator.svg)](https://www.npmjs.com/package/openapi-mcp-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub repository](https://img.shields.io/badge/GitHub-harsha--iiiv/openapi--mcp--generator-blue.svg)](https://github.com/harsha-iiiv/openapi-mcp-generator)

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
- 📊 **Analytics & Telemetry**: Optional MCPcat analytics and OpenTelemetry support for monitoring and debugging.

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

# Generate with MCPcat analytics enabled
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --with-mcpcat

# Generate with OpenTelemetry tracing enabled
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --with-otel

# Generate with both MCPcat analytics and OpenTelemetry
openapi-mcp-generator --input path/to/openapi.json --output path/to/output/dir --with-mcpcat --with-otel
```

### CLI Options

| Option              | Alias | Description                                                                                                                                    | Default                           |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `--input`           | `-i`  | Path or URL to OpenAPI specification (YAML or JSON)                                                                                            | **Required**                      |
| `--output`          | `-o`  | Directory to output the generated MCP project                                                                                                  | **Required**                      |
| `--server-name`     | `-n`  | Name of the MCP server (`package.json:name`)                                                                                                   | OpenAPI title or `mcp-api-server` |
| `--server-version`  | `-v`  | Version of the MCP server (`package.json:version`)                                                                                             | OpenAPI version or `1.0.0`        |
| `--base-url`        | `-b`  | Base URL for API requests. Required if OpenAPI `servers` missing or ambiguous.                                                                 | Auto-detected if possible         |
| `--transport`       | `-t`  | Transport mode: `"stdio"` (default), `"web"`, or `"streamable-http"`                                                                           | `"stdio"`                         |
| `--port`            | `-p`  | Port for web-based transports                                                                                                                  | `3000`                            |
| `--default-include` |       | Default behavior for x-mcp filtering. Accepts `true` or `false` (case-insensitive). `true` = include by default, `false` = exclude by default. | `true`                            |
| `--with-mcpcat`     |       | Enable MCPcat product analytics for usage insights and debugging                                                                               | `false`                           |
| `--with-otel`       |       | Enable OpenTelemetry (OTLP) exporters for distributed tracing and logging                                                                      | `false`                           |
| `--force`           |       | Overwrite existing files in the output directory without confirmation                                                                          | `false`                           |

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
└── public/          # For web-based transports
    └── index.html   # Test client
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
- In-browser test client UI
- Multi-connection support
- Built with lightweight Hono framework

### StreamableHTTP

Implements the MCP StreamableHTTP transport which offers:

- Stateful JSON-RPC over HTTP POST requests
- Session management using HTTP headers
- Proper HTTP response status codes
- Built-in error handling
- Compatibility with MCP StreamableHTTPClientTransport
- In-browser test client UI
- Built with lightweight Hono framework

### Transport Comparison

| Feature            | stdio               | web (SSE)         | streamable-http    |
| ------------------ | ------------------- | ----------------- | ------------------ |
| Protocol           | JSON-RPC over stdio | JSON-RPC over SSE | JSON-RPC over HTTP |
| Connection         | Persistent          | Persistent        | Request/response   |
| Bidirectional      | Yes                 | Yes               | Yes (stateful)     |
| Multiple clients   | No                  | Yes               | Yes                |
| Browser compatible | No                  | Yes               | Yes                |
| Firewall friendly  | No                  | Yes               | Yes                |
| Load balancing     | No                  | Limited           | Yes                |
| Status codes       | No                  | Limited           | Full HTTP codes    |
| Headers            | No                  | Limited           | Full HTTP headers  |
| Test client        | No                  | Yes               | Yes                |

---

## 🔐 Environment Variables for Authentication

Configure auth credentials in your environment:

| Auth Type  | Variable Format                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- |
| API Key    | `API_KEY_<SCHEME_NAME>`                                                                            |
| Bearer     | `BEARER_TOKEN_<SCHEME_NAME>`                                                                       |
| Basic Auth | `BASIC_USERNAME_<SCHEME_NAME>`, `BASIC_PASSWORD_<SCHEME_NAME>`                                     |
| OAuth2     | `OAUTH_CLIENT_ID_<SCHEME_NAME>`, `OAUTH_CLIENT_SECRET_<SCHEME_NAME>`, `OAUTH_SCOPES_<SCHEME_NAME>` |

---

## 📊 Analytics & Telemetry

### MCPcat Analytics
[MCPcat](https://mcpcat.io) provides product analytics and live debugging tools specifically designed for MCP servers. When enabled with `--with-mcpcat`, your generated server will include:

- Usage tracking and analytics
- Tool call monitoring
- Error detection and reporting
- Performance insights

To use MCPcat:
1. Sign up for free at [mcpcat.io](https://mcpcat.io)
2. Get your project ID
3. Set the `MCPCAT_PROJECT_ID` environment variable

### OpenTelemetry Support
Enable distributed tracing and logging with `--with-otel` to integrate with your existing observability stack:

- OTLP trace exporters
- Distributed request tracing
- Performance metrics
- Integration with popular observability platforms (Datadog, New Relic, Grafana, etc.)

Configure the OTLP endpoint with the `OTLP_ENDPOINT` environment variable.

### Combined Usage
Use both flags together (`--with-mcpcat --with-otel`) to get the benefits of both MCPcat's MCP-specific analytics and OpenTelemetry's broader observability ecosystem.

#### Environment Variables
Configure analytics and telemetry:

| Variable             | Description                                              | Required When      |
| -------------------- | -------------------------------------------------------- | ------------------ |
| `MCPCAT_PROJECT_ID`  | Your MCPcat project ID from [mcpcat.io](https://mcpcat.io) | `--with-mcpcat`    |
| `OTLP_ENDPOINT`      | OpenTelemetry collector endpoint URL                    | `--with-otel`      |


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

### Testing Web-Based Servers

For web and StreamableHTTP transports, a browser-based test client is automatically generated:

1. Start the server using the appropriate command
2. Open your browser to `http://localhost:<port>`
3. Use the test client to interact with your MCP server

---

## ⚠️ Requirements

- Node.js v20 or later

---

## Star History

<a href="https://www.star-history.com/#harsha-iiiv/openapi-mcp-generator&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=harsha-iiiv/openapi-mcp-generator&type=Date" />
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
