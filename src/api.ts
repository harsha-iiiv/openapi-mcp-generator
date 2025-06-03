/**
 * Programmatic API for OpenAPI to MCP Generator
 * Allows direct usage from other Node.js applications
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV3 } from 'openapi-types';
import { extractToolsFromApi } from './parser/extract-tools.js';
import type { McpToolDefinition } from './types/index.js';
import { determineBaseUrl } from './utils/url.js';

/**
 * Options for generating the MCP tools
 */
export interface GetToolsOptions {
  /** Optional base URL to override the one in the OpenAPI spec */
  baseUrl?: string;
  
  /** Whether to dereference the OpenAPI spec */
  dereference?: boolean;
  
  /** Array of operation IDs to exclude from the tools list */
  excludeOperationIds?: string[];
  
  /** Optional filter function to exclude tools based on custom criteria */
  filterFn?: (tool: McpToolDefinition) => boolean;
}

/**
 * Get a list of tools from an OpenAPI specification
 * 
 * @param specPathOrUrl Path or URL to the OpenAPI specification
 * @param options Options for generating the tools
 * @returns Promise that resolves to an array of tool definitions
 */
export async function getToolsFromOpenApi(
  specPathOrUrl: string,
  options: GetToolsOptions = {}
): Promise<McpToolDefinition[]> {
  try {
    // Parse the OpenAPI spec
    const api = options.dereference 
      ? (await SwaggerParser.dereference(specPathOrUrl)) as OpenAPIV3.Document
      : (await SwaggerParser.parse(specPathOrUrl)) as OpenAPIV3.Document;

    // Extract tools from the API
    const allTools = extractToolsFromApi(api);
    
    // Add base URL to each tool
    const baseUrl = determineBaseUrl(api, options.baseUrl);
    
    // Apply filters to exclude specified operationIds and custom filter function
    let filteredTools = allTools;
    
    // Filter by excluded operation IDs if provided
    if (options.excludeOperationIds && options.excludeOperationIds.length > 0) {
      const excludeSet = new Set(options.excludeOperationIds);
      filteredTools = filteredTools.filter(tool => !excludeSet.has(tool.operationId));
    }
    
    // Apply custom filter function if provided
    if (options.filterFn) {
      filteredTools = filteredTools.filter(options.filterFn);
    }
    
    // Return the filtered tools with base URL added
    return filteredTools.map(tool => ({
      ...tool,
      baseUrl: baseUrl || '',
    }));
  } catch (error) {
    // Provide more context for the error
    if (error instanceof Error) {
      throw new Error(`Failed to extract tools from OpenAPI: ${error.message}`);
    }
    throw error;
  }
}

// Export types for convenience
export { McpToolDefinition };