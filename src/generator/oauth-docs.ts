/**
 * Generator for OAuth2 documentation
 */
import { OpenAPIV3 } from 'openapi-types';

type OAuthFlowWithScopes = { scopes?: { [scope: string]: string } };

function scopesList(flow: OAuthFlowWithScopes | undefined): string {
  if (!flow?.scopes || Object.keys(flow.scopes).length === 0) return '';
  let content = '\n**Available Scopes:**\n\n';
  for (const [scope, description] of Object.entries(flow.scopes)) {
    content += `- \`${scope}\`: ${description}\n`;
  }
  return content;
}

/**
 * Generates documentation about OAuth2 configuration.
 *
 * It mirrors what generated servers do at runtime: `OAUTH_TOKEN_<SCHEME>` works for
 * every flow, and only schemes with a client credentials flow can fetch a
 * token themselves from `OAUTH_CLIENT_ID_<SCHEME>` and `OAUTH_CLIENT_SECRET_<SCHEME>`.
 *
 * @param securitySchemes Security schemes from OpenAPI spec
 * @returns Markdown documentation about OAuth2 configuration
 */
export function generateOAuth2Docs(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  if (!securitySchemes) {
    return '# OAuth2 Configuration\n\nNo OAuth2 security schemes defined in this API.';
  }

  const oauth2Schemes: { name: string; scheme: OpenAPIV3.OAuth2SecurityScheme }[] = [];

  for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
    if ('$ref' in schemeOrRef) continue;
    if (schemeOrRef.type === 'oauth2') {
      oauth2Schemes.push({ name, scheme: schemeOrRef });
    }
  }

  if (oauth2Schemes.length === 0) {
    return '# OAuth2 Configuration\n\nNo OAuth2 security schemes defined in this API.';
  }

  const canFetchToken = (scheme: OpenAPIV3.OAuth2SecurityScheme) =>
    // The token request uses the client credentials grant, so a password-only scheme cannot
    // fetch a token yet; document a pre-acquired token for it instead.
    Boolean(scheme.flows?.clientCredentials);
  const anyFetches = oauth2Schemes.some(({ scheme }) => canFetchToken(scheme));

  let content = `# OAuth2 Configuration

This API uses OAuth2 for authentication. The MCP server can authenticate in the following ways:

1. **Using a pre-acquired token**: set \`OAUTH_TOKEN_<SCHEME>\` to a token you already obtained. This works for every flow.
`;
  if (anyFetches) {
    content += `2. **Fetching a token itself**: for schemes with a client credentials flow, the server requests a token with your client ID and secret.
`;
  }
  content += `
## Environment Variables

`;

  for (const { name, scheme } of oauth2Schemes) {
    content += `### ${name}\n\n`;

    if (scheme.description) {
      content += `${scheme.description}\n\n`;
    }

    const envVarPrefix = name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const fetches = canFetchToken(scheme);

    content += '**Configuration Variables:**\n\n';
    if (fetches) {
      content += `- \`OAUTH_TOKEN_${envVarPrefix}\`: Pre-acquired OAuth token (optional when the client ID and secret are set)\n`;
      content += `- \`OAUTH_CLIENT_ID_${envVarPrefix}\`: Your OAuth client ID\n`;
      content += `- \`OAUTH_CLIENT_SECRET_${envVarPrefix}\`: Your OAuth client secret\n`;
      content += `- \`OAUTH_SCOPES_${envVarPrefix}\`: Space-separated list of scopes to request (optional)\n`;
    } else {
      content += `- \`OAUTH_TOKEN_${envVarPrefix}\`: Pre-acquired OAuth token (required). The server cannot fetch tokens for this scheme's flows, so obtain one with your OAuth client and set it here.\n`;
    }
    content += '\n';

    const { clientCredentials, password, authorizationCode, implicit } = scheme.flows ?? {};

    if (clientCredentials) {
      content += '**Client Credentials Flow:**\n\n';
      content += `- Token URL: \`${clientCredentials.tokenUrl}\`\n`;
      content += scopesList(clientCredentials);
      content += '\n';
    }

    if (password) {
      content += '**Password Flow:**\n\n';
      content += `- Token URL: \`${password.tokenUrl}\`\n`;
      content += scopesList(password);
      content += '\n';
    }

    if (authorizationCode) {
      content += '**Authorization Code Flow:**\n\n';
      content += `- Authorization URL: \`${authorizationCode.authorizationUrl}\`\n`;
      content += `- Token URL: \`${authorizationCode.tokenUrl}\`\n`;
      content += scopesList(authorizationCode);
      content += '\n';
    }

    if (implicit) {
      content += '**Implicit Flow:**\n\n';
      content += `- Authorization URL: \`${implicit.authorizationUrl}\`\n`;
      content += scopesList(implicit);
      content += '\n';
    }
  }

  if (anyFetches) {
    content += `## Token Caching

The MCP server caches tokens it fetches with a client ID and secret. Tokens are cached for their lifetime (as specified by the \`expires_in\` parameter in the token response) minus 60 seconds as a safety margin.

When making API requests, the server will:

1. Check for a cached token that's still valid
2. Use the cached token if available
3. Request a new token if no valid cached token exists
`;
  }

  return content;
}
