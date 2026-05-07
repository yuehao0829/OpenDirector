import { describe, expect, it } from 'vitest';
import { normalizeLanguage } from './index';

describe('normalizeLanguage', () => {
  it('normalizes Chinese locales to zh-CN', () => {
    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN');
    expect(normalizeLanguage('zh_TW')).toBe('zh-CN');
  });

  it('normalizes English locales to en-US', () => {
    expect(normalizeLanguage('en')).toBe('en-US');
    expect(normalizeLanguage('en-US')).toBe('en-US');
    expect(normalizeLanguage('en_GB')).toBe('en-US');
  });

  it('falls back to zh-CN for unknown or empty locales', () => {
    expect(normalizeLanguage('ja-JP')).toBe('zh-CN');
    expect(normalizeLanguage('')).toBe('zh-CN');
    expect(normalizeLanguage(null)).toBe('zh-CN');
  });
});
