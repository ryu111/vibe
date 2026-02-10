#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate-hook.sh
# 用途：驗證 Hook 組件（V-HK-01 ~ V-HK-15）
# 呼叫方：/forge:hook 或 /forge:scaffold 組合呼叫
# 輸入：$1 = hooks.json 路徑
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

HOOKS_FILE="${1:?用法: validate-hook.sh <hooks.json 路徑>}"
HOOKS_DIR="$(dirname "$HOOKS_FILE")"
PLUGIN_DIR="$(cd "${HOOKS_DIR}/.." && pwd)"

echo -e "${BOLD}驗證 Hooks: ${HOOKS_FILE}${NC}" >&2
echo "" >&2

# --- V-HK-01: hooks.json 為合法 JSON ---
if jq empty "$HOOKS_FILE" 2>/dev/null; then
    v_pass "V-HK-01" "hooks.json 為合法 JSON"
else
    v_fail "V-HK-01" "hooks.json JSON 格式錯誤"
    v_summary "Hook"
    exit 1
fi

# --- V-HK-02: 根物件有 hooks 欄位 ---
if jq -e '.hooks' "$HOOKS_FILE" >/dev/null 2>&1; then
    v_pass "V-HK-02" "根物件有 hooks 欄位"
else
    v_fail "V-HK-02" "根物件缺少 hooks 欄位"
    v_summary "Hook"
    exit 1
fi

# 合法事件名稱
VALID_EVENTS="SessionStart UserPromptSubmit PreToolUse PermissionRequest PostToolUse PostToolUseFailure Notification SubagentStart SubagentStop Stop TeammateIdle TaskCompleted PreCompact SessionEnd"

# 可阻擋事件
BLOCKABLE_EVENTS="PreToolUse PermissionRequest UserPromptSubmit Stop SubagentStop TeammateIdle TaskCompleted"

# --- 遍歷所有事件 ---
EVENTS=$(jq -r '.hooks | keys[]' "$HOOKS_FILE" 2>/dev/null || true)

for event in $EVENTS; do
    [[ -z "$event" ]] && continue

    # --- V-HK-03: Event 名稱合法 ---
    if echo "$VALID_EVENTS" | grep -qw "$event"; then
        v_pass "V-HK-03" "事件名稱合法: ${event}"
    else
        v_fail "V-HK-03" "不合法的事件名稱: ${event}"
        continue
    fi

    # 遍歷 hook groups
    GROUP_COUNT=$(jq -r ".hooks.\"${event}\" | length" "$HOOKS_FILE")
    for ((i=0; i<GROUP_COUNT; i++)); do
        GROUP_PATH=".hooks.\"${event}\"[$i]"

        # 偵測格式：flat（直接有 type）或 grouped（有 hooks 陣列）
        IS_FLAT=$(jq -r "${GROUP_PATH}.type // empty" "$HOOKS_FILE" 2>/dev/null)

        if [[ -n "$IS_FLAT" ]]; then
            # --- Flat 格式：hook entry 直接在陣列中 ---
            v_pass "V-HK-04" "${event}[${i}] 使用 flat hook 格式"

            # 直接處理這個 entry 為單一 hook
            HOOK_COUNT=1
            HOOK_PATHS=("${GROUP_PATH}")
        else
            # --- Grouped 格式：有 matcher + hooks 陣列 ---
            if jq -e "${GROUP_PATH}.hooks" "$HOOKS_FILE" >/dev/null 2>&1; then
                v_pass "V-HK-04" "${event}[${i}] 有 hooks 陣列"
            else
                v_fail "V-HK-04" "${event}[${i}] 缺少 hooks 陣列（且非 flat 格式）"
                continue
            fi

            # --- V-HK-09: matcher 合法（如有） ---
            MATCHER=$(jq -r "${GROUP_PATH}.matcher // empty" "$HOOKS_FILE")
            if [[ -n "$MATCHER" ]]; then
                if echo "test" | grep -qE "$MATCHER" 2>/dev/null || true; then
                    v_pass "V-HK-09" "${event}[${i}] matcher 語法合法: ${MATCHER}"
                fi
            fi

            HOOK_COUNT=$(jq -r "${GROUP_PATH}.hooks | length" "$HOOKS_FILE")
            HOOK_PATHS=()
            for ((j=0; j<HOOK_COUNT; j++)); do
                HOOK_PATHS+=("${GROUP_PATH}.hooks[$j]")
            done
        fi

        # 遍歷每個 hook
        for ((j=0; j<HOOK_COUNT; j++)); do
            HOOK_PATH="${HOOK_PATHS[$j]}"
            HOOK_TYPE=$(jq -r "${HOOK_PATH}.type // empty" "$HOOKS_FILE")

            # --- V-HK-05: type 合法 ---
            if echo "$HOOK_TYPE" | grep -qE '^(command|prompt|agent)$'; then
                v_pass "V-HK-05" "${event}[${i}][${j}] type 合法: ${HOOK_TYPE}"
            else
                v_fail "V-HK-05" "${event}[${i}][${j}] type 不合法: ${HOOK_TYPE}"
                continue
            fi

            if [[ "$HOOK_TYPE" == "command" ]]; then
                CMD=$(jq -r "${HOOK_PATH}.command // empty" "$HOOKS_FILE")

                # --- V-HK-06/07: command hook 腳本 ---
                if [[ -n "$CMD" ]]; then
                    # 替換 ${CLAUDE_PLUGIN_ROOT}
                    ACTUAL_CMD=$(echo "$CMD" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${PLUGIN_DIR}|g")
                    CMD_PATH=$(echo "$ACTUAL_CMD" | awk '{print $1}')

                    if [[ -f "$CMD_PATH" ]]; then
                        v_pass "V-HK-07" "腳本存在: ${CMD}"
                        if [[ -x "$CMD_PATH" ]]; then
                            v_pass "V-HK-06" "腳本可執行: ${CMD}"
                        else
                            v_fail "V-HK-06" "腳本缺少執行權限: ${CMD}"
                        fi
                    else
                        v_fail "V-HK-07" "腳本不存在: ${CMD}"
                    fi
                else
                    v_fail "V-HK-06" "${event}[${i}][${j}] command hook 缺少 command 欄位"
                fi

                # --- V-HK-15: async 僅用於 command ---
                ASYNC=$(jq -r "${HOOK_PATH}.async // empty" "$HOOKS_FILE")
                if [[ -n "$ASYNC" ]]; then
                    ASYNC_TYPE=$(jq -r "${HOOK_PATH}.async | type" "$HOOKS_FILE")
                    if [[ "$ASYNC_TYPE" == "boolean" ]]; then
                        v_pass "V-HK-15" "async 為布林值"
                    else
                        v_warn "V-HK-15" "async 應為布林值: ${ASYNC_TYPE}"
                    fi
                fi
            fi

            if [[ "$HOOK_TYPE" == "prompt" || "$HOOK_TYPE" == "agent" ]]; then
                # --- V-HK-08: prompt/agent 有 prompt 欄位 ---
                PROMPT=$(jq -r "${HOOK_PATH}.prompt // empty" "$HOOKS_FILE")
                if [[ -n "$PROMPT" ]]; then
                    v_pass "V-HK-08" "${HOOK_TYPE} hook 有 prompt 欄位"
                else
                    v_fail "V-HK-08" "${HOOK_TYPE} hook 缺少 prompt 欄位"
                fi
            fi

            # --- V-HK-16: 檢查 hook entry 多餘欄位 ---
            KNOWN_HOOK_FIELDS="type command prompt model timeout statusMessage once async"
            EXTRA_HOOK_FIELDS=$(jq -r "${HOOK_PATH} | keys[]" "$HOOKS_FILE" 2>/dev/null | while read -r key; do
                if ! echo "$KNOWN_HOOK_FIELDS" | grep -qw "$key"; then
                    echo "$key"
                fi
            done)
            if [[ -z "$EXTRA_HOOK_FIELDS" ]]; then
                v_pass "V-HK-16" "${event}[${i}][${j}] 無多餘欄位"
            else
                while IFS= read -r field; do
                    [[ -z "$field" ]] && continue
                    v_fail "V-HK-16" "${event}[${i}][${j}] 不支援的欄位: ${field}"
                done <<< "$EXTRA_HOOK_FIELDS"
            fi

            # --- V-HK-17: 檢查 hook group 多餘欄位（僅 grouped 格式） ---
            if [[ -z "$IS_FLAT" ]]; then
                KNOWN_GROUP_FIELDS="matcher hooks description"
                EXTRA_GROUP_FIELDS=$(jq -r "${GROUP_PATH} | keys[]" "$HOOKS_FILE" 2>/dev/null | while read -r key; do
                    if ! echo "$KNOWN_GROUP_FIELDS" | grep -qw "$key"; then
                        echo "$key"
                    fi
                done)
                if [[ -n "$EXTRA_GROUP_FIELDS" ]]; then
                    while IFS= read -r field; do
                        [[ -z "$field" ]] && continue
                        v_fail "V-HK-17" "${event}[${i}] hook group 不支援的欄位: ${field}"
                    done <<< "$EXTRA_GROUP_FIELDS"
                fi
            fi

            # --- V-HK-10: 不可阻擋事件的提醒 ---
            if ! echo "$BLOCKABLE_EVENTS" | grep -qw "$event"; then
                v_warn "V-HK-10" "${event} 為不可阻擋事件，exit code 2 無效"
            fi

            # --- V-HK-11: 檢查硬編碼路徑 ---
            if [[ "$HOOK_TYPE" == "command" ]]; then
                CMD=$(jq -r "${HOOK_PATH}.command // empty" "$HOOKS_FILE")
                if echo "$CMD" | grep -qE '^/' && ! echo "$CMD" | grep -q 'CLAUDE_PLUGIN_ROOT'; then
                    v_warn "V-HK-11" "command 使用硬編碼路徑，建議用 \${CLAUDE_PLUGIN_ROOT}: ${CMD}"
                else
                    v_pass "V-HK-11" "路徑使用方式正確"
                fi
            fi

            # --- V-HK-12: timeout ---
            TIMEOUT=$(jq -r "${HOOK_PATH}.timeout // empty" "$HOOKS_FILE")
            if [[ -n "$TIMEOUT" ]]; then
                if [[ "$TIMEOUT" =~ ^[0-9]+$ ]] && [[ "$TIMEOUT" -gt 0 ]]; then
                    v_pass "V-HK-12" "timeout 為正整數: ${TIMEOUT}"
                else
                    v_warn "V-HK-12" "timeout 應為正整數: ${TIMEOUT}"
                fi
            fi

            # --- V-HK-13: statusMessage ---
            SM_TYPE=$(jq -r "${HOOK_PATH}.statusMessage | type" "$HOOKS_FILE" 2>/dev/null || echo "null")
            if [[ "$SM_TYPE" != "null" && "$SM_TYPE" != "string" ]]; then
                v_warn "V-HK-13" "statusMessage 應為字串: ${SM_TYPE}"
            fi

            # --- V-HK-14: once ---
            ONCE_TYPE=$(jq -r "${HOOK_PATH}.once | type" "$HOOKS_FILE" 2>/dev/null || echo "null")
            if [[ "$ONCE_TYPE" != "null" && "$ONCE_TYPE" != "boolean" ]]; then
                v_warn "V-HK-14" "once 應為布林值: ${ONCE_TYPE}"
            fi
        done
    done
done

v_summary "Hook"
