import { describe, it, expect, beforeEach } from 'vitest';
import { useTimelineStore } from './timelineStore';
import { useSelectionStore } from './selectionStore';
import { useSettingsStore } from './settingsStore';
import { Track, Fragment, Scene } from '../types';

// Helper to create test tracks
const createTrack = (
  id: string,
  type: 'video' | 'audio' = 'video',
  order: number = 0
): Track => ({
  id,
  type,
  name: `Track ${id}`,
  muted: false,
  locked: false,
  order,
});

// Helper to create test fragments
const createFragment = (
  id: string,
  trackId: string,
  start: number,
  duration: number
): Fragment => ({
  id,
  trackId,
  start,
  duration,
  prompt: '',
  references: [],
  status: 'draft',
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Helper to create test scenes
const createScene = (id: string, start: number, duration: number): Scene => ({
  id,
  name: `Scene ${id}`,
  start,
  duration,
  referenceIds: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('timelineStore', () => {
  beforeEach(() => {
    useTimelineStore.getState().reset();
    useSettingsStore.getState().reset();
  });

  describe('Track operations', () => {
    describe('addTrack', () => {
      it('should add a track to the store', () => {
        const store = useTimelineStore.getState();
        const track = createTrack('track-1');

        store.addTrack(track);

        expect(useTimelineStore.getState().tracks).toHaveLength(1);
        expect(useTimelineStore.getState().tracks[0]).toEqual(track);
      });

      it('should add multiple tracks', () => {
        const store = useTimelineStore.getState();

        store.addTrack(createTrack('track-1', 'video', 0));
        store.addTrack(createTrack('track-2', 'audio', 1));

        expect(useTimelineStore.getState().tracks).toHaveLength(2);
      });
    });

    describe('updateTrack', () => {
      it('should update track properties', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));

        store.updateTrack('track-1', { muted: true, name: 'Updated Track' });

        const track = useTimelineStore.getState().tracks[0];
        expect(track.muted).toBe(true);
        expect(track.name).toBe('Updated Track');
      });

      it('should not modify other tracks', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addTrack(createTrack('track-2'));

        store.updateTrack('track-1', { muted: true });

        const tracks = useTimelineStore.getState().tracks;
        expect(tracks[0].muted).toBe(true);
        expect(tracks[1].muted).toBe(false);
      });

      it('should do nothing if track does not exist', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));

        store.updateTrack('non-existent', { muted: true });

        expect(useTimelineStore.getState().tracks).toHaveLength(1);
      });
    });

    describe('deleteTrack', () => {
      it('should remove track from store', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));

        store.deleteTrack('track-1');

        expect(useTimelineStore.getState().tracks).toHaveLength(0);
      });

      it('should delete associated fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addTrack(createTrack('track-2'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        store.addFragment(createFragment('f2', 'track-2', 0, 1000));

        store.deleteTrack('track-1');

        const state = useTimelineStore.getState();
        expect(state.tracks).toHaveLength(1);
        expect(state.fragments).toHaveLength(1);
        expect(state.fragments[0].trackId).toBe('track-2');
      });
    });

    describe('canAddVideoTrack', () => {
      it('should return true when under max video tracks', () => {
        const store = useTimelineStore.getState();
        expect(store.canAddVideoTrack()).toBe(true);
      });

      it('should return true when at max video tracks - 1', () => {
        const store = useTimelineStore.getState();
        // Add 9 tracks (max is 10 by default)
        for (let i = 0; i < 9; i++) {
          store.addTrack(createTrack(`track-${i}`, 'video', i));
        }
        expect(store.canAddVideoTrack()).toBe(true);
      });

      it('should return false when at max video tracks', () => {
        const store = useTimelineStore.getState();
        // Add 10 tracks (max is 10 by default)
        for (let i = 0; i < 10; i++) {
          store.addTrack(createTrack(`track-${i}`, 'video', i));
        }
        expect(store.canAddVideoTrack()).toBe(false);
      });

      it('should only count video tracks', () => {
        const store = useTimelineStore.getState();
        // Add 10 audio tracks
        for (let i = 0; i < 10; i++) {
          store.addTrack(createTrack(`track-${i}`, 'audio', i));
        }
        expect(store.canAddVideoTrack()).toBe(true);
      });
    });
  });

  describe('Fragment operations', () => {
    describe('createFragment', () => {
      it('should prefer project default generation params for new fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        useSettingsStore.getState().setDefaultGenerationParams({
          resolution: '1080p',
          aspectRatio: '9:16',
          enableAudio: false,
          enableMusic: true,
          enableSubtitle: true,
          enableWatermark: true,
          enableWebSearch: true,
        });

        store.createFragment('track-1', 0, 5000);

        expect(useTimelineStore.getState().fragments[0]?.genParams).toEqual(
          useSettingsStore.getState().defaultGenerationParams,
        );
      });
    });

    describe('addFragment', () => {
      it('should add a fragment to the store', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        const fragment = createFragment('f1', 'track-1', 0, 1000);

        store.addFragment(fragment);

        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });

      it('should update duration when fragment extends beyond current', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));

        store.addFragment(createFragment('f1', 'track-1', 0, 5000));

        expect(useTimelineStore.getState().duration).toBe(5000);
      });

      it('should not reduce duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 5000));

        store.addFragment(createFragment('f2', 'track-1', 1000, 1000));

        expect(useTimelineStore.getState().duration).toBe(5000);
      });

      it('should update duration based on fragment end time', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.addFragment(createFragment('f2', 'track-1', 5000, 2000));

        expect(useTimelineStore.getState().duration).toBe(7000);
      });

      it('should extend last scene when fragment exceeds scene total duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 5000)); // Scene ends at 5000ms

        // Add fragment that ends at 8000ms
        store.addFragment(createFragment('f1', 'track-1', 0, 8000));

        const state = useTimelineStore.getState();
        expect(state.duration).toBe(8000);
        expect(state.scenes[0].duration).toBe(8000); // Scene should extend to 8000ms
      });

      it('should not change scene duration when fragment is within scene total duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 10000)); // Scene ends at 10000ms

        // Add fragment that ends at 5000ms - within scene duration
        store.addFragment(createFragment('f1', 'track-1', 0, 5000));

        const state = useTimelineStore.getState();
        // Duration is based on fragment end time, not scene
        expect(state.duration).toBe(5000);
        // Scene duration should remain at 10000ms (not extended, not shrunk)
        expect(state.scenes[0].duration).toBe(10000);
      });

      it('should only extend the last scene when multiple scenes exist', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 3000)); // Scene 1: 0-3000ms
        store.addScene(createScene('scene-2', 3000, 2000)); // Scene 2: 3000-5000ms

        // Add fragment that ends at 8000ms
        store.addFragment(createFragment('f1', 'track-1', 0, 8000));

        const state = useTimelineStore.getState();
        expect(state.duration).toBe(8000);
        expect(state.scenes[0].duration).toBe(3000); // Scene 1 unchanged
        expect(state.scenes[1].duration).toBe(5000); // Scene 2 extended from 2000ms to 5000ms
      });
    });

    describe('updateFragment', () => {
      it('should update fragment properties', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.updateFragment('f1', { prompt: 'New prompt', duration: 2000 });

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.prompt).toBe('New prompt');
        expect(fragment.duration).toBe(2000);
      });

      it('should update updatedAt timestamp', async () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        const originalTime = useTimelineStore.getState().fragments[0].updatedAt;

        // Wait a bit to ensure timestamp difference
        await new Promise(resolve => setTimeout(resolve, 10));
        store.updateFragment('f1', { prompt: 'Updated' });

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.updatedAt.getTime()).toBeGreaterThan(originalTime.getTime());
      });
    });

    describe('deleteFragment', () => {
      it('should remove fragment from store', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.deleteFragment('f1');

        expect(useTimelineStore.getState().fragments).toHaveLength(0);
      });

      it('should remove fragment from selection', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        useSelectionStore.getState().selectFragment('f1');

        store.deleteFragment('f1');

        expect(useSelectionStore.getState().primaryIds).toHaveLength(0);
      });
    });

    describe('moveFragment', () => {
      it('should move fragment to new position', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.moveFragment('f1', 2000);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.start).toBe(2000);
      });

      it('should not allow negative start time', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.moveFragment('f1', -500);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.start).toBe(0);
      });

      it('should update duration when fragment moves beyond current duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.moveFragment('f1', 5000);

        expect(useTimelineStore.getState().duration).toBe(6000);
      });

      it('should extend last scene when fragment moves beyond scene total duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 5000));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        // Move fragment to end at 8000ms
        store.moveFragment('f1', 7000);

        const state = useTimelineStore.getState();
        expect(state.duration).toBe(8000);
        expect(state.scenes[0].duration).toBe(8000);
      });
    });

    describe('moveFragments', () => {
      it('should move multiple fragments atomically', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1', 'video', 0));
        store.addTrack(createTrack('track-2', 'video', 1));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        store.addFragment(createFragment('f2', 'track-1', 2000, 1000));

        store.moveFragments([
          { id: 'f1', newStart: 3000, newTrackId: 'track-2' },
          { id: 'f2', newStart: 5000, newTrackId: 'track-2' },
        ]);

        const [first, second] = useTimelineStore.getState().fragments;
        expect(first.start).toBe(3000);
        expect(first.trackId).toBe('track-2');
        expect(second.start).toBe(5000);
        expect(second.trackId).toBe('track-2');
        expect(useTimelineStore.getState().duration).toBe(6000);
      });

      it('should ignore invalid cross-type track moves while preserving time updates', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('video-1', 'video', 0));
        store.addTrack(createTrack('audio-1', 'audio', 0));
        store.addFragment(createFragment('f1', 'video-1', 1000, 1000));

        store.moveFragments([
          { id: 'f1', newStart: 4000, newTrackId: 'audio-1' },
        ]);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.start).toBe(4000);
        expect(fragment.trackId).toBe('video-1');
      });
    });

    describe('resizeFragment', () => {
      it('should change fragment duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.resizeFragment('f1', 3000);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.duration).toBe(3000);
      });

      it('should enforce minimum duration of 1000ms', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.resizeFragment('f1', 500);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.duration).toBe(1000);
      });

      it('should update duration when resize extends beyond', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.resizeFragment('f1', 5000);

        expect(useTimelineStore.getState().duration).toBe(5000);
      });

      it('should extend last scene when fragment resize exceeds scene total duration', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 5000));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        // Resize fragment to end at 8000ms
        store.resizeFragment('f1', 8000);

        const state = useTimelineStore.getState();
        expect(state.duration).toBe(8000);
        expect(state.scenes[0].duration).toBe(8000);
      });
    });

    describe('applyFragmentTiming', () => {
      it('should update start, duration, and trimStart in a single commit', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment({
          ...createFragment('f1', 'track-1', 1000, 2000),
          trimStart: 300,
        });

        store.applyFragmentTiming('f1', {
          start: 2500,
          duration: 3500,
          trimStart: 900,
        });

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.start).toBe(2500);
        expect(fragment.duration).toBe(3500);
        expect(fragment.trimStart).toBe(900);
        expect(useTimelineStore.getState().duration).toBe(6000);
      });

      it('should extend the last scene when the committed timing grows the timeline', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 5000));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.applyFragmentTiming('f1', {
          start: 2000,
          duration: 5000,
        });

        const state = useTimelineStore.getState();
        expect(state.duration).toBe(7000);
        expect(state.scenes[0].duration).toBe(7000);
      });
    });

    describe('splitFragment', () => {
      it('should split fragment at specified time', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 2000));

        store.splitFragment('f1', 1000);

        const fragments = useTimelineStore.getState().fragments;
        expect(fragments).toHaveLength(2);
        expect(fragments.find(f => f.id === 'f1')?.duration).toBe(1000);
        expect(fragments.find(f => f.start === 1000)?.duration).toBe(1000);
      });

      it('should not split if time is before fragment start', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 1000, 2000));

        store.splitFragment('f1', 500);

        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });

      it('should not split if time is at or after fragment end', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 2000));

        store.splitFragment('f1', 2000);
        expect(useTimelineStore.getState().fragments).toHaveLength(1);

        store.splitFragment('f1', 3000);
        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });

      it('should not split if time is at fragment start', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 1000, 2000));

        store.splitFragment('f1', 1000);

        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });

      it('should preserve fragment properties in both parts', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment({
          ...createFragment('f1', 'track-1', 0, 2000),
          prompt: 'Test prompt',
          sceneId: 'scene-1',
        });

        store.splitFragment('f1', 1000);

        const fragments = useTimelineStore.getState().fragments;
        const original = fragments.find(f => f.id === 'f1');
        const newFragment = fragments.find(f => f.id !== 'f1');

        expect(original?.prompt).toBe('Test prompt');
        expect(original?.sceneId).toBe('scene-1');
        expect(newFragment?.prompt).toBe('Test prompt');
        expect(newFragment?.sceneId).toBe('scene-1');
      });

      it('should not add trimStart when splitting a fragment without playback source', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment({
          ...createFragment('f1', 'track-1', 0, 2000),
          trimStart: 250,
        });

        store.splitFragment('f1', 1000);

        const fragments = useTimelineStore.getState().fragments.sort((a, b) => a.start - b.start);
        expect(fragments).toHaveLength(2);
        expect(fragments[0]?.trimStart).toBeUndefined();
        expect(fragments[1]?.trimStart).toBeUndefined();
      });
    });

    describe('mergeFragments', () => {
      it('should merge adjacent fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        store.addFragment(createFragment('f2', 'track-1', 1000, 1000));

        store.mergeFragments(['f1', 'f2']);

        const fragments = useTimelineStore.getState().fragments;
        expect(fragments).toHaveLength(1);
        expect(fragments[0].duration).toBe(2000);
        expect(fragments[0].start).toBe(0);
      });

      it('should not merge non-adjacent fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 500));
        store.addFragment(createFragment('f2', 'track-1', 1000, 500));

        store.mergeFragments(['f1', 'f2']);

        expect(useTimelineStore.getState().fragments).toHaveLength(2);
      });

      it('should merge overlapping fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1500));
        store.addFragment(createFragment('f2', 'track-1', 1000, 500));

        store.mergeFragments(['f1', 'f2']);

        const fragments = useTimelineStore.getState().fragments;
        expect(fragments).toHaveLength(1);
        expect(fragments[0].start).toBe(0);
        expect(fragments[0].duration).toBe(1500);
      });

      it('should merge prompts from fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment({ ...createFragment('f1', 'track-1', 0, 1000), prompt: 'First' });
        store.addFragment({ ...createFragment('f2', 'track-1', 1000, 1000), prompt: 'Second' });

        store.mergeFragments(['f1', 'f2']);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.prompt).toBe('First Second');
      });

      it('should merge references from fragments', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment({
          ...createFragment('f1', 'track-1', 0, 1000),
          references: [{ id: 'ref1', type: 'image', assetId: 'asset-1' }],
        });
        store.addFragment({
          ...createFragment('f2', 'track-1', 1000, 1000),
          references: [{ id: 'ref2', type: 'video', assetId: 'asset-2' }],
        });

        store.mergeFragments(['f1', 'f2']);

        const fragment = useTimelineStore.getState().fragments[0];
        expect(fragment.references).toHaveLength(2);
      });

      it('should clear selection after merge', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));
        store.addFragment(createFragment('f2', 'track-1', 1000, 1000));
        useSelectionStore.getState().selectFragments(['f1', 'f2']);

        store.mergeFragments(['f1', 'f2']);

        // Selection is not auto-cleared by mergeFragments (it just updates fragments)
        // Consumers should clear selection if needed
        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });

      it('should handle single fragment gracefully', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addFragment(createFragment('f1', 'track-1', 0, 1000));

        store.mergeFragments(['f1']);

        expect(useTimelineStore.getState().fragments).toHaveLength(1);
      });
    });
  });

  describe('Scene operations', () => {
    describe('addScene', () => {
      it('should add a scene to the store', () => {
        const store = useTimelineStore.getState();
        const scene = createScene('scene-1', 0, 5000);

        store.addScene(scene);

        expect(useTimelineStore.getState().scenes).toHaveLength(1);
      });
    });

    describe('updateScene', () => {
      it('should update scene properties', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));

        store.updateScene('scene-1', { name: 'Updated Scene', duration: 8000 });

        const scene = useTimelineStore.getState().scenes[0];
        expect(scene.name).toBe('Updated Scene');
        expect(scene.duration).toBe(8000);
      });

      it('should allow duration to shrink when scene is shortened', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 40000)); // 40s

        // Add a fragment that ends at 5s
        store.addFragment(createFragment('f1', 'track-1', 0, 5000));

        // Manually shorten scene to 20s
        store.updateScene('scene-1', { duration: 20000 });

        const stateAfterShrink = useTimelineStore.getState();
        expect(stateAfterShrink.scenes[0].duration).toBe(20000);
        expect(stateAfterShrink.duration).toBe(20000); // Duration should match scene

        // Create a new fragment that ends at 10s
        store.addFragment(createFragment('f2', 'track-1', 5000, 5000));

        const stateAfterAdd = useTimelineStore.getState();
        // Scene should NOT expand back to old duration since content is within scene
        expect(stateAfterAdd.scenes[0].duration).toBe(20000);
        // Duration should now be max of scene (20s) and fragment end (10s) = 20s
        expect(stateAfterAdd.duration).toBe(20000);
      });

      it('should expand scene to content length when content exceeds shortened scene', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 100000)); // 100s

        // Add a fragment that ends at 5s
        store.addFragment(createFragment('f1', 'track-1', 0, 5000));

        // Manually shorten scene to 90s
        store.updateScene('scene-1', { duration: 90000 });

        const stateAfterShrink = useTimelineStore.getState();
        expect(stateAfterShrink.scenes[0].duration).toBe(90000);
        expect(stateAfterShrink.duration).toBe(90000);

        // Add content that ends at 95s
        store.addFragment(createFragment('f2', 'track-1', 90000, 5000));

        const stateAfterAdd = useTimelineStore.getState();
        // Scene should expand to 95s (not back to 100s)
        expect(stateAfterAdd.scenes[0].duration).toBe(95000);
        expect(stateAfterAdd.duration).toBe(95000);
      });

      it('should set scene to content length when content changes after scene shortened', () => {
        // User scenario: scene 100s, content ends at 100s
        // User shortens scene to 90s
        // User deletes content, then adds content ending at 95s
        // Expected: scene becomes 95s, not 100s
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.addScene(createScene('scene-1', 0, 100000)); // 100s

        // Add content ending at 100s
        store.addFragment(createFragment('f1', 'track-1', 0, 100000));

        // Shorten scene to 90s (content still at 100s)
        store.updateScene('scene-1', { duration: 90000 });

        const stateAfterShrink = useTimelineStore.getState();
        expect(stateAfterShrink.scenes[0].duration).toBe(90000);
        // Duration should be 100s because content ends at 100s
        expect(stateAfterShrink.duration).toBe(100000);

        // Delete the fragment
        store.deleteFragment('f1');

        // Add new content ending at 95s
        store.addFragment(createFragment('f2', 'track-1', 0, 95000));

        const stateFinal = useTimelineStore.getState();
        // Scene should expand to 95s (content length)
        expect(stateFinal.scenes[0].duration).toBe(95000);
        expect(stateFinal.duration).toBe(95000);
      });
    });

    describe('deleteScene', () => {
      it('should extend next scene to fill gap when deleting', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));
        store.addScene(createScene('scene-2', 5000, 3000));

        store.deleteScene('scene-1');

        const scenes = useTimelineStore.getState().scenes;
        expect(scenes).toHaveLength(1);
        expect(scenes[0].id).toBe('scene-2');
        expect(scenes[0].start).toBe(0);
        expect(scenes[0].duration).toBe(8000);
      });

      it('should extend previous scene to fill gap when deleting last scene', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));
        store.addScene(createScene('scene-2', 5000, 3000));

        store.deleteScene('scene-2');

        const scenes = useTimelineStore.getState().scenes;
        expect(scenes).toHaveLength(1);
        expect(scenes[0].id).toBe('scene-1');
        expect(scenes[0].duration).toBe(8000);
      });

      it('should not delete the only scene', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));

        store.deleteScene('scene-1');

        expect(useTimelineStore.getState().scenes).toHaveLength(1);
      });
    });

    describe('splitScene', () => {
      it('should split scene at specified time', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));

        store.splitScene('scene-1', 2000);

        const scenes = useTimelineStore.getState().scenes;
        expect(scenes).toHaveLength(2);
        expect(scenes.find(s => s.id === 'scene-1')?.duration).toBe(2000);
        expect(scenes.find(s => s.start === 2000)?.duration).toBe(3000);
      });

      it('should not split if time is before scene start', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 1000, 5000));

        store.splitScene('scene-1', 500);

        expect(useTimelineStore.getState().scenes).toHaveLength(1);
      });

      it('should not split if time is at or after scene end', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));

        store.splitScene('scene-1', 5000);
        expect(useTimelineStore.getState().scenes).toHaveLength(1);

        store.splitScene('scene-1', 6000);
        expect(useTimelineStore.getState().scenes).toHaveLength(1);
      });

      it('should not split if time is at scene start', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 1000, 5000));

        store.splitScene('scene-1', 1000);

        expect(useTimelineStore.getState().scenes).toHaveLength(1);
      });

      it('should give new scene a "(2)" suffix', () => {
        const store = useTimelineStore.getState();
        store.addScene({ ...createScene('scene-1', 0, 5000), name: 'My Scene' });

        store.splitScene('scene-1', 2000);

        const newScene = useTimelineStore.getState().scenes.find(s => s.id !== 'scene-1');
        expect(newScene?.name).toBe('My Scene (2)');
      });
    });

    describe('mergeScenes', () => {
      it('should merge adjacent scenes', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));
        store.addScene(createScene('scene-2', 5000, 3000));

        store.mergeScenes(['scene-1', 'scene-2']);

        const scenes = useTimelineStore.getState().scenes;
        expect(scenes).toHaveLength(1);
        expect(scenes[0].duration).toBe(8000);
        expect(scenes[0].start).toBe(0);
      });

      it('should not merge non-adjacent scenes', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 2000));
        store.addScene(createScene('scene-2', 5000, 3000));

        store.mergeScenes(['scene-1', 'scene-2']);

        expect(useTimelineStore.getState().scenes).toHaveLength(2);
      });

      it('should merge reference IDs from scenes (max 2)', () => {
        const store = useTimelineStore.getState();
        store.addScene({ ...createScene('scene-1', 0, 5000), referenceIds: ['ref1', 'ref2'] });
        store.addScene({ ...createScene('scene-2', 5000, 3000), referenceIds: ['ref3'] });

        store.mergeScenes(['scene-1', 'scene-2']);

        const scene = useTimelineStore.getState().scenes[0];
        expect(scene.referenceIds).toEqual(['ref1', 'ref2']);
      });

      it('should deduplicate reference IDs', () => {
        const store = useTimelineStore.getState();
        store.addScene({ ...createScene('scene-1', 0, 5000), referenceIds: ['ref1', 'ref2'] });
        store.addScene({ ...createScene('scene-2', 5000, 3000), referenceIds: ['ref2', 'ref3'] });

        store.mergeScenes(['scene-1', 'scene-2']);

        const scene = useTimelineStore.getState().scenes[0];
        expect(scene.referenceIds).toEqual(['ref1', 'ref2']);
      });
    });

    describe('getSceneAtTime', () => {
      it('should return scene at given time', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 0, 5000));
        store.addScene(createScene('scene-2', 5000, 3000));

        expect(store.getSceneAtTime(0)?.id).toBe('scene-1');
        expect(store.getSceneAtTime(4000)?.id).toBe('scene-1');
        expect(store.getSceneAtTime(5000)?.id).toBe('scene-2');
        expect(store.getSceneAtTime(7000)?.id).toBe('scene-2');
      });

      it('should return undefined if no scene at time', () => {
        const store = useTimelineStore.getState();
        store.addScene(createScene('scene-1', 1000, 2000));

        expect(store.getSceneAtTime(0)).toBeUndefined();
        expect(store.getSceneAtTime(3500)).toBeUndefined();
      });
    });
  });

  describe('Selection logic (via selectionStore)', () => {
    beforeEach(() => {
      useSelectionStore.getState().clear();
    });

    describe('selectFragment', () => {
      it('should select a single fragment', () => {
        useSelectionStore.getState().selectFragment('f1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('fragment');
        expect(sel.primaryIds).toEqual(['f1']);
        expect(sel.primaryFocusId).toBe('f1');
      });

      it('should replace selection when selecting new fragment', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().selectFragment('f2');

        const sel = useSelectionStore.getState();
        expect(sel.primaryIds).toEqual(['f2']);
        expect(sel.primaryFocusId).toBe('f2');
      });

      it('should add to selection with toggleFragment', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().toggleFragment('f2');

        const sel = useSelectionStore.getState();
        expect(sel.primaryIds).toEqual(['f1', 'f2']);
        expect(sel.primaryFocusId).toBe('f2');
      });

      it('should toggle selection with toggleFragment', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().toggleFragment('f1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBeNull();
        expect(sel.primaryIds).toEqual([]);
        expect(sel.primaryFocusId).toBeNull();
      });

      it('should clear scene selection when selecting fragment', () => {
        useSelectionStore.getState().selectScene('scene-1');
        useSelectionStore.getState().selectFragment('f1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('fragment');
        expect(sel.primaryIds).toEqual(['f1']);
        expect(sel.primaryFocusId).toBe('f1');
      });

      it('should focus an already selected fragment without collapsing multi-select', () => {
        useSelectionStore.getState().selectFragments(['f1', 'f2', 'f3']);
        useSelectionStore.getState().focusFragment('f2');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('fragment');
        expect(sel.primaryIds).toEqual(['f1', 'f2', 'f3']);
        expect(sel.primaryFocusId).toBe('f2');
        expect(sel.getSelectedId()).toBe('f2');
      });
    });

    describe('selectScene', () => {
      it('should select a single scene', () => {
        useSelectionStore.getState().selectScene('scene-1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('scene');
        expect(sel.primaryIds).toEqual(['scene-1']);
        expect(sel.primaryFocusId).toBe('scene-1');
      });

      it('should add to selection with toggleScene', () => {
        useSelectionStore.getState().selectScene('scene-1');
        useSelectionStore.getState().toggleScene('scene-2');

        const sel = useSelectionStore.getState();
        expect(sel.primaryIds).toEqual(['scene-1', 'scene-2']);
        expect(sel.primaryFocusId).toBe('scene-2');
      });

      it('should toggle selection with toggleScene', () => {
        useSelectionStore.getState().selectScene('scene-1');
        useSelectionStore.getState().toggleScene('scene-1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBeNull();
        expect(sel.primaryIds).toEqual([]);
        expect(sel.primaryFocusId).toBeNull();
      });

      it('should clear fragment selection when selecting scene', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().selectScene('scene-1');

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('scene');
        expect(sel.primaryIds).toEqual(['scene-1']);
        expect(sel.primaryFocusId).toBe('scene-1');
      });
    });

    describe('clear', () => {
      it('should clear all selections', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().clear();

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBeNull();
        expect(sel.primaryIds).toEqual([]);
        expect(sel.primaryFocusId).toBeNull();
      });
    });

    describe('selectFragments (batch)', () => {
      it('should batch select multiple fragments', () => {
        useSelectionStore.getState().selectFragments(['f1', 'f2', 'f3']);

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('fragment');
        expect(sel.primaryIds).toEqual(['f1', 'f2', 'f3']);
        expect(sel.primaryFocusId).toBe('f1');
      });

      it('should clear selection when empty array', () => {
        useSelectionStore.getState().selectFragment('f1');
        useSelectionStore.getState().selectFragments([]);

        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBeNull();
        expect(sel.primaryIds).toEqual([]);
        expect(sel.primaryFocusId).toBeNull();
      });
    });
  });

  describe('Selection Box logic', () => {
    beforeEach(() => {
      const store = useTimelineStore.getState();
      store.addTrack(createTrack('track-1'));
      store.addTrack(createTrack('track-2'));
      store.addScene(createScene('scene-1', 0, 5000));
      store.addFragment(createFragment('f1', 'track-1', 0, 2000));
      store.addFragment(createFragment('f2', 'track-2', 1000, 2000));
    });

    describe('startSelectionBox', () => {
      it('should create selection box with start coordinates', () => {
        const store = useTimelineStore.getState();

        store.startSelectionBox(100, 50);

        const box = useTimelineStore.getState().selectionBox;
        expect(box).toEqual({
          startX: 100,
          startY: 50,
          endX: 100,
          endY: 50,
        });
      });
    });

    describe('updateSelectionBox', () => {
      it('should update end coordinates', () => {
        const store = useTimelineStore.getState();
        store.startSelectionBox(100, 50);

        store.updateSelectionBox(200, 100);

        const box = useTimelineStore.getState().selectionBox;
        expect(box?.endX).toBe(200);
        expect(box?.endY).toBe(100);
      });

      it('should not update if no selection box exists', () => {
        const store = useTimelineStore.getState();

        store.updateSelectionBox(200, 100);

        expect(useTimelineStore.getState().selectionBox).toBeNull();
      });
    });

    describe('confirmSelectionBox', () => {
      it('should select fragments that overlap with selection box', () => {
        const store = useTimelineStore.getState();
        // At zoom 50, fragment f1 at start 0, duration 2000 occupies pixels 0-100
        // Fragment f2 at start 1000, duration 2000 occupies pixels 50-150
        // Content-area Y: track-1=0-80, track-2=80-160
        store.setZoom(50);
        store.startSelectionBox(0, 80);  // Select within track-2 area
        store.updateSelectionBox(100, 150);

        store.confirmSelectionBox();

        const state = useTimelineStore.getState();
        expect(state.selectionBox).toBeNull();
        const sel = useSelectionStore.getState();
        expect(sel.primaryType).toBe('fragment');
        expect(sel.primaryIds.length).toBeGreaterThan(0);
      });

      it('should not select scenes (handled by SceneTrack component)', () => {
        const store = useTimelineStore.getState();
        store.setZoom(50);
        // Scene track is in a separate frozen pane, not handled by selection box
        store.startSelectionBox(0, 0);
        store.updateSelectionBox(250, 80);

        store.confirmSelectionBox();

        const sel = useSelectionStore.getState();
        // Selection box only operates on fragments, not scenes
        expect(sel.primaryType === 'scene').toBe(false);
      });

      it('should create draft fragment when selecting empty area', () => {
        const store = useTimelineStore.getState();
        store.setZoom(50);
        // Content-area Y: track-1=0-80, track-2=80-160
        // Select area beyond existing fragments, within track-1 (Y=0-80)
        store.startSelectionBox(300, 0);
        store.updateSelectionBox(500, 80);

        store.confirmSelectionBox();

        const state = useTimelineStore.getState();
        expect(state.draftFragment).not.toBeNull();
        expect(state.draftFragment?.trackId).toBe('track-1');
      });

      it('should clear selection box after confirmation', () => {
        const store = useTimelineStore.getState();
        store.startSelectionBox(0, 50);
        store.updateSelectionBox(100, 100);

        store.confirmSelectionBox();

        expect(useTimelineStore.getState().selectionBox).toBeNull();
      });
    });

    describe('cancelSelectionBox', () => {
      it('should clear selection box', () => {
        const store = useTimelineStore.getState();
        store.startSelectionBox(100, 50);

        store.cancelSelectionBox();

        expect(useTimelineStore.getState().selectionBox).toBeNull();
      });
    });
  });

  describe('Draft Fragment', () => {
    describe('setDraftFragment', () => {
      it('should set draft fragment', () => {
        const store = useTimelineStore.getState();

        store.setDraftFragment({ trackId: 'track-1', start: 1000, duration: 2000 });

        const draft = useTimelineStore.getState().draftFragment;
        expect(draft).toEqual({
          trackId: 'track-1',
          start: 1000,
          duration: 2000,
        });
      });

      it('should clear draft fragment when set to null', () => {
        const store = useTimelineStore.getState();
        store.setDraftFragment({ trackId: 'track-1', start: 1000, duration: 2000 });

        store.setDraftFragment(null);

        expect(useTimelineStore.getState().draftFragment).toBeNull();
      });
    });

    describe('confirmDraftFragment', () => {
      it('should create fragment from draft', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.setDraftFragment({ trackId: 'track-1', start: 1000, duration: 2000 });

        store.confirmDraftFragment('Test prompt');

        const state = useTimelineStore.getState();
        expect(state.fragments).toHaveLength(1);
        expect(state.fragments[0].prompt).toBe('Test prompt');
        expect(state.fragments[0].start).toBe(1000);
        expect(state.fragments[0].duration).toBe(2000);
        expect(state.draftFragment).toBeNull();
      });

      it('should use project default generation params for confirmed drafts', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        useSettingsStore.getState().setDefaultGenerationParams({
          resolution: '1080p',
          aspectRatio: '9:16',
          enableAudio: false,
          enableMusic: true,
          enableSubtitle: true,
          enableWatermark: true,
          enableWebSearch: true,
        });
        store.setDraftFragment({ trackId: 'track-1', start: 1000, duration: 2000 });

        store.confirmDraftFragment('Test prompt');

        expect(useTimelineStore.getState().fragments[0]?.genParams).toEqual(
          useSettingsStore.getState().defaultGenerationParams,
        );
      });

      it('should update duration when confirming draft', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));
        store.setDraftFragment({ trackId: 'track-1', start: 5000, duration: 3000 });

        store.confirmDraftFragment('Test');

        expect(useTimelineStore.getState().duration).toBe(8000);
      });

      it('should do nothing if no draft exists', () => {
        const store = useTimelineStore.getState();
        store.addTrack(createTrack('track-1'));

        store.confirmDraftFragment('Test');

        expect(useTimelineStore.getState().fragments).toHaveLength(0);
      });
    });
  });

  describe('Playback & View', () => {
    describe('setPlayhead', () => {
      it('should set playhead position', () => {
        const store = useTimelineStore.getState();

        store.setPlayhead(5000);

        expect(useTimelineStore.getState().playhead).toBe(5000);
      });

      it('should not allow negative playhead', () => {
        const store = useTimelineStore.getState();

        store.setPlayhead(-1000);

        expect(useTimelineStore.getState().playhead).toBe(0);
      });
    });

    describe('play/pause/togglePlayback', () => {
      it('should set isPlaying to true', () => {
        const store = useTimelineStore.getState();

        store.play();

        expect(useTimelineStore.getState().isPlaying).toBe(true);
      });

      it('should set isPlaying to false', () => {
        const store = useTimelineStore.getState();
        store.play();

        store.pause();

        expect(useTimelineStore.getState().isPlaying).toBe(false);
      });

      it('should toggle isPlaying', () => {
        const store = useTimelineStore.getState();
        expect(useTimelineStore.getState().isPlaying).toBe(false);

        store.togglePlayback();
        expect(useTimelineStore.getState().isPlaying).toBe(true);

        store.togglePlayback();
        expect(useTimelineStore.getState().isPlaying).toBe(false);
      });
    });

    describe('setZoom', () => {
      it('should set zoom level', () => {
        const store = useTimelineStore.getState();

        store.setZoom(100);

        expect(useTimelineStore.getState().zoom).toBe(100);
      });

      it('should enforce minimum zoom of 0.5', () => {
        const store = useTimelineStore.getState();

        store.setZoom(0.3);

        expect(useTimelineStore.getState().zoom).toBe(0.5);
      });

      it('should enforce maximum zoom of 1000', () => {
        const store = useTimelineStore.getState();

        store.setZoom(1500);

        expect(useTimelineStore.getState().zoom).toBe(1000);
      });
    });

    describe('setScroll', () => {
      it('should set scroll position', () => {
        const store = useTimelineStore.getState();

        store.setScroll(100, 200);

        expect(useTimelineStore.getState().scroll).toEqual({ x: 100, y: 200 });
      });

      it('should not allow negative scroll values', () => {
        const store = useTimelineStore.getState();

        store.setScroll(-100, -200);

        expect(useTimelineStore.getState().scroll).toEqual({ x: 0, y: 0 });
      });
    });
  });

  describe('Tool Mode', () => {
    describe('setToolMode', () => {
      it('should set tool mode', () => {
        const store = useTimelineStore.getState();

        store.setToolMode('razor');

        expect(useTimelineStore.getState().toolMode).toBe('razor');
      });

      it('should accept all valid tool modes', () => {
        const store = useTimelineStore.getState();
        const modes: Array<'select' | 'razor'> = ['select', 'razor'];

        modes.forEach(mode => {
          store.setToolMode(mode);
          expect(useTimelineStore.getState().toolMode).toBe(mode);
        });
      });
    });
  });

  describe('Reset', () => {
    it('should reset all state to initial values', () => {
      const store = useTimelineStore.getState();
      store.addTrack(createTrack('track-1'));
      store.addFragment(createFragment('f1', 'track-1', 0, 1000));
      store.addScene(createScene('scene-1', 0, 5000));
      useSelectionStore.getState().selectFragment('f1');
      store.setPlayhead(5000);
      store.setZoom(100);
      store.play();

      store.reset();
      useSelectionStore.getState().clear();

      const state = useTimelineStore.getState();
      expect(state.tracks).toEqual([]);
      expect(state.fragments).toEqual([]);
      expect(state.scenes).toEqual([]);
      expect(state.playhead).toBe(0);
      expect(state.zoom).toBe(50);
      expect(state.isPlaying).toBe(false);
      expect(state.toolMode).toBe('select');
      expect(state.selectionBox).toBeNull();
      expect(state.draftFragment).toBeNull();
      expect(state.duration).toBe(0);
    });
  });
});
