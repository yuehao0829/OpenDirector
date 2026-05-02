/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Vite environment variables
  [key: `VITE_${string}`]: string;
  // Tauri environment variables
  [key: `TAURI_${string}`]: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
