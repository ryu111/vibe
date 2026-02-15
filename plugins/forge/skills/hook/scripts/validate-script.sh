#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate-script.sh
# 用途：驗證 Script 組件（V-SC-01 ~ V-SC-10）
# 呼叫方：/forge:hook 或 /forge:scaffold 組合呼叫
# 輸入：$1 = 腳本檔案路徑 或 scripts/ 目錄
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# 支援：.sh（bash）和 .js（node）腳本
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

TARGET="${1:?用法: validate-script.sh <腳本路徑或 scripts/ 目錄>}"

# 收集檔案（支援 .sh 和 .js）
FILES=()
if [[ -d "$TARGET" ]]; then
    while IFS= read -r f; do
        FILES+=("$f")
    done < <(find "$TARGET" \( -name "*.sh" -o -name "*.js" \) -type f 2>/dev/null)
    if [[ ${#FILES[@]} -eq 0 ]]; then
        echo "在 ${TARGET} 中找不到 .sh 或 .js 檔案" >&2
        exit 0
    fi
elif [[ -f "$TARGET" ]]; then
    FILES=("$TARGET")
else
    echo "錯誤：路徑不存在: $TARGET" >&2
    exit 1
fi

for FILE in "${FILES[@]}"; do
    echo -e "${BOLD}驗證 Script: ${FILE}${NC}" >&2
    echo "" >&2

    # 推導被驗證腳本所屬 plugin 的根目錄（向上尋找 .claude-plugin/）
    _dir="$(cd "$(dirname "$FILE")" && pwd)"
    TARGET_PLUGIN_ROOT="$_dir"
    while [[ "$_dir" != "/" ]]; do
        if [[ -d "$_dir/.claude-plugin" ]]; then
            TARGET_PLUGIN_ROOT="$_dir"
            break
        fi
        _dir="$(dirname "$_dir")"
    done

    # 判斷腳本類型
    EXT="${FILE##*.}"

    # --- V-SC-01: 檔案存在 ---
    v_file_exists "V-SC-01" "$FILE" "腳本" || continue

    # --- V-SC-02: 有執行權限 ---
    v_file_executable "V-SC-02" "$FILE" "腳本"

    # --- V-SC-03: 正確的 shebang ---
    FIRST_LINE=$(head -1 "$FILE")
    if [[ "$EXT" == "js" ]]; then
        if [[ "$FIRST_LINE" == "#!/usr/bin/env node" ]]; then
            v_pass "V-SC-03" "shebang 正確（node）"
        elif echo "$FIRST_LINE" | grep -q '^#!/'; then
            v_warn "V-SC-03" "shebang 存在但建議用 #!/usr/bin/env node: ${FIRST_LINE}"
        else
            v_fail "V-SC-03" "缺少 shebang（JS 腳本需要 #!/usr/bin/env node）"
        fi
    else
        if [[ "$FIRST_LINE" == "#!/usr/bin/env bash" ]]; then
            v_pass "V-SC-03" "shebang 正確（bash）"
        elif echo "$FIRST_LINE" | grep -q '^#!/'; then
            v_warn "V-SC-03" "shebang 存在但建議用 #!/usr/bin/env bash: ${FIRST_LINE}"
        else
            v_fail "V-SC-03" "缺少 shebang"
        fi
    fi

    # --- V-SC-04: strict mode ---
    if [[ "$EXT" == "js" ]]; then
        if grep -q "'use strict'" "$FILE" 2>/dev/null; then
            v_pass "V-SC-04" "JS strict mode ('use strict')"
        else
            v_warn "V-SC-04" "建議加入 'use strict'"
        fi
    else
        v_file_contains "V-SC-04" "$FILE" "set -euo pipefail" "strict mode (set -euo pipefail)"
    fi

    # --- V-SC-05: 文件頭註解 ---
    if [[ "$EXT" == "js" ]]; then
        if grep -q '^\s*/\*\*' "$FILE" 2>/dev/null || grep -q '^// ====' "$FILE" 2>/dev/null; then
            v_pass "V-SC-05" "有文件頭註解"
        else
            v_warn "V-SC-05" "建議加入文件頭註解區塊"
        fi
    else
        if grep -q '^# ====' "$FILE" 2>/dev/null; then
            v_pass "V-SC-05" "有文件頭註解"
        else
            v_warn "V-SC-05" "建議加入文件頭註解區塊"
        fi
    fi

    # --- V-SC-06: 不包含硬編碼絕對路徑 ---
    # 排除 shebang 和變數定義行
    HARDCODED=$(grep -nE '^[^#/]*"/Users/|^[^#/]*"/home/' "$FILE" 2>/dev/null | grep -v 'SCRIPT_DIR\|__dirname\|CLAUDE_PLUGIN_ROOT' || true)
    if [[ -z "$HARDCODED" ]]; then
        v_pass "V-SC-06" "無硬編碼絕對路徑"
    else
        v_fail "V-SC-06" "包含硬編碼絕對路徑:\n${HARDCODED}"
    fi

    # --- V-SC-07: 變數/字串安全 ---
    if [[ "$EXT" == "js" ]]; then
        # JS: 檢查是否使用 eval
        if grep -qE '^\s*[^/]*\beval\s*\(' "$FILE" 2>/dev/null; then
            v_warn "V-SC-07" "使用了 eval()，有安全風險"
        else
            v_pass "V-SC-07" "未使用 eval()"
        fi
    else
        # Bash: 簡易檢查未加引號的變數
        UNQUOTED=$(grep -nE '\$[A-Z_]+[^"'\'')}]' "$FILE" 2>/dev/null | grep -v '^[[:space:]]*#' | head -3 || true)
        if [[ -z "$UNQUOTED" ]]; then
            v_pass "V-SC-07" "變數使用有加引號"
        else
            v_warn "V-SC-07" "可能有未加引號的變數（請確認）"
        fi
    fi

    # --- V-SC-08: 不使用危險函式 ---
    if [[ "$EXT" == "js" ]]; then
        if grep -qE '^\s*[^/]*\beval\b' "$FILE" 2>/dev/null; then
            v_warn "V-SC-08" "使用了 eval，有安全風險"
        else
            v_pass "V-SC-08" "未使用 eval"
        fi
    else
        if grep -qE '^[^#]*\beval\b' "$FILE" 2>/dev/null; then
            v_warn "V-SC-08" "使用了 eval，有安全風險"
        else
            v_pass "V-SC-08" "未使用 eval"
        fi
    fi

    # --- V-SC-09: require/source 的檔案存在 ---
    if [[ "$EXT" == "js" ]]; then
        REQUIRES=$(grep -oE "require\(['\"][^'\"]+['\"]\)" "$FILE" 2>/dev/null | grep -v 'node:' | grep -E "require\(['\"]\./" || true)
        if [[ -n "$REQUIRES" ]]; then
            while IFS= read -r req_line; do
                [[ -z "$req_line" ]] && continue
                req_path=$(echo "$req_line" | sed "s/require(['\"]//;s/['\"])//" )
                resolved="$(dirname "$FILE")/${req_path}"
                # 嘗試加上 .js 副檔名
                if [[ -f "$resolved" ]] || [[ -f "${resolved}.js" ]]; then
                    v_pass "V-SC-09" "require 檔案存在: ${req_path}"
                else
                    v_fail "V-SC-09" "require 檔案不存在: ${req_path}"
                fi
            done <<< "$REQUIRES"
        else
            v_pass "V-SC-09" "無本地 require 引用"
        fi
    else
        SOURCES=$(grep -E '^[^#]*source "[^"]*"' "$FILE" 2>/dev/null | grep -oE 'source "[^"]*"' || true)
        if [[ -n "$SOURCES" ]]; then
            while IFS= read -r src_line; do
                [[ -z "$src_line" ]] && continue
                src_path=$(echo "$src_line" | sed 's/source "//;s/"//')
                resolved=$(echo "$src_path" | sed "s|\\\${SCRIPT_DIR}|$(dirname "$FILE")|g" | sed "s|\\\${PLUGIN_ROOT}|${TARGET_PLUGIN_ROOT}|g" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${TARGET_PLUGIN_ROOT}|g")
                if [[ -f "$resolved" ]]; then
                    v_pass "V-SC-09" "source 檔案存在: ${src_path}"
                else
                    v_fail "V-SC-09" "source 檔案不存在: ${src_path} → ${resolved}"
                fi
            done <<< "$SOURCES"
        else
            v_pass "V-SC-09" "無 source 引用"
        fi
    fi

    # --- V-SC-10: 語法檢查 ---
    if [[ "$EXT" == "js" ]]; then
        if node --check "$FILE" 2>/dev/null; then
            v_pass "V-SC-10" "node --check 語法檢查通過"
        else
            v_fail "V-SC-10" "node --check 語法檢查失敗"
        fi
    else
        if bash -n "$FILE" 2>/dev/null; then
            v_pass "V-SC-10" "bash -n 語法檢查通過"
        else
            v_fail "V-SC-10" "bash -n 語法檢查失敗"
        fi
    fi

    echo "" >&2
done

v_summary "Script"
