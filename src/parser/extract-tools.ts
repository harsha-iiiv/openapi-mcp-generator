/**
 * Functions for extracting tools from an OpenAPI specification
 */
import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7, JSONSchema7TypeName } from 'json-schema';
import { createHash } from 'crypto';
import { generateOperationId } from '../utils/code-gen.js';
import { ExecutionParameter, McpToolAnnotations, McpToolDefinition } from '../types/index.js';
import { shouldIncludeOperationForMcp } from '../utils/helpers.js';
import { normalizeUrl, resolveServerUrl } from '../utils/url.js';

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

/** The boolean hints `x-mcp-annotations` may override. */
const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

/**
 * MCP tool annotations for an operation: defaults from the HTTP method's
 * semantics (RFC 9110 safe and idempotent methods), then any boolean hints from
 * the operation's `x-mcp-annotations` object.
 */
export function getToolAnnotations(method: string, operation: object): McpToolAnnotations {
  let annotations: McpToolAnnotations;
  switch (method.toLowerCase()) {
    case 'get':
    case 'head':
    case 'options':
    case 'trace':
      annotations = { readOnlyHint: true, openWorldHint: true };
      break;
    case 'put':
    case 'delete':
      annotations = {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      };
      break;
    case 'patch':
      annotations = {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
      break;
    default: // post and anything unknown
      annotations = {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
  const overrides = (operation as Record<string, unknown>)['x-mcp-annotations'];
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      console.warn(
        `Ignoring x-mcp-annotations: expected an object, got ${JSON.stringify(overrides)}.`
      );
    } else {
      for (const [key, value] of Object.entries(overrides)) {
        if ((ANNOTATION_HINTS as readonly string[]).includes(key) && typeof value === 'boolean') {
          annotations[key as (typeof ANNOTATION_HINTS)[number]] = value;
        } else {
          console.warn(
            `Ignoring x-mcp-annotations.${key}: expected one of ${ANNOTATION_HINTS.join(', ')} with a boolean value.`
          );
        }
      }
    }
  }
  return annotations;
}

/**
 * Output schema for an operation: the schema of its first (lowest) 2xx response
 * with `application/json` content, mapped as a response (writeOnly properties
 * dropped). Only object schemas qualify, because MCP structured content is a
 * JSON object.
 */
export function getOutputSchema(operation: OpenAPIV3.OperationObject): JSONSchema7 | undefined {
  for (const [status, responseOrRef] of Object.entries(operation.responses ?? {})) {
    if (!/^2(\d\d|XX)$/i.test(status)) continue;
    const response = responseOrRef as OpenAPIV3.ResponseObject;
    const mediaType = Object.entries(response?.content ?? {}).find(([type]) =>
      /^application\/json\b/i.test(type)
    )?.[1];
    if (!mediaType?.schema) continue;
    const mapped = mapOpenApiSchemaToJsonSchema(mediaType.schema, { direction: 'response' });
    return typeof mapped === 'object' && mapped.type === 'object' ? mapped : undefined;
  }
  return undefined;
}

/**
 * Display title for an operation: `x-mcp-title`, else the trimmed summary.
 */
export function getToolTitle(operation: object): string | undefined {
  const record = operation as Record<string, unknown>;
  for (const candidate of [record['x-mcp-title'], record.summary]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
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
      const executionParameters = parameters.map(toExecutionParameter);

      // Determine security requirements
      const securityRequirements =
        operation.security === null ? globalSecurity : operation.security || globalSecurity;

      // Extract OpenAPI tags and deprecation status
      const tags = Array.isArray(operation.tags) ? operation.tags.filter(Boolean) : [];
      const deprecated = operation.deprecated === true;

      // Create the tool definition
      // Operation servers win over path-item servers; the root server is the default base URL.
      const server = operation.servers?.[0] ?? pathItem.servers?.[0];
      const serverUrl = server?.url ? normalizeUrl(resolveServerUrl(server)) : undefined;

      const title = getToolTitle(operation);
      const outputSchema = getOutputSchema(operation);
      tools.push({
        name: finalToolName,
        ...(title !== undefined && { title }),
        description,
        inputSchema,
        method,
        pathTemplate: path,
        parameters,
        executionParameters,
        requestBodyContentType,
        securityRequirements,
        ...(serverUrl !== undefined && { serverUrl }),
        operationId: originalOperationId,
        tags,
        deprecated,
        annotations: getToolAnnotations(method, operation),
        ...(outputSchema !== undefined && { outputSchema }),
      });
    }
  }

  return tools;
}

/**
 * Execution metadata for one parameter. Query and cookie parameters keep their
 * OpenAPI `style` and `explode` only when they differ from the defaults (style
 * form, explode true for form and false for every other style), so specs that
 * use the defaults generate the same output as before.
 */
export function toExecutionParameter(param: OpenAPIV3.ParameterObject): ExecutionParameter {
  const entry: ExecutionParameter = { name: param.name, in: param.in };
  if (param.in !== 'query' && param.in !== 'cookie') return entry;
  const style = param.style ?? 'form';
  const explode = param.explode ?? style === 'form';
  if (style !== 'form') entry.style = style;
  if (explode !== (style === 'form')) entry.explode = explode;
  return entry;
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

    const paramSchema = mapOpenApiSchemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject, {
      direction: 'request',
    });
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
      const bodySchema = mapOpenApiSchemaToJsonSchema(
        jsonContent.schema as OpenAPIV3.SchemaObject,
        {
          direction: 'request',
        }
      );

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

/** Keywords whose value is a single subschema. */
const SINGLE_SCHEMA_KEYWORDS = [
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
] as const;
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
] as const;

/**
 * OpenAPI 3.0 writes exclusive bounds as a boolean next to minimum/maximum;
 * JSON Schema (and OpenAPI 3.1) writes the bound itself. Converts the 3.0 form
 * and leaves numeric bounds untouched.
 */
function normalizeExclusiveBound(schema: Record<string, any>, bound: 'minimum' | 'maximum'): void {
  const exclusiveKey = bound === 'minimum' ? 'exclusiveMinimum' : 'exclusiveMaximum';
  if (typeof schema[exclusiveKey] !== 'boolean') return;
  if (schema[exclusiveKey] && typeof schema[bound] === 'number') {
    schema[exclusiveKey] = schema[bound];
    delete schema[bound];
  } else {
    delete schema[exclusiveKey];
  }
}

/** Options for {@link mapOpenApiSchemaToJsonSchema}. */
export interface MapSchemaOptions {
  /**
   * Which side of the exchange the schema describes. 'request' drops properties
   * marked `readOnly: true` (the API ignores or rejects them in requests);
   * 'response' drops properties marked `writeOnly: true` (the API never returns
   * them). Omitted: properties are kept.
   */
  direction?: 'request' | 'response';
}

/**
 * Maps an OpenAPI schema to JSON Schema (2020-12), recursing into every
 * subschema (properties, items, composition keywords, additionalProperties, ...).
 *
 * Types (including `integer`), `format`, `pattern`, enums and composition
 * keywords are kept as written. OpenAPI-only keywords are removed, `nullable`
 * becomes a `null` type, a 3.0 boolean exclusive bound becomes a numeric one and
 * a single `example` becomes `examples: [example]`.
 *
 * @param schema OpenAPI schema object or reference
 * @param options Mapping options (request/response direction)
 * @param seen Schemas on the current recursion path, used to break cycles
 * @returns JSON Schema representation
 */
export function mapOpenApiSchemaToJsonSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  options: MapSchemaOptions = {},
  seen: WeakSet<object> = new WeakSet()
): JSONSchema7 | boolean {
  // Handle boolean schemas
  if (typeof schema === 'boolean') return schema;
  if (schema === null || typeof schema !== 'object') return {};

  // Handle reference objects
  if ('$ref' in schema) {
    console.warn(`Unresolved $ref '${schema.$ref}'.`);
    return { type: 'object' };
  }

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
    const jsonSchema: Record<string, any> = { ...schema };

    normalizeExclusiveBound(jsonSchema, 'minimum');
    normalizeExclusiveBound(jsonSchema, 'maximum');

    // OpenAPI's single `example` is JSON Schema's `examples` array.
    if (!Array.isArray(jsonSchema.examples)) {
      if (jsonSchema.example !== undefined) jsonSchema.examples = [jsonSchema.example];
      else delete jsonSchema.examples;
    }

    // Remove OpenAPI-specific properties that aren't in JSON Schema
    delete jsonSchema.nullable;
    delete jsonSchema.example;
    delete jsonSchema.xml;
    delete jsonSchema.externalDocs;
    delete jsonSchema.deprecated;
    delete jsonSchema.readOnly;
    delete jsonSchema.writeOnly;

    // Handle nullable properties by adding null to the type
    if (schema.nullable) {
      if (Array.isArray(jsonSchema.type)) {
        if (!jsonSchema.type.includes('null')) jsonSchema.type = [...jsonSchema.type, 'null'];
      } else if (typeof jsonSchema.type === 'string') {
        jsonSchema.type = [jsonSchema.type as JSONSchema7TypeName, 'null'];
      } else if (!jsonSchema.type) {
        jsonSchema.type = 'null';
      }
    }

    const mapChild = (child: unknown): unknown =>
      child !== null && typeof child === 'object' && !Array.isArray(child)
        ? mapOpenApiSchemaToJsonSchema(child as OpenAPIV3.SchemaObject, options, seen)
        : child;

    // Drop properties this direction never carries: readOnly ones from requests,
    // writeOnly ones from responses (and from `required`, so it stays satisfiable).
    const hiddenKeyword =
      options.direction === 'request'
        ? 'readOnly'
        : options.direction === 'response'
          ? 'writeOnly'
          : undefined;
    const properties = jsonSchema.properties;
    if (
      hiddenKeyword &&
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    ) {
      const hidden = Object.keys(properties).filter((name) => {
        const child = properties[name];
        return child !== null && typeof child === 'object' && child[hiddenKeyword] === true;
      });
      if (hidden.length > 0) {
        jsonSchema.properties = Object.fromEntries(
          Object.entries(properties).filter(([name]) => !hidden.includes(name))
        );
        if (Array.isArray(jsonSchema.required)) {
          const required = jsonSchema.required.filter((name: string) => !hidden.includes(name));
          if (required.length > 0) jsonSchema.required = required;
          else delete jsonSchema.required;
        }
      }
    }

    for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
      if (keyword in jsonSchema) jsonSchema[keyword] = mapChild(jsonSchema[keyword]);
    }
    // items is one schema (OpenAPI 3.0 / 3.1) or a tuple (older drafts)
    if ('items' in jsonSchema) {
      jsonSchema.items = Array.isArray(jsonSchema.items)
        ? jsonSchema.items.map(mapChild)
        : mapChild(jsonSchema.items);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      if (Array.isArray(jsonSchema[keyword]))
        jsonSchema[keyword] = jsonSchema[keyword].map(mapChild);
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const map = jsonSchema[keyword];
      if (map === null || typeof map !== 'object' || Array.isArray(map)) continue;
      const mapped: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(map)) mapped[name] = mapChild(child);
      jsonSchema[keyword] = mapped;
    }

    return jsonSchema as JSONSchema7;
  } finally {
    seen.delete(schema);
  }
}

/** Tag and operation filters applied after x-mcp filtering. */
export interface ToolFilterOptions {
  /** Keep only tools with at least one of these tags (case-insensitive). */
  includeTags?: string[];
  /** Drop tools with any of these tags (case-insensitive). */
  excludeTags?: string[];
  /** Keep only these operations (operationId or generated tool name). */
  includeOperations?: string[];
  /** Drop these operations (operationId or generated tool name). */
  excludeOperations?: string[];
}

/**
 * Applies tag and operation filters. When any include list is given, a tool is
 * kept if it matches one of them (a listed tag or a listed operation); every
 * exclusion then removes matching tools, so exclusions win over inclusions.
 * Filter values that match no tool are reported with a warning.
 */
export function filterTools(
  tools: McpToolDefinition[],
  filters: ToolFilterOptions = {}
): McpToolDefinition[] {
  const clean = (values?: string[]) =>
    (Array.isArray(values) ? values : []).map((v) => v.trim()).filter(Boolean);
  const includeTags = clean(filters.includeTags).map((t) => t.toLowerCase());
  const excludeTags = clean(filters.excludeTags).map((t) => t.toLowerCase());
  const includeOperations = clean(filters.includeOperations);
  const excludeOperations = clean(filters.excludeOperations);
  if (
    includeTags.length +
      excludeTags.length +
      includeOperations.length +
      excludeOperations.length ===
    0
  ) {
    return tools;
  }

  const tagsOf = (tool: McpToolDefinition) => (tool.tags ?? []).map((t) => t.toLowerCase());
  const isOperation = (tool: McpToolDefinition, value: string) =>
    tool.operationId === value || tool.name === value;
  const warnUnmatched = (flag: string, values: string[], matches: (value: string) => boolean) => {
    for (const value of values) {
      if (!matches(value)) console.warn(`Warning: ${flag} '${value}' matches no operation.`);
    }
  };
  warnUnmatched('--include-tags', includeTags, (tag) => tools.some((t) => tagsOf(t).includes(tag)));
  warnUnmatched('--exclude-tags', excludeTags, (tag) => tools.some((t) => tagsOf(t).includes(tag)));
  warnUnmatched('--include-operations', includeOperations, (op) =>
    tools.some((t) => isOperation(t, op))
  );
  warnUnmatched('--exclude-operations', excludeOperations, (op) =>
    tools.some((t) => isOperation(t, op))
  );

  const hasIncludes = includeTags.length > 0 || includeOperations.length > 0;
  return tools.filter((tool) => {
    const tags = tagsOf(tool);
    if (excludeTags.some((tag) => tags.includes(tag))) return false;
    if (excludeOperations.some((op) => isOperation(tool, op))) return false;
    if (!hasIncludes) return true;
    return (
      includeTags.some((tag) => tags.includes(tag)) ||
      includeOperations.some((op) => isOperation(tool, op))
    );
  });
}
