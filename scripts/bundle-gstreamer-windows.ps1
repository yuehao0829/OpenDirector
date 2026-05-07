$ErrorActionPreference = "Stop"

$GstRoot = if ($env:OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT) {
    $env:OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT
} elseif ($env:GSTREAMER_1_0_ROOT_MSVC_X86_64) {
    $env:GSTREAMER_1_0_ROOT_MSVC_X86_64
} elseif ($env:GSTREAMER_1_0_ROOT_X86_64) {
    $env:GSTREAMER_1_0_ROOT_X86_64
} else {
    "C:\gstreamer\1.0\msvc\x86_64"
}
$RuntimeDir = if ($env:OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR) {
    $env:OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR
} else {
    Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\gstreamer-runtime"
}
$RootDllDir = if ($env:OPENDIRECTOR_GSTREAMER_BUNDLE_ROOT_DLL_DIR) {
    $env:OPENDIRECTOR_GSTREAMER_BUNDLE_ROOT_DLL_DIR
} else {
    Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\gstreamer-runtime-root"
}

if (-not (Test-Path $GstRoot)) {
    Write-Error "GStreamer not found at $GstRoot"
    exit 1
}

if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
if (Test-Path $RootDllDir) { Remove-Item -Recurse -Force $RootDllDir }

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "bin") | Out-Null
New-Item -ItemType Directory -Force -Path $RootDllDir | Out-Null

# Place runtime DLLs next to the app executable so Windows can resolve them
# before Rust/Tauri code has a chance to adjust PATH.
Copy-Item "$GstRoot\bin\*.dll" -Destination $RootDllDir
$nonDlls = Get-ChildItem "$GstRoot\bin" -File -Exclude *.dll
if ($nonDlls) { Copy-Item $nonDlls -Destination (Join-Path $RuntimeDir "bin") }

Copy-Item -Recurse "$GstRoot\lib\gstreamer-1.0" "$RuntimeDir\lib\gstreamer-1.0"

Get-ChildItem -Recurse "$RuntimeDir", "$RootDllDir" -Filter "*.lib" | Remove-Item -Force
Get-ChildItem -Recurse "$RuntimeDir", "$RootDllDir" -Filter "*.pdb" | Remove-Item -Force
Get-ChildItem -Recurse "$RuntimeDir", "$RootDllDir" -Filter "*.h" | Remove-Item -Force

Write-Host "GStreamer runtime bundled to $RuntimeDir"
Write-Host "Root-level DLLs staged to $RootDllDir"
