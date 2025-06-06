/**
 * Generator for .env file and .env.example file
 */
import { OpenAPIV3 } from 'openapi-types';
import { getEnvVarName } from '../utils/security.js';

/**
 * Generates the content of .env.example file for the MCP server
 *
 * @param securitySchemes Security schemes from the OpenAPI spec
 * @returns Content for .env.example file
 */
export function generateEnvExample(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  let content = `# MCP Server Environment Variables
# Copy this file to .env and fill in the values

# Server configuration
PORT=3000
LOG_LEVEL=info

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
