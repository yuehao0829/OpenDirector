param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$EntryScript = Join-Path $RepoRoot "scripts\setup-gstreamer-dev.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to run setup-gstreamer-dev. Install Node.js 20+ first."
}

& node $EntryScript @ScriptArgs
exit $LASTEXITCODE
