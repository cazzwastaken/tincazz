import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/support/resolve-ts.ts'],
    // Property and end-to-end tests are slow when the whole suite runs in parallel.
    testTimeout: 20_000,
    // Never collect tests from nested worktrees.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
