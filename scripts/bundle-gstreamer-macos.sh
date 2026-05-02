#!/usr/bin/env bash
set -euo pipefail

# 从 Homebrew 复制 GStreamer 运行时到 gstreamer-runtime/ 并修复 dylib install_name

GST_PREFIX="$(brew --prefix gstreamer)"
TARGET_DIR="$(git rev-parse --show-toplevel)/apps/desktop/src-tauri/gstreamer-runtime"

if [ ! -d "$GST_PREFIX" ]; then
    echo "Error: GStreamer not found at $GST_PREFIX" >&2
    exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

# 复制运行时必要文件（子目录可能不存在，逐个判断）
for subdir in bin lib libexec; do
    if [ -d "$GST_PREFIX/$subdir" ]; then
        cp -R "$GST_PREFIX/$subdir" "$TARGET_DIR/$subdir"
    fi
done

# 删除不需要的文件（头文件、静态库、pkg-config、cmake）
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

# 修复所有 dylib 的 install_name
# 将 /opt/homebrew/lib/..., /usr/local/lib/..., /opt/local/lib/... 替换为 @rpath/...
REWRITE_PREFIX="@rpath"
while IFS= read -r dylib; do
    # 使用相对于 TARGET_DIR 的路径作为 id，避免不同子目录同名文件冲突
    rel="${dylib#$TARGET_DIR/}"
    changes=()
    while IFS= read -r ref; do
        changes+=(-change "$ref" "$REWRITE_PREFIX/$(basename "$ref")")
    done < <(otool -L "$dylib" | grep -oE '/(opt/homebrew|usr/local|opt/local)[^ ]*' || true)

    if [ ${#changes[@]} -gt 0 ]; then
        install_name_tool -id "$REWRITE_PREFIX/$rel" "${changes[@]}" "$dylib" 2>/dev/null || true
    else
        install_name_tool -id "$REWRITE_PREFIX/$rel" "$dylib" 2>/dev/null || true
    fi
done < <(find "$TARGET_DIR" -type f \( -name "*.dylib" -o -name "*.so" \))

# 修复可执行文件的引用
if [ -d "$TARGET_DIR/bin" ]; then
    while IFS= read -r exe; do
        if file "$exe" | grep -q "Mach-O"; then
            changes=()
            while IFS= read -r ref; do
                changes+=(-change "$ref" "$REWRITE_PREFIX/$(basename "$ref")")
            done < <(otool -L "$exe" | grep -oE '/(opt/homebrew|usr/local|opt/local)[^ ]*' || true)

            if [ ${#changes[@]} -gt 0 ]; then
                install_name_tool "${changes[@]}" "$exe" 2>/dev/null || true
            fi
        fi
    done < <(find "$TARGET_DIR/bin" -type f ! -name "*.dylib" ! -name "*.so")
fi

echo "GStreamer runtime bundled to $TARGET_DIR"
