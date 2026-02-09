#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate.sh
# 用途：驗證 Plugin 整體結構（組合呼叫各 skill 的驗證腳本）
# 呼叫方：/forge:scaffold
# 輸入：$1 = plugin 根目錄路徑
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

TARGET="${1:?用法: validate.sh <plugin 根目錄>}"

if [[ ! -d "$TARGET" ]]; then
    echo "錯誤：不是目錄: $TARGET" >&2
    exit 1
fi

echo -e "${BOLD}=== 驗證 Plugin: ${TARGET} ===${NC}" >&2
echo "" >&2

# --- 基本結構 ---

# plugin.json
PLUGIN_JSON="${TARGET}/.claude-plugin/plugin.json"
if [[ -f "$PLUGIN_JSON" ]]; then
    v_pass "P-01" ".claude-plugin/plugin.json 存在"

    # 驗證 JSON 格式
    if jq empty "$PLUGIN_JSON" 2>/dev/null; then
        v_pass "P-02" "plugin.json 為合法 JSON"

        # name 欄位
        PNAME=$(jq -r '.name // empty' "$PLUGIN_JSON")
        if [[ -n "$PNAME" ]] && echo "$PNAME" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
            v_pass "P-03" "name 為 kebab-case: ${PNAME}"
        else
            v_fail "P-03" "name 必須為 kebab-case: ${PNAME}"
        fi

        # version 欄位（選填）
        PVER=$(jq -r '.version // empty' "$PLUGIN_JSON")
        if [[ -n "$PVER" ]]; then
            if echo "$PVER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
                v_pass "P-04" "version 符合語義版本: ${PVER}"
            else
                v_warn "P-04" "version 建議符合語義版本: ${PVER}"
            fi
        fi
    else
        v_fail "P-02" "plugin.json JSON 格式錯誤"
    fi
else
    v_warn "P-01" ".claude-plugin/plugin.json 不存在（將自動探索）"
fi

# .claude-plugin/ 規則：僅包含 plugin.json
if [[ -d "${TARGET}/.claude-plugin" ]]; then
    EXTRA_FILES=$(find "${TARGET}/.claude-plugin" -type f ! -name "plugin.json" 2>/dev/null || true)
    if [[ -z "$EXTRA_FILES" ]]; then
        v_pass "P-05" ".claude-plugin/ 僅包含 plugin.json"
    else
        v_fail "P-05" ".claude-plugin/ 包含非 plugin.json 的檔案"
    fi
fi

# --- 組件目錄 ---
echo "" >&2
echo -e "${CYAN}--- Skills ---${NC}" >&2

SKILLS_DIR="${TARGET}/skills"
if [[ -d "$SKILLS_DIR" ]]; then
    SKILL_VALIDATE="${PLUGIN_ROOT}/skills/skill/scripts/validate.sh"
    if [[ -x "$SKILL_VALIDATE" ]]; then
        for skill_dir in "${SKILLS_DIR}"/*/; do
            [[ -d "$skill_dir" ]] || continue
            "$SKILL_VALIDATE" "$skill_dir" 2>&1 >&2 || true
        done
    else
        v_warn "P-06" "Skill 驗證腳本不可用: ${SKILL_VALIDATE}"
    fi
else
    v_pass "P-06" "無 skills/ 目錄（選填）"
fi

echo "" >&2
echo -e "${CYAN}--- Agents ---${NC}" >&2

AGENTS_DIR="${TARGET}/agents"
if [[ -d "$AGENTS_DIR" ]]; then
    AGENT_VALIDATE="${PLUGIN_ROOT}/skills/agent/scripts/validate.sh"
    if [[ -x "$AGENT_VALIDATE" ]]; then
        "$AGENT_VALIDATE" "$AGENTS_DIR" 2>&1 >&2 || true
    else
        v_warn "P-07" "Agent 驗證腳本不可用: ${AGENT_VALIDATE}"
    fi
else
    v_pass "P-07" "無 agents/ 目錄（選填）"
fi

echo "" >&2
echo -e "${CYAN}--- Hooks ---${NC}" >&2

HOOKS_FILE="${TARGET}/hooks/hooks.json"
if [[ -f "$HOOKS_FILE" ]]; then
    HOOK_VALIDATE="${PLUGIN_ROOT}/skills/hook/scripts/validate-hook.sh"
    if [[ -x "$HOOK_VALIDATE" ]]; then
        "$HOOK_VALIDATE" "$HOOKS_FILE" 2>&1 >&2 || true
    else
        v_warn "P-08" "Hook 驗證腳本不可用: ${HOOK_VALIDATE}"
    fi
else
    v_pass "P-08" "無 hooks/hooks.json（選填）"
fi

echo "" >&2
echo -e "${CYAN}--- Scripts ---${NC}" >&2

SCRIPTS_DIR="${TARGET}/scripts"
if [[ -d "$SCRIPTS_DIR" ]]; then
    SCRIPT_VALIDATE="${PLUGIN_ROOT}/skills/hook/scripts/validate-script.sh"
    if [[ -x "$SCRIPT_VALIDATE" ]]; then
        "$SCRIPT_VALIDATE" "$SCRIPTS_DIR" 2>&1 >&2 || true
    else
        v_warn "P-09" "Script 驗證腳本不可用: ${SCRIPT_VALIDATE}"
    fi
else
    v_pass "P-09" "無 scripts/ 目錄（選填）"
fi

echo "" >&2
v_summary "Plugin"
