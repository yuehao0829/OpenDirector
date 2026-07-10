import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

/**
 * Resolve the GStreamer runtime root from the standard candidate sources
 * (env override → installed GSTREAMER_1_0_ROOT_* → repo-local gstreamer-dev
 * → PATH inference). Shared by `pnpm dev` (run-desktop-tauri-dev.mjs) and
 * `pnpm rust:*` (run-cargo.mjs) so both entry points pick the same root.
 */
export function resolveDefaultRuntimeRoot(env, localRuntimeRoot, platform = process.platform) {
  return resolveReadyRuntimeRoot(
    [
      getEnvValue(env, 'OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT'),
      getEnvValue(env, 'GSTREAMER_1_0_ROOT_MSVC_X86_64'),
      getEnvValue(env, 'GSTREAMER_1_0_ROOT_X86_64'),
      localRuntimeRoot,
      inferRuntimeRootFromPath(getEnvValue(env, 'PATH')),
    ],
    platform,
  );
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

/**
 * Configure the GStreamer runtime environment (PATH / GST_PLUGIN_PATH /
 * GSTREAMER_1_0_ROOT_* / PKG_CONFIG_* / DYLD_* / GST_PLUGIN_SCANNER) for the
 * given runtime root. Single source of truth shared by `pnpm dev`
 * (run-desktop-tauri-dev.mjs) and `pnpm rust:*` (run-cargo.mjs) so the two
 * entry points can't drift — previously run-cargo.mjs mirrored this by hand
 * and was missing the macOS plugin-scanner wrapper.
 *
 * @param targetEnv environment map to mutate in place (e.g. process.env)
 * @param root     resolved GStreamer runtime root (bin/ lib/ ...)
 * @param tauriDir app tauri dir; the macOS plugin-scanner wrapper script is
 *                 written under `<tauriDir>/target/gstreamer-runtime/`
 */
export function configureRuntimeEnvironment(targetEnv, root, tauriDir) {
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
    const pluginScannerWrapper = ensureMacosPluginScannerWrapper(root, libDir, typelibDir, tauriDir);
    if (pluginScannerWrapper) {
      setEnvValue(targetEnv, 'GST_PLUGIN_SCANNER', pluginScannerWrapper);
      setEnvValue(targetEnv, 'GST_PLUGIN_SCANNER_1_0', pluginScannerWrapper);
    }

    if (pkgConfigExecutable) {
      setEnvValue(targetEnv, 'PKG_CONFIG', pkgConfigExecutable);
    }

    applyPkgConfigLibdir(targetEnv, pkgConfigExecutable, pkgConfigDir);
  }

  if (process.platform === 'win32') {
    setEnvValue(targetEnv, 'GSTREAMER_1_0_ROOT_MSVC_X86_64', root);
    setEnvValue(targetEnv, 'GSTREAMER_1_0_ROOT_X86_64', root);

    if (pkgConfigExecutable) {
      setEnvValue(targetEnv, 'PKG_CONFIG', pkgConfigExecutable);
      prependPathEntry(targetEnv, 'PATH', path.dirname(pkgConfigExecutable));
      applyPkgConfigLibdir(targetEnv, pkgConfigExecutable, pkgConfigDir);
    } else if (existsSync(pkgConfigDir)) {
      console.warn(
        '[GStreamer] pkg-config executable not found; Rust/Tauri builds may fail on Windows.',
      );
    }
  }
}

function ensureMacosPluginScannerWrapper(root, libDir, typelibDir, tauriDir) {
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

  const existingContent = existsSync(wrapperPath) ? readFileSync(wrapperPath, 'utf8') : null;
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

  const candidates = [path.join(root, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function applyPkgConfigLibdir(targetEnv, pkgConfigExecutable, pkgConfigDir) {
  if (!existsSync(pkgConfigDir)) {
    return;
  }
  prependPathEntry(targetEnv, 'PKG_CONFIG_PATH', pkgConfigDir);
  const pkgConfigLibdir = resolvePkgConfigLibdir(pkgConfigExecutable, pkgConfigDir);
  if (pkgConfigLibdir) {
    setEnvValue(targetEnv, 'PKG_CONFIG_LIBDIR', pkgConfigLibdir);
  }
}

function prependPathEntry(targetEnv, key, entry) {
  if (!existsSync(entry)) {
    return;
  }

  const existingValue = getEnvValue(targetEnv, key) ?? '';
  const existing = existingValue ? existingValue.split(path.delimiter).filter(Boolean) : [];
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
      { stdio: 'pipe', encoding: 'utf8' },
    );

    if (result.status === 0) {
      defaultEntries.push(...result.stdout.trim().split(path.delimiter).filter(Boolean));
    }
  }

  const mergedEntries = [preferredEntry, ...defaultEntries].filter(Boolean);
  if (mergedEntries.length === 0) {
    return null;
  }

  return [...new Set(mergedEntries.map((entry) => path.resolve(entry)))].join(path.delimiter);
}
