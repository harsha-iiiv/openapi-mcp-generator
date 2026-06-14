// src/types/index.ts

/**
 * Core type definitions for the openapi-to-mcp generator
 */
import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7 } from 'json-schema';

/**
 * Transport types supported by the MCP server
 */
export type TransportType = 'stdio' | 'web' | 'streamable-http';

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
}

/**
 * MCP Tool Definition describes a tool extracted from an OpenAPI spec
 * for use in Model Context Protocol server
 */
export interface McpToolDefinition {
  /** Name of the tool, must be unique */
  name: string;
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
  /** Parameter names and locations for execution */
  executionParameters: { name: string; in: string }[];
  /** Content type for request body, if applicable */
  requestBodyContentType?: string;
  /** Security requirements for this operation */
  securityRequirements: OpenAPIV3.SecurityRequirementObject[];
  /** Original operation ID from the OpenAPI spec */
  operationId: string;
  /** OpenAPI tags associated with this operation, if any */
  tags?: string[];
  /** Whether the operation is marked deprecated in the OpenAPI spec */
  deprecated?: boolean;
}

/**
 * Helper type for JSON objects
 */
export type JsonObject = Record<string, any>;
