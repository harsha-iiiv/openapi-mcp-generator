import { OpenAPIV3 } from 'openapi-types';
import { CliOptions } from '../types/index.js';
import { extractToolsFromApi } from '../parser/extract-tools.js';
import { determineBaseUrl } from '../utils/index.js';
import {
  generateToolDefinitionMap,
  generateCallToolHandler,
  generateListToolsHandler,
} from '../utils/code-gen.js';
import { generateExecuteApiToolFunction } from '../utils/security.js';

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
  const tools = extractToolsFromApi(api, options.defaultInclude ?? true);

  // Determine base URL
  const determinedBaseUrl = determineBaseUrl(api, options.baseUrl);

  // Generate code for tool definition map
  const toolDefinitionMapCode = generateToolDefinitionMap(tools, api.components?.securitySchemes);

  // Generate code for API tool execution
  const executeApiToolFunctionCode = generateExecuteApiToolFunction(
    api.components?.securitySchemes
  );

  // Generate code for request handlers
  const callToolHandlerCode = generateCallToolHandler(options.passthroughAuth);
  const listToolsHandlerCode = generateListToolsHandler();

  // Determine which transport to include
  let transportImport = '';
  let transportCode = '';

  switch (options.transport) {
    case 'web':
      transportImport = `\nimport { setupWebServer } from "./web-server.js";`;
      transportCode = `// Set up Web Server transport
  try {
    await setupWebServer(server, ${options.port || 3000});
  } catch (error) {
    console.error("Error setting up web server:", error);
    process.exit(1);
  }`;
      break;
    case 'streamable-http':
      transportImport = `\nimport { setupStreamableHttpServer } from "./streamable-http.js";`;
      transportCode = `// Set up StreamableHTTP transport
  try {
    await setupStreamableHttpServer(server, ${options.port || 3000});
  } catch (error) {
    console.error("Error setting up StreamableHTTP server:", error);
    process.exit(1);
  }`;
      break;
    default: // stdio
      transportImport = '';
      transportCode = `// Set up stdio transport
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest,
  ServerRequest,
  ServerNotification,
  IsomorphicHeaders
} from "@modelcontextprotocol/sdk/types.js";${transportImport}
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

import { z, ZodError } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

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
}

/**
 * Server configuration
 */
export const SERVER_NAME = "${serverName}";
export const SERVER_VERSION = "${serverVersion}";
export const API_BASE_URL = "${determinedBaseUrl || ''}";

/**
 * MCP Server instance
 */
const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
);

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

${listToolsHandlerCode}
${callToolHandlerCode}
${executeApiToolFunctionCode}

/**
 * Main function to start the server
 */
async function main() {
${transportCode}
}

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
});

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

/**
 * Converts a JSON Schema to a Zod schema for runtime validation
 * 
 * @param jsonSchema JSON Schema
 * @param toolName Tool name for error reporting
 * @returns Zod schema
 */
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
    if (typeof jsonSchema !== 'object' || jsonSchema === null) { 
        return z.object({}).passthrough(); 
    }
    try {
        const zodSchemaString = jsonSchemaToZod(jsonSchema);
        const zodSchema = eval(zodSchemaString);
        if (typeof zodSchema?.parse !== 'function') { 
            throw new Error('Eval did not produce a valid Zod schema.'); 
        }
        return zodSchema as z.ZodTypeAny;
    } catch (err: any) {
        console.error(\`Failed to generate/evaluate Zod schema for '\${toolName}':\`, err);
        return z.object({}).passthrough();
    }
}
`;
}
