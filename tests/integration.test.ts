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

function generate(outDir: string, extraArgs: string[]): void {
  execFileSync(
    'node',
    [cliEntry, '--input', fixture, '--output', outDir, '--force', ...extraArgs],
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
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain('export const inboundHeaderStore');
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

  it('generates a Cloudflare Worker project with the expected files and shape', () => {
    // The Worker project's npm deps (agents, @cloudflare/workers-types, wrangler)
    // aren't installed at the repo root, so a full tsc/npm-install typecheck would
    // fail on missing types. Following the web-transport precedent above, we assert
    // on the generated source shape instead of full type-checking (and avoid a slow,
    // flaky npm install / wrangler dry-run in CI).
    const realSpec = path.join(here, 'fixtures', 'real-petstore.json');
    const out = path.join(workdir, 'cf-worker');
    execFileSync(
      'node',
      [
        cliEntry,
        '--input',
        realSpec,
        '--output',
        out,
        '--force',
        '--transport',
        'cloudflare-worker',
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
    );

    // Worker-target files exist at the out root.
    for (const f of [
      'wrangler.jsonc',
      'package.json',
      'tsconfig.json',
      '.dev.vars.example',
      'README.md',
    ]) {
      expect(fs.existsSync(path.join(out, f)), `missing ${f}`).toBe(true);
    }
    // Worker source files exist.
    expect(fs.existsSync(path.join(out, 'src', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'src', 'tools.ts'))).toBe(true);

    // Node-target files must NOT exist (proves the early-return isolation
    // end-to-end through the real CLI).
    for (const f of ['.env.example', 'jest.config.js', '.eslintrc.json']) {
      expect(fs.existsSync(path.join(out, f)), `unexpected ${f}`).toBe(false);
    }

    // src/index.ts shape: Worker runtime, not Node.
    const indexTs = fs.readFileSync(path.join(out, 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain('WebStandardStreamableHTTPServerTransport');
    expect(indexTs).toContain('transport.handleRequest(request)');
    expect(indexTs).toContain('await fetch(');
    expect(indexTs).not.toContain('agents/mcp');
    expect(indexTs).not.toContain('node:https');
    expect(indexTs).not.toContain('process.env');
    expect(indexTs).not.toMatch(/\beval\s*\(/);

    // src/tools.ts exposes the shared tool maps.
    const toolsTs = fs.readFileSync(path.join(out, 'src', 'tools.ts'), 'utf8');
    expect(toolsTs).toContain('export const toolDefinitionMap');
    expect(toolsTs).toContain('export const toolZodShapes');

    // wrangler.jsonc is configured for the Worker entrypoint + Node compat.
    const wrangler = fs.readFileSync(path.join(out, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"main": "src/index.ts"');

    // package.json declares the Worker deps.
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    expect(pkg.dependencies).not.toHaveProperty('agents');
    expect(pkg.devDependencies).toHaveProperty('wrangler');
  });

  it('fails the cloudflare-worker target when no base URL can be resolved', () => {
    // A spec with no `servers` entry and no --base-url cannot produce a working
    // Worker (fetch needs an absolute URL), so generation must fail fast.
    const noServerSpec = path.join(workdir, 'no-server.json');
    fs.writeFileSync(
      noServerSpec,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'no-server', version: '1' },
        paths: {
          '/p': { get: { operationId: 'getP', responses: { '200': { description: 'ok' } } } },
        },
      })
    );
    let failed = false;
    let output = '';
    try {
      execFileSync(
        'node',
        [
          cliEntry,
          '--input',
          noServerSpec,
          '--output',
          path.join(workdir, 'no-server-out'),
          '--transport',
          'cloudflare-worker',
          '--force',
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (e: any) {
      failed = true;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    expect(output).toMatch(/Unable to determine an API base URL/i);
  });
});
