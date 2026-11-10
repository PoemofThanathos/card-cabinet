import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/rules.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15000,
  },
});
