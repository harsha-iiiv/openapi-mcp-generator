# Security Policy

## Supported versions

| Version | Supported                                                      |
| ------- | -------------------------------------------------------------- |
| 5.x     | Yes, security fixes are released for the latest minor version. |
| < 5.0   | No. Please upgrade to 5.x.                                     |

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**
(<https://github.com/harsha-iiiv/openapi-mcp-generator/security/advisories/new>).

Include the affected version, the command or a minimal OpenAPI document that reproduces the
issue, and the impact you observed.

What to expect:

- An acknowledgement within 3 business days.
- An initial assessment within 7 days.
- For confirmed issues: a fix or mitigation, a coordinated disclosure date, and credit in the
  advisory and changelog unless you prefer to stay anonymous.

## Scope

In scope:

- The generator CLI and programmatic API: specification parsing and code generation.
- Code emitted into generated servers (`stdio`, `web`, `streamable-http`, `cloudflare-worker`),
  including authentication and request handling.

Out of scope:

- Vulnerabilities in the upstream APIs that generated servers call.
- Deployments that ignore the documented guidance, for example exposing an HTTP transport
  publicly without `--inbound-auth` while it holds upstream credentials.

## Security model of generated servers

- **Specifications are untrusted input.** External `http(s)` `$ref`s are not fetched unless you
  pass `--allow-external-refs`, and descriptions are escaped before they are embedded in code.
- **Upstream credentials** come from environment variables (Node) or Wrangler secrets (Workers)
  and are never written into generated files.
- **HTTP transports are public unless generated with `--inbound-auth bearer`.** With it, every
  MCP request needs `Authorization: Bearer <token>`. Tokens are read at runtime from
  `MCP_AUTH_TOKEN` (or comma-separated `MCP_AUTH_TOKENS` for rotation) and compared in constant
  time on SHA-256 digests. The endpoint fails closed (`503`) when no token is configured, and
  SSE sessions are bound to the token that opened them; stateless Streamable HTTP checks the
  token on every request.
- **Browser origins** are validated on Node HTTP servers: requests whose `Origin` is not
  loopback or listed in `MCP_ALLOWED_ORIGINS` are refused, which blocks DNS rebinding.
- **Upstream security requirements** follow OpenAPI semantics: alternatives are tried in order,
  every scheme of an alternative must be satisfied, and an incomplete set of credentials is
  never sent.
- **`--header-passthrough`** forwards only the headers you list, and refuses `Authorization`
  while inbound auth is on (it would leak the MCP token upstream).
- **stdio servers** have no network endpoint; only the process that launches them can talk to
  them.

## Past advisories

| Issue | Summary                                                             | Fixed in | Reported by  |
| ----- | ------------------------------------------------------------------- | -------- | ------------ |
| #67   | Template-literal injection through unsanitized OpenAPI descriptions | 4.0.0    | @Arasuhacker |
| #68   | SSRF through unrestricted external `$ref` resolution during parsing | 4.0.0    | @Arasuhacker |
