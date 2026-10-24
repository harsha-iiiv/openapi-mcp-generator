/**
 * Unit tests for v4.0.0 security fixes, bug fixes, and features.
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { OpenAPIV3 } from 'openapi-types';

import { getServerInstructions, sanitizeForTemplate } from '../src/utils/helpers.js';
import {
  assertNoExternalRefs,
  isExternalHttpRef,
  ExternalRefError,
  parseSpecSecurely,
  UnsupportedSwaggerError,
} from '../src/utils/parser-security.js';
import {
  extractToolsFromApi,
  truncateToolName,
  shortenToolName,
  abbreviateToolName,
  splitNameIntoWords,
  mapOpenApiSchemaToJsonSchema,
  getToolAnnotations,
  getToolTitle,
  filterTools,
  getOutputSchema,
} from '../src/parser/extract-tools.js';
import { generateToolDefinitionMap } from '../src/utils/code-gen.js';
import {
  generateOAuth2TokenAcquisitionCode,
  generateExecuteApiToolFunction,
  getSecurityModuleImports,
  getInboundHeaderStoreDeclaration,
  generateHttpSecurityCode,
} from '../src/utils/security.js';
import { generateMcpServerCode, generateCustomAuthStub } from '../src/generator/server-code.js';
import { generateCloudflareWorkerFiles } from '../src/generator/cloudflare-worker.js';
import { getToolsFromOpenApi } from '../src/api.js';
import { generatePackageJson } from '../src/generator/package-json.js';
import rootPackageJson from '../package.json' with { type: 'json' };
import type { McpToolDefinition } from '../src/types/index.js';

// --- #67: template-literal injection ---------------------------------------

describe('#67 sanitizeForTemplate', () => {
  it('escapes backticks and backslashes', () => {
    expect(sanitizeForTemplate('a`b\\c')).toBe('a\\`b\\\\c');
  });

  it('escapes ${ template-expression sequences', () => {
    const malicious = 'desc ${process.env.SECRET}';
    const out = sanitizeForTemplate(malicious);
    expect(out).toBe('desc \\${process.env.SECRET}');
    // Every `${` is backslash-escaped, so none survives as a live interpolation
    // when the value is embedded in a generated backtick template literal.
    // (Verified by string inspection rather than eval to avoid SAST noise.)
    expect(out).not.toMatch(/(^|[^\\])\$\{/);
    expect(out).toContain('\\${');
  });

  it('handles empty/undefined input', () => {
    expect(sanitizeForTemplate('')).toBe('');
    // @ts-expect-error testing runtime guard
    expect(sanitizeForTemplate(undefined)).toBe('');
  });
});

// --- #68: SSRF external $ref guard ------------------------------------------

describe('#68 external $ref SSRF guard', () => {
  it('detects http(s) refs', () => {
    expect(isExternalHttpRef('http://169.254.169.254/')).toBe(true);
    expect(isExternalHttpRef('https://evil.test/x.json')).toBe(true);
    expect(isExternalHttpRef('#/components/schemas/Foo')).toBe(false);
    expect(isExternalHttpRef('./local.yaml')).toBe(false);
    expect(isExternalHttpRef(42)).toBe(false);
  });

  it('throws on a nested external ref', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/x': { get: { responses: { 200: { $ref: 'http://internal/svc' } } } } },
    };
    expect(() => assertNoExternalRefs(spec)).toThrow(ExternalRefError);
  });

  it('allows local refs', () => {
    const spec = { a: { $ref: '#/components/schemas/Foo' }, b: { $ref: './local.yaml' } };
    expect(() => assertNoExternalRefs(spec)).not.toThrow();
  });

  it('does not treat a $ref string in example/data as an OpenAPI reference', () => {
    // A `$ref` that is user data (example payload, or a data object with extra
    // sibling props) must NOT be rejected — only true Reference Objects are.
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  // An example payload that happens to contain a $ref-shaped string.
                  example: { $ref: 'http://example.com/some-user-data', other: 1 },
                },
              },
            },
          },
        },
      },
    };
    expect(() => assertNoExternalRefs(spec)).not.toThrow();
  });

  it('still rejects a real external Reference Object alongside summary/description', () => {
    const spec = {
      schema: { $ref: 'https://evil.test/x.json', summary: 's', description: 'd' },
    };
    expect(() => assertNoExternalRefs(spec)).toThrow(ExternalRefError);
  });

  it('handles cyclic objects without infinite recursion', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => assertNoExternalRefs(a)).not.toThrow();
  });

  it('accepts a pre-parsed OpenAPI document (not just a path/URL string)', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } },
      },
    } as unknown as OpenAPIV3.Document;
    const result = await parseSpecSecurely(doc, false);
    expect(result.openapi).toBe('3.0.0');
    expect(result.paths?.['/x']).toBeDefined();
  });

  it('parses a spec from a path/URL-style string input under the default guard', async () => {
    // Regression: the SSRF guard must not block loading the user-supplied input
    // itself (a file path or http(s) URL). Only embedded external $refs are
    // rejected. Previously `resolve: { http: false }` blocked fetching a URL
    // input outright, breaking `-i https://.../openapi.json`.
    const fixture = new URL('./fixtures/sample-api.json', import.meta.url);
    const result = await parseSpecSecurely(fileURLToPath(fixture), false);
    expect(result.openapi).toBeDefined();
    expect(Object.keys(result.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('resolves relative $refs in a multi-file spec under the default guard', async () => {
    // Regression: dereferencing must resolve relative file refs against the
    // spec's directory (not the process cwd), so multi-file specs work.
    const fixture = new URL('./fixtures/multifile/openapi.json', import.meta.url);
    const result = await parseSpecSecurely(fileURLToPath(fixture), false);
    const body = (result.paths?.['/pets'] as any)?.post?.requestBody?.content?.['application/json']
      ?.schema;
    // The `./refs/schemas.json#/Pet` ref must be inlined, not left dangling.
    expect(body?.$ref).toBeUndefined();
    expect(body?.properties?.name).toBeDefined();
    expect(body?.properties?.id).toBeDefined();
  });
});

// --- JSON Schema fidelity --------------------------------------------------------

describe('JSON Schema fidelity of input schemas', () => {
  it('keeps integer types, including nullable integers', () => {
    expect(mapOpenApiSchemaToJsonSchema({ type: 'integer', format: 'int64' })).toEqual({
      type: 'integer',
      format: 'int64',
    });
    expect(
      mapOpenApiSchemaToJsonSchema({ type: 'integer', nullable: true } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: ['integer', 'null'] });
  });

  it('turns example into examples, keeping an existing examples array', () => {
    expect(mapOpenApiSchemaToJsonSchema({ type: 'string', example: 'rex' })).toEqual({
      type: 'string',
      examples: ['rex'],
    });
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'string',
        example: 'ignored',
        examples: ['a', 'b'],
      } as unknown as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'string', examples: ['a', 'b'] });
    // An example of `false` or `null` is still an example.
    expect(mapOpenApiSchemaToJsonSchema({ type: 'boolean', example: false })).toEqual({
      type: 'boolean',
      examples: [false],
    });
  });

  it('keeps format, pattern, enums and composition keywords as written', () => {
    const source = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', pattern: '^.+@.+$' },
        status: { type: 'string', enum: ['a', 'b'] },
        either: { oneOf: [{ type: 'integer' }, { type: 'string', format: 'uuid' }] },
        both: { allOf: [{ type: 'object' }], anyOf: [{ required: ['x'] }] },
      },
    } as unknown as OpenAPIV3.SchemaObject;
    expect(mapOpenApiSchemaToJsonSchema(source)).toEqual(source);
  });

  const petApi = {
    openapi: '3.0.3',
    info: { title: 'pets', version: '1' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: {
                    id: { type: 'integer', readOnly: true },
                    name: { type: 'string' },
                    password: { type: 'string', writeOnly: true },
                    owner: {
                      type: 'object',
                      required: ['createdAt'],
                      properties: {
                        createdAt: { type: 'string', format: 'date-time', readOnly: true },
                        email: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  } as unknown as OpenAPIV3.Document;

  it('drops readOnly properties from request input schemas, and from required', () => {
    const [tool] = extractToolsFromApi(petApi);
    const body = (tool.inputSchema as any).properties.requestBody;
    expect(Object.keys(body.properties)).toEqual(['name', 'password', 'owner']);
    expect(body.required).toEqual(['name']);
    expect(Object.keys(body.properties.owner.properties)).toEqual(['email']);
    expect(body.properties.owner.required).toBeUndefined();
  });

  it('drops writeOnly properties when mapping a response schema', () => {
    const schema = (petApi.paths['/pets'] as any).post.requestBody.content['application/json']
      .schema;
    const mapped = mapOpenApiSchemaToJsonSchema(schema, { direction: 'response' }) as any;
    expect(Object.keys(mapped.properties)).toEqual(['id', 'name', 'owner']);
    expect(mapped.required).toEqual(['id', 'name']);
    // Without a direction nothing is dropped.
    const neutral = mapOpenApiSchemaToJsonSchema(schema) as any;
    expect(Object.keys(neutral.properties)).toEqual(['id', 'name', 'password', 'owner']);
  });
});

// --- per-operation servers (#73) -------------------------------------------------

describe('#73 operation and path-item servers', () => {
  const api = {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://{env}.example.com/api/', variables: { env: { default: 'prod' } } }],
    paths: {
      '/a': {
        servers: [{ url: 'https://path.example.com' }, { url: 'https://ignored.example.com' }],
        get: { operationId: 'pathLevel', responses: { '200': { description: 'ok' } } },
        post: {
          operationId: 'operationLevel',
          servers: [
            { url: '/v{major}/', variables: { major: { default: '2' } } },
            { url: 'https://ignored.example.com' },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/b': { get: { operationId: 'rootLevel', responses: { '200': { description: 'ok' } } } },
    },
  } as unknown as OpenAPIV3.Document;

  it('records operation > path-item servers with variables resolved; root stays the base URL', async () => {
    const tools = await getToolsFromOpenApi(api);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.operationLevel.serverUrl).toBe('/v2');
    expect(byName.pathLevel.serverUrl).toBe('https://path.example.com');
    expect(byName.rootLevel.serverUrl).toBeUndefined();
    expect((byName.rootLevel as any).baseUrl).toBe('https://prod.example.com/api');
    expect(generateToolDefinitionMap(tools)).toContain('serverUrl: "/v2",');
  });
});

// --- tag and operation filters --------------------------------------------------

describe('tag and operation filters', () => {
  const op = (operationId: string, tags: string[], extra: object = {}) => ({
    operationId,
    tags,
    responses: { '200': { description: 'ok' } },
    ...extra,
  });
  const api = {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/pets': { get: op('listPets', ['Pets']), post: op('createPet', ['pets', 'Admin']) },
      '/stores': { get: op('list.stores', ['Stores']) },
      '/users': { get: op('listUsers', ['Users'], { 'x-mcp': false }) },
      '/health': { get: op('health', []) },
    },
  } as unknown as OpenAPIV3.Document;
  const names = (filters: Parameters<typeof filterTools>[1]) =>
    filterTools(extractToolsFromApi(api), filters).map((t) => t.name);

  it('keeps everything without filters (after x-mcp)', () => {
    expect(names({})).toEqual(['listPets', 'createPet', 'list_stores', 'health']);
  });

  it('includes by tag case-insensitively and by operationId or tool name', () => {
    expect(names({ includeTags: ['PETS'] })).toEqual(['listPets', 'createPet']);
    expect(names({ includeOperations: ['list.stores'] })).toEqual(['list_stores']);
    expect(names({ includeOperations: ['list_stores', 'health'] })).toEqual([
      'list_stores',
      'health',
    ]);
    // Include lists combine as a union.
    expect(names({ includeTags: ['stores'], includeOperations: ['health'] })).toEqual([
      'list_stores',
      'health',
    ]);
  });

  it('lets exclusions win over inclusions', () => {
    expect(names({ includeTags: ['pets'], excludeTags: ['admin'] })).toEqual(['listPets']);
    expect(names({ includeTags: ['pets'], excludeOperations: ['listPets'] })).toEqual([
      'createPet',
    ]);
    expect(names({ excludeTags: ['Pets', 'stores'] })).toEqual(['health']);
  });

  it('never resurrects operations excluded by x-mcp', () => {
    expect(names({ includeTags: ['users'] })).toEqual([]);
  });

  it('applies the same filters through the programmatic API', async () => {
    const tools = await getToolsFromOpenApi(api, { includeTags: ['pets'], excludeTags: ['admin'] });
    expect(tools.map((t) => t.name)).toEqual(['listPets']);
  });
});

// --- output schemas -------------------------------------------------------------

describe('output schemas', () => {
  const schema = { type: 'object', properties: { id: { type: 'integer' } } };
  it('takes the lowest 2xx response with JSON content, objects only', () => {
    expect(
      getOutputSchema({
        responses: {
          '400': { description: 'bad', content: { 'application/json': { schema } } },
          '202': {
            description: 'later',
            content: { 'application/json': { schema: { type: 'string' } } },
          },
          '201': {
            description: 'created',
            content: { 'application/json; charset=utf-8': { schema } },
          },
          '200': { description: 'no body' },
        },
      } as unknown as OpenAPIV3.OperationObject)
    ).toEqual(schema);
    expect(
      getOutputSchema({
        responses: {
          '201': { description: 'created', content: { 'application/json': { schema } } },
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'string' } } },
          },
        },
      } as unknown as OpenAPIV3.OperationObject)
    ).toBeUndefined();
    expect(
      getOutputSchema({
        responses: {
          '2XX': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      } as unknown as OpenAPIV3.OperationObject)
    ).toBeUndefined();
    expect(
      getOutputSchema({
        responses: { default: { description: 'ok', content: { 'application/json': { schema } } } },
      } as unknown as OpenAPIV3.OperationObject)
    ).toBeUndefined();
  });

  it('is emitted into generated servers only with --output-schema', () => {
    const api = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            operationId: 'getX',
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema } } },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;
    const opts = { input: 'x', output: 'y' };
    expect(generateMcpServerCode(api, opts, 't', '1')).not.toContain('outputSchema: {');
    expect(generateMcpServerCode(api, { ...opts, outputSchema: true }, 't', '1')).toContain(
      'outputSchema: {"type":"object","properties":{"id":{"type":"integer"}}}'
    );
    const worker = (outputSchema: boolean) =>
      generateCloudflareWorkerFiles({
        tools: extractToolsFromApi(api),
        serverName: 't',
        serverVersion: '1',
        securitySchemes: undefined,
        baseUrl: 'https://api.example.com',
        outputSchema,
      }).find((f) => f.path === 'src/tools.ts')!.content;
    expect(worker(false)).not.toContain('outputSchema: {');
    expect(worker(true)).toContain('outputSchema: {');
  });
});

// --- server instructions ------------------------------------------------------------

describe('server instructions from info.description', () => {
  it('trims, omits blanks and bounds the length to 2000 characters', () => {
    expect(getServerInstructions('  Pets API  ')).toBe('Pets API');
    expect(getServerInstructions('   ')).toBeUndefined();
    expect(getServerInstructions(undefined)).toBeUndefined();
    const long = getServerInstructions('x'.repeat(5000))!;
    expect(long.length).toBe(2000);
    expect(long.endsWith('…')).toBe(true);
    expect(getServerInstructions('y'.repeat(2000))).toBe('y'.repeat(2000));
  });

  it('is emitted only when present', () => {
    const base = {
      openapi: '3.0.3',
      paths: {},
    } as unknown as OpenAPIV3.Document;
    const withText = generateMcpServerCode(
      { ...base, info: { title: 't', version: '1', description: 'Use `me` ${wisely}' } },
      { input: 'x', output: 'y' },
      't',
      '1'
    );
    expect(withText).toContain('export const SERVER_INSTRUCTIONS = "Use `me` ${wisely}";');
    expect(withText).toContain('instructions: SERVER_INSTRUCTIONS');
    const without = generateMcpServerCode(
      { ...base, info: { title: 't', version: '1' } },
      { input: 'x', output: 'y' },
      't',
      '1'
    );
    expect(without).not.toContain('SERVER_INSTRUCTIONS');
  });
});

// --- tool annotations and titles -----------------------------------------------

describe('tool annotations and titles', () => {
  it('derives annotations from the HTTP method', () => {
    const readOnly = { readOnlyHint: true, openWorldHint: true };
    for (const method of ['get', 'head', 'options']) {
      expect(getToolAnnotations(method, {}), method).toEqual(readOnly);
    }
    expect(getToolAnnotations('post', {})).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(getToolAnnotations('put', {})).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(getToolAnnotations('patch', {})).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(getToolAnnotations('delete', {})).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('lets x-mcp-annotations override individual boolean hints only', () => {
    expect(
      getToolAnnotations('post', {
        'x-mcp-annotations': {
          idempotentHint: true,
          openWorldHint: false,
          other: true,
          readOnlyHint: 'yes',
        },
      })
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(getToolAnnotations('get', { 'x-mcp-annotations': 'nope' })).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('takes the title from x-mcp-title, else the trimmed summary, else none', () => {
    expect(getToolTitle({ 'x-mcp-title': ' Find pets ', summary: 'Summary' })).toBe('Find pets');
    expect(getToolTitle({ summary: '  List pets\n' })).toBe('List pets');
    expect(getToolTitle({ summary: '   ' })).toBeUndefined();
    expect(getToolTitle({})).toBeUndefined();
  });

  it('exposes title and annotations through the programmatic API and the generated map', async () => {
    const api = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          get: {
            operationId: 'listA',
            summary: 'List A',
            responses: { '200': { description: 'ok' } },
          },
          put: { operationId: 'putA', responses: { '200': { description: 'ok' } } },
        },
      },
    } as OpenAPIV3.Document;
    const tools = await getToolsFromOpenApi(api);
    expect(tools.find((t) => t.name === 'listA')).toMatchObject({
      title: 'List A',
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
    const putA = tools.find((t) => t.name === 'putA')!;
    expect(putA.title).toBeUndefined();
    expect(putA.annotations?.destructiveHint).toBe(true);
    const map = generateToolDefinitionMap(tools);
    expect(map).toContain('title: "List A",');
    expect(map).toContain('annotations: {"readOnlyHint":true,"openWorldHint":true}');
  });
});

// --- Swagger 2.0 input ----------------------------------------------------------

describe('Swagger 2.0 input fails loudly', () => {
  const swagger = {
    swagger: '2.0',
    info: { title: 'legacy', version: '1' },
    host: 'api.example.com',
    paths: {
      '/x': {
        post: {
          operationId: 'postX',
          parameters: [{ in: 'body', name: 'body', schema: { type: 'object' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const message =
    'Swagger 2.0 is not supported. Convert it to OpenAPI 3 first, for example: ' +
    'npx swagger2openapi swagger.json -o openapi.json';

  it('parseSpecSecurely rejects it with and without external refs allowed', async () => {
    for (const allow of [false, true]) {
      await expect(
        parseSpecSecurely(structuredClone(swagger) as never, allow)
      ).rejects.toBeInstanceOf(UnsupportedSwaggerError);
      await expect(parseSpecSecurely(structuredClone(swagger) as never, allow)).rejects.toThrow(
        message
      );
    }
  });

  it('getToolsFromOpenApi rejects it whether or not it dereferences', async () => {
    for (const dereference of [false, true]) {
      await expect(
        getToolsFromOpenApi(structuredClone(swagger) as never, { dereference })
      ).rejects.toThrow(message);
    }
  });

  it('still accepts OpenAPI 3 documents', async () => {
    const tools = await getToolsFromOpenApi({
      openapi: '3.0.3',
      info: { title: 'ok', version: '1' },
      paths: {
        '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } },
      },
    } as OpenAPIV3.Document);
    expect(tools.map((t) => t.name)).toEqual(['getX']);
  });
});

// --- #4: tool name truncation ------------------------------------------------

describe('#77 OpenAPI 3.0 exclusiveMinimum conversion', () => {
  it('converts the boolean exclusive bound to a JSON Schema numeric bound', () => {
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'number',
        minimum: 0,
        exclusiveMinimum: true,
      } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'number', exclusiveMinimum: 0 });
  });

  it('preserves minimum when exclusiveMinimum is false', () => {
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'number',
        minimum: 0,
        exclusiveMinimum: false,
      } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'number', minimum: 0 });
  });

  it('preserves numeric exclusiveMinimum from OpenAPI 3.1', () => {
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'number',
        exclusiveMinimum: 0,
      } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'number', exclusiveMinimum: 0 });
  });

  it('converts the OpenAPI 3.0 boolean exclusiveMaximum the same way', () => {
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'number',
        maximum: 100,
        exclusiveMaximum: true,
      } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'number', exclusiveMaximum: 100 });
    expect(
      mapOpenApiSchemaToJsonSchema({
        type: 'number',
        maximum: 100,
        exclusiveMaximum: false,
      } as OpenAPIV3.SchemaObject)
    ).toEqual({ type: 'number', maximum: 100 });
  });

  it('normalizes bounds in nested subschemas', () => {
    const bounded = { type: 'number', minimum: 0, exclusiveMinimum: true } as const;
    const expected = { type: 'number', exclusiveMinimum: 0 };
    const mapped = mapOpenApiSchemaToJsonSchema({
      type: 'object',
      properties: {
        composed: { allOf: [{ type: 'object', properties: { size: { ...bounded } } }] },
        either: { oneOf: [{ ...bounded }, { type: 'string' }] },
        any: { anyOf: [{ ...bounded }] },
        excluded: { not: { ...bounded } },
        map: { type: 'object', additionalProperties: { ...bounded } },
        nullableObject: { type: 'object', nullable: true, properties: { size: { ...bounded } } },
        untyped: { properties: { size: { ...bounded } } },
        list: { type: 'array', items: { ...bounded } },
      },
    } as unknown as OpenAPIV3.SchemaObject) as any;

    expect(mapped.properties.composed.allOf[0].properties.size).toEqual(expected);
    expect(mapped.properties.either.oneOf[0]).toEqual(expected);
    expect(mapped.properties.any.anyOf[0]).toEqual(expected);
    expect(mapped.properties.excluded.not).toEqual(expected);
    expect(mapped.properties.map.additionalProperties).toEqual(expected);
    expect(mapped.properties.nullableObject.type).toEqual(['object', 'null']);
    expect(mapped.properties.nullableObject.properties.size).toEqual(expected);
    expect(mapped.properties.untyped.properties.size).toEqual(expected);
    expect(mapped.properties.list.items).toEqual(expected);
  });

  it('applies the other OpenAPI conversions inside composed schemas too', () => {
    const mapped = mapOpenApiSchemaToJsonSchema({
      allOf: [{ type: 'string', nullable: true, example: 'a' }],
    } as unknown as OpenAPIV3.SchemaObject) as any;
    expect(mapped.allOf[0]).toEqual({ type: ['string', 'null'], examples: ['a'] });
  });

  it('does not modify the source schema', () => {
    const source = { type: ['string'], nullable: true } as unknown as OpenAPIV3.SchemaObject;
    mapOpenApiSchemaToJsonSchema(source);
    expect(source).toEqual({ type: ['string'], nullable: true });
  });

  it('breaks cycles through composed schemas', () => {
    const node: any = { type: 'object', properties: {} };
    node.properties.child = { allOf: [node] };
    const mapped = mapOpenApiSchemaToJsonSchema(node) as any;
    expect(mapped.properties.child.allOf[0]).toEqual({ type: 'object' });
  });

  it('emits the converted bound in an operation request-body input schema', () => {
    const [tool] = extractToolsFromApi({
      openapi: '3.0.3',
      info: { title: 'test', version: '1' },
      paths: {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      size: { type: 'number', minimum: 0, exclusiveMinimum: true },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        requestBody: {
          type: 'object',
          properties: { size: { type: 'number', exclusiveMinimum: 0 } },
        },
      },
    });
  });
});

describe('#4 tool name truncation', () => {
  it('leaves short names unchanged', () => {
    expect(truncateToolName('getUser', 64)).toBe('getUser');
  });

  it('truncates long names to the limit with a hash suffix', () => {
    const long = 'a'.repeat(100);
    const out = truncateToolName(long, 64);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).not.toBe(long);
    // Result stays within the MCP-allowed character set.
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('is deterministic and unique across distinct inputs', () => {
    const a = truncateToolName('x'.repeat(80) + '_alpha', 64);
    const b = truncateToolName('x'.repeat(80) + '_beta', 64);
    expect(a).toBe(truncateToolName('x'.repeat(80) + '_alpha', 64));
    expect(a).not.toBe(b);
  });

  it('preserves both head and tail (Start…End) so prefix-collisions stay distinguishable', () => {
    // Names long enough to force truncation (> 64), sharing a long prefix and
    // differing only in the tail — the common REST prefix-collision shape.
    const a = truncateToolName(
      'createUserAccountSubscriptionPaymentMethodConfigurationWithDefaultBillingAddress',
      64
    );
    const b = truncateToolName(
      'createUserAccountSubscriptionPaymentMethodConfigurationWithAlternateBillingAddress',
      64
    );
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    // Shared head is kept...
    expect(a.startsWith('createUserAccountSubscription')).toBe(true);
    // ...and the distinguishing tail is kept (not replaced by an opaque hash only).
    expect(a).toContain('BillingAddress');
    expect(b).toContain('BillingAddress');
    // Middle elided with the marker, and the two remain distinct.
    expect(a).toContain('__');
    expect(a).not.toBe(b);
  });

  it('keeps the tail for suffix-collisions via the head (getXById family)', () => {
    // These are short enough to be unchanged, documenting the non-truncated path.
    expect(truncateToolName('getUserById', 64)).toBe('getUserById');
    expect(truncateToolName('getOrderById', 64)).toBe('getOrderById');
  });

  it('falls back to head+hash when the limit is too small for two ends', () => {
    const out = truncateToolName('x'.repeat(40), 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
    // No elision marker when there is no room for a meaningful tail.
    expect(out).not.toContain('__');
  });

  it('applies during extraction and keeps names unique', () => {
    const longId = 'operation_' + 'X'.repeat(80);
    const api: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/a': { get: { operationId: longId, responses: {} } },
        '/b': { get: { operationId: longId, responses: {} } },
      },
    };
    const tools = extractToolsFromApi(api, true, 64);
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t.name.length).toBeLessThanOrEqual(64);
    expect(tools[0].name).not.toBe(tools[1].name);
  });

  it('preserves the original operationId even when the tool name is truncated', () => {
    const longId = 'getSomethingWith' + 'X'.repeat(80);
    const api: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: { '/a': { get: { operationId: longId, responses: {} } } },
    };
    const [tool] = extractToolsFromApi(api, true, 64);
    // Tool name is truncated for MCP, but operationId stays the original spec value.
    expect(tool.name.length).toBeLessThanOrEqual(64);
    expect(tool.operationId).toBe(longId);
  });
});

// --- #4: word-level abbreviation --------------------------------------------

describe('#4 word-level name abbreviation', () => {
  it('splits snake_case, kebab-case and camelCase into words', () => {
    expect(splitNameIntoWords('FDA_get_info_on_conditions')).toEqual([
      'FDA',
      'get',
      'info',
      'on',
      'conditions',
    ]);
    expect(splitNameIntoWords('createUserSubscriptionMethod')).toEqual([
      'create',
      'User',
      'Subscription',
      'Method',
    ]);
    expect(splitNameIntoWords('get-drug-info')).toEqual(['get', 'drug', 'info']);
  });

  it('keeps the first word, keeps short words, shortens long words to 4 chars', () => {
    // Mirrors the ToolUniverse reference example.
    expect(
      abbreviateToolName('FDA_get_info_on_conditions_for_doctor_consultation_by_drug_name')
    ).toBe('FDA_get_info_on_cond_for_doct_cons_by_drug_name');
    expect(abbreviateToolName('euhealthinfo_search_diabetes_mellitus_epidemiology_registry')).toBe(
      'euhealthinfo_sear_diab_mell_epid_regi'
    );
  });

  it('shortenToolName abbreviates when over the limit and fits the result', () => {
    const name = 'createUserAccountSubscriptionPaymentMethodConfigurationWithBillingAddressDetails';
    expect(name.length).toBeGreaterThan(64);
    const out = shortenToolName(name, 64);
    expect(out.length).toBeLessThanOrEqual(64);
    // Words remain individually recognizable (no opaque hash needed here).
    expect(out).toContain('create');
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('shortenToolName leaves names that already fit unchanged', () => {
    const name = 'FDA_get_info_on_conditions_for_doctor_consultation_by_drug_name'; // 63 chars
    expect(name.length).toBeLessThanOrEqual(64);
    expect(shortenToolName(name, 64)).toBe(name);
  });

  it('shortenToolName falls back to hash truncation when abbreviation still overflows', () => {
    // Many long words: even abbreviated to 4 chars each, exceeds a tight limit.
    const name = Array.from({ length: 20 }, (_, i) => `segment${i}xxxxxxxx`).join('_');
    const out = shortenToolName(name, 64);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

// --- #59 / #49: tags & deprecated -------------------------------------------

describe('#59 tags and #49 deprecated extraction', () => {
  const api: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['pets', 'public'],
          deprecated: true,
          responses: {},
        },
      },
    },
  };

  it('extracts tags and deprecated onto the tool definition', () => {
    const [tool] = extractToolsFromApi(api, true, 64);
    expect(tool.tags).toEqual(['pets', 'public']);
    expect(tool.deprecated).toBe(true);
  });

  it('emits tags/deprecated and decorates the description in generated map', () => {
    const [tool] = extractToolsFromApi(api, true, 64);
    const code = generateToolDefinitionMap([tool]);
    expect(code).toContain('tags: ["pets","public"]');
    expect(code).toContain('deprecated: true');
    expect(code).toContain('[DEPRECATED]');
    expect(code).toContain('(Tags: pets, public)');
  });
});

// --- #56: OAuth scheme name resolution --------------------------------------

describe('#56 OAuth env var resolves from runtime scheme name', () => {
  it('does not emit a literal SCHEMENAME env lookup', () => {
    const code = generateOAuth2TokenAcquisitionCode();
    expect(code).not.toContain('OAUTH_CLIENT_ID_SCHEMENAME');
    expect(code).not.toContain('OAUTH_CLIENT_SECRET_SCHEMENAME');
    // Should derive the var name from the runtime schemeName argument.
    expect(code).toContain('schemeName.replace(');
  });
});

// --- #66: basic auth empty password -----------------------------------------

describe('#66 basic auth with empty password', () => {
  it('requires only a username (username == null rejects) and defaults password', () => {
    const code = generateExecuteApiToolFunction();
    expect(code).toContain('if (username == null) return null;');
    expect(code).toContain("getSchemeEnv('BASIC_PASSWORD', schemeName) ?? ''");
    expect(code).not.toContain('if (username && password)');
  });

  it('keeps the exported generateHttpSecurityCode helper in sync', () => {
    const code = generateHttpSecurityCode();
    expect(code).toContain('username != null');
    expect(code).toContain("password ?? ''");
    expect(code).not.toContain('if (username && password)');
  });
});

// --- #41: array query params -------------------------------------------------

describe('#41 array query param serialization', () => {
  it('emits a paramsSerializer that joins arrays with commas', () => {
    const code = generateExecuteApiToolFunction();
    expect(code).toContain('paramsSerializer');
    expect(code).toContain("value.join(',')");
  });
});

// --- #65: content-type coercion ---------------------------------------------

describe('#65 content-type build fix', () => {
  it('coerces the header value to string before lowercasing', () => {
    const code = generateExecuteApiToolFunction();
    expect(code).toContain("String(response.headers['content-type'] ?? '').toLowerCase()");
    expect(code).not.toContain("response.headers['content-type']?.toLowerCase()");
  });
});

// --- #46 / #8 / #9 / #55: opt-in flags --------------------------------------

describe('opt-in security/execution options', () => {
  it('#46 insecure adds https import and agent only when enabled', () => {
    expect(getSecurityModuleImports({ insecure: true })).toContain('import * as https');
    expect(getSecurityModuleImports({})).not.toContain('https');
    const code = generateExecuteApiToolFunction(undefined, { insecure: true });
    expect(code).toContain('rejectUnauthorized: false');
    expect(generateExecuteApiToolFunction(undefined, {})).not.toContain('rejectUnauthorized');
  });

  it('#8 oauth-creds-in-body moves credentials into the form body', () => {
    const inBody = generateOAuth2TokenAcquisitionCode({ oauthCredsInBody: true });
    expect(inBody).toContain("formData.append('client_id', clientId)");
    expect(inBody).toContain("formData.append('client_secret', clientSecret)");
    const header = generateOAuth2TokenAcquisitionCode({});
    expect(header).toContain("'Authorization': `Basic");
    expect(header).not.toContain("formData.append('client_id'");
  });

  it('#9 custom-auth wires the hook import and call', () => {
    expect(getSecurityModuleImports({ customAuth: true })).toContain("from './auth.js'");
    const code = generateExecuteApiToolFunction(undefined, { customAuth: true });
    expect(code).toContain('applyCustomAuth(');
    expect(generateExecuteApiToolFunction(undefined, {})).not.toContain('applyCustomAuth');
  });

  it('#55 header passthrough reads request-scoped store only when names provided', () => {
    const code = generateExecuteApiToolFunction(undefined, { headerPassthrough: ['X-API-KEY'] });
    // Reads from request-scoped AsyncLocalStorage, NOT a shared global.
    expect(code).toContain('inboundHeaderStore.getStore()');
    expect(code).not.toContain('globalThis');
    expect(code).toContain('"x-api-key"');
    expect(generateExecuteApiToolFunction(undefined, {})).not.toContain('inboundHeaderStore');
  });

  it('#55 emits the AsyncLocalStorage import + store declaration when enabled', () => {
    const opts = { headerPassthrough: ['X-API-KEY'] };
    expect(getSecurityModuleImports(opts)).toContain("from 'async_hooks'");
    expect(getInboundHeaderStoreDeclaration(opts)).toContain('new AsyncLocalStorage');
    expect(getInboundHeaderStoreDeclaration({})).toBe('');
    expect(getSecurityModuleImports({})).not.toContain('async_hooks');
  });

  it('#9 custom-auth guards built-in auth behind the hook result', () => {
    const code = generateExecuteApiToolFunction(undefined, { customAuth: true });
    // Built-in auth must be skipped when the hook handled it.
    expect(code).toContain('if (!customAuthHandled)');
    expect(generateExecuteApiToolFunction(undefined, {})).not.toContain('customAuthHandled');
  });

  it('generates a valid custom auth stub', () => {
    const stub = generateCustomAuthStub();
    expect(stub).toContain('export async function applyCustomAuth');
    expect(stub).toContain('CustomAuthContext');
    expect(stub).toContain('return false;');
  });
});

// --- #50: PORT env fallback + lib mode --------------------------------------

describe('#50 PORT env fallback and library mode', () => {
  const api: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.test' }],
    paths: { '/x': { get: { operationId: 'getX', responses: {} } } },
  };

  it('uses PORT env fallback when no --port given (web transport)', () => {
    const code = generateMcpServerCode(api, { input: '', output: '', transport: 'web' }, 's', '1');
    expect(code).toContain('Number(process.env.PORT) || 3000');
  });

  it('uses the explicit port when provided', () => {
    const code = generateMcpServerCode(
      api,
      { input: '', output: '', transport: 'web', port: 8080 },
      's',
      '1'
    );
    expect(code).toContain('setupWebServer(createServer, 8080)');
  });

  it('exports main and omits auto-invoke in lib mode', () => {
    const lib = generateMcpServerCode(api, { input: '', output: '', generateLib: true }, 's', '1');
    expect(lib).toContain('export async function main()');
    expect(lib).not.toContain("process.on('SIGINT'");
    const normal = generateMcpServerCode(api, { input: '', output: '' }, 's', '1');
    expect(normal).toContain("process.on('SIGINT'");
    expect(normal).not.toContain('export async function main()');
  });
});

// --- regression: tool definition map is well-formed -------------------------

describe('generated tool definition map shape', () => {
  it('includes all expected fields', () => {
    const tool: McpToolDefinition = {
      name: 'getX',
      description: 'gets x',
      inputSchema: { type: 'object', properties: {} },
      method: 'get',
      pathTemplate: '/x',
      parameters: [],
      executionParameters: [],
      securityRequirements: [],
      operationId: 'getX',
      tags: ['t'],
      deprecated: false,
    };
    const code = generateToolDefinitionMap([tool]);
    expect(code).toContain('"getX"');
    expect(code).toContain('method: "get"');
    expect(code).toContain('pathTemplate: "/x"');
    expect(code).toContain('tags: ["t"]');
    expect(code).toContain('deprecated: false');
  });
});

// --- cloudflare-worker target ----------------------------------------------

describe('cloudflare-worker target', () => {
  it('exposes a generator that returns the expected file set', () => {
    const files = generateCloudflareWorkerFiles(
      // minimal stub: empty tools, name/version
      {
        tools: [],
        serverName: 'test-mcp',
        serverVersion: '0.1.0',
        securitySchemes: undefined,
        baseUrl: 'https://api.example.com',
      }
    );
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        '.dev.vars.example',
        '.gitignore',
        'README.md',
        'package.json',
        'src/index.ts',
        'src/playground.ts',
        'src/tools.ts',
        'src/upstream-auth.ts',
        'tsconfig.json',
        'wrangler.jsonc',
      ].sort()
    );
  });

  it('generates a .gitignore that excludes local secrets but keeps the example', () => {
    const files = generateCloudflareWorkerFiles({
      tools: [],
      serverName: 'test-mcp',
      serverVersion: '0.1.0',
      securitySchemes: undefined,
      baseUrl: 'https://api.example.com',
    });
    const gitignore = fileContent(files, '.gitignore');
    expect(gitignore).toContain('.dev.vars');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.wrangler/');
    // The committed template must stay tracked.
    expect(gitignore).toContain('!.dev.vars.example');
  });

  it('treats an http scheme as Basic regardless of casing (e.g. "Basic")', () => {
    const files = generateCloudflareWorkerFiles({
      tools: [],
      serverName: 'test-mcp',
      serverVersion: '0.1.0',
      securitySchemes: {
        basicAuth: { type: 'http', scheme: 'Basic' },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://api.example.com',
    });
    // Embedded metadata is normalized to lowercase so the runtime `=== 'basic'`
    // check matches and the username/password env vars (not a bearer token) are used.
    const auth = fileContent(files, 'src/upstream-auth.ts');
    expect(auth).toContain('"scheme": "basic"');
    const devVars = fileContent(files, '.dev.vars.example');
    expect(devVars).toContain('BASICAUTH_USERNAME');
    expect(devVars).toContain('BASICAUTH_PASSWORD');
    expect(devVars).not.toContain('BASICAUTH_TOKEN');
  });

  const petstorePath = fileURLToPath(new URL('./fixtures/real-petstore.json', import.meta.url));
  const fileContent = (
    files: ReturnType<typeof generateCloudflareWorkerFiles>,
    path: string
  ): string => {
    const f = files.find((x) => x.path === path);
    if (!f) throw new Error(`missing generated file: ${path}`);
    return f.content;
  };

  it('emits a Workers-native src/index.ts (no node/process/eval, no hardcoded header)', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: undefined,
      baseUrl: 'https://petstore.example.com',
    });
    const index = fileContent(files, 'src/index.ts');

    expect(index).toContain("from '@modelcontextprotocol/server'");
    expect(index).toContain('createMcpHandler,');
    expect(index).toContain("const MCP_ROUTE = '/mcp'");
    // One handler per request serves MCP 2026-07-28 and 2025-era clients.
    expect(index).toContain(
      'createMcpHandler(() => createServer(env, forwardedHeaders)).fetch(request)'
    );
    expect(index).toContain('await fetch(');
    // No dependency on the Cloudflare `agents` package (raw SDK transport only).
    expect(index).not.toContain('agents/mcp');
    expect(index).not.toContain('node:https');
    expect(index).not.toContain('process.env');
    expect(index).not.toMatch(/\beval\s*\(/);
    expect(index).not.toContain('x-api-key');
  });

  it('emits src/tools.ts with embedded names, no zod and no eval', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    expect(tools.length).toBeGreaterThan(0);
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: undefined,
      baseUrl: 'https://petstore.example.com',
    });
    const toolsFile = fileContent(files, 'src/tools.ts');

    expect(toolsFile).toContain(JSON.stringify(tools[0].name));
    expect(toolsFile).toContain('export const toolDefinitionMap');
    expect(toolsFile).not.toContain('zod');
    expect(toolsFile).not.toMatch(/\beval\s*\(/);
    // Arguments are validated against the JSON Schema at runtime instead.
    const index = fileContent(files, 'src/index.ts');
    expect(index).toContain("import { Validator, type OutputUnit } from '@cfworker/json-schema'");
    expect(index).toContain('validateToolArguments(def.name, def.inputSchema, args)');
    expect(index).not.toContain('zod');
    const pkg = JSON.parse(fileContent(files, 'package.json'));
    expect(pkg.dependencies).toHaveProperty('@cfworker/json-schema');
    expect(pkg.dependencies).not.toHaveProperty('zod');
  });

  it('keeps secrets out of wrangler.jsonc and lists the api-key var in .dev.vars.example', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const wrangler = fileContent(files, 'wrangler.jsonc');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"API_BASE_URL"');
    expect(wrangler).toContain('"main": "src/index.ts"');
    expect(wrangler).not.toMatch(/API_KEY/i);

    const devVars = fileContent(files, '.dev.vars.example');
    expect(devVars).toContain('APIKEYAUTH_API_KEY');
  });

  it('places an apiKey in=query scheme into url.searchParams', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        qkey: { type: 'apiKey', in: 'query', name: 'api_key' },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const auth = fileContent(files, 'src/upstream-auth.ts');

    expect(auth).toContain('SECURITY_SCHEMES');
    expect(auth).toContain('"in": "query"');
    expect(auth).toContain('"name": "api_key"');
    expect(auth).toContain('url.searchParams.set');
    // index.ts delegates to the auth module instead of embedding scheme metadata.
    expect(fileContent(files, 'src/index.ts')).toContain(
      "import { applyAuth, describeMissingCredentials, requiresCredentials } from './upstream-auth.js'"
    );
  });

  it('emits an oauth2 client-credentials token fetch (with scope forwarding) and dev vars', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        oauth: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } },
        },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const auth = fileContent(files, 'src/upstream-auth.ts');

    // Token request is built with URLSearchParams (grant_type + optional scope).
    expect(auth).toContain("grant_type: 'client_credentials'");
    expect(auth).toContain('tokenUrl');
    // Scopes from the operation's securityRequirements are forwarded.
    expect(auth).toContain("body.set('scope', scope)");

    const devVars = fileContent(files, '.dev.vars.example');
    expect(devVars).toContain('OAUTH_CLIENT_ID');
    expect(devVars).toContain('OAUTH_CLIENT_SECRET');
  });

  it('emits an oauth2 TOKEN_URL secret hint when the spec omits the token URL', async () => {
    const files = generateCloudflareWorkerFiles({
      tools: [],
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        oauth: { type: 'oauth2', flows: {} },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const devVars = fileContent(files, '.dev.vars.example');
    const readme = fileContent(files, 'README.md');
    // Both the dev vars and the README deploy steps must mention TOKEN_URL.
    expect(devVars).toContain('OAUTH_TOKEN_URL');
    expect(readme).toContain('OAUTH_TOKEN_URL');
  });

  it('places an http bearer scheme into an Authorization header from a TOKEN secret', async () => {
    const files = generateCloudflareWorkerFiles({
      tools: [],
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const auth = fileContent(files, 'src/upstream-auth.ts');
    // The scheme metadata is embedded; the env-var name is derived at runtime
    // from the scheme name (`${upper}_TOKEN`), not baked into the source.
    expect(auth).toContain('"type": "http"');
    expect(auth).toContain('"scheme": "bearer"');
    expect(auth).toContain('${upper}_TOKEN');
    expect(auth).toContain('Bearer ${token}');

    // The concrete secret name is what the user must set, documented in dev vars.
    const devVars = fileContent(files, '.dev.vars.example');
    expect(devVars).toContain('BEARERAUTH_TOKEN');
  });

  it('places an apiKey in=cookie scheme into an encoded Cookie header', async () => {
    const files = generateCloudflareWorkerFiles({
      tools: [],
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: {
        ckey: { type: 'apiKey', in: 'cookie', name: 'session' },
      } as OpenAPIV3.ComponentsObject['securitySchemes'],
      baseUrl: 'https://petstore.example.com',
    });
    const auth = fileContent(files, 'src/upstream-auth.ts');
    expect(auth).toContain('"in": "cookie"');
    expect(auth).toContain('"name": "session"');
    expect(auth).toContain("headers['cookie']");
    // Cookie value is URL-encoded to stay RFC 6265 safe.
    expect(auth).toContain('encodeURIComponent(key)');
  });

  it('guards against a non-absolute base URL at runtime with an actionable error', async () => {
    const tools = await getToolsFromOpenApi(petstorePath, { dereference: true });
    const files = generateCloudflareWorkerFiles({
      tools,
      serverName: 'petstore-mcp',
      serverVersion: '1.0.0',
      securitySchemes: undefined,
      // A relative base URL (common when the spec's server is e.g. "/api/v3").
      baseUrl: '/api/v3',
    });
    const index = fileContent(files, 'src/index.ts');
    // The Workers runtime can't build a request from a relative base URL; the
    // generated code must check for an absolute http(s) URL and return an MCP
    // error explaining how to fix it, rather than throwing "Invalid URL string".
    expect(index).toContain('is not absolute');
    expect(index).toContain('API_BASE_URL');
    // It checks for an http(s) scheme before constructing the URL.
    expect(index).toMatch(/test\(baseUrl\)/);
  });
});

// --- generated project manifests -------------------------------------------------

describe('generated package.json', () => {
  const manifest = (transport: string) =>
    JSON.parse(generatePackageJson('demo', '1.0.0', transport));

  it('requires Node 22 for the generator and every generated Node project', () => {
    // The generator itself needs 22.19+ (@apidevtools/swagger-parser 13 and commander 15).
    expect(rootPackageJson.engines.node).toBe('>=22.19.0');
    for (const transport of ['stdio', 'web', 'streamable-http']) {
      const pkg = manifest(transport);
      expect(pkg.engines.node).toBe('>=22');
      expect(pkg.devDependencies['@types/node']).toMatch(/^\^22\./);
    }
  });

  it('validates with @cfworker/json-schema instead of zod and json-schema-to-zod', () => {
    for (const transport of ['stdio', 'web', 'streamable-http']) {
      const deps = manifest(transport).dependencies;
      expect(deps).toHaveProperty('@cfworker/json-schema');
      expect(deps).not.toHaveProperty('zod');
      expect(deps).not.toHaveProperty('json-schema-to-zod');
    }
  });
});
