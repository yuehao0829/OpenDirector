#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${GENLINE_GSTREAMER_BUNDLE_RUNTIME_DIR:-$REPO_ROOT/apps/desktop/src-tauri/gstreamer-runtime}"
GST_PREFIX="${GENLINE_GSTREAMER_RUNTIME_ROOT:-}"

if [ -z "$GST_PREFIX" ]; then
    if ! command -v brew >/dev/null 2>&1; then
        echo "Error: GENLINE_GSTREAMER_RUNTIME_ROOT is not set and Homebrew is unavailable." >&2
        exit 1
    fi

    if ! GST_PREFIX="$(brew --prefix gstreamer 2>/dev/null)"; then
        echo "Error: Homebrew gstreamer formula is not installed." >&2
        exit 1
    fi
fi

if [ ! -d "$GST_PREFIX" ]; then
    echo "Error: GStreamer not found at $GST_PREFIX" >&2
    exit 1
fi

GST_PREFIX_REAL="$GST_PREFIX"
if GST_PREFIX_CANONICAL="$(cd "$GST_PREFIX" 2>/dev/null && pwd -P)"; then
    GST_PREFIX_REAL="$GST_PREFIX_CANONICAL"
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

for subdir in bin lib libexec; do
    if [ -d "$GST_PREFIX/$subdir" ]; then
        cp -R "$GST_PREFIX/$subdir" "$TARGET_DIR/$subdir"
    fi
done

find "$TARGET_DIR" -name "*.h" -delete
find "$TARGET_DIR" -name "*.a" -delete
find "$TARGET_DIR" -name "*.la" -delete
find "$TARGET_DIR" -name "*.pc" -delete
find "$TARGET_DIR" -name "*.cmake" -delete
find "$TARGET_DIR" -type d -name "pkgconfig" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -type d -name "cmake" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -type d -name "include" -exec rm -rf {} + 2>/dev/null || true

# 删除指向 Homebrew 外部的破损符号链接（如 libgstnice.dylib -> /opt/libnice-gstreamer/...）
find "$TARGET_DIR" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
REWRITE_PREFIX="@rpath"

should_rewrite_reference() {
    local ref="$1"

    case "$ref" in
        @*|/System/*|/usr/lib/*)
            return 1
            ;;
        "$GST_PREFIX"/*|"$GST_PREFIX_REAL"/*|/opt/homebrew/*|/usr/local/*|/opt/local/*|/Library/Frameworks/GStreamer.framework/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

collect_rewrite_references() {
    local binary_path="$1"

    while IFS= read -r line; do
        local ref="${line%% *}"
        if [ -n "$ref" ] && should_rewrite_reference "$ref"; then
            printf '%s\n' "$ref"
        fi
    done < <(otool -L "$binary_path" | tail -n +2)
}

rewrite_binary_references() {
    local binary_path="$1"
    local set_id="${2:-}"

    local changes=()
    while IFS= read -r ref; do
        [ -n "$ref" ] || continue
        changes+=(-change "$ref" "$REWRITE_PREFIX/$(basename "$ref")")
    done < <(collect_rewrite_references "$binary_path")

    if [ -n "$set_id" ]; then
        if [ ${#changes[@]} -gt 0 ]; then
            install_name_tool -id "$REWRITE_PREFIX/$set_id" "${changes[@]}" "$binary_path" 2>/dev/null || true
        else
            install_name_tool -id "$REWRITE_PREFIX/$set_id" "$binary_path" 2>/dev/null || true
        fi
    elif [ ${#changes[@]} -gt 0 ]; then
        install_name_tool "${changes[@]}" "$binary_path" 2>/dev/null || true
    fi
}

while IFS= read -r -d '' dylib; do
    rewrite_binary_references "$dylib" "${dylib#$TARGET_DIR/}"
done < <(find "$TARGET_DIR" -type f \( -name "*.dylib" -o -name "*.so" \) -print0)

if [ -d "$TARGET_DIR/bin" ]; then
    while IFS= read -r -d '' exe; do
        if file "$exe" | grep -q "Mach-O"; then
            rewrite_binary_references "$exe"
        fi
    done < <(find "$TARGET_DIR/bin" -type f ! -name "*.dylib" ! -name "*.so" -print0)
fi

echo "GStreamer runtime bundled from $GST_PREFIX_REAL to $TARGET_DIR"
