/**
 * Task Log — thin wrapper around the Tauri write_generation_log command.
 * All calls are fire-and-forget; errors are silently swallowed so logging
 * never interferes with the application.
 *
 * If projectPath is undefined, the call is silently skipped (no-op).
 */

import { tauriBridge } from '@opendirector/core/services/tauri-bridge';

interface TaskLogOptions {
  taskId?: string;
  durationMs?: number;
  /** Arbitrary structured data for this log entry */
  [key: string]: unknown;
}

async function write(
  projectPath: string | undefined,
  level: 'info' | 'warn' | 'error',
  phase: string,
  msg: string,
  opts?: TaskLogOptions,
): Promise<void> {
  if (!projectPath) return;
  try {
    const { taskId, durationMs, ...data } = opts ?? {};
    await tauriBridge.generationLogApi.writeGenerationLog({
      projectPath,
      level,
      taskId,
      phase,
      msg,
      durationMs,
      data,
    });
  } catch {
    // Swallow — logging failure must never break the app
  }
}

export const taskLog = {
  info(projectPath: string | undefined, phase: string, msg: string, opts?: TaskLogOptions) {
    return write(projectPath, 'info', phase, msg, opts);
  },
  warn(projectPath: string | undefined, phase: string, msg: string, opts?: TaskLogOptions) {
    return write(projectPath, 'warn', phase, msg, opts);
  },
  error(projectPath: string | undefined, phase: string, msg: string, opts?: TaskLogOptions) {
    return write(projectPath, 'error', phase, msg, opts);
  },
};
