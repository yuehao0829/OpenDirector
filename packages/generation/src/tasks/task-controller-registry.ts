/**
 * TaskController registry — per-provider-type dispatch for the generation task
 * lifecycle.
 *
 * Each registered controller encapsulates the provider-specific Rust calls for
 * start / cancel / resume, plus optional JS-side status polling
 * (batchQuery / getTaskStatus / downloadResult / refreshActive) for providers
 * that support it.
 *
 * Design rules:
 * - NO silent seedance fallback. `requireTaskController(typeId)` throws if the
 *   typeId is unregistered. Recovery / refresh paths must skip-with-warning
 *   (`taskLog.warn`) for unregistered types rather than routing to seedance.
 * - `acknowledgeTask` and `listPendingTasks` are intentionally NOT on the
 *   controller — they are type-agnostic (shared pending-tasks dir) and live on
 *   `tauriBridge` directly.
 * - Optional methods (`batchQuery` etc.) are present only on providers that
 *   support JS-side status polling. Callers must guard with `?.` and skip
 *   providers that don't implement them.
 */

import type { Generation } from '@opendirector/core/types/generation';
import type { GenerationParams } from '@opendirector/core/types/generation';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import type { TaskStatusResult } from '@opendirector/core/types/ai-video';
import type { SubmitGenerationOptions } from '@opendirector/core/types/service-interfaces';

/** High-level input passed to a controller's `start` method. */
export interface TaskControllerStartInput {
  fragmentId: string;
  instanceId: string;
  modelId: string;
  params: GenerationParams;
  options?: SubmitGenerationOptions;
  /** Resolved provider instance (avoids a second store lookup inside the controller). */
  instance?: ProviderInstance;
}

/** Input for the optional `downloadResult` method. */
export interface DownloadResultInput {
  url: string;
  projectPath: string;
  generationId: string;
}

/** Result of a download operation. */
export interface DownloadResult {
  file_path: string;
  file_size: number;
}

/**
 * Per-provider task lifecycle controller.
 *
 * Required methods (every controller): start, cancel, resume.
 * Optional methods (only providers supporting JS-side status polling):
 * batchQuery, getTaskStatus, downloadResult, refreshActive.
 */
export interface TaskController {
  /** Start a generation task. Returns the local task_id. */
  start(input: TaskControllerStartInput): Promise<string>;

  /** Cancel a running task (sends a cancel signal to the Rust manager). */
  cancel(taskId: string): Promise<boolean>;

  /** Resume a pending task after app restart (re-registers with the Rust coordinator). */
  resume(taskId: string, password: string): Promise<boolean>;

  /**
   * Batch-query task statuses from the provider's API.
   * Only providers with a JS-side polling endpoint implement this
   * (Seedance via ARK batch query). MiniMax / GPT Image do NOT.
   */
  batchQuery?(
    instance: ProviderInstance,
    password: string,
    taskIds: string[],
  ): Promise<TaskStatusResult[]>;

  /** Query a single task's status from the provider's API. */
  getTaskStatus?(
    instance: ProviderInstance,
    password: string,
    taskId: string,
  ): Promise<TaskStatusResult>;

  /** Download a generation result (video/audio) to the project directory. */
  downloadResult?(input: DownloadResultInput): Promise<DownloadResult>;

  /**
   * Refresh active generations for this provider type by querying the server.
   * Only Seedance implements this (it has a JS-side batch query endpoint).
   * MiniMax is event-driven via its Rust coordinator and does NOT.
   */
  refreshActive?(gens: Generation[], folderPath?: string): Promise<void>;
}

const registry = new Map<string, TaskController>();

/** Register a TaskController for a provider typeId. */
export function registerTaskController(typeId: string, controller: TaskController): void {
  registry.set(typeId, controller);
}

/** Look up a TaskController by typeId. Returns undefined if unregistered. */
export function getTaskController(typeId: string): TaskController | undefined {
  return registry.get(typeId);
}

/**
 * Require a TaskController for a provider typeId.
 * Throws loudly if no controller is registered — this is the explicit
 * "no silent seedance fallback" guarantee. Callers that can tolerate a
 * missing controller (recovery / refresh paths) should use
 * `getTaskController` and skip-with-warning instead.
 */
export function requireTaskController(typeId: string): TaskController {
  const controller = registry.get(typeId);
  if (!controller) {
    throw new Error(
      `No TaskController registered for typeId "${typeId}". ` +
        'Register a controller via registerTaskController before dispatching tasks for this provider type.',
    );
  }
  return controller;
}

/**
 * Send a cancel signal to EVERY registered controller.
 *
 * Cancel is keyed by task_id in the Rust managers (each provider's manager
 * looks the task up by id and no-ops if absent), so sending to all controllers
 * is safe and idempotent. This is the fallback for when the provider INSTANCE
 * has been deleted (so its typeId is unknown) — the task is still registered in
 * exactly one Rust manager by task_id, and we must reach that manager to stop
 * it. Resume/acknowledge do NOT need this (resume needs a password; acknowledge
 * is already type-agnostic).
 */
export async function cancelAcrossControllers(taskId: string): Promise<void> {
  await Promise.all(
    Array.from(registry.values()).map((controller) =>
      controller.cancel(taskId).catch((err) => {
        // Best-effort: one controller failing must not block the others, and
        // the task is registered in at most one manager — the rest no-op.
        console.warn(`[task-controller] cancel signal failed for a controller (task ${taskId}):`, err);
      }),
    ),
  );
}
