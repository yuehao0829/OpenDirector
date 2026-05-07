#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <OpenDirector.app>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="$1"
REPO_RUNTIME_DIR="$REPO_ROOT/apps/desktop/src-tauri/gstreamer-runtime"
RUNTIME_DIR="$APP_PATH/Contents/Resources/gstreamer-runtime"

if [ ! -d "$APP_PATH/Contents" ]; then
    echo "Error: app bundle not found: $APP_PATH" >&2
    exit 1
fi

APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
APP_BINARY="$APP_PATH/Contents/MacOS/$APP_EXECUTABLE"

if [ ! -f "$APP_BINARY" ]; then
    echo "Error: app executable not found: $APP_BINARY" >&2
    exit 1
fi

runtime_has_gstreamer() {
    local runtime_dir="$1"
    [ -f "$runtime_dir/bin/gst-discoverer-1.0" ] &&
        [ -f "$runtime_dir/bin/gst-inspect-1.0" ] &&
        [ -f "$runtime_dir/bin/ges-launch-1.0" ] &&
        [ -f "$runtime_dir/libexec/gstreamer-1.0/gst-plugin-scanner" ] &&
        [ -d "$runtime_dir/lib/gstreamer-1.0" ]
}

if ! runtime_has_gstreamer "$REPO_RUNTIME_DIR"; then
    echo "Error: repo GStreamer runtime is missing or incomplete: $REPO_RUNTIME_DIR" >&2
    echo "Run the build through scripts/prepare-gstreamer-runtime.mjs first." >&2
    exit 1
fi

rm -rf "$RUNTIME_DIR"
mkdir -p "$(dirname "$RUNTIME_DIR")"
cp -R "$REPO_RUNTIME_DIR" "$RUNTIME_DIR"

# Keep the runtime focused on GStreamer code that can be signed and notarized.
rm -rf "$RUNTIME_DIR/lib/ruby"
rm -f "$RUNTIME_DIR/bin/session-manager-plugin"
rm -f "$RUNTIME_DIR/bin/openssl"
find "$RUNTIME_DIR" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

# The bundled runtime is already self-contained and uses relative @rpath
# references. Only the app binary itself needs to point at the embedded copy.

MACH_O_ROOT="$RUNTIME_DIR"
REWRITE_PREFIX="@rpath"
# shellcheck source=mach-o-common.sh
source "$SCRIPT_DIR/mach-o-common.sh"

# Exclude Ruby/gem paths from reference rewriting
should_rewrite_reference() {
    local ref="$1"
    case "$ref" in
        */lib/ruby/*|*/gems/*|*/ruby/*)
            return 1
            ;;
    esac
    should_rewrite_reference_base "$ref"
}

chmod u+w "$APP_BINARY" 2>/dev/null || true
delete_external_rpaths "$APP_BINARY"
add_rpath_if_missing "$APP_BINARY" "@executable_path/../Resources/gstreamer-runtime/lib"
rewrite_binary_references "$APP_BINARY"

echo "Bundled GStreamer runtime into $RUNTIME_DIR"
du -sh "$RUNTIME_DIR" 2>/dev/null || true
otool -L "$APP_BINARY" | grep -E '(@rpath|libgst|gstreamer)' || true
