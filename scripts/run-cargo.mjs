#!/usr/bin/env node
/**
 * Runs `cargo` with the repo-local GStreamer runtime on the environment,
 * mirroring what `pnpm dev` (run-desktop-tauri-dev.mjs) does for `tauri dev`.
 *
 * Why this exists: the Tauri desktop crate links against GStreamer (glib,
 * gobject, …). Two environment problems recur when invoking cargo directly:
 *   1. Build: the user's shell may export `PKG_CONFIG_PATH` (e.g. an MSYS2 /
 *      scoop mingw64 dir) that shadows the repo-local `gstreamer-dev/lib/
 *      pkgconfig`. The cargo config uses `force = false`, so the shell value
 *      wins and `glib-sys`/`gobject-sys` fail with "system library not found".
 *   2. Run: the built binary (incl. `cargo test`) needs `gstreamer-dev/bin`
 *      on `PATH` so the GStreamer DLLs/dylibs resolve, else Windows aborts
 *      with STATUS_DLL_NOT_FOUND (0xc0000135).
 *
 * This wrapper delegates the GStreamer env setup to the shared
 * `configureRuntimeEnvironment` (from gstreamer-dev-utils.mjs — the same
 * function `pnpm dev` uses), then spawns cargo with `--manifest-path` so it
 * works from any directory.
 *
 * Usage:
 *   pnpm rust:test            → cargo test
 *   pnpm rust:check           → cargo check
 *   node run-cargo.mjs <args> → cargo <args>
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configureRuntimeEnvironment,
  resolveDefaultRuntimeRoot,
} from './gstreamer-dev-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tauriDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri');
const localRuntimeRoot = path.join(tauriDir, 'gstreamer-dev');

const runtimeRoot = resolveDefaultRuntimeRoot(process.env, localRuntimeRoot);

if (runtimeRoot) {
  configureRuntimeEnvironment(process.env, runtimeRoot, tauriDir);
  console.error(`[cargo] GStreamer runtime root: ${runtimeRoot}`);
} else {
  console.warn(
    '[cargo] No GStreamer runtime root detected; the build/run may fail. ' +
      'Run `pnpm setup:gstreamer` first.',
  );
}

const cargoArgs = process.argv.slice(2);
if (cargoArgs.length === 0) {
  console.error('Usage: node run-cargo.mjs <cargo args…>  (e.g. test, check, build)');
  process.exit(2);
}

// `--manifest-path` is a subcommand option (not a top-level cargo option), so
// it must come right after the subcommand, before any test filter / trailing args.
const manifestPath = path.join(tauriDir, 'Cargo.toml');
const finalArgs = [
  cargoArgs[0],
  '--manifest-path',
  manifestPath,
  ...cargoArgs.slice(1),
];

const child = spawn('cargo', finalArgs, {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`[cargo] Failed to spawn cargo: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
});
