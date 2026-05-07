#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearEnvValue,
  delay,
  getEnvValue,
  inferRuntimeRootFromPath,
  MAC_FRAMEWORK_ROOTS,
  resolveReadyRuntimeRoot,
  setEnvValue,
} from './gstreamer-dev-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tauriDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri');
const localRuntimeRoot = path.join(tauriDir, 'gstreamer-dev');
const bundledRuntimeDir = path.join(tauriDir, 'gstreamer-runtime');
const runtimeRootDir = path.join(tauriDir, 'gstreamer-runtime-root');
const stagingToken = `${process.pid}-${Date.now()}`;
const windowsRenameRetryCount = 20;
const windowsRenameRetryDelayMs = 300;
const PREBUNDLED_MAC_RUNTIME_MARKER = '.opendirector-gstreamer-runtime.json';

async function main() {
  const stagedOutput = createStagedOutputPaths();

  try {
    switch (process.platform) {
      case 'win32':
        prepareWindowsRuntime(stagedOutput);
        break;
      case 'darwin':
        prepareMacRuntime(stagedOutput);
        break;
      default:
        throw new Error('Only Windows and macOS release bundles are supported.');
    }

    await publishStagedOutputs(stagedOutput);
  } finally {
    await cleanupStagedOutputs(stagedOutput);
  }
}

function prepareWindowsRuntime(stagedOutput) {
  const env = { ...process.env };
  const runtimeRoot = resolveWindowsRuntimeRoot(env);

  clearEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT');
  setEnvValue(env, 'OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR', stagedOutput.runtime);
  setEnvValue(env, 'OPENDIRECTOR_GSTREAMER_BUNDLE_ROOT_DLL_DIR', stagedOutput.rootDll);
  if (runtimeRoot) {
    setEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT', runtimeRoot);
    setEnvValue(env, 'GSTREAMER_1_0_ROOT_MSVC_X86_64', runtimeRoot);
    setEnvValue(env, 'GSTREAMER_1_0_ROOT_X86_64', runtimeRoot);
    console.log(`[GStreamer Bundle] Using Windows runtime root: ${runtimeRoot}`);
  } else {
    console.warn(
      '[GStreamer Bundle] No Windows runtime root detected before bundling; falling back to bundle script defaults.',
    );
  }

  runCommand(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'bundle-gstreamer-windows.ps1'),
    ],
    env,
  );
}

function prepareMacRuntime(stagedOutput) {
  const env = { ...process.env };
  const runtimeRoot = resolveMacRuntimeRoot(env);

  clearEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT');
  setEnvValue(env, 'OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR', stagedOutput.runtime);
  if (runtimeRoot) {
    setEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT', runtimeRoot);
    console.log(`[GStreamer Bundle] Using macOS runtime root: ${runtimeRoot}`);
  } else {
    console.warn(
      '[GStreamer Bundle] No prebuilt macOS runtime root detected; falling back to local macOS bundling.',
    );
  }

  if (runtimeRoot && isPrebundledMacRuntime(runtimeRoot)) {
    cpSync(runtimeRoot, stagedOutput.runtime, { recursive: true });
    console.log(`[GStreamer Bundle] Copied prebundled macOS runtime from: ${runtimeRoot}`);
  } else {
    runCommand('bash', [path.join(__dirname, 'bundle-gstreamer-macos.sh')], env);
  }

  // macOS does not need root-level DLLs, but tauri.conf.json references
  // gstreamer-runtime-root/ as a resource path. Create an empty directory
  // so Tauri's build does not fail with "resource path doesn't exist".
  mkdirSync(stagedOutput.rootDll, { recursive: true });
}

function isPrebundledMacRuntime(runtimeRoot) {
  return existsSync(path.join(runtimeRoot, PREBUNDLED_MAC_RUNTIME_MARKER));
}

function createStagedOutputPaths() {
  return {
    runtime: `${bundledRuntimeDir}.next-${stagingToken}`,
    rootDll: `${runtimeRootDir}.next-${stagingToken}`,
  };
}

async function publishStagedOutputs(stagedOutput) {
  const mappings = [
    {
      stagedPath: stagedOutput.runtime,
      targetPath: bundledRuntimeDir,
    },
    {
      stagedPath: stagedOutput.rootDll,
      targetPath: runtimeRootDir,
    },
  ];

  const publishState = [];

  try {
    for (const mapping of mappings) {
      if (!existsSync(mapping.stagedPath)) {
        throw new Error(`Bundler did not produce expected output at ${mapping.stagedPath}`);
      }

      const state = {
        ...mapping,
        backupPath: `${mapping.targetPath}.backup-${stagingToken}`,
        hadTarget: false,
        published: false,
      };
      publishState.push(state);

      await rm(state.backupPath, { recursive: true, force: true });

      if (existsSync(state.targetPath)) {
        state.hadTarget = true;
        await renameWithRetry(state.targetPath, state.backupPath);
      }

      await renameWithRetry(state.stagedPath, state.targetPath);
      state.published = true;
    }

    await Promise.all(
      publishState
        .filter((state) => state.hadTarget)
        .map((state) => rm(state.backupPath, { recursive: true, force: true })),
    );
  } catch (error) {
    await rollbackPublishedOutputs(publishState);
    throw error;
  }
}

async function rollbackPublishedOutputs(publishState) {
  for (const state of [...publishState].reverse()) {
    if (state.published && existsSync(state.targetPath)) {
      await rm(state.targetPath, { recursive: true, force: true });
    }

    if (state.hadTarget && existsSync(state.backupPath)) {
      await renameWithRetry(state.backupPath, state.targetPath);
      continue;
    }

    await rm(state.backupPath, { recursive: true, force: true });
  }
}

async function cleanupStagedOutputs(stagedOutput) {
  await Promise.all(
    Object.values(stagedOutput).map((stagedPath) =>
      rm(stagedPath, { recursive: true, force: true }),
    ),
  );
}

async function renameWithRetry(sourcePath, targetPath) {
  const maxAttempts = process.platform === 'win32' ? windowsRenameRetryCount : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!shouldRetryRename(error) || attempt === maxAttempts) {
        throw error;
      }

      await delay(windowsRenameRetryDelayMs);
    }
  }
}

function shouldRetryRename(error) {
  return ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
}

function resolveWindowsRuntimeRoot(env) {
  return resolveReadyRuntimeRoot(
    [
      getEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT'),
      getEnvValue(env, 'GSTREAMER_1_0_ROOT_MSVC_X86_64'),
      getEnvValue(env, 'GSTREAMER_1_0_ROOT_X86_64'),
      localRuntimeRoot,
      inferRuntimeRootFromPath(getEnvValue(env, 'PATH'), 'win32'),
    ],
    'win32',
  );
}

function resolveMacRuntimeRoot(env) {
  return resolveReadyRuntimeRoot(
    [
      getEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT'),
      localRuntimeRoot,
      ...MAC_FRAMEWORK_ROOTS,
    ],
    'darwin',
  );
}

function runCommand(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

main().catch((error) => {
  console.error(`[GStreamer Bundle] ${error.message}`);
  process.exitCode = 1;
});
