import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewDiagnostics, PreviewSessionState } from '@opendirector/core/types/media-preview';
import { NativeTimelinePreviewHost } from './NativeTimelinePreviewHost';

interface MockNativeTimelinePreviewState {
  active: boolean;
  sessionId: string | null;
  state: PreviewSessionState;
  surfaceAttached: boolean;
  timelineAttached: boolean;
  positionMs: number;
  transportControlled: boolean;
  diagnostics: Partial<PreviewDiagnostics> | null;
  error: string | null;
}

const previewState = vi.hoisted(() => ({
  current: {
    active: true,
    sessionId: 'preview-session-1',
    state: 'playing',
    surfaceAttached: true,
    timelineAttached: true,
    positionMs: 320,
    transportControlled: true,
    diagnostics: {
      playbackBackend: 'in-process-ges-pipeline',
      configuredVideoSinkType: 'glimagesink',
      nativeSurfaceImplemented: true,
      nativeSurfacePlatformStatus: 'supported',
      nativeSurfaceType: 'nsview-child',
      nativeSurfaceVisible: true,
      nativeSurfacePresenting: true,
      nativeSurfaceEmbeddedContentAttached: true,
      runtime: {
        gstreamerReady: true,
      },
      nativeHostWindowHandle: 'host-1',
      nativeSurfaceWindowHandle: 'surface-1',
      nativeSurfacePhysicalRect: {
        x: 10,
        y: 20,
        width: 640,
        height: 360,
      },
    },
    error: null as string | null,
  } as MockNativeTimelinePreviewState,
}));

vi.mock('../../hooks/useNativeTimelinePreview', () => ({
  useNativeTimelinePreview: vi.fn(() => previewState.current),
}));

describe('NativeTimelinePreviewHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    previewState.current = {
      active: true,
      sessionId: 'preview-session-1',
      state: 'playing',
      surfaceAttached: true,
      timelineAttached: true,
      positionMs: 320,
      transportControlled: true,
      diagnostics: {
        playbackBackend: 'in-process-ges-pipeline',
        configuredVideoSinkType: 'glimagesink',
        nativeSurfaceImplemented: true,
        nativeSurfacePlatformStatus: 'supported',
        nativeSurfaceType: 'nsview-child',
        nativeSurfaceVisible: true,
        nativeSurfacePresenting: true,
        nativeSurfaceEmbeddedContentAttached: true,
        runtime: {
          gstreamerReady: true,
        },
        nativeHostWindowHandle: 'host-1',
        nativeSurfaceWindowHandle: 'surface-1',
        nativeSurfacePhysicalRect: {
          x: 10,
          y: 20,
          width: 640,
          height: 360,
        },
      },
      error: null as string | null,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('reports native transport ownership and exposes preview diagnostics attrs', () => {
    const onTransportControlChange = vi.fn();
    const onErrorChange = vi.fn();

    act(() => {
      root.render(
        <NativeTimelinePreviewHost
          enabled
          onTransportControlChange={onTransportControlChange}
          onErrorChange={onErrorChange}
        />,
      );
    });

    const host = container.querySelector('[data-testid="native-timeline-preview-host"]');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('data-native-preview-transport')).toBe('native');
    expect(host?.getAttribute('data-native-preview-timeline')).toBe('attached');
    expect(host?.getAttribute('data-native-preview-position-ms')).toBe('320');
    expect(host?.getAttribute('data-native-preview-backend')).toBe('in-process-ges-pipeline');
    expect(host?.getAttribute('data-native-preview-sink')).toBe('glimagesink');
    expect(host?.getAttribute('data-native-preview-platform-status')).toBe('supported');
    expect(host?.getAttribute('data-native-preview-platform-implemented')).toBe('true');
    expect(host?.getAttribute('data-native-preview-surface-type')).toBe('nsview-child');
    expect(host?.getAttribute('data-native-preview-embedded-content')).toBe('true');
    expect(onTransportControlChange).toHaveBeenCalledWith(true);
    expect(onErrorChange).toHaveBeenCalledWith(null);
  });

  it('notifies parent when transport control is released', () => {
    const onTransportControlChange = vi.fn();
    const onErrorChange = vi.fn();

    act(() => {
      root.render(
        <NativeTimelinePreviewHost
          enabled
          onTransportControlChange={onTransportControlChange}
          onErrorChange={onErrorChange}
        />,
      );
    });

    previewState.current = {
      ...previewState.current,
      transportControlled: false,
      timelineAttached: false,
      state: 'paused',
    };

    act(() => {
      root.render(
        <NativeTimelinePreviewHost
          enabled
          onTransportControlChange={onTransportControlChange}
          onErrorChange={onErrorChange}
        />,
      );
    });

    expect(onTransportControlChange).toHaveBeenLastCalledWith(false);
  });

  it('reports preview errors to parent callbacks', () => {
    const onErrorChange = vi.fn();

    previewState.current = {
      ...previewState.current,
      state: 'error',
      transportControlled: false,
      timelineAttached: false,
      error: 'Timeline preview requires media-backed fragments.',
    };

    act(() => {
      root.render(
        <NativeTimelinePreviewHost
          enabled
          onErrorChange={onErrorChange}
        />,
      );
    });

    const host = container.querySelector('[data-testid="native-timeline-preview-host"]');
    expect(host?.getAttribute('data-native-preview-error')).toBe('true');
    expect(onErrorChange).toHaveBeenCalledWith(
      'Timeline preview requires media-backed fragments.',
    );
  });

  it('summarizes sink binding failures for parent callbacks', () => {
    const onErrorChange = vi.fn();

    previewState.current = {
      ...previewState.current,
      state: 'error',
      transportControlled: false,
      timelineAttached: false,
      error:
        'Failed to bind native preview surface to preview sink: configured preview video sink does not implement GstVideoOverlay',
    };

    act(() => {
      root.render(
        <NativeTimelinePreviewHost
          enabled
          onErrorChange={onErrorChange}
        />,
      );
    });

    expect(onErrorChange).toHaveBeenCalledWith(
      '原生预览宿主已创建，但视频 sink (glimagesink) 绑定失败：Failed to bind native preview surface to preview sink: configured preview video sink does not implement GstVideoOverlay',
    );
  });

  it('exposes unsupported platform attrs when native surface is unavailable', () => {
    previewState.current = {
      ...previewState.current,
      surfaceAttached: false,
      timelineAttached: false,
      diagnostics: {
        playbackBackend: 'in-process-ges-pipeline',
        nativeSurfaceImplemented: false,
        nativeSurfacePlatformStatus: 'unsupported',
        nativeSurfacePlatformReason:
          'Native preview surfaces are only implemented on Windows and macOS',
        nativeSurfaceVisible: false,
        nativeSurfacePresenting: false,
        nativeSurfaceEmbeddedContentAttached: false,
        runtime: {
          gstreamerReady: true,
        },
      },
    };

    act(() => {
      root.render(<NativeTimelinePreviewHost enabled />);
    });

    const host = container.querySelector('[data-testid="native-timeline-preview-host"]');
    expect(host?.getAttribute('data-native-preview-platform-status')).toBe('unsupported');
    expect(host?.getAttribute('data-native-preview-platform-implemented')).toBe('false');
    expect(host?.getAttribute('data-native-preview-surface')).toBe('detached');
    expect(host?.getAttribute('data-native-preview-sink')).toBe('');
  });
});
