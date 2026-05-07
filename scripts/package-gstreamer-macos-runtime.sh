#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GSTREAMER_MACOS_VERSION="${1:-${GSTREAMER_MACOS_VERSION:-1.28.2}}"
OUTPUT_DIR="${2:-${OPENDIRECTOR_GSTREAMER_OUTPUT_DIR:-$REPO_ROOT/.artifacts/gstreamer-runtime}}"
ASSET_NAME="gstreamer-1.0-macos-universal-${GSTREAMER_MACOS_VERSION}-runtime.tar.gz"
PKG_URL="${GSTREAMER_MACOS_RUNTIME_PKG_URL:-https://gstreamer.freedesktop.org/data/pkg/osx/${GSTREAMER_MACOS_VERSION}/gstreamer-1.0-${GSTREAMER_MACOS_VERSION}-universal.pkg}"
MARKER_FILE=".opendirector-gstreamer-runtime.json"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opendirector-gstreamer-macos.XXXXXX")"
PKG_PATH="$WORK_DIR/gstreamer-runtime.pkg"
EXPANDED_DIR="$WORK_DIR/expanded"
SOURCE_ROOT="$WORK_DIR/source-root"
RUNTIME_ROOT="$WORK_DIR/runtime-root"
ASSET_PATH="$OUTPUT_DIR/$ASSET_NAME"
CHECKSUM_PATH="$ASSET_PATH.sha256"

cleanup() {
    rm -rf "$WORK_DIR"
}

trap cleanup EXIT

copy_required_file() {
    local source_path="$1"
    local target_path="$2"

    if [ ! -f "$source_path" ]; then
        echo "Error: required runtime file is missing: $source_path" >&2
        exit 1
    fi

    mkdir -p "$(dirname "$target_path")"
    cp -p "$source_path" "$target_path"
    chmod u+w "$target_path" 2>/dev/null || true
}

MACH_O_ROOT=""  # set before sourcing; overridden per-call below
REWRITE_PREFIX=""
# shellcheck source=mach-o-common.sh
source "$SCRIPT_DIR/mach-o-common.sh"

binary_has_load_dylib() {
    local binary_path="$1"
    local expected_ref="$2"
    while IFS= read -r line; do
        case "$line" in
            "LOAD_DYLIB:$expected_ref") return 0 ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
    return 1
}

assert_universal_binary() {
    local binary_path="$1"
    local archs

    archs="$(lipo -archs "$binary_path")"
    case "$archs" in
        *arm64*x86_64*|*x86_64*arm64*)
            ;;
        *)
            echo "Error: expected a universal binary, got: $binary_path -> $archs" >&2
            exit 1
            ;;
    esac
}

validate_runtime_layout() {
    local runtime_root="$1"
    local sample_plugin="$runtime_root/lib/gstreamer-1.0/libgstcoreelements.dylib"

    if [ ! -f "$sample_plugin" ]; then
        sample_plugin="$runtime_root/lib/gstreamer-1.0/libgstvideotestsrc.dylib"
    fi

    if [ ! -f "$sample_plugin" ]; then
        echo "Error: expected a sample GStreamer plugin in $runtime_root/lib/gstreamer-1.0" >&2
        exit 1
    fi

    assert_universal_binary "$runtime_root/bin/gst-discoverer-1.0"
    assert_universal_binary "$runtime_root/bin/gst-inspect-1.0"
    assert_universal_binary "$runtime_root/bin/ges-launch-1.0"
    assert_universal_binary "$runtime_root/libexec/gstreamer-1.0/gst-plugin-scanner"
    assert_universal_binary "$sample_plugin"

    binary_has_rpath "$runtime_root/bin/gst-inspect-1.0" "@executable_path/../lib" || {
        echo "Error: gst-inspect-1.0 is missing @executable_path/../lib rpath" >&2
        exit 1
    }

    binary_has_rpath "$runtime_root/libexec/gstreamer-1.0/gst-plugin-scanner" "@executable_path/../../lib" || {
        echo "Error: gst-plugin-scanner is missing @executable_path/../../lib rpath" >&2
        exit 1
    }

    binary_has_rpath "$sample_plugin" "@loader_path/../../lib" || {
        echo "Error: sample plugin is missing @loader_path/../../lib rpath" >&2
        exit 1
    }

    binary_has_load_dylib "$runtime_root/bin/gst-inspect-1.0" "@rpath/libgstreamer-1.0.0.dylib" || {
        echo "Error: gst-inspect-1.0 no longer links against @rpath/libgstreamer-1.0.0.dylib" >&2
        exit 1
    }
}

mkdir -p "$OUTPUT_DIR" "$SOURCE_ROOT" "$RUNTIME_ROOT"

echo "Downloading official GStreamer macOS runtime package..."
curl -L --fail --progress-bar -o "$PKG_PATH" "$PKG_URL"

echo "Expanding package..."
pkgutil --expand-full "$PKG_PATH" "$EXPANDED_DIR"

echo "Assembling runtime root from package payloads..."
while IFS= read -r payload_dir; do
    ditto "$payload_dir" "$SOURCE_ROOT"
done < <(find "$EXPANDED_DIR" -type d -path '*/Payload' | sort)

if [ ! -d "$SOURCE_ROOT/lib" ] || [ ! -d "$SOURCE_ROOT/lib/gstreamer-1.0" ]; then
    echo "Error: extracted runtime root is missing lib/gstreamer-1.0" >&2
    exit 1
fi

ditto "$SOURCE_ROOT/lib" "$RUNTIME_ROOT/lib"
copy_required_file "$SOURCE_ROOT/bin/gst-discoverer-1.0" "$RUNTIME_ROOT/bin/gst-discoverer-1.0"
copy_required_file "$SOURCE_ROOT/bin/gst-inspect-1.0" "$RUNTIME_ROOT/bin/gst-inspect-1.0"
copy_required_file "$SOURCE_ROOT/bin/ges-launch-1.0" "$RUNTIME_ROOT/bin/ges-launch-1.0"
copy_required_file \
    "$SOURCE_ROOT/libexec/gstreamer-1.0/gst-plugin-scanner" \
    "$RUNTIME_ROOT/libexec/gstreamer-1.0/gst-plugin-scanner"

echo "Pruning non-runtime files..."
rm -rf "$RUNTIME_ROOT/lib/gstreamer-1.0/include"
rm -rf "$RUNTIME_ROOT/lib/gstreamer-1.0/python"
rm -rf "$RUNTIME_ROOT/lib/gstreamer-1.0/validate"
rm -rf "$RUNTIME_ROOT/lib/pkgconfig"
rm -rf "$RUNTIME_ROOT/lib/cmake"
rm -rf "$RUNTIME_ROOT/lib/gobject-introspection-1.0"
rm -f "$RUNTIME_ROOT/lib/gstreamer-1.0/libgstpython.dylib"
rm -f "$RUNTIME_ROOT/lib/gstreamer-1.0/libgstvalidatetracer.dylib"
find "$RUNTIME_ROOT" \( \
    -name '*.a' -o \
    -name '*.la' -o \
    -name '*.h' -o \
    -name '*.pc' -o \
    -name '*.cmake' \
\) -delete
find "$RUNTIME_ROOT" -type d \( -name pkgconfig -o -name cmake -o -name include \) -prune -exec rm -rf {} +
find "$RUNTIME_ROOT" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

cat >"$RUNTIME_ROOT/$MARKER_FILE" <<EOF
{
  "layout": "prebundled-runtime",
  "platform": "darwin",
  "architectures": ["arm64", "x86_64"],
  "source": "official-gstreamer-runtime-pkg",
  "sourceUrl": "$PKG_URL",
  "version": "$GSTREAMER_MACOS_VERSION",
  "assetName": "$ASSET_NAME"
}
EOF

echo "Validating runtime layout..."
validate_runtime_layout "$RUNTIME_ROOT"

rm -f "$ASSET_PATH" "$CHECKSUM_PATH"
tar -czf "$ASSET_PATH" -C "$RUNTIME_ROOT" .
shasum -a 256 "$ASSET_PATH" >"$CHECKSUM_PATH"

echo "Created macOS runtime asset:"
echo "  $ASSET_PATH"
echo "Checksum:"
cat "$CHECKSUM_PATH"
echo "Runtime size:"
du -sh "$RUNTIME_ROOT"
echo "Asset size:"
du -sh "$ASSET_PATH"
