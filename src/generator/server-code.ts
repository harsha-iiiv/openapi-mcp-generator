import { OpenAPIV3 } from 'openapi-types';
import { CliOptions } from '../types/index.js';
import { extractToolsFromApi } from '../parser/extract-tools.js';
import { determineBaseUrl } from '../utils/index.js';
import {
  generateToolDefinitionMap,
  generateCallToolHandler,
  generateListToolsHandler,
  generateSchemaValidationCode,
} from '../utils/code-gen.js';
import {
  generateExecuteApiToolFunction,
  getSecurityModuleImports,
  getInboundHeaderStoreDeclaration,
  type SecurityCodeOptions,
} from '../utils/security.js';

/**
 * Generates the TypeScript code for the MCP server
 *
 * @param api OpenAPI document
 * @param options CLI options
 * @param serverName Server name
 * @param serverVersion Server version
 * @returns Generated TypeScript code
 */
export function generateMcpServerCode(
  api: OpenAPIV3.Document,
  options: CliOptions,
  serverName: string,
  serverVersion: string
): string {
  // Extract tools from API
  const tools = extractToolsFromApi(
    api,
    options.defaultInclude ?? true,
    options.maxToolNameLength ?? 64
  );

  // Determine base URL
  const determinedBaseUrl = determineBaseUrl(api, options.baseUrl);

  // Security/execution generation options derived from CLI options
  const securityOptions: SecurityCodeOptions = {
    insecure: options.insecure,
    oauthCredsInBody: options.oauthCredsInBody,
    headerPassthrough: options.headerPassthrough,
    customAuth: options.customAuth,
  };

  // Generate code for tool definition map
  const toolDefinitionMapCode = generateToolDefinitionMap(tools, api.components?.securitySchemes);

  // Generate code for API tool execution
  const executeApiToolFunctionCode = generateExecuteApiToolFunction(
    api.components?.securitySchemes,
    securityOptions
  );

  // Top-of-module imports required by the security/execution code
  const securityModuleImports = getSecurityModuleImports(securityOptions);

  // Request-scoped inbound-header store declaration (issue #55). Empty unless
  // header passthrough is enabled.
  const inboundHeaderStoreDecl = getInboundHeaderStoreDeclaration(securityOptions);

  // Startup/cleanup wiring. In library mode (issue #50) we export main() and
  // leave lifecycle (signal handlers, invocation) to the importing application.
  const startupCode = options.generateLib
    ? `
// Library mode: main() is exported above; the importing application is
// responsible for invoking it and handling process lifecycle/signals.`
    : `
/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
main().catch((error) => {
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});`;

  // Generate code for request handlers
  const callToolHandlerCode = generateCallToolHandler();
  const listToolsHandlerCode = generateListToolsHandler();

  // Determine which transport to include.
  // Port resolution order: explicit --port, then PORT env var, then 3000 (issue #50).
  let transportImport = '';
  let transportCode = '';
  let stdioImport = '';
  // Treat an explicit --port (including 0, "let the OS pick") as set; only fall
  // back to PORT/3000 when no port was provided (issue #50).
  const portExpr =
    options.port !== undefined ? `${options.port}` : `Number(process.env.PORT) || 3000`;

  switch (options.transport) {
    case 'web':
      transportImport = `\nimport { setupWebServer } from "./web-server.js";`;
      transportCode = `// Set up Web Server transport
  try {
    await setupWebServer(createServer, ${portExpr});
  } catch (error) {
    console.error("Error setting up web server:", error);
    process.exit(1);
  }`;
      break;
    case 'streamable-http':
      transportImport = `\nimport { setupStreamableHttpServer } from "./streamable-http.js";`;
      transportCode = `// Set up StreamableHTTP transport
  try {
    await setupStreamableHttpServer(createServer, ${portExpr});
  } catch (error) {
    console.error("Error setting up StreamableHTTP server:", error);
    process.exit(1);
  }`;
      break;
    default: // stdio
      transportImport = '';
      stdioImport = `\nimport { serveStdio } from "@modelcontextprotocol/server/stdio";`;
      transportCode = `// Set up stdio transport. serveStdio picks the era from the client's opening
  // message: MCP 2026-07-28 (server/discover and per-request metadata) or a
  // 2025-era initialize handshake. Each connection gets its own server instance.
  try {
    serveStdio(() => createServer(), {
      onerror: (error) => console.error('MCP stdio error:', error),
    });
    console.error(\`\${SERVER_NAME} MCP Server (v\${SERVER_VERSION}) running on stdio\${API_BASE_URL ? \`, proxying API at \${API_BASE_URL}\` : ''}\`);
  } catch (error) {
    console.error("Error during server startup:", error);
    process.exit(1);
  }`;
      break;
  }

  // Generate the full server code
  return `#!/usr/bin/env node
/**
 * MCP Server generated from OpenAPI spec for ${serverName} v${serverVersion}
 * Generated on: ${new Date().toISOString()}
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { Server, ProtocolError, ProtocolErrorCode, type Tool, type CallToolResult, type CallToolRequest } from "@modelcontextprotocol/server";${stdioImport}${transportImport}

import { Validator, type OutputUnit } from '@cfworker/json-schema';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
${securityModuleImports}${inboundHeaderStoreDecl}
/**
 * Type definition for JSON objects
 */
type JsonObject = Record<string, any>;

/**
 * Interface for MCP Tool Definition
 */
interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: any;
    method: string;
    pathTemplate: string;
    executionParameters: { name: string, in: string }[];
    requestBodyContentType?: string;
    securityRequirements: any[];
    tags?: string[];
    deprecated?: boolean;
}

/**
 * Server configuration
 */
export const SERVER_NAME = "${serverName}";
export const SERVER_VERSION = "${serverVersion}";
// Base URL for the API, can be set via environment variable or determined from OpenAPI spec
export const API_BASE_URL = process.env.API_BASE_URL || "${determinedBaseUrl || ''}";
console.error("API_BASE_URL is set to:", API_BASE_URL);

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([
${toolDefinitionMapCode}
]);

/**
 * Security schemes from the OpenAPI spec
 */
const securitySchemes = ${JSON.stringify(api.components?.securitySchemes || {}, null, 2).replace(/^/gm, '  ')};
${generateSchemaValidationCode()}
/**
 * Creates a fresh MCP server instance with the tool handlers registered.
 * Transports call this once per request, connection or era probe: an SDK server
 * instance serves exactly one transport, and the same factory backs both the
 * 2026-07-28 and 2025-era protocols.
 */
export function createServer(): Server {
  const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
  );
${listToolsHandlerCode}
${callToolHandlerCode}
  return server;
}
${executeApiToolFunctionCode}

/**
 * Main function to start the server
 */
${options.generateLib ? 'export ' : ''}async function main() {
${transportCode}
}
${startupCode}

/**
 * Formats API errors for better readability
 * 
 * @param error Axios error
 * @returns Formatted error message
 */
function formatApiError(error: AxiosError): string {
    let message = 'API request failed.';
    if (error.response) {
        message = \`API Error: Status \${error.response.status} (\${error.response.statusText || 'Status text not available'}). \`;
        const responseData = error.response.data;
        const MAX_LEN = 200;
        if (typeof responseData === 'string') { 
            message += \`Response: \${responseData.substring(0, MAX_LEN)}\${responseData.length > MAX_LEN ? '...' : ''}\`; 
        }
        else if (responseData) { 
            try { 
                const jsonString = JSON.stringify(responseData); 
                message += \`Response: \${jsonString.substring(0, MAX_LEN)}\${jsonString.length > MAX_LEN ? '...' : ''}\`; 
            } catch { 
                message += 'Response: [Could not serialize data]'; 
            } 
        }
        else { 
            message += 'No response body received.'; 
        }
    } else if (error.request) {
        message = 'API Network Error: No response received from server.';
        if (error.code) message += \` (Code: \${error.code})\`;
    } else { 
        message += \`API Request Setup Error: \${error.message}\`; 
    }
    return message;
}
`;
}

/**
 * Generates the editable `src/auth.ts` custom auth hook stub (issue #9).
 *
 * The generated server calls `applyCustomAuth` before applying built-in
 * (env-based) auth. Returning `true` signals that auth was fully handled and
 * built-in auth should be skipped — useful for custom JWT/header schemes or
 * excluding specific operations from automatic auth injection.
 *
 * @returns Generated TypeScript source for src/auth.ts
 */
export function generateCustomAuthStub(): string {
  return `/**
 * Custom authentication hook.
 *
 * This file is generated once and is safe to edit. It is imported by the
 * generated MCP server and invoked for every tool call BEFORE the built-in
 * environment-variable-based authentication is applied.
 *
 * Mutate \`ctx.headers\` / \`ctx.queryParams\` to inject your own credentials.
 * Return \`true\` to indicate auth is fully handled and built-in auth should be
 * skipped for this request; return \`false\` (the default) to fall through to
 * built-in auth.
 */

export interface CustomAuthContext {
  /** Mutable request headers (lower-cased keys). */
  headers: Record<string, string>;
  /** Mutable query parameters. */
  queryParams: Record<string, any>;
  /** Name of the tool being executed. */
  toolName: string;
  /** Full tool definition (method, pathTemplate, securityRequirements, ...). */
  definition: {
    name: string;
    method: string;
    pathTemplate: string;
    securityRequirements: any[];
    [key: string]: any;
  };
}

/**
 * Apply custom authentication. Edit this function to implement your scheme.
 *
 * @param ctx Mutable auth context for the current request
 * @returns true if auth was fully handled (skip built-in auth), else false
 */
export async function applyCustomAuth(ctx: CustomAuthContext): Promise<boolean> {
  // Example: inject a static bearer token for every request.
  // ctx.headers['authorization'] = \`Bearer \${process.env.MY_TOKEN ?? ''}\`;
  // return true;

  // Default: do nothing and let built-in auth run.
  void ctx;
  return false;
}
`;
}
