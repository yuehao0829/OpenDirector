#!/usr/bin/env bash
set -euo pipefail

ALLOW_MISSING=0
if [ "${1:-}" = "--allow-missing" ]; then
    ALLOW_MISSING=1
    shift
fi

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 [--allow-missing] <repo> <release-tag> <version> <output-dir> [download-dir]" >&2
    exit 2
fi

REPO="$1"
RELEASE_TAG="$2"
VERSION="$3"
OUTPUT_DIR="$4"
CREATED_DOWNLOAD_DIR=0
if [ "$#" -ge 5 ]; then
    DOWNLOAD_DIR="$5"
else
    DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opendirector-gstreamer-download.XXXXXX")"
    CREATED_DOWNLOAD_DIR=1
fi
ASSET_NAME="gstreamer-1.0-macos-universal-${VERSION}-runtime.tar.gz"
MARKER_FILE=".opendirector-gstreamer-runtime.json"
# Exit code returned when --allow-missing is set and the runtime is unavailable.
EXIT_GRACEFUL_SKIP=3

cleanup() {
    if [ "$CREATED_DOWNLOAD_DIR" -eq 1 ]; then
        rm -rf "$DOWNLOAD_DIR"
    fi
}

trap cleanup EXIT

runtime_has_required_files() {
    local runtime_dir="$1"
    [ -f "$runtime_dir/$MARKER_FILE" ] &&
        [ -f "$runtime_dir/bin/gst-discoverer-1.0" ] &&
        [ -f "$runtime_dir/bin/gst-inspect-1.0" ] &&
        [ -f "$runtime_dir/bin/ges-launch-1.0" ] &&
        [ -f "$runtime_dir/libexec/gstreamer-1.0/gst-plugin-scanner" ] &&
        [ -d "$runtime_dir/lib/gstreamer-1.0" ]
}

handle_missing_runtime() {
    local reason="$1"

    if [ "$ALLOW_MISSING" -eq 1 ]; then
        echo "::warning::${reason}; falling back to local macOS runtime bundling"
        exit "$EXIT_GRACEFUL_SKIP"
    fi

    echo "Error: ${reason}" >&2
    exit 1
}

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR" "$DOWNLOAD_DIR"

echo "Downloading GStreamer $ASSET_NAME from release $RELEASE_TAG ..."
if ! gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$ASSET_NAME" --dir "$DOWNLOAD_DIR"; then
    handle_missing_runtime "unable to download prebuilt macOS runtime asset $ASSET_NAME from $RELEASE_TAG"
fi

tar -xzf "$DOWNLOAD_DIR/$ASSET_NAME" -C "$OUTPUT_DIR"

if ! runtime_has_required_files "$OUTPUT_DIR"; then
    echo "Error: downloaded macOS GStreamer runtime is incomplete: $OUTPUT_DIR" >&2
    exit 1
fi

echo "Prepared macOS GStreamer runtime at $OUTPUT_DIR"
