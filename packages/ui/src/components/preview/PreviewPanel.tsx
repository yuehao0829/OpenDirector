import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { applyReference } from '@opendirector/core/services/reference-processor';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Asset, CropRect, Reference, TrimRange } from '@opendirector/core/types/asset';
import type { PreviewSessionState } from '@opendirector/core/types/media-preview';
import { isTauri } from '@opendirector/core/utils/platform';
import { usePreviewSource } from '../../hooks/usePreviewSource';
import {
  computeCropFrameRect,
  computeCropDrawParams,
  computeContainLayout,
  parseAspectRatio,
} from '../../utils/crop';
import { useImageCanvas } from '../../hooks/useImageCanvas';
import { useContainerSize } from '../../hooks/useContainerSize';
import { useReferenceCrop } from '../../hooks/useReferenceCrop';
import { PlaybackControls } from './PlaybackControls';
import { NativeTimelinePreviewHost } from './NativeTimelinePreviewHost';
import { VideoPreview } from './VideoPreview';
import { WaveformPreview } from './WaveformPreview';
import { CropOverlay } from './CropOverlay';
import { Crop } from 'lucide-react';

export function PreviewPanel() {
  const tauriEnvironment = isTauri();
  // Get preview source from hook (video only, topmost video track)
  const source = usePreviewSource();
  const [nativeTimelinePreviewError, setNativeTimelinePreviewError] = useState<string | null>(null);
  const [nativeTimelinePreviewState, setNativeTimelinePreviewState] =
    useState<PreviewSessionState>('idle');

  // Seek tracking: increment on each user seek to trigger video sync
  const seekCountRef = useRef(0);
  const [seekCount, setSeekCount] = useState(0);

  // Timeline state for timeline mode
  const playhead = useTimelineStore((s) => s.playhead);
  const timelineIsPlaying = useTimelineStore((s) => s.isPlaying);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);

  const addAsset = useAssetStore((s) => s.addAsset);

  // Preview store for asset mode
  const previewIsPlaying = usePreviewStore((s) => s.isPlaying);
  const currentTime = usePreviewStore((s) => s.currentTime);
  const previewDuration = usePreviewStore((s) => s.duration);
  const pause = usePreviewStore((s) => s.pause);
  const seek = usePreviewStore((s) => s.seek);
  const setTime = usePreviewStore((s) => s.setTime);
  const setDuration = usePreviewStore((s) => s.setDuration);

  const desktopTimelinePreviewActive = tauriEnvironment && source.mode === 'timeline';
  const nativeTimelinePlaybackActive =
    desktopTimelinePreviewActive && nativeTimelinePreviewState === 'playing';

  // Determine effective values based on mode
  const isIndependentPlayback = source.mode === 'asset' || source.mode === 'reference';
  const isPlaying = isIndependentPlayback ? previewIsPlaying : timelineIsPlaying;
  // In reference mode with trim, previewStore uses relative time [0, trimEnd-trimStart],
  // but PlaybackControls and VideoPreview work in absolute time [0, asset.duration].
  // Convert accordingly.
  const referenceTrimStart =
    source.mode === 'reference' && source.reference?.trimRange
      ? source.reference.trimRange.startMs
      : 0;
  const effectiveCurrentTime = isIndependentPlayback
    ? currentTime + referenceTrimStart
    : source.fragment
      ? playhead - source.fragment.start + (source.fragment.trimStart ?? 0)
      : 0;
  // Display time for PlaybackControls: in timeline mode show playhead position,
  // not the video-internal time (which is for seeking/positioning only)
  const displayCurrentTime = source.mode === 'timeline' ? playhead : effectiveCurrentTime;
  const effectiveDuration =
    source.mode === 'reference' && source.asset?.duration
      ? source.asset.duration
      : isIndependentPlayback
        ? previewDuration
        : source.duration;

  const referenceTrimEnd =
    source.mode === 'reference' && source.reference?.trimRange
      ? source.reference.trimRange.endMs
      : 0;

  const handleTimeUpdate = useCallback(
    (time: number) => {
      if (isIndependentPlayback) {
        setTime(time - referenceTrimStart);
        if (source.mode === 'reference' && referenceTrimEnd > 0 && time >= referenceTrimEnd) {
          pause();
        }
      }
    },
    [isIndependentPlayback, referenceTrimStart, referenceTrimEnd, source.mode, setTime, pause],
  );

  const handleDurationChange = useCallback(
    (dur: number) => {
      if (isIndependentPlayback) {
        setDuration(dur);
      }
    },
    [isIndependentPlayback, setDuration],
  );

  const handleVideoEnded = useCallback(() => {
    if (isIndependentPlayback) {
      pause();
    }
  }, [isIndependentPlayback, pause]);

  const handleMediaPause = useCallback(() => {
    if (isIndependentPlayback) {
      pause();
    }
  }, [isIndependentPlayback, pause]);

  const handleSeek = useCallback(
    (time: number) => {
      if (isIndependentPlayback) {
        // Reference mode: convert absolute time back to relative (subtract trimStart)
        seek(time - referenceTrimStart);
        seekCountRef.current += 1;
        setSeekCount(seekCountRef.current);
      } else {
        setPlayhead(time);
      }
    },
    [isIndependentPlayback, referenceTrimStart, seek, setPlayhead],
  );

  // ── Reference mode: crop/trim state management ──
  const updateFragment = useTimelineStore((s) => s.updateFragment);

  // Unified update for crop/trim with rAF throttling to avoid store mutation spam during drag
  const pendingUpdateRef = useRef<{
    fragmentId: string;
    refId: string;
    field: 'cropRect' | 'trimRange';
    value: CropRect | TrimRange;
  } | null>(null);
  const rafRef = useRef(0);

  const flushReferenceUpdate = useCallback(() => {
    const pending = pendingUpdateRef.current;
    if (!pending) return;
    pendingUpdateRef.current = null;
    const fragment = useTimelineStore.getState().fragments.find((f) => f.id === pending.fragmentId);
    if (!fragment) return;
    const updatedRefs = fragment.references.map((r) =>
      r.id === pending.refId ? { ...r, [pending.field]: pending.value } : r,
    );
    updateFragment(pending.fragmentId, { references: updatedRefs });
  }, [updateFragment]);

  const scheduleReferenceUpdate = useCallback(
    (
      fragmentId: string,
      refId: string,
      field: 'cropRect' | 'trimRange',
      value: CropRect | TrimRange,
    ) => {
      pendingUpdateRef.current = { fragmentId, refId, field, value };
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          flushReferenceUpdate();
        });
      }
    },
    [flushReferenceUpdate],
  );

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // ── Crop overlay toggle ──
  const [cropOverlayVisible, setCropOverlayVisible] = useState(false);

  // Track whether crop is at default (reported by sub-components via useReferenceCrop)
  const [isDefaultCrop, setIsDefaultCrop] = useState(true);
  const [defaultCropRect, setDefaultCropRect] = useState<CropRect | null>(null);
  const defaultCropRectRef = useRef<CropRect | null>(null);
  defaultCropRectRef.current = defaultCropRect;

  const handleCropChange = useCallback(
    (newCropRect: CropRect) => {
      // Only write cropRect to fragment reference when overlay is visible —
      // when hidden, pan/zoom is disabled and no state should be persisted.
      if (!cropOverlayVisible) return;
      if (source.mode !== 'reference' || !source.reference || !source.referenceFragmentId) return;
      scheduleReferenceUpdate(
        source.referenceFragmentId,
        source.reference.id,
        'cropRect',
        newCropRect,
      );
    },
    [
      cropOverlayVisible,
      source.mode,
      source.reference,
      source.referenceFragmentId,
      scheduleReferenceUpdate,
    ],
  );

  const handleTrimChange = useCallback(
    (newTrimRange: TrimRange) => {
      if (source.mode !== 'reference' || !source.reference || !source.referenceFragmentId) return;
      scheduleReferenceUpdate(
        source.referenceFragmentId,
        source.reference.id,
        'trimRange',
        newTrimRange,
      );
    },
    [source.mode, source.reference, source.referenceFragmentId, scheduleReferenceUpdate],
  );

  // ── Apply: crop/trim → generate new file → replace reference ──
  const [isApplying, setIsApplying] = useState(false);

  const handleDefaultCropChange = useCallback((isDefault: boolean, defCr: CropRect) => {
    setIsDefaultCrop(isDefault);
    setDefaultCropRect((prev) => {
      if (
        prev &&
        Math.abs(prev.x - defCr.x) < 0.001 &&
        Math.abs(prev.y - defCr.y) < 0.001 &&
        Math.abs(prev.width - defCr.width) < 0.001 &&
        Math.abs(prev.height - defCr.height) < 0.001
      ) {
        return prev;
      }
      return defCr;
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (
      source.mode !== 'reference' ||
      !source.reference ||
      !source.asset ||
      !source.referenceFragmentId
    )
      return;
    setIsApplying(true);

    try {
      const asset = source.asset;
      const ref = source.reference;
      const project = useProjectStore.getState().currentProject;

      if (!project?.folderPath) {
        throw new Error('No project or file system available');
      }

      const adapter = await getPlatformAdapter();
      const fs = adapter.fs;
      if (!fs) throw new Error('No file system adapter available');

      // All types: media crop/trim — cropRect only when overlay visible, trimRange always active
      // Use isDefaultCrop (which reflects user's actual zoom/pan state) rather than
      // ratio comparison alone. When the source aspect matches the target, the user
      // can still zoom/pan the contain layout, and that crop must be applied.
      const effectiveRef = cropOverlayVisible
        ? {
            ...ref,
            cropRect:
              ref.cropRect ??
              (isDefaultCrop ? undefined : (defaultCropRectRef.current ?? undefined)),
          }
        : { ...ref, cropRect: undefined };

      const result = await applyReference({
        asset,
        reference: effectiveRef,
        projectPath: project.folderPath,
        targetAspectRatio: source.targetAspectRatio,
        fs,
      });
      const newAsset = result.newAsset;

      // Register new asset in store
      addAsset(newAsset);
      // Persist to DB
      try {
        const assetWithProject = { ...newAsset, projectId: project.id };
        await adapter.db.saveAsset(assetWithProject);
      } catch (e) {
        console.warn('Failed to persist new asset to DB:', e);
      }

      // Cancel any pending crop/trim rAF update before clearing —
      // otherwise the pending flush could overwrite cropRect: undefined back to the old value
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pendingUpdateRef.current = null;

      // Update fragment reference: replace assetId, clear cropRect and trimRange
      const fragment = useTimelineStore
        .getState()
        .fragments.find((f) => f.id === source.referenceFragmentId);
      if (fragment) {
        const updatedRefs = fragment.references.map((r) =>
          r.id === ref.id
            ? { ...r, assetId: newAsset.id, cropRect: undefined, trimRange: undefined }
            : r,
        );
        updateFragment(fragment.id, { references: updatedRefs });
      }

      // Reset UI state
      setCropOverlayVisible(false);
    } catch (err) {
      console.error('[Apply Reference] Failed:', err);
    } finally {
      setIsApplying(false);
    }
  }, [
    source.mode,
    source.reference,
    source.asset,
    source.referenceFragmentId,
    source.targetAspectRatio,
    isDefaultCrop,
    cropOverlayVisible,
    addAsset,
    updateFragment,
  ]);

  const applyDisabled = useMemo(() => {
    if (source.mode !== 'reference' || !source.reference || !source.asset) return true;

    const asset = source.asset;
    const targetAr = parseAspectRatio(source.targetAspectRatio);
    const sourceAr = asset.width && asset.height ? asset.width / asset.height : null;

    const hasAspectRatioCrop =
      targetAr !== null && sourceAr !== null && Math.abs(targetAr - sourceAr) > 0.01;
    const hasCropChange = cropOverlayVisible && (!isDefaultCrop || hasAspectRatioCrop);

    const tr = source.reference.trimRange;
    const assetDuration = source.asset.duration ?? 0;
    const isDefaultTrim =
      !tr || (Math.abs(tr.startMs) < 1 && Math.abs(tr.endMs - assetDuration) < 1);

    return !hasCropChange && isDefaultTrim;
  }, [
    source.mode,
    source.reference,
    source.asset,
    source.targetAspectRatio,
    cropOverlayVisible,
    isDefaultCrop,
  ]);

  // Render preview content based on type
  const renderPreview = () => {
    if (nativeTimelinePlaybackActive) {
      return null;
    }

    if (!source.previewUrl) {
      // Timeline mode: black screen when no video content at playhead
      // Asset/Reference mode: show "No preview available"
      if (source.mode === 'timeline') {
        return <div className="w-full h-full bg-black" />;
      }
      return (
        <div className="w-full h-full bg-zinc-900 flex items-center justify-center">
          <p className="text-zinc-500 text-sm">No preview available</p>
        </div>
      );
    }

    // ── Reference mode rendering ──
    if (source.mode === 'reference') {
      return renderReferencePreview();
    }

    switch (source.previewType) {
      case 'video':
        if (source.mode === 'timeline') {
          return <div className="w-full h-full bg-black" />;
        }

        return (
          <VideoPreview
            src={source.previewUrl}
            isPlaying={isPlaying}
            currentTime={effectiveCurrentTime}
            seekCount={seekCount}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={handleDurationChange}
            onEnded={handleVideoEnded}
            onPause={handleMediaPause}
          />
        );

      case 'audio':
        // In timeline mode, audio is handled by the mixer — show nothing
        // (video from topmost track takes priority; audio tracks are mixed separately)
        // In asset mode, show waveform as before
        if (source.mode === 'timeline') {
          return <div className="w-full h-full bg-black" />;
        }
        return (
          <WaveformPreview
            src={source.previewUrl}
            currentTime={effectiveCurrentTime}
            duration={effectiveDuration}
            isPlaying={isPlaying}
            onSeek={handleSeek}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleVideoEnded}
            waveformDataPath={source.waveformDataPath}
          />
        );

      case 'image':
        return (
          <img
            src={source.previewUrl}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded"
          />
        );

      default:
        return null;
    }
  };

  // Render reference mode preview with crop/trim controls
  const renderReferencePreview = () => {
    if (!source.reference || !source.asset) return null;

    const ref = source.reference;
    const asset = source.asset;

    switch (source.previewType) {
      case 'image': {
        return (
          <ReferenceImagePreview
            asset={asset}
            reference={ref}
            targetAspectRatio={source.targetAspectRatio}
            onCropChange={handleCropChange}
            onDefaultCropChange={handleDefaultCropChange}
            cropOverlayVisible={cropOverlayVisible}
          />
        );
      }

      case 'video': {
        const targetAr = parseAspectRatio(source.targetAspectRatio);
        return (
          <ReferenceVideoPreview
            src={source.previewUrl!}
            asset={asset}
            reference={ref}
            targetAspectRatio={targetAr}
            isPlaying={isPlaying}
            currentTime={effectiveCurrentTime}
            seekCount={seekCount}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={handleDurationChange}
            onEnded={handleVideoEnded}
            onPause={pause}
            onCropChange={handleCropChange}
            onDefaultCropChange={handleDefaultCropChange}
            cropOverlayVisible={cropOverlayVisible}
          />
        );
      }

      case 'audio': {
        return (
          <div className="w-full h-full flex items-center justify-center">
            <WaveformPreview
              src={source.previewUrl!}
              currentTime={effectiveCurrentTime}
              duration={effectiveDuration}
              isPlaying={isPlaying}
              onSeek={handleSeek}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleVideoEnded}
              waveformDataPath={source.waveformDataPath}
            />
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950" data-testid="preview-panel">
      <div className="flex-1 flex items-center justify-center bg-black min-h-0 relative">
        {desktopTimelinePreviewActive && (
          <NativeTimelinePreviewHost
            enabled
            onErrorChange={setNativeTimelinePreviewError}
            onStateChange={setNativeTimelinePreviewState}
          />
        )}
        {renderPreview()}
        {desktopTimelinePreviewActive && nativeTimelinePreviewError && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 px-6"
            data-testid="native-preview-error-overlay"
          >
            <div className="w-full max-w-xl space-y-2 text-center">
              <p className="text-sm font-medium text-white">该工程的时间线预览无法打开</p>
              <p className="text-xs leading-5 text-zinc-300">{nativeTimelinePreviewError}</p>
            </div>
          </div>
        )}

        {/* Crop overlay toggle button (reference mode only) */}
        {source.mode === 'reference' &&
          (source.previewType === 'image' || source.previewType === 'video') && (
            <button
              className={`absolute bottom-3 right-3 z-30 p-1.5 rounded transition-colors ${
                cropOverlayVisible
                  ? 'bg-blue-500/80 text-white'
                  : 'bg-black/50 hover:bg-black/70 text-white'
              }`}
              onClick={() => setCropOverlayVisible((v) => !v)}
              title={cropOverlayVisible ? '隐藏裁剪' : '显示裁剪'}
            >
              <Crop size={14} />
            </button>
          )}
      </div>

      <PlaybackControls
        currentTime={displayCurrentTime}
        duration={effectiveDuration}
        mode={source.mode}
        previewType={source.previewType}
        onSeek={handleSeek}
        trimRange={
          source.mode === 'reference' && source.asset?.duration
            ? (source.reference?.trimRange ?? { startMs: 0, endMs: source.asset.duration })
            : undefined
        }
        onTrimChange={source.mode === 'reference' ? handleTrimChange : undefined}
        applyButton={source.mode === 'reference'}
        onApply={handleApply}
        isApplying={isApplying}
        applyDisabled={applyDisabled}
      />
    </div>
  );
}

// ── Reference image preview sub-component ──

function ReferenceImagePreview({
  asset,
  reference,
  targetAspectRatio,
  onCropChange,
  onDefaultCropChange,
  cropOverlayVisible,
}: {
  asset: Asset;
  reference: Reference;
  targetAspectRatio: string | null;
  onCropChange: (rect: CropRect) => void;
  onDefaultCropChange: (isDefault: boolean, defaultCropRect: CropRect) => void;
  cropOverlayVisible: boolean;
}) {
  const targetAr = parseAspectRatio(targetAspectRatio);

  // Bridge state: passes cropRect from useReferenceCrop to useImageCanvas
  // without waiting for store round-trip (avoids 1-frame lag during pan/zoom).
  // Reset when overlay closes so stale values from a previous image don't leak
  // into the next crop session. Only syncs the initial default — during drag,
  // the CropOverlay callback sets canvasCropRect directly.
  const [canvasCropRect, setCanvasCropRect] = useState<CropRect | undefined>(undefined);

  // Canvas rendering
  const { canvasRef, containerRef, imageInfo, containerSize } = useImageCanvas({
    src: asset.url,
    cropRect: cropOverlayVisible ? canvasCropRect : undefined,
    targetAspectRatio,
  });

  const { cropRect, defaultCropRect, isDefaultCrop } = useReferenceCrop({
    reference,
    imageInfo,
    targetAspectRatio: targetAr,
    onCropChange: (cr) => {
      setCanvasCropRect(cr);
      onCropChange(cr);
    },
    enabled: cropOverlayVisible,
  });

  // Sync canvasCropRect with useReferenceCrop's initial default.
  // useReferenceCrop skips the first onCropChange call (to avoid writing the
  // default back to the store), so canvasCropRect would otherwise stay stale
  // until the user starts panning/zooming. After the initial sync, the
  // CropOverlay callback handles all subsequent updates directly.
  const cropSyncedRef = useRef(false);
  useEffect(() => {
    if (!cropOverlayVisible) {
      setCanvasCropRect(undefined);
      cropSyncedRef.current = false;
    } else if (cropRect && !cropSyncedRef.current) {
      setCanvasCropRect(cropRect);
      cropSyncedRef.current = true;
    }
  }, [cropOverlayVisible, cropRect]);

  useEffect(() => {
    if (defaultCropRect) onDefaultCropChange(isDefaultCrop, defaultCropRect);
  }, [isDefaultCrop, defaultCropRect, onDefaultCropChange]);

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas ref={canvasRef} className="absolute inset-0" />
      {cropOverlayVisible && (
        <CropOverlay
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          sourceWidth={imageInfo.naturalWidth}
          sourceHeight={imageInfo.naturalHeight}
          cropRect={cropRect ?? reference.cropRect ?? { x: 0, y: 0, width: 1, height: 1 }}
          onCropChange={(cr) => {
            setCanvasCropRect(cr);
            onCropChange(cr);
          }}
          aspectRatio={targetAr}
          defaultCropRect={defaultCropRect}
        />
      )}
    </div>
  );
}

// ── Reference video preview sub-component (CSS-based pan/zoom) ──

function ReferenceVideoPreview({
  src,
  asset,
  reference,
  targetAspectRatio,
  isPlaying,
  currentTime,
  seekCount,
  onTimeUpdate,
  onDurationChange,
  onEnded,
  onPause,
  onCropChange,
  onDefaultCropChange,
  cropOverlayVisible,
}: {
  src: string;
  asset: Asset;
  reference: Reference;
  targetAspectRatio: number | null;
  isPlaying: boolean;
  currentTime: number;
  seekCount: number;
  onTimeUpdate: (time: number) => void;
  onDurationChange: (duration: number) => void;
  onEnded: () => void;
  onPause: () => void;
  onCropChange: (rect: CropRect) => void;
  onDefaultCropChange: (isDefault: boolean, defaultCropRect: CropRect) => void;
  cropOverlayVisible: boolean;
}) {
  const { containerRef, containerSize } = useContainerSize();

  const { cropRect, defaultCropRect, isDefaultCrop } = useReferenceCrop({
    reference,
    imageInfo: { naturalWidth: asset.width ?? 1920, naturalHeight: asset.height ?? 1080 },
    targetAspectRatio,
    onCropChange,
    enabled: cropOverlayVisible,
  });

  useEffect(() => {
    if (defaultCropRect) onDefaultCropChange(isDefaultCrop, defaultCropRect);
  }, [isDefaultCrop, defaultCropRect, onDefaultCropChange]);

  const effectiveCropRect = cropOverlayVisible ? (cropRect ?? null) : null;
  const targetAr = targetAspectRatio;

  const { videoStyle, frame } = useMemo(() => {
    const vidW = asset.width ?? 1920;
    const vidH = asset.height ?? 1080;
    const cW = containerSize.width;
    const cH = containerSize.height;

    if (!effectiveCropRect) {
      const { x, y, width, height } = computeContainLayout(cW, cH, vidW, vidH);
      const frame = computeCropFrameRect(cW, cH, targetAr);
      return {
        videoStyle: {
          position: 'absolute' as const,
          width: `${width}px`,
          height: `${height}px`,
          left: `${x}px`,
          top: `${y}px`,
          maxWidth: 'none' as const,
          maxHeight: 'none' as const,
        },
        frame,
      };
    }

    const { drawX, drawY, drawW, drawH, frame } = computeCropDrawParams(
      effectiveCropRect,
      vidW,
      vidH,
      cW,
      cH,
      targetAr,
    );

    return {
      videoStyle: {
        position: 'absolute' as const,
        width: `${drawW}px`,
        height: `${drawH}px`,
        left: `${drawX}px`,
        top: `${drawY}px`,
        maxWidth: 'none' as const,
        maxHeight: 'none' as const,
      },
      frame,
    };
  }, [
    effectiveCropRect,
    targetAr,
    asset.width,
    asset.height,
    containerSize.width,
    containerSize.height,
  ]);

  return (
    <div ref={containerRef} className="w-full h-full bg-black relative overflow-hidden">
      {/* Video always renders at contain size in full container */}
      <VideoPreview
        src={src}
        isPlaying={isPlaying}
        currentTime={currentTime}
        seekCount={seekCount}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={onDurationChange}
        onEnded={onEnded}
        onPause={onPause}
        styleOverride={videoStyle}
      />

      {/* Dark mask outside crop frame (only when crop overlay is visible) */}
      {cropOverlayVisible && effectiveCropRect && (
        <>
          <div
            className="absolute bg-black/50 pointer-events-none"
            style={{ left: 0, top: 0, width: '100%', height: frame.y }}
          />
          <div
            className="absolute bg-black/50 pointer-events-none"
            style={{
              left: 0,
              top: frame.y + frame.height,
              width: '100%',
              height: containerSize.height - frame.y - frame.height,
            }}
          />
          <div
            className="absolute bg-black/50 pointer-events-none"
            style={{ left: 0, top: frame.y, width: frame.x, height: frame.height }}
          />
          <div
            className="absolute bg-black/50 pointer-events-none"
            style={{
              left: frame.x + frame.width,
              top: frame.y,
              width: containerSize.width - frame.x - frame.width,
              height: frame.height,
            }}
          />
        </>
      )}

      {cropOverlayVisible && effectiveCropRect && (
        <CropOverlay
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          sourceWidth={asset.width ?? 1920}
          sourceHeight={asset.height ?? 1080}
          cropRect={effectiveCropRect}
          onCropChange={onCropChange}
          aspectRatio={targetAspectRatio}
          defaultCropRect={defaultCropRect}
        />
      )}
    </div>
  );
}
