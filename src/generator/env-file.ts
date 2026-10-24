/**
 * Generator for .env file and .env.example file
 */
import { OpenAPIV3 } from 'openapi-types';
import { InboundAuthMode } from '../types/index.js';
import { getEnvVarName } from '../utils/security.js';
import { generateAllowedOriginsEnvDoc, generateInboundAuthEnvDoc } from './inbound-auth.js';

/** Options affecting the generated .env.example. */
export interface EnvExampleOptions {
  /** Document the inbound MCP token when HTTP inbound auth is enabled (issue #80). */
  inboundAuth?: InboundAuthMode;
  /** Document MCP_ALLOWED_ORIGINS (Node HTTP transports). */
  httpTransport?: boolean;
}

/**
 * Generates the content of .env.example file for the MCP server
 *
 * @param securitySchemes Security schemes from the OpenAPI spec
 * @param options Generation options (inbound auth documentation)
 * @returns Content for .env.example file
 */
export function generateEnvExample(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes'],
  options: EnvExampleOptions = {}
): string {
  let content = `# MCP Server Environment Variables
# Copy this file to .env and fill in the values

# Server configuration
# Port for web / streamable-http transports (also overridable via --port).
PORT=3000
LOG_LEVEL=info
# Override the target API base URL at runtime. Takes precedence over the value
# baked in from the OpenAPI servers list, so you can switch environments
# (staging/prod) without regenerating. Leave it commented out to use the spec-derived default.
# API_BASE_URL=https://api.example.com

`;

  // Add security scheme environment variables with examples. Every credential line is
  // commented out: a placeholder copied unchanged into .env would count as a configured
  // credential and be sent upstream instead of failing closed.
  if (securitySchemes && Object.keys(securitySchemes).length > 0) {
    content += `# API Authentication\n`;
    content += `# Uncomment the variables for the schemes you use and set real values (a placeholder left in place is sent as the credential).\n`;

    for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
      if ('$ref' in schemeOrRef) {
        content += `# ${name} - Referenced security scheme (reference not resolved)\n`;
        continue;
      }

      const scheme = schemeOrRef;

      if (scheme.type === 'apiKey') {
        const varName = getEnvVarName(name, 'API_KEY');
        content += `# ${varName}=your_api_key_here\n`;
      } else if (scheme.type === 'http') {
        if (scheme.scheme?.toLowerCase() === 'bearer') {
          const varName = getEnvVarName(name, 'BEARER_TOKEN');
          content += `# ${varName}=your_bearer_token_here\n`;
        } else if (scheme.scheme?.toLowerCase() === 'basic') {
          const usernameVar = getEnvVarName(name, 'BASIC_USERNAME');
          const passwordVar = getEnvVarName(name, 'BASIC_PASSWORD');
          content += `# ${usernameVar}=your_username_here\n`;
          content += `# ${passwordVar}=your_password_here\n`;
        }
      } else if (scheme.type === 'oauth2') {
        content += `# OAuth2 authentication (${scheme.flows ? Object.keys(scheme.flows).join(', ') : 'unknown'} flow): a token you already have works for every flow\n`;
        content += `# ${getEnvVarName(name, 'OAUTH_TOKEN')}=your_oauth_token_here\n`;
        if (scheme.flows?.clientCredentials) {
          content += `# Or let the server fetch a token with the client credentials grant:\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_CLIENT_ID')}=your_client_id_here\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_CLIENT_SECRET')}=your_client_secret_here\n`;
        } else if (scheme.flows?.password) {
          content += `# Or let the server fetch a token with the password grant (client ID optional, secret only for a confidential client):\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_USERNAME')}=your_username_here\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_PASSWORD')}=your_password_here\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_CLIENT_ID')}=your_client_id_here\n`;
          content += `# ${getEnvVarName(name, 'OAUTH_CLIENT_SECRET')}=your_client_secret_here\n`;
        }
      } else if (scheme.type === 'openIdConnect') {
        content += `# ${getEnvVarName(name, 'OPENID_TOKEN')}=your_openid_token_here\n`;
      }
    }
    content += `
# A tool whose operation requires credentials that are not configured fails with
# an error naming the variables to set, without calling the API. Set to true to
# send such requests without upstream credentials instead (the 4.x behavior).
MCP_ALLOW_MISSING_CREDENTIALS=
`;
  } else {
    content += `# No API authentication required\n`;
  }

  if (options.httpTransport) {
    content += generateAllowedOriginsEnvDoc();
    content += `
# The browser playground at http://localhost:<port>/ lists and calls tools.
# Set to off to stop serving it (for example in production).
MCP_PLAYGROUND=
`;
  }
  content += generateInboundAuthEnvDoc(options.inboundAuth);

  content += `\n# Add any other environment variables your API might need\n`;

  return content;
}
