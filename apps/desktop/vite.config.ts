import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const defaultDevServerPort = 3000;
const configuredDevServerPort = Number.parseInt(
  process.env.OPENDIRECTOR_DEV_SERVER_PORT ?? String(defaultDevServerPort),
  10,
);
const devServerPort =
  Number.isFinite(configuredDevServerPort) && configuredDevServerPort > 0
    ? configuredDevServerPort
    : defaultDevServerPort;

const prebundledDeps = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@tauri-apps/plugin-sql',
  '@tauri-apps/plugin-fs',
  '@tauri-apps/plugin-os',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/path',
  '@tauri-apps/api/window',
] as const;

const entryFiles = ['./src/main.tsx', './src/App.tsx'];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@opendirector/core': path.resolve(__dirname, '../../packages/core/src'),
      '@opendirector/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@opendirector/generation': path.resolve(__dirname, '../../packages/generation/src'),
    },
  },
  server: {
    port: devServerPort,
    strictPort: true,
    warmup: {
      clientFiles: entryFiles,
    },
  },
  optimizeDeps: {
    entries: entryFiles,
    include: [...prebundledDeps],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
