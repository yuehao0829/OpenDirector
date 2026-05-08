import { i18n, initializeI18n } from '@opendirector/core/i18n';
import { initReactI18next } from 'react-i18next';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  writable: true,
  configurable: true,
});

await initializeI18n('zh-CN');
initReactI18next.init(i18n);
