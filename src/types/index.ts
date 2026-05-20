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
  /** Enable MCPcat analytics tracking */
  withMcpcat?: boolean;
  /** Enable OpenTelemetry (OTLP) exporters */
  withOtel?: boolean;
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
}

/**
 * Helper type for JSON objects
 */
export type JsonObject = Record<string, any>;
