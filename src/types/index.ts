// src/types/index.ts

/**
 * Core type definitions for the openapi-to-mcp generator
 */
import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7 } from 'json-schema';

/**
 * Transport types supported by the MCP server
 */
export type TransportType = 'stdio' | 'web' | 'streamable-http' | 'cloudflare-worker';

/**
 * Inbound authentication for generated HTTP servers (issue #80).
 * - 'none' (default): the MCP endpoint is public.
 * - 'bearer': clients must send `Authorization: Bearer <token>`; accepted tokens are
 *   read at runtime from MCP_AUTH_TOKENS (comma-separated) or MCP_AUTH_TOKEN.
 */
export type InboundAuthMode = 'none' | 'bearer';

/**
 * How a generated server sends one OpenAPI parameter. `style` and `explode` are
 * set only for query and cookie parameters whose serialization differs from the
 * OpenAPI default (style form, explode true).
 */
export interface ExecutionParameter {
  name: string;
  in: string;
  style?: string;
  explode?: boolean;
}

/**
 * CLI options for the generator
 */
export interface CliOptions {
  /** Path to the OpenAPI specification file */
  input: string;
  /** Output directory path for generated files */
  output: string;
  /** Optional server name to override the one in the OpenAPI spec */
  serverName?: string;
  /** Optional server version to override the one in the OpenAPI spec */
  serverVersion?: string;
  /** Optional base URL to override the one in the OpenAPI spec */
  baseUrl?: string;
  /** Server transport type (stdio, web, or streamable-http) */
  transport?: TransportType;
  /** Server port (for web and streamable-http transports) */
  port?: number;
  /**
   * Default behavior for x-mcp filtering.
   * true (default) = include by default when x-mcp is missing or invalid;
   * false = exclude by default unless x-mcp explicitly enables.
   */
  defaultInclude?: boolean;
  /**
   * Allow resolution of external (http/https) `$ref` references in the spec.
   * Default false: external refs are rejected to prevent SSRF during parsing.
   */
  allowExternalRefs?: boolean;
  /**
   * Maximum length for generated tool names (Claude Desktop limits to 64).
   * Names longer than this are truncated with a deterministic hash suffix.
   * Default 64.
   */
  maxToolNameLength?: number;
  /**
   * Inbound HTTP header names (web/streamable-http transports) to forward
   * onto the upstream API request, overriding env-based auth for those headers.
   */
  headerPassthrough?: string[];
  /**
   * Allow insecure HTTPS connections (skip TLS certificate verification) in the
   * generated server. Default false.
   */
  insecure?: boolean;
  /**
   * Generate library-style output: export `main()` instead of auto-invoking it,
   * and omit signal-handler/cleanup wiring. Default false.
   */
  generateLib?: boolean;
  /**
   * Generate an editable `src/auth.ts` custom auth hook invoked before built-in
   * auth in the generated server. Default false.
   */
  customAuth?: boolean;
  /**
   * Send OAuth2 client credentials in the token request body instead of the
   * Basic Authorization header. Default false.
   */
  oauthCredsInBody?: boolean;
  /**
   * Inbound authentication for HTTP transports (web, streamable-http,
   * cloudflare-worker). Has no effect on stdio. Default 'none'.
   */
  inboundAuth?: InboundAuthMode;
  /** Keep only operations with one of these tags (case-insensitive). */
  includeTags?: string[];
  /** Drop operations with any of these tags (case-insensitive). Wins over inclusions. */
  excludeTags?: string[];
  /** Keep only these operations (operationId or generated tool name). */
  includeOperations?: string[];
  /** Drop these operations (operationId or generated tool name). Wins over inclusions. */
  excludeOperations?: string[];
  /**
   * Declare each tool's outputSchema from its first 2xx application/json response
   * schema (object schemas only) and validate responses against it. Default false.
   */
  outputSchema?: boolean;
}

/**
 * MCP tool annotations: hints about a tool's behavior. Clients treat them as
 * untrusted hints, never as security guarantees.
 */
export interface McpToolAnnotations {
  /** The tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates (meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Repeating the call with the same arguments has no additional effect. */
  idempotentHint?: boolean;
  /** The tool interacts with an open world of external entities. */
  openWorldHint?: boolean;
}

/**
 * MCP Tool Definition describes a tool extracted from an OpenAPI spec
 * for use in Model Context Protocol server
 */
export interface McpToolDefinition {
  /** Name of the tool, must be unique */
  name: string;
  /** Human-readable display name (operation `x-mcp-title`, else its summary) */
  title?: string;
  /** Human-readable description of the tool */
  description: string;
  /** JSON Schema that defines the input parameters */
  inputSchema: JSONSchema7 | boolean;
  /** HTTP method for the operation (get, post, etc.) */
  method: string;
  /** URL path template with parameter placeholders */
  pathTemplate: string;
  /** OpenAPI parameter objects for this operation */
  parameters: OpenAPIV3.ParameterObject[];
  /**
   * Parameter names and locations for execution. Query and cookie parameters carry
   * `style` and `explode` only when they differ from the OpenAPI defaults
   * (style form, explode true).
   */
  executionParameters: ExecutionParameter[];
  /** Content type for request body, if applicable */
  requestBodyContentType?: string;
  /**
   * Server URL declared on the operation or its path item (variables resolved).
   * Absolute URLs replace the base URL; relative ones resolve against it.
   */
  serverUrl?: string;
  /**
   * Base URL for the API: `GetToolsOptions.baseUrl`, else the spec's first root server
   * (variables resolved), else an empty string. Set on every tool returned by
   * `getToolsFromOpenApi`. An operation or path-item server is reported in `serverUrl`
   * and takes precedence over this value when calling the API.
   */
  baseUrl?: string;
  /** Security requirements for this operation */
  securityRequirements: OpenAPIV3.SecurityRequirementObject[];
  /** Original operation ID from the OpenAPI spec */
  operationId: string;
  /** OpenAPI tags associated with this operation, if any */
  tags?: string[];
  /** Whether the operation is marked deprecated in the OpenAPI spec */
  deprecated?: boolean;
  /** Behavior hints derived from the HTTP method, overridable with `x-mcp-annotations` */
  annotations?: McpToolAnnotations;
  /**
   * JSON Schema of the first (lowest) 2xx `application/json` response, when it describes
   * an object (writeOnly properties removed). Generated servers declare it as the
   * tool's outputSchema only with --output-schema.
   */
  outputSchema?: JSONSchema7;
}

/**
 * Helper type for JSON objects
 */
export type JsonObject = Record<string, any>;
