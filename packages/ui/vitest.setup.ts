import { initializeI18n } from '@opendirector/core/i18n';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  writable: true,
  configurable: true,
});

await initializeI18n('zh-CN');
