import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reference } from '@opendirector/core/types/asset';
import type { InputRequirements } from '@opendirector/core/types/provider-system';
import { ReferenceSelector } from './ReferenceSelector';

// ReferenceSelector reads secondaryFocus on render and only touches
// selectReference/clearSecondaryFocus on click — provide stubs so render works.
vi.mock('@opendirector/core/stores/selectionStore', () => ({
  useSelectionStore: (selector: (s: any) => any) =>
    selector({ secondaryFocus: undefined, selectReference: vi.fn(), clearSecondaryFocus: vi.fn() }),
}));

const SEEDAUDIO_REQ: InputRequirements = {
  promptRequired: true,
  references: {
    image: { required: false, min: 0, max: 1 },
    video: { required: false, min: 0, max: 0 },
    audio: { required: false, min: 0, max: 3 },
    maxTotal: 3,
  },
  crossConstraints: [{ rule: 'forbid_image_audio_mix', message: 'no mix' }],
};

const SEEDANCE_REQ: InputRequirements = {
  promptRequired: true,
  references: {
    image: { required: false, min: 0, max: 9 },
    video: { required: false, min: 0, max: 3 },
    audio: { required: false, min: 0, max: 3 },
    maxTotal: 15,
  },
};

const MINIMAX_REQ: InputRequirements = {
  promptRequired: true,
  references: {
    image: { required: false, min: 0, max: 0 },
    video: { required: false, min: 0, max: 0 },
    audio: { required: false, min: 0, max: 0 },
    maxTotal: 0,
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, root };
}

describe('ReferenceSelector — type slots driven by inputRequirements', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
  });

  it('renders a slot per supported type even when empty (SeedAudio: image + audio, no video)', () => {
    ({ container, root } = render(
      <ReferenceSelector references={[]} assets={[]} onChange={() => {}} inputRequirements={SEEDAUDIO_REQ} />,
    ));
    const text = container.textContent ?? '';
    // image (0/1) + audio (0/3); video (max:0) must NOT render
    expect(countOccurrences(text, '(0/1)')).toBe(1);
    expect(text).toContain('(0/3)');
    expect(text).not.toContain('(0/0)');
  });

  it('renders a slot per supported type (Seedance: image + video + audio)', () => {
    ({ container, root } = render(
      <ReferenceSelector references={[]} assets={[]} onChange={() => {}} inputRequirements={SEEDANCE_REQ} />,
    ));
    const text = container.textContent ?? '';
    expect(countOccurrences(text, '(0/9)')).toBe(1); // image
    expect(countOccurrences(text, '(0/3)')).toBe(2); // video + audio
  });

  it('renders only a generic hint when the model supports no references (MiniMax)', () => {
    ({ container, root } = render(
      <ReferenceSelector references={[]} assets={[]} onChange={() => {}} inputRequirements={MINIMAX_REQ} />,
    ));
    expect(container.querySelector('[data-testid="reference-selector"]')).toBeNull();
    expect(container.textContent).toContain('拖拽');
  });

  it('renders only a generic hint when no model is selected and refs are empty', () => {
    ({ container, root } = render(
      <ReferenceSelector references={[]} assets={[]} onChange={() => {}} />,
    ));
    expect(container.querySelector('[data-testid="reference-selector"]')).toBeNull();
  });

  it('shows a slot for an existing ref even without inputRequirements (escape hatch)', () => {
    const ref = { id: 'r1', assetId: 'a1', type: 'image', role: 'reference_image' } as Reference;
    const assets = [{ id: 'a1', name: 'img.png', type: 'image' }] as any;
    ({ container, root } = render(
      <ReferenceSelector references={[ref]} assets={assets} onChange={() => {}} />,
    ));
    expect(container.querySelector('[data-testid="reference-selector"]')).not.toBeNull();
    // image slot, no max declared → count "(1)"
    expect(container.textContent).toContain('(1)');
  });

  it('shows the ref in its slot and an empty hint in the other (SeedAudio with one audio ref)', () => {
    const audioRef = { id: 'r1', assetId: 'a1', type: 'audio' } as Reference;
    const assets = [{ id: 'a1', name: 'clip.wav', type: 'audio' }] as any;
    ({ container, root } = render(
      <ReferenceSelector references={[audioRef]} assets={assets} onChange={() => {}} inputRequirements={SEEDAUDIO_REQ} />,
    ));
    const text = container.textContent ?? '';
    expect(text).toContain('(0/1)'); // image slot empty
    expect(text).toContain('(1/3)'); // audio slot holding the ref (max 3)
    expect(text).toContain('clip.wav');
  });

  it('renders multiple audio refs in the same slot up to the max (SeedAudio @音频N)', () => {
    const refs = [
      { id: 'r1', assetId: 'a1', type: 'audio' },
      { id: 'r2', assetId: 'a2', type: 'audio' },
      { id: 'r3', assetId: 'a3', type: 'audio' },
    ] as Reference[];
    const assets = [
      { id: 'a1', name: 'clip1.wav', type: 'audio' },
      { id: 'a2', name: 'clip2.wav', type: 'audio' },
      { id: 'a3', name: 'clip3.wav', type: 'audio' },
    ] as any;
    ({ container, root } = render(
      <ReferenceSelector references={refs} assets={assets} onChange={() => {}} inputRequirements={SEEDAUDIO_REQ} />,
    ));
    const text = container.textContent ?? '';
    expect(text).toContain('(3/3)'); // audio slot full
    expect(text).toContain('clip1.wav');
    expect(text).toContain('clip2.wav');
    expect(text).toContain('clip3.wav');
  });

  it('shows a mix-conflict indicator when both image and audio refs are present (forbid_image_audio_mix)', () => {
    const refs = [
      { id: 'r1', assetId: 'a1', type: 'image' },
      { id: 'r2', assetId: 'a2', type: 'audio' },
    ] as Reference[];
    const assets = [
      { id: 'a1', name: 'img.png', type: 'image' },
      { id: 'a2', name: 'clip.wav', type: 'audio' },
    ] as any;
    ({ container, root } = render(
      <ReferenceSelector references={refs} assets={assets} onChange={() => {}} inputRequirements={SEEDAUDIO_REQ} />,
    ));
    expect(container.querySelector('[data-testid="ref-mix-conflict"]')).not.toBeNull();
  });

  it('does not show a mix-conflict indicator for audio-only refs', () => {
    const refs = [{ id: 'r1', assetId: 'a1', type: 'audio' }] as Reference[];
    const assets = [{ id: 'a1', name: 'clip.wav', type: 'audio' }] as any;
    ({ container, root } = render(
      <ReferenceSelector references={refs} assets={assets} onChange={() => {}} inputRequirements={SEEDAUDIO_REQ} />,
    ));
    expect(container.querySelector('[data-testid="ref-mix-conflict"]')).toBeNull();
  });
});
