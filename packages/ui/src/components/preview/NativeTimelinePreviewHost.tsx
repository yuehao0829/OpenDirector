import { useEffect, useRef } from 'react';
import { useNativeTimelinePreview } from '../../hooks/useNativeTimelinePreview';
import type {
  PreviewDiagnostics,
  PreviewSessionState,
} from '@opendirector/core/types/media-preview';
import { useTranslation } from 'react-i18next';

interface NativeTimelinePreviewHostProps {
  enabled: boolean;
  className?: string;
  onTransportControlChange?: (transportControlled: boolean) => void;
  onErrorChange?: (error: string | null) => void;
  onStateChange?: (state: PreviewSessionState) => void;
}

function summarizeNativePreviewError(
  error: string | null,
  diagnostics: PreviewDiagnostics | null,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!error) {
    return null;
  }

  if (diagnostics?.nativeSurfacePlatformStatus === 'unsupported') {
    const reason = diagnostics.nativeSurfacePlatformReason || error;
    return translate('preview.nativeErrors.unsupported', { reason });
  }

  if (diagnostics && diagnostics.runtime.gstreamerReady === false) {
    const reason = diagnostics.runtime.gstreamerReason || error;
    return translate('preview.nativeErrors.runtimeUnavailable', { reason });
  }

  if (
    error.includes('Failed to bind native preview surface to preview sink') ||
    error.includes('Failed to bind preview backend to native preview surface') ||
    error.includes('GstVideoOverlay')
  ) {
    const sinkType = diagnostics?.configuredVideoSinkType;
    if (sinkType) {
      return translate('preview.nativeErrors.sinkBindWithType', { sinkType, error });
    }
    return translate('preview.nativeErrors.sinkBind', { error });
  }

  if (
    error.includes('Failed to attach native preview surface') ||
    error.includes('Failed to present native preview surface') ||
    error.includes('Failed to apply native preview viewport') ||
    error.includes('Failed to update native preview surface visibility')
  ) {
    return translate('preview.nativeErrors.hostLayoutFailed', { error });
  }

  if (error.includes('Failed to initialize preview backend')) {
    return translate('preview.nativeErrors.backendInitFailed', { error });
  }

  return error;
}

export function NativeTimelinePreviewHost({
  enabled,
  className = 'absolute inset-0 pointer-events-none',
  onTransportControlChange,
  onErrorChange,
  onStateChange,
}: NativeTimelinePreviewHostProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const preview = useNativeTimelinePreview({
    enabled,
    containerRef,
  });
  const summarizedError = summarizeNativePreviewError(preview.error, preview.diagnostics, t);

  useEffect(() => {
    onTransportControlChange?.(preview.transportControlled);
    return () => {
      onTransportControlChange?.(false);
    };
  }, [onTransportControlChange, preview.transportControlled]);

  useEffect(() => {
    onErrorChange?.(summarizedError);
    return () => {
      onErrorChange?.(null);
    };
  }, [onErrorChange, summarizedError]);

  useEffect(() => {
    onStateChange?.(preview.state);
  }, [onStateChange, preview.state]);

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden="true"
      data-testid="native-timeline-preview-host"
      data-native-preview-active={preview.active ? 'true' : 'false'}
      data-native-preview-session={preview.sessionId ?? ''}
      data-native-preview-state={preview.state}
      data-native-preview-surface={preview.surfaceAttached ? 'attached' : 'detached'}
      data-native-preview-platform-status={
        preview.diagnostics?.nativeSurfacePlatformStatus ?? ''
      }
      data-native-preview-platform-implemented={
        preview.diagnostics?.nativeSurfaceImplemented === undefined
          ? ''
          : preview.diagnostics.nativeSurfaceImplemented
            ? 'true'
            : 'false'
      }
      data-native-preview-surface-type={preview.diagnostics?.nativeSurfaceType ?? ''}
      data-native-preview-timeline={preview.timelineAttached ? 'attached' : 'detached'}
      data-native-preview-transport={preview.transportControlled ? 'native' : 'legacy'}
      data-native-preview-position-ms={preview.positionMs}
      data-native-preview-visible={
        preview.diagnostics?.nativeSurfaceVisible ? 'true' : 'false'
      }
      data-native-preview-presenting={
        preview.diagnostics?.nativeSurfacePresenting ? 'true' : 'false'
      }
      data-native-preview-embedded-content={
        preview.diagnostics?.nativeSurfaceEmbeddedContentAttached ? 'true' : 'false'
      }
      data-native-preview-runtime-ready={
        preview.diagnostics?.runtime.gstreamerReady ? 'true' : 'false'
      }
      data-native-preview-backend={preview.diagnostics?.playbackBackend ?? ''}
      data-native-preview-sink={preview.diagnostics?.configuredVideoSinkType ?? ''}
      data-native-preview-host-hwnd={preview.diagnostics?.nativeHostWindowHandle ?? ''}
      data-native-preview-surface-hwnd={preview.diagnostics?.nativeSurfaceWindowHandle ?? ''}
      data-native-preview-physical-rect={
        preview.diagnostics?.nativeSurfacePhysicalRect
          ? [
              preview.diagnostics.nativeSurfacePhysicalRect.x,
              preview.diagnostics.nativeSurfacePhysicalRect.y,
              preview.diagnostics.nativeSurfacePhysicalRect.width,
              preview.diagnostics.nativeSurfacePhysicalRect.height,
            ].join(',')
          : ''
      }
      data-native-preview-error={summarizedError ? 'true' : 'false'}
    />
  );
}
