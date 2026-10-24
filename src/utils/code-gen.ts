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
      const outputSchemaLine =
        tool.outputSchema !== undefined
          ? `,\n    outputSchema: ${JSON.stringify(tool.outputSchema)}`
          : '';

      // Build the tool definition entry
      return `
  ["${tool.name}", {
    name: "${tool.name}",${titleLine}
    description: \`${escapedDescription}\`,
    inputSchema: ${schemaString},
    method: "${tool.method}",
    pathTemplate: "${tool.pathTemplate}",
    executionParameters: ${execParamsString},
    requestBodyContentType: ${tool.requestBodyContentType ? `"${tool.requestBodyContentType}"` : 'undefined'},${tool.serverUrl !== undefined ? `\n    serverUrl: ${JSON.stringify(tool.serverUrl)},` : ''}
    securityRequirements: ${securityReqsString},
    tags: ${tagsString},
    deprecated: ${tool.deprecated ? 'true' : 'false'},
    annotations: ${annotationsString}${outputSchemaLine}
  }],`;
    })
    .join('');
}

/**
 * Returns the tools without their output schemas, for servers generated
 * without --output-schema.
 */
export function withoutOutputSchemas(tools: McpToolDefinition[]): McpToolDefinition[] {
  return tools.map(({ outputSchema: _outputSchema, ...tool }) => tool);
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
    ...(def.outputSchema !== undefined && { outputSchema: def.outputSchema }),
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
 * Readable text for one validation error. Exclusive bounds are reworded because
 * @cfworker/json-schema reports a value equal to the bound as, for example,
 * "1 is less than 1."
 */
function schemaErrorText(e: OutputUnit): string {
    if (e.keyword === 'false') return 'Not allowed by the schema.';
    if (e.keyword === 'exclusiveMinimum' || e.keyword === 'exclusiveMaximum') {
        const bound = /(?:than|to) (\\S+)\\.$/.exec(e.error)?.[1];
        if (bound !== undefined) {
            return \`must be \${e.keyword === 'exclusiveMinimum' ? 'greater' : 'less'} than \${bound}.\`;
        }
    }
    return e.error;
}

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
        const message = \`\${location(e.instanceLocation)}: \${schemaErrorText(e)}\`;
        if (!messages.includes(message)) messages.push(message);
    }
    return messages.join('; ');
}

/**
 * Validates a structured result against the tool's declared output schema.
 * Returns a readable error message, or null when it conforms.
 */
function validateToolOutput(toolName: string, outputSchema: unknown, value: unknown): string | null {
    const result = getSchemaValidator(\`output:\${toolName}\`, outputSchema).validate(value);
    return result.valid ? null : formatSchemaErrors(result.errors);
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
 * Generates the helper that picks the upstream base URL for one operation:
 * an absolute operation/path-item server replaces the base URL; a relative one
 * resolves against it. Shared by the Node and Worker targets.
 *
 * @returns Generated TypeScript source
 */
export function generateServerUrlResolutionCode(): string {
  return `
/**
 * Base URL for one operation. Without an operation or path-item server this is
 * the configured base URL (API_BASE_URL, else the spec's root server). An
 * absolute operation/path-item server is used as is, even when API_BASE_URL is
 * set; a relative one resolves against the configured base URL ("v2" appends a
 * segment, "/v2" replaces the path).
 */
function resolveOperationBaseUrl(serverUrl: string | undefined, baseUrl: string): string {
    if (!serverUrl) return baseUrl;
    const isAbsolute = (url: string) => /^[a-z][a-z0-9+.-]*:\\/\\//i.test(url);
    if (isAbsolute(serverUrl)) return serverUrl.replace(/\\/+$/, '');
    if (isAbsolute(baseUrl)) {
        return new URL(serverUrl, baseUrl.replace(/\\/*$/, '/')).href.replace(/\\/+$/, '');
    }
    // Both relative: join the paths.
    if (serverUrl.startsWith('/')) return serverUrl.replace(/\\/+$/, '');
    return \`\${baseUrl.replace(/\\/+$/, '')}/\${serverUrl}\`.replace(/\\/+$/, '');
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
