#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ENTRY_SCRIPT="$REPO_ROOT/scripts/setup-gstreamer-dev.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required to run setup-gstreamer-dev." >&2
  exit 1
fi

exec node "$ENTRY_SCRIPT" "$@"
