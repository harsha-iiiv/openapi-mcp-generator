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
 * every flow. Schemes with a client credentials flow fetch a token themselves from
 * `OAUTH_CLIENT_ID_<SCHEME>` and `OAUTH_CLIENT_SECRET_<SCHEME>`; schemes with only a
 * password flow fetch one from `OAUTH_USERNAME_<SCHEME>` and `OAUTH_PASSWORD_<SCHEME>`.
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

  // The client credentials grant wins; the password grant is used only without it.
  const usesClientCredentials = (scheme: OpenAPIV3.OAuth2SecurityScheme) =>
    Boolean(scheme.flows?.clientCredentials);
  const usesPasswordGrant = (scheme: OpenAPIV3.OAuth2SecurityScheme) =>
    !scheme.flows?.clientCredentials && Boolean(scheme.flows?.password);
  const canFetchToken = (scheme: OpenAPIV3.OAuth2SecurityScheme) =>
    usesClientCredentials(scheme) || usesPasswordGrant(scheme);
  const anyFetches = oauth2Schemes.some(({ scheme }) => canFetchToken(scheme));
  const anyClientCredentials = oauth2Schemes.some(({ scheme }) => usesClientCredentials(scheme));
  const anyPassword = oauth2Schemes.some(({ scheme }) => usesPasswordGrant(scheme));

  let content = `# OAuth2 Configuration

This API uses OAuth2 for authentication. The MCP server can authenticate in the following ways:

1. **Using a pre-acquired token**: set \`OAUTH_TOKEN_<SCHEME>\` to a token you already obtained. This works for every flow.
`;
  if (anyClientCredentials) {
    content += `2. **Fetching a token with client credentials**: for schemes with a client credentials flow, the server requests a token with your client ID and secret.
`;
  }
  if (anyPassword) {
    content += `${anyClientCredentials ? '3' : '2'}. **Fetching a token with a username and password**: for schemes with only a password flow, the server requests a token with the resource owner's username and password (resource owner password grant).
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

    content += '**Configuration Variables:**\n\n';
    if (usesPasswordGrant(scheme)) {
      content += `- \`OAUTH_TOKEN_${envVarPrefix}\`: Pre-acquired OAuth token (optional when the username and password are set)\n`;
      content += `- \`OAUTH_USERNAME_${envVarPrefix}\`: Resource owner username for the password grant\n`;
      content += `- \`OAUTH_PASSWORD_${envVarPrefix}\`: Resource owner password for the password grant\n`;
      content += `- \`OAUTH_CLIENT_ID_${envVarPrefix}\`: OAuth client ID, if the token endpoint requires one (optional)\n`;
      content += `- \`OAUTH_CLIENT_SECRET_${envVarPrefix}\`: OAuth client secret for a confidential client (optional; leave unset for a public client)\n`;
      content += `- \`OAUTH_SCOPES_${envVarPrefix}\`: Space-separated list of scopes to request (optional)\n`;
    } else if (usesClientCredentials(scheme)) {
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

The MCP server caches the tokens it fetches. Tokens are cached for their lifetime (as specified by the \`expires_in\` parameter in the token response) minus 60 seconds as a safety margin.

When making API requests, the server will:

1. Check for a cached token that's still valid
2. Use the cached token if available
3. Request a new token if no valid cached token exists
`;
  }

  return content;
}
