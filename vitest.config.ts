import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // Slightly below the current numbers (l92/s92/f95/b83): the gate is
      // against silent regression, not a target to chase.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 92,
        branches: 80,
      },
    },
  },
});
