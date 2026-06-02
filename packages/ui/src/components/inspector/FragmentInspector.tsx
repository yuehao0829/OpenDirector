import { useEffect, useMemo, useRef, useState } from 'react';
import { getGenerationService, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useCurrentProjectGenerations } from '@opendirector/core/stores/generationStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useSettingsStore } from '@opendirector/core/stores/settingsStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Asset, ImageRole, Reference } from '@opendirector/core/types/asset';
import { getEffectiveImageRole } from '@opendirector/core/types/asset';
import type { GenerationParamDefaults } from '@opendirector/core/types/generation';
import { isActiveGenerationStatus } from '@opendirector/core/types/generation';
import type { SubmitGenerationOptions } from '@opendirector/core/types/service-interfaces';
import type { Fragment, Scene } from '@opendirector/core/types/timeline';
import type {
  CapabilityParams,
  ConstraintIndicator,
  ModelVariant,
} from '@opendirector/core/types/provider-system';
import { computeReferenceIndicators, isImageModel, validateInputRequirements } from '@opendirector/core/types/provider-system';
import {
  buildContinuousPlan,
  computeContinuousProgress,
  fragmentMsToGenSeconds,
  genSecondsToFragmentMs,
  isContinuousMode,
} from '@opendirector/core/utils/duration';
import { useTranslation } from 'react-i18next';
import { PromptBuilder } from './PromptBuilder';
import { TaskOverview } from './TaskOverview';
import { InspectorHeader } from './InspectorHeader';
import { GenerationParamsSection, type GenerationParamsValue } from './GenerationParamsSection';
import { Panel } from '../layout/Panel';
import { Button } from '../common/Button';
import { X } from 'lucide-react';
import { ReferenceSelector, AssetThumbnail } from './ReferenceSelector';
import {
  groupReferences,
  getAssetTypeLabel,
  getImageRoleLabel,
  type GroupedReference,
} from './ReferenceSelector.shared';
import { getReferenceLabels, parsePromptLabels } from './prompt-editor';
import { PlaybackSourceSelector } from './PlaybackSourceSelector';
import { makeCompositeKey } from './compositeKey';

/** 音频开启但音乐关闭时，需要通过提示词告知模型不要生成音乐 */
const isMusicSuppressed = (p: Pick<GenerationParamsValue, 'enableAudio' | 'enableMusic'>) =>
  p.enableAudio && !p.enableMusic;

function buildEffectivePrompt(
  basePrompt: string,
  genParams: Pick<GenerationParamsValue, 'enableAudio' | 'enableMusic' | 'enableSubtitle'>,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const hints: string[] = [];
  if (isMusicSuppressed(genParams)) hints.push(translate('inspector.promptHints.noMusic'));
  if (!genParams.enableSubtitle) hints.push(translate('inspector.promptHints.noSubtitle'));
  return hints.length > 0 ? basePrompt + '\n' + hints.join('\n') : basePrompt;
}

function hasSameGenerationParamsValue(
  left: GenerationParamsValue,
  right: GenerationParamsValue,
): boolean {
  return (
    left.duration === right.duration &&
    left.resolution === right.resolution &&
    left.aspectRatio === right.aspectRatio &&
    left.enableAudio === right.enableAudio &&
    left.enableMusic === right.enableMusic &&
    left.enableSubtitle === right.enableSubtitle &&
    left.enableWatermark === right.enableWatermark &&
    left.enableWebSearch === right.enableWebSearch &&
    left.imageQuality === right.imageQuality &&
    left.imageOutputFormat === right.imageOutputFormat &&
    left.imageBackground === right.imageBackground &&
    left.imageModeration === right.imageModeration &&
    left.autoDuration === right.autoDuration &&
    left.imageOutputCompression === right.imageOutputCompression
  );
}

function getFragmentGenParams(fragment: { genParams?: GenerationParamDefaults; duration?: number } | null | undefined): GenerationParamsValue {
  const defaults = useSettingsStore.getState().defaultGenerationParams;
  const base = fragment?.genParams ?? defaults;
  const duration = fragment?.duration ? fragmentMsToGenSeconds(fragment.duration) : 5;
  return {
    ...base,
    duration,
    autoDuration: false,
    imageQuality: base.imageQuality ?? 'high',
    imageOutputFormat: base.imageOutputFormat ?? 'jpeg',
    imageBackground: base.imageBackground ?? 'opaque',
    imageModeration: base.imageModeration ?? 'low',
    imageOutputCompression: base.imageOutputCompression,
  };
}

/** Strip UI-only fields (duration, autoDuration) to get GenerationParamDefaults for persistence */
function toParamDefaults(v: GenerationParamsValue): GenerationParamDefaults {
  const { duration: _, autoDuration: __, ...rest } = v;
  return rest;
}

export function FragmentInspector() {
  const { t } = useTranslation();
  const primaryType = useSelectionStore((s) => s.primaryType);
  const primaryFocusId = useSelectionStore((s) => s.primaryFocusId);
  const fragments = useTimelineStore((s) => s.fragments);
  const tracks = useTimelineStore((s) => s.tracks);
  const scenes = useTimelineStore((s) => s.scenes);
  const updateFragment = useTimelineStore((s) => s.updateFragment);
  const resizeFragment = useTimelineStore((s) => s.resizeFragment);
  const draftFragment = useTimelineStore((s) => s.draftFragment);
  const draftPrompt = useTimelineStore((s) => s.draftPrompt);
  const confirmDraftFragment = useTimelineStore((s) => s.confirmDraftFragment);
  const setDraftPrompt = useTimelineStore((s) => s.setDraftPrompt);
  const cancelDraftFragment = useTimelineStore((s) => s.cancelDraftFragment);
  const getAssetById = useAssetStore((s) => s.getAssetById);

  const generations = useCurrentProjectGenerations();

  // Local UI state
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [genParams, setGenParams] = useState<GenerationParamsValue>(getFragmentGenParams(null));
  const genParamsRef = useRef(genParams);
  const currentGenParamDefaults = useMemo(() => toParamDefaults(genParams), [genParams]);
  const selectedFragmentIdRef = useRef<string | null>(null);
  const skipGenParamsWritebackFragmentIdRef = useRef<string | null>(null);
  genParamsRef.current = genParams;

  // Reset draft prompt when draft fragment changes
  useEffect(() => {
    if (draftFragment) {
      setDraftPrompt('');
    }
  }, [draftFragment, setDraftPrompt]);

  const selectedFragment = primaryType === 'fragment' && primaryFocusId
    ? fragments.find((f) => f.id === primaryFocusId)
    : null;

  const scene = selectedFragment?.sceneId
    ? scenes.find(s => s.id === selectedFragment.sceneId) ?? null
    : null;
  const selectedFragmentId = selectedFragment?.id ?? null;
  const selectedFragmentDuration = selectedFragment?.duration;
  const selectedFragmentProviderSelection = selectedFragment?.providerSelection;
  const selectedFragmentProviderInstanceId = selectedFragmentProviderSelection?.instanceId ?? null;
  const selectedFragmentProviderModelId = selectedFragmentProviderSelection?.modelId ?? null;
  const selectedFragmentStoredGenParams = selectedFragment?.genParams;

  // Reset genParams when fragment selection changes
  useEffect(() => {
    const nextSelectedFragmentId = selectedFragmentId;
    const nextGenParams = getFragmentGenParams(selectedFragment);
    const selectionChanged = selectedFragmentIdRef.current !== nextSelectedFragmentId;
    const localGenParamsOutOfSync = !hasSameGenerationParamsValue(genParamsRef.current, nextGenParams);
    const shouldResetLocalGenParams = selectionChanged || localGenParamsOutOfSync;
    selectedFragmentIdRef.current = nextSelectedFragmentId;

    if (shouldResetLocalGenParams) {
      skipGenParamsWritebackFragmentIdRef.current = nextSelectedFragmentId;
    }

    setGenParams((current) => {
      if (!shouldResetLocalGenParams && hasSameGenerationParamsValue(current, nextGenParams)) {
        return current;
      }
      return nextGenParams;
    });
  }, [selectedFragment, selectedFragmentId]);

  // Derive continuous mode state from fragment duration
  const { continuousMode, continuousPlan } = useMemo(() => {
    if (selectedFragmentDuration == null) {
      return { continuousMode: false, continuousPlan: undefined };
    }
    return {
      continuousMode: isContinuousMode(selectedFragmentDuration),
      continuousPlan: buildContinuousPlan(selectedFragmentDuration),
    };
  }, [selectedFragmentDuration]);

  // Fragment → slider sync: when fragment duration changes at runtime, update genParams
  useEffect(() => {
    if (selectedFragmentDuration == null || continuousMode) return;
    const genSec = fragmentMsToGenSeconds(selectedFragmentDuration);
    setGenParams((prev) => {
      if (prev.duration === genSec && !prev.autoDuration) return prev;
      return { ...prev, duration: genSec, autoDuration: false };
    });
  }, [selectedFragmentDuration, continuousMode]);

  // ── Flattened model list from all generation provider instances ──
  const instances = useProviderInstanceStore((s) => s.instances);

  const allModels = useMemo(() => {
    const needDisambiguate = instances.length > 1;
    const options: { modelId: string; instanceId: string; label: string }[] = [];
    for (const inst of instances) {
      const typeDef = getProviderTypeRegistry().get(inst.typeId);
      if (!typeDef || typeDef.providerType !== 'generation' || !inst.enabled) continue;
      for (const m of typeDef.modelFamilies.flatMap((f) => f.models)) {
        options.push({
          modelId: m.modelId,
          instanceId: inst.instanceId,
          label: needDisambiguate ? `${m.name} (${inst.displayName})` : m.name,
        });
      }
    }
    return options;
  }, [instances]);

  // Map: compositeKey (instanceId::modelId) → { modelId, instanceId }
  // Uses composite key to avoid "last instance wins" when same modelId exists across providers
  const modelByKey = useMemo(() => {
    const map = new Map<string, { modelId: string; instanceId: string }>();
    for (const opt of allModels) {
      const key = makeCompositeKey(opt.instanceId, opt.modelId);
      map.set(key, { modelId: opt.modelId, instanceId: opt.instanceId });
    }
    return map;
  }, [allModels]);

  // Derive isGenerating from generations (SSOT)
  const activeGeneration = generations.find(g =>
    g.fragmentId === selectedFragment?.id && isActiveGenerationStatus(g.status)
  );
  const isGenerating = !!activeGeneration;

  // Continuous segment progress
  const segmentProgress = useMemo(() => {
    if (!activeGeneration?.continuousMode) return null;
    const plan = activeGeneration.continuousPlan ?? [];
    const idx = activeGeneration.currentSegmentIndex ?? 0;
    if (plan.length === 0) return null;
    return computeContinuousProgress(plan, idx, activeGeneration.progress ?? 0);
  }, [activeGeneration?.continuousMode, activeGeneration?.continuousPlan, activeGeneration?.currentSegmentIndex, activeGeneration?.progress]);

  const resolvedModelSelection = useMemo(() => {
    const ps = selectedFragmentProviderSelection;
    const directKey = ps ? makeCompositeKey(ps.instanceId, ps.modelId) : '';

    if (directKey && modelByKey.has(directKey)) {
      return modelByKey.get(directKey);
    }
    if (ps?.instanceId) {
      const firstModelInSameInstance = allModels.find((m) => m.instanceId === ps.instanceId);
      if (firstModelInSameInstance) {
        return { modelId: firstModelInSameInstance.modelId, instanceId: firstModelInSameInstance.instanceId };
      }
    }
    if (allModels.length > 0) {
      return { modelId: allModels[0].modelId, instanceId: allModels[0].instanceId };
    }
    return undefined;
  }, [
    selectedFragmentProviderSelection,
    allModels,
    modelByKey,
  ]);

  const selectedCompositeKey = resolvedModelSelection
    ? makeCompositeKey(resolvedModelSelection.instanceId, resolvedModelSelection.modelId)
    : '';

  // Sync model selection from fragment when selection changes
  useEffect(() => {
    if (!selectedFragmentId || !resolvedModelSelection || isGenerating) return;

    const needsUpdate =
      selectedFragmentProviderInstanceId !== resolvedModelSelection.instanceId
      || selectedFragmentProviderModelId !== resolvedModelSelection.modelId;

    if (needsUpdate) {
      updateFragment(selectedFragmentId, {
        providerSelection: {
          instanceId: resolvedModelSelection.instanceId,
          modelId: resolvedModelSelection.modelId,
        },
      });
    }
  }, [
    selectedFragmentId,
    selectedFragmentProviderInstanceId,
    selectedFragmentProviderModelId,
    resolvedModelSelection,
    isGenerating,
    updateFragment,
  ]);

  const effectiveEntry = resolvedModelSelection;
  const effectiveModelId = effectiveEntry?.modelId ?? '';
  const effectiveInstanceId = effectiveEntry?.instanceId ?? '';

  // ── Grouped references for preview mode (must be before conditional returns to satisfy rules of hooks) ──
  const groupedReferences = useMemo(
    () => selectedFragment ? groupReferences(selectedFragment.references) : [],
    [selectedFragment],
  );

  // ── Get current model variant ──
  const currentModel: ModelVariant | undefined = useMemo(() => {
    if (!effectiveModelId || !effectiveInstanceId) return undefined;
    const inst = useProviderInstanceStore.getState().get(effectiveInstanceId);
    if (!inst) return undefined;
    const typeDef = getProviderTypeRegistry().get(inst.typeId);
    if (!typeDef) return undefined;
    return typeDef.modelFamilies
      .flatMap((f) => f.models)
      .find((m) => m.modelId === effectiveModelId);
  }, [effectiveModelId, effectiveInstanceId]);

  const capabilityParams: CapabilityParams | undefined = currentModel?.params;

  // Degrade global defaults when provider doesn't support them (e.g. 1080p → 720p for Seedance)
  useEffect(() => {
    if (!capabilityParams || !selectedFragmentId) return;
    setGenParams((prev) => {
      const updates: Partial<GenerationParamsValue> = {};
      if (capabilityParams.resolution && !capabilityParams.resolution.includes(prev.resolution)) {
        updates.resolution = capabilityParams.resolution[capabilityParams.resolution.length - 1];
      }
      if (capabilityParams.aspectRatios && !capabilityParams.aspectRatios.includes(prev.aspectRatio)) {
        updates.aspectRatio = capabilityParams.aspectRatios[0];
      }
      if (capabilityParams.imageQuality && !capabilityParams.imageQuality.includes(prev.imageQuality)) {
        updates.imageQuality = capabilityParams.imageQuality[0];
      }
      if (capabilityParams.imageOutputFormats && !capabilityParams.imageOutputFormats.includes(prev.imageOutputFormat)) {
        updates.imageOutputFormat = capabilityParams.imageOutputFormats[0];
      }
      if (capabilityParams.imageBackgrounds && !capabilityParams.imageBackgrounds.includes(prev.imageBackground)) {
        updates.imageBackground = capabilityParams.imageBackgrounds[0];
      }
      // Enforce: transparent background requires png/webp (not jpeg)
      const effectiveFormat = updates.imageOutputFormat ?? prev.imageOutputFormat;
      const effectiveBackground = updates.imageBackground ?? prev.imageBackground;
      if (effectiveBackground === 'transparent' && effectiveFormat === 'jpeg') {
        updates.imageOutputFormat = 'png';
      }
      if (Object.keys(updates).length === 0) return prev;
      return { ...prev, ...updates };
    });
  }, [capabilityParams, selectedFragmentId]);

  // Sync degraded genParams to fragment after local state settles
  useEffect(() => {
    if (!selectedFragmentId) return;
    if (skipGenParamsWritebackFragmentIdRef.current === selectedFragmentId) {
      skipGenParamsWritebackFragmentIdRef.current = null;
      return;
    }
    const stored = selectedFragmentStoredGenParams;
    if (JSON.stringify(currentGenParamDefaults) !== JSON.stringify(stored)) {
      updateFragment(selectedFragmentId, { genParams: currentGenParamDefaults });
    }
  }, [
    currentGenParamDefaults,
    selectedFragmentId,
    selectedFragmentStoredGenParams,
    updateFragment,
  ]);

  // ── Input validation based on model (must be before conditional returns) ──
  const inputValidation = useMemo(() => {
    return validateInputRequirements(
      {
        prompt: selectedFragment?.prompt,
        references: selectedFragment?.references,
        getAsset: (assetId) => getAssetById(assetId) ?? undefined,
      },
      currentModel?.inputRequirements,
    );
  }, [currentModel, selectedFragment?.prompt, selectedFragment?.references, getAssetById]);

  // ── Reference constraint indicators for UI display ──
  const assets = useAssetStore((s) => s.assets);
  const referenceIndicators = useMemo(() => {
    if (!currentModel?.inputRequirements || !selectedFragment?.references) return undefined;
    return computeReferenceIndicators(
      {
        references: selectedFragment.references,
        getAsset: (assetId) => assets.find((a) => a.id === assetId),
      },
      currentModel.inputRequirements,
    );
  }, [currentModel, selectedFragment?.references, assets]);

  // ── Draft fragment flow ──
  if (draftFragment) {
    const draftTrackType = tracks.find(t => t.id === draftFragment.trackId)?.type ?? 'video';
    const isDraftAudio = draftTrackType === 'audio';

    const handleCreateDraft = () => {
      confirmDraftFragment(draftPrompt.trim());
    };

    const handleCancelDraft = () => {
      cancelDraftFragment();
    };

    const handlePromptChange = (value: string) => {
      setDraftPrompt(value);
    };

    return (
      <div className="p-4 space-y-4" data-testid="draft-inspector">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-blue-400">
            {isDraftAudio ? t('inspector.actions.createAudioFragment') : t('inspector.actions.createFragment')}
          </span>
          <button
            onClick={handleCancelDraft}
            className="text-zinc-500 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <div className="text-sm text-zinc-400">
          {t('inspector.labels.duration')}: {(draftFragment.duration / 1000).toFixed(1)}s
        </div>

        {isDraftAudio ? (
          <input
            type="text"
            value={draftPrompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            placeholder={t('inspector.placeholders.audioDescription')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
        ) : (
          <PromptBuilder
            prompt={draftPrompt}
            onPromptChange={handlePromptChange}
            showWebSearch={false}
            autoFocus
          />
        )}

        <p className="text-xs text-zinc-500">
          {t('inspector.draftHint')}
        </p>

        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={handleCreateDraft}
          >
            {t('inspector.actions.createFragment')}
          </Button>
          <Button
            variant="ghost"
            onClick={handleCancelDraft}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  // ── Empty state: task overview dashboard ──
  if (!selectedFragment) {
    return <TaskOverview />;
  }

  const resolvedTrackType = tracks.find(t => t.id === selectedFragment.trackId)?.type ?? 'video';

  const hasGenerated = !!selectedFragment.generatedUrl || generations.some(g => g.fragmentId === selectedFragment?.id && g.status === 'completed');

  const canGenerate = !!selectedFragment.prompt && !isGenerating && !!effectiveModelId;

  const handleModelChange = (modelId: string, instanceId: string) => {
    updateFragment(selectedFragment.id, {
      providerSelection: { instanceId, modelId },
    });
  };

  const handleGenerate = () => {
    if (!effectiveModelId || !effectiveInstanceId) return;

    const genDuration = continuousMode
      ? (continuousPlan?.[0] ?? 15)
      : genParams.autoDuration ? -1 : genParams.duration;

    const options: SubmitGenerationOptions | undefined = continuousMode
      ? {
          returnLastFrame: (continuousPlan?.length ?? 0) > 1,
          continuousMode: true,
          continuousPlan,
          currentSegmentIndex: 0,
          inputRequirements: currentModel?.inputRequirements,
        }
      : currentModel?.inputRequirements
        ? { inputRequirements: currentModel.inputRequirements }
        : undefined;

    getGenerationService().submitTask(selectedFragment.id, effectiveInstanceId, effectiveModelId, {
      prompt: buildEffectivePrompt(selectedFragment.prompt, genParams, t),
      references: selectedFragment.references,
      duration: genDuration,
      aspectRatio: genParams.aspectRatio,
      resolution: genParams.resolution,
      generateAudio: genParams.enableAudio,
      generateWatermark: genParams.enableWatermark,
      imageQuality: genParams.imageQuality,
      imageOutputFormat: genParams.imageOutputFormat,
      imageBackground: genParams.imageBackground,
      imageModeration: genParams.imageModeration,
      imageOutputCompression: genParams.imageOutputCompression,
    }, options);

    // Clear selection to show TaskOverview dashboard
    useSelectionStore.getState().clear();
  };

  const sourceAsset = selectedFragment.sourceAssetId
    ? getAssetById(selectedFragment.sourceAssetId)
    : null;

  return (
    <div className="flex flex-col h-full" data-testid="fragment-inspector">
      {/* Header: tabs + model selector + generate button */}
      <InspectorHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasGenerated={hasGenerated}
        isGenerating={isGenerating}
        onGenerate={handleGenerate}
        disabled={!canGenerate || !inputValidation.valid || !!referenceIndicators?.hasErrors}
        models={allModels}
        selectedCompositeKey={selectedCompositeKey}
        onModelChange={handleModelChange}
        trackType={resolvedTrackType}
        segmentProgress={segmentProgress}
      />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pb-12">
        {activeTab === 'edit' ? (
          <EditModeContent
            fragment={selectedFragment}
            genParams={genParams}
            onGenParamsChange={(v) => {
              const prevDuration = genParamsRef.current.duration;
              setGenParams(v);
              // Sync non-duration params to fragment (only when actually changed)
              const newDefaults = toParamDefaults(v);
              const oldDefaults = toParamDefaults(genParamsRef.current);
              if (JSON.stringify(newDefaults) !== JSON.stringify(oldDefaults)) {
                updateFragment(selectedFragment.id, { genParams: newDefaults });
              }
              // Slider → fragment sync (only when not in continuous mode)
              if (!continuousMode && selectedFragment && !v.autoDuration && v.duration !== prevDuration) {
                resizeFragment(selectedFragment.id, genSecondsToFragmentMs(v.duration));
              }
            }}
            capabilityParams={capabilityParams}
            continuousMode={continuousMode}
            continuousPlan={continuousPlan}
            totalDuration={selectedFragment.duration}
            updateFragment={updateFragment}
            validation={inputValidation}
            indicators={referenceIndicators?.indicators}
            assets={assets}
            trackType={resolvedTrackType}
          />
        ) : (
          <PreviewModeContent
            fragment={selectedFragment}
            genParams={genParams}
            sourceAsset={sourceAsset ?? undefined}
            grouped={groupedReferences}
            getAssetById={getAssetById}
            scene={scene}
            trackType={resolvedTrackType}
            firstFrameAsReference={activeGeneration?.firstFrameAsReference}
            capabilityParams={capabilityParams}
          />
        )}
      </div>
    </div>
  );
}

// ── Edit mode content ──

function EditModeContent({
  fragment,
  genParams,
  onGenParamsChange,
  capabilityParams,
  continuousMode,
  continuousPlan,
  totalDuration,
  updateFragment,
  validation,
  indicators,
  assets,
  trackType,
}: {
  fragment: Fragment;
  genParams: GenerationParamsValue;
  onGenParamsChange: (v: GenerationParamsValue) => void;
  capabilityParams?: CapabilityParams;
  continuousMode: boolean;
  continuousPlan?: number[];
  totalDuration: number;
  updateFragment: (id: string, updates: Partial<Fragment>) => void;
  validation?: { valid: boolean; errors: string[]; promptWarnings: string[]; warnings: string[] };
  indicators?: Map<string, ConstraintIndicator[]>;
  assets: Asset[];
  trackType: 'video' | 'audio';
}) {
  const { t } = useTranslation();
  const isAudio = trackType === 'audio';

  return (
    <div className="space-y-2">
      {(validation?.errors.length ?? 0) + (validation?.warnings.length ?? 0) > 0 && (
        <div className="space-y-1">
          {validation?.errors.map((msg, i) => (
            <p key={`e${i}`} className="text-xs text-red-400">✗ {msg}</p>
          ))}
          {validation?.warnings.map((msg, i) => (
            <p key={`w${i}`} className="text-xs text-amber-400">⚠ {msg}</p>
          ))}
        </div>
      )}
      {!isAudio && (
        <GenerationParamsSection
          value={genParams}
          onChange={onGenParamsChange}
          capabilityParams={capabilityParams}
          continuousMode={continuousMode}
          continuousPlan={continuousPlan}
          totalDuration={totalDuration}
        />
      )}

      {!isAudio && (
        <Panel title={t('inspector.labels.prompt')}>
          <PromptBuilder
            prompt={fragment.prompt}
            onPromptChange={(prompt) => updateFragment(fragment.id, { prompt })}
            enableWebSearch={genParams.enableWebSearch}
            onWebSearchChange={(v) => onGenParamsChange({ ...genParams, enableWebSearch: v })}
            warnings={validation?.promptWarnings}
            references={fragment.references}
            assets={assets}
          />
        </Panel>
      )}

      {!isAudio && (
        <Panel title={t('inspector.labels.referenceAssets')}>
          <ReferenceSelector
            references={fragment.references}
            assets={assets}
            onChange={(refs) => updateFragment(fragment.id, { references: refs })}
            fragmentId={fragment.id}
            indicators={indicators}
          />
        </Panel>
      )}

      <Panel title={t('inspector.labels.playbackSource')}>
        <PlaybackSourceSelector
          fragmentId={fragment.id}
          sourceAssetId={fragment.sourceAssetId}
          onChange={(assetId) => updateFragment(fragment.id, { sourceAssetId: assetId })}
        />
      </Panel>
    </div>
  );
}

// ── Preview mode content ──

function PreviewModeContent({
  fragment,
  genParams,
  sourceAsset,
  grouped,
  getAssetById,
  scene,
  trackType,
  firstFrameAsReference,
  capabilityParams,
}: {
  fragment: Fragment;
  genParams: GenerationParamsValue;
  sourceAsset: Asset | undefined;
  grouped: GroupedReference[];
  getAssetById: (id: string) => Asset | null;
  scene: Scene | null;
  trackType: 'video' | 'audio';
  firstFrameAsReference?: boolean;
  capabilityParams?: CapabilityParams;
}) {
  const { t } = useTranslation();
  const labelToRef = useMemo(() => {
    const refs = fragment.references ?? [];
    if (refs.length === 0) return new Map<string, { ref: Reference; asset: Asset }>();
    const idLabels = getReferenceLabels(refs);
    const map = new Map<string, { ref: Reference; asset: Asset }>();
    for (const ref of refs) {
      const label = idLabels.get(ref.id);
      if (label) {
        const asset = getAssetById(ref.assetId);
        if (asset) map.set(label, { ref, asset });
      }
    }
    return map;
  }, [fragment.references, getAssetById]);

  const promptElements = useMemo(() => {
    if (!fragment.prompt) return null;
    const effectivePrompt = buildEffectivePrompt(fragment.prompt, {
      enableAudio: genParams.enableAudio,
      enableMusic: genParams.enableMusic,
      enableSubtitle: genParams.enableSubtitle,
    }, t);

    return parsePromptLabels(
      effectivePrompt,
      labelToRef,
      (label, info, key) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-zinc-700 rounded text-xs text-blue-300 align-middle"
        >
          {info.asset?.thumbnailUrl && (
            <img src={info.asset.thumbnailUrl} alt="" className="w-4 h-4 rounded object-cover" />
          )}
          {label}
        </span>
      ),
      (text, _key) => text,
    );
  }, [
    fragment.prompt,
    labelToRef,
    genParams.enableAudio,
    genParams.enableMusic,
    genParams.enableSubtitle,
    t,
  ]);

  const isAudio = trackType === 'audio';
  const isImage = capabilityParams ? isImageModel(capabilityParams) : false;

  // Scene references provide shared context across fragments in the same scene
  const sceneRefAssets = useMemo((): Asset[] => {
    if (!scene?.referenceIds?.length) return [];
    return scene.referenceIds
      .map((id: string) => getAssetById(id))
      .filter((a): a is Asset => a !== null);
  }, [scene, getAssetById]);

  return (
    <div className="p-3 space-y-3">
      {!isAudio && (
        <div className="p-2 bg-zinc-800/50 rounded text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">{t('inspector.labels.params')}</span>
          {isImage ? (
            <>
              <span className="ml-2">{genParams.resolution} · {genParams.aspectRatio} · {genParams.imageQuality} · {genParams.imageOutputFormat.toUpperCase()}</span>
            </>
          ) : (
            <>
              <span className="ml-2">{genParams.resolution} · {genParams.aspectRatio} · {genParams.duration}s</span>
              {genParams.enableAudio && <span className="ml-1">· {t('inspector.previewSummary.audioOn')}</span>}
              {genParams.enableMusic && <span className="ml-1">· {t('inspector.previewSummary.musicOn')}</span>}
              {genParams.enableSubtitle && <span className="ml-1">· {t('inspector.previewSummary.subtitleOn')}</span>}
              {genParams.enableWatermark && <span className="ml-1">· {t('inspector.previewSummary.watermarkOn')}</span>}
              {genParams.enableWebSearch && <span className="ml-1">· {t('inspector.previewSummary.webSearchOn')}</span>}
            </>
          )}
        </div>
      )}

      {!isAudio && (isMusicSuppressed(genParams) || !genParams.enableSubtitle || firstFrameAsReference) && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-400/80">
          {isMusicSuppressed(genParams) && <div>{t('inspector.promptHints.musicDisabled')}</div>}
          {!genParams.enableSubtitle && <div>{t('inspector.promptHints.subtitleDisabled')}</div>}
          {firstFrameAsReference && (
            <div>
              {t('inspector.promptHints.firstFrameAsReference', {
                hint: t('generation.prompt.firstFrameHint', { index: 'N' }),
              })}
            </div>
          )}
        </div>
      )}

      {/* Prompt preview */}
      <Panel title={t('inspector.labels.prompt')}>
        <div className="text-sm text-zinc-300 whitespace-pre-wrap min-h-[2rem]">
          {promptElements || <span className="text-zinc-600 italic">{t('inspector.labels.emptyPrompt')}</span>}
        </div>
      </Panel>

      {/* Scene references (merged) */}
      {sceneRefAssets.length > 0 && (
        <Panel title={t('inspector.labels.sceneReferences', { count: sceneRefAssets.length })}>
          <div className="space-y-1">
            {sceneRefAssets.map((asset) => (
              <div key={asset.id} className="flex items-center gap-2 p-1.5 bg-zinc-800/50 rounded">
                <AssetThumbnail type={asset.type} thumbnailUrl={asset.thumbnailUrl} />
                <span className="text-sm text-zinc-300 truncate">{asset.name}</span>
                <span className="text-xs text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">{t('inspector.labels.sceneTag')}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Grouped references preview */}
      {grouped.map((group) => (
        <Panel key={group.type} title={`${getAssetTypeLabel(group.type, t)} (${group.refs.length})`}>
          <div className="space-y-1">
            {group.refs.map((ref) => {
              const asset = getAssetById(ref.assetId);
              const isImage = group.type === 'image';
              const role = isImage ? getEffectiveImageRole(ref) : 'reference_image';
              const showRoleLabel = isImage && (role === 'first_frame' || role === 'last_frame');
              return (
                <div key={ref.assetId} className="flex items-center gap-2 p-1.5 bg-zinc-800/50 rounded">
                  <AssetThumbnail type={group.type} thumbnailUrl={asset?.thumbnailUrl} />
                  <span className="text-sm text-zinc-300 truncate">{asset?.name ?? ref.assetId}</span>
                  {showRoleLabel && (
                    <span className="text-xs text-zinc-400 bg-zinc-700 px-1.5 py-0.5 rounded">
                      {getImageRoleLabel(role as ImageRole, t)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      ))}

      {/* Source asset */}
      {sourceAsset && (
        <Panel title={t('inspector.labels.playbackSource')}>
          <div className="flex items-center gap-2 p-1.5 bg-zinc-800/50 rounded">
            <AssetThumbnail type={sourceAsset.type} thumbnailUrl={sourceAsset.thumbnailUrl} />
            <span className="text-sm text-zinc-300 truncate">{sourceAsset.name}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
