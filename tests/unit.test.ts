/**
 * Unit tests for v4.0.0 security fixes, bug fixes, and features.
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { OpenAPIV3 } from 'openapi-types';

import { sanitizeForTemplate } from '../src/utils/helpers.js';
import {
  assertNoExternalRefs,
  isExternalHttpRef,
  ExternalRefError,
  parseSpecSecurely,
} from '../src/utils/parser-security.js';
import {
  extractToolsFromApi,
  truncateToolName,
  shortenToolName,
  abbreviateToolName,
  splitNameIntoWords,
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

// --- #4: tool name truncation ------------------------------------------------

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
  it('requires only a username (username != null) and defaults password', () => {
    const code = generateExecuteApiToolFunction();
    expect(code).toContain('username != null');
    expect(code).toContain("password ?? ''");
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
    expect(code).toContain('setupWebServer(server, 8080)');
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
        'README.md',
        'package.json',
        'src/index.ts',
        'src/tools.ts',
        'tsconfig.json',
        'wrangler.jsonc',
      ].sort()
    );
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

    expect(index).toContain("import { createMcpHandler } from 'agents/mcp'");
    expect(index).toContain("import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'");
    expect(index).toContain("{ route: '/mcp' }");
    expect(index).toContain('await fetch(');
    expect(index).not.toContain('node:https');
    expect(index).not.toContain('process.env');
    expect(index).not.toMatch(/\beval\s*\(/);
    expect(index).not.toContain('x-api-key');
  });

  it('emits src/tools.ts with embedded names + build-time zod and no eval', async () => {
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
    expect(toolsFile).toContain('export const toolZodShapes');
    expect(toolsFile).toContain("import { z } from 'zod'");
    expect(toolsFile).not.toMatch(/\beval\s*\(/);
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
    const index = fileContent(files, 'src/index.ts');

    expect(index).toContain('SECURITY_SCHEMES');
    expect(index).toContain('"in": "query"');
    expect(index).toContain('"name": "api_key"');
    expect(index).toContain('url.searchParams.set');
  });

  it('emits an oauth2 client-credentials token fetch and the matching dev vars', async () => {
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
    const index = fileContent(files, 'src/index.ts');

    expect(index).toContain('grant_type=client_credentials');
    expect(index).toContain('tokenUrl');

    const devVars = fileContent(files, '.dev.vars.example');
    expect(devVars).toContain('OAUTH_CLIENT_ID');
    expect(devVars).toContain('OAUTH_CLIENT_SECRET');
  });
});
