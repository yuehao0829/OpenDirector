/**
 * Asset Store
 *
 * Manages asset state in memory
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Asset, AssetSource, FileCategory } from '../types';
import { storeEvents } from './store-events';
import { useSelectionStore } from './selectionStore';

interface AssetState {
  assets: Asset[];
  isLoading: boolean;
  searchQuery: string;

  // New source and category filters
  source: AssetSource;
  fileCategory: FileCategory;

  showUploadedOnly: boolean;

  // Pending deletions — assets removed from UI but files not yet deleted from disk
  pendingDeletions: Asset[];

  // Asset actions
  addAsset: (asset: Asset) => void;
  updateAsset: (id: string, updates: Partial<Asset>) => void;
  deleteAsset: (id: string) => void;
  clearPendingDeletions: () => void;

  // UI actions
  setSearchQuery: (query: string) => void;
  setSource: (source: AssetSource) => void;
  setFileCategory: (category: FileCategory) => void;
  setShowUploadedOnly: (show: boolean) => void;

  // Queries
  getFilteredAssets: () => Asset[];
  getAssetById: (id: string) => Asset | null;
  getAssetBySourcePath: (sourcePath: string) => Asset | null;
  getAssetByNameAndSize: (name: string, fileSize: number) => Asset | null;
}

export const useAssetStore = create<AssetState>()(
  subscribeWithSelector((set, get) => ({
  assets: [],
  isLoading: false,
  searchQuery: '',
  source: 'original',
  fileCategory: 'all',
  showUploadedOnly: false,
  pendingDeletions: [],

  // Asset actions
  addAsset: (asset) => set((state) => ({
    assets: [...state.assets, asset],
  })),

  updateAsset: (id, updates) => set((state) => ({
    assets: state.assets.map((a) =>
      a.id === id ? { ...a, ...updates, updatedAt: new Date() } : a
    ),
  })),

  deleteAsset: (id) => {
    const { assets } = get();
    const asset = assets.find((a) => a.id === id);
    if (!asset) return;

    const currentSelection = useSelectionStore.getState();
    if (currentSelection.secondaryFocus?.type === 'asset' && currentSelection.secondaryFocus.assetIds.includes(id)) {
      useSelectionStore.getState().removeAssetFromSelection(id);
    }

    // Remove from active assets, move to pending deletions
    set((state) => ({
      assets: state.assets.filter((a) => a.id !== id),
      pendingDeletions: [...state.pendingDeletions, asset],
    }));
  },

  clearPendingDeletions: () => {
    set({ pendingDeletions: [] });
  },

  // UI actions
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSource: (source) => set({ source }),
  setFileCategory: (fileCategory) => set({ fileCategory }),
  setShowUploadedOnly: (showUploadedOnly) => set({ showUploadedOnly }),

  // Queries
  getFilteredAssets: () => {
    const { assets, searchQuery, source, fileCategory, showUploadedOnly } = get();
    return assets.filter((asset) => {
      // 1. Filter by source
      const matchesSource = asset.source === source;

      // 2. Filter by file type
      const matchesType = fileCategory === 'all' || asset.type === fileCategory;

      // 3. Filter by search query
      const matchesSearch = searchQuery === '' ||
        asset.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        asset.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesUploaded = !showUploadedOnly || asset.remoteAssetStatus === 'Active';

      return matchesSource && matchesType && matchesSearch && matchesUploaded;
    });
  },

  getAssetById: (id) => {
    const { assets } = get();
    return assets.find((a) => a.id === id) || null;
  },

  getAssetBySourcePath: (sourcePath) => {
    const { assets } = get();
    const normalized = sourcePath.replace(/\\/g, '/');
    return assets.find((a) => {
      if (!a.sourcePath) return false;
      return a.sourcePath.replace(/\\/g, '/') === normalized;
    }) || null;
  },

  getAssetByNameAndSize: (name, fileSize) => {
    const { assets } = get();
    return assets.find((a) => a.name === name && a.fileSize === fileSize) || null;
  },
}))
);

// ---------------------------------------------------------------------------
// Subscribe to storeEvents — SNAPSHOT_RESTORED from undoManager
// ---------------------------------------------------------------------------
storeEvents.subscribe((event) => {
  if (event.type === 'SNAPSHOT_RESTORED') {
    useAssetStore.setState({
      assets: event.snapshot.assets,
      pendingDeletions: event.snapshot.pendingDeletions,
    });
  }
});