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
    expect(indexTs).toContain('__mcpInboundHeaders');
    // auth.ts stub generated
    expect(fs.existsSync(path.join(out, 'src', 'auth.ts'))).toBe(true);

    const res = typecheckGenerated(path.join(out, 'src'));
    expect(res.ok, res.output).toBe(true);
  });

  it('rejects external $ref by default but allows with the flag', () => {
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
    try {
      execFileSync(
        'node',
        [cliEntry, '--input', badSpec, '--output', path.join(workdir, 'bad-out'), '--force'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
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
});
