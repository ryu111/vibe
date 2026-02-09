#!/usr/bin/env bash
set -euo pipefail
# ============================================================
# 共用函式庫：common.sh
# 用途：所有腳本共用的基礎工具函式
# 使用方式：source "${SCRIPT_DIR}/lib/common.sh"
# ============================================================

# --- JSON 輸出輔助 ---

# 輸出標準 JSON 回應
# 用法：output_json "pass|warn|block" "訊息"
output_json() {
    local result="$1"
    local reason="${2:-}"
    jq -n \
        --arg result "$result" \
        --arg reason "$reason" \
        '{result: $result, reason: $reason}'
}

# 輸出帶 feedback 的 JSON（PostToolUse 專用）
# 用法：output_feedback "warn" "摘要" "詳細回饋"
output_feedback() {
    local result="$1"
    local reason="$2"
    local feedback="${3:-}"
    jq -n \
        --arg result "$result" \
        --arg reason "$reason" \
        --arg feedback "$feedback" \
        '{result: $result, reason: $reason, feedback: $feedback}'
}

# 輸出阻擋 JSON 並 exit 2（PreToolUse 專用）
# 用法：output_block "阻擋原因"
output_block() {
    local reason="$1"
    jq -n --arg reason "$reason" '{result: "block", reason: $reason}'
    exit 2
}

# --- 檔案判斷 ---

# 取得檔案副檔名
# 用法：ext=$(get_extension "foo.ts")
get_extension() {
    echo "${1##*.}"
}

# 判斷是否為 JavaScript/TypeScript 檔案
is_js_ts() {
    local ext
    ext=$(get_extension "$1")
    [[ "$ext" =~ ^(js|jsx|ts|tsx|mjs|cjs)$ ]]
}

# 判斷是否為 Python 檔案
is_python() {
    local ext
    ext=$(get_extension "$1")
    [[ "$ext" == "py" ]]
}

# --- 工具檢查 ---

# 檢查命令是否可用
# 用法：require_cmd "eslint" || exit 0
require_cmd() {
    command -v "$1" &>/dev/null
}

# --- 日誌 ---

# 輸出到 stderr（不影響 stdout JSON）
log() {
    echo "[forge] $*" >&2
}

log_warn() {
    echo "[forge:warn] $*" >&2
}

log_error() {
    echo "[forge:error] $*" >&2
}
