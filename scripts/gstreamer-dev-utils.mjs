import { existsSync } from 'node:fs';
import path from 'node:path';

export const MAC_FRAMEWORK_ROOTS = [
  '/Library/Frameworks/GStreamer.framework/Versions/Current',
  '/Library/Frameworks/GStreamer.framework/Versions/1.0',
];

export const REQUIRED_GSTREAMER_TOOLS = [
  'gst-discoverer-1.0',
  'gst-inspect-1.0',
  'ges-launch-1.0',
];

export function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export function executableName(toolName, platform = process.platform) {
  return platform === 'win32' ? `${toolName}.exe` : toolName;
}

export function inspectRuntime(runtimeRoot, platform = process.platform) {
  const binDir = path.join(runtimeRoot, 'bin');
  const missingTools = REQUIRED_GSTREAMER_TOOLS
    .map((toolName) => executableName(toolName, platform))
    .filter((toolName) => !existsSync(path.join(binDir, toolName)));

  return {
    ready: missingTools.length === 0,
    missingTools,
  };
}

export function runtimeRootLooksReady(runtimeRoot, platform = process.platform) {
  return runtimeRoot ? inspectRuntime(runtimeRoot, platform).ready : false;
}

export function resolveReadyRuntimeRoot(candidates, platform = process.platform) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolvedPath = path.resolve(candidate);
    if (runtimeRootLooksReady(resolvedPath, platform)) {
      return resolvedPath;
    }
  }

  return null;
}

export function inferRuntimeRootFromPath(pathValue, platform = process.platform) {
  if (!pathValue) {
    return null;
  }

  const executableNames = REQUIRED_GSTREAMER_TOOLS.map((toolName) =>
    executableName(toolName, platform),
  );

  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) {
      continue;
    }

    if (executableNames.some((toolName) => existsSync(path.join(entry, toolName)))) {
      return path.dirname(entry);
    }
  }

  return null;
}

export function getEnvValue(targetEnv, key) {
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

export function setEnvValue(targetEnv, key, value) {
  const normalizedKey = key.toLowerCase();
  for (const candidateKey of Object.keys(targetEnv)) {
    if (candidateKey.toLowerCase() === normalizedKey) {
      targetEnv[candidateKey] = value;
      return;
    }
  }

  targetEnv[key] = value;
}

export function clearEnvValue(targetEnv, key) {
  const normalizedKey = key.toLowerCase();
  for (const candidateKey of Object.keys(targetEnv)) {
    if (candidateKey.toLowerCase() === normalizedKey) {
      delete targetEnv[candidateKey];
    }
  }
}

export function resolveExecutableOnPath(targetEnv, executableNameBase) {
  const pathValue = getEnvValue(targetEnv, 'PATH');
  if (!pathValue) {
    return null;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          executableNameBase,
          `${executableNameBase}.exe`,
          `${executableNameBase}.cmd`,
          `${executableNameBase}.bat`,
        ]
      : [executableNameBase];

  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) {
      continue;
    }

    for (const candidate of candidates) {
      const executablePath = path.join(entry, candidate);
      if (existsSync(executablePath)) {
        return executablePath;
      }
    }
  }

  return null;
}

export function resolveWindowsPkgConfigExecutable(targetEnv = process.env) {
  if (process.platform !== 'win32') {
    return null;
  }

  const localAppData = getEnvValue(targetEnv, 'LOCALAPPDATA');
  if (!localAppData) {
    return null;
  }

  const candidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'pkg-config.exe'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'pkgconf.exe'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolvePkgConfigExecutable(targetEnv = process.env) {
  return (
    resolveExecutableOnPath(targetEnv, 'pkg-config') ??
    resolveExecutableOnPath(targetEnv, 'pkgconf') ??
    resolveWindowsPkgConfigExecutable(targetEnv)
  );
}
