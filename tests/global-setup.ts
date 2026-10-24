/**
 * Vitest global setup: build the generator once so dist/ matches src/.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
}
