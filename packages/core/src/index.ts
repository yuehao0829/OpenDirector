// Types
export * from './types';

// Constants
export * from './constants';

// Stores
export * from './stores';

// i18n
export * from './i18n';

// Services
export * from './services';

// Adapters (explicitly export to avoid conflicts)
export {
  getTauriPlatformAdapter,
  getPlatformAdapter,
} from './adapters';

// Adapter types (use export type for interfaces)
export type {
  StorageAdapter,
  DatabaseAdapter,
  FileSystemAdapter,
  FileSelectOptions,
  FileFilter,
  PlatformAdapter,
} from './adapters';

// Utils
export * from './utils';
