/**
 * Code generation utilities for OpenAPI to MCP generator
 */
import { McpToolDefinition } from '../types/index.js';
import { OpenAPIV3 } from 'openapi-types';
import { sanitizeForTemplate } from './helpers.js';

/**
 * Generates the tool definition map code
 *
 * @param tools List of tool definitions
 * @param securitySchemes Security schemes from OpenAPI spec
 * @returns Generated code for the tool definition map
 */
export function generateToolDefinitionMap(
  tools: McpToolDefinition[],
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  if (tools.length === 0) return '';

  return tools
    .map((tool) => {
      // Safely stringify complex objects
      let schemaString;
      try {
        schemaString = JSON.stringify(tool.inputSchema);
      } catch (e) {
        schemaString = '{}';
        console.warn(`Failed to stringify schema for tool ${tool.name}: ${e}`);
      }

      let execParamsString;
      try {
        execParamsString = JSON.stringify(tool.executionParameters);
      } catch (e) {
        execParamsString = '[]';
        console.warn(`Failed to stringify execution parameters for tool ${tool.name}: ${e}`);
      }

      let securityReqsString;
      try {
        securityReqsString = JSON.stringify(tool.securityRequirements);
      } catch (e) {
        securityReqsString = '[]';
        console.warn(`Failed to stringify security requirements for tool ${tool.name}: ${e}`);
      }

      // Decorate the description with deprecation marker and tags for
      // discoverability/filtering, then sanitize for the template literal.
      const tags = Array.isArray(tool.tags) ? tool.tags.filter(Boolean) : [];
      let decoratedDescription = tool.description;
      if (tool.deprecated) {
        decoratedDescription = `[DEPRECATED] ${decoratedDescription}`;
      }
      if (tags.length > 0) {
        decoratedDescription = `${decoratedDescription}\n(Tags: ${tags.join(', ')})`;
      }
      const escapedDescription = sanitizeForTemplate(decoratedDescription);

      let tagsString;
      try {
        tagsString = JSON.stringify(tags);
      } catch (e) {
        tagsString = '[]';
        console.warn(`Failed to stringify tags for tool ${tool.name}: ${e}`);
      }

      // JSON string literals are safe inside the generated source.
      const titleLine =
        tool.title !== undefined ? `\n    title: ${JSON.stringify(tool.title)},` : '';
      const annotationsString = JSON.stringify(tool.annotations ?? {});

      // Build the tool definition entry
      return `
  ["${tool.name}", {
    name: "${tool.name}",${titleLine}
    description: \`${escapedDescription}\`,
    inputSchema: ${schemaString},
    method: "${tool.method}",
    pathTemplate: "${tool.pathTemplate}",
    executionParameters: ${execParamsString},
    requestBodyContentType: ${tool.requestBodyContentType ? `"${tool.requestBodyContentType}"` : 'undefined'},
    securityRequirements: ${securityReqsString},
    tags: ${tagsString},
    deprecated: ${tool.deprecated ? 'true' : 'false'},
    annotations: ${annotationsString}
  }],`;
    })
    .join('');
}

/**
 * Generates the list tools handler code
 *
 * @returns Generated code for the list tools handler
 */
export function generateListToolsHandler(): string {
  return `
server.setRequestHandler('tools/list', async () => {
  const toolsForClient: Tool[] = Array.from(toolDefinitionMap.values()).map(def => ({
    name: def.name,
    ...(def.title !== undefined && { title: def.title }),
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations
  }));
  return { tools: toolsForClient };
});
`;
}

/**
 * Generates the call tool handler code
 *
 * @returns Generated code for the call tool handler
 */
export function generateCallToolHandler(): string {
  return `
server.setRequestHandler('tools/call', async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name: toolName, arguments: toolArgs } = request.params;
  const toolDefinition = toolDefinitionMap.get(toolName);
  if (!toolDefinition) {
    // An unknown tool is a protocol error (JSON-RPC -32602), not a tool result.
    console.error(\`Error: Unknown tool requested: \${toolName}\`);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, \`Unknown tool: \${toolName}\`);
  }
  return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, securitySchemes);
});
`;
}

/**
 * Generates the JSON Schema validation helpers shared by the Node and Worker
 * targets. Validation uses @cfworker/json-schema (JSON Schema 2020-12), which
 * interprets schemas directly: no code generation, no eval, safe on Workers.
 * The generated module must import `Validator` and `OutputUnit` from
 * '@cfworker/json-schema'.
 *
 * @returns Generated TypeScript source
 */
export function generateSchemaValidationCode(): string {
  return `
/** Compiled JSON Schema validators, created on first use and cached by key. */
const schemaValidators = new Map<string, Validator>();

/**
 * Returns the cached validator for a schema (JSON Schema 2020-12, all errors).
 * The validator gets its own copy because compiling annotates the schema object.
 */
function getSchemaValidator(key: string, schema: unknown): Validator {
    let validator = schemaValidators.get(key);
    if (!validator) {
        const compiled = typeof schema === 'boolean' ? schema : structuredClone(schema ?? {});
        validator = new Validator(compiled as any, '2020-12', false);
        schemaValidators.set(key, validator);
    }
    return validator;
}

/** Keywords whose errors only repeat that a nested value failed. */
const SUMMARY_KEYWORDS = new Set([
    'properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
    'items', 'prefixItems', 'additionalItems', 'unevaluatedItems', 'contains',
    'dependentSchemas', 'propertyNames', '$ref', '$recursiveRef', '$dynamicRef',
]);

/**
 * Formats validation errors as "<location>: <message>" joined with "; ",
 * dropping summaries that only repeat a more specific error.
 */
function formatSchemaErrors(errors: OutputUnit[]): string {
    const location = (pointer: string) => (pointer === '#' || pointer === '' ? '(root)' : pointer.replace(/^#/, ''));
    const isUnder = (pointer: string, parent: string) => pointer === parent || pointer.startsWith(parent + '/');
    const specific = errors.filter((e) => !SUMMARY_KEYWORDS.has(e.keyword) && e.keyword !== 'false');
    const kept = errors.filter((e) => {
        if (SUMMARY_KEYWORDS.has(e.keyword)) {
            return !specific.some((other) => isUnder(other.instanceLocation, e.instanceLocation));
        }
        if (e.keyword === 'false') {
            // "false" schemas reject any value, e.g. a property additionalProperties forbids.
            return !specific.some((other) => other.instanceLocation === e.instanceLocation);
        }
        return true;
    });
    const messages: string[] = [];
    for (const e of kept.length > 0 ? kept : errors) {
        const text = e.keyword === 'false' ? 'Not allowed by the schema.' : e.error;
        const message = \`\${location(e.instanceLocation)}: \${text}\`;
        if (!messages.includes(message)) messages.push(message);
    }
    return messages.join('; ');
}

/**
 * Validates tool arguments against the tool's input schema. Returns a readable
 * error message, or null when they are valid. Arguments are never modified:
 * schema defaults are not injected.
 */
function validateToolArguments(toolName: string, inputSchema: unknown, args: unknown): string | null {
    const result = getSchemaValidator(\`input:\${toolName}\`, inputSchema).validate(args);
    return result.valid ? null : \`Invalid arguments for tool '\${toolName}': \${formatSchemaErrors(result.errors)}\`;
}
`;
}

/**
 * Convert a string to title case
 *
 * @param str String to convert
 * @returns Title case string
 */
export function titleCase(str: string): string {
  // Converts snake_case, kebab-case, or path/parts to TitleCase
  return str
    .toLowerCase()
    .replace(/[-_\/](.)/g, (_, char) => char.toUpperCase()) // Handle separators
    .replace(/^{/, '') // Remove leading { from path params
    .replace(/}$/, '') // Remove trailing } from path params
    .replace(/^./, (char) => char.toUpperCase()); // Capitalize first letter
}

/**
 * Generates an operation ID from method and path
 *
 * @param method HTTP method
 * @param path API path
 * @returns Generated operation ID
 */
export function generateOperationId(method: string, path: string): string {
  // Generator: get /users/{userId}/posts -> GetUsersPostsByUserId
  const parts = path.split('/').filter((p) => p); // Split and remove empty parts

  let name = method.toLowerCase(); // Start with method name

  parts.forEach((part, index) => {
    if (part.startsWith('{') && part.endsWith('}')) {
      // Append 'By' + ParamName only for the *last* path parameter segment
      if (index === parts.length - 1) {
        name += 'By' + titleCase(part);
      }
      // Potentially include non-terminal params differently if needed, e.g.:
      // else { name += 'With' + titleCase(part); }
    } else {
      // Append the static path part in TitleCase
      name += titleCase(part);
    }
  });

  // Simple fallback if name is just the method (e.g., GET /)
  if (name === method.toLowerCase()) {
    name += 'Root';
  }

  // Ensure first letter is uppercase after potential lowercase method start
  name = name.charAt(0).toUpperCase() + name.slice(1);

  return name;
}
