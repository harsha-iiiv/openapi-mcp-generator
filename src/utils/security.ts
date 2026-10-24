/**
 * Security handling utilities for OpenAPI to MCP generator
 */
import { OpenAPIV3 } from 'openapi-types';

/**
 * Get environment variable name for a security scheme
 *
 * @param schemeName Security scheme name
 * @param type Type of security credentials
 * @returns Environment variable name
 */
export function getEnvVarName(
  schemeName: string,
  type:
    | 'API_KEY'
    | 'BEARER_TOKEN'
    | 'BASIC_USERNAME'
    | 'BASIC_PASSWORD'
    | 'OAUTH_CLIENT_ID'
    | 'OAUTH_CLIENT_SECRET'
    | 'OAUTH_TOKEN'
    | 'OAUTH_SCOPES'
    | 'OPENID_TOKEN'
): string {
  const sanitizedName = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `${type}_${sanitizedName}`;
}

/**
 * Generates code for handling API key security
 *
 * @param scheme API key security scheme
 * @returns Generated code
 */
export function generateApiKeySecurityCode(scheme: OpenAPIV3.ApiKeySecurityScheme): string {
  const schemeName = 'schemeName'; // Placeholder, will be replaced in template
  return `
    if (scheme?.type === 'apiKey') {
        const apiKey = process.env[\`${getEnvVarName(schemeName, 'API_KEY')}\`];
        if (apiKey) {
            if (scheme.in === 'header') {
                headers[scheme.name.toLowerCase()] = apiKey;
            }
            else if (scheme.in === 'query') {
                queryParams[scheme.name] = apiKey;
            }
            else if (scheme.in === 'cookie') {
                headers['cookie'] = \`\${scheme.name}=\${apiKey}\${headers['cookie'] ? \`; \${headers['cookie']}\` : ''}\`;
            }
        }
    }`;
}

/**
 * Generates code for handling HTTP security (Bearer/Basic)
 *
 * @returns Generated code
 */
export function generateHttpSecurityCode(): string {
  const schemeName = 'schemeName'; // Placeholder, will be replaced in template
  return `
    else if (scheme?.type === 'http') {
        if (scheme.scheme?.toLowerCase() === 'bearer') {
            const token = process.env[\`${getEnvVarName(schemeName, 'BEARER_TOKEN')}\`];
            if (token) {
                headers['authorization'] = \`Bearer \${token}\`;
            }
        } 
        else if (scheme.scheme?.toLowerCase() === 'basic') {
            const username = process.env[\`${getEnvVarName(schemeName, 'BASIC_USERNAME')}\`];
            const password = process.env[\`${getEnvVarName(schemeName, 'BASIC_PASSWORD')}\`];
            // Empty password is valid per RFC 7617 (issue #66); only username is required.
            if (username != null) {
                headers['authorization'] = \`Basic \${Buffer.from(\`\${username}:\${password ?? ''}\`).toString('base64')}\`;
            }
        }
    }`;
}

/**
 * Options controlling generated security/execution code.
 */
export interface SecurityCodeOptions {
  /** Skip TLS verification for generated requests (issue #46). */
  insecure?: boolean;
  /** Send OAuth2 client credentials in the request body, not Basic header (issue #8). */
  oauthCredsInBody?: boolean;
  /** Inbound header names to forward to the upstream API (issue #55). */
  headerPassthrough?: string[];
  /** Generate and invoke a custom auth hook before built-in auth (issue #9). */
  customAuth?: boolean;
  /** Target transport; header passthrough only works on the HTTP transports. */
  transport?: string;
}

/**
 * Generates code for OAuth2 token acquisition.
 *
 * The env-var lookups are computed from the *runtime* `schemeName` argument
 * (not a literal placeholder) so per-scheme credentials resolve correctly
 * (issue #56).
 *
 * @param options Generation options affecting the emitted code
 * @returns Generated code for OAuth2 token acquisition
 */
export function generateOAuth2TokenAcquisitionCode(options: SecurityCodeOptions = {}): string {
  // Runtime env-var expression for a given credential prefix.
  const env = (prefix: string) =>
    `process.env[\`${prefix}_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`]`;

  // Token request: credentials in body (issue #8) or Basic header (default).
  const bodyCreds = options.oauthCredsInBody
    ? `
        // Send client credentials in the request body
        formData.append('client_id', clientId);
        formData.append('client_secret', clientSecret);`
    : '';
  const tokenRequestHeaders = options.oauthCredsInBody
    ? `'Content-Type': 'application/x-www-form-urlencoded'`
    : `'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': \`Basic \${Buffer.from(\`\${clientId}:\${clientSecret}\`).toString('base64')}\``;

  // Insecure HTTPS agent (issue #46).
  const insecureAgent = options.insecure
    ? `,
            httpsAgent: insecureHttpsAgent`
    : '';

  return `
/**
 * Type definition for cached OAuth tokens
 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

/**
 * Declare global __oauthTokenCache property for TypeScript
 */
declare global {
    var __oauthTokenCache: Record<string, TokenCacheEntry> | undefined;
}

/**
 * Acquires an OAuth2 token using client credentials flow
 * 
 * @param schemeName Name of the security scheme
 * @param scheme OAuth2 security scheme
 * @param requiredScopes Scopes declared by the operation's security requirement
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any, requiredScopes: string[] = []): Promise<string | null | undefined> {
    try {
        // Check if we have the necessary credentials (resolved per-scheme at runtime)
        const clientId = ${env('OAUTH_CLIENT_ID')};
        const clientSecret = ${env('OAUTH_CLIENT_SECRET')};
        const configuredScopes = ${env('OAUTH_SCOPES')};
        // An explicit OAUTH_SCOPES_<SCHEME> wins; otherwise request the scopes the
        // operation's security requirement declares (issue #81).
        const scopes = configuredScopes || (requiredScopes.length > 0 ? requiredScopes.join(' ') : '');

        if (!clientId || !clientSecret) {
            console.error(\`Missing client credentials for OAuth2 scheme '\${schemeName}'\`);
            return null;
        }
        
        // Initialize token cache if needed
        if (typeof global.__oauthTokenCache === 'undefined') {
            global.__oauthTokenCache = {};
        }
        
        // Check if we have a cached token
        // Cache per scope set so a narrower token is never reused for a wider requirement.
        const cacheKey = \`\${schemeName}_\${clientId}_\${scopes}\`;
        const cachedToken = global.__oauthTokenCache[cacheKey];
        const now = Date.now();
        
        if (cachedToken && cachedToken.expiresAt > now) {
            console.error(\`Using cached OAuth2 token for '\${schemeName}' (expires in \${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)\`);
            return cachedToken.token;
        }
        
        // Determine token URL based on flow type
        let tokenUrl = '';
        if (scheme.flows?.clientCredentials?.tokenUrl) {
            tokenUrl = scheme.flows.clientCredentials.tokenUrl;
            console.error(\`Using client credentials flow for '\${schemeName}'\`);
        } else if (scheme.flows?.password?.tokenUrl) {
            tokenUrl = scheme.flows.password.tokenUrl;
            console.error(\`Using password flow for '\${schemeName}'\`);
        } else {
            console.error(\`No supported OAuth2 flow found for '\${schemeName}'\`);
            return null;
        }
        
        // Prepare the token request
        let formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        
        // Add scopes if specified
        if (scopes) {
            formData.append('scope', scopes);
        }${bodyCreds}

        console.error(\`Requesting OAuth2 token from \${tokenUrl}\`);

        // Make the token request
        const response = await axios({
            method: 'POST',
            url: tokenUrl,
            headers: {
                ${tokenRequestHeaders}
            },
            data: formData.toString()${insecureAgent}
        });
        
        // Process the response
        if (response.data?.access_token) {
            const token = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600; // Default to 1 hour
            
            // Cache the token
            global.__oauthTokenCache[cacheKey] = {
                token,
                expiresAt: now + (expiresIn * 1000) - 60000 // Expire 1 minute early
            };
            
            console.error(\`Successfully acquired OAuth2 token for '\${schemeName}' (expires in \${expiresIn} seconds)\`);
            return token;
        } else {
            console.error(\`Failed to acquire OAuth2 token for '\${schemeName}': No access_token in response\`);
            return null;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(\`Error acquiring OAuth2 token for '\${schemeName}':\`, errorMessage);
        return null;
    }
}
`;
}

/**
 * Returns the top-of-module import statements the generated security/execution
 * code requires, given the active options. These must be emitted at the top of
 * the generated module (ES module imports cannot appear mid-file).
 *
 * @param options Generation options
 * @returns Import statements (possibly empty), newline-terminated
 */
export function getSecurityModuleImports(options: SecurityCodeOptions = {}): string {
  let imports = '';
  if (options.insecure) {
    imports += `import * as https from 'https';\n`;
  }
  if (options.customAuth) {
    imports += `import { applyCustomAuth } from './auth.js';\n`;
  }
  if (
    Array.isArray(options.headerPassthrough) &&
    options.headerPassthrough.filter(Boolean).length
  ) {
    imports += `import { AsyncLocalStorage } from 'async_hooks';\n`;
  }
  return imports;
}

/**
 * Declaration for the request-scoped inbound-header store used by header
 * passthrough (issue #55). Exported so the web/streamable-http transports can
 * run each request inside `inboundHeaderStore.run(headers, ...)`, giving
 * concurrency-safe, per-request header forwarding (no shared global state).
 *
 * @param options Generation options
 * @returns Declaration source (empty unless header passthrough is enabled)
 */
export function getInboundHeaderStoreDeclaration(options: SecurityCodeOptions = {}): string {
  const enabled =
    Array.isArray(options.headerPassthrough) &&
    options.headerPassthrough.filter(Boolean).length > 0;
  if (!enabled) return '';
  return `
/**
 * Request-scoped storage for inbound headers eligible for passthrough.
 * The transports populate this per request; executeApiTool reads it.
 */
export const inboundHeaderStore = new AsyncLocalStorage<Record<string, string>>();
`;
}

/**
 * Generates code for executing API tools with security handling
 *
 * @param securitySchemes Security schemes from OpenAPI spec
 * @param options Generation options affecting the emitted code
 * @returns Generated code for the execute API tool function
 */
export function generateExecuteApiToolFunction(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes'],
  options: SecurityCodeOptions = {}
): string {
  // Generate OAuth2 token acquisition function
  const oauth2TokenAcquisitionCode = generateOAuth2TokenAcquisitionCode(options);

  // Insecure HTTPS agent declaration (issue #46), shared by token + tool requests.
  // Note: the `https` import is emitted at the top of the generated module by
  // getSecurityModuleImports(); this only declares the shared agent constant.
  const insecurePreamble = options.insecure
    ? `
/** Shared HTTPS agent that skips TLS verification (enabled via --insecure). */
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });
`
    : '';

  // Insecure agent applied to the per-tool axios request config (issue #46).
  const insecureAgentToolConfig = options.insecure ? `\n      httpsAgent: insecureHttpsAgent,` : '';

  // Custom auth hook invocation (issue #9). When the hook returns true, the
  // built-in auth block below is skipped (guarded by !customAuthHandled).
  const customAuthCall = options.customAuth
    ? `
    // Custom auth hook (see src/auth.ts). Returning true short-circuits built-in auth.
    const customAuthHandled = await applyCustomAuth({ headers, queryParams, toolName, definition });
    if (customAuthHandled) {
        console.error(\`Custom auth applied for tool '\${toolName}', skipping built-in auth.\`);
    }
`
    : '';
  // Built-in auth is wrapped in this guard so a custom hook can fully own auth.
  const builtinAuthGuardOpen = options.customAuth ? '    if (!customAuthHandled) {\n' : '';
  const builtinAuthGuardClose = options.customAuth ? '\n    }' : '';

  // Header passthrough (issue #55): forward selected inbound headers to the
  // upstream API. Headers are read from request-scoped AsyncLocalStorage (set
  // by the web/streamable-http transports), NOT a shared global, so concurrent
  // requests cannot leak each other's credentials. No-op for stdio.
  const headerPassthroughNames = Array.isArray(options.headerPassthrough)
    ? options.headerPassthrough.filter(Boolean)
    : [];
  // The configured headers this request carries are collected before upstream auth,
  // so they also count as credentials for the schemes they carry.
  const forwardedHeadersCode =
    headerPassthroughNames.length > 0
      ? `
    // Configured inbound headers present on this request (issue #55)
    const __passthroughHeaderNames = ${JSON.stringify(headerPassthroughNames.map((h) => h.toLowerCase()))};
    const forwardedHeaders: Record<string, string> = {};
    const __inboundHeaders = inboundHeaderStore.getStore();
    if (__inboundHeaders) {
        for (const __name of __passthroughHeaderNames) {
            const __val = __inboundHeaders[__name];
            if (typeof __val !== 'undefined') {
                forwardedHeaders[__name] = __val;
            }
        }
    }
`
      : `
    const forwardedHeaders: Record<string, string> = {};
`;
  const headerPassthroughCode =
    headerPassthroughNames.length > 0
      ? `
    // Forward configured inbound headers to the upstream API (issue #55)
    for (const [__name, __val] of Object.entries(forwardedHeaders)) {
        headers[__name] = __val;
    }
`
      : '';

  // Headers a client can send instead of a configured credential (HTTP transports only;
  // stdio has no inbound headers).
  const passthroughHintNames =
    options.transport === 'web' || options.transport === 'streamable-http'
      ? headerPassthroughNames.map((h) => h.toLowerCase())
      : [];

  // Upstream auth (issue #81): OpenAPI Security Requirement semantics. Every
  // requirement object is an alternative (OR); every scheme inside one object must
  // be satisfied together (AND). Credentials are resolved for a whole alternative
  // before any are applied, so an incomplete AND group is never sent.
  const securityCode = `
    // Apply upstream credentials for this operation's security requirements
    // (OR across requirement objects, AND within one; see resolveSecurityRequirements).
    const securityResolution = await resolveSecurityRequirements(definition.securityRequirements, allSecuritySchemes, forwardedHeaders);
    if (securityResolution.status === 'applied') {
        for (const credential of securityResolution.credentials) {
            applyUpstreamCredential(credential, headers, queryParams);
            console.error(\`Applied \${credential.description}\`);
        }
    } else if (securityResolution.status === 'unsatisfied') {
        // Fail closed (issue #82): do not call the API without the credentials it requires,
        // unless MCP_ALLOW_MISSING_CREDENTIALS=true restores the old warn-and-send behavior.
        if (String(process.env.MCP_ALLOW_MISSING_CREDENTIALS ?? '').toLowerCase() === 'true') {
            console.warn(\`Tool '\${toolName}' requires security: \${securityResolution.summary}, but no complete set of credentials is configured. Sending the request without upstream credentials (MCP_ALLOW_MISSING_CREDENTIALS=true).\`);
        } else {
            const message = describeMissingCredentials(toolName, definition.securityRequirements, allSecuritySchemes, ${JSON.stringify(passthroughHintNames)});
            console.error(message);
            return { isError: true, content: [{ type: 'text', text: message }] };
        }
    }
    `;

  // Helpers emitted once at module scope, next to the OAuth2 token code.
  const securityResolutionHelpers = `
/**
 * A credential to place on the upstream request for one security scheme.
 */
interface UpstreamCredential {
    schemeName: string;
    location: 'header' | 'query' | 'cookie';
    name: string;
    value: string;
    description: string;
}

/**
 * Outcome of resolving a tool's OpenAPI security requirements.
 */
type SecurityResolution =
    | { status: 'none' }
    | { status: 'optional' }
    | { status: 'applied'; credentials: UpstreamCredential[] }
    | { status: 'unsatisfied'; summary: string };

/**
 * Reads a per-scheme credential from the environment, e.g. API_KEY_PETSTORE_AUTH.
 */
function getSchemeEnv(prefix: string, schemeName: string): string | undefined {
    return process.env[\`\${prefix}_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
}

/**
 * Resolves the credential for one security scheme, or null when it is not
 * configured or cannot be obtained (for example, an OAuth2 token request failed).
 */
async function resolveSchemeCredential(
    schemeName: string,
    scheme: any,
    scopes: string[]
): Promise<UpstreamCredential | null> {
    if (!scheme) return null;

    // API Key security (header, query, cookie)
    if (scheme.type === 'apiKey') {
        const apiKey = getSchemeEnv('API_KEY', schemeName);
        if (!apiKey || !scheme.name) return null;
        const location: UpstreamCredential['location'] =
            scheme.in === 'query' ? 'query' : scheme.in === 'cookie' ? 'cookie' : 'header';
        return {
            schemeName,
            location,
            name: location === 'header' ? String(scheme.name).toLowerCase() : String(scheme.name),
            value: apiKey,
            description: \`API key '\${schemeName}' in \${location} '\${scheme.name}'\`,
        };
    }

    // HTTP security (bearer, basic)
    if (scheme.type === 'http') {
        const httpScheme = String(scheme.scheme ?? '').toLowerCase();
        if (httpScheme === 'bearer') {
            const token = getSchemeEnv('BEARER_TOKEN', schemeName);
            if (!token) return null;
            return {
                schemeName,
                location: 'header',
                name: 'authorization',
                value: \`Bearer \${token}\`,
                description: \`Bearer token for '\${schemeName}'\`,
            };
        }
        if (httpScheme === 'basic') {
            const username = getSchemeEnv('BASIC_USERNAME', schemeName);
            // Empty password is valid per RFC 7617 (issue #66); only username is required.
            if (username == null) return null;
            const password = getSchemeEnv('BASIC_PASSWORD', schemeName) ?? '';
            return {
                schemeName,
                location: 'header',
                name: 'authorization',
                value: \`Basic \${Buffer.from(\`\${username}:\${password}\`).toString('base64')}\`,
                description: \`Basic authentication for '\${schemeName}'\`,
            };
        }
        return null;
    }

    // OAuth2: a pre-provided token, or client credentials for automatic acquisition
    if (scheme.type === 'oauth2') {
        let token = getSchemeEnv('OAUTH_TOKEN', schemeName);
        if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
            token = (await acquireOAuth2Token(schemeName, scheme, scopes)) ?? undefined;
        }
        if (!token) return null;
        return {
            schemeName,
            location: 'header',
            name: 'authorization',
            value: \`Bearer \${token}\`,
            description: \`OAuth2 token for '\${schemeName}'\${scopes.length > 0 ? \` (scopes: \${scopes.join(', ')})\` : ''}\`,
        };
    }

    // OpenID Connect
    if (scheme.type === 'openIdConnect') {
        const token = getSchemeEnv('OPENID_TOKEN', schemeName);
        if (!token) return null;
        return {
            schemeName,
            location: 'header',
            name: 'authorization',
            value: \`Bearer \${token}\`,
            description: \`OpenID Connect token for '\${schemeName}'\`,
        };
    }

    return null;
}

/**
 * The request header a scheme's credential travels in, when it travels in one.
 */
function credentialHeaderName(scheme: any): string | undefined {
    if (!scheme) return undefined;
    if (scheme.type === 'apiKey') {
        return scheme.in === 'query' || scheme.in === 'cookie' || !scheme.name
            ? undefined
            : String(scheme.name).toLowerCase();
    }
    if (scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
        return 'authorization';
    }
    return undefined;
}

/**
 * True when two credentials from one requirement would overwrite each other
 * (for example, two schemes that both need the Authorization header).
 */
function hasConflictingCredentials(credentials: UpstreamCredential[]): boolean {
    const seen = new Set<string>();
    for (const credential of credentials) {
        // Several cookies combine into one Cookie header, so they never conflict.
        if (credential.location === 'cookie') continue;
        const key = \`\${credential.location}:\${credential.name.toLowerCase()}\`;
        if (seen.has(key)) return true;
        seen.add(key);
    }
    return false;
}

/**
 * Places one resolved credential on the outgoing request.
 */
function applyUpstreamCredential(
    credential: UpstreamCredential,
    headers: Record<string, string>,
    queryParams: Record<string, any>
): void {
    if (credential.location === 'query') {
        queryParams[credential.name] = credential.value;
    } else if (credential.location === 'cookie') {
        // Add the cookie, preserving other cookies if they exist
        headers['cookie'] = \`\${credential.name}=\${credential.value}\${headers['cookie'] ? \`; \${headers['cookie']}\` : ''}\`;
    } else {
        headers[credential.name] = credential.value;
    }
}

/**
 * Human-readable security requirements, e.g. "[apiKey AND oauth (scopes: read)] OR [bearer]".
 */
function describeSecurityRequirements(requirements: Record<string, string[]>[]): string {
    return requirements
        .map((requirement) => {
            const parts = Object.entries(requirement ?? {}).map(([name, scopes]) =>
                Array.isArray(scopes) && scopes.length > 0 ? \`\${name} (scopes: \${scopes.join(', ')})\` : name
            );
            return \`[\${parts.length > 0 ? parts.join(' AND ') : 'no auth'}]\`;
        })
        .join(' OR ');
}

/**
 * Environment variables (or forwarded headers) that supply one scheme's credential.
 */
function credentialHint(schemeName: string, scheme: any, passthroughNames: string[]): string {
    const suffix = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    let hint: string;
    if (!scheme) {
        return \`(security scheme '\${schemeName}' is not defined in the spec)\`;
    } else if (scheme.type === 'apiKey') {
        hint = \`API_KEY_\${suffix}\`;
    } else if (scheme.type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'bearer') {
        hint = \`BEARER_TOKEN_\${suffix}\`;
    } else if (scheme.type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'basic') {
        hint = \`BASIC_USERNAME_\${suffix} (and BASIC_PASSWORD_\${suffix})\`;
    } else if (scheme.type === 'oauth2') {
        hint = scheme.flows?.clientCredentials || scheme.flows?.password
            ? \`OAUTH_TOKEN_\${suffix} (or OAUTH_CLIENT_ID_\${suffix} and OAUTH_CLIENT_SECRET_\${suffix})\`
            : \`OAUTH_TOKEN_\${suffix}\`;
    } else if (scheme.type === 'openIdConnect') {
        hint = \`OPENID_TOKEN_\${suffix}\`;
    } else {
        return \`(security scheme '\${schemeName}' of type \${scheme.type} is not supported)\`;
    }
    const header = credentialHeaderName(scheme);
    return header !== undefined && passthroughNames.includes(header)
        ? \`\${hint} or the '\${header}' request header\`
        : hint;
}

/**
 * Tool error text for an operation whose security requirements cannot be met,
 * e.g. "Missing credentials for 'getPet': set API_KEY_PETSTORE_AUTH."
 */
function describeMissingCredentials(
    toolName: string,
    requirements: Record<string, string[]>[],
    allSecuritySchemes: Record<string, any>,
    passthroughNames: string[]
): string {
    const alternatives = requirements
        .filter((requirement) => Object.keys(requirement ?? {}).length > 0)
        .map((requirement) =>
            Object.keys(requirement)
                .map((schemeName) => credentialHint(schemeName, allSecuritySchemes[schemeName], passthroughNames))
                .join(' and ')
        );
    return \`Missing credentials for '\${toolName}': set \${alternatives.join(', or ')}. Required security: \${describeSecurityRequirements(requirements)}.\`;
}

/**
 * Resolves an operation's OpenAPI security requirements (issue #81).
 *
 * Requirement objects are alternatives tried in order (OR); every scheme inside one
 * object must resolve (AND). A partially satisfied alternative is never applied, so
 * an incomplete set of credentials is never sent. An empty object ({}) makes
 * authentication optional: it is used only when no other alternative is complete.
 * A forwarded passthrough header (--header-passthrough) satisfies the scheme whose
 * credential travels in it, so a client that sends its own API key still gets the
 * other schemes of an AND requirement.
 */
async function resolveSecurityRequirements(
    requirements: Record<string, string[]>[] | undefined,
    allSecuritySchemes: Record<string, any>,
    forwarded: Record<string, string> = {}
): Promise<SecurityResolution> {
    if (!Array.isArray(requirements) || requirements.length === 0) return { status: 'none' };
    let optional = false;
    for (const requirement of requirements) {
        const entries = Object.entries(requirement ?? {});
        if (entries.length === 0) {
            optional = true;
            continue;
        }
        const credentials: UpstreamCredential[] = [];
        let complete = true;
        for (const [schemeName, scopes] of entries) {
            const headerName = credentialHeaderName(allSecuritySchemes[schemeName]);
            const credential: UpstreamCredential | null =
                headerName !== undefined && forwarded[headerName] !== undefined
                    ? {
                          schemeName,
                          location: 'header',
                          name: headerName,
                          value: forwarded[headerName],
                          description: \`forwarded client header '\${headerName}' for '\${schemeName}'\`,
                      }
                    : await resolveSchemeCredential(
                          schemeName,
                          allSecuritySchemes[schemeName],
                          Array.isArray(scopes) ? scopes : []
                      );
            if (!credential) {
                complete = false;
                break;
            }
            credentials.push(credential);
        }
        if (!complete) continue;
        if (hasConflictingCredentials(credentials)) {
            console.error(\`Skipping security requirement \${describeSecurityRequirements([requirement])}: two of its schemes need the same request location.\`);
            continue;
        }
        return { status: 'applied', credentials };
    }
    return optional
        ? { status: 'optional' }
        : { status: 'unsatisfied', summary: describeSecurityRequirements(requirements) };
}
`;

  // Generate complete execute API tool function
  return `
${insecurePreamble}${oauth2TokenAcquisitionCode}${securityResolutionHelpers}

/**
 * Executes an API tool with the provided arguments
 * 
 * @param toolName Name of the tool to execute
 * @param definition Tool definition
 * @param toolArgs Arguments provided by the user
 * @param allSecuritySchemes Security schemes from the OpenAPI spec
 * @returns Call tool result
 */
async function executeApiTool(
    toolName: string,
    definition: McpToolDefinition,
    toolArgs: JsonObject,
    allSecuritySchemes: Record<string, any>
): Promise<CallToolResult> {
  try {
    // Validate arguments against the tool's JSON Schema (no code generation, no eval).
    // Invalid arguments are a tool execution error the model can read and correct.
    const validatedArgs: JsonObject = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
    const validationError = validateToolArguments(toolName, definition.inputSchema, validatedArgs);
    if (validationError) {
        return { isError: true, content: [{ type: 'text', text: validationError }] };
    }

    // Prepare URL, query parameters, headers, and request body
    let urlPath = definition.pathTemplate;
    const queryParams: Record<string, any> = {};
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let requestBodyData: any = undefined;

    // Apply parameters to the URL path, query, or headers
    definition.executionParameters.forEach((param) => {
        const value = validatedArgs[param.name];
        if (typeof value !== 'undefined' && value !== null) {
            if (param.in === 'path') {
                urlPath = urlPath.replace(\`{\${param.name}}\`, encodeURIComponent(String(value)));
            }
            else if (param.in === 'query') {
                queryParams[param.name] = value;
            }
            else if (param.in === 'header') {
                headers[param.name.toLowerCase()] = String(value);
            }
        }
    });

    // Ensure all path parameters are resolved
    if (urlPath.includes('{')) {
        throw new Error(\`Failed to resolve path parameters: \${urlPath}\`);
    }
    
    // Construct the full URL (operation and path-item servers win over the base URL)
    const baseUrl = resolveOperationBaseUrl(definition.serverUrl, API_BASE_URL);
    const requestUrl = baseUrl ? \`\${baseUrl}\${urlPath}\` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
        requestBodyData = validatedArgs['requestBody'];
        headers['content-type'] = definition.requestBodyContentType;
    }
${forwardedHeadersCode}${customAuthCall}${builtinAuthGuardOpen}${securityCode}${builtinAuthGuardClose}
${headerPassthroughCode}
    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      // Serialize array query params as comma-separated values (issue #41)
      paramsSerializer: (params: Record<string, any>) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          search.append(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        return search.toString();
      },${insecureAgentToolConfig}
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    // Log request info to stderr (doesn't affect MCP output)
    console.error(\`Executing tool "\${toolName}": \${config.method} \${config.url}\`);

    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    // Coerce header value to string before lowercasing (issue #65)
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    
    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
         try { 
             responseText = JSON.stringify(response.data, null, 2); 
         } catch (e) { 
             responseText = "[Stringify Error]"; 
         }
    } 
    // Handle string responses
    else if (typeof response.data === 'string') { 
         responseText = response.data; 
    }
    // Handle other response types
    else if (response.data !== undefined && response.data !== null) { 
         responseText = String(response.data); 
    }
    // Handle empty responses
    else { 
         responseText = \`(Status: \${response.status} - No body content)\`; 
    }
    
    const text = \`API Response (Status: \${response.status}):\\n\${responseText}\`;

    // A JSON object response is also returned as structuredContent (text unchanged).
    const structuredContent =
        contentType.includes('application/json') &&
        typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)
            ? (response.data as Record<string, unknown>)
            : undefined;

    // With a declared outputSchema (--output-schema), never return a result that violates it.
    if (definition.outputSchema !== undefined) {
        const outputError = structuredContent === undefined
            ? 'expected a JSON object response'
            : validateToolOutput(toolName, definition.outputSchema, structuredContent);
        if (outputError) {
            return {
                isError: true,
                content: [{ type: 'text', text: \`Response for tool '\${toolName}' does not match its output schema: \${outputError}\\n\\n\${text}\` }],
            };
        }
    }

    return {
        content: [{ type: 'text', text }],
        ...(structuredContent !== undefined && { structuredContent }),
    };

  } catch (error: unknown) {
    // Handle errors during execution
    let errorMessage: string;
    
    // Format Axios errors specially
    if (axios.isAxiosError(error)) { 
        errorMessage = formatApiError(error); 
    }
    // Handle standard errors
    else if (error instanceof Error) { 
        errorMessage = error.message; 
    }
    // Handle unexpected error types
    else { 
        errorMessage = 'Unexpected error: ' + String(error); 
    }
    
    // Log error to stderr
    console.error(\`Error during execution of tool '\${toolName}':\`, errorMessage);
    
    // Return the error to the client as a tool error so the model knows the call failed
    return { isError: true, content: [{ type: "text", text: errorMessage }] };
  }
}
`;
}

/**
 * Gets security scheme documentation for README
 *
 * @param securitySchemes Security schemes from OpenAPI spec
 * @returns Documentation for security schemes
 */
export function getSecuritySchemesDocs(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  if (!securitySchemes) return 'No security schemes defined in the OpenAPI spec.';

  let docs = '';

  for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
    if ('$ref' in schemeOrRef) {
      docs += `- \`${name}\`: Referenced security scheme (reference not resolved)\n`;
      continue;
    }

    const scheme = schemeOrRef;

    if (scheme.type === 'apiKey') {
      const envVar = getEnvVarName(name, 'API_KEY');
      docs += `- \`${envVar}\`: API key for ${scheme.name} (in ${scheme.in})\n`;
    } else if (scheme.type === 'http') {
      if (scheme.scheme?.toLowerCase() === 'bearer') {
        const envVar = getEnvVarName(name, 'BEARER_TOKEN');
        docs += `- \`${envVar}\`: Bearer token for authentication\n`;
      } else if (scheme.scheme?.toLowerCase() === 'basic') {
        const usernameEnvVar = getEnvVarName(name, 'BASIC_USERNAME');
        const passwordEnvVar = getEnvVarName(name, 'BASIC_PASSWORD');
        docs += `- \`${usernameEnvVar}\`: Username for Basic authentication\n`;
        docs += `- \`${passwordEnvVar}\`: Password for Basic authentication\n`;
      }
    } else if (scheme.type === 'oauth2') {
      const flowTypes = scheme.flows ? Object.keys(scheme.flows) : ['unknown'];

      // Add client credentials for OAuth2
      const clientIdVar = getEnvVarName(name, 'OAUTH_CLIENT_ID');
      const clientSecretVar = getEnvVarName(name, 'OAUTH_CLIENT_SECRET');
      docs += `- \`${clientIdVar}\`: Client ID for OAuth2 authentication (${flowTypes.join(', ')} flow)\n`;
      docs += `- \`${clientSecretVar}\`: Client secret for OAuth2 authentication\n`;

      // Add OAuth token for manual setting
      const tokenVar = getEnvVarName(name, 'OAUTH_TOKEN');
      docs += `- \`${tokenVar}\`: OAuth2 token (if not using automatic token acquisition)\n`;

      // Add scopes env var
      const scopesVar = getEnvVarName(name, 'OAUTH_SCOPES');
      docs += `- \`${scopesVar}\`: Space-separated list of OAuth2 scopes to request\n`;

      // If available, list flow-specific details
      if (scheme.flows?.clientCredentials) {
        docs += `  Client Credentials Flow Token URL: ${scheme.flows.clientCredentials.tokenUrl}\n`;

        // List available scopes if defined
        if (
          scheme.flows.clientCredentials.scopes &&
          Object.keys(scheme.flows.clientCredentials.scopes).length > 0
        ) {
          docs += `  Available scopes:\n`;
          for (const [scope, description] of Object.entries(
            scheme.flows.clientCredentials.scopes
          )) {
            docs += `  - \`${scope}\`: ${description}\n`;
          }
        }
      }
    } else if (scheme.type === 'openIdConnect') {
      const tokenVar = getEnvVarName(name, 'OPENID_TOKEN');
      docs += `- \`${tokenVar}\`: OpenID Connect token\n`;
      if (scheme.openIdConnectUrl) {
        docs += `  OpenID Connect Discovery URL: ${scheme.openIdConnectUrl}\n`;
      }
    }
  }

  return docs;
}
