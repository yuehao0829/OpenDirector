import { useTimelineStore } from '@opendirector/core/stores/timelineStore';

/**
 * Reset a fragment's status if it is currently 'generating'.
 * Used when a generation task fails, is cancelled, or expires —
 * the fragment should not remain stuck in 'generating' without an active task.
 */
export function resetFragmentIfGenerating(fragmentId: string, status: 'draft' | 'failed'): void {
  const fragment = useTimelineStore.getState().fragments.find((f) => f.id === fragmentId);
  if (fragment && fragment.status === 'generating') {
    useTimelineStore.getState().updateFragment(fragmentId, { status });
  }
}
