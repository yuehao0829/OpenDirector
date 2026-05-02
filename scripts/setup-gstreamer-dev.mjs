#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAURI_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri');
const DEFAULT_RUNTIME_ROOT = path.join(TAURI_DIR, 'gstreamer-dev');
const DEFAULT_WINDOWS_VERSION = process.env.GENLINE_GSTREAMER_VERSION || '1.28.2';
const REQUIRED_TOOLS = ['gst-discoverer-1.0', 'gst-inspect-1.0', 'ges-launch-1.0'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtimeRoot = path.resolve(options.runtimeRoot);

  if (options.help) {
    printUsage();
    return;
  }

  log(`Platform: ${process.platform}`);
  log(`Runtime target: ${runtimeRoot}`);

  if (options.doctor) {
    await runDoctor(runtimeRoot);
    return;
  }

  if (process.platform === 'win32') {
    await setupWindowsRuntime(runtimeRoot, options.force, options.version);
  } else if (process.platform === 'darwin') {
    await setupMacRuntime(runtimeRoot, options.force);
  } else {
    throw new Error(
      'Only Windows and macOS are supported by the automatic GStreamer setup script.',
    );
  }

  const localRuntime = await inspectRuntime(runtimeRoot);
  if (!localRuntime.ready) {
    throw new Error(
      `Configured runtime is still incomplete: missing ${localRuntime.missingTools.join(', ')}`,
    );
  }

  log('Runtime is ready.');
  printNextSteps(runtimeRoot);
}

function parseArgs(argv) {
  const options = {
    doctor: false,
    force: false,
    help: false,
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    version: DEFAULT_WINDOWS_VERSION,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--doctor':
        options.doctor = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--runtime-root':
        options.runtimeRoot = requireValue(argv, ++index, arg);
        break;
      case '--version':
        options.version = requireValue(argv, ++index, arg);
        break;
      default:
        if (arg.startsWith('--runtime-root=')) {
          options.runtimeRoot = arg.slice('--runtime-root='.length);
          break;
        }
        if (arg.startsWith('--version=')) {
          options.version = arg.slice('--version='.length);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function runDoctor(runtimeRoot) {
  const candidates = await collectRuntimeCandidates(runtimeRoot);
  const readyCandidate = candidates.find((candidate) => candidate.ready);

  if (candidates.length === 0) {
    log('No GStreamer runtime candidates were discovered.');
  } else {
    for (const candidate of candidates) {
      const status = candidate.ready
        ? 'ready'
        : `missing ${candidate.missingTools.join(', ')}`;
      log(`Candidate [${candidate.source}] ${candidate.path} -> ${status}`);
    }
  }

  if (!readyCandidate) {
    throw new Error('No usable GStreamer runtime was found.');
  }

  log(`Using candidate: ${readyCandidate.path}`);
  printNextSteps(runtimeRoot);
}

async function setupWindowsRuntime(runtimeRoot, force, version) {
  const localRuntime = await inspectRuntime(runtimeRoot);
  if (localRuntime.ready && !force) {
    log('Existing repo-local runtime is already ready.');
    return;
  }

  if (existsSync(runtimeRoot)) {
    if (!force) {
      throw new Error(
        `Found an incomplete runtime at ${runtimeRoot}. Re-run with --force to reinstall it.`,
      );
    }
    await removeRepoLocalRuntime(runtimeRoot);
  }

  await mkdir(runtimeRoot, { recursive: true });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'genline-gstreamer-'));
  const installerPath = path.join(tempDir, `gstreamer-runtime-${version}.exe`);
  const installerUrl =
    `https://gstreamer.freedesktop.org/data/pkg/windows/${version}/msvc/` +
    `gstreamer-1.0-msvc-x86_64-${version}.exe`;

  try {
    await downloadFile(installerUrl, installerPath);
    installInnoRuntime(installerPath, runtimeRoot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function setupMacRuntime(runtimeRoot, force) {
  const localRuntime = await inspectRuntime(runtimeRoot);
  if (localRuntime.ready && !force) {
    log('Existing repo-local runtime is already ready.');
    return;
  }

  ensureMacBuildDeps();
  const sourceRoot = await resolveMacRuntimeSource();
  if (!sourceRoot) {
    throw new Error(
      'Unable to find a macOS GStreamer runtime. Install Homebrew first, or install the official GStreamer framework.',
    );
  }

  if (existsSync(runtimeRoot)) {
    await removeRepoLocalRuntime(runtimeRoot);
  }

  await symlink(sourceRoot, runtimeRoot, 'dir');
  log(`Linked ${runtimeRoot} -> ${sourceRoot}`);
}

function ensureMacBuildDeps() {
  const pkgConfigResult = spawnSync('pkg-config', ['--version'], { encoding: 'utf8' });
  if (pkgConfigResult.status !== 0) {
    const brew = spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
    if (brew.status !== 0) {
      throw new Error(
        'pkg-config is required but not found, and Homebrew is not installed. ' +
        'Install Homebrew first: https://brew.sh',
      );
    }
    log('Installing pkg-config via Homebrew ...');
    runCommand('brew', ['install', 'pkgconf']);
  } else {
    log('pkg-config is available.');
  }
}

async function resolveMacRuntimeSource() {
  const frameworkCandidates = [
    '/Library/Frameworks/GStreamer.framework/Versions/Current',
    '/Library/Frameworks/GStreamer.framework/Versions/1.0',
  ];

  for (const candidate of frameworkCandidates) {
    const inspected = await inspectRuntime(candidate);
    if (inspected.ready) {
      log(`Using existing macOS framework runtime at ${candidate}`);
      return candidate;
    }
  }

  const brew = spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
  if (brew.status !== 0) {
    return null;
  }

  const listResult = spawnSync('brew', ['list', '--versions', 'gstreamer'], {
    encoding: 'utf8',
  });
  if (listResult.status !== 0 || !listResult.stdout.trim()) {
    log('Installing Homebrew gstreamer formula...');
    runCommand('brew', ['install', 'gstreamer']);
  }

  const prefixResult = spawnSync('brew', ['--prefix', 'gstreamer'], {
    encoding: 'utf8',
  });
  if (prefixResult.status !== 0) {
    throw new Error(prefixResult.stderr.trim() || 'Failed to resolve brew gstreamer prefix');
  }

  const prefix = prefixResult.stdout.trim();
  const inspected = await inspectRuntime(prefix);
  if (!inspected.ready) {
    throw new Error(
      `Homebrew gstreamer prefix is incomplete: missing ${inspected.missingTools.join(', ')}`,
    );
  }

  return prefix;
}

async function collectRuntimeCandidates(runtimeRoot) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = async (candidatePath, source) => {
    if (!candidatePath) return;
    const resolvedPath = path.resolve(candidatePath);
    if (seen.has(resolvedPath)) return;
    seen.add(resolvedPath);

    candidates.push({
      path: resolvedPath,
      source,
      ...(await inspectRuntime(resolvedPath)),
    });
  };

  await addCandidate(runtimeRoot, 'repo-local');

  for (const envName of [
    'GSTREAMER_1_0_ROOT_MSVC_X86_64',
    'GSTREAMER_1_0_ROOT_X86_64',
  ]) {
    await addCandidate(process.env[envName], `env:${envName}`);
  }

  if (process.platform === 'darwin') {
    await addCandidate(
      '/Library/Frameworks/GStreamer.framework/Versions/Current',
      'mac-framework',
    );
    await addCandidate(
      '/Library/Frameworks/GStreamer.framework/Versions/1.0',
      'mac-framework',
    );
  }

  const pathCandidate = await inferRuntimeRootFromPath();
  await addCandidate(pathCandidate, 'path');

  return candidates;
}

async function inferRuntimeRootFromPath() {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;

    for (const toolName of REQUIRED_TOOLS) {
      const candidate = path.join(entry, executableName(toolName));
      try {
        await access(candidate);
        return path.dirname(entry);
      } catch {
        // Continue scanning PATH entries.
      }
    }
  }

  return null;
}

async function inspectRuntime(runtimeRoot) {
  const binDir = path.join(runtimeRoot, 'bin');
  const missingTools = [];

  for (const toolName of REQUIRED_TOOLS) {
    const toolPath = path.join(binDir, executableName(toolName));
    if (!existsSync(toolPath)) {
      missingTools.push(executableName(toolName));
    }
  }

  return {
    ready: missingTools.length === 0,
    missingTools,
  };
}

function executableName(toolName) {
  return process.platform === 'win32' ? `${toolName}.exe` : toolName;
}

async function removeRepoLocalRuntime(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const allowedRoot = path.resolve(TAURI_DIR);

  if (!resolvedRoot.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete runtime outside repo workspace: ${resolvedRoot}`);
  }

  let currentLinkTarget = null;
  try {
    const stats = await lstat(resolvedRoot);
    if (stats.isSymbolicLink()) {
      currentLinkTarget = await readlink(resolvedRoot);
    }
  } catch {
    currentLinkTarget = null;
  }

  await rm(resolvedRoot, { recursive: true, force: true });
  if (currentLinkTarget) {
    log(`Removed stale runtime symlink -> ${currentLinkTarget}`);
  } else {
    log(`Removed ${resolvedRoot}`);
  }
}

async function downloadFile(url, destination) {
  log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

function installInnoRuntime(installerPath, runtimeRoot) {
  log(`Installing ${path.basename(installerPath)} to ${runtimeRoot}`);
  runCommand(installerPath, [
    '/SP-',
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/DIR=${runtimeRoot}`,
  ]);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function printNextSteps(runtimeRoot) {
  const relativeRuntime = path.relative(REPO_ROOT, runtimeRoot) || runtimeRoot;
  log(`Repo-local runtime: ${relativeRuntime}`);
  log('Next steps:');
  log('  1. pnpm dev:desktop');
  log('  2. cargo test xges -- --nocapture');
}

function printUsage() {
  console.log(`Usage: node scripts/setup-gstreamer-dev.mjs [options]

Options:
  --doctor                 Only inspect current runtime candidates.
  --force                  Reinstall or relink the repo-local runtime.
  --runtime-root <path>    Override the repo-local target directory.
  --version <version>      Override the Windows installer version (default: ${DEFAULT_WINDOWS_VERSION}).
  --help, -h               Show this help message.
`);
}

function log(message) {
  console.log(`[GStreamer] ${message}`);
}

main().catch((error) => {
  console.error(`[GStreamer] ${error.message}`);
  process.exitCode = 1;
});
