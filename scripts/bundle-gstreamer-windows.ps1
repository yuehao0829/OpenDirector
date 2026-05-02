$ErrorActionPreference = "Stop"

$GstRoot = if ($env:GSTREAMER_1_0_ROOT_MSVC_X86_64) { $env:GSTREAMER_1_0_ROOT_MSVC_X86_64 } else { "C:\gstreamer\1.0\msvc\x86_64" }
$TargetDir = Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\gstreamer-runtime"

if (-not (Test-Path $GstRoot)) {
    Write-Error "GStreamer not found at $GstRoot"
    exit 1
}

if (Test-Path $TargetDir) { Remove-Item -Recurse -Force $TargetDir }

# 复制 bin (exe + dll)
Copy-Item -Recurse "$GstRoot\bin" "$TargetDir\bin"

# 复制插件
Copy-Item -Recurse "$GstRoot\lib\gstreamer-1.0" "$TargetDir\lib\gstreamer-1.0"

# 删除不需要的文件
Get-ChildItem -Recurse "$TargetDir" -Filter "*.lib" | Remove-Item -Force
Get-ChildItem -Recurse "$TargetDir" -Filter "*.pdb" | Remove-Item -Force
Get-ChildItem -Recurse "$TargetDir" -Filter "*.h" | Remove-Item -Force

Write-Host "GStreamer runtime bundled to $TargetDir"
