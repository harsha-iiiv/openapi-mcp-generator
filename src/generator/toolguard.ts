/**
 * Optional mcp-toolguard integration (`--toolguard`).
 *
 * mcp-toolguard (https://github.com/harsha-iiiv/mcp-toolguard, npm `mcp-toolguard-cli`) is a local
 * proxy that sits between an MCP client and an MCP server and blocks poisoned tool descriptions,
 * rug pulls, secret exfiltration and injected tool results. Because the generator knows every tool
 * and whether it only reads (from the HTTP method and `x-mcp-annotations`), it can write a policy
 * tailored to the API:
 *
 *   - only the generated tools are allowed; anything else the server lists or is called with is blocked
 *   - calls that can change data (every tool that is not read-only) need human approval
 *   - destructive tools are listed so they can be denied outright with one edit
 *
 * Nothing here adds a dependency to the generator or to the generated project: the scripts run
 * mcp-toolguard through `npx`, pinned to a minor version.
 */
import type { McpToolDefinition, TransportType } from '../types/index.js';

/** npm package and version range of mcp-toolguard used in generated scripts and configs. */
export const TOOLGUARD_PACKAGE = 'mcp-toolguard-cli@0.2';

/** File name of the generated policy (mcp-toolguard also finds it automatically in the cwd). */
export const TOOLGUARD_POLICY_FILE = 'toolguard.yaml';

/** Transports a generated project can be guarded on (the Worker target runs on Cloudflare, not locally). */
export function supportsToolguard(transport: TransportType | string | undefined): boolean {
  return transport === undefined || ['stdio', 'web', 'streamable-http'].includes(transport);
}

/** Tool names partitioned by what they can do, from the tool annotations. */
export interface ToolguardToolSets {
  readOnly: string[];
  /** Not read-only: creates or updates data (POST, PUT, PATCH by default). */
  writes: string[];
  /** Subset of `writes` with destructiveHint (PUT, PATCH, DELETE by default). */
  destructive: string[];
}

export function classifyTools(tools: McpToolDefinition[]): ToolguardToolSets {
  const sets: ToolguardToolSets = { readOnly: [], writes: [], destructive: [] };
  for (const tool of tools) {
    // Missing annotations are treated as "may write": the safe default for a security policy.
    if (tool.annotations?.readOnlyHint === true) {
      sets.readOnly.push(tool.name);
      continue;
    }
    sets.writes.push(tool.name);
    if (tool.annotations?.destructiveHint !== false) sets.destructive.push(tool.name);
  }
  return sets;
}

/** A YAML flow sequence of quoted strings (JSON strings are valid YAML). */
function yamlList(names: string[]): string {
  return names.length === 0
    ? ' []'
    : `\n${names.map((n) => `    - ${JSON.stringify(n)}`).join('\n')}`;
}

/** Whether the transport is a network server that toolguard connects to by URL. */
function isHttpTransport(transport: TransportType | string | undefined): boolean {
  return transport === 'web' || transport === 'streamable-http';
}

/** Environment variable the generated HTTP server checks with `--inbound-auth bearer`. */
export const INBOUND_TOKEN_ENV = 'MCP_AUTH_TOKEN';
/** Comma-separated tokens for rotation; the server prefers it over MCP_AUTH_TOKEN when set. */
export const INBOUND_TOKENS_ENV = 'MCP_AUTH_TOKENS';

/** Options for the guarded command. */
export interface ToolguardRunOptions {
  /** The generated HTTP server requires `Authorization: Bearer <token>` (`--inbound-auth bearer`). */
  bearer?: boolean;
  /**
   * Text that stands in for the token in the Authorization header. The token itself is never
   * written into generated files. Default: a `<MCP_AUTH_TOKEN>` placeholder for docs.
   */
  tokenText?: string;
}

/** The command an MCP client runs to start the guarded server, for docs and next steps. */
export function toolguardRunArgs(
  serverName: string,
  transport: TransportType | string | undefined,
  port: number,
  opts: ToolguardRunOptions = {}
): string[] {
  const base = [
    '-y',
    TOOLGUARD_PACKAGE,
    'run',
    '--policy',
    TOOLGUARD_POLICY_FILE,
    '--server-id',
    serverName,
  ];
  if (!isHttpTransport(transport)) return [...base, '--', 'node', 'build/index.js'];
  const url = transport === 'web' ? `http://localhost:${port}/sse` : `http://localhost:${port}/mcp`;
  const auth = opts.bearer
    ? ['--header', `Authorization: Bearer ${opts.tokenText ?? `<${INBOUND_TOKEN_ENV}>`}`]
    : [];
  return [...base, '--transport', transport === 'web' ? 'sse' : 'http', '--url', url, ...auth];
}

/**
 * Generates toolguard.yaml for the given tools. The policy is valid for mcp-toolguard 0.2
 * (`mcp-toolguard check-policy toolguard.yaml`).
 */
export function generateToolguardPolicy(
  tools: McpToolDefinition[],
  serverName: string,
  transport: TransportType | string | undefined,
  port: number,
  opts: Pick<ToolguardRunOptions, 'bearer'> = {}
): string {
  const { readOnly, writes, destructive } = classifyTools(tools);
  const http = isHttpTransport(transport);
  const projectDir = `/absolute/path/to/${serverName}`;
  const args = toolguardRunArgs(serverName, transport, port, opts).map((a) =>
    a === TOOLGUARD_POLICY_FILE ? `${projectDir}/${TOOLGUARD_POLICY_FILE}` : a
  );
  const clientArgs = JSON.stringify(
    args.map((a) => (a === 'build/index.js' ? `${projectDir}/build/index.js` : a))
  );
  const startCmd = transport === 'web' ? 'npm run start:web' : 'npm run start:http';
  const transportNotes = http
    ? `#
# Build and start the server first (npm run build && ${startCmd}); toolguard connects to its URL.
# The policy applies only to calls that go through toolguard: a client that connects to the server's
# own port directly skips it.${opts.bearer ? '' : ' Use --inbound-auth bearer so a direct connection needs a token.'}
${
  opts.bearer
    ? `# The server requires a bearer token: replace <${INBOUND_TOKEN_ENV}> with the value from .env (it is a
# secret, so keep that client config private). npm run start:guarded reads it from the environment
# instead, like the server: the first entry of ${INBOUND_TOKENS_ENV}, else ${INBOUND_TOKEN_ENV} (export it first).
`
    : ''
}`
    : `#
# Run npm run build first: the client config above starts build/index.js, which npm install does not create.
# The server loads .env from its working directory. Either start the entry from ${projectDir}
# (if your client supports a working directory) or pass the variables from .env in the entry's
# "env" object: absolute paths alone do not load .env.
`;

  return `# mcp-toolguard policy for ${serverName}
# Generated by openapi-mcp-generator --toolguard. Docs: https://github.com/harsha-iiiv/mcp-toolguard
#
# mcp-toolguard runs between your MCP client and this server. It blocks poisoned tool descriptions,
# tools that change after you approved them (rug pulls), secrets in tool arguments and prompt
# injection in API responses. Every decision goes to a tamper-evident audit log
# (~/.mcp-toolguard/audit.jsonl; check it with: npx ${TOOLGUARD_PACKAGE} verify-log <file>).
#
# Try it:            npm run start:guarded
# Validate policy:   npx ${TOOLGUARD_PACKAGE} check-policy ${TOOLGUARD_POLICY_FILE}
# Approve a call:    npx ${TOOLGUARD_PACKAGE} approve <id>      (the id is in the tool result)
#
# MCP client config (Claude Desktop, Cursor, Claude Code: "mcpServers"; VS Code: "servers"):
#   "${serverName}": { "command": "npx", "args": ${clientArgs} }
${transportNotes}
version: 1
mode: enforce # "monitor" logs and warns but never blocks: useful for a first run

tools:
  # Only the ${tools.length} tool(s) this project was generated with. A tool the server was not built
  # with (for example from a modified build) is hidden and its calls are blocked.
  allow:${yamlList(tools.map((t) => t.name))}
  unlisted: block
  unknown: block
  # Destructive tools (DELETE/PUT/PATCH unless x-mcp-annotations says otherwise). To forbid them
  # entirely instead of asking for approval, uncomment:
  # deny: ${destructive.length ? JSON.stringify(destructive) : '[]'}

approval:
  # ${writes.length} tool(s) that can change data (not read-only) wait for a human:
  # the model gets "APPROVAL REQUIRED ... approve <id>", you run \`npx ${TOOLGUARD_PACKAGE} approve <id>\`,
  # and the identical call then goes through once. Read-only tools (${readOnly.length}) run without asking.
  tools:${yamlList(writes)}
`;
}

/** Quote one argument for the POSIX shell that runs npm scripts. */
function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\`])/g, '\\$1')}"`;
}

/** Shell variable the start script resolves the bearer token into. */
const SCRIPT_TOKEN_VAR = 'TOOLGUARD_TOKEN';

/**
 * package.json script that runs the server behind mcp-toolguard. With bearer auth the token is read
 * from the environment at run time, never written into package.json. Like the generated server, it
 * uses the first MCP_AUTH_TOKENS entry when that is set (rotation), else MCP_AUTH_TOKEN, and stops
 * with a clear message when neither is set. The script needs a POSIX shell (macOS, Linux, WSL).
 */
export function toolguardStartScript(
  serverName: string,
  transport: TransportType | string | undefined,
  port: number,
  opts: Pick<ToolguardRunOptions, 'bearer'> = {}
): string {
  const v = SCRIPT_TOKEN_VAR;
  const tokenText = `\${${v}:?export ${INBOUND_TOKEN_ENV} or ${INBOUND_TOKENS_ENV} (see .env) first}`;
  const args = toolguardRunArgs(serverName, transport, port, { ...opts, tokenText });
  const cmd = ['npx', ...args]
    .map((a) => (a.includes(tokenText) ? `"${a}"` : shellArg(a)))
    .join(' ');
  if (!isHttpTransport(transport)) return `npm run build && ${cmd}`;
  if (!opts.bearer) return cmd;
  // First comma-separated MCP_AUTH_TOKENS entry (spaces trimmed, as the server does), else MCP_AUTH_TOKEN.
  const pick = [
    `${v}="\${${INBOUND_TOKENS_ENV}%%,*}"`,
    `${v}="\${${v}#"\${${v}%%[! ]*}"}"`,
    `${v}="\${${v}%"\${${v}##*[! ]}"}"`,
    `${v}="\${${v}:-\$${INBOUND_TOKEN_ENV}}"`,
  ].join('; ');
  return `${pick}; ${cmd}`;
}
