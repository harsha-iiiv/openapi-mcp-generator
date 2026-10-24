/**
 * Type-level checks of the exported API: compiles a consumer snippet against the
 * package's own types (strict mode), so a property missing from an exported type
 * fails here even though vitest itself does not type-check.
 */
import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

describe('exported types', () => {
  it('declares baseUrl on McpToolDefinition', () => {
    const dir = fs.mkdtempSync(path.join(repoRoot, '.test-tmp-types-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'consumer.ts'),
        [
          "import { getToolsFromOpenApi, type McpToolDefinition } from '../src/api.js';",
          '',
          'export async function baseUrls(spec: string): Promise<string[]> {',
          '  const tools: McpToolDefinition[] = await getToolsFromOpenApi(spec);',
          "  return tools.map((tool) => tool.baseUrl ?? '');",
          '}',
          '',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            esModuleInterop: true,
            strict: true,
            skipLibCheck: true,
            resolveJsonModule: true,
            noEmit: true,
            types: ['node'],
          },
          files: ['consumer.ts'],
        })
      );
      execFileSync('node', [tscEntry, '-p', path.join(dir, 'tsconfig.json')], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
