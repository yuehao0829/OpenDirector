# Shared Mach-O binary manipulation functions for macOS app bundling.
# Source this file, do not execute it directly.
#
# Required variables (set before sourcing):
#   MACH_O_ROOT    - root directory to scan for Mach-O files
#   REWRITE_PREFIX - prefix for rewritten references (typically "@rpath")
#
# Optional overrides (define AFTER sourcing to customize):
#   should_rewrite_reference() - override to add custom prefix patterns

is_mach_o() {
    local binary_path="$1"
    file "$binary_path" 2>/dev/null | grep -q "Mach-O"
}

is_dylib() {
    local binary_path="$1"
    file "$binary_path" 2>/dev/null | grep -q "dynamically linked shared library"
}

find_runtime_mach_o_files() {
    while IFS= read -r -d '' candidate; do
        case "$candidate" in
            *.o) continue ;;
        esac
        if is_mach_o "$candidate"; then
            printf '%s\0' "$candidate"
        fi
    done < <(find "$MACH_O_ROOT" -type f -print0)
}

should_rewrite_reference() {
    local ref="$1"
    case "$ref" in
        @*|/System/*|/usr/lib/*)
            return 1
            ;;
        /opt/homebrew/*|/usr/local/*|/opt/local/*|/Library/Frameworks/GStreamer.framework/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Parse otool -l output into a compact format for batch processing.
# Output: "RPATH:<path>" or "LOAD_DYLIB:<path>" per line.
parse_otool_load_commands() {
    local binary_path="$1"
    otool -l "$binary_path" |
        awk '
            $1 == "cmd" { cmd = $2; next }
            cmd == "LC_RPATH" && $1 == "path" { print "RPATH:" $2; cmd = ""; next }
            cmd == "LC_LOAD_DYLIB" && $1 == "name" { print "LOAD_DYLIB:" $2; cmd = ""; next }
        '
}

# Collect all external rpaths that should be rewritten.
collect_external_rpaths() {
    local binary_path="$1"
    while IFS= read -r line; do
        case "$line" in
            RPATH:*)
                local rpath="${line#RPATH:}"
                if should_rewrite_reference "$rpath"; then
                    printf '%s\n' "$rpath"
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
}

expected_runtime_rpath() {
    local binary_path="$1"
    local relative_path="${binary_path#$MACH_O_ROOT/}"

    case "$relative_path" in
        lib/gstreamer-1.0/*)
            printf '%s\n' "@loader_path/.."
            ;;
        lib/*)
            printf '%s\n' "@loader_path"
            ;;
        bin/*)
            printf '%s\n' "@executable_path/../lib"
            ;;
        libexec/gstreamer-1.0/*)
            printf '%s\n' "@executable_path/../../lib"
            ;;
        libexec/*)
            printf '%s\n' "@executable_path/../lib"
            ;;
    esac
}

# Legacy helper functions for manipulating individual binaries outside the
# runtime tree (e.g. the app executable itself).

delete_external_rpaths() {
    local binary_path="$1"
    local args=("__sentinel__")
    args=()
    while IFS= read -r line; do
        case "$line" in
            RPATH:*)
                local rpath="${line#RPATH:}"
                if should_rewrite_reference "$rpath"; then
                    args+=(-delete_rpath "$rpath")
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
    if [ "${#args[@]}" -gt 0 ]; then
        chmod u+w "$binary_path" 2>/dev/null || true
        install_name_tool "${args[@]}" "$binary_path"
    fi
}

add_rpath_if_missing() {
    local binary_path="$1"
    local rpath="$2"
    local found=0
    while IFS= read -r line; do
        case "$line" in
            "RPATH:$rpath")
                found=1
                break
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
    if [ "$found" -eq 0 ]; then
        chmod u+w "$binary_path" 2>/dev/null || true
        install_name_tool -add_rpath "$rpath" "$binary_path"
    fi
}

rewrite_binary_references() {
    local binary_path="$1"
    local binary_basename
    binary_basename="$(basename "$binary_path")"
    local args=("__sentinel__")
    args=()
    while IFS= read -r line; do
        case "$line" in
            LOAD_DYLIB:*)
                local ref="${line#LOAD_DYLIB:}"
                if [ "$(basename "$ref")" = "$binary_basename" ]; then
                    continue
                fi
                if should_rewrite_reference "$ref"; then
                    args+=(-change "$ref" "$REWRITE_PREFIX/$(basename "$ref")")
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
    if [ "${#args[@]}" -gt 0 ]; then
        chmod u+w "$binary_path" 2>/dev/null || true
        install_name_tool "${args[@]}" "$binary_path"
    fi
}

binary_has_rpath() {
    local binary_path="$1"
    local rpath="$2"
    while IFS= read -r line; do
        case "$line" in
            "RPATH:$rpath") return 0 ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
    return 1
}

# Configure rpaths for a single binary: delete external rpaths, add expected one.
# Uses a single install_name_tool call when possible.
configure_runtime_rpaths() {
    local binary_path="$1"
    local args=("__sentinel__")
    args=()

    local expected_rpath
    expected_rpath="$(expected_runtime_rpath "$binary_path")"

    # Collect all operations from a single otool -l pass
    local need_add_rpath=1
    while IFS= read -r line; do
        case "$line" in
            RPATH:*)
                local rpath="${line#RPATH:}"
                if should_rewrite_reference "$rpath"; then
                    args+=(-delete_rpath "$rpath")
                elif [ -n "$expected_rpath" ] && [ "$rpath" = "$expected_rpath" ]; then
                    need_add_rpath=0
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")

    if [ -n "$expected_rpath" ] && [ "$need_add_rpath" -eq 1 ]; then
        args+=(-add_rpath "$expected_rpath")
    fi

    if [ "${#args[@]}" -gt 0 ]; then
        chmod u+w "$binary_path" 2>/dev/null || true
        install_name_tool "${args[@]}" "$binary_path"
    fi
}

collect_rewrite_references() {
    local binary_path="$1"
    local binary_basename
    binary_basename="$(basename "$binary_path")"

    while IFS= read -r line; do
        case "$line" in
            LOAD_DYLIB:*)
                local ref="${line#LOAD_DYLIB:}"
                if [ "$(basename "$ref")" = "$binary_basename" ]; then
                    continue
                fi
                if should_rewrite_reference "$ref"; then
                    printf '%s\n' "$ref"
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")
}

# Rewrite all external references + dylib id + configure rpaths in a single
# install_name_tool call per binary. This is the key optimization: instead of
# 3-5 separate install_name_tool calls per binary, we do just one.
process_mach_o_binary() {
    local binary_path="$1"
    local args=("__sentinel__")
    args=()

    local expected_rpath
    expected_rpath="$(expected_runtime_rpath "$binary_path")"

    local binary_basename
    binary_basename="$(basename "$binary_path")"

    local need_add_rpath=1
    local is_dylib=0

    while IFS= read -r line; do
        case "$line" in
            RPATH:*)
                local rpath="${line#RPATH:}"
                if should_rewrite_reference "$rpath"; then
                    args+=(-delete_rpath "$rpath")
                elif [ -n "$expected_rpath" ] && [ "$rpath" = "$expected_rpath" ]; then
                    need_add_rpath=0
                fi
                ;;
            LOAD_DYLIB:*)
                local ref="${line#LOAD_DYLIB:}"
                if [ "$(basename "$ref")" = "$binary_basename" ]; then
                    is_dylib=1
                    continue
                fi
                if should_rewrite_reference "$ref"; then
                    args+=(-change "$ref" "$REWRITE_PREFIX/$(basename "$ref")")
                fi
                ;;
        esac
    done < <(parse_otool_load_commands "$binary_path")

    if [ -n "$expected_rpath" ] && [ "$need_add_rpath" -eq 1 ]; then
        args+=(-add_rpath "$expected_rpath")
    fi

    if [ "$is_dylib" -eq 1 ]; then
        args+=(-id "$REWRITE_PREFIX/$binary_basename")
    fi

    if [ "${#args[@]}" -gt 0 ]; then
        chmod u+w "$binary_path" 2>/dev/null || true
        install_name_tool "${args[@]}" "$binary_path"
    fi
}

# Print any remaining external rpaths or references for extra binaries (args)
# plus all runtime Mach-O files. Returns non-empty string if issues found.
verify_no_external_references() {
    for binary_path in "$@"; do
        while IFS= read -r line; do
            case "$line" in
                RPATH:*)
                    local rpath="${line#RPATH:}"
                    if should_rewrite_reference "$rpath"; then
                        printf '%s LC_RPATH -> %s\n' "$binary_path" "$rpath"
                    fi
                    ;;
                LOAD_DYLIB:*)
                    local ref="${line#LOAD_DYLIB:}"
                    local bn
                    bn="$(basename "$ref")"
                    [ "$bn" = "$(basename "$binary_path")" ] && continue
                    if should_rewrite_reference "$ref"; then
                        printf '%s -> %s\n' "$binary_path" "$ref"
                    fi
                    ;;
            esac
        done < <(parse_otool_load_commands "$binary_path")
    done

    while IFS= read -r -d '' binary_path; do
        while IFS= read -r line; do
            case "$line" in
                RPATH:*)
                    local rpath="${line#RPATH:}"
                    if should_rewrite_reference "$rpath"; then
                        printf '%s LC_RPATH -> %s\n' "$binary_path" "$rpath"
                    fi
                    ;;
                LOAD_DYLIB:*)
                    local ref="${line#LOAD_DYLIB:}"
                    local bn
                    bn="$(basename "$ref")"
                    [ "$bn" = "$(basename "$binary_path")" ] && continue
                    if should_rewrite_reference "$ref"; then
                        printf '%s -> %s\n' "$binary_path" "$ref"
                    fi
                    ;;
            esac
        done < <(parse_otool_load_commands "$binary_path")
    done < <(find_runtime_mach_o_files)
}

# Print any runtime Mach-O files missing their expected rpath.
verify_runtime_rpaths() {
    while IFS= read -r -d '' binary_path; do
        local expected_rpath
        expected_rpath="$(expected_runtime_rpath "$binary_path")"
        [ -n "$expected_rpath" ] || continue

        local found=0
        while IFS= read -r line; do
            case "$line" in
                "RPATH:$expected_rpath")
                    found=1
                    break
                    ;;
            esac
        done < <(parse_otool_load_commands "$binary_path")

        if [ "$found" -eq 0 ]; then
            printf '%s missing LC_RPATH %s\n' "$binary_path" "$expected_rpath"
        fi
    done < <(find_runtime_mach_o_files)
}
