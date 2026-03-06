/**
 * Generator for .env file and .env.example file
 */
import { OpenAPIV3 } from 'openapi-types';
import { getEnvVarName } from '../utils/security.js';
import { CliOptions } from '../types/index.js';

/**
 * Generates the content of .env.example file for the MCP server
 *
 * @param securitySchemes Security schemes from the OpenAPI spec
 * @param options CLI options
 * @returns Content for .env.example file
 */
export function generateEnvExample(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes'],
  options?: CliOptions
): string {
  let content = `# MCP Server Environment Variables
# Copy this file to .env and fill in the values

# Server configuration
PORT=3000
LOG_LEVEL=info
# If you have a server outside the servers list from OpenAPI, define it here.
# Otherwise, omit this.
API_BASE_URL=your_api_base_url_here

`;

  // Add security scheme environment variables with examples
  if (securitySchemes && Object.keys(securitySchemes).length > 0) {
    content += `# API Authentication\n`;

    for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
      if ('$ref' in schemeOrRef) {
        content += `# ${name} - Referenced security scheme (reference not resolved)\n`;
        continue;
      }

      const scheme = schemeOrRef;

      if (scheme.type === 'apiKey') {
        const varName = getEnvVarName(name, 'API_KEY');
        content += `${varName}=your_api_key_here\n`;
      } else if (scheme.type === 'http') {
        if (scheme.scheme?.toLowerCase() === 'bearer') {
          const varName = getEnvVarName(name, 'BEARER_TOKEN');
          content += `${varName}=your_bearer_token_here\n`;
        } else if (scheme.scheme?.toLowerCase() === 'basic') {
          const usernameVar = getEnvVarName(name, 'BASIC_USERNAME');
          const passwordVar = getEnvVarName(name, 'BASIC_PASSWORD');
          content += `${usernameVar}=your_username_here\n`;
          content += `${passwordVar}=your_password_here\n`;
        }
      } else if (scheme.type === 'oauth2') {
        content += `# OAuth2 authentication (${scheme.flows ? Object.keys(scheme.flows).join(', ') : 'unknown'} flow)\n`;
        const varName = `OAUTH_TOKEN_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
        content += `${varName}=your_oauth_token_here\n`;
      }
    }
  } else {
    content += `# No API authentication required\n`;
  }

  // Add MCPcat environment variables if enabled
  if (options?.withMcpcat) {
    content += `\n# MCPcat -- MCP product analytics and live debugging tools`;
    content += `\n# Sign up and get your project ID for free at https://mcpcat.io\n`;
    content += `MCPCAT_PROJECT_ID=proj_0000000  # Replace with your MCPcat project ID\n`;
  }

  // Add OpenTelemetry environment variables if enabled
  if (options?.withOtel) {
    content += `\n# OpenTelemetry Configuration for logging and traces\n`;
    content += `OTLP_ENDPOINT=http://localhost:4318/v1/traces  # OTLP collector endpoint\n`;
  }

  content += `\n# Add any other environment variables your API might need\n`;

  return content;
}

/**
 * Generates dotenv configuration code for the MCP server
 *
 * @returns Code for loading environment variables
 */
export function generateDotenvConfig(): string {
  return `
/**
 * Load environment variables from .env file
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
const result = dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (result.error) {
  console.warn('Warning: No .env file found or error loading .env file.');
  console.warn('Using default environment variables.');
}

export const config = {
  port: process.env.PORT || '3000',
  logLevel: process.env.LOG_LEVEL || 'info',
};
`;
}
