import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build the generator once before any test file runs (tests spawn the CLI
    // from dist/ and generated projects resolve deps from the repo root).
    globalSetup: ['./tests/global-setup.ts'],
    // Test files generate, compile and run projects under the repo root; run
    // them one at a time so builds and spawned servers never race.
    fileParallelism: false,
  },
});
