import { saveProject } from '@opendirector/core/services/project-service';
import { taskLog } from './task-log';

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced project save after a generation task completes.
 * Multiple completions in quick succession are coalesced into a single save.
 */
export function scheduleSaveAfterCompletion(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProject().catch((e) =>
      taskLog.warn(undefined, 'debounced_save', 'Debounced save after completion failed', { error: String(e) })
    );
  }, 2000);
}
