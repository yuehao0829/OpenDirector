/**
 * usePreviewSource Hook
 *
 * Computes preview source from unified selection system:
 * 1. If selection.type === 'reference' -> reference mode (crop/trim editing)
 * 2. If selection.type === 'asset' -> asset mode
 * 3. If selection.type === 'fragment' -> show that fragment
 * 4. Else -> timeline mode (show fragment at playhead)
 *
 * Returns:
 * - mode: 'asset' | 'timeline' | 'reference'
 * - asset: Asset | null
 * - fragment: Fragment | null
 * - reference: Reference | null
 * - referenceFragmentId: string | null
 * - targetAspectRatio: string | null
 * - previewUrl: string | null
 * - previewType: 'video' | 'image' | 'audio'
 */

import { useMemo, useEffect, useRef } from 'react';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Asset, Reference } from '@opendirector/core/types/asset';
import type { Fragment } from '@opendirector/core/types/timeline';

export type PreviewType = 'video' | 'image' | 'audio';

export interface PreviewSource {
  mode: 'asset' | 'timeline' | 'reference';
  asset: Asset | null;
  fragment: Fragment | null;
  reference: Reference | null;
  referenceFragmentId: string | null;
  targetAspectRatio: string | null;
  previewUrl: string | null;
  previewType: PreviewType;
  duration: number;  // milliseconds
  waveformDataPath?: string;  // Path to binary peak data file (audio assets)
}

function getReferencePreviewIdentity(source: PreviewSource): string | null {
  if (source.mode !== 'reference' || !source.asset || !source.reference) {
    return null;
  }

  return [
    source.referenceFragmentId ?? 'unknown',
    source.reference.id,
    source.asset.id,
    source.previewType,
  ].join(':');
}

function getReferenceTrimStartMs(reference: Reference): number {
  return reference.trimRange?.startMs ?? 0;
}

export function usePreviewSource(): PreviewSource {
  // Secondary focus controls Preview window only (reference/asset navigation)
  const secondaryFocus = useSelectionStore((s) => s.secondaryFocus);

  const getAssetById = useAssetStore((s) => s.getAssetById);

  const playhead = useTimelineStore((s) => s.playhead);
  const fragments = useTimelineStore((s) => s.fragments);
  const tracks = useTimelineStore((s) => s.tracks);
  const timelineDuration = useTimelineStore((s) => s.duration);

  const setAssetPreview = usePreviewStore((s) => s.setAssetPreview);
  const setReferencePreview = usePreviewStore((s) => s.setReferencePreview);
  const setTimelinePreview = usePreviewStore((s) => s.setTimelinePreview);
  const setPreviewDuration = usePreviewStore((s) => s.setDuration);
  const previousReferencePreviewIdentityRef = useRef<string | null>(null);
  const previousReferenceTrimStartMsRef = useRef(0);

  // Compute preview source (read-only)
  const source = useMemo((): PreviewSource => {
    // Reference mode: secondaryFocus.type === 'reference'
    if (secondaryFocus?.type === 'reference') {
      const referenceData = secondaryFocus.referenceData;
      const fragment = fragments.find((f) => f.id === referenceData.fragmentId);
      if (fragment) {
        const ref = fragment.references.find((r) => r.id === referenceData.referenceId);
        const asset = ref ? getAssetById(ref.assetId) : null;
        if (ref && asset) {
          const targetAspectRatio = fragment.genParams?.aspectRatio ?? null;
          return {
            mode: 'reference' as const,
            asset,
            fragment: null,
            reference: ref,
            referenceFragmentId: fragment.id,
            targetAspectRatio,
            previewUrl: asset.url,
            previewType: asset.type,
            duration: ref.trimRange
              ? ref.trimRange.endMs - ref.trimRange.startMs
              : (asset.duration || 0),
            waveformDataPath: asset.type === 'audio'
              ? asset.waveformDataPath
              : undefined,
          };
        }
      }
    }

    // Asset mode: secondaryFocus.type === 'asset'
    if (secondaryFocus?.type === 'asset' && secondaryFocus.assetIds.length > 0) {
      const asset = getAssetById(secondaryFocus.assetIds[0]);
      if (asset) {
        return {
          mode: 'asset' as const,
          asset,
          fragment: null,
          reference: null,
          referenceFragmentId: null,
          targetAspectRatio: null,
          previewUrl: asset.url,
          previewType: asset.type,
          duration: asset.duration || 0,
          waveformDataPath: asset.type === 'audio'
            ? asset.waveformDataPath
            : undefined,
        };
      }
    }

    // Timeline mode: find video fragment on topmost video track with valid source
    const videoTracks = tracks
      .filter((t) => t.type === 'video')
      .sort((a, b) => b.order - a.order); // Descending: highest order = topmost visually

    // Helper to check if fragment has valid preview source
    const hasValidPreviewSource = (frag: Fragment): boolean => {
      const playbackAssetId = frag.sourceAssetId ?? frag.resultAssetId;
      if (playbackAssetId) {
        const sourceAsset = getAssetById(playbackAssetId);
        return sourceAsset?.url != null;
      }
      return frag.generatedUrl != null || frag.thumbnailUrl != null;
    };

    let currentFragment: Fragment | null = null;
    for (const track of videoTracks) {
      const frag = fragments.find(
        (f) => f.trackId === track.id && playhead >= f.start && playhead < f.start + f.duration && hasValidPreviewSource(f)
      );
      if (frag) {
        currentFragment = frag;
        break;
      }
    }

    // Get preview URL: sourceAssetId → generatedUrl → thumbnailUrl
    let previewUrl: string | null = null;
    let previewType: PreviewType = 'video';
    let waveformDataPath: string | undefined;

    const playbackAssetId = currentFragment?.sourceAssetId ?? currentFragment?.resultAssetId;
    if (playbackAssetId) {
      const sourceAsset = getAssetById(playbackAssetId);
      if (sourceAsset) {
        previewUrl = sourceAsset.url;
        previewType = sourceAsset.type;
        waveformDataPath = sourceAsset.type === 'audio'
          ? sourceAsset.waveformDataPath
          : undefined;
      }
    }

    if (!previewUrl && currentFragment) {
      previewUrl = currentFragment.generatedUrl || currentFragment.thumbnailUrl || null;
    }

    return {
      mode: 'timeline' as const,
      asset: null,
      fragment: currentFragment || null,
      reference: null,
      referenceFragmentId: null,
      targetAspectRatio: null,
      previewUrl,
      previewType,
      duration: timelineDuration,
      waveformDataPath,
    };
  }, [secondaryFocus, getAssetById, playhead, fragments, tracks, timelineDuration]);

  // Update preview store mode when source changes
  useEffect(() => {
    if (source.mode !== 'timeline' && useTimelineStore.getState().isPlaying) {
      // Preview source switched away from timeline; treat this as leaving
      // timeline playback mode entirely.
      // We intentionally do not sync the latest playhead ref back into the
      // coarse UI playhead here: when the user opens asset/reference preview,
      // the expected behavior is to stop timeline playback rather than preserve
      // sub-frame continuity for a later resume. Keeping that handoff simple
      // avoids extra cross-store/native transport coordination.
      useTimelineStore.getState().pause();
    }

    if (source.mode === 'reference' && source.asset && source.reference) {
      const previewState = usePreviewStore.getState();
      const referencePreviewIdentity = getReferencePreviewIdentity(source);
      const referenceTrimStartMs = getReferenceTrimStartMs(source.reference);
      const sameReferencePreview =
        previewState.mode === 'reference' &&
        previewState.assetId === source.asset.id &&
        previewState.assetType === source.previewType &&
        previousReferencePreviewIdentityRef.current === referencePreviewIdentity;
      const shouldResetForVideoTrimStartChange =
        sameReferencePreview &&
        source.previewType === 'video' &&
        previewState.isPlaying &&
        previousReferenceTrimStartMsRef.current !== referenceTrimStartMs;
      const shouldClampPlayingVideoToNewEnd =
        sameReferencePreview &&
        source.previewType === 'video' &&
        previewState.isPlaying &&
        previewState.currentTime > source.duration;
      if (shouldResetForVideoTrimStartChange) {
        setReferencePreview(source.asset.id, source.previewType, source.duration);
      } else if (shouldClampPlayingVideoToNewEnd) {
        setReferencePreview(source.asset.id, source.previewType, source.duration);
        usePreviewStore.getState().seek(source.duration);
      } else if (sameReferencePreview) {
        setPreviewDuration(source.duration);
        if (previewState.currentTime > source.duration) {
          previewState.seek(source.duration);
        }
      } else {
        setReferencePreview(source.asset.id, source.previewType, source.duration);
      }
      previousReferencePreviewIdentityRef.current = referencePreviewIdentity;
      previousReferenceTrimStartMsRef.current = referenceTrimStartMs;
    } else if (source.mode === 'asset' && source.asset) {
      previousReferencePreviewIdentityRef.current = null;
      previousReferenceTrimStartMsRef.current = 0;
      const previewState = usePreviewStore.getState();
      const sameAssetPreview =
        previewState.mode === 'asset' &&
        previewState.assetId === source.asset.id &&
        previewState.assetType === source.previewType;
      if (sameAssetPreview) {
        setPreviewDuration(source.duration);
        if (previewState.currentTime > source.duration) {
          previewState.seek(source.duration);
        }
      } else {
        setAssetPreview(source.asset.id, source.previewType, source.duration);
      }
    } else {
      previousReferencePreviewIdentityRef.current = null;
      previousReferenceTrimStartMsRef.current = 0;
      if (usePreviewStore.getState().mode !== 'timeline') {
        setTimelinePreview();
      }
    }
  }, [
    source.mode,
    source.asset,
    source.reference,
    source.previewType,
    source.duration,
    setAssetPreview,
    setReferencePreview,
    setTimelinePreview,
    setPreviewDuration,
  ]);

  return source;
}
