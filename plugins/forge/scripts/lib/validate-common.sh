#!/usr/bin/env bash
set -euo pipefail
# ============================================================
# 共用函式庫：validate-common.sh
# 用途：所有驗證腳本共用的框架（計數、輸出、摘要）
# 使用方式：source "${SCRIPT_DIR}/lib/validate-common.sh"
# ============================================================

# --- 顏色定義 ---
if [[ -t 2 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

# --- 計數器 ---
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

# --- 驗證輸出 ---

# 輸出 PASS
# 用法：v_pass "V-SK-01" "SKILL.md 存在"
v_pass() {
    local rule="$1"
    local msg="$2"
    ((PASS_COUNT++))
    echo -e "${GREEN}✓ PASS${NC} [${rule}] ${msg}" >&2
}

# 輸出 WARN
# 用法：v_warn "V-SK-04" "description 欄位建議填寫"
v_warn() {
    local rule="$1"
    local msg="$2"
    ((WARN_COUNT++))
    echo -e "${YELLOW}⚠ WARN${NC} [${rule}] ${msg}" >&2
}

# 輸出 FAIL
# 用法：v_fail "V-SK-02" "Frontmatter YAML 格式錯誤"
v_fail() {
    local rule="$1"
    local msg="$2"
    ((FAIL_COUNT++))
    echo -e "${RED}✗ FAIL${NC} [${rule}] ${msg}" >&2
}

# --- 摘要 ---

# 輸出驗證摘要並回傳 exit code
# 用法：v_summary "skill" → exit code 0 (全過) 或 1 (有失敗)
v_summary() {
    local component="${1:-component}"
    local total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
    echo "" >&2
    echo -e "${BOLD}── ${component} 驗證摘要 ──${NC}" >&2
    echo -e "  ${GREEN}PASS${NC}: ${PASS_COUNT}  ${YELLOW}WARN${NC}: ${WARN_COUNT}  ${RED}FAIL${NC}: ${FAIL_COUNT}  Total: ${total}" >&2

    if [[ $FAIL_COUNT -gt 0 ]]; then
        echo -e "  ${RED}${BOLD}結果：未通過${NC}" >&2
        return 1
    elif [[ $WARN_COUNT -gt 0 ]]; then
        echo -e "  ${YELLOW}${BOLD}結果：通過（有警告）${NC}" >&2
        return 0
    else
        echo -e "  ${GREEN}${BOLD}結果：全部通過${NC}" >&2
        return 0
    fi
}

# --- 輔助函式 ---

# 檢查檔案是否存在
# 用法：v_file_exists "V-SK-01" "$file" "SKILL.md"
v_file_exists() {
    local rule="$1"
    local file="$2"
    local desc="$3"
    if [[ -f "$file" ]]; then
        v_pass "$rule" "${desc} 存在"
        return 0
    else
        v_fail "$rule" "${desc} 不存在: ${file}"
        return 1
    fi
}

# 檢查檔案是否有執行權限
# 用法：v_file_executable "V-SC-02" "$file" "腳本"
v_file_executable() {
    local rule="$1"
    local file="$2"
    local desc="$3"
    if [[ -x "$file" ]]; then
        v_pass "$rule" "${desc} 有執行權限"
        return 0
    else
        v_fail "$rule" "${desc} 缺少執行權限: ${file}"
        return 1
    fi
}

# 檢查檔案是否包含指定字串
# 用法：v_file_contains "V-SC-03" "$file" "#!/usr/bin/env bash" "shebang"
v_file_contains() {
    local rule="$1"
    local file="$2"
    local pattern="$3"
    local desc="$4"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        v_pass "$rule" "${desc}"
        return 0
    else
        v_fail "$rule" "缺少 ${desc}: ${pattern}"
        return 1
    fi
}

# 檢查檔案是否不包含指定模式
# 用法：v_file_not_contains "V-SC-06" "$file" "^/Users/" "不應包含硬編碼路徑"
v_file_not_contains() {
    local rule="$1"
    local file="$2"
    local pattern="$3"
    local desc="$4"
    if grep -qE "$pattern" "$file" 2>/dev/null; then
        v_fail "$rule" "${desc}"
        return 1
    else
        v_pass "$rule" "${desc}"
        return 0
    fi
}
