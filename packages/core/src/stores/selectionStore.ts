/**
 * Selection Store
 *
 * Dual-focus system for managing user-selected entities:
 *
 * Primary Focus (timeline entities): fragment, scene, draft
 * - Controls Inspector content
 * - Controls AssetPanel "Generated" filter
 * - Supports multi-select via primaryIds[]
 * - primaryFocusId tracks the active item inside the current primary selection
 *
 * Secondary Focus (panel navigation): reference, asset
 * - Controls Preview window content
 * - Does NOT affect Inspector content
 * - Does NOT affect Generated filter
 *
 * Design Goals:
 * 1. Primary/secondary independence — secondary focus changes don't clear primary
 * 2. Single primary type — only one primary type active at a time
 * 3. Multi-select within primary type — support selecting multiple fragments or scenes
 * 4. Type-safe — explicitly support multiple entity types
 * 5. Extensible — easy to add new focus types
 * 6. Performance — use Set for O(1) id lookup
 */

import { create } from 'zustand';
import { storeEvents } from './store-events';

/**
 * Primary focus type (timeline entities that control Inspector / Generated filter)
 */
export type PrimaryFocusType = 'fragment' | 'scene' | 'draft' | null;

/**
 * Draft focus data (for unconfirmed fragments)
 */
export interface DraftSelection {
  trackId: string;
  start: number;
  duration: number;
}

/**
 * Reference selection data (needs fragmentId context because
 * the same asset can be used in multiple fragments with different crop params)
 */
export interface ReferenceSelection {
  fragmentId: string;
  referenceId: string;
}

/**
 * Secondary focus data (controls Preview window only)
 */
export type SecondaryFocus =
  | { type: 'reference'; referenceData: ReferenceSelection }
  | { type: 'asset'; assetIds: string[] }
  | null;

/**
 * Selection state
 *
 * Invariants:
 * - When primaryType is 'fragment' | 'scene', primaryIds is non-empty and primaryFocusId is one of primaryIds
 * - When primaryType is 'draft', draftData must exist
 * - When primaryType is null, primaryIds is [], primaryFocusId is null, and draftData is null
 * - secondaryFocus is independent and does not affect primary
 */
export interface SelectionState {
  primaryType: PrimaryFocusType;
  primaryIds: string[];
  // Active item inside the current primary selection; controls Inspector/Generated detail views
  primaryFocusId: string | null;

  // Only valid when primaryType === 'draft'
  draftData: DraftSelection | null;

  // Independent secondary focus (controls Preview only)
  secondaryFocus: SecondaryFocus;
}

/**
 * Store actions
 */
interface SelectionActions {
  // Primary: select single entity (replaces current primary selection, preserves secondary)
  selectFragment: (id: string) => void;
  selectScene: (id: string) => void;
  selectDraft: (draftData: DraftSelection) => void;
  focusFragment: (id: string) => void;

  // Secondary: set secondary focus (preserves primary)
  selectReference: (fragmentId: string, referenceId: string) => void;
  selectAsset: (id: string, multi?: boolean) => void;
  selectAssetRange: (fromId: string, toId: string, allAssetIds: string[]) => void;
  removeAssetFromSelection: (id: string) => void;
  clearSecondaryFocus: () => void;

  // Toggle: if already selected, remove; if not, add (same type only)
  toggleFragment: (id: string) => void;
  toggleScene: (id: string) => void;

  // Batch select (for selection box, Ctrl+A, etc.)
  selectFragments: (ids: string[]) => void;
  selectScenes: (ids: string[]) => void;

  // Clear all focus (both primary and secondary)
  clear: () => void;

  // Backward-compatible getter: focused primary id (or null)
  getSelectedId: () => string | null;

  // Check if a primary id is selected (O(1) via internal Set)
  isSelected: (id: string) => boolean;

  // Get selected primary IDs for a specific type (empty if type doesn't match)
  getSelectedIds: (type: 'fragment' | 'scene') => string[];
}

/**
 * Initial state
 */
const initialState: SelectionState = {
  primaryType: null,
  primaryIds: [],
  primaryFocusId: null,
  draftData: null,
  secondaryFocus: null,
};

export const useSelectionStore = create<SelectionState & SelectionActions>((set, get) => {
  // ── Factory functions ──

  // Set primary focus while preserving secondary
  function setPrimary(
    type: PrimaryFocusType,
    primaryIds: string[],
    draftData: DraftSelection | null,
    primaryFocusId: string | null,
  ) {
    return set((state) => ({
      primaryType: type,
      primaryIds,
      primaryFocusId,
      draftData,
      secondaryFocus: state.secondaryFocus,
    }));
  }

  // Get selected IDs for a given primary type (returns empty if type doesn't match)
  function getIdsForType(type: 'fragment' | 'scene', state: SelectionState): string[] {
    return state.primaryType === type ? state.primaryIds : [];
  }

  function makeToggle(type: 'fragment' | 'scene') {
    return (id: string) => set((state) => {
      if (state.primaryType !== type) {
        return {
          primaryType: type,
          primaryIds: [id],
          primaryFocusId: id,
          draftData: null,
          secondaryFocus: state.secondaryFocus,
        };
      }
      const idx = state.primaryIds.indexOf(id);
      if (idx >= 0) {
        const newIds = state.primaryIds.filter((_, i) => i !== idx);
        if (newIds.length === 0) {
          return {
            primaryType: null,
            primaryIds: [],
            primaryFocusId: null,
            draftData: null,
            secondaryFocus: state.secondaryFocus,
          };
        }
        return {
          primaryIds: newIds,
          primaryFocusId: state.primaryFocusId === id ? newIds[0] : state.primaryFocusId,
        };
      }
      return { primaryIds: [...state.primaryIds, id], primaryFocusId: id };
    });
  }

  function makeSelectBatch(type: 'fragment' | 'scene') {
    return (ids: string[]) => {
      if (ids.length === 0) {
        set((state) => ({
          primaryType: null,
          primaryIds: [],
          primaryFocusId: null,
          draftData: null,
          secondaryFocus: state.secondaryFocus,
        }));
      } else {
        set((state) => ({
          primaryType: type,
          primaryIds: ids,
          primaryFocusId: ids[0] ?? null,
          draftData: null,
          secondaryFocus: state.secondaryFocus,
        }));
      }
    };
  }

  function focusPrimary(type: 'fragment' | 'scene', id: string) {
    return set((state) => {
      if (state.primaryType !== type || !state.primaryIds.includes(id)) {
        return {
          primaryType: type,
          primaryIds: [id],
          primaryFocusId: id,
          draftData: null,
          secondaryFocus: state.secondaryFocus,
        };
      }
      if (state.primaryFocusId === id) return {};
      return { primaryFocusId: id };
    });
  }

  return {
    ...initialState,

    // ── Primary selection actions ──

    // Select single entity — clears previous primary selection, preserves secondary
    selectFragment: (id) => setPrimary('fragment', [id], null, id),
    selectScene: (id) => setPrimary('scene', [id], null, id),
    selectDraft: (draftData) => setPrimary('draft', [], draftData, null),
    focusFragment: (id) => focusPrimary('fragment', id),

    // ── Secondary selection actions ──

    // Select reference: set secondary focus, preserve primary
    selectReference: (fragmentId, referenceId) => set(() => ({
      secondaryFocus: { type: 'reference', referenceData: { fragmentId, referenceId } },
    })),

    selectAsset: (id, multi) => set((state) => {
      if (multi && state.secondaryFocus?.type === 'asset') {
        const ids = state.secondaryFocus.assetIds;
        if (ids.includes(id)) {
          const newIds = ids.filter((i) => i !== id);
          if (newIds.length === 0) return { secondaryFocus: null };
          return { secondaryFocus: { type: 'asset', assetIds: newIds } };
        }
        return { secondaryFocus: { type: 'asset', assetIds: [...ids, id] } };
      }
      return { secondaryFocus: { type: 'asset', assetIds: [id] } };
    }),

    // allAssetIds passed from UI to avoid circular store dependency
    selectAssetRange: (fromId, toId, allAssetIds) => {
      const fromIdx = allAssetIds.indexOf(fromId);
      const toIdx = allAssetIds.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      const start = Math.min(fromIdx, toIdx);
      const end = Math.max(fromIdx, toIdx);
      const rangeIds = allAssetIds.slice(start, end + 1);
      set(() => ({ secondaryFocus: { type: 'asset', assetIds: rangeIds } }));
    },

    removeAssetFromSelection: (id) => set((state) => {
      if (state.secondaryFocus?.type !== 'asset') return {};
      const newIds = state.secondaryFocus.assetIds.filter((i) => i !== id);
      if (newIds.length === 0) return { secondaryFocus: null };
      return { secondaryFocus: { type: 'asset', assetIds: newIds } };
    }),

    clearSecondaryFocus: () => set({ secondaryFocus: null }),

    // ── Toggle / batch ──

    toggleFragment: makeToggle('fragment'),
    toggleScene: makeToggle('scene'),

    // Batch select — replaces current selection with multiple ids of the same type
    selectFragments: makeSelectBatch('fragment'),
    selectScenes: makeSelectBatch('scene'),

    // Clear all focus
    clear: () => set({ ...initialState }),

    getSelectedId: (): string | null => {
      const { primaryFocusId, primaryIds } = get();
      return primaryFocusId ?? primaryIds[0] ?? null;
    },

    isSelected: (id: string): boolean => {
      const { primaryIds } = get();
      return primaryIds.includes(id);
    },

    getSelectedIds: (type: 'fragment' | 'scene'): string[] => getIdsForType(type, get()),
  };
});

// ---------------------------------------------------------------------------
// Subscribe to storeEvents — selection coordination from other stores
// ---------------------------------------------------------------------------
storeEvents.subscribe((event) => {
  const store = useSelectionStore.getState();
  switch (event.type) {
    case 'SELECTION_CLEAR':
      store.clear();
      break;
    case 'SELECTION_SELECT_FRAGMENT':
      store.selectFragment(event.id);
      break;
    case 'SELECTION_SELECT_FRAGMENTS':
      store.selectFragments(event.ids);
      break;
    case 'SELECTION_SELECT_SCENES':
      store.selectScenes(event.ids);
      break;
    case 'SELECTION_SELECT_DRAFT':
      store.selectDraft(event.data);
      break;
    case 'SELECTION_CLEAR_SECONDARY_FOCUS':
      store.clearSecondaryFocus();
      break;
    default:
      break;
  }
});
