/**
 * --toolguard: emits a mcp-toolguard policy tailored to the generated tools, plus a start:guarded
 * script. Default output must not change when the flag is off.
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOLGUARD_PACKAGE,
  classifyTools,
  generateToolguardPolicy,
  supportsToolguard,
  toolguardRunArgs,
  toolguardStartScript,
} from '../src/generator/toolguard.js';
import type { McpToolDefinition } from '../src/types/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixture = path.join(here, 'fixtures', 'sample-api.json');
const cliEntry = path.join(repoRoot, 'bin', 'openapi-mcp-generator.js');

function tool(name: string, method: string, annotations?: McpToolDefinition['annotations']) {
  return { name, method, annotations } as McpToolDefinition;
}

const TOOLS = [
  tool('listPets', 'get', { readOnlyHint: true }),
  tool('createPet', 'post', { readOnlyHint: false, destructiveHint: false }),
  tool('updatePet', 'put', { readOnlyHint: false, destructiveHint: true }),
  tool('deletePet', 'delete', { readOnlyHint: false, destructiveHint: true }),
  tool('softDeletePet', 'delete', { readOnlyHint: false, destructiveHint: false }), // x-mcp-annotations override
  tool('noHints', 'post'),
];

/** Pull a YAML block sequence of quoted names out of the policy (keeps the test free of a YAML dep). */
function listAfter(policy: string, key: string): string[] {
  const m = new RegExp(`\\n  ${key}:((?:\\n    - "[^"]*")*| \\[\\])`).exec(policy);
  if (!m) throw new Error(`no ${key} list in policy`);
  return [...m[1].matchAll(/- "([^"]*)"/g)].map((x) => x[1]);
}

describe('toolguard policy generation', () => {
  it('classifies tools from their annotations; missing hints count as writes', () => {
    expect(classifyTools(TOOLS)).toEqual({
      readOnly: ['listPets'],
      writes: ['createPet', 'updatePet', 'deletePet', 'softDeletePet', 'noHints'],
      destructive: ['updatePet', 'deletePet', 'noHints'],
    });
  });

  it('allows exactly the generated tools and requires approval for writes', () => {
    const policy = generateToolguardPolicy(TOOLS, 'petstore', 'stdio', 3000);
    expect(listAfter(policy, 'allow')).toEqual(TOOLS.map((t) => t.name));
    const approvalSection = policy.split('\napproval:')[1] ?? '';
    expect(listAfter(approvalSection, 'tools')).toEqual([
      'createPet',
      'updatePet',
      'deletePet',
      'softDeletePet',
      'noHints',
    ]);
    expect(policy).toContain('\n  unlisted: block\n');
    expect(policy).toContain('\n  unknown: block\n');
    expect(policy).toContain('\nmode: enforce');
    expect(policy).toContain('\nversion: 1\n');
    // Destructive tools are offered as a one-line deny, commented out.
    expect(policy).toContain('# deny: ["updatePet","deletePet","noHints"]');
    // No trailing whitespace.
    expect(policy.split('\n').some((l) => / $/.test(l))).toBe(false);
  });

  it('writes empty lists for an API with no writes', () => {
    const policy = generateToolguardPolicy([TOOLS[0]], 'ro', 'stdio', 3000);
    expect(listAfter(policy, 'tools')).toEqual([]);
    expect(policy).toContain('  tools: []');
  });

  it('quotes tool names so YAML never misreads them', () => {
    const policy = generateToolguardPolicy(
      [tool('yes', 'get', { readOnlyHint: true })],
      'x',
      'stdio',
      3000
    );
    expect(policy).toContain('    - "yes"');
  });

  it('wraps stdio servers by command and HTTP servers by URL', () => {
    expect(toolguardRunArgs('petstore', 'stdio', 3000)).toEqual([
      '-y',
      TOOLGUARD_PACKAGE,
      'run',
      '--policy',
      'toolguard.yaml',
      '--server-id',
      'petstore',
      '--',
      'node',
      'build/index.js',
    ]);
    expect(toolguardRunArgs('petstore', 'streamable-http', 4100).slice(-4)).toEqual([
      '--transport',
      'http',
      '--url',
      'http://localhost:4100/mcp',
    ]);
    expect(toolguardRunArgs('petstore', 'web', 3000).slice(-4)).toEqual([
      '--transport',
      'sse',
      '--url',
      'http://localhost:3000/sse',
    ]);
    expect(toolguardStartScript('petstore', 'stdio', 3000)).toMatch(/^npm run build && npx -y /);
    expect(toolguardStartScript('petstore', 'streamable-http', 3000)).toMatch(/^npx -y /);
  });

  it('bearer auth: sends the token header without writing the token anywhere', () => {
    const args = toolguardRunArgs('petstore', 'streamable-http', 3000, { bearer: true });
    expect(args.slice(-2)).toEqual(['--header', 'Authorization: Bearer <MCP_AUTH_TOKEN>']);
    // stdio has no inbound auth: no header even if asked.
    expect(toolguardRunArgs('petstore', 'stdio', 3000, { bearer: true })).not.toContain('--header');

    const script = toolguardStartScript('petstore', 'streamable-http', 3000, { bearer: true });
    expect(script).toContain(
      '--header "Authorization: Bearer ${TOOLGUARD_TOKEN:?export MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (see .env) first}"'
    );
    expect(toolguardStartScript('petstore', 'web', 3000)).not.toContain('--header');
    expect(toolguardStartScript('petstore', 'web', 3000)).not.toContain('TOOLGUARD_TOKEN');

    const policy = generateToolguardPolicy([], 'petstore', 'streamable-http', 3000, {
      bearer: true,
    });
    expect(policy).toContain('"--header","Authorization: Bearer <MCP_AUTH_TOKEN>"');
  });

  it.skipIf(process.platform === 'win32')(
    'bearer auth: start:guarded picks the token like the server (MCP_AUTH_TOKENS first entry, else MCP_AUTH_TOKEN)',
    () => {
      const script = toolguardStartScript('petstore', 'streamable-http', 3000, { bearer: true });
      // Run everything before `npx` in a real POSIX shell and print the resolved token.
      const pick = script.slice(0, script.indexOf('; npx '));
      const resolve = (env: Record<string, string>) =>
        spawnSync(
          'sh',
          [
            '-c',
            `${pick}; printf %s "\${TOOLGUARD_TOKEN:?export MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (see .env) first}"`,
          ],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } }
        );
      expect(resolve({ MCP_AUTH_TOKENS: 'new,old' }).stdout).toBe('new');
      expect(resolve({ MCP_AUTH_TOKENS: ' new , old' }).stdout).toBe('new');
      expect(resolve({ MCP_AUTH_TOKEN: 'single' }).stdout).toBe('single');
      expect(resolve({ MCP_AUTH_TOKENS: 'rot', MCP_AUTH_TOKEN: 'ignored' }).stdout).toBe('rot');
      const none = resolve({});
      expect(none.status).not.toBe(0);
      expect(none.stderr).toContain('export MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (see .env) first');
    }
  );

  it('documents transport-specific limits in the policy header', () => {
    const stdio = generateToolguardPolicy([], 'petstore', 'stdio', 3000);
    expect(stdio).toContain('Run npm run build first');
    expect(stdio).toContain('loads .env from its working directory');
    expect(stdio).toContain('"env" object');
    const http = generateToolguardPolicy([], 'petstore', 'streamable-http', 3000);
    expect(http).toContain('npm run build && npm run start:http');
    expect(http).toContain("connects to the server's\n# own port directly skips it");
    expect(http).toContain('Use --inbound-auth bearer');
    expect(http).not.toContain('loads .env');
  });

  it('does not support the Cloudflare Worker target', () => {
    expect(supportsToolguard(undefined)).toBe(true);
    expect(supportsToolguard('stdio')).toBe(true);
    expect(supportsToolguard('web')).toBe(true);
    expect(supportsToolguard('streamable-http')).toBe(true);
    expect(supportsToolguard('cloudflare-worker')).toBe(false);
  });
});

describe('--toolguard CLI', () => {
  let workdir: string;

  beforeAll(() => {
    // dist/ is built once by tests/global-setup.ts.
    workdir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-'));
  });

  afterAll(() => {
    if (workdir && fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
  });

  function generate(outDir: string, extraArgs: string[]): string {
    return execFileSync(
      'node',
      [cliEntry, '--input', fixture, '--output', outDir, '--force', ...extraArgs],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
    );
  }

  it('default output is unchanged: no policy, no start:guarded', () => {
    const out = path.join(workdir, 'plain');
    generate(out, []);
    expect(fs.existsSync(path.join(out, 'toolguard.yaml'))).toBe(false);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:guarded']).toBeUndefined();
  });

  it('stdio: writes toolguard.yaml for the spec tools and a start:guarded script', () => {
    const out = path.join(workdir, 'stdio');
    generate(out, ['--toolguard']);
    const policy = fs.readFileSync(path.join(out, 'toolguard.yaml'), 'utf8');
    // sample-api.json: GET /items, GET /items/{id}, POST /items.
    expect(listAfter(policy, 'allow').sort()).toEqual(['createItem', 'getItemById', 'listItems']);
    expect(listAfter(policy, 'tools')).toEqual(['createItem']);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:guarded']).toBe(
      `npm run build && npx -y ${TOOLGUARD_PACKAGE} run --policy toolguard.yaml --server-id sample-api -- node build/index.js`
    );
    // The generator adds no dependency for this.
    expect(JSON.stringify(pkg.dependencies)).not.toContain('toolguard');
  });

  it('respects tool filters: excluded operations are not allowed', () => {
    const out = path.join(workdir, 'filtered');
    generate(out, ['--toolguard', '--exclude-operations', 'createItem']);
    const policy = fs.readFileSync(path.join(out, 'toolguard.yaml'), 'utf8');
    expect(listAfter(policy, 'allow').sort()).toEqual(['getItemById', 'listItems']);
    expect(listAfter(policy, 'tools')).toEqual([]);
  });

  it('streamable-http: guards the local URL on the configured port', () => {
    const out = path.join(workdir, 'http');
    generate(out, ['--toolguard', '--transport', 'streamable-http', '--port', '4123']);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:guarded']).toContain(
      '--transport http --url http://localhost:4123/mcp'
    );
    expect(fs.readFileSync(path.join(out, 'toolguard.yaml'), 'utf8')).toContain(
      'npm run start:http'
    );
  });

  it('streamable-http with --inbound-auth bearer: start:guarded reads the token at run time', () => {
    const out = path.join(workdir, 'http-bearer');
    generate(out, ['--toolguard', '--transport', 'streamable-http', '--inbound-auth', 'bearer']);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:guarded']).toContain('${MCP_AUTH_TOKENS%%,*}');
    expect(pkg.scripts['start:guarded']).toContain('Authorization: Bearer ${TOOLGUARD_TOKEN:?');
  });

  it('--force without --toolguard keeps an existing toolguard.yaml but warns it may be stale', () => {
    const out = path.join(workdir, 'stale');
    generate(out, ['--toolguard']);
    const before = fs.readFileSync(path.join(out, 'toolguard.yaml'), 'utf8');
    const res = spawnSync('node', [cliEntry, '--input', fixture, '--output', out, '--force'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('is from an earlier --toolguard run and was not regenerated');
    expect(fs.readFileSync(path.join(out, 'toolguard.yaml'), 'utf8')).toBe(before);
    // A fresh run with --toolguard does not warn.
    const again = spawnSync(
      'node',
      [cliEntry, '--input', fixture, '--output', out, '--force', '--toolguard'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(again.stderr).not.toContain('earlier --toolguard run');
  });

  it('--generate-lib: warns and writes no policy or start:guarded', () => {
    const out = path.join(workdir, 'lib');
    const res = spawnSync(
      'node',
      [cliEntry, '--input', fixture, '--output', out, '--force', '--generate-lib', '--toolguard'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('--toolguard is not supported with --generate-lib');
    expect(fs.existsSync(path.join(out, 'toolguard.yaml'))).toBe(false);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.scripts['start:guarded']).toBeUndefined();
  });

  it('cloudflare-worker: warns and writes no policy', () => {
    const out = path.join(workdir, 'worker');
    const realSpec = path.join(here, 'fixtures', 'real-petstore.json');
    const res = spawnSync(
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
        '--toolguard',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('--toolguard is not supported with --transport cloudflare-worker');
    expect(fs.existsSync(path.join(out, 'toolguard.yaml'))).toBe(false);
  });
});
