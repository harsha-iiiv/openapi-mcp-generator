import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7, JSONSchema7TypeName } from 'json-schema';
import { generateOperationId } from './utils.js';

interface CliOptions {
    input: string;
    output: string; // This is the directory path
    serverName?: string;
    serverVersion?: string;
    baseUrl?: string;
}

interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: JSONSchema7 | boolean;
    operationId: string;
    method: string;
    path: string;
    parameters: OpenAPIV3.ParameterObject[];
    requestBody?: OpenAPIV3.RequestBodyObject;
}


/**
 * Generates the TypeScript code content for the server's src/index.ts file.
 */
export function generateMcpServerCode(
    api: OpenAPIV3.Document,
    options: CliOptions,
    serverName: string,
    serverVersion: string
): string {

    const tools: McpToolDefinition[] = extractToolsFromApi(api);
    const determinedBaseUrl = determineBaseUrl(api, options.baseUrl);
    const listToolsCode = generateListTools(tools);
    const callToolCode = generateCallTool(tools, determinedBaseUrl);

    // --- Template for src/index.ts ---
    return `
// Generated by openapi-to-mcp-generator for ${serverName} v${serverVersion}
// Source OpenAPI spec: ${options.input}
// Generation date: ${new Date().toISOString()}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import Schemas and Types from /types subpath with .js extension
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest // Added type for the request parameter
} from "@modelcontextprotocol/sdk/types.js";

// Zod for runtime validation
import { z, ZodError } from 'zod';
// Library to convert JSON Schema to Zod schema string at runtime
import { jsonSchemaToZod } from 'json-schema-to-zod';

// Define JsonObject locally as a utility type
type JsonObject = Record<string, any>;

import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

// --- Server Configuration ---
const SERVER_NAME = "${serverName}";
const SERVER_VERSION = "${serverVersion}";
const API_BASE_URL = "${determinedBaseUrl || ''}";

// --- Server Instance ---
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// --- Tool Definitions (for ListTools response) ---
// Corrected: Use Tool[] type
const toolsList: Tool[] = [
${listToolsCode}
];

// --- Request Handlers ---

// 1. List Available Tools Handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolsList,
  };
});

// 2. Call Tool Handler
// Corrected: Added explicit type for 'request' parameter
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name: toolName, arguments: toolArgs } = request.params;

  const toolDefinition = toolsList.find(t => t.name === toolName);

  if (!toolDefinition) {
    console.error(\`Error: Received request for unknown tool: \${toolName}\`);
    return { content: [{ type: "text", text: \`Error: Unknown tool requested: \${toolName}\` }] };
  }

  // --- Tool Execution Logic ---
${callToolCode} // This generated code now includes Zod validation

  // Fallback error
  console.error(\`Error: Handler logic missing for tool: \${toolName}. This indicates an issue in the generator.\`);
  return { content: [{ type: "text", text: \`Error: Internal server error - handler not implemented for tool: \${toolName}\` }] };
});


// --- Main Execution Function ---
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(\`\${SERVER_NAME} MCP Server (v\${SERVER_VERSION}) running on stdio\${API_BASE_URL ? \`, proxying API at \${API_BASE_URL}\` : ''}\`);
  } catch (error) {
    console.error("Error during server startup:", error);
    process.exit(1);
  }
}

// --- Cleanup Function ---
async function cleanup() {
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// --- Start the Server ---
main().catch((error) => {
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});

// --- Helper Functions (Included in the generated server code) ---
function formatApiError(error: AxiosError): string {
    let message = 'API request failed.';
    if (error.response) {
        message = \`API Error: Status \${error.response.status} (\${error.response.statusText || 'Status text not available'}). \`;
        const responseData = error.response.data;
        const MAX_LEN = 200;
        if (typeof responseData === 'string') {
            message += \`Response: \${responseData.substring(0, MAX_LEN)}\${responseData.length > MAX_LEN ? '...' : ''}\`;
        } else if (responseData) {
            try {
                const jsonString = JSON.stringify(responseData);
                message += \`Response: \${jsonString.substring(0, MAX_LEN)}\${jsonString.length > MAX_LEN ? '...' : ''}\`;
            } catch {
                message += 'Response: [Could not serialize response data]';
            }
        } else {
            message += 'No response body received.';
        }
    } else if (error.request) {
        message = 'API Network Error: No response received from the server. Check network connectivity or server availability.';
        if (error.code) message += \` (Code: \${error.code})\`;
    } else {
        message = \`API Request Setup Error: \${error.message}\`;
    }
    return message;
}

/**
 * Attempts to dynamically generate and evaluate a Zod schema from a JSON schema.
 * WARNING: Uses eval(), which can be a security risk if the schema input is untrusted.
 * In this context, the schema originates from the generator/OpenAPI spec, reducing risk.
 * @param jsonSchema The JSON Schema object (or boolean).
 * @param toolName For error logging.
 * @returns The evaluated Zod schema object.
 * @throws If schema conversion or evaluation fails.
 */
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
    if (typeof jsonSchema !== 'object' || jsonSchema === null) {
        // Handle boolean schemas or invalid input
        console.warn(\`Cannot generate Zod schema for non-object JSON schema for tool '\${toolName}'. Input type: \${typeof jsonSchema}\`)
        // Fallback to allowing any object - adjust if stricter handling is needed
        return z.object({}).passthrough();
    }
    try {
        // Note: jsonSchemaToZod may require specific configurations or adjustments
        // depending on the complexity of the JSON Schemas being converted.
        const zodSchemaString = jsonSchemaToZod(jsonSchema);

        // IMPORTANT: Using eval() to execute the generated Zod schema string.
        // This is generally discouraged due to security risks with untrusted input.
        // Ensure the JSON schemas processed here are from trusted sources (like your OpenAPI spec).
        // The 'z' variable (from imported zod) must be in scope for eval.
        const zodSchema = eval(zodSchemaString);

        if (typeof zodSchema?.parse !== 'function') {
             throw new Error('Generated Zod schema string did not evaluate to a valid Zod schema object.');
        }
        return zodSchema as z.ZodTypeAny;
    } catch (err: any) {
        console.error(\`Failed to generate or evaluate Zod schema for tool '\${toolName}':\`, err);
        // Fallback schema in case of conversion/evaluation error
        // This allows any object, effectively skipping validation on error.
        // Consider throwing the error if validation is critical.
        return z.object({}).passthrough();
    }
}
`;
}

/**
 * Generates the content for the package.json file for a buildable project.
 * Adds zod and json-schema-to-zod dependencies.
 */
export function generatePackageJson(serverName: string, serverVersion: string): string {
    const packageData = {
        name: serverName,
        version: serverVersion,
        description: `MCP Server generated from OpenAPI spec for ${serverName}`,
        private: true,
        type: "module",
        main: "build/index.js",
        files: [ "build", "src" ],
        scripts: {
            "start": "node build/index.js",
            "build": "tsc && chmod 755 build/index.js",
            "typecheck": "tsc --noEmit",
            "prestart": "npm run build"
        },
        engines: {
            "node": ">=18.0.0"
        },
        dependencies: {
            "@modelcontextprotocol/sdk": "^1.9.0",
            "axios": "^1.8.4",
            "zod": "^3.24.2",
            "json-schema-to-zod": "^2.6.1"
        },
        devDependencies: {
            "@types/node": "^18.19.0",
            "typescript": "^5.4.5"
            // Removed ts-node, tsc-watch
        }
    };
    return JSON.stringify(packageData, null, 2);
}

/**
 * Generates the content for the tsconfig.json file for a buildable project.
 * Enables stricter type checking.
 */
export function generateTsconfigJson(): string {
    const tsconfigData = {
        compilerOptions: {
            "target": "ES2022",
            "module": "Node16",
            "moduleResolution": "Node16",
            "outDir": "./build",
            "rootDir": "./src",
            "strict": true,
            "esModuleInterop": true,
            "skipLibCheck": true,
            "forceConsistentCasingInFileNames": true
          },
        "include": ["src/**/*"],
        "exclude": ["node_modules"]
    };
    return JSON.stringify(tsconfigData, null, 2);
}

/**
 * Generates the content for the .gitignore file.
 */
export function generateGitignore(): string {
    // Content unchanged from previous version
    return `
# Node dependencies
node_modules
# Build output
dist
build

# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*
.pnpm-debug.log*

# Diagnostic reports
report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Coverage directory
coverage
*.lcov
.nyc_output

# Build artifacts
.grunt
bower_components
# build/Release # Covered by build/ above
jspm_packages/
web_modules/
.lock-wscript

# VS Code files
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
*.code-workspace

# Caches
.eslintcache
.node_repl_history
.browserslistcache

# Environment variables
.env
.env.*.local
.env.local
`;
}


// --- Helper Functions below are mostly unchanged, except generateCallTool ---

function determineBaseUrl(api: OpenAPIV3.Document, cmdLineBaseUrl?: string): string | null {
    // Logic unchanged
    if (cmdLineBaseUrl) return cmdLineBaseUrl.replace(/\/$/, '');
    if (api.servers && api.servers.length === 1 && api.servers[0].url) return api.servers[0].url.replace(/\/$/, '');
    if (api.servers && api.servers.length > 1) {
        console.warn(`⚠️ Multiple servers found. Using first: "${api.servers[0].url}". Use --base-url to override.`);
        return api.servers[0].url.replace(/\/$/, '');
    }
    return null;
}

function extractToolsFromApi(api: OpenAPIV3.Document): McpToolDefinition[] {
    // Logic unchanged
    const tools: McpToolDefinition[] = [];
    const usedNames = new Set<string>();
    if (!api.paths) return tools;
    for (const [path, pathItem] of Object.entries(api.paths)) {
        if (!pathItem) continue;
        for (const method of Object.values(OpenAPIV3.HttpMethods)) {
            const operation = pathItem[method];
            if (!operation) continue;
            let baseName = operation.operationId || generateOperationId(method, path);
            if (!baseName) {
                console.warn(`⚠️ Skipping ${method.toUpperCase()} ${path}: missing operationId.`);
                continue;
            }
            let finalToolName = baseName;
            let counter = 1;
            while (usedNames.has(finalToolName)) finalToolName = `${baseName}_${counter++}`;
            usedNames.add(finalToolName);
            const description = operation.description || operation.summary || `Executes ${method.toUpperCase()} ${path}`;
            const { inputSchema, parameters, requestBody } = generateInputSchema(operation);
            tools.push({ name: finalToolName, description, inputSchema, operationId: baseName, method, path, parameters, requestBody });
        }
    }
    return tools;
}

function generateInputSchema(operation: OpenAPIV3.OperationObject): { inputSchema: JSONSchema7 | boolean, parameters: OpenAPIV3.ParameterObject[], requestBody?: OpenAPIV3.RequestBodyObject } {
    // Logic unchanged
    const properties: { [key: string]: JSONSchema7 | boolean } = {};
    const required: string[] = [];
    const allParameters: OpenAPIV3.ParameterObject[] = Array.isArray(operation.parameters)
        ? operation.parameters.map(p => p as OpenAPIV3.ParameterObject) : [];
    allParameters.forEach(param => {
        if (!param.name || !param.schema) return;
        const paramSchema = mapOpenApiSchemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject);
        if (typeof paramSchema === 'object') paramSchema.description = param.description || paramSchema.description;
        properties[param.name] = paramSchema;
        if (param.required) required.push(param.name);
    });
    let opRequestBody: OpenAPIV3.RequestBodyObject | undefined = undefined;
    if (operation.requestBody) {
        opRequestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
        const jsonContent = opRequestBody.content?.['application/json'];
        if (jsonContent?.schema) {
            const bodySchema = mapOpenApiSchemaToJsonSchema(jsonContent.schema as OpenAPIV3.SchemaObject);
            if (typeof bodySchema === 'object') bodySchema.description = opRequestBody.description || bodySchema.description || 'The JSON request body.';
            properties['requestBody'] = bodySchema;
            if (opRequestBody.required) required.push('requestBody');
        } else {
            const firstContent = opRequestBody.content ? Object.entries(opRequestBody.content)[0] : undefined;
            if(firstContent) {
                const [contentType] = firstContent;
                properties['requestBody'] = { type: 'string', description: opRequestBody.description || `Request body (content type: ${contentType})` };
                if (opRequestBody.required) required.push('requestBody');
            }
        }
    }
    const inputSchema: JSONSchema7 = { type: 'object', properties, ...(required.length > 0 && { required }) };
    return { inputSchema, parameters: allParameters, requestBody: opRequestBody };
}

function mapOpenApiSchemaToJsonSchema(schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject): JSONSchema7 | boolean {
    // Logic mostly unchanged, ensure it handles recursion correctly
    if ('$ref' in schema) {
        console.warn(`⚠️ Unresolved $ref '${schema.$ref}'. Schema may be incomplete.`);
        return { type: 'object', description: `Unresolved: ${schema.$ref}` };
    }
    if (typeof schema === 'boolean') return schema;
    const jsonSchema: JSONSchema7 = { ...schema } as any;
    if (schema.type === 'integer') jsonSchema.type = 'number';
    delete (jsonSchema as any).nullable; delete (jsonSchema as any).example; delete (jsonSchema as any).xml;
    delete (jsonSchema as any).externalDocs; delete (jsonSchema as any).deprecated; delete (jsonSchema as any).readOnly; delete (jsonSchema as any).writeOnly;
    if (schema.nullable) {
        if (Array.isArray(jsonSchema.type)) { if (!jsonSchema.type.includes('null')) jsonSchema.type.push('null'); }
        else if (typeof jsonSchema.type === 'string') jsonSchema.type = [jsonSchema.type as JSONSchema7TypeName, 'null'];
        else if (!jsonSchema.type) jsonSchema.type = 'null';
    }
    if (jsonSchema.type === 'object' && jsonSchema.properties) {
        const mappedProps: { [key: string]: JSONSchema7 | boolean } = {};
        for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
             if (typeof propSchema === 'object' && propSchema !== null) mappedProps[key] = mapOpenApiSchemaToJsonSchema(propSchema as OpenAPIV3.SchemaObject);
             else if (typeof propSchema === 'boolean') mappedProps[key] = propSchema;
        }
        jsonSchema.properties = mappedProps;
    }
    if (jsonSchema.type === 'array' && typeof jsonSchema.items === 'object' && jsonSchema.items !== null) {
        jsonSchema.items = mapOpenApiSchemaToJsonSchema(jsonSchema.items as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject);
    }
    return jsonSchema;
}

function generateListTools(tools: McpToolDefinition[]): string {
    // Logic unchanged
    if (tools.length === 0) return "  // No tools extracted from the OpenAPI spec.";
    return tools.map(tool => {
        const escapedDescription = (tool.description || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        let schemaString; try { schemaString = JSON.stringify(tool.inputSchema, null, 4).replace(/^/gm, '    '); }
        catch (e) { schemaString = '    { "type": "object", "description": "Error: Could not stringify schema" }'; }
        return `\n  // Tool: ${tool.name} (${tool.method.toUpperCase()} ${tool.path})\n  {\n    name: "${tool.name}",\n    description: \`${escapedDescription}\`,\n    inputSchema: ${schemaString}\n  },`;
    }).join(''); // Changed join to empty string to avoid extra newline
}

/**
 * Generates the 'if/else if' block for the CallTool handler.
 * Includes runtime Zod validation.
 */
function generateCallTool(tools: McpToolDefinition[], baseUrl: string | null): string {
    if (tools.length === 0) return '  // No tools defined, so no handlers generated.';

    const cases = tools.map(tool => {
        const { name, method, path: rawPath, parameters, requestBody } = tool;
        const pathParams = parameters.filter(p => p.in === 'path');
        const queryParams = parameters.filter(p => p.in === 'query');
        const headerParams = parameters.filter(p => p.in === 'header');

        // --- Code Generation Snippets ---
        // Zod validation block (remains the same)
        const argsValidationCode = `
      // --- Argument Validation using Zod ---
      let validatedArgs: JsonObject;
      try {
          const zodSchema = getZodSchemaFromJsonSchema(toolDefinition.inputSchema, toolName);
          const argsToParse = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
          validatedArgs = zodSchema.parse(argsToParse);
          console.error(\`Arguments validated successfully for tool '\${toolName}'.\`);
      } catch (error: any) {
          if (error instanceof ZodError) {
              const validationErrorMessage = \`Invalid arguments for tool '\${toolName}': \${error.errors.map(e => \`\${e.path.join('.')} (\${e.code}): \${e.message}\`).join(', ')}\`;
              console.error(validationErrorMessage);
              return { content: [{ type: 'text', text: validationErrorMessage }] };
          } else {
               console.error(\`Unexpected error during argument validation setup for tool '\${toolName}':\`, error);
               return { content: [{ type: 'text', text: \`Internal server error during argument validation setup for tool '\${toolName}'.\` }] };
          }
      }
      // --- End Argument Validation ---
`;

        // URL Path Construction (uses validatedArgs)
        let urlPathCode = `      let urlPath = "${rawPath}";\n`;
        pathParams.forEach(p => {
            urlPathCode += `      const ${p.name}_val = validatedArgs['${p.name}'];\n`; // Use distinct name to avoid clash
            urlPathCode += `      if (typeof ${p.name}_val !== 'undefined' && ${p.name}_val !== null) { urlPath = urlPath.replace("{${p.name}}", encodeURIComponent(String(${p.name}_val))); }\n`;
        });
        urlPathCode += `      if (urlPath.includes('{')) { throw new Error(\`Validation passed but failed to resolve path parameters in URL: \${urlPath}. Check schema/validation logic.\`); }\n`;
        urlPathCode += `      const requestUrl = API_BASE_URL ? \`\${API_BASE_URL}\${urlPath}\` : urlPath;`;

        // Query Parameters Construction (uses validatedArgs)
        let queryParamsCode = '      const queryParams: Record<string, any> = {};\n';
        queryParams.forEach(p => {
            queryParamsCode += `      const ${p.name}_val = validatedArgs['${p.name}'];\n`; // Use distinct name
            queryParamsCode += `      if (typeof ${p.name}_val !== 'undefined' && ${p.name}_val !== null) queryParams['${p.name}'] = ${p.name}_val;\n`;
        });

        // Headers Construction (uses validatedArgs)
        let headersCode = `      const headers: Record<string, string> = { 'Accept': 'application/json' };\n`;
        headerParams.forEach(p => {
            headersCode += `      const ${p.name}_val = validatedArgs['${p.name}'];\n`; // Use distinct name
            headersCode += `      if (typeof ${p.name}_val !== 'undefined' && ${p.name}_val !== null) headers['${p.name.toLowerCase()}'] = String(${p.name}_val);\n`;
        });

        // **Corrected Request Body Handling**
        let requestBodyDeclarationCode = ''; // Code to declare and assign requestBodyData
        let axiosDataProperty = ''; // String part for the Axios config's 'data' property
        let requestContentType = 'application/json'; // Default assumption

        if (requestBody) { // Only generate body handling if the tool expects one
            // Declare the variable *before* config construction
            requestBodyDeclarationCode = `      let requestBodyData: any = undefined;\n`;
            // Assign value *after* validation (which sets validatedArgs)
            requestBodyDeclarationCode += `      if (validatedArgs && typeof validatedArgs['requestBody'] !== 'undefined') {\n`;
            requestBodyDeclarationCode += `          requestBodyData = validatedArgs['requestBody'];\n`;
            requestBodyDeclarationCode += `      }\n`;

            // Determine Content-Type (must happen before headers are finalized in config)
            if (requestBody.content?.['application/json']) {
                 requestContentType = 'application/json';
            } else if (requestBody.content) {
                 const firstType = Object.keys(requestBody.content)[0];
                 if (firstType) { requestContentType = firstType; }
            }
            // Add Content-Type header *if* data might exist
            headersCode += `      // Set Content-Type based on OpenAPI spec (or fallback)\n`;
            headersCode += `      if (typeof validatedArgs?.['requestBody'] !== 'undefined') { headers['content-type'] = '${requestContentType}'; }\n`;

            // Set the string for the Axios config 'data' property
            axiosDataProperty = 'data: requestBodyData, // Pass the prepared request body data';
        }

        // --- Assemble the 'if' block for this tool ---
        // Ensure correct order: Validation -> Declarations -> Config -> Axios Call
        return `
  // Handler for tool: ${name}
  if (toolName === "${name}") {
    try {
${argsValidationCode}
      // --- API Call Preparation ---
${urlPathCode}
${queryParamsCode}
${headersCode}
${requestBodyDeclarationCode} // Declare and assign requestBodyData *here*

      // --- Axios Request Configuration ---
      // Now 'requestBodyData' is declared before being referenced here
      const config: AxiosRequestConfig = {
        method: "${method.toUpperCase()}",
        url: requestUrl,
        params: queryParams,
        headers: headers,
        ${axiosDataProperty} // Include data property conditionally
        // Add Authentication logic here if needed
      };

      console.error(\`Executing tool "\${toolName}": \${config.method} \${config.url}\`);

      // --- Execute API Call ---
      const response = await axios(config);

      // --- Process Successful Response ---
      let responseText = '';
      const contentType = response.headers['content-type']?.toLowerCase() || '';
      if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
           try { responseText = JSON.stringify(response.data, null, 2); }
           catch (e) { responseText = "[Error: Failed to stringify JSON response]"; }
      } else if (typeof response.data === 'string') {
           responseText = response.data;
      } else if (response.data !== undefined && response.data !== null) {
           responseText = String(response.data);
      } else {
           responseText = \`(Status: \${response.status} - No body content)\`;
      }
      return { content: [ { type: "text", text: \`API Response (Status: \${response.status}):\\n\${responseText}\` } ], };

    } catch (error: any) {
      // --- Handle Errors (Post-Validation) ---
      let errorMessage = \`Error executing tool '\${toolName}': \${error.message}\`;
      if (axios.isAxiosError(error)) { errorMessage = formatApiError(error); }
      else if (error instanceof Error) { errorMessage = error.message; }
      else { errorMessage = 'An unexpected error occurred: ' + String(error); }
      console.error(\`Error during execution of tool '\${toolName}':\`, errorMessage, error.stack);
      return { content: [{ type: "text", text: errorMessage }] };
    }
  }`;
    }).join(' else ');

    return cases || '  // No tools defined, so no handlers generated.';
}