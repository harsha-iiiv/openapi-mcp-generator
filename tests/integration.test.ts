/**
 * Integration smoke test: generate a server from a fixture spec and TypeScript
 * type-check the generated `src/index.ts` to catch build-breaking regressions
 * (e.g. issue #65). Uses the root project's installed peer deps for resolution.
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixture = path.join(here, 'fixtures', 'sample-api.json');
const xquikOpenApi31Fixture = path.join(here, 'fixtures', 'xquik-openapi31.json');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');

/**
 * Type-check generated TS against the repo's node_modules. The generated
 * project lives under the repo root so Node's upward module resolution finds
 * the installed peer deps (@modelcontextprotocol/sdk, zod, axios, ...).
 */
function typecheckGenerated(srcDir: string): { ok: boolean; output: string } {
  const tmpTsconfig = path.join(srcDir, '..', 'tsconfig.check.json');
  fs.writeFileSync(
    tmpTsconfig,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
      },
      include: [path.join(srcDir, '**/*.ts')],
    })
  );
  try {
    const out = execFileSync(
      'node',
      [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tmpTsconfig],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
    );
    return { ok: true, output: out };
  } catch (e: any) {
    return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** Generate a server from a fixture for integration assertions. */
function generate(outDir: string, extraArgs: string[], specFixture = fixture): void {
  execFileSync(
    'node',
    [cliEntry, '--input', specFixture, '--output', outDir, '--force', ...extraArgs],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
  );
}

describe('integration: generate + typecheck', () => {
  let workdir: string;

  beforeAll(() => {
    // Build the generator so dist/index.js exists.
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    // Generate under the repo root so upward node_modules resolution finds peer deps.
    workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-'));
  });

  afterAll(() => {
    if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('generates a stdio server that type-checks (regression for #65)', () => {
    const out = path.join(workdir, 'stdio');
    generate(out, []);
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');

    // #67: malicious ${...} in description is escaped, not live in the template.
    expect(indexTs).toContain('\\${not_injected}');
    // #59 / #49: tags + deprecated surfaced.
    expect(indexTs).toContain('[DEPRECATED]');
    expect(indexTs).toContain('(Tags: items, public)');
    // #56: no literal SCHEMENAME env lookups.
    expect(indexTs).not.toContain('OAUTH_CLIENT_ID_SCHEMENAME');
    // #41: array param serializer present.
    expect(indexTs).toContain('paramsSerializer');
    // #65: content-type coercion present.
    expect(indexTs).toContain("String(response.headers['content-type'] ?? '')");

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });

  it('generates with all opt-in flags and still type-checks', () => {
    const out = path.join(workdir, 'full');
    generate(out, [
      '--insecure',
      '--custom-auth',
      '--oauth-creds-in-body',
      '--header-passthrough',
      'X-API-Key,X-Tenant',
      '--max-tool-name-length',
      '40',
    ]);
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain("import * as https from 'https'");
    expect(indexTs).toContain("import { applyCustomAuth } from './auth.js'");
    // Header passthrough uses a request-scoped AsyncLocalStorage, not a global.
    expect(indexTs).toContain("from 'async_hooks'");
    expect(indexTs).toContain('inboundHeaderStore');
    expect(indexTs).not.toContain('globalThis');
    // Custom auth short-circuits built-in auth.
    expect(indexTs).toContain('if (!customAuthHandled)');
    // auth.ts stub generated
    expect(fs.existsSync(path.join(out, 'src', 'auth.ts'))).toBe(true);

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });

  it('forwards request-scoped headers via AsyncLocalStorage in web transport', () => {
    // Web transport deps (hono, etc.) aren't installed at the repo root, so we
    // assert on the generated source shape rather than full type-checking it.
    const out = path.join(workdir, 'web-passthrough');
    generate(out, ['--transport', 'web', '--header-passthrough', 'X-API-Key']);
    const webTs = fs.readFileSync(path.join(out, 'src', 'web-server.ts'), 'utf8');
    expect(webTs).toContain("import { inboundHeaderStore } from './index.js'");
    expect(webTs).toContain('inboundHeaderStore.run(');
    expect(webTs).not.toContain('__mcpInboundHeaders');
    expect(webTs).toContain("path.join(__dirname, '..', 'public')");
    expect(webTs).not.toContain("path.join(__dirname, '..', '..', 'public')");
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain('export const inboundHeaderStore');
  });

  it('resolves Streamable HTTP assets from the generated public directory (issue #45)', () => {
    const out = path.join(workdir, 'streamable-public-path');
    const relativeOut = path.relative(repoRoot, out);
    expect(path.isAbsolute(relativeOut)).toBe(false);
    generate(relativeOut, ['--transport', 'streamable-http']);
    const streamableTs = fs.readFileSync(path.join(out, 'src', 'streamable-http.ts'), 'utf8');

    expect(streamableTs).toContain("path.join(__dirname, '..', 'public')");
    expect(streamableTs).not.toContain("path.join(__dirname, '..', '..', 'public')");
    expect(streamableTs).toContain('await c.req.raw.clone().json()');
    expect(streamableTs).not.toContain('await c.req.json()');

    const clientHtml = fs.readFileSync(path.join(out, 'public', 'index.html'), 'utf8');
    expect(clientHtml).toContain("const protocolVersion = '2025-03-26'");
    expect(clientHtml).toMatch(/params:\s*\{\s*protocolVersion,/);
    expect(clientHtml).toContain('clientInfo: {');
    expect(clientHtml).not.toContain('clientName:');
    expect(clientHtml).toContain("method: 'notifications/initialized'");
    expect(clientHtml).toContain("method: 'tools/list'");
    expect(clientHtml).toContain("method: 'tools/call'");
    expect(clientHtml).not.toContain("method: 'listTools'");
    expect(clientHtml).not.toContain("method: 'callTool'");
    expect(clientHtml).toContain("'Accept': 'application/json, text/event-stream'");
  });

  it('rejects external $ref by default (SSRF guard)', () => {
    const badSpec = path.join(workdir, 'bad.json');
    fs.writeFileSync(
      badSpec,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'b', version: '1' },
        paths: {
          '/x': {
            get: {
              operationId: 'getX',
              responses: { '200': { $ref: 'http://169.254.169.254/latest' } },
            },
          },
        },
      })
    );
    let failed = false;
    let output = '';
    try {
      execFileSync(
        'node',
        [cliEntry, '--input', badSpec, '--output', path.join(workdir, 'bad-out'), '--force'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (e: any) {
      failed = true;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    // Assert it failed specifically because of the external-ref SSRF guard,
    // not some unrelated regression.
    expect(output).toMatch(/external \$ref|SSRF|allow-external-refs/i);
  });

  it('allows external $ref when --allow-external-refs is set (guard does not block)', () => {
    // A spec whose only "external" ref is a local-style ref must generate fine
    // with the flag on; this exercises the allow path without a network call.
    const okSpec = path.join(workdir, 'allow.json');
    fs.writeFileSync(
      okSpec,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'ok', version: '1' },
        paths: {
          '/x': {
            get: { operationId: 'getX', responses: { '200': { description: 'ok' } } },
          },
        },
      })
    );
    const out = path.join(workdir, 'allow-out');
    // Should not throw with the flag set.
    execFileSync(
      'node',
      [cliEntry, '--input', okSpec, '--output', out, '--allow-external-refs', '--force'],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
    );
    expect(fs.existsSync(path.join(out, 'src', 'index.ts'))).toBe(true);
  });

  it('generates a real-world spec (Swagger Petstore) that type-checks', () => {
    const realSpec = path.join(here, 'fixtures', 'real-petstore.json');
    const out = path.join(workdir, 'petstore');
    execFileSync('node', [cliEntry, '--input', realSpec, '--output', out, '--force'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');

    // All generated tool names respect the 64-char limit (issue #4).
    const names = [...indexTs.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(64);

    // Every {pathParam} appears in its tool's executionParameters (issues #20/#44/#54).
    const toolRe = /pathTemplate: "([^"]+)",\s*executionParameters: (\[[^\]]*\])/g;
    let m: RegExpExecArray | null;
    let pathParamTools = 0;
    while ((m = toolRe.exec(indexTs))) {
      const tmpl = m[1];
      const params = [...tmpl.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
      if (params.length === 0) continue;
      pathParamTools++;
      const execNames = new Set(
        (JSON.parse(m[2]) as { name: string; in: string }[]).map((e) => e.name)
      );
      for (const p of params)
        expect(execNames.has(p), `missing path param ${p} in ${tmpl}`).toBe(true);
    }
    expect(pathParamTools).toBeGreaterThan(0);

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });

  it('generates an API-key protected Xquik read API spec that type-checks', () => {
    const xquikSpec = path.join(here, 'fixtures', 'xquik-read-api.json');
    const out = path.join(workdir, 'xquik');
    generate(out, [], xquikSpec);

    const sourceSchema = JSON.parse(fs.readFileSync(xquikSpec, 'utf8'));
    const tweetsSchema =
      sourceSchema.paths['/api/v1/x/tweets/search'].get.responses['200'].content['application/json']
        .schema.properties.tweets;
    expect(tweetsSchema).toMatchObject({
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          author: {
            type: 'object',
            properties: {
              username: { type: 'string' },
            },
          },
        },
      },
    });

    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain('searchTweets');
    expect(indexTs).toContain('https://xquik.com');
    expect(indexTs).toContain('"x-api-key"');
    expect(indexTs).toContain('"oauthBearer"');
    expect(indexTs).toContain('BEARER_TOKEN_${schemeName.replace');
    expect(indexTs).toContain("headers['authorization'] = `Bearer ${token}`");

    const envExample = fs.readFileSync(path.join(out, '.env.example'), 'utf8');
    expect(envExample).toContain('API_KEY_APIKEY=your_api_key_here');
    expect(envExample).toContain('BEARER_TOKEN_OAUTHBEARER=your_bearer_token_here');

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });

  it('generates an OpenAPI 3.1 Xquik spec that type-checks', () => {
    const out = path.join(workdir, 'xquik-openapi31');
    generate(out, [], xquikOpenApi31Fixture);

    const sourceSchema = JSON.parse(fs.readFileSync(xquikOpenApi31Fixture, 'utf8'));
    const monitorBillingSchema =
      sourceSchema.paths['/api/v1/account'].get.responses['200'].content['application/json'].schema
        .properties.monitorBilling;
    expect(monitorBillingSchema).toMatchObject({
      type: 'object',
      required: [
        'activeDailyEstimate',
        'activeHourlyBurn',
        'creditsPerActiveMonitorDay',
        'creditsPerActiveMonitorHour',
        'eventsIncluded',
        'instantCheckIntervalSeconds',
        'unlimitedSlots',
      ],
      properties: {
        activeDailyEstimate: { type: 'string' },
        activeHourlyBurn: { type: 'string' },
        creditsPerActiveMonitorDay: { type: 'string' },
        creditsPerActiveMonitorHour: { type: 'string' },
        eventsIncluded: { type: 'boolean' },
        instantCheckIntervalSeconds: { type: 'integer' },
        unlimitedSlots: { type: 'boolean' },
      },
    });

    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain('getAccount');
    expect(indexTs).toContain('updateAccount');
    expect(indexTs).toContain('searchTweets');
    expect(indexTs).toContain(
      '"queryType":{"type":"string","enum":["Latest","Top"],"default":"Latest"'
    );
    expect(indexTs).toContain('{"name":"queryType","in":"query"}');
    expect(indexTs).toContain('"apiKey"');
    expect(indexTs).toContain('"oauthBearer"');
    expect(indexTs).toContain('"x-api-key"');

    const envExample = fs.readFileSync(path.join(out, '.env.example'), 'utf8');
    expect(envExample).toContain('API_KEY_APIKEY');
    expect(envExample).toContain('BEARER_TOKEN_OAUTHBEARER');

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });
});
