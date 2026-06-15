# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.1.0] - 2026-06-14

### Added

- `--transport cloudflare-worker`: generate a complete, deployable Cloudflare
  Workers MCP server that serves Streamable HTTP at `/mcp` via the MCP SDK's
  `WebStandardStreamableHTTPServerTransport` (a fresh server + transport per
  request, per the MCP SDK ≥ 1.26 isolation requirement) — no extra agent
  framework dependency, just `@modelcontextprotocol/sdk` and `zod`. The user
  deploys with `npx wrangler deploy`,
  signing into their own Cloudflare account. Non-secret config goes in
  `wrangler.jsonc` `vars`; secrets are set with `wrangler secret put` and read
  from the `env` binding. Auth is scheme-aware (API key in header/query/cookie,
  HTTP basic/bearer, OAuth2 client-credentials). Tool extraction and naming
  (including the 64-char abbreviation) are shared with the existing targets;
  argument validation uses build-time-emitted zod (no runtime `eval`) and
  requests use the global `fetch` (no Node `https`). The flags that don't apply
  to Workers (`--header-passthrough`, `--custom-auth`, `--port`, `--insecure`,
  `--generate-lib`, `--oauth-creds-in-body`) are ignored with a warning. Existing
  stdio/web/streamable-http output is unchanged.
  - When the spec's `servers` URL is relative (e.g. `/api/v3`) the generator now
    warns at generation time, and the generated Worker returns an actionable MCP
    error (asking for an absolute `API_BASE_URL`) instead of a cryptic "Invalid
    URL string" — the Workers `fetch` runtime requires an absolute upstream URL.
    Pass `--base-url https://host/path` to bake one in.

## [4.0.1] - 2026-06-14

### Fixed

- The SSRF guard added in 4.0.0 disabled the HTTP resolver for the whole parse,
  which also blocked fetching the user-supplied input when it was an `http(s)`
  URL — e.g. `openapi-mcp-generator -i https://.../openapi.json` failed with
  "Unable to resolve $ref pointer". The guard now only rejects external `$ref`s
  embedded inside the spec; the trusted input URL/path still loads.
- Relative `$ref`s in multi-file specs (e.g. `./refs/schemas.json#/Pet`) now
  resolve against the spec's directory instead of the process working directory.
- `getToolsFromOpenApi` (programmatic API) no longer hits the same URL-input
  regression; it follows the same parse → scan → dereference flow with SSRF
  protection intact.

## [4.0.0] - 2026-06-13

A hardening-and-configurability release. All changes are backward compatible:
new behaviors are opt-in via CLI flags / env vars, or are additive metadata.
Defaults preserve previous output except where the prior behavior was a
security hole or a build-breaking bug.

### Security

- **Prevent template-literal injection** from OpenAPI `description`/`summary`
  fields. `sanitizeForTemplate()` now escapes `${` sequences in addition to
  backticks and backslashes, so a malicious spec can no longer inject code that
  executes at generated-server startup. (#67)
- **SSRF protection for external `$ref` resolution.** External `http(s)` `$ref`
  references are now rejected by default during parsing (which previously issued
  live outbound requests). Use `--allow-external-refs` (CLI) or
  `allowExternalRefs: true` (`getToolsFromOpenApi`) to opt back in. (#68)

### Fixed

- Generated server no longer fails `npm run build` with a `toLowerCase` type
  error on `content-type`; the header value is coerced to a string first. (#65)
- OAuth2 client-credentials env vars now resolve from the runtime scheme name
  (e.g. `OAUTH_CLIENT_ID_MYSCHEME`) instead of the literal `SCHEMENAME`. (#56)
- HTTP Basic auth now works when the password is empty (valid per RFC 7617);
  only a username is required. (#66)
- Array-valued query parameters are now serialized as comma-separated values
  (`?fields=a,b`) instead of `fields[]=a&fields[]=b`. (#41)

### Added

- `--max-tool-name-length <n>` (default 64): keep generated tool names within
  the limit (Claude Desktop caps at 64). Names that fit are left unchanged.
  Over-limit names are first **word-abbreviated** (inspired by ToolUniverse):
  the leading category/verb word is preserved, short words are kept, and longer
  words are shortened to their first 4 characters
  (`FDA_get_info_on_conditions_for_doctor_consultation_by_drug_name` →
  `FDA_get_info_on_cond_for_doct_cons_by_drug_name`), keeping every word
  recognizable. If abbreviation still overflows, it falls back to deterministic
  "Start…End" hash truncation (`head__tail_hash`). Collisions resolve via a
  content hash of the operationId — stable across spec reordering. (#4)
- `--header-passthrough <names>`: forward selected inbound HTTP headers
  (web/streamable-http transports) onto the upstream API request, enabling
  per-user API keys via MCP client headers. (#55)
- OpenAPI `tags` are now surfaced in the tool definition and appended to the
  tool description for grouping/filtering. (#59)
- Operation `deprecated` status is surfaced in the tool definition and the
  description is prefixed with `[DEPRECATED]`. (#49)
- `--insecure` / `-k`: allow insecure HTTPS connections (skip TLS verification)
  in the generated server, including OAuth token acquisition. (#46)
- `--generate-lib`: emit library-style output that exports `main()` instead of
  auto-invoking it and omits signal-handler/cleanup wiring. (#50)
- The generated server now resolves its port from `--port`, then the `PORT`
  environment variable, then `3000`. (#48, #50)
- `--custom-auth`: generate an editable `src/auth.ts` hook (`applyCustomAuth`)
  invoked before built-in auth; returning `true` skips built-in auth. (#9)
- `--oauth-creds-in-body`: send OAuth2 client credentials in the token request
  body instead of the Basic `Authorization` header. (#8)
- `getToolsFromOpenApi` accepts `allowExternalRefs` and `maxToolNameLength`
  options.

## [3.3.0] - 2026-03-03

### Added

- `API_BASE_URL` environment variable support in generated server code; the env var takes precedence over the value from the OpenAPI `servers` section, with the resolved URL logged at startup.
- `shx` dependency for cross-platform build script compatibility (fixes `chmod` on Windows).

### Fixed

- Path-level `parameters` are now correctly merged with operation-level parameters; operation-level values take precedence, preventing conflicts and incorrect requests.
- Improved handling when path-level parameters are optional or missing, reducing edge-case errors and improving API compatibility.

## [3.2.0] - 2025-08-24

### Added

- Endpoint filtering using `x-mcp` OpenAPI extension to control which operations are exposed as MCP tools
- CLI option `--default-include` to change default behavior for endpoint inclusion
- Precedence rules for `x-mcp` extension (operation > path > root level)
- Enhanced programmatic API with `defaultInclude` option in `getToolsFromOpenApi`

### Changed

- Improved documentation with examples for endpoint filtering and OpenAPI extensions.
- Version bump to next minor release
- Updated package version to reflect accumulated features and improvements

## [3.1.4] - 2025-06-18

### Chores

- Updated the application version to 3.1.4 and ensured the CLI displays the version dynamically.

### Style

- Improved code formatting for better readability.

### Bug Fixes

- Tool names now retain their original casing during extraction.

## [3.1.3] - 2025-06-12

### Fixed

- Cannot find the package after building and the problem during the building.

## [3.1.2] - 2025-06-08

### Fixed

- Prevent stack overflow (RangeError: Maximum call stack size exceeded) when processing recursive or cyclic OpenAPI schemas (e.g., self-referencing objects).
- Added cycle detection to schema mapping, ensuring robust handling of recursive structures.

## [3.1.1] - 2025-05-26

### Added

- Introduced a new executable command-line script for easier usage in Unix-like environments.

### Changed

- Use new CLI entry point to use the new `bin/openapi-mcp-generator.js` file.
- Updated build script to ensure the new CLI file has the correct permissions.
- Refactored `index.ts` to streamline argument parsing and error handling.

## [3.1.0] - 2025-05-18

### Added

- Programmatic API to extract MCP tool definitions from OpenAPI specs
- New exportable `getToolsFromOpenApi` function for direct integration in code
- Advanced filtering capabilities for programmatic tool extraction
- Comprehensive documentation in PROGRAMMATIC_API.md
- Updated README with programmatic API usage examples

### Changed

- Improved module structure with better exports
- Enhanced detection of module execution context

## [3.0.0] - 2025-04-26

### Added

- Streamable HTTP support for OpenAPI MCP generator, enabling efficient handling of large payloads and real-time data transfer.
- Major architectural refactor to support streaming responses and requests.

### Fixed

- Multiple bugs related to HTTP/HTTPS connection handling, stream closure, and error propagation in streaming scenarios.
- Fixed resource leak issues on server aborts and client disconnects during streaming.

### Changed

- Major version bump due to breaking changes in API and internal structures to support streaming.
- Updated documentation to reflect new streaming capabilities and usage instructions.
- Enhanced performance and robustness of HTTP/HTTPS transport layers.

## [2.0.0] - 2025-04-12

### Added

- Runtime argument validation using Zod
- JSON Schema to Zod schema conversion
- Improved error handling and formatting
- TypeScript strict mode enabled
- Buildable project structure with proper TypeScript configuration
- Enhanced project documentation
- Better support for OpenAPI request body handling
- Support for multiple content types

### Changed

- Simplified transport layer to only support stdio transport
- Removed support for WebSocket and HTTP transports
- Updated to use @modelcontextprotocol/sdk v1.9.0
- Improved CLI interface with better error messages
- Enhanced type safety throughout the codebase
- Better handling of path parameters and query strings
- More robust OpenAPI schema processing

### Fixed

- Path parameter resolution in URLs
- Content-Type header handling
- Response processing for different content types
- Schema validation error messages
- Building and packaging issues

## [1.0.0] - Initial Release

### Added

- Basic OpenAPI to MCP server generation
- Support for GET, POST, PUT, DELETE methods
- Basic error handling
- Simple CLI interface
- Basic TypeScript support
