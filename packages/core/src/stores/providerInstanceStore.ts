/**
 * ProviderInstanceStore — instance layer (Zustand, persisted to localStorage).
 *
 * Users create/manage provider instances in settings. Each instance
 * references a typeId from ProviderTypeRegistry.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderInstance } from '../types';

interface ProviderInstanceState {
  instances: ProviderInstance[];
  defaultAssetProviderId: string | null;

  addInstance: (instance: Omit<ProviderInstance, 'createdAt' | 'updatedAt' | 'instanceId'>) => string;
  updateInstance: (instanceId: string, updates: Partial<Omit<ProviderInstance, 'instanceId' | 'createdAt'>>) => void;
  removeInstance: (instanceId: string) => void;
  getByType: (typeId: string) => ProviderInstance[];
  get: (instanceId: string) => ProviderInstance | undefined;
  setDefaultAssetProvider: (instanceId: string | null) => void;
  getDefaultAssetProvider: () => ProviderInstance | undefined;
}

export const useProviderInstanceStore = create<ProviderInstanceState>()(
  persist(
    (set, get) => ({
      instances: [],
      defaultAssetProviderId: null,

      addInstance: (partial) => {
        const instanceId = `${partial.typeId}-${Date.now()}`;
        const now = new Date().toISOString();
        const instance: ProviderInstance = {
          ...partial,
          instanceId,
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          instances: [...state.instances, instance],
        }));

        return instanceId;
      },

      updateInstance: (instanceId, updates) => {
        set((state) => ({
          instances: state.instances.map((inst) =>
            inst.instanceId === instanceId
              ? { ...inst, ...updates, updatedAt: new Date().toISOString() }
              : inst
          ),
        }));
      },

      removeInstance: (instanceId) => {
        set((state) => ({
          instances: state.instances.filter((inst) => inst.instanceId !== instanceId),
        }));
      },

      getByType: (typeId) => {
        return get().instances.filter((inst) => inst.typeId === typeId);
      },

      get: (instanceId) => {
        return get().instances.find((inst) => inst.instanceId === instanceId);
      },

      setDefaultAssetProvider: (instanceId) => {
        set({ defaultAssetProviderId: instanceId });
      },

      getDefaultAssetProvider: () => {
        const { instances, defaultAssetProviderId } = get();

        if (defaultAssetProviderId) {
          const inst = instances.find((i) => i.instanceId === defaultAssetProviderId && i.enabled);
          if (inst) return inst;
        }

        return undefined;
      },
    }),
    {
      name: 'opendirector-provider-instances',
    }
  )
);
