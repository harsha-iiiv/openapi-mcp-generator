#!/usr/bin/env node
/**
 * MCP Server generated from OpenAPI spec for swagger-petstore---openapi-3-0 v1.0.27
 * Generated on: 2026-10-24T18:18:25.952Z
 */

import { existsSync } from 'node:fs';

// Load environment variables from .env in the working directory, when present.
// Node's built-in loader never overrides variables that are already set and,
// unlike dotenv 17+, never writes to stdout (which would corrupt stdio servers).
if (existsSync('.env')) process.loadEnvFile('.env');

import { Server, ProtocolError, ProtocolErrorCode, type Tool, type CallToolResult, type CallToolRequest } from "@modelcontextprotocol/server";
import { setupStreamableHttpServer } from "./streamable-http.js";

import { Validator, type OutputUnit } from '@cfworker/json-schema';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

/**
 * Type definition for JSON objects
 */
type JsonObject = Record<string, any>;

/**
 * Interface for MCP Tool Definition
 */
interface McpToolDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: any;
    method: string;
    pathTemplate: string;
    executionParameters: { name: string, in: string }[];
    requestBodyContentType?: string;
    serverUrl?: string;
    securityRequirements: any[];
    tags?: string[];
    deprecated?: boolean;
    outputSchema?: any;
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/**
 * Server configuration
 */
export const SERVER_NAME = "swagger-petstore---openapi-3-0";
export const SERVER_VERSION = "1.0.27";
// Instructions sent to clients, from the OpenAPI info.description.
export const SERVER_INSTRUCTIONS = "This is a sample Pet Store Server based on the OpenAPI 3.0 specification.  You can find out more about\nSwagger at [https://swagger.io](https://swagger.io). In the third iteration of the pet store, we've switched to the design first approach!\nYou can now help us improve the API whether it's by making changes to the definition itself or to the code.\nThat way, with time, we can improve the API in general, and expose some of the new features in OAS3.\n\nSome useful links:\n- [The Pet Store repository](https://github.com/swagger-api/swagger-petstore)\n- [The source API definition for the Pet Store](https://github.com/swagger-api/swagger-petstore/blob/master/src/main/resources/openapi.yaml)";
// Base URL for the API, can be set via environment variable or determined from OpenAPI spec
export const API_BASE_URL = process.env.API_BASE_URL || "https://petstore3.swagger.io/api/v3";
console.error("API_BASE_URL is set to:", API_BASE_URL);

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([

  ["updatePet", {
    name: "updatePet",
    title: "Update an existing pet.",
    description: `Update an existing pet by Id.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"required":["name","photoUrls"],"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"name":{"type":"string","examples":["doggie"]},"category":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[1]},"name":{"type":"string","examples":["Dogs"]}}},"photoUrls":{"type":"array","items":{"type":"string"}},"tags":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer","format":"int64"},"name":{"type":"string"}}}},"status":{"type":"string","description":"pet status in the store","enum":["available","pending","sold"]}},"description":"Update an existent pet in the store"}},"required":["requestBody"]},
    method: "put",
    pathTemplate: "/pet",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}
  }],
  ["addPet", {
    name: "addPet",
    title: "Add a new pet to the store.",
    description: `Add a new pet to the store.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"required":["name","photoUrls"],"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"name":{"type":"string","examples":["doggie"]},"category":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[1]},"name":{"type":"string","examples":["Dogs"]}}},"photoUrls":{"type":"array","items":{"type":"string"}},"tags":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer","format":"int64"},"name":{"type":"string"}}}},"status":{"type":"string","description":"pet status in the store","enum":["available","pending","sold"]}},"description":"Create a new pet in the store"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pet",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["findPetsByStatus", {
    name: "findPetsByStatus",
    title: "Finds Pets by status.",
    description: `Multiple status values can be provided with comma separated strings.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"status":{"type":"string","default":"available","enum":["available","pending","sold"],"description":"Status values that need to be considered for filter"}},"required":["status"]},
    method: "get",
    pathTemplate: "/pet/findByStatus",
    executionParameters: [{"name":"status","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["findPetsByTags", {
    name: "findPetsByTags",
    title: "Finds Pets by tags.",
    description: `Multiple tags can be provided with comma separated strings. Use tag1, tag2, tag3 for testing.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"},"description":"Tags to filter by"}},"required":["tags"]},
    method: "get",
    pathTemplate: "/pet/findByTags",
    executionParameters: [{"name":"tags","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["getPetById", {
    name: "getPetById",
    title: "Find pet by ID.",
    description: `Returns a single pet.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"petId":{"type":"integer","format":"int64","description":"ID of pet to return"}},"required":["petId"]},
    method: "get",
    pathTemplate: "/pet/{petId}",
    executionParameters: [{"name":"petId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"api_key":[]},{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["updatePetWithForm", {
    name: "updatePetWithForm",
    title: "Updates a pet in the store with form data.",
    description: `Updates a pet resource based on the form data.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"petId":{"type":"integer","format":"int64","description":"ID of pet that needs to be updated"},"name":{"type":"string","description":"Name of pet that needs to be updated"},"status":{"type":"string","description":"Status of pet that needs to be updated"}},"required":["petId"]},
    method: "post",
    pathTemplate: "/pet/{petId}",
    executionParameters: [{"name":"petId","in":"path"},{"name":"name","in":"query"},{"name":"status","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["deletePet", {
    name: "deletePet",
    title: "Deletes a pet.",
    description: `Delete a pet.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"api_key":{"type":"string"},"petId":{"type":"integer","format":"int64","description":"Pet id to delete"}},"required":["petId"]},
    method: "delete",
    pathTemplate: "/pet/{petId}",
    executionParameters: [{"name":"api_key","in":"header"},{"name":"petId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}
  }],
  ["uploadFile", {
    name: "uploadFile",
    title: "Uploads an image.",
    description: `Upload image of the pet.
(Tags: pet)`,
    inputSchema: {"type":"object","properties":{"petId":{"type":"integer","format":"int64","description":"ID of pet to update"},"additionalMetadata":{"type":"string","description":"Additional Metadata"},"requestBody":{"type":"string","description":"Request body (content type: application/octet-stream)"}},"required":["petId"]},
    method: "post",
    pathTemplate: "/pet/{petId}/uploadImage",
    executionParameters: [{"name":"petId","in":"path"},{"name":"additionalMetadata","in":"query"}],
    requestBodyContentType: "application/octet-stream",
    securityRequirements: [{"petstore_auth":["write:pets","read:pets"]}],
    tags: ["pet"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["getInventory", {
    name: "getInventory",
    title: "Returns pet inventories by status.",
    description: `Returns a map of status codes to quantities.
(Tags: store)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/store/inventory",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"api_key":[]}],
    tags: ["store"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["placeOrder", {
    name: "placeOrder",
    title: "Place an order for a pet.",
    description: `Place a new order in the store.
(Tags: store)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"petId":{"type":"integer","format":"int64","examples":[198772]},"quantity":{"type":"integer","format":"int32","examples":[7]},"shipDate":{"type":"string","format":"date-time"},"status":{"type":"string","description":"Order Status","enum":["placed","approved","delivered"],"examples":["approved"]},"complete":{"type":"boolean"}},"description":"The JSON request body."}}},
    method: "post",
    pathTemplate: "/store/order",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [],
    tags: ["store"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["getOrderById", {
    name: "getOrderById",
    title: "Find purchase order by ID.",
    description: `For valid response try integer IDs with value <= 5 or > 10. Other values will generate exceptions.
(Tags: store)`,
    inputSchema: {"type":"object","properties":{"orderId":{"type":"integer","format":"int64","description":"ID of order that needs to be fetched"}},"required":["orderId"]},
    method: "get",
    pathTemplate: "/store/order/{orderId}",
    executionParameters: [{"name":"orderId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["store"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["deleteOrder", {
    name: "deleteOrder",
    title: "Delete purchase order by identifier.",
    description: `For valid response try integer IDs with value < 1000. Anything above 1000 or non-integers will generate API errors.
(Tags: store)`,
    inputSchema: {"type":"object","properties":{"orderId":{"type":"integer","format":"int64","description":"ID of the order that needs to be deleted"}},"required":["orderId"]},
    method: "delete",
    pathTemplate: "/store/order/{orderId}",
    executionParameters: [{"name":"orderId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["store"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}
  }],
  ["createUser", {
    name: "createUser",
    title: "Create user.",
    description: `This can only be done by the logged in user.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"username":{"type":"string","examples":["theUser"]},"firstName":{"type":"string","examples":["John"]},"lastName":{"type":"string","examples":["James"]},"email":{"type":"string","examples":["john@email.com"]},"password":{"type":"string","examples":["12345"]},"phone":{"type":"string","examples":["12345"]},"userStatus":{"type":"integer","description":"User Status","format":"int32","examples":[1]}},"description":"Created user object"}}},
    method: "post",
    pathTemplate: "/user",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["createUsersWithListInput", {
    name: "createUsersWithListInput",
    title: "Creates list of users with given input array.",
    description: `Creates list of users with given input array.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"username":{"type":"string","examples":["theUser"]},"firstName":{"type":"string","examples":["John"]},"lastName":{"type":"string","examples":["James"]},"email":{"type":"string","examples":["john@email.com"]},"password":{"type":"string","examples":["12345"]},"phone":{"type":"string","examples":["12345"]},"userStatus":{"type":"integer","description":"User Status","format":"int32","examples":[1]}}},"description":"The JSON request body."}}},
    method: "post",
    pathTemplate: "/user/createWithList",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true}
  }],
  ["loginUser", {
    name: "loginUser",
    title: "Logs user into the system.",
    description: `Log into the system.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"username":{"type":"string","description":"The user name for login"},"password":{"type":"string","description":"The password for login in clear text"}}},
    method: "get",
    pathTemplate: "/user/login",
    executionParameters: [{"name":"username","in":"query"},{"name":"password","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["logoutUser", {
    name: "logoutUser",
    title: "Logs out current logged in user session.",
    description: `Log user out of the system.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/user/logout",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["getUserByName", {
    name: "getUserByName",
    title: "Get user by user name.",
    description: `Get user detail based on username.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"username":{"type":"string","description":"The name that needs to be fetched. Use user1 for testing"}},"required":["username"]},
    method: "get",
    pathTemplate: "/user/{username}",
    executionParameters: [{"name":"username","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":true,"openWorldHint":true}
  }],
  ["updateUser", {
    name: "updateUser",
    title: "Update user resource.",
    description: `This can only be done by the logged in user.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"username":{"type":"string","description":"name that need to be deleted"},"requestBody":{"type":"object","properties":{"id":{"type":"integer","format":"int64","examples":[10]},"username":{"type":"string","examples":["theUser"]},"firstName":{"type":"string","examples":["John"]},"lastName":{"type":"string","examples":["James"]},"email":{"type":"string","examples":["john@email.com"]},"password":{"type":"string","examples":["12345"]},"phone":{"type":"string","examples":["12345"]},"userStatus":{"type":"integer","description":"User Status","format":"int32","examples":[1]}},"description":"Update an existent user in the store"}},"required":["username"]},
    method: "put",
    pathTemplate: "/user/{username}",
    executionParameters: [{"name":"username","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}
  }],
  ["deleteUser", {
    name: "deleteUser",
    title: "Delete user resource.",
    description: `This can only be done by the logged in user.
(Tags: user)`,
    inputSchema: {"type":"object","properties":{"username":{"type":"string","description":"The name that needs to be deleted"}},"required":["username"]},
    method: "delete",
    pathTemplate: "/user/{username}",
    executionParameters: [{"name":"username","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [],
    tags: ["user"],
    deprecated: false,
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}
  }],
]);

/**
 * Security schemes from the OpenAPI spec
 */
const securitySchemes =   {
    "petstore_auth": {
      "type": "oauth2",
      "flows": {
        "implicit": {
          "authorizationUrl": "https://petstore3.swagger.io/oauth/authorize",
          "scopes": {
            "write:pets": "modify pets in your account",
            "read:pets": "read your pets"
          }
        }
      }
    },
    "api_key": {
      "type": "apiKey",
      "name": "api_key",
      "in": "header"
    }
  };

/** Compiled JSON Schema validators, created on first use and cached by key. */
const schemaValidators = new Map<string, Validator>();

/**
 * Returns the cached validator for a schema (JSON Schema 2020-12, all errors).
 * The validator gets its own copy because compiling annotates the schema object.
 */
function getSchemaValidator(key: string, schema: unknown): Validator {
    let validator = schemaValidators.get(key);
    if (!validator) {
        const compiled = typeof schema === 'boolean' ? schema : structuredClone(schema ?? {});
        validator = new Validator(compiled as any, '2020-12', false);
        schemaValidators.set(key, validator);
    }
    return validator;
}

/** Keywords whose errors only repeat that a nested value failed. */
const SUMMARY_KEYWORDS = new Set([
    'properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
    'items', 'prefixItems', 'additionalItems', 'unevaluatedItems', 'contains',
    'dependentSchemas', 'propertyNames', '$ref', '$recursiveRef', '$dynamicRef',
]);

/**
 * Formats validation errors as "<location>: <message>" joined with "; ",
 * dropping summaries that only repeat a more specific error.
 */
function formatSchemaErrors(errors: OutputUnit[]): string {
    const location = (pointer: string) => (pointer === '#' || pointer === '' ? '(root)' : pointer.replace(/^#/, ''));
    const isUnder = (pointer: string, parent: string) => pointer === parent || pointer.startsWith(parent + '/');
    const specific = errors.filter((e) => !SUMMARY_KEYWORDS.has(e.keyword) && e.keyword !== 'false');
    const kept = errors.filter((e) => {
        if (SUMMARY_KEYWORDS.has(e.keyword)) {
            return !specific.some((other) => isUnder(other.instanceLocation, e.instanceLocation));
        }
        if (e.keyword === 'false') {
            // "false" schemas reject any value, e.g. a property additionalProperties forbids.
            return !specific.some((other) => other.instanceLocation === e.instanceLocation);
        }
        return true;
    });
    const messages: string[] = [];
    for (const e of kept.length > 0 ? kept : errors) {
        const text = e.keyword === 'false' ? 'Not allowed by the schema.' : e.error;
        const message = `${location(e.instanceLocation)}: ${text}`;
        if (!messages.includes(message)) messages.push(message);
    }
    return messages.join('; ');
}

/**
 * Validates a structured result against the tool's declared output schema.
 * Returns a readable error message, or null when it conforms.
 */
function validateToolOutput(toolName: string, outputSchema: unknown, value: unknown): string | null {
    const result = getSchemaValidator(`output:${toolName}`, outputSchema).validate(value);
    return result.valid ? null : formatSchemaErrors(result.errors);
}

/**
 * Validates tool arguments against the tool's input schema. Returns a readable
 * error message, or null when they are valid. Arguments are never modified:
 * schema defaults are not injected.
 */
function validateToolArguments(toolName: string, inputSchema: unknown, args: unknown): string | null {
    const result = getSchemaValidator(`input:${toolName}`, inputSchema).validate(args);
    return result.valid ? null : `Invalid arguments for tool '${toolName}': ${formatSchemaErrors(result.errors)}`;
}

/**
 * Base URL for one operation. Without an operation or path-item server this is
 * the configured base URL (API_BASE_URL, else the spec's root server). An
 * absolute operation/path-item server is used as is, even when API_BASE_URL is
 * set; a relative one resolves against the configured base URL ("v2" appends a
 * segment, "/v2" replaces the path).
 */
function resolveOperationBaseUrl(serverUrl: string | undefined, baseUrl: string): string {
    if (!serverUrl) return baseUrl;
    const isAbsolute = (url: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    if (isAbsolute(serverUrl)) return serverUrl.replace(/\/+$/, '');
    if (isAbsolute(baseUrl)) {
        return new URL(serverUrl, baseUrl.replace(/\/*$/, '/')).href.replace(/\/+$/, '');
    }
    // Both relative: join the paths.
    if (serverUrl.startsWith('/')) return serverUrl.replace(/\/+$/, '');
    return `${baseUrl.replace(/\/+$/, '')}/${serverUrl}`.replace(/\/+$/, '');
}

/**
 * Creates a fresh MCP server instance with the tool handlers registered.
 * Transports call this once per request, connection or era probe: an SDK server
 * instance serves exactly one transport, and the same factory backs both the
 * 2026-07-28 and 2025-era protocols.
 */
export function createServer(): Server {
  const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

server.setRequestHandler('tools/list', async () => {
  const toolsForClient: Tool[] = Array.from(toolDefinitionMap.values()).map(def => ({
    name: def.name,
    ...(def.title !== undefined && { title: def.title }),
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema !== undefined && { outputSchema: def.outputSchema }),
    annotations: def.annotations
  }));
  return { tools: toolsForClient };
});


server.setRequestHandler('tools/call', async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name: toolName, arguments: toolArgs } = request.params;
  const toolDefinition = toolDefinitionMap.get(toolName);
  if (!toolDefinition) {
    // An unknown tool is a protocol error (JSON-RPC -32602), not a tool result.
    console.error(`Error: Unknown tool requested: ${toolName}`);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
  }
  return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, securitySchemes);
});

  return server;
}


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
 * @param requiredScopes Scopes declared by the operation's security requirement
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any, requiredScopes: string[] = []): Promise<string | null | undefined> {
    try {
        // Check if we have the necessary credentials (resolved per-scheme at runtime)
        const clientId = process.env[`OAUTH_CLIENT_ID_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        const clientSecret = process.env[`OAUTH_CLIENT_SECRET_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        const configuredScopes = process.env[`OAUTH_SCOPES_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        // An explicit OAUTH_SCOPES_<SCHEME> wins; otherwise request the scopes the
        // operation's security requirement declares (issue #81).
        const scopes = configuredScopes || (requiredScopes.length > 0 ? requiredScopes.join(' ') : '');

        if (!clientId || !clientSecret) {
            console.error(`Missing client credentials for OAuth2 scheme '${schemeName}'`);
            return null;
        }
        
        // Initialize token cache if needed
        if (typeof global.__oauthTokenCache === 'undefined') {
            global.__oauthTokenCache = {};
        }
        
        // Check if we have a cached token
        // Cache per scope set so a narrower token is never reused for a wider requirement.
        const cacheKey = `${schemeName}_${clientId}_${scopes}`;
        const cachedToken = global.__oauthTokenCache[cacheKey];
        const now = Date.now();
        
        if (cachedToken && cachedToken.expiresAt > now) {
            console.error(`Using cached OAuth2 token for '${schemeName}' (expires in ${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)`);
            return cachedToken.token;
        }
        
        // Determine token URL based on flow type
        let tokenUrl = '';
        if (scheme.flows?.clientCredentials?.tokenUrl) {
            tokenUrl = scheme.flows.clientCredentials.tokenUrl;
            console.error(`Using client credentials flow for '${schemeName}'`);
        } else if (scheme.flows?.password?.tokenUrl) {
            tokenUrl = scheme.flows.password.tokenUrl;
            console.error(`Using password flow for '${schemeName}'`);
        } else {
            console.error(`No supported OAuth2 flow found for '${schemeName}'`);
            return null;
        }
        
        // Prepare the token request
        let formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        
        // Add scopes if specified
        if (scopes) {
            formData.append('scope', scopes);
        }

        console.error(`Requesting OAuth2 token for '${schemeName}'`);

        // Make the token request
        const response = await axios({
            method: 'POST',
            url: tokenUrl,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
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
            
            console.error(`Successfully acquired OAuth2 token for '${schemeName}' (expires in ${expiresIn} seconds)`);
            return token;
        } else {
            console.error(`Failed to acquire OAuth2 token for '${schemeName}': No access_token in response`);
            return null;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error acquiring OAuth2 token for '${schemeName}':`, errorMessage);
        return null;
    }
}

/**
 * A credential to place on the upstream request for one security scheme.
 */
interface UpstreamCredential {
    schemeName: string;
    location: 'header' | 'query' | 'cookie';
    name: string;
    value: string;
    description: string;
}

/**
 * Outcome of resolving a tool's OpenAPI security requirements.
 */
type SecurityResolution =
    | { status: 'none' }
    | { status: 'optional' }
    | { status: 'applied'; credentials: UpstreamCredential[] }
    | { status: 'unsatisfied'; summary: string };

/**
 * Reads a per-scheme credential from the environment, e.g. API_KEY_PETSTORE_AUTH.
 */
function getSchemeEnv(prefix: string, schemeName: string): string | undefined {
    return process.env[`${prefix}_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
}

/**
 * Resolves the credential for one security scheme, or null when it is not
 * configured or cannot be obtained (for example, an OAuth2 token request failed).
 */
async function resolveSchemeCredential(
    schemeName: string,
    scheme: any,
    scopes: string[]
): Promise<UpstreamCredential | null> {
    if (!scheme) return null;

    // API Key security (header, query, cookie)
    if (scheme.type === 'apiKey') {
        const apiKey = getSchemeEnv('API_KEY', schemeName);
        if (!apiKey || !scheme.name) return null;
        const location: UpstreamCredential['location'] =
            scheme.in === 'query' ? 'query' : scheme.in === 'cookie' ? 'cookie' : 'header';
        return {
            schemeName,
            location,
            name: location === 'header' ? String(scheme.name).toLowerCase() : String(scheme.name),
            value: apiKey,
            description: `API key '${schemeName}' in ${location} '${scheme.name}'`,
        };
    }

    // HTTP security (bearer, basic)
    if (scheme.type === 'http') {
        const httpScheme = String(scheme.scheme ?? '').toLowerCase();
        if (httpScheme === 'bearer') {
            const token = getSchemeEnv('BEARER_TOKEN', schemeName);
            if (!token) return null;
            return {
                schemeName,
                location: 'header',
                name: 'authorization',
                value: `Bearer ${token}`,
                description: `Bearer token for '${schemeName}'`,
            };
        }
        if (httpScheme === 'basic') {
            const username = getSchemeEnv('BASIC_USERNAME', schemeName);
            // Empty password is valid per RFC 7617 (issue #66); only username is required.
            if (username == null) return null;
            const password = getSchemeEnv('BASIC_PASSWORD', schemeName) ?? '';
            return {
                schemeName,
                location: 'header',
                name: 'authorization',
                value: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
                description: `Basic authentication for '${schemeName}'`,
            };
        }
        return null;
    }

    // OAuth2: a pre-provided token, or client credentials for automatic acquisition
    if (scheme.type === 'oauth2') {
        let token = getSchemeEnv('OAUTH_TOKEN', schemeName);
        if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
            token = (await acquireOAuth2Token(schemeName, scheme, scopes)) ?? undefined;
        }
        if (!token) return null;
        return {
            schemeName,
            location: 'header',
            name: 'authorization',
            value: `Bearer ${token}`,
            description: `OAuth2 token for '${schemeName}'${scopes.length > 0 ? ` (scopes: ${scopes.join(', ')})` : ''}`,
        };
    }

    // OpenID Connect
    if (scheme.type === 'openIdConnect') {
        const token = getSchemeEnv('OPENID_TOKEN', schemeName);
        if (!token) return null;
        return {
            schemeName,
            location: 'header',
            name: 'authorization',
            value: `Bearer ${token}`,
            description: `OpenID Connect token for '${schemeName}'`,
        };
    }

    return null;
}

/**
 * The request header a scheme's credential travels in, when it travels in one.
 */
function credentialHeaderName(scheme: any): string | undefined {
    if (!scheme) return undefined;
    if (scheme.type === 'apiKey') {
        return scheme.in === 'query' || scheme.in === 'cookie' || !scheme.name
            ? undefined
            : String(scheme.name).toLowerCase();
    }
    if (scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
        return 'authorization';
    }
    return undefined;
}

/**
 * True when two credentials from one requirement would overwrite each other
 * (for example, two schemes that both need the Authorization header).
 */
function hasConflictingCredentials(credentials: UpstreamCredential[]): boolean {
    const seen = new Set<string>();
    for (const credential of credentials) {
        // Several cookies combine into one Cookie header, so they never conflict.
        if (credential.location === 'cookie') continue;
        const key = `${credential.location}:${credential.name.toLowerCase()}`;
        if (seen.has(key)) return true;
        seen.add(key);
    }
    return false;
}

/**
 * Places one resolved credential on the outgoing request.
 */
function applyUpstreamCredential(
    credential: UpstreamCredential,
    headers: Record<string, string>,
    queryParams: Record<string, any>
): void {
    if (credential.location === 'query') {
        queryParams[credential.name] = credential.value;
    } else if (credential.location === 'cookie') {
        // Add the cookie, preserving other cookies if they exist
        headers['cookie'] = `${credential.name}=${credential.value}${headers['cookie'] ? `; ${headers['cookie']}` : ''}`;
    } else {
        headers[credential.name] = credential.value;
    }
}

/**
 * Human-readable security requirements, e.g. "[apiKey AND oauth (scopes: read)] OR [bearer]".
 */
function describeSecurityRequirements(requirements: Record<string, string[]>[]): string {
    return requirements
        .map((requirement) => {
            const parts = Object.entries(requirement ?? {}).map(([name, scopes]) =>
                Array.isArray(scopes) && scopes.length > 0 ? `${name} (scopes: ${scopes.join(', ')})` : name
            );
            return `[${parts.length > 0 ? parts.join(' AND ') : 'no auth'}]`;
        })
        .join(' OR ');
}

/**
 * Environment variables (or forwarded headers) that supply one scheme's credential.
 */
function credentialHint(schemeName: string, scheme: any, passthroughNames: string[]): string {
    const suffix = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    let hint: string;
    if (!scheme) {
        return `(security scheme '${schemeName}' is not defined in the spec)`;
    } else if (scheme.type === 'apiKey') {
        hint = `API_KEY_${suffix}`;
    } else if (scheme.type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'bearer') {
        hint = `BEARER_TOKEN_${suffix}`;
    } else if (scheme.type === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'basic') {
        hint = `BASIC_USERNAME_${suffix} (and BASIC_PASSWORD_${suffix})`;
    } else if (scheme.type === 'oauth2') {
        hint = scheme.flows?.clientCredentials || scheme.flows?.password
            ? `OAUTH_TOKEN_${suffix} (or OAUTH_CLIENT_ID_${suffix} and OAUTH_CLIENT_SECRET_${suffix})`
            : `OAUTH_TOKEN_${suffix}`;
    } else if (scheme.type === 'openIdConnect') {
        hint = `OPENID_TOKEN_${suffix}`;
    } else {
        return `(security scheme '${schemeName}' of type ${scheme.type} is not supported)`;
    }
    const header = credentialHeaderName(scheme);
    return header !== undefined && passthroughNames.includes(header)
        ? `${hint} or the '${header}' request header`
        : hint;
}

/**
 * Tool error text for an operation whose security requirements cannot be met,
 * e.g. "Missing credentials for 'getPet': set API_KEY_PETSTORE_AUTH."
 */
function describeMissingCredentials(
    toolName: string,
    requirements: Record<string, string[]>[],
    allSecuritySchemes: Record<string, any>,
    passthroughNames: string[]
): string {
    const alternatives = requirements
        .filter((requirement) => Object.keys(requirement ?? {}).length > 0)
        .map((requirement) =>
            Object.keys(requirement)
                .map((schemeName) => credentialHint(schemeName, allSecuritySchemes[schemeName], passthroughNames))
                .join(' and ')
        );
    return `Missing credentials for '${toolName}': set ${alternatives.join(', or ')}. Required security: ${describeSecurityRequirements(requirements)}.`;
}

/**
 * Resolves an operation's OpenAPI security requirements (issue #81).
 *
 * Requirement objects are alternatives tried in order (OR); every scheme inside one
 * object must resolve (AND). A partially satisfied alternative is never applied, so
 * an incomplete set of credentials is never sent. An empty object ({}) makes
 * authentication optional: it is used only when no other alternative is complete.
 * A forwarded passthrough header (--header-passthrough) satisfies the scheme whose
 * credential travels in it, so a client that sends its own API key still gets the
 * other schemes of an AND requirement.
 */
async function resolveSecurityRequirements(
    requirements: Record<string, string[]>[] | undefined,
    allSecuritySchemes: Record<string, any>,
    forwarded: Record<string, string> = {}
): Promise<SecurityResolution> {
    if (!Array.isArray(requirements) || requirements.length === 0) return { status: 'none' };
    let optional = false;
    for (const requirement of requirements) {
        const entries = Object.entries(requirement ?? {});
        if (entries.length === 0) {
            optional = true;
            continue;
        }
        const credentials: UpstreamCredential[] = [];
        let complete = true;
        for (const [schemeName, scopes] of entries) {
            const headerName = credentialHeaderName(allSecuritySchemes[schemeName]);
            const credential: UpstreamCredential | null =
                headerName !== undefined && forwarded[headerName] !== undefined
                    ? {
                          schemeName,
                          location: 'header',
                          name: headerName,
                          value: forwarded[headerName],
                          description: `forwarded client header '${headerName}' for '${schemeName}'`,
                      }
                    : await resolveSchemeCredential(
                          schemeName,
                          allSecuritySchemes[schemeName],
                          Array.isArray(scopes) ? scopes : []
                      );
            if (!credential) {
                complete = false;
                break;
            }
            credentials.push(credential);
        }
        if (!complete) continue;
        if (hasConflictingCredentials(credentials)) {
            console.error(`Skipping security requirement ${describeSecurityRequirements([requirement])}: two of its schemes need the same request location.`);
            continue;
        }
        return { status: 'applied', credentials };
    }
    return optional
        ? { status: 'optional' }
        : { status: 'unsatisfied', summary: describeSecurityRequirements(requirements) };
}


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
    // Validate arguments against the tool's JSON Schema (no code generation, no eval).
    // Invalid arguments are a tool execution error the model can read and correct.
    const validatedArgs: JsonObject = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
    const validationError = validateToolArguments(toolName, definition.inputSchema, validatedArgs);
    if (validationError) {
        return { isError: true, content: [{ type: 'text', text: validationError }] };
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
                urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
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
        throw new Error(`Failed to resolve path parameters: ${urlPath}`);
    }
    
    // Construct the full URL (operation and path-item servers win over the base URL)
    const baseUrl = resolveOperationBaseUrl(definition.serverUrl, API_BASE_URL);
    const requestUrl = baseUrl ? `${baseUrl}${urlPath}` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
        requestBodyData = validatedArgs['requestBody'];
        headers['content-type'] = definition.requestBodyContentType;
    }

    const forwardedHeaders: Record<string, string> = {};

    // Apply upstream credentials for this operation's security requirements
    // (OR across requirement objects, AND within one; see resolveSecurityRequirements).
    const securityResolution = await resolveSecurityRequirements(definition.securityRequirements, allSecuritySchemes, forwardedHeaders);
    if (securityResolution.status === 'applied') {
        for (const credential of securityResolution.credentials) {
            applyUpstreamCredential(credential, headers, queryParams);
            console.error(`Applied ${credential.description}`);
        }
    } else if (securityResolution.status === 'unsatisfied') {
        // Fail closed (issue #82): do not call the API without the credentials it requires,
        // unless MCP_ALLOW_MISSING_CREDENTIALS=true restores the old warn-and-send behavior.
        if (String(process.env.MCP_ALLOW_MISSING_CREDENTIALS ?? '').toLowerCase() === 'true') {
            console.warn(`Tool '${toolName}' requires security: ${securityResolution.summary}, but no complete set of credentials is configured. Sending the request without upstream credentials (MCP_ALLOW_MISSING_CREDENTIALS=true).`);
        } else {
            const message = describeMissingCredentials(toolName, definition.securityRequirements, allSecuritySchemes, []);
            console.error(message);
            return { isError: true, content: [{ type: 'text', text: message }] };
        }
    }
    

    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      // Serialize array query params as comma-separated values (issue #41)
      paramsSerializer: (params: Record<string, any>) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          search.append(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        return search.toString();
      },
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    // Log request info to stderr (doesn't affect MCP output)
    console.error(`Executing tool "${toolName}": ${config.method} ${config.url}`);

    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    // Coerce header value to string before lowercasing (issue #65)
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    
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
         responseText = `(Status: ${response.status} - No body content)`; 
    }
    
    const text = `API Response (Status: ${response.status}):\n${responseText}`;

    // A JSON object response is also returned as structuredContent (text unchanged).
    const structuredContent =
        contentType.includes('application/json') &&
        typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)
            ? (response.data as Record<string, unknown>)
            : undefined;

    // With a declared outputSchema (--output-schema), never return a result that violates it.
    if (definition.outputSchema !== undefined) {
        const outputError = structuredContent === undefined
            ? 'expected a JSON object response'
            : validateToolOutput(toolName, definition.outputSchema, structuredContent);
        if (outputError) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Response for tool '${toolName}' does not match its output schema: ${outputError}\n\n${text}` }],
            };
        }
    }

    return {
        content: [{ type: 'text', text }],
        ...(structuredContent !== undefined && { structuredContent }),
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
    console.error(`Error during execution of tool '${toolName}':`, errorMessage);
    
    // Return the error to the client as a tool error so the model knows the call failed
    return { isError: true, content: [{ type: "text", text: errorMessage }] };
  }
}


/**
 * Main function to start the server
 */
async function main() {
// Set up StreamableHTTP transport
  try {
    await setupStreamableHttpServer(createServer, Number(process.env.PORT) || 3000);
  } catch (error) {
    console.error("Error setting up StreamableHTTP server:", error);
    process.exit(1);
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
main().catch((error) => {
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});

/**
 * Formats API errors for better readability
 * 
 * @param error Axios error
 * @returns Formatted error message
 */
function formatApiError(error: AxiosError): string {
    let message = 'API request failed.';
    if (error.response) {
        message = `API Error: Status ${error.response.status} (${error.response.statusText || 'Status text not available'}). `;
        const responseData = error.response.data;
        const MAX_LEN = 200;
        if (typeof responseData === 'string') { 
            message += `Response: ${responseData.substring(0, MAX_LEN)}${responseData.length > MAX_LEN ? '...' : ''}`; 
        }
        else if (responseData) { 
            try { 
                const jsonString = JSON.stringify(responseData); 
                message += `Response: ${jsonString.substring(0, MAX_LEN)}${jsonString.length > MAX_LEN ? '...' : ''}`; 
            } catch { 
                message += 'Response: [Could not serialize data]'; 
            } 
        }
        else { 
            message += 'No response body received.'; 
        }
    } else if (error.request) {
        message = 'API Network Error: No response received from server.';
        if (error.code) message += ` (Code: ${error.code})`;
    } else { 
        message += `API Request Setup Error: ${error.message}`; 
    }
    return message;
}
