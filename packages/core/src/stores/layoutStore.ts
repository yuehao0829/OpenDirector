import { create } from 'zustand';
import { clamp } from '../utils/common';

const MIN_PREVIEW_WIDTH = 280;
const RESIZER_WIDTH = 4;

interface LayoutState {
  // Panel sizes in pixels
  assetsWidth: number;
  inspectorWidth: number;
  topSectionHeight: number;

  // Expanded state
  inspectorExpanded: boolean;

  // Initialization flag
  isInitialized: boolean;

  // Actions
  setAssetsWidth: (width: number) => void;
  setInspectorWidth: (width: number) => void;
  setTopSectionHeight: (height: number) => void;
  toggleInspectorExpanded: () => void;
  initializeLayout: (viewportWidth: number, topSectionPixelHeight: number) => void;
  rescaleLayout: (oldViewportWidth: number, newViewportWidth: number) => void;
}

// Default sizes (conservative fallback)
const DEFAULT_ASSETS_WIDTH = 280;
const DEFAULT_INSPECTOR_WIDTH = 280;
const DEFAULT_TOP_SECTION_HEIGHT_PERCENT = 0.45;

// Min/max constraints
const MIN_ASSETS_WIDTH = 200;
const MAX_ASSETS_WIDTH = 700;
const MIN_INSPECTOR_WIDTH = 250;
const MAX_INSPECTOR_WIDTH = 700;
const MIN_TOP_HEIGHT_PERCENT = 0.25;
const MAX_TOP_HEIGHT_PERCENT = 0.75;

export const useLayoutStore = create<LayoutState>((set) => ({
  assetsWidth: DEFAULT_ASSETS_WIDTH,
  inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
  topSectionHeight: DEFAULT_TOP_SECTION_HEIGHT_PERCENT,
  inspectorExpanded: false,
  isInitialized: false,

  setAssetsWidth: (width) => set({
    assetsWidth: clamp(width, MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH)
  }),

  setInspectorWidth: (width) => set({
    inspectorWidth: clamp(width, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)
  }),

  setTopSectionHeight: (height) => set({
    topSectionHeight: clamp(height, MIN_TOP_HEIGHT_PERCENT, MAX_TOP_HEIGHT_PERCENT)
  }),

  toggleInspectorExpanded: () => set((s) => ({ inspectorExpanded: !s.inspectorExpanded })),

  initializeLayout: (viewportWidth, topSectionPixelHeight) => {
    set((s) => {
      if (s.isInitialized) return s;

      // Target preview width for 16:9 aspect ratio
      const targetPreviewWidth = topSectionPixelHeight * (16 / 9);
      const remaining = viewportWidth - 2 * RESIZER_WIDTH - targetPreviewWidth;
      const panelWidth = clamp(remaining / 2, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH);

      // If even min widths don't fit, fall back to min values
      const minSideWidth = MIN_ASSETS_WIDTH + MIN_INSPECTOR_WIDTH;
      if (remaining < minSideWidth) {
        return {
          assetsWidth: MIN_ASSETS_WIDTH,
          inspectorWidth: MIN_INSPECTOR_WIDTH,
          isInitialized: true,
        };
      }

      return {
        assetsWidth: clamp(panelWidth, MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH),
        inspectorWidth: clamp(panelWidth, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
        isInitialized: true,
      };
    });
  },

  rescaleLayout: (oldViewportWidth, newViewportWidth) => {
    if (oldViewportWidth <= 0) return;
    const ratio = newViewportWidth / oldViewportWidth;
    set((s) => {
      if (!s.isInitialized) return s;
      return {
        assetsWidth: clamp(Math.round(s.assetsWidth * ratio), MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH),
        inspectorWidth: clamp(Math.round(s.inspectorWidth * ratio), MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
      };
    });
  },
}));

// Export constraints for use in components
export const LAYOUT_CONSTRAINTS = {
  MIN_ASSETS_WIDTH,
  MAX_ASSETS_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MAX_INSPECTOR_WIDTH,
  MIN_TOP_HEIGHT_PERCENT,
  MAX_TOP_HEIGHT_PERCENT,
  MIN_PREVIEW_WIDTH,
  RESIZER_WIDTH,
};
