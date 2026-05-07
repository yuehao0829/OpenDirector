#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${OPENDIRECTOR_GSTREAMER_BUNDLE_RUNTIME_DIR:-$REPO_ROOT/apps/desktop/src-tauri/gstreamer-runtime}"
GST_PREFIX="${OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT:-}"

# When the prefix points to the generic Homebrew root rather than the GStreamer
# formula directory, resolve to the formula so we only bundle GStreamer's own
# files — not the entire Homebrew cellar.
if [ -n "$GST_PREFIX" ] && command -v brew >/dev/null 2>&1; then
    BREW_PREFIX="$(brew --prefix 2>/dev/null)" || true
    if [ "$GST_PREFIX" = "$BREW_PREFIX" ]; then
        if GST_FORMULA="$(brew --prefix gstreamer 2>/dev/null)"; then
            GST_PREFIX="$GST_FORMULA"
        fi
    fi
fi

if [ -z "$GST_PREFIX" ]; then
    if ! command -v brew >/dev/null 2>&1; then
        echo "Error: OPENDIRECTOR_GSTREAMER_RUNTIME_ROOT is not set and Homebrew is unavailable." >&2
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
find "$TARGET_DIR" -name "*.o" -delete
find "$TARGET_DIR" -name "*.pc" -delete
find "$TARGET_DIR" -name "*.cmake" -delete
find "$TARGET_DIR" -type d -name "pkgconfig" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -type d -name "cmake" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -type d -name "include" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -type d -path "*/lib/ruby" -exec rm -rf {} + 2>/dev/null || true
find "$TARGET_DIR" -name "libruby*" -delete 2>/dev/null || true

# 删除指向 Homebrew 外部的破损符号链接（如 libgstnice.dylib -> /opt/libnice-gstreamer/...）
find "$TARGET_DIR" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

MACH_O_ROOT="$TARGET_DIR"
REWRITE_PREFIX="@rpath"
# shellcheck source=mach-o-common.sh
source "$SCRIPT_DIR/mach-o-common.sh"

# Extend should_rewrite_reference to recognize the GStreamer prefix used at build time.
should_rewrite_reference() {
    local ref="$1"
    case "$ref" in
        "$GST_PREFIX"/*|"$GST_PREFIX_REAL"/*)
            return 0
            ;;
        */lib/ruby/*|*/gems/*|*/ruby/*)
            return 1
            ;;
    esac
    should_rewrite_reference_base "$ref"
}

copy_external_dylib_dependencies() {
    local max_depth="${1:-2}"
    local work_queue=()
    while IFS= read -r -d '' f; do
        work_queue+=("$f")
    done < <(find_runtime_mach_o_files)

    local depth=0
    while [ "${#work_queue[@]}" -gt 0 ]; do
        [ "$depth" -lt "$max_depth" ] || break
        local next_queue=()
        for binary_path in "${work_queue[@]}"; do
            while IFS= read -r ref; do
                [ -n "$ref" ] || continue
                should_rewrite_reference "$ref" || continue

                if [ ! -f "$ref" ]; then
                    echo "Error: referenced dylib does not exist: $ref" >&2
                    exit 1
                fi

                local dest="$TARGET_DIR/lib/$(basename "$ref")"
                if [ ! -f "$dest" ]; then
                    mkdir -p "$TARGET_DIR/lib"
                    cp -p "$ref" "$dest"
                    chmod u+w "$dest" 2>/dev/null || true
                    next_queue+=("$dest")
                fi
            done < <(collect_rewrite_references "$binary_path")
        done
        depth=$((depth + 1))
        [ "${#next_queue[@]}" -gt 0 ] || break
        work_queue=("${next_queue[@]}")
    done
}

copy_external_dylib_dependencies

while IFS= read -r -d '' binary_path; do
    process_mach_o_binary "$binary_path"
done < <(find_runtime_mach_o_files)

remaining_references="$(verify_no_external_references)"
if [ -n "$remaining_references" ]; then
    echo "Error: bundled GStreamer runtime still references external libraries:" >&2
    printf '%s\n' "$remaining_references" >&2
    exit 1
fi

missing_rpaths="$(verify_runtime_rpaths)"
if [ -n "$missing_rpaths" ]; then
    echo "Error: bundled GStreamer runtime is missing required rpaths:" >&2
    printf '%s\n' "$missing_rpaths" >&2
    exit 1
fi

echo "GStreamer runtime bundled from $GST_PREFIX_REAL to $TARGET_DIR"
