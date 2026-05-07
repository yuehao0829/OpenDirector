import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireNativePreviewOcclusion,
  getNativePreviewOcclusionSnapshot,
  isNativePreviewOccluded,
} from './native-preview-occlusion';

describe('native-preview-occlusion', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    const mockWindow = Object.assign(new EventTarget(), {
      addEventListener: EventTarget.prototype.addEventListener,
      removeEventListener: EventTarget.prototype.removeEventListener,
      dispatchEvent: EventTarget.prototype.dispatchEvent,
    });

    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
      return;
    }

    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it('tracks nested blockers until all releases complete', () => {
    const releaseModal = acquireNativePreviewOcclusion('modal');
    const releaseSettings = acquireNativePreviewOcclusion('settings');
    const releaseNestedModal = acquireNativePreviewOcclusion('modal');

    expect(isNativePreviewOccluded()).toBe(true);
    expect(getNativePreviewOcclusionSnapshot()).toEqual({
      active: true,
      reasons: ['modal', 'settings'],
    });

    releaseNestedModal();
    expect(getNativePreviewOcclusionSnapshot()).toEqual({
      active: true,
      reasons: ['modal', 'settings'],
    });

    releaseSettings();
    expect(getNativePreviewOcclusionSnapshot()).toEqual({
      active: true,
      reasons: ['modal'],
    });

    releaseModal();
    expect(isNativePreviewOccluded()).toBe(false);
    expect(getNativePreviewOcclusionSnapshot()).toEqual({
      active: false,
      reasons: [],
    });
  });
});
