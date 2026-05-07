import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = fileURLToPath(new URL('../core/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@opendirector\/core\/types$/,
        replacement: `${coreSrc}/types/index.ts`,
      },
      {
        find: '@opendirector/core',
        replacement: coreSrc,
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
  },
});
