# MCP relay

A small, open-source Cloudflare Worker that lets a browser page talk to MCP servers that do not send
CORS headers for it. The hosted [MCP playground](https://mcp.pidata.tech/playground/) uses it only
when you turn on "Route through relay", typically after a direct request was blocked.

## What it does

- Accepts `GET`, `POST`, `DELETE` and `OPTIONS` on `/`, with the real server in the `x-mcp-target`
  header (an absolute `https://` URL).
- Forwards the method, the body and the request headers, minus hop-by-hop headers, `Cookie`,
  `Origin`, `Referer`, `Host`, `cf-*`, `x-forwarded-*`, `sec-*` and `x-mcp-target`. Dropping `Origin`
  matters: some servers refuse any foreign origin, but answer a request without one.
- Streams the response back unchanged, so Server-Sent Events arrive as they are sent. `Set-Cookie`
  and upstream CORS headers are removed; its own CORS headers are added.
- Answers CORS preflight for the allowed origins, reflecting the requested headers (custom headers
  such as `x-api-key` work), and exposes `mcp-session-id`, `mcp-protocol-version`,
  `www-authenticate`, `retry-after`, `content-type` and `location` to the page.

It also carries the playground's OAuth requests (metadata discovery, client registration, token
exchange) when the relay is on, for authorization servers that block browser requests.

## What it never stores

Nothing. It has no storage bindings. It logs one line per request with the method, the target
**host** (not the path or query), the status and the duration. It never logs headers, tokens or
bodies.

Tokens and headers do pass through it in transit, which is why the playground shows that disclosure
next to the toggle and leaves the relay off by default. If that matters for your server, run your
own relay (below) or connect directly.

## Limits and abuse protection

| Guard                | Value                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed page origins | `ALLOWED_ORIGINS` (default `https://mcp.pidata.tech`); other origins and requests without `Origin` get 403                                                                                                                          |
| Targets              | `https://` only, default port only, no credentials in the URL                                                                                                                                                                       |
| Blocked hosts        | IP literals in private, loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6, including IPv4-mapped forms), `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan` and single-label names |
| Request bodies       | `POST` only, `application/json` or `application/x-www-form-urlencoded`, at most 1 MiB                                                                                                                                               |
| Responses            | at most 20 MiB; streams end after 15 minutes                                                                                                                                                                                        |
| Redirects            | same-origin redirects are followed (at most 5); a redirect to another origin returns 502 with the location in the message                                                                                                           |
| Rate limit           | 120 requests per minute per client IP, through the Workers Rate Limiting binding (counted per Cloudflare location, so approximate)                                                                                                  |

A single MCP session uses several requests (initialize, the initialized notification, each list and
call, and one long-lived GET stream for servers that keep sessions), so 120 a minute leaves room for
interactive use.

### Threat model

- **Open proxy abuse.** Only allowed origins get CORS, so other websites cannot use the relay from
  their visitors' browsers. A non-browser client can forge `Origin`, so the origin check is not
  authentication; the rate limit, size and time caps and https-only targets bound what such a client
  can do, and nothing reachable through the relay is more than that client could fetch itself.
- **SSRF.** Workers have no access to private networks, and the relay additionally refuses private
  and internal targets by IP literal and hostname, refuses non-default ports, and refuses
  cross-origin redirects, so a public host cannot bounce a request somewhere else. Hostnames that
  resolve to private addresses cannot be checked from a Worker; Cloudflare's network does not route
  them to your infrastructure.
- **Credential exposure.** The relay sees the tokens and headers it forwards. It keeps no copy and
  logs none of them. `src/index.ts` is the whole program.
- **Cookies.** Cookies are never forwarded in either direction, so a target cannot set state on the
  relay's origin and the relay never carries a browser's cookies.

## Run it locally

```sh
node relay/dev-server.mjs                 # http://127.0.0.1:8787, needs Node 22.18 or later
PORT=9000 ALLOWED_ORIGINS="http://localhost:5173" node relay/dev-server.mjs
# or, with wrangler:
cd relay && npm install && npx wrangler dev
```

The Node adapter imports the TypeScript source directly and has no rate limiter.

## Deploy

1. `cd relay && npm install` (installs wrangler, the only dev dependency; the Worker has no runtime
   dependencies).
2. `npx wrangler login`, then edit `wrangler.jsonc`:
   - `vars.ALLOWED_ORIGINS`: the origins of the pages that will use the relay.
   - `ratelimits[0].namespace_id`: any integer unique within your Cloudflare account; adjust
     `simple.limit` if needed (the period must be 10 or 60 seconds).
   - Optionally uncomment `routes` to serve it on a custom domain, for example
     `relay.mcp.pidata.tech`; otherwise it is served at `https://mcp-relay.<subdomain>.workers.dev`.
3. `npx wrangler deploy`.
4. Point the page at it: in the hosted playground's `playground.config.json`, set
   `"relayUrl": "https://relay.mcp.pidata.tech/"`, and allow that origin in the page's
   Content-Security-Policy `connect-src`.

## Cost

Each relayed request is one Worker request. The Workers free plan covers 100,000 requests a day; the
paid plan ($5 a month) includes 10 million requests a month, then $0.30 per million. Streaming
responses cost wall time, not CPU time, and the relay does almost no CPU work. Check Cloudflare's
current pricing before relying on these numbers.

## Tests

`tests/relay.test.ts` in the repository root runs the Worker's fetch handler in-process with an
injected upstream fetch: preflight, header filtering, Origin removal, SSRF rejections, size caps,
streaming, the time cap and the redirect rule. `tests/client.test.ts` also drives the playground
client through the relay against the MCP reference server.
