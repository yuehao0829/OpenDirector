import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@opendirector/core': fileURLToPath(new URL('../core/src', import.meta.url)),
      '@opendirector/ui': fileURLToPath(new URL('../ui/src', import.meta.url)),
      '@opendirector/generation': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
