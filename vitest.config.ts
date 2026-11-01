import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, not built dist/.
    alias: [
      {
        find: /^@claw-pay\/(.+)$/,
        replacement: fileURLToPath(new URL('./packages/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // CI rule: no network. Tests that need a server use loopback only; the global fetch always rejects.
    setupFiles: ['./test-setup/no-network.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/bin/**'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
