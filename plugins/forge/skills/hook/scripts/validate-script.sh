#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate-script.sh
# 用途：驗證 Script 組件（V-SC-01 ~ V-SC-10）
# 呼叫方：/forge:hook 或 /forge:scaffold 組合呼叫
# 輸入：$1 = 腳本檔案路徑 或 scripts/ 目錄
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

TARGET="${1:?用法: validate-script.sh <腳本路徑或 scripts/ 目錄>}"

# 收集檔案
FILES=()
if [[ -d "$TARGET" ]]; then
    while IFS= read -r f; do
        FILES+=("$f")
    done < <(find "$TARGET" -name "*.sh" -type f 2>/dev/null)
    if [[ ${#FILES[@]} -eq 0 ]]; then
        echo "在 ${TARGET} 中找不到 .sh 檔案" >&2
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

    # --- V-SC-01: 檔案存在 ---
    v_file_exists "V-SC-01" "$FILE" "腳本" || continue

    # --- V-SC-02: 有執行權限 ---
    v_file_executable "V-SC-02" "$FILE" "腳本"

    # --- V-SC-03: 正確的 shebang ---
    FIRST_LINE=$(head -1 "$FILE")
    if [[ "$FIRST_LINE" == "#!/usr/bin/env bash" ]]; then
        v_pass "V-SC-03" "shebang 正確"
    elif echo "$FIRST_LINE" | grep -q '^#!/'; then
        v_warn "V-SC-03" "shebang 存在但建議用 #!/usr/bin/env bash: ${FIRST_LINE}"
    else
        v_fail "V-SC-03" "缺少 shebang"
    fi

    # --- V-SC-04: set -euo pipefail ---
    v_file_contains "V-SC-04" "$FILE" "set -euo pipefail" "strict mode (set -euo pipefail)"

    # --- V-SC-05: 文件頭註解 ---
    if grep -q '^# ====' "$FILE" 2>/dev/null; then
        v_pass "V-SC-05" "有文件頭註解"
    else
        v_warn "V-SC-05" "建議加入文件頭註解區塊"
    fi

    # --- V-SC-06: 不包含硬編碼絕對路徑 ---
    # 排除 shebang 和 SCRIPT_DIR 定義行
    HARDCODED=$(grep -nE '^[^#]*"/Users/|^[^#]*"/home/' "$FILE" 2>/dev/null | grep -v 'SCRIPT_DIR' || true)
    if [[ -z "$HARDCODED" ]]; then
        v_pass "V-SC-06" "無硬編碼絕對路徑"
    else
        v_fail "V-SC-06" "包含硬編碼絕對路徑:\n${HARDCODED}"
    fi

    # --- V-SC-07: 變數使用加引號 ---
    # 簡易檢查：找 $VAR 但不在引號內的情況
    UNQUOTED=$(grep -nE '\$[A-Z_]+[^"'\'')}]' "$FILE" 2>/dev/null | grep -v '^[[:space:]]*#' | head -3 || true)
    if [[ -z "$UNQUOTED" ]]; then
        v_pass "V-SC-07" "變數使用有加引號"
    else
        v_warn "V-SC-07" "可能有未加引號的變數（請確認）"
    fi

    # --- V-SC-08: 不使用 eval ---
    if grep -qE '^[^#]*\beval\b' "$FILE" 2>/dev/null; then
        v_warn "V-SC-08" "使用了 eval，有安全風險"
    else
        v_pass "V-SC-08" "未使用 eval"
    fi

    # --- V-SC-09: source 的檔案存在 ---
    SOURCES=$(grep -E '^[^#]*source "[^"]*"' "$FILE" 2>/dev/null | grep -oE 'source "[^"]*"' || true)
    if [[ -n "$SOURCES" ]]; then
        while IFS= read -r src_line; do
            [[ -z "$src_line" ]] && continue
            src_path=$(echo "$src_line" | sed 's/source "//;s/"//')
            # 替換變數
            resolved=$(echo "$src_path" | sed "s|\\\${SCRIPT_DIR}|$(dirname "$FILE")|g" | sed "s|\\\${PLUGIN_ROOT}|${PLUGIN_ROOT}|g" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${PLUGIN_ROOT}|g")
            if [[ -f "$resolved" ]]; then
                v_pass "V-SC-09" "source 檔案存在: ${src_path}"
            else
                v_fail "V-SC-09" "source 檔案不存在: ${src_path} → ${resolved}"
            fi
        done <<< "$SOURCES"
    else
        v_pass "V-SC-09" "無 source 引用"
    fi

    # --- V-SC-10: bash -n 語法檢查 ---
    if bash -n "$FILE" 2>/dev/null; then
        v_pass "V-SC-10" "bash -n 語法檢查通過"
    else
        v_fail "V-SC-10" "bash -n 語法檢查失敗"
    fi

    echo "" >&2
done

v_summary "Script"
