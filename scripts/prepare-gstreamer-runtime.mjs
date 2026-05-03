#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tauriDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri');
const localRuntimeRoot = path.join(tauriDir, 'gstreamer-dev');
const bundledRuntimeDir = path.join(tauriDir, 'gstreamer-runtime');
const runtimeRootDir = path.join(tauriDir, 'gstreamer-runtime-root');
const requiredTools = ['gst-discoverer-1.0', 'gst-inspect-1.0', 'ges-launch-1.0'];
const macFrameworkRoots = [
  '/Library/Frameworks/GStreamer.framework/Versions/Current',
  '/Library/Frameworks/GStreamer.framework/Versions/1.0',
];
const stagingToken = `${process.pid}-${Date.now()}`;

async function main() {
  const stagedOutput = createStagedOutputPaths(process.platform);

  try {
    if (process.platform === 'win32') {
      prepareWindowsRuntime(stagedOutput);
      await publishStagedOutputs(stagedOutput);
      return;
    }

    if (process.platform === 'darwin') {
      prepareMacRuntime(stagedOutput);
      await publishStagedOutputs(stagedOutput);
      return;
    }

    throw new Error('Only Windows and macOS release bundles are supported.');
  } finally {
    await cleanupStagedOutputs(stagedOutput);
  }
}

function prepareWindowsRuntime(stagedOutput) {
  const env = { ...process.env };
  const runtimeRoot = resolveWindowsRuntimeRoot(env);

  clearEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT');
  setEnvValue(env, 'GENLINE_GSTREAMER_BUNDLE_RUNTIME_DIR', stagedOutput.runtime);
  setEnvValue(env, 'GENLINE_GSTREAMER_BUNDLE_ROOT_DLL_DIR', stagedOutput.rootDll);
  if (runtimeRoot) {
    setEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT', runtimeRoot);
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

  clearEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT');
  setEnvValue(env, 'GENLINE_GSTREAMER_BUNDLE_RUNTIME_DIR', stagedOutput.runtime);
  if (runtimeRoot) {
    setEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT', runtimeRoot);
    console.log(`[GStreamer Bundle] Using macOS runtime root: ${runtimeRoot}`);
  } else {
    console.warn(
      '[GStreamer Bundle] No macOS runtime root detected before bundling; falling back to Homebrew gstreamer.',
    );
  }

  runCommand('bash', [path.join(__dirname, 'bundle-gstreamer-macos.sh')], env);

  // macOS does not need root-level DLLs, but tauri.conf.json references
  // gstreamer-runtime-root/ as a resource path. Create an empty directory
  // so Tauri's build does not fail with "resource path doesn't exist".
  mkdirSync(stagedOutput.rootDll, { recursive: true });
}

function createStagedOutputPaths(platform) {
  const stagedOutput = {
    runtime: `${bundledRuntimeDir}.next-${stagingToken}`,
    rootDll: `${runtimeRootDir}.next-${stagingToken}`,
  };

  return stagedOutput;
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
        await rename(state.targetPath, state.backupPath);
      }

      await rename(state.stagedPath, state.targetPath);
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
      await rename(state.backupPath, state.targetPath);
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

function resolveWindowsRuntimeRoot(env) {
  return resolveReadyRuntimeRoot(
    [
      getEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT'),
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
      getEnvValue(env, 'GENLINE_GSTREAMER_RUNTIME_ROOT'),
      localRuntimeRoot,
      inferRuntimeRootFromPath(getEnvValue(env, 'PATH'), 'darwin'),
      ...macFrameworkRoots,
    ],
    'darwin',
  );
}

function resolveReadyRuntimeRoot(candidates, platform) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolvedPath = path.resolve(candidate);
    if (inspectRuntime(resolvedPath, platform).ready) {
      return resolvedPath;
    }
  }

  return null;
}

function inspectRuntime(runtimeRoot, platform) {
  const binDir = path.join(runtimeRoot, 'bin');
  if (!existsSync(binDir)) {
    return { ready: false };
  }

  const missingTools = requiredTools.filter(
    (toolName) => !existsSync(path.join(binDir, executableName(toolName, platform))),
  );

  return {
    ready: missingTools.length === 0,
    missingTools,
  };
}

function executableName(toolName, platform) {
  return platform === 'win32' ? `${toolName}.exe` : toolName;
}

function inferRuntimeRootFromPath(pathValue, platform) {
  if (!pathValue) {
    return null;
  }

  // Only need to find one GStreamer tool to identify the bin directory;
  // resolveReadyRuntimeRoot will validate the full set via inspectRuntime.
  const probeTool = executableName(requiredTools[0], platform);

  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) {
      continue;
    }

    if (existsSync(path.join(entry, probeTool))) {
      return path.dirname(entry);
    }
  }

  return null;
}

function getEnvValue(targetEnv, key) {
  const exact = targetEnv[key];
  if (typeof exact === 'string') {
    return exact;
  }

  const normalizedKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(targetEnv)) {
    if (candidateKey.toLowerCase() === normalizedKey && typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function setEnvValue(targetEnv, key, value) {
  const normalizedKey = key.toLowerCase();
  for (const candidateKey of Object.keys(targetEnv)) {
    if (candidateKey.toLowerCase() === normalizedKey) {
      targetEnv[candidateKey] = value;
      return;
    }
  }

  targetEnv[key] = value;
}

function clearEnvValue(targetEnv, key) {
  const normalizedKey = key.toLowerCase();
  for (const candidateKey of Object.keys(targetEnv)) {
    if (candidateKey.toLowerCase() === normalizedKey) {
      delete targetEnv[candidateKey];
    }
  }
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
