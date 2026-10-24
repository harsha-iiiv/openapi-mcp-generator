# OpenAPI to MCP Generator - Programmatic API

This document describes how to use the OpenAPI to MCP Generator programmatically in your Node.js applications.

## Installation

```bash
npm install openapi-mcp-generator
```

## Usage

The package exports a simple, focused API for extracting MCP tool definitions from OpenAPI specifications:

```typescript
import { getToolsFromOpenApi } from 'openapi-mcp-generator';
```

### `getToolsFromOpenApi(specPathOrUrl, options)`

This function extracts an array of tools from an OpenAPI specification.

**Parameters:**

- `specPathOrUrl`: Path to a local OpenAPI spec file or URL to a remote spec
- `options`: (Optional) Configuration options

**Options:**

- `baseUrl`: Override the base URL in the OpenAPI spec
- `dereference`: Whether to resolve $refs (default: false)
- `excludeOperationIds`: Array of operation IDs to exclude from the results
- `includeTags` / `excludeTags`: Keep only, or drop, operations with these tags (case-insensitive)
- `includeOperations` / `excludeOperations`: Keep only, or drop, these operations (operationId or tool
  name). The four filters match the CLI flags: include lists combine, exclusions win, and they apply
  after `x-mcp` filtering
- `filterFn`: Custom function to filter tools (receives tool, returns boolean)

Swagger 2.0 documents are rejected with an error; convert them to OpenAPI 3 first
(`npx swagger2openapi swagger.json -o openapi.json`).

**Returns:**

- Promise that resolves to an array of McpToolDefinition objects

**Example:**

```typescript
import { getToolsFromOpenApi } from 'openapi-mcp-generator';

// Basic usage
const tools = await getToolsFromOpenApi('./petstore.json');

// With options
const filteredTools = await getToolsFromOpenApi(
  'https://petstore3.swagger.io/api/v3/openapi.json',
  {
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    dereference: true,
    excludeOperationIds: ['addPet', 'updatePet'],
    filterFn: (tool) => tool.method.toLowerCase() === 'get',
  }
);

// Process the results
for (const tool of filteredTools) {
  console.log(`Tool: ${tool.name}`);
  console.log(`  Description: ${tool.description}`);
  console.log(`  Method: ${tool.method.toUpperCase()} ${tool.pathTemplate}`);
  console.log(`  OperationId: ${tool.operationId}`);
}
```

you can also provide a `OpenAPIV3.Document` to the parser:

```typescript
import { parser } from '@readme/openapi-parser';

const api = await parser('https://petstore3.swagger.io/api/v3/openapi.json', {
  dereference: {
    circular: true,
  },
});

const tools = await getToolsFromOpenApi(api);
```

## Tool Definition Structure

Each tool definition (`McpToolDefinition`) has the following properties:

```typescript
interface McpToolDefinition {
  /** Name of the tool, must be unique */
  name: string;

  /** Display title: the operation's x-mcp-title, else its summary */
  title?: string;

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

  /** Server declared on the operation or path item (variables resolved) */
  serverUrl?: string;

  /** Original operation ID from the OpenAPI spec */
  operationId: string;

  /** OpenAPI tags and deprecation status */
  tags?: string[];
  deprecated?: boolean;

  /** Behavior hints from the HTTP method, overridable with x-mcp-annotations */
  annotations?: McpToolAnnotations; // readOnlyHint, destructiveHint, idempotentHint, openWorldHint

  /** Schema of the lowest 2xx application/json response, when it is an object */
  outputSchema?: JSONSchema7;

  /** Base URL for the API (if available) */
  baseUrl?: string;
}
```

`inputSchema` is JSON Schema 2020-12: integers stay `integer`, `example` becomes `examples`, and
properties marked `readOnly` are omitted from request inputs.

## Advanced Filtering Examples

### Filter by Tag

```typescript
const petTools = await getToolsFromOpenApi(specUrl, {
  includeTags: ['pets'],
  excludeOperations: ['deletePet'],
});
```

### Read-only Tools

```typescript
const readOnlyTools = await getToolsFromOpenApi(specUrl, {
  filterFn: (tool) => tool.annotations?.readOnlyHint === true,
});
```

### Filter by HTTP Method

```typescript
const getTools = await getToolsFromOpenApi(specUrl, {
  filterFn: (tool) => tool.method.toLowerCase() === 'get',
});
```

### Filter by Security Requirements

```typescript
const secureTools = await getToolsFromOpenApi(specUrl, {
  filterFn: (tool) => tool.securityRequirements.length > 0,
});
```

### Filter by Path Pattern

```typescript
const userTools = await getToolsFromOpenApi(specUrl, {
  filterFn: (tool) => tool.pathTemplate.includes('/user'),
});
```

### Combining Multiple Filters

```typescript
const safeUserTools = await getToolsFromOpenApi(specUrl, {
  excludeOperationIds: ['deleteUser', 'updateUser'],
  filterFn: (tool) => tool.pathTemplate.includes('/user') && tool.method.toLowerCase() === 'get',
});
```
