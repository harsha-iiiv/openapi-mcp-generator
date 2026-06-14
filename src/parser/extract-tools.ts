/**
 * Functions for extracting tools from an OpenAPI specification
 */
import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7, JSONSchema7TypeName } from 'json-schema';
import { createHash } from 'crypto';
import { generateOperationId } from '../utils/code-gen.js';
import { McpToolDefinition } from '../types/index.js';
import { shouldIncludeOperationForMcp } from '../utils/helpers.js';

/** Default maximum tool name length (Claude Desktop limit). */
export const DEFAULT_MAX_TOOL_NAME_LENGTH = 64;

/** Length of the deterministic hex hash segment appended for uniqueness. */
const HASH_LEN = 6;
/** Marker inserted where the middle of a name is elided: `head__tail`. */
const ELISION_MARKER = '__';
/** Fraction of the head/tail budget given to the head (front carries the verb/resource). */
const HEAD_RATIO = 0.6;
/** Words this length or shorter are kept intact during abbreviation. */
const SHORT_WORD_MAX = 3;
/** Longer words are abbreviated to this many leading characters. */
const ABBREV_WORD_LEN = 4;

/**
 * Split a tool name into words on `_`/`-` boundaries and camelCase humps,
 * preserving each word's original casing so it can be rejoined.
 *
 * `FDA_get_info_on_conditions` -> ['FDA','get','info','on','conditions']
 * `createUserSubscriptionMethod` -> ['create','User','Subscription','Method']
 */
export function splitNameIntoWords(name: string): string[] {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .flatMap(
      (segment) =>
        // Split camelCase / PascalCase, and digit boundaries, into separate words.
        segment.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [segment]
    );
}

/**
 * Abbreviate a tool name word-by-word (inspired by ToolUniverse): keep the
 * first word (category/verb prefix) intact, then for each subsequent word keep
 * short words (<= 3 chars) as-is and shorten longer words to their first 4
 * characters. Words are rejoined with `_`.
 *
 * `FDA_get_info_on_conditions_for_doctor_consultation_by_drug_name`
 *   -> `FDA_get_info_on_cond_for_doct_cons_by_drug_name`
 *
 * Readability-preserving but NOT length-guaranteed (a name with very many words
 * can still exceed the limit), so callers must apply a hard backstop.
 */
export function abbreviateToolName(name: string): string {
  const words = splitNameIntoWords(name);
  if (words.length <= 1) return name;
  return words
    .map((word, i) => {
      if (i === 0) return word; // preserve the category/verb prefix
      if (word.length <= SHORT_WORD_MAX) return word;
      return word.slice(0, ABBREV_WORD_LEN);
    })
    .join('_');
}

/**
 * Produce an MCP-compliant tool name within `maxLength` (issue #4).
 *
 * Strategy:
 *  1. If the name already fits, return it unchanged.
 *  2. Try word-level abbreviation (readable, no hash). If that fits, use it.
 *  3. Otherwise fall back to deterministic Start…End hash truncation.
 *
 * @param name Sanitized candidate tool name
 * @param maxLength Maximum allowed length
 * @returns A name guaranteed to be <= maxLength
 */
export function shortenToolName(name: string, maxLength: number): string {
  if (maxLength <= 0 || name.length <= maxLength) return name;
  const abbreviated = abbreviateToolName(name);
  if (abbreviated.length <= maxLength && abbreviated !== name) {
    return abbreviated;
  }
  // Abbreviation alone wasn't enough — hash-truncate the (already abbreviated)
  // name so distinct long names still collapse to unique, stable identifiers.
  return truncateToolName(abbreviated.length < name.length ? abbreviated : name, maxLength);
}

/**
 * Truncate a tool name to `maxLength` when it exceeds the limit.
 *
 * Strategy (issue #4): names are truncated "Start…End" style — the head and
 * the tail are both preserved and the middle is elided with `__` — followed by
 * a short deterministic hash of the *full* name. This keeps tool names readable
 * for the model in both common collision shapes (prefix collisions like
 * `createUserSubscriptionPaymentMethodWith...` where the tail disambiguates,
 * and suffix collisions like `getUserById`/`getOrderById` where the head does),
 * while the hash guarantees uniqueness even when both ends match. The hash is
 * computed over the original name, so output is stable across runs and spec
 * reordering.
 *
 * For very small limits there isn't room for two ends plus a marker plus a
 * hash, so it falls back to `head_hash`.
 *
 * Returns the name unchanged when already within the limit.
 */
export function truncateToolName(name: string, maxLength: number): string {
  if (maxLength <= 0 || name.length <= maxLength) return name;

  const hash = createHash('sha1').update(name).digest('hex').slice(0, HASH_LEN);
  const hashSuffix = `_${hash}`; // separator + hash

  // Budget left for the visible name once the hash is reserved.
  const nameBudget = maxLength - hashSuffix.length;

  // Need at least 2 chars per end plus the marker to make Start…End meaningful;
  // otherwise degrade to head + hash.
  const headTailBudget = nameBudget - ELISION_MARKER.length;
  if (headTailBudget < 4) {
    const headLength = Math.max(1, nameBudget);
    return `${name.slice(0, headLength)}${hashSuffix}`.slice(0, maxLength);
  }

  const headLength = Math.ceil(headTailBudget * HEAD_RATIO);
  const tailLength = headTailBudget - headLength;
  const head = name.slice(0, headLength);
  const tail = tailLength > 0 ? name.slice(name.length - tailLength) : '';
  return `${head}${ELISION_MARKER}${tail}${hashSuffix}`.slice(0, maxLength);
}

/**
 * Extracts tool definitions from an OpenAPI document
 *
 * @param api OpenAPI document
 * @returns Array of MCP tool definitions
 */
/** Smallest tool-name length that still guarantees collision-resolution progress. */
export const MIN_TOOL_NAME_LENGTH = 8;

export function extractToolsFromApi(
  api: OpenAPIV3.Document,
  defaultInclude: boolean = true,
  maxToolNameLength: number = DEFAULT_MAX_TOOL_NAME_LENGTH
): McpToolDefinition[] {
  // Clamp pathologically small limits so the collision-resolution loop below
  // always makes progress (the 6-char hash suffix needs room to stay unique).
  if (maxToolNameLength < MIN_TOOL_NAME_LENGTH) {
    console.warn(
      `maxToolNameLength=${maxToolNameLength} is too small; using ${MIN_TOOL_NAME_LENGTH} to keep tool names unique.`
    );
    maxToolNameLength = MIN_TOOL_NAME_LENGTH;
  }

  const tools: McpToolDefinition[] = [];
  const usedNames = new Set<string>();
  const globalSecurity = api.security || [];

  if (!api.paths) return tools;

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Apply x-mcp filtering, precedence: operation > path > root
      try {
        if (
          !shouldIncludeOperationForMcp(
            api,
            pathItem as OpenAPIV3.PathItemObject,
            operation,
            defaultInclude
          )
        ) {
          continue;
        }
      } catch (error) {
        const loc = operation.operationId || `${method} ${path}`;
        const extVal =
          (operation as any)['x-mcp'] ?? (pathItem as any)['x-mcp'] ?? (api as any)['x-mcp'];
        let extPreview: string;
        try {
          extPreview = JSON.stringify(extVal);
        } catch {
          extPreview = String(extVal);
        }
        console.warn(
          `Error evaluating x-mcp extension for operation ${loc} (x-mcp=${extPreview}):`,
          error
        );
        if (!defaultInclude) {
          continue;
        }
      }

      // Generate a unique name for the tool.
      // Preserve the original operationId (or generated fallback) separately so
      // tool.operationId stays stable for callers that filter on it, e.g.
      // getToolsFromOpenApi({ excludeOperationIds }) — independent of the
      // sanitization/truncation applied to the MCP-facing tool name.
      const originalOperationId = operation.operationId || generateOperationId(method, path);
      if (!originalOperationId) continue;

      // Sanitize the name to be MCP-compatible (only a-z, 0-9, _, -)
      const sanitized = originalOperationId.replace(/\./g, '_').replace(/[^a-z0-9_-]/gi, '_');

      // Shorten to fit the limit: word-abbreviate first, hash-truncate as backstop.
      const baseName = shortenToolName(sanitized, maxToolNameLength);

      // Resolve collisions deterministically. Use a content hash of the
      // original operationId (stable across spec reordering) rather than an
      // order-dependent counter, re-shortened to stay within the limit.
      let finalToolName = baseName;
      let attempt = 0;
      while (usedNames.has(finalToolName)) {
        const disambiguator = createHash('sha1')
          .update(`${sanitized}#${attempt++}`)
          .digest('hex')
          .slice(0, HASH_LEN);
        const suffix = `_${disambiguator}`;
        const headRoom = Math.max(1, maxToolNameLength - suffix.length);
        finalToolName = `${baseName.slice(0, headRoom)}${suffix}`;
      }
      usedNames.add(finalToolName);

      // Get or create a description
      const description =
        operation.description || operation.summary || `Executes ${method.toUpperCase()} ${path}`;

      // Generate input schema and extract parameters
      const { inputSchema, parameters, requestBodyContentType } = generateInputSchemaAndDetails(
        operation,
        pathItem.parameters
      );

      // Extract parameter details for execution
      const executionParameters = parameters.map((p) => ({ name: p.name, in: p.in }));

      // Determine security requirements
      const securityRequirements =
        operation.security === null ? globalSecurity : operation.security || globalSecurity;

      // Extract OpenAPI tags and deprecation status
      const tags = Array.isArray(operation.tags) ? operation.tags.filter(Boolean) : [];
      const deprecated = operation.deprecated === true;

      // Create the tool definition
      tools.push({
        name: finalToolName,
        description,
        inputSchema,
        method,
        pathTemplate: path,
        parameters,
        executionParameters,
        requestBodyContentType,
        securityRequirements,
        operationId: originalOperationId,
        tags,
        deprecated,
      });
    }
  }

  return tools;
}

/**
 * Generates input schema and extracts parameter details from an operation
 *
 * @param operation OpenAPI operation object
 * @param pathParameters Optional path-level parameters that apply to all operations in the path
 * @returns Input schema, parameters, and request body content type
 */
export function generateInputSchemaAndDetails(
  operation: OpenAPIV3.OperationObject,
  pathParameters?: (OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject)[]
): {
  inputSchema: JSONSchema7 | boolean;
  parameters: OpenAPIV3.ParameterObject[];
  requestBodyContentType?: string;
} {
  const properties: { [key: string]: JSONSchema7 | boolean } = {};
  const required: string[] = [];

  // Process parameters - merge path parameters with operation parameters
  const operationParameters: OpenAPIV3.ParameterObject[] = Array.isArray(operation.parameters)
    ? operation.parameters.map((p) => p as OpenAPIV3.ParameterObject)
    : [];

  const pathParametersResolved: OpenAPIV3.ParameterObject[] = Array.isArray(pathParameters)
    ? pathParameters.map((p) => p as OpenAPIV3.ParameterObject)
    : [];

  // Combine path parameters and operation parameters
  // Operation parameters override path parameters if they have the same name/location
  const allParameters: OpenAPIV3.ParameterObject[] = [];

  pathParametersResolved.concat(operationParameters).forEach((param) => {
    const existingIndex = allParameters.findIndex(
      (pathParam) => pathParam.name === param.name && pathParam.in === param.in
    );
    if (existingIndex >= 0) {
      // Override path parameter with operation parameter
      allParameters[existingIndex] = param;
    } else {
      // Add new operation parameter
      allParameters.push(param);
    }
  });

  allParameters.forEach((param) => {
    if (!param.name || !param.schema) return;

    const paramSchema = mapOpenApiSchemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject);
    if (typeof paramSchema === 'object') {
      paramSchema.description = param.description || paramSchema.description;
    }

    properties[param.name] = paramSchema;
    if (param.required) required.push(param.name);
  });

  // Process request body (if present)
  let requestBodyContentType: string | undefined = undefined;

  if (operation.requestBody) {
    const opRequestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
    const jsonContent = opRequestBody.content?.['application/json'];
    const firstContent = opRequestBody.content
      ? Object.entries(opRequestBody.content)[0]
      : undefined;

    if (jsonContent?.schema) {
      requestBodyContentType = 'application/json';
      const bodySchema = mapOpenApiSchemaToJsonSchema(jsonContent.schema as OpenAPIV3.SchemaObject);

      if (typeof bodySchema === 'object') {
        bodySchema.description =
          opRequestBody.description || bodySchema.description || 'The JSON request body.';
      }

      properties['requestBody'] = bodySchema;
      if (opRequestBody.required) required.push('requestBody');
    } else if (firstContent) {
      const [contentType] = firstContent;
      requestBodyContentType = contentType;

      properties['requestBody'] = {
        type: 'string',
        description: opRequestBody.description || `Request body (content type: ${contentType})`,
      };

      if (opRequestBody.required) required.push('requestBody');
    }
  }

  // Combine everything into a JSON Schema
  const inputSchema: JSONSchema7 = {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  };

  return { inputSchema, parameters: allParameters, requestBodyContentType };
}

/**
 * Maps an OpenAPI schema to a JSON Schema with cycle protection.
 *
 * @param schema OpenAPI schema object or reference
 * @param seen WeakSet tracking already visited schema objects
 * @returns JSON Schema representation
 */
export function mapOpenApiSchemaToJsonSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  seen: WeakSet<object> = new WeakSet()
): JSONSchema7 | boolean {
  // Handle reference objects
  if ('$ref' in schema) {
    console.warn(`Unresolved $ref '${schema.$ref}'.`);
    return { type: 'object' };
  }

  // Handle boolean schemas
  if (typeof schema === 'boolean') return schema;

  // Detect cycles
  if (seen.has(schema)) {
    console.warn(
      `Cycle detected in schema${schema.title ? ` "${schema.title}"` : ''}, returning generic object to break recursion.`
    );
    return { type: 'object' };
  }
  seen.add(schema);

  try {
    // Create a copy of the schema to modify
    const jsonSchema: JSONSchema7 = { ...schema } as any;

    // Convert integer type to number (JSON Schema compatible)
    if (schema.type === 'integer') jsonSchema.type = 'number';

    // Remove OpenAPI-specific properties that aren't in JSON Schema
    delete (jsonSchema as any).nullable;
    delete (jsonSchema as any).example;
    delete (jsonSchema as any).xml;
    delete (jsonSchema as any).externalDocs;
    delete (jsonSchema as any).deprecated;
    delete (jsonSchema as any).readOnly;
    delete (jsonSchema as any).writeOnly;

    // Handle nullable properties by adding null to the type
    if (schema.nullable) {
      if (Array.isArray(jsonSchema.type)) {
        if (!jsonSchema.type.includes('null')) jsonSchema.type.push('null');
      } else if (typeof jsonSchema.type === 'string') {
        jsonSchema.type = [jsonSchema.type as JSONSchema7TypeName, 'null'];
      } else if (!jsonSchema.type) {
        jsonSchema.type = 'null';
      }
    }

    // Recursively process object properties
    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      const mappedProps: { [key: string]: JSONSchema7 | boolean } = {};

      for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
        if (typeof propSchema === 'object' && propSchema !== null) {
          mappedProps[key] = mapOpenApiSchemaToJsonSchema(
            propSchema as OpenAPIV3.SchemaObject,
            seen
          );
        } else if (typeof propSchema === 'boolean') {
          mappedProps[key] = propSchema;
        }
      }

      jsonSchema.properties = mappedProps;
    }

    // Recursively process array items
    if (
      jsonSchema.type === 'array' &&
      typeof jsonSchema.items === 'object' &&
      jsonSchema.items !== null
    ) {
      jsonSchema.items = mapOpenApiSchemaToJsonSchema(
        jsonSchema.items as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
        seen
      );
    }
    return jsonSchema;
  } finally {
    seen.delete(schema);
  }
}
