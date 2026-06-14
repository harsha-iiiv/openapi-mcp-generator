# openapi-mcp-generator v4.0.0 — "Hardened & Configurable"

**Date:** 2026-06-13
**Status:** Approved (design)
**Author:** Harsha v

## Goal

Resolve the backlog of open GitHub issues and PRs in a single, cohesive major
release. Every change is **non-breaking**: new behaviors are opt-in via CLI
flags / env vars, or are metadata-only additions. Defaults preserve current
output, except where current behavior is a security hole or an outright bug.

Already merged into `main` (no work needed): path+operation parameter merge
(#54), configurable `API_BASE_URL` env var (#58), endpoint filtering (#38),
BYO `OpenAPIV3.Document` (#37).

Deferred: MCPcat / OpenTelemetry analytics (#52) — invasive, adds runtime
deps, and has a standing PR. Out of scope for v4.0.0.

## Architecture

The generator is a pipeline of pure template-string functions:

- `src/parser/extract-tools.ts` — turns an OpenAPI doc into `McpToolDefinition[]`
- `src/utils/{code-gen,security,helpers,url}.ts` — emit code fragments
- `src/generator/*.ts` — assemble fragments into project files
- `src/index.ts` — CLI; `src/api.ts` — programmatic API

The work extends `CliOptions` with optional fields, threads them through the
generator functions, and hardens the template emitters. Public API signatures
(`getToolsFromOpenApi`, `generateMcpServer`) remain compatible.
`McpToolDefinition` gains **optional** `tags?: string[]` and
`deprecated?: boolean` — additive only.

## Workstream 1 — Security (default-on, no flag needed)

### #67 — Template-literal injection via OpenAPI description
`sanitizeForTemplate()` escapes backticks and backslashes but not `${`. A
malicious `description` like `${process.env}` is written verbatim into a
backtick template literal in generated `index.ts` and evaluated at startup.

**Fix:** extend `sanitizeForTemplate()` to also escape `$` that precedes `{`
(`.replace(/\$\{/g, '\\${')`). Order matters: escape backslashes first, then
backticks, then `${`. Add unit test with a malicious description.

### #68 — SSRF via uncontrolled external `$ref`
`SwaggerParser.dereference()` resolves `http(s)://` refs with live requests, no
allow-list. Exploitable in CI and on cloud VMs (metadata endpoints).

**Fix:** add CLI flag `--allow-external-refs` (default **false**) and
`GetToolsOptions.allowExternalRefs`. When false, configure the parser to refuse
external HTTP(S) resolution (via `SwaggerParser` resolver options disabling the
`http` resolver), so a spec with external refs fails fast with a clear error
rather than emitting requests. Local file refs still resolve. Document the flag.

## Workstream 2 — Bug fixes (default-on)

### #65 — `npm run build` fails on generated server
`response.headers['content-type']?.toLowerCase()` — header value is typed
`string | number | ... | AxiosHeaders`; `.toLowerCase()` doesn't exist on it.

**Fix:** in generated `executeApiTool`, coerce: `String(response.headers['content-type'] ?? '').toLowerCase()`.

### #56 — OAuth `SCHEMENAME` not replaced
`acquireOAuth2Token` reads literal `process.env['OAUTH_CLIENT_ID_SCHEMENAME']`
because `getEnvVarName('schemeName', ...)` is called at generation time with the
literal placeholder string. At runtime the function receives the real
`schemeName` arg but never uses it for the env lookup.

**Fix:** generate code that computes the env var name from the runtime
`schemeName` argument, e.g.
`process.env['OAUTH_CLIENT_ID_' + schemeName.replace(/[^a-zA-Z0-9]/g,'_').toUpperCase()]`
— mirroring the pattern already used in `generateExecuteApiToolFunction`.

### #66 — Basic auth fails when password is empty
`if (username && password)` treats an empty password (valid per RFC 7617, e.g.
Dropbox Sign) as missing. Fix all three sites: availability check, applied-auth
code, and `generateHttpSecurityCode()`. Use `if (username != null)` and
`password ?? ''`. (Adopts PR #66.)

### #41 — Array query params serialized incorrectly
axios defaults to `fields[]=a&fields[]=b`; many APIs want `fields=a,b`.

**Fix:** add a `paramsSerializer` to the generated axios config that joins array
values as comma-separated. Only affects array-valued params (currently broken),
so it is safe-by-default. (Adopts PR #41 intent.)

## Workstream 3 — Non-breaking features (opt-in / metadata)

### #4 — Tool names over 64 chars (Claude Desktop limit)
**Flag:** `--max-tool-name-length <n>` (default **64**). In
`extractToolsFromApi`, after sanitizing, if `name.length > max`, truncate to
`max` chars; on truncation/collision append a short deterministic hash suffix
within the limit. Uniqueness set already exists. Default 64 changes output only
for specs that were already broken in Claude Desktop.

### #55 — Per-request API key via MCP headers (web / streamable-http)
**Flag:** `--header-passthrough <comma-separated-names>`. Generated web /
streamable-http transports capture the listed inbound HTTP headers and forward
them onto the upstream API request, overriding env-based auth for those headers.
Stdio transport unaffected (no inbound headers). Documented in README + .env.

### #48 — Base URL via env var
Already implemented (`process.env.API_BASE_URL || "<determined>"`). Work:
surface `API_BASE_URL` in `.env.example` and README so users discover it.

### #59 — OpenAPI tags in tool interface
Extract `operation.tags` into `McpToolDefinition.tags`. Emit into the tool
definition map and append `(Tags: a, b)` to the tool description for
filtering/grouping. Metadata-only, default on. (Adopts PR #59.)

### #49 — Expose `deprecated` attribute
Extract `operation.deprecated` (default `false`) into
`McpToolDefinition.deprecated`, emit into tool map, and prefix description with
a `[DEPRECATED]` marker. Metadata-only, default on. (Adopts PR #49.)

### #46 — Allow insecure HTTPS (self-signed certs)
**Flag:** `--insecure` / `-k` (default false). When set, generated axios
requests (incl. OAuth token acquisition) use an `https.Agent({ rejectUnauthorized:
false })`. Off by default — TLS verification unchanged. (Adopts PR #46.)

### #50 — PORT env fallback + library mode
- Generated transports resolve port as `options.port ?? process.env.PORT ?? 3000`.
- **Flag:** `--generate-lib` exports `main()` and omits the auto-invoke +
  signal-handler/cleanup block, so the entry can be imported as a library.
  Default off. (Adopts PR #50 intent.)

## Workstream 4 — Larger opt-in features

### #9 — Customizable auth interface
**Flag:** `--custom-auth`. Generates `src/auth.ts` exporting
`export async function applyCustomAuth(ctx: { headers, queryParams, toolName, definition }): Promise<boolean>`.
The generated `executeApiTool` calls it before built-in auth; returning `true`
short-circuits built-in auth application. The file is a user-editable stub with
a no-op default. Off by default.

### #8 — OAuth client creds in request body
**Flag:** `--oauth-creds-in-body`. Generated `acquireOAuth2Token` sends
`client_id` / `client_secret` in the `application/x-www-form-urlencoded` body
instead of the Basic `Authorization` header. Off by default (header remains the
default per current behavior). (Adopts issue #8 / PRs #7, #13 intent.)

## Type changes (additive)

```ts
interface CliOptions {
  // ...existing...
  allowExternalRefs?: boolean;     // #68
  maxToolNameLength?: number;      // #4  (default 64)
  headerPassthrough?: string[];    // #55
  insecure?: boolean;              // #46
  generateLib?: boolean;           // #50
  customAuth?: boolean;            // #9
  oauthCredsInBody?: boolean;      // #8
}

interface McpToolDefinition {
  // ...existing...
  tags?: string[];                 // #59
  deprecated?: boolean;            // #49
}

interface GetToolsOptions {
  // ...existing...
  allowExternalRefs?: boolean;     // #68
  maxToolNameLength?: number;      // #4
}
```

## Testing

Unit tests (Jest) per fix:
- `sanitizeForTemplate` escapes `${`, backticks, backslashes (#67)
- external-ref spec is rejected when `allowExternalRefs` is false (#68)
- OAuth env var names derive from runtime scheme name (#56)
- basic auth applied when password empty (#66)
- array query param serialized CSV (#41)
- tool name truncated to <=64 with uniqueness preserved (#4)
- `tags` / `deprecated` extracted into `McpToolDefinition` (#59, #49)

Integration smoke test: generate from `examples` petstore spec into a temp dir
and run `tsc --noEmit` on the output to catch #65-class regressions.

## Version & docs

- Bump to **4.0.0** in `package.json`.
- Update `CHANGELOG.md` with grouped entries (Security / Fixed / Added).
- Update `README.md`: new CLI flags table, `.env.example` notes, custom-auth and
  insecure usage.

## Non-goals

- MCPcat / OpenTelemetry analytics (#52) — deferred.
- Any change to the public API that breaks existing callers.
- Touching the in-progress Cloudflare Worker work on other branches.
