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
    [ -d "$runtime_dir/lib/gstreamer-1.0" ] &&
        [ -n "$(ls -A "$runtime_dir/lib/" 2>/dev/null)" ]
}

if ! runtime_has_gstreamer "$REPO_RUNTIME_DIR"; then
    echo "Repo GStreamer runtime is missing or incomplete; rebuilding it..."
    OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR="$REPO_RUNTIME_DIR" \
        "$REPO_ROOT/scripts/bundle-gstreamer-macos.sh"
fi

if ! runtime_has_gstreamer "$REPO_RUNTIME_DIR"; then
    echo "Error: repo GStreamer runtime is still incomplete: $REPO_RUNTIME_DIR" >&2
    exit 1
fi

rm -rf "$RUNTIME_DIR"
mkdir -p "$(dirname "$RUNTIME_DIR")"
cp -R "$REPO_RUNTIME_DIR" "$RUNTIME_DIR"

if ! runtime_has_gstreamer "$RUNTIME_DIR"; then
    echo "Error: app GStreamer runtime is incomplete after copy: $RUNTIME_DIR" >&2
    exit 1
fi

# Keep the runtime focused on GStreamer code that can be signed and notarized.
rm -rf "$RUNTIME_DIR/lib/ruby"
rm -f "$RUNTIME_DIR/bin/session-manager-plugin"
rm -f "$RUNTIME_DIR/bin/openssl"
find "$RUNTIME_DIR" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

# The GStreamer runtime was already fully processed by bundle-gstreamer-macos.sh
# (rpaths rewritten, dylib ids set, references changed to @rpath). We only need
# to update the app binary itself to point to the embedded runtime.

MACH_O_ROOT="$RUNTIME_DIR"
# shellcheck source=mach-o-common.sh
source "$SCRIPT_DIR/mach-o-common.sh"

# Exclude Ruby/gem paths from reference rewriting
_should_rewrite_reference_base() { should_rewrite_reference "$1"; }
should_rewrite_reference() {
    local ref="$1"
    case "$ref" in
        */lib/ruby/*|*/gems/*|*/ruby/*)
            return 1
            ;;
    esac
    _should_rewrite_reference_base "$ref"
}

chmod u+w "$APP_BINARY" 2>/dev/null || true
delete_external_rpaths "$APP_BINARY"
add_rpath_if_missing "$APP_BINARY" "@executable_path/../Resources/gstreamer-runtime/lib"
rewrite_binary_references "$APP_BINARY"

echo "Bundled GStreamer runtime into $RUNTIME_DIR"
du -sh "$RUNTIME_DIR" 2>/dev/null || true
otool -L "$APP_BINARY" | grep -E '(@rpath|libgst|gstreamer)' || true
