import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoPreview } from './VideoPreview';

describe('VideoPreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalPlay: typeof HTMLMediaElement.prototype.play;
  let originalPause: typeof HTMLMediaElement.prototype.pause;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    originalPlay = HTMLMediaElement.prototype.play;
    originalPause = HTMLMediaElement.prototype.pause;

    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();

    HTMLMediaElement.prototype.play = originalPlay;
    HTMLMediaElement.prototype.pause = originalPause;
  });

  it('seeks to the requested position when seekCount changes', () => {
    act(() => {
      root.render(
        <VideoPreview
          src="asset.mp4"
          isPlaying={false}
          currentTime={0}
        />,
      );
    });

    const video = container.querySelector('video') as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video!.currentTime).toBe(0);

    act(() => {
      root.render(
        <VideoPreview
          src="asset.mp4"
          isPlaying={false}
          currentTime={2_500}
          seekCount={1}
        />,
      );
    });

    expect(video!.currentTime).toBe(2.5);
  });
});
