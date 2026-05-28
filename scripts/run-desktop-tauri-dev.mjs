#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  delay,
  getEnvValue,
  inferRuntimeRootFromPath,
  MAC_FRAMEWORK_ROOTS,
  resolveExecutableOnPath,
  resolvePkgConfigExecutable,
  resolveReadyRuntimeRoot,
  runtimeRootLooksReady,
  setEnvValue,
} from './gstreamer-dev-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const tauriDir = path.join(desktopDir, 'src-tauri');
const tauriConfigPath = path.join(tauriDir, 'tauri.conf.json');
const localRuntimeRoot = path.join(tauriDir, 'gstreamer-dev');
const defaultDesktopDevServerPort = 3000;
const maxDesktopDevServerPortAttempts = 20;
const viteLogDir = path.join(repoRoot, '.logs');
const viteLogPaths = {
  out: path.join(viteLogDir, '.desktop-vite-dev.out.log'),
  err: path.join(viteLogDir, '.desktop-vite-dev.err.log'),
};
const tauriPidFilePath = path.join(viteLogDir, `.desktop-tauri-dev.${process.pid}.pid`);
const gracefulChildExitTimeoutMs = 3000;
const windowsGuiCloseGracePeriodMs = 500;
const windowsCliExitGracePeriodMs = 500;
const windowsChildExitTimeoutMs = gracefulChildExitTimeoutMs;
const unixChildExitTimeoutMs = gracefulChildExitTimeoutMs;
const unixForceKillWaitMs = 1000;

const runtimeRoot = resolveRuntimeRoot();
const env = { ...process.env };
prepareProcessLogFile(tauriPidFilePath);
writeFileSync(tauriPidFilePath, '', 'utf8');
env.OPENDIRECTOR_DEV_PID_FILE = tauriPidFilePath;
const pnpmInvocation = resolvePnpmInvocation(env);
const devEntryPath = resolveDevEntryPath();
let desktopDevServer = resolveDesktopDevServer();
const viteInvocation = resolveViteInvocation();
const tauriInvocation = resolveTauriInvocation();
const tauriCliArgs = normalizeForwardedCliArgs(process.argv.slice(2));
const isTauriInfoCommand = tauriCliArgs.some((arg) =>
  ['-h', '--help', '-V', '--version'].includes(arg),
);

if (runtimeRoot) {
  configureRuntimeEnvironment(env, runtimeRoot);
  console.log(`[GStreamer] Using runtime root: ${runtimeRoot}`);
} else {
  console.warn(
    '[GStreamer] No runtime root detected before tauri dev; desktop startup may fail if DLLs are unavailable on PATH.',
  );
}

if (!isTauriInfoCommand) {
  const devServerState = await ensureDesktopDevServer();
  if (devServerState.message) {
    console.log(devServerState.message);
  }
}

const tauriConfigOverride = JSON.stringify(buildTauriDevConfigOverride());
const tauriArgs = [
  'dev',
  ...(!isTauriInfoCommand ? ['--no-dev-server-wait'] : []),
  '-c',
  tauriConfigOverride,
  ...tauriCliArgs,
];
const child = startTauriDevProcess(tauriInvocation, tauriArgs, {
  cwd: desktopDir,
  env,
});
startExitWatchdog({
  controllerPid: process.pid,
  tauriPid: child.pid,
});
const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};
let shutdownRequested = false;
let forceShutdownRequested = false;
let requestedExitCode = null;

process.once('exit', () => {
  try {
    unlinkSync(tauriPidFilePath);
  } catch {
    // Ignore cleanup failures.
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    requestedExitCode =
      process.platform === 'win32' && signal === 'SIGINT'
        ? 0
        : signalExitCodes[signal];

    if (shutdownRequested) {
      if (!forceShutdownRequested) {
        forceShutdownRequested = true;
        void forceShutdownTauriDevProcess();
      }
      return;
    }

    void shutdownTauriDevProcess(signal);
  });
}

child.on('exit', (code, signal) => {
  if (
    process.platform === 'win32' &&
    isWindowsCtrlCExitCode(code) &&
    !shutdownRequested
  ) {
    requestedExitCode = 0;
    void shutdownTauriDevProcess('SIGINT');
    return;
  }

  if (shutdownRequested) {
    return;
  }

  process.exit(normalizeExitCode(
    requestedExitCode ?? code ?? signalExitCodes[signal] ?? 1,
  ));
});

child.on('error', (error) => {
  console.error(
    `[GStreamer] Failed to launch tauri dev via ${tauriInvocation.command}: ${error.message}`,
  );
  process.exit(1);
});

async function shutdownTauriDevProcess(signal) {
  if (shutdownRequested) {
    return;
  }

  shutdownRequested = true;

  if (child.pid) {
    await terminateProcessTree(child.pid, signal);

    if (child.exitCode == null && child.signalCode == null) {
      await waitForChildExit(
        child,
        process.platform === 'win32'
          ? windowsChildExitTimeoutMs
          : unixChildExitTimeoutMs,
      ).catch(() => {});
    }
  }

  process.exit(normalizeExitCode(
    requestedExitCode ?? signalExitCodes[signal] ?? 1,
  ));
}

async function forceShutdownTauriDevProcess() {
  if (child.pid) {
    forceTerminateProcessTree(child.pid);
    await waitForChildExit(
      child,
      process.platform === 'win32' ? windowsCliExitGracePeriodMs : unixForceKillWaitMs,
    ).catch(() => {});
  }

  process.exit(normalizeExitCode(requestedExitCode ?? signalExitCodes.SIGINT));
}

function startTauriDevProcess(invocation, args, options) {
  const child = spawn(
    invocation.command,
    [...invocation.args, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      detached: false,
      stdio:
        process.platform === 'win32'
          ? ['ignore', 'pipe', 'pipe']
          : 'inherit',
      windowsHide: true,
    },
  );

  if (process.platform === 'win32') {
    pipeChildOutput(child);
  }

  return child;
}

function pipeChildOutput(target) {
  target.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  target.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
}

function isWindowsCtrlCExitCode(code) {
  return process.platform === 'win32' && code === 3221225786;
}

function normalizeExitCode(code) {
  if (isWindowsCtrlCExitCode(code)) {
    return 0;
  }

  return code;
}

function startExitWatchdog(options) {
  if (process.platform !== 'win32' || !options.tauriPid || isTauriInfoCommand) {
    return;
  }

  const watchdog = spawn(
    process.execPath,
    [
      '-e',
      buildWindowsExitWatchdogScript(),
      String(options.controllerPid),
      String(options.tauriPid),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  watchdog.unref();
}

function buildWindowsExitWatchdogScript() {
  return [
    "const { spawnSync } = require('node:child_process');",
    "const controllerPid = Number.parseInt(process.argv[1], 10);",
    "const tauriPid = Number.parseInt(process.argv[2], 10);",
    "const tracked = new Set();",
    "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
    "",
    "function sleep(ms) {",
    "  Atomics.wait(sleeper, 0, 0, ms);",
    "}",
    "",
    "function processExists(pid) {",
    "  if (!Number.isFinite(pid) || pid <= 0) {",
    "    return false;",
    "  }",
    "  try {",
    "    process.kill(pid, 0);",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "function runPowerShell(command) {",
    "  return spawnSync(",
    "    'powershell',",
    "    ['-NoProfile', '-NonInteractive', '-Command', command],",
    "    { stdio: 'pipe', encoding: 'utf8', windowsHide: true },",
    "  );",
    "}",
    "",
    "function collectTrackedDescendants(rootPid) {",
    "  if (!Number.isFinite(rootPid) || rootPid <= 0) {",
    "    return;",
    "  }",
    "  const result = runPowerShell(",
    "    '$items = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +",
    "      'Select-Object ProcessId, ParentProcessId; ' +",
    "      '$items | ConvertTo-Json -Compress',",
    "  );",
    "  if (result.status !== 0) {",
    "    return;",
    "  }",
    "  const stdout = result.stdout.trim();",
    "  if (!stdout) {",
    "    return;",
    "  }",
    "  let processes;",
    "  try {",
    "    processes = JSON.parse(stdout);",
    "  } catch {",
    "    return;",
    "  }",
    "  const rows = Array.isArray(processes) ? processes : [processes];",
    "  const childrenByParent = new Map();",
    "  for (const row of rows) {",
    "    if (!row || typeof row.ProcessId !== 'number' || typeof row.ParentProcessId !== 'number') {",
    "      continue;",
    "    }",
    "    const siblings = childrenByParent.get(row.ParentProcessId) ?? [];",
    "    siblings.push(row.ProcessId);",
    "    childrenByParent.set(row.ParentProcessId, siblings);",
    "  }",
    "  const queue = [rootPid];",
    "  while (queue.length > 0) {",
    "    const currentPid = queue.shift();",
    "    if (!Number.isFinite(currentPid) || tracked.has(currentPid)) {",
    "      continue;",
    "    }",
    "    tracked.add(currentPid);",
    "    for (const childPid of childrenByParent.get(currentPid) ?? []) {",
    "      queue.push(childPid);",
    "    }",
    "  }",
    "}",
    "",
    "function closeTrackedWindows() {",
    "  const pids = [...tracked].filter((pid) => Number.isFinite(pid) && pid > 0);",
    "  if (pids.length === 0) {",
    "    return;",
    "  }",
    "  const command = [",
    "    '$targetPids = @(' + pids.join(',') + ');',",
    "    'foreach ($targetPid in $targetPids) {',",
    "    '  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue;',",
    "    '  if ($null -ne $proc -and $proc.MainWindowHandle -ne 0) {',",
    "    '    $null = $proc.CloseMainWindow();',",
    "    '  }',",
    "    '}',",
    "  ].join(' ');",
    "  runPowerShell(command);",
    "}",
    "",
    "function killTrackedProcesses() {",
    "  const pids = [...tracked].filter((pid) => Number.isFinite(pid) && pid > 0);",
    "  if (pids.length === 0 && Number.isFinite(tauriPid) && tauriPid > 0) {",
    "    pids.push(tauriPid);",
    "  }",
    "  for (const pid of pids) {",
    "    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });",
    "  }",
    "}",
    "",
    "function hasLiveTrackedProcess() {",
    "  for (const pid of tracked) {",
    "    if (processExists(pid)) {",
    "      return true;",
    "    }",
    "  }",
    "  return false;",
    "}",
    "",
    "if (!processExists(controllerPid)) {",
    "  collectTrackedDescendants(tauriPid);",
    "  closeTrackedWindows();",
    `  sleep(${windowsGuiCloseGracePeriodMs});`,
    "  collectTrackedDescendants(tauriPid);",
    "  killTrackedProcesses();",
    "  process.exit(0);",
    "}",
    "",
    "while (processExists(controllerPid)) {",
    "  collectTrackedDescendants(tauriPid);",
    "  if (!processExists(tauriPid) && !hasLiveTrackedProcess()) {",
    "    process.exit(0);",
    "  }",
    "  sleep(500);",
    "}",
    "",
    "collectTrackedDescendants(tauriPid);",
    "closeTrackedWindows();",
    `sleep(${windowsGuiCloseGracePeriodMs});`,
    "collectTrackedDescendants(tauriPid);",
    "killTrackedProcesses();",
  ].join('\n');
}

function resolvePnpmInvocation(targetEnv) {
  const npmExecPath = targetEnv.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    const extension = path.extname(npmExecPath).toLowerCase();
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return {
        command: process.execPath,
        args: [npmExecPath],
      };
    }

    return {
      command: npmExecPath,
      args: [],
    };
  }

  const pnpmPath = resolveExecutableOnPath(targetEnv, 'pnpm');
  if (pnpmPath) {
    return { command: pnpmPath, args: [] };
  }

  throw new Error(
    'Unable to locate pnpm executable. Ensure pnpm is on PATH or npm_execpath is set.',
  );
}

async function terminateProcessTree(pid, signal) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    closeWindowsGuiProcessTree(pid);

    const desktopAppExited = await waitForWindowsDesktopAppExit(
      pid,
      windowsGuiCloseGracePeriodMs,
    );
    if (!desktopAppExited) {
      forceTerminateWindowsProcessTree(pid);
      return;
    }

    const childExitedNaturally = await waitForTargetExit(
      child,
      windowsCliExitGracePeriodMs,
    );
    if (!childExitedNaturally) {
      forceTerminateWindowsProcessTree(pid);
    }

    return;
  }

  await terminateUnixProcessTree(pid, signal);
}

function forceTerminateWindowsProcessTree(rootPid) {
  spawnSync(
    'taskkill',
    ['/PID', String(rootPid), '/T', '/F'],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}

function forceTerminateProcessTree(rootPid) {
  if (!rootPid) {
    return;
  }

  if (process.platform === 'win32') {
    forceTerminateWindowsProcessTree(rootPid);
    return;
  }

  forceTerminateUnixTrackedProcesses(rootPid);
}

function closeWindowsGuiProcessTree(rootPid) {
  const command = [
    `$rootPid = ${Number(rootPid)};`,
    '$items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId);',
    '$childrenByParent = @{};',
    'foreach ($item in $items) {',
    '  if (-not $childrenByParent.ContainsKey($item.ParentProcessId)) {',
    '    $childrenByParent[$item.ParentProcessId] = @();',
    '  }',
    '  $childrenByParent[$item.ParentProcessId] += $item.ProcessId;',
    '}',
    '$queue = New-Object System.Collections.Generic.Queue[int];',
    '$seen = New-Object System.Collections.Generic.HashSet[int];',
    '$queue.Enqueue($rootPid);',
    'while ($queue.Count -gt 0) {',
    '  $current = $queue.Dequeue();',
    '  if (-not $seen.Add($current)) { continue }',
    '  $proc = Get-Process -Id $current -ErrorAction SilentlyContinue;',
    '  if ($null -ne $proc -and $proc.MainWindowHandle -ne 0) {',
    '    $null = $proc.CloseMainWindow();',
    '  }',
    '  foreach ($childPid in @($childrenByParent[$current])) {',
    '    $queue.Enqueue([int]$childPid);',
    '  }',
    '}',
  ].join(' ');

  runWindowsPowerShell(command);
}

async function waitForWindowsDesktopAppExit(rootPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!hasWindowsDesktopAppInTree(rootPid)) {
      return true;
    }

    await delay(200);
  }

  return !hasWindowsDesktopAppInTree(rootPid);
}

function hasWindowsDesktopAppInTree(rootPid) {
  return getWindowsProcessTree(rootPid).some(
    (processInfo) => processInfo.name.toLowerCase() === 'opendirector.exe',
  );
}

function getWindowsProcessTree(rootPid) {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return [];
  }

  const processes = listWindowsProcesses();
  if (processes.length === 0) {
    return [];
  }

  const processesByPid = new Map(
    processes.map((processInfo) => [processInfo.pid, processInfo]),
  );
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const siblings = childrenByParent.get(processInfo.parentPid) ?? [];
    siblings.push(processInfo.pid);
    childrenByParent.set(processInfo.parentPid, siblings);
  }

  const queue = [rootPid];
  const seen = new Set();
  const tree = [];

  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!Number.isFinite(currentPid) || seen.has(currentPid)) {
      continue;
    }

    seen.add(currentPid);
    const processInfo = processesByPid.get(currentPid);
    if (processInfo) {
      tree.push(processInfo);
    }

    for (const childPid of childrenByParent.get(currentPid) ?? []) {
      queue.push(childPid);
    }
  }

  return tree;
}

function listWindowsProcesses() {
  if (process.platform !== 'win32') {
    return [];
  }

  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        '$items = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
        '  Select-Object ProcessId, ParentProcessId, Name;',
        '$items | ConvertTo-Json -Compress',
      ].join(' '),
    ],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    return [];
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(
        (row) =>
          row &&
          typeof row.ProcessId === 'number' &&
          typeof row.ParentProcessId === 'number',
      )
      .map((row) => ({
        pid: row.ProcessId,
        parentPid: row.ParentProcessId,
        name: row.Name ?? '',
      }));
  } catch {
    return [];
  }
}

function runWindowsPowerShell(command) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

async function terminateUnixProcessTree(rootPid, signal) {
  const targetPids = collectUnixTerminationTargets(rootPid);
  if (targetPids.length === 0) {
    signalUnixProcess(rootPid, signal);
    return;
  }

  for (const pid of targetPids) {
    signalUnixProcess(pid, signal);
  }

  const exited = await waitForProcessesExit(targetPids, unixChildExitTimeoutMs);
  if (exited) {
    return;
  }

  const survivors = targetPids.filter((pid) => isProcessAlive(pid));
  for (const pid of survivors) {
    signalUnixProcess(pid, 'SIGKILL');
  }

  await waitForProcessesExit(survivors, unixForceKillWaitMs).catch(() => {});
}

function collectUnixProcessTreePids(rootPid) {
  if (!Number.isFinite(rootPid) || rootPid <= 0) {
    return [];
  }

  const processes = listUnixProcesses();
  if (processes.length === 0) {
    return isProcessAlive(rootPid) ? [rootPid] : [];
  }

  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const siblings = childrenByParent.get(processInfo.parentPid) ?? [];
    siblings.push(processInfo.pid);
    childrenByParent.set(processInfo.parentPid, siblings);
  }

  const queue = [rootPid];
  const seen = new Set();
  const tree = [];

  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!Number.isFinite(currentPid) || seen.has(currentPid)) {
      continue;
    }

    seen.add(currentPid);
    if (isProcessAlive(currentPid)) {
      tree.push(currentPid);
    }

    for (const childPid of childrenByParent.get(currentPid) ?? []) {
      queue.push(childPid);
    }
  }

  return tree;
}

function listUnixProcesses() {
  if (process.platform === 'win32') {
    return [];
  }

  const result = spawnSync(
    'ps',
    ['-axo', 'pid=,ppid='],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(\d+)\s+(\d+)$/))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
    }));
}

function readTauriPidFilePids() {
  try {
    return readFileSync(tauriPidFilePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function collectUnixTerminationTargets(rootPid) {
  if (process.platform === 'win32') {
    return [];
  }

  const currentTree = collectUnixProcessTreePids(rootPid).filter(
    (pid) => pid !== process.pid,
  );
  const pidFilePids = readTauriPidFilePids().filter(
    (pid) => pid !== process.pid && isProcessAlive(pid),
  );

  return [...new Set([...currentTree, ...pidFilePids])];
}

function forceTerminateUnixTrackedProcesses(rootPid) {
  for (const pid of collectUnixTerminationTargets(rootPid)) {
    signalUnixProcess(pid, 'SIGKILL');
  }
}

function signalUnixProcess(pid, signal) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, signal === 'SIGINT' ? 'SIGINT' : signal);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesExit(pids, timeoutMs) {
  if (pids.length === 0) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    await delay(100);
  }

  return pids.every((pid) => !isProcessAlive(pid));
}

async function waitForTargetExit(target, timeoutMs) {
  try {
    await waitForChildExit(target, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(target, timeoutMs) {
  if (target.exitCode != null || target.signalCode != null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for PID ${target.pid} to exit.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      target.off('exit', handleExit);
      target.off('error', handleExit);
    };

    const handleExit = () => {
      cleanup();
      resolve();
    };

    target.once('exit', handleExit);
    target.once('error', handleExit);
  });
}

async function ensureDesktopDevServer() {
  const requestedPort = desktopDevServer.port;
  const selectedDevServer = resolveAvailableDesktopDevServer(desktopDevServer);
  desktopDevServer = selectedDevServer.devServer;
  env.OPENDIRECTOR_DEV_SERVER_PORT = String(desktopDevServer.port);

  const { baseUrl, port } = desktopDevServer;
  const occupant = selectedDevServer.occupant;
  const portChanged = port !== requestedPort;
  const portChangeMessage = portChanged
    ? `Default port ${requestedPort} was unavailable; using ${port} instead. `
    : '';

  if (selectedDevServer.reusableOccupant) {
    await waitForDevServerReady(baseUrl, 5000, {
      includeEntry: false,
      logPaths: viteLogPaths,
      timeoutLabel: 'HTTP readiness',
    });

    return {
      message: `${portChangeMessage}Reusing desktop Vite dev server on port ${port}.`,
    };
  }

  if (!occupant) {
    prepareProcessLogFile(viteLogPaths.out);
    prepareProcessLogFile(viteLogPaths.err);

    startDetachedNodeProcess(viteInvocation, {
      cwd: desktopDir,
      env,
      logPaths: viteLogPaths,
    });

    await waitForDevServerReady(baseUrl, 60000, {
      includeEntry: false,
      logPaths: viteLogPaths,
      timeoutLabel: 'HTTP readiness',
    });

    void waitForDevServerReady(baseUrl, 45000, {
      includeEntry: true,
      logPaths: viteLogPaths,
      timeoutLabel: 'entry warmup',
    }).catch((error) => {
      console.warn(`[Desktop Dev] ${error.message}`);
    });

    return {
      message:
        `${portChangeMessage}Started desktop Vite dev server on port ${port}; ` +
        'continuing to warm the app entry in the background.',
    };
  }

  throw new Error(
    `Unable to find an available desktop dev server port after checking ` +
      `${requestedPort}-${requestedPort + maxDesktopDevServerPortAttempts - 1}. ` +
      `Last conflict was PID ${occupant.pid} (${occupant.name ?? 'unknown'}).`,
  );
}

function resolveAvailableDesktopDevServer(initialDevServer) {
  let lastConflict = null;

  const listeningProcesses = batchFindListeningProcesses(
    initialDevServer.port,
    initialDevServer.port + maxDesktopDevServerPortAttempts - 1,
  );

  for (let offset = 0; offset < maxDesktopDevServerPortAttempts; offset += 1) {
    const port = initialDevServer.port + offset;
    const candidateDevServer = buildDesktopDevServerForPort(initialDevServer, port);
    const occupant = listeningProcesses.get(port) ?? null;
    if (!occupant) {
      return {
        devServer: candidateDevServer,
        occupant: null,
        reusableOccupant: null,
      };
    }

    if (isWorkspaceViteProcess(occupant)) {
      return {
        devServer: candidateDevServer,
        occupant,
        reusableOccupant: occupant,
      };
    }

    lastConflict = occupant;
  }

  return {
    devServer: initialDevServer,
    occupant: lastConflict,
    reusableOccupant: null,
  };
}

function buildDesktopDevServerForPort(devServer, port) {
  return {
    port,
    baseUrl: replaceUrlPort(devServer.baseUrl, port),
  };
}

function replaceUrlPort(value, port) {
  const url = normalizeDevServerBaseUrl(value);
  url.port = String(port);
  return url.toString();
}

function isWorkspaceViteProcess(occupant) {
  const desktopPathFragment = desktopDir.toLowerCase();
  const commandLine = (occupant?.commandLine ?? '').toLowerCase();
  return commandLine.includes(desktopPathFragment) && commandLine.includes('vite');
}

function findListeningProcess(port) {
  if (process.platform === 'win32') {
    const command = [
      '$conn = Get-NetTCPConnection -State Listen -LocalPort ' + port + ' -ErrorAction SilentlyContinue | Select-Object -First 1;',
      'if ($null -eq $conn) { exit 0 }',
      '$proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $conn.OwningProcess);',
      '$payload = [PSCustomObject]@{ port = $conn.LocalPort; pid = $conn.OwningProcess; name = $proc.Name; commandLine = $proc.CommandLine };',
      '$payload | ConvertTo-Json -Compress',
    ].join(' ');

    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', command],
      {
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return null;
    }

    try {
      const parsed = JSON.parse(stdout);
      return { pid: parsed.pid, name: parsed.name, commandLine: parsed.commandLine };
    } catch {
      return null;
    }
  }

  const lsofResult = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (lsofResult.status !== 0) {
    return null;
  }

  const pid = lsofResult.stdout
    .split('\n')
    .find((line) => line.startsWith('p'))
    ?.slice(1)
    .trim();
  if (!pid) {
    return null;
  }

  const name = lsofResult.stdout
    .split('\n')
    .find((line) => line.startsWith('c'))
    ?.slice(1)
    .trim();

  const psResult = spawnSync(
    'ps',
    ['-p', pid, '-o', 'command='],
    {
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );

  const commandLine =
    psResult.status === 0
      ? psResult.stdout.trim()
      : undefined;

  return {
    pid: Number(pid),
    name,
    commandLine,
  };
}

function batchFindListeningProcesses(startPort, endPort) {
  const result = new Map();

  if (process.platform === 'win32') {
    const command = [
      '$conns = Get-NetTCPConnection -State Listen -LocalPort ' + startPort + '..' + endPort + ' -ErrorAction SilentlyContinue;',
      'if ($null -eq $conns) { exit 0 }',
      '$items = @($conns) | Select-Object LocalPort, OwningProcess -Unique;',
      '$pids = $items | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique;',
      '$procs = @{}; foreach ($p in $pids) { $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $p) -ErrorAction SilentlyContinue; if ($proc) { $procs[$p] = $proc } };',
      '$payload = @(); foreach ($item in $items) { $proc = $procs[$item.OwningProcess]; $payload += [PSCustomObject]@{ port = $item.LocalPort; pid = $item.OwningProcess; name = if ($proc) { $proc.Name } else { $null }; commandLine = if ($proc) { $proc.CommandLine } else { $null } } };',
      '$payload | ConvertTo-Json -Compress',
    ].join(' ');

    const psResult = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', command],
      {
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );

    if (psResult.status !== 0 || !psResult.stdout.trim()) {
      return result;
    }

    try {
      const parsed = JSON.parse(psResult.stdout.trim());
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (typeof entry.port === 'number') {
          result.set(entry.port, {
            pid: entry.pid,
            name: entry.name ?? '',
            commandLine: entry.commandLine,
          });
        }
      }
    } catch {
      // Fall through — return empty map, individual ports will appear unoccupied.
    }

    return result;
  }

  for (let port = startPort; port <= endPort; port += 1) {
    const occupant = findListeningProcess(port);
    if (occupant) {
      result.set(port, occupant);
    }
  }

  return result;
}

async function waitForDevServerReady(baseUrl, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const normalizedBaseUrl = normalizeDevServerBaseUrl(baseUrl);
  const origin = normalizedBaseUrl.toString();
  const includeEntry = options.includeEntry ?? true;
  const timeoutLabel = options.timeoutLabel ?? 'readiness';
  const checks = [
    new URL('.', normalizedBaseUrl).toString(),
    new URL('@vite/client', normalizedBaseUrl).toString(),
  ];
  if (includeEntry) {
    checks.push(
      new URL(stripLeadingSlash(devEntryPath), normalizedBaseUrl).toString(),
    );
  }

  while (Date.now() < deadline) {
    try {
      const responses = await Promise.all(
        checks.map((url) => fetch(url, {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: '*/*' },
        })),
      );

      if (responses.every((response) => response.ok)) {
        return;
      }
    } catch {
      // keep polling until the dev server is actually ready to serve the app
    }

    await delay(200);
  }

  const errorMessage =
    `Timed out waiting for desktop dev server ${timeoutLabel} on ${origin}.`;

  throw createDevServerStartupError(errorMessage, options.logPaths);
}

function resolveDevEntryPath() {
  const indexHtmlPath = path.join(desktopDir, 'index.html');

  try {
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const match = indexHtml.match(/<script\s+type=["']module["']\s+src=["']([^"']+)["']/i);
    if (!match?.[1]) {
      return '/src/main.tsx';
    }

    return match[1].startsWith('/') ? match[1] : `/${match[1]}`;
  } catch {
    return '/src/main.tsx';
  }
}

function resolveDesktopDevServer() {
  const fallback = {
    port: defaultDesktopDevServerPort,
    baseUrl: `http://localhost:${defaultDesktopDevServerPort}/`,
  };

  const configuredPort = resolveConfiguredDesktopDevServerPort();

  try {
    const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
    const devUrl = tauriConfig?.build?.devUrl;
    if (typeof devUrl !== 'string' || devUrl.trim() === '') {
      return configuredPort
        ? buildDesktopDevServerForPort(fallback, configuredPort)
        : fallback;
    }

    const normalizedBaseUrl = normalizeDevServerBaseUrl(devUrl);
    const resolved = {
      port: parsePortFromUrl(normalizedBaseUrl, fallback.port),
      baseUrl: normalizedBaseUrl.toString(),
    };
    return configuredPort
      ? buildDesktopDevServerForPort(resolved, configuredPort)
      : resolved;
  } catch {
    return configuredPort
      ? buildDesktopDevServerForPort(fallback, configuredPort)
      : fallback;
  }
}

function resolveConfiguredDesktopDevServerPort() {
  const candidate = Number.parseInt(
    process.env.OPENDIRECTOR_DEV_SERVER_PORT ?? '',
    10,
  );
  return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

function normalizeDevServerBaseUrl(value) {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);

  url.hash = '';
  url.search = '';
  if (!url.pathname || url.pathname === '') {
    url.pathname = '/';
  } else if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

function parsePortFromUrl(url, fallbackPort) {
  if (typeof url.port === 'string' && url.port !== '') {
    const port = Number.parseInt(url.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }

  if (url.protocol === 'https:') {
    return 443;
  }

  if (url.protocol === 'http:') {
    return 80;
  }

  return fallbackPort;
}

function stripLeadingSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function resolveViteInvocation() {
  const viteCliPath = resolvePackageEntry([
    path.join(desktopDir, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
  ]);
  if (viteCliPath) {
    return {
      command: process.execPath,
      args: [viteCliPath],
    };
  }

  return {
    command: pnpmInvocation.command,
    args: [...pnpmInvocation.args, 'dev'],
  };
}

function resolveTauriInvocation() {
  const tauriCliPath = resolvePackageEntry([
    path.join(desktopDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
  ]);
  if (tauriCliPath) {
    return {
      command: process.execPath,
      args: [tauriCliPath],
    };
  }

  return {
    command: pnpmInvocation.command,
    args: [...pnpmInvocation.args, 'exec', 'tauri'],
  };
}

function resolvePackageEntry(candidates) {
  for (const candidate of candidates) {
    if (canAccessFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function canAccessFile(filePath) {
  try {
    return existsSync(filePath) && readFileSync(filePath, 'utf8').length >= 0;
  } catch {
    return false;
  }
}

function startDetachedNodeProcess(invocation, options) {
  mkdirSync(path.dirname(options.logPaths.out), { recursive: true });
  const stdoutFd = openSync(options.logPaths.out, 'a');
  const stderrFd = openSync(options.logPaths.err, 'a');

  try {
    const child = spawn(
      invocation.command,
      invocation.args,
      {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
      },
    );

    child.unref();

    return { pid: child.pid ?? null };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function normalizeForwardedCliArgs(argv) {
  if (argv[0] === '--') {
    return argv.slice(1);
  }

  return argv;
}

function createDevServerStartupError(message, logPaths) {
  const logTail = readProcessLogTail(logPaths);
  if (!logTail) {
    return new Error(message);
  }

  return new Error(`${message}\n\nRecent Vite logs:\n${logTail}`);
}

function readProcessLogTail(logPaths) {
  if (!logPaths) {
    return '';
  }

  const sections = [
    readLogSection(logPaths.out, 'stdout'),
    readLogSection(logPaths.err, 'stderr'),
  ].filter(Boolean);

  return sections.join('\n\n');
}

function readLogSection(filePath, label) {
  if (!filePath) {
    return '';
  }

  try {
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) {
      return '';
    }

    return `[${label}]\n${tailLog(content)}`;
  } catch {
    return '';
  }
}

function tailLog(content, maxLines = 30, maxChars = 4000) {
  const lines = content.split(/\r?\n/);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length <= maxChars ? tail : tail.slice(-maxChars);
}

function prepareProcessLogFile(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
}

function buildTauriDevConfigOverride() {
  const override = {
    build: {
      beforeDevCommand: null,
      devUrl: desktopDevServer.baseUrl,
    },
  };
  const missingResourcePatch = resolveMissingTauriBundleResourcePatch();
  if (missingResourcePatch) {
    override.bundle = {
      resources: missingResourcePatch,
    };
  }
  return override;
}

function resolveMissingTauriBundleResourcePatch() {
  try {
    const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
    const resources = tauriConfig?.bundle?.resources;
    if (!resources) {
      return null;
    }

    if (Array.isArray(resources)) {
      const existingResources = resources.filter((resource) =>
        typeof resource === 'string' &&
        (tauriResourceSourceLooksLikeGlob(resource) || tauriResourceSourceExists(resource)),
      );

      if (existingResources.length === resources.length) {
        return null;
      }

      return existingResources;
    }

    if (typeof resources !== 'object') {
      return null;
    }

    const missingEntries = Object.keys(resources).filter(
      (resource) =>
        typeof resource === 'string' &&
        !tauriResourceSourceLooksLikeGlob(resource) &&
        !tauriResourceSourceExists(resource),
    );

    if (missingEntries.length === 0) {
      return null;
    }

    console.log(
      `[Tauri Dev] Skipping missing bundle resources: ${missingEntries.join(', ')}`,
    );

    return Object.fromEntries(
      missingEntries.map((resource) => [resource, null]),
    );
  } catch (error) {
    console.warn(
      `[Tauri Dev] Failed to inspect bundle resources from tauri.conf.json: ${error.message}`,
    );
    return null;
  }
}

function tauriResourceSourceExists(resourceSource) {
  const resolvedSourcePath = path.resolve(tauriDir, resourceSource);
  return existsSync(resolvedSourcePath);
}

function tauriResourceSourceLooksLikeGlob(resourceSource) {
  return /[*?[\]{}]/.test(resourceSource);
}

function resolveRuntimeRoot() {
  return resolveReadyRuntimeRoot(
    [
      getEnvValue(process.env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT'),
      getEnvValue(process.env, 'GSTREAMER_1_0_ROOT_MSVC_X86_64'),
      getEnvValue(process.env, 'GSTREAMER_1_0_ROOT_X86_64'),
      localRuntimeRoot,
      inferRuntimeRootFromPath(getEnvValue(process.env, 'PATH')),
    ],
    process.platform,
  );
}

function configureRuntimeEnvironment(targetEnv, root) {
  const binDir = path.join(root, 'bin');
  const pluginDir = path.join(root, 'lib', 'gstreamer-1.0');
  const pkgConfigDir = path.join(root, 'lib', 'pkgconfig');
  const typelibDir = path.join(root, 'lib', 'girepository-1.0');
  const pkgConfigExecutable = resolvePkgConfigExecutable(targetEnv);

  prependPathEntry(targetEnv, 'PATH', binDir);

  if (existsSync(pluginDir)) {
    prependPathEntry(targetEnv, 'GST_PLUGIN_PATH', pluginDir);
    prependPathEntry(targetEnv, 'GST_PLUGIN_SYSTEM_PATH', pluginDir);
  }

  if (process.platform === 'darwin') {
    const libDir = path.join(root, 'lib');
    prependPathEntry(targetEnv, 'DYLD_LIBRARY_PATH', libDir);
    prependPathEntry(targetEnv, 'DYLD_FALLBACK_LIBRARY_PATH', libDir);
    prependPathEntry(targetEnv, 'GI_TYPELIB_PATH', typelibDir);
    const pluginScannerWrapper = ensureMacosPluginScannerWrapper(root, libDir, typelibDir);
    if (pluginScannerWrapper) {
      setEnvValue(targetEnv, 'GST_PLUGIN_SCANNER', pluginScannerWrapper);
      setEnvValue(targetEnv, 'GST_PLUGIN_SCANNER_1_0', pluginScannerWrapper);
    }

    if (pkgConfigExecutable) {
      setEnvValue(targetEnv, 'PKG_CONFIG', pkgConfigExecutable);
    }

    if (existsSync(pkgConfigDir)) {
      prependPathEntry(targetEnv, 'PKG_CONFIG_PATH', pkgConfigDir);
      const pkgConfigLibdir = resolvePkgConfigLibdir(pkgConfigExecutable, pkgConfigDir);
      if (pkgConfigLibdir) {
        setEnvValue(targetEnv, 'PKG_CONFIG_LIBDIR', pkgConfigLibdir);
      }
    }
  }

  if (process.platform === 'win32') {
    setEnvValue(targetEnv, 'GSTREAMER_1_0_ROOT_MSVC_X86_64', root);
    setEnvValue(targetEnv, 'GSTREAMER_1_0_ROOT_X86_64', root);

    if (pkgConfigExecutable) {
      setEnvValue(targetEnv, 'PKG_CONFIG', pkgConfigExecutable);
      prependPathEntry(targetEnv, 'PATH', path.dirname(pkgConfigExecutable));

      if (existsSync(pkgConfigDir)) {
        prependPathEntry(targetEnv, 'PKG_CONFIG_PATH', pkgConfigDir);
        const pkgConfigLibdir = resolvePkgConfigLibdir(pkgConfigExecutable, pkgConfigDir);
        if (pkgConfigLibdir) {
          setEnvValue(targetEnv, 'PKG_CONFIG_LIBDIR', pkgConfigLibdir);
        }
      }
    } else if (existsSync(pkgConfigDir)) {
      console.warn(
        '[GStreamer] pkg-config executable not found; Rust/Tauri builds may fail on Windows.',
      );
    }
  }
}

function ensureMacosPluginScannerWrapper(root, libDir, typelibDir) {
  const scannerPath = resolveMacosPluginScanner(root);
  if (!scannerPath) {
    return null;
  }

  const wrapperDir = path.join(tauriDir, 'target', 'gstreamer-runtime');
  mkdirSync(wrapperDir, { recursive: true });
  const wrapperPath = path.join(wrapperDir, 'gst-plugin-scanner-macos.sh');
  const content = [
    '#!/bin/sh',
    `export DYLD_LIBRARY_PATH=${shellSingleQuote(libDir)}\${DYLD_LIBRARY_PATH:+":$DYLD_LIBRARY_PATH"}`,
    `export DYLD_FALLBACK_LIBRARY_PATH=${shellSingleQuote(libDir)}\${DYLD_FALLBACK_LIBRARY_PATH:+":$DYLD_FALLBACK_LIBRARY_PATH"}`,
    `export GI_TYPELIB_PATH=${shellSingleQuote(typelibDir)}\${GI_TYPELIB_PATH:+":$GI_TYPELIB_PATH"}`,
    `exec ${shellSingleQuote(scannerPath)} "$@"`,
    '',
  ].join('\n');

  const existingContent = existsSync(wrapperPath)
    ? readFileSync(wrapperPath, 'utf8')
    : null;
  if (existingContent !== content) {
    writeFileSync(wrapperPath, content, 'utf8');
  }
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function resolveMacosPluginScanner(root) {
  const inspectPath = path.join(root, 'bin', 'gst-inspect-1.0');
  if (existsSync(inspectPath)) {
    try {
      const resolvedInspectPath = realpathSync(inspectPath);
      const prefixDir = path.dirname(path.dirname(resolvedInspectPath));
      const scannerPath = path.join(prefixDir, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner');
      if (existsSync(scannerPath)) {
        return scannerPath;
      }
    } catch {
      // continue to fallback candidates
    }
  }

  const candidates = [
    path.join(root, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function prependPathEntry(targetEnv, key, entry) {
  if (!existsSync(entry)) {
    return;
  }

  const existingValue = getEnvValue(targetEnv, key) ?? '';
  const existing = existingValue
    ? existingValue.split(path.delimiter).filter(Boolean)
    : [];
  const normalizedEntry = path.resolve(entry);
  const nextEntries = [
    normalizedEntry,
    ...existing.filter((value) => path.resolve(value) !== normalizedEntry),
  ];

  setEnvValue(targetEnv, key, nextEntries.join(path.delimiter));
}

function resolvePkgConfigLibdir(pkgConfigExecutable, preferredEntry) {
  const defaultEntries = [];

  if (pkgConfigExecutable) {
    const result = spawnSync(
      pkgConfigExecutable,
      ['--variable', 'pc_path', 'pkg-config'],
      {
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );

    if (result.status === 0) {
      defaultEntries.push(
        ...result.stdout
          .trim()
          .split(path.delimiter)
          .filter(Boolean),
      );
    }
  }

  const mergedEntries = [
    preferredEntry,
    ...defaultEntries,
  ].filter(Boolean);

  if (mergedEntries.length === 0) {
    return null;
  }

  return [...new Set(mergedEntries.map((entry) => path.resolve(entry)))].join(path.delimiter);
}
