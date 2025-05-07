/**
 * Security handling utilities for OpenAPI to MCP generator
 */
import { OpenAPIV3 } from 'openapi-types';

/**
 * Get environment variable name for a security scheme
 *
 * @param schemeName Security scheme name
 * @param type Type of security credentials
 * @returns Environment variable name
 */
export function getEnvVarName(
  schemeName: string,
  type:
    | 'API_KEY'
    | 'BEARER_TOKEN'
    | 'BASIC_USERNAME'
    | 'BASIC_PASSWORD'
    | 'OAUTH_CLIENT_ID'
    | 'OAUTH_CLIENT_SECRET'
    | 'OAUTH_TOKEN'
    | 'OAUTH_SCOPES'
    | 'OPENID_TOKEN'
): string {
  const sanitizedName = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `${type}_${sanitizedName}`;
}

/**
 * Generates code for handling API key security
 *
 * @param scheme API key security scheme
 * @returns Generated code
 */
export function generateApiKeySecurityCode(scheme: OpenAPIV3.ApiKeySecurityScheme): string {
  const schemeName = 'schemeName'; // Placeholder, will be replaced in template
  return `
    if (scheme?.type === 'apiKey') {
        const apiKey = process.env[\`${getEnvVarName(schemeName, 'API_KEY')}\`];
        if (apiKey) {
            if (scheme.in === 'header') {
                headers[scheme.name.toLowerCase()] = apiKey;
            }
            else if (scheme.in === 'query') {
                queryParams[scheme.name] = apiKey;
            }
            else if (scheme.in === 'cookie') {
                headers['cookie'] = \`\${scheme.name}=\${apiKey}\${headers['cookie'] ? \`; \${headers['cookie']}\` : ''}\`;
            }
        }
    }`;
}

/**
 * Generates code for handling HTTP security (Bearer/Basic)
 *
 * @returns Generated code
 */
export function generateHttpSecurityCode(): string {
  const schemeName = 'schemeName'; // Placeholder, will be replaced in template
  return `
    else if (scheme?.type === 'http') {
        if (scheme.scheme?.toLowerCase() === 'bearer') {
            const token = process.env[\`${getEnvVarName(schemeName, 'BEARER_TOKEN')}\`];
            if (token) {
                headers['authorization'] = \`Bearer \${token}\`;
            }
        } 
        else if (scheme.scheme?.toLowerCase() === 'basic') {
            const username = process.env[\`${getEnvVarName(schemeName, 'BASIC_USERNAME')}\`];
            const password = process.env[\`${getEnvVarName(schemeName, 'BASIC_PASSWORD')}\`];
            if (username && password) {
                headers['authorization'] = \`Basic \${Buffer.from(\`\${username}:\${password}\`).toString('base64')}\`;
            }
        }
    }`;
}

/**
 * Generates code for OAuth2 token acquisition
 *
 * @returns Generated code for OAuth2 token acquisition
 */
export function generateOAuth2TokenAcquisitionCode(): string {
  return `
/**
 * Type definition for cached OAuth tokens
 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

/**
 * Declare global __oauthTokenCache property for TypeScript
 */
declare global {
    var __oauthTokenCache: Record<string, TokenCacheEntry> | undefined;
}

/**
 * Acquires an OAuth2 token using client credentials flow
 * 
 * @param schemeName Name of the security scheme
 * @param scheme OAuth2 security scheme
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any): Promise<string | null | undefined> {
    try {
        // Check if we have the necessary credentials
        const clientId = process.env[\`${getEnvVarName('schemeName', 'OAUTH_CLIENT_ID')}\`];
        const clientSecret = process.env[\`${getEnvVarName('schemeName', 'OAUTH_CLIENT_SECRET')}\`];
        const scopes = process.env[\`${getEnvVarName('schemeName', 'OAUTH_SCOPES')}\`];
        
        if (!clientId || !clientSecret) {
            console.error(\`Missing client credentials for OAuth2 scheme '\${schemeName}'\`);
            return null;
        }
        
        // Initialize token cache if needed
        if (typeof global.__oauthTokenCache === 'undefined') {
            global.__oauthTokenCache = {};
        }
        
        // Check if we have a cached token
        const cacheKey = \`\${schemeName}_\${clientId}\`;
        const cachedToken = global.__oauthTokenCache[cacheKey];
        const now = Date.now();
        
        if (cachedToken && cachedToken.expiresAt > now) {
            console.error(\`Using cached OAuth2 token for '\${schemeName}' (expires in \${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)\`);
            return cachedToken.token;
        }
        
        // Determine token URL based on flow type
        let tokenUrl = '';
        if (scheme.flows?.clientCredentials?.tokenUrl) {
            tokenUrl = scheme.flows.clientCredentials.tokenUrl;
            console.error(\`Using client credentials flow for '\${schemeName}'\`);
        } else if (scheme.flows?.password?.tokenUrl) {
            tokenUrl = scheme.flows.password.tokenUrl;
            console.error(\`Using password flow for '\${schemeName}'\`);
        } else {
            console.error(\`No supported OAuth2 flow found for '\${schemeName}'\`);
            return null;
        }
        
        // Prepare the token request
        let formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        formData.append('client_id', clientId);
        formData.append('client_secret', clientSecret);
        
        // Add scopes if specified
        if (scopes) {
            formData.append('scope', scopes);
        }
        
        console.error(\`Requesting OAuth2 token from \${tokenUrl}\`);
        
        // Make the token request
        const response = await axios({
            method: 'POST',
            url: tokenUrl,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': \`Basic \${Buffer.from(\`\${clientId}:\${clientSecret}\`).toString('base64')}\`
            },
            data: formData.toString()
        });
        
        // Process the response
        if (response.data?.access_token) {
            const token = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600; // Default to 1 hour
            
            // Cache the token
            global.__oauthTokenCache[cacheKey] = {
                token,
                expiresAt: now + (expiresIn * 1000) - 60000 // Expire 1 minute early
            };
            
            console.error(\`Successfully acquired OAuth2 token for '\${schemeName}' (expires in \${expiresIn} seconds)\`);
            return token;
        } else {
            console.error(\`Failed to acquire OAuth2 token for '\${schemeName}': No access_token in response\`);
            return null;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(\`Error acquiring OAuth2 token for '\${schemeName}':\`, errorMessage);
        return null;
    }
}
`;
}

/**
 * Generates code for executing API tools with security handling
 *
 * @param securitySchemes Security schemes from OpenAPI spec
 * @returns Generated code for the execute API tool function
 */
export function generateExecuteApiToolFunction(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  // Generate OAuth2 token acquisition function
  const oauth2TokenAcquisitionCode = generateOAuth2TokenAcquisitionCode();

  // Generate security handling code for checking, applying security
  const securityCode = `
    // Apply security requirements if available
    // Security requirements use OR between array items and AND within each object
    const appliedSecurity = definition.securityRequirements?.find(req => {
        // Try each security requirement (combined with OR)
        return Object.entries(req).every(([schemeName, scopesArray]) => {
            const scheme = allSecuritySchemes[schemeName];
            if (!scheme) return false;
            
            // API Key security (header, query, cookie)
            if (scheme.type === 'apiKey') {
                return !!process.env[\`API_KEY_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
            }
            
            // HTTP security (basic, bearer)
            if (scheme.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    return !!process.env[\`BEARER_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                }
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    return !!process.env[\`BASIC_USERNAME_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`] && 
                           !!process.env[\`BASIC_PASSWORD_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                }
            }
            
            // OAuth2 security
            if (scheme.type === 'oauth2') {
                // Check for pre-existing token
                if (process.env[\`OAUTH_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`]) {
                    return true;
                }
                
                // Check for client credentials for auto-acquisition
                if (process.env[\`OAUTH_CLIENT_ID_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`] &&
                    process.env[\`OAUTH_CLIENT_SECRET_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`]) {
                    // Verify we have a supported flow
                    if (scheme.flows?.clientCredentials || scheme.flows?.password) {
                        return true;
                    }
                }
                
                return false;
            }
            
            // OpenID Connect
            if (scheme.type === 'openIdConnect') {
                return !!process.env[\`OPENID_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
            }
            
            return false;
        });
    });

    // If we found matching security scheme(s), apply them
    if (appliedSecurity) {
        // Apply each security scheme from this requirement (combined with AND)
        for (const [schemeName, scopesArray] of Object.entries(appliedSecurity)) {
            const scheme = allSecuritySchemes[schemeName];
            
            // API Key security
            if (scheme?.type === 'apiKey') {
                const apiKey = process.env[\`API_KEY_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                if (apiKey) {
                    if (scheme.in === 'header') {
                        headers[scheme.name.toLowerCase()] = apiKey;
                        console.error(\`Applied API key '\${schemeName}' in header '\${scheme.name}'\`);
                    }
                    else if (scheme.in === 'query') {
                        queryParams[scheme.name] = apiKey;
                        console.error(\`Applied API key '\${schemeName}' in query parameter '\${scheme.name}'\`);
                    }
                    else if (scheme.in === 'cookie') {
                        // Add the cookie, preserving other cookies if they exist
                        headers['cookie'] = \`\${scheme.name}=\${apiKey}\${headers['cookie'] ? \`; \${headers['cookie']}\` : ''}\`;
                        console.error(\`Applied API key '\${schemeName}' in cookie '\${scheme.name}'\`);
                    }
                }
            } 
            // HTTP security (Bearer or Basic)
            else if (scheme?.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    const token = process.env[\`BEARER_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                    if (token) {
                        headers['authorization'] = \`Bearer \${token}\`;
                        console.error(\`Applied Bearer token for '\${schemeName}'\`);
                    }
                } 
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    const username = process.env[\`BASIC_USERNAME_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                    const password = process.env[\`BASIC_PASSWORD_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                    if (username && password) {
                        headers['authorization'] = \`Basic \${Buffer.from(\`\${username}:\${password}\`).toString('base64')}\`;
                        console.error(\`Applied Basic authentication for '\${schemeName}'\`);
                    }
                }
            }
            // OAuth2 security
            else if (scheme?.type === 'oauth2') {
                // First try to use a pre-provided token
                let token = process.env[\`OAUTH_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                
                // If no token but we have client credentials, try to acquire a token
                if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
                    console.error(\`Attempting to acquire OAuth token for '\${schemeName}'\`);
                    token = (await acquireOAuth2Token(schemeName, scheme)) ?? '';
                }
                
                // Apply token if available
                if (token) {
                    headers['authorization'] = \`Bearer \${token}\`;
                    console.error(\`Applied OAuth2 token for '\${schemeName}'\`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(\`Requested scopes: \${scopes.join(', ')}\`);
                    }
                }
            }
            // OpenID Connect
            else if (scheme?.type === 'openIdConnect') {
                const token = process.env[\`OPENID_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];
                if (token) {
                    headers['authorization'] = \`Bearer \${token}\`;
                    console.error(\`Applied OpenID Connect token for '\${schemeName}'\`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(\`Requested scopes: \${scopes.join(', ')}\`);
                    }
                }
            }
        }
    } 
    // Log warning if security is required but not available
    else if (definition.securityRequirements?.length > 0) {
        // First generate a more readable representation of the security requirements
        const securityRequirementsString = definition.securityRequirements
            .map(req => {
                const parts = Object.entries(req)
                    .map(([name, scopesArray]) => {
                        const scopes = scopesArray as string[];
                        if (scopes.length === 0) return name;
                        return \`\${name} (scopes: \${scopes.join(', ')})\`;
                    })
                    .join(' AND ');
                return \`[\${parts}]\`;
            })
            .join(' OR ');
            
        console.warn(\`Tool '\${toolName}' requires security: \${securityRequirementsString}, but no suitable credentials found.\`);
    }
    `;

  // Generate complete execute API tool function
  return `
${oauth2TokenAcquisitionCode}

/**
 * Executes an API tool with the provided arguments
 * 
 * @param toolName Name of the tool to execute
 * @param definition Tool definition
 * @param toolArgs Arguments provided by the user
 * @param allSecuritySchemes Security schemes from the OpenAPI spec
 * @returns Call tool result
 */
async function executeApiTool(
    toolName: string,
    definition: McpToolDefinition,
    toolArgs: JsonObject,
    allSecuritySchemes: Record<string, any>
): Promise<CallToolResult> {
  try {
    // Validate arguments against the input schema
    let validatedArgs: JsonObject;
    try {
        const zodSchema = getZodSchemaFromJsonSchema(definition.inputSchema, toolName);
        const argsToParse = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
        validatedArgs = zodSchema.parse(argsToParse);
    } catch (error: unknown) {
        if (error instanceof ZodError) {
            const validationErrorMessage = \`Invalid arguments for tool '\${toolName}': \${error.errors.map(e => \`\${e.path.join('.')} (\${e.code}): \${e.message}\`).join(', ')}\`;
            return { content: [{ type: 'text', text: validationErrorMessage }] };
        } else {
             const errorMessage = error instanceof Error ? error.message : String(error);
             return { content: [{ type: 'text', text: \`Internal error during validation setup: \${errorMessage}\` }] };
        }
    }

    // Prepare URL, query parameters, headers, and request body
    let urlPath = definition.pathTemplate;
    const queryParams: Record<string, any> = {};
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let requestBodyData: any = undefined;

    // Apply parameters to the URL path, query, or headers
    definition.executionParameters.forEach((param) => {
        const value = validatedArgs[param.name];
        if (typeof value !== 'undefined' && value !== null) {
            if (param.in === 'path') {
                urlPath = urlPath.replace(\`{\${param.name}}\`, encodeURIComponent(String(value)));
            }
            else if (param.in === 'query') {
                queryParams[param.name] = value;
            }
            else if (param.in === 'header') {
                headers[param.name.toLowerCase()] = String(value);
            }
        }
    });

    // Ensure all path parameters are resolved
    if (urlPath.includes('{')) {
        throw new Error(\`Failed to resolve path parameters: \${urlPath}\`);
    }
    
    // Construct the full URL
    const requestUrl = API_BASE_URL ? \`\${API_BASE_URL}\${urlPath}\` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
        requestBodyData = validatedArgs['requestBody'];
        headers['content-type'] = definition.requestBodyContentType;
    }

${securityCode}

    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(), 
      url: requestUrl, 
      params: queryParams, 
      headers: headers,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    // Log request info to stderr (doesn't affect MCP output)
    console.error(\`Executing tool "\${toolName}": \${config.method} \${config.url}\`);
    
    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    const contentType = response.headers['content-type']?.toLowerCase() || '';
    
    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
         try { 
             responseText = JSON.stringify(response.data, null, 2); 
         } catch (e) { 
             responseText = "[Stringify Error]"; 
         }
    } 
    // Handle string responses
    else if (typeof response.data === 'string') { 
         responseText = response.data; 
    }
    // Handle other response types
    else if (response.data !== undefined && response.data !== null) { 
         responseText = String(response.data); 
    }
    // Handle empty responses
    else { 
         responseText = \`(Status: \${response.status} - No body content)\`; 
    }
    
    // Return formatted response
    return { 
        content: [ 
            { 
                type: "text", 
                text: \`API Response (Status: \${response.status}):\\n\${responseText}\` 
            } 
        ], 
    };

  } catch (error: unknown) {
    // Handle errors during execution
    let errorMessage: string;
    
    // Format Axios errors specially
    if (axios.isAxiosError(error)) { 
        errorMessage = formatApiError(error); 
    }
    // Handle standard errors
    else if (error instanceof Error) { 
        errorMessage = error.message; 
    }
    // Handle unexpected error types
    else { 
        errorMessage = 'Unexpected error: ' + String(error); 
    }
    
    // Log error to stderr
    console.error(\`Error during execution of tool '\${toolName}':\`, errorMessage);
    
    // Return error message to client
    return { content: [{ type: "text", text: errorMessage }] };
  }
}
`;
}

/**
 * Gets security scheme documentation for README
 *
 * @param securitySchemes Security schemes from OpenAPI spec
 * @returns Documentation for security schemes
 */
export function getSecuritySchemesDocs(
  securitySchemes?: OpenAPIV3.ComponentsObject['securitySchemes']
): string {
  if (!securitySchemes) return 'No security schemes defined in the OpenAPI spec.';

  let docs = '';

  for (const [name, schemeOrRef] of Object.entries(securitySchemes)) {
    if ('$ref' in schemeOrRef) {
      docs += `- \`${name}\`: Referenced security scheme (reference not resolved)\n`;
      continue;
    }

    const scheme = schemeOrRef;

    if (scheme.type === 'apiKey') {
      const envVar = getEnvVarName(name, 'API_KEY');
      docs += `- \`${envVar}\`: API key for ${scheme.name} (in ${scheme.in})\n`;
    } else if (scheme.type === 'http') {
      if (scheme.scheme?.toLowerCase() === 'bearer') {
        const envVar = getEnvVarName(name, 'BEARER_TOKEN');
        docs += `- \`${envVar}\`: Bearer token for authentication\n`;
      } else if (scheme.scheme?.toLowerCase() === 'basic') {
        const usernameEnvVar = getEnvVarName(name, 'BASIC_USERNAME');
        const passwordEnvVar = getEnvVarName(name, 'BASIC_PASSWORD');
        docs += `- \`${usernameEnvVar}\`: Username for Basic authentication\n`;
        docs += `- \`${passwordEnvVar}\`: Password for Basic authentication\n`;
      }
    } else if (scheme.type === 'oauth2') {
      const flowTypes = scheme.flows ? Object.keys(scheme.flows) : ['unknown'];

      // Add client credentials for OAuth2
      const clientIdVar = getEnvVarName(name, 'OAUTH_CLIENT_ID');
      const clientSecretVar = getEnvVarName(name, 'OAUTH_CLIENT_SECRET');
      docs += `- \`${clientIdVar}\`: Client ID for OAuth2 authentication (${flowTypes.join(', ')} flow)\n`;
      docs += `- \`${clientSecretVar}\`: Client secret for OAuth2 authentication\n`;

      // Add OAuth token for manual setting
      const tokenVar = getEnvVarName(name, 'OAUTH_TOKEN');
      docs += `- \`${tokenVar}\`: OAuth2 token (if not using automatic token acquisition)\n`;

      // Add scopes env var
      const scopesVar = getEnvVarName(name, 'OAUTH_SCOPES');
      docs += `- \`${scopesVar}\`: Space-separated list of OAuth2 scopes to request\n`;

      // If available, list flow-specific details
      if (scheme.flows?.clientCredentials) {
        docs += `  Client Credentials Flow Token URL: ${scheme.flows.clientCredentials.tokenUrl}\n`;

        // List available scopes if defined
        if (
          scheme.flows.clientCredentials.scopes &&
          Object.keys(scheme.flows.clientCredentials.scopes).length > 0
        ) {
          docs += `  Available scopes:\n`;
          for (const [scope, description] of Object.entries(
            scheme.flows.clientCredentials.scopes
          )) {
            docs += `  - \`${scope}\`: ${description}\n`;
          }
        }
      }
    } else if (scheme.type === 'openIdConnect') {
      const tokenVar = getEnvVarName(name, 'OPENID_TOKEN');
      docs += `- \`${tokenVar}\`: OpenID Connect token\n`;
      if (scheme.openIdConnectUrl) {
        docs += `  OpenID Connect Discovery URL: ${scheme.openIdConnectUrl}\n`;
      }
    }
  }

  return docs;
}
