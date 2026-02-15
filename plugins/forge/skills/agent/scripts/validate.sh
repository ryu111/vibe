#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate.sh
# 用途：驗證 Agent 組件（V-AG-01 ~ V-AG-15）
# 呼叫方：/forge:agent 或 /forge:scaffold 組合呼叫
# 輸入：$1 = agent .md 路徑 或 agents/ 目錄
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

TARGET="${1:?用法: validate.sh <agent.md 路徑或 agents/ 目錄>}"

# 支援目錄（批量驗證）或單一檔案
FILES=()
if [[ -d "$TARGET" ]]; then
    while IFS= read -r f; do
        FILES+=("$f")
    done < <(find "$TARGET" -name "*.md" -maxdepth 1 -type f 2>/dev/null)
    if [[ ${#FILES[@]} -eq 0 ]]; then
        echo "在 ${TARGET} 中找不到 .md 檔案" >&2
        exit 0
    fi
elif [[ -f "$TARGET" ]]; then
    FILES=("$TARGET")
else
    echo "錯誤：路徑不存在: $TARGET" >&2
    exit 1
fi

VALID_TOOLS="Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch|Task|TaskCreate|TaskGet|TaskList|TaskUpdate|TaskOutput|NotebookEdit|AskUserQuestion|Skill|KillShell|MCPSearch|ExitPlanMode|LSP"
VALID_MODELS="sonnet|opus|haiku|inherit"
VALID_PERM_MODES="default|acceptEdits|delegate|dontAsk|bypassPermissions|plan"
VALID_MEMORY="user|project|local"
VALID_COLORS="red|blue|green|yellow|purple|orange|pink|cyan"

for FILE in "${FILES[@]}"; do
    echo -e "${BOLD}驗證 Agent: ${FILE}${NC}" >&2
    echo "" >&2

    # 推導被驗證 agent 所屬 plugin 的根目錄（agents/{name}.md → 往上 2 層）
    TARGET_PLUGIN_ROOT="$(cd "$(dirname "$FILE")/.." && pwd)"

    # --- V-AG-01: .md 檔案存在 ---
    v_file_exists "V-AG-01" "$FILE" "Agent .md" || continue

    CONTENT=$(cat "$FILE")

    # --- 提取 frontmatter ---
    if echo "$CONTENT" | head -1 | grep -q '^---'; then
        FRONTMATTER=$(echo "$CONTENT" | awk 'BEGIN{n=0} /^---$/{n++; next} n==1{print}')
        BODY=$(echo "$CONTENT" | awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}')
    else
        FRONTMATTER=""
        BODY="$CONTENT"
    fi

    # --- V-AG-02: Frontmatter 為合法 YAML ---
    if [[ -n "$FRONTMATTER" ]]; then
        if echo "$FRONTMATTER" | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" 2>/dev/null; then
            v_pass "V-AG-02" "Frontmatter 為合法 YAML"
        else
            v_fail "V-AG-02" "Frontmatter YAML 格式錯誤"
            continue
        fi
    else
        v_fail "V-AG-02" "缺少 YAML frontmatter"
        continue
    fi

    # 輔助函式
    get_field() {
        echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
val = data.get('$1', '')
if val is None: val = ''
if isinstance(val, list): val = ', '.join(str(v) for v in val)
print(val)
" 2>/dev/null || echo ""
    }

    get_field_type() {
        echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
val = data.get('$1')
if val is None: print('missing')
else: print(type(val).__name__)
" 2>/dev/null || echo "missing"
    }

    # --- V-AG-16: 檢查多餘欄位 ---
    KNOWN_FIELDS="name description tools disallowedTools model color permissionMode maxTurns skills mcpServers hooks memory"
    EXTRA_FIELDS=$(echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
known = set('$KNOWN_FIELDS'.split())
extra = [k for k in data.keys() if k not in known]
for f in extra: print(f)
" 2>/dev/null || true)
    if [[ -z "$EXTRA_FIELDS" ]]; then
        v_pass "V-AG-16" "無多餘欄位"
    else
        while IFS= read -r field; do
            [[ -z "$field" ]] && continue
            v_fail "V-AG-16" "不支援的欄位: ${field}（可能是拼寫錯誤）"
        done <<< "$EXTRA_FIELDS"
    fi

    # --- V-AG-03: name ---
    NAME=$(get_field "name")
    if [[ -n "$NAME" ]] && echo "$NAME" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
        v_pass "V-AG-03" "name 合法: ${NAME}"
    else
        v_fail "V-AG-03" "name 必須存在且為 kebab-case: ${NAME}"
    fi

    # --- V-AG-04: description ---
    DESC=$(get_field "description")
    if [[ -n "$DESC" ]]; then
        v_pass "V-AG-04" "description 存在"
    else
        v_fail "V-AG-04" "description 必須存在且非空"
    fi

    # --- V-AG-05: tools ---
    TOOLS=$(get_field "tools")
    if [[ -n "$TOOLS" ]]; then
        ALL_VALID=true
        IFS=',' read -ra TOOL_ARRAY <<< "$TOOLS"
        for tool in "${TOOL_ARRAY[@]}"; do
            tool=$(echo "$tool" | xargs)
            tool_base=$(echo "$tool" | sed 's/(.*//')
            if ! echo "$tool_base" | grep -qE "^(${VALID_TOOLS}|mcp__)" ; then
                v_fail "V-AG-05" "不合法的工具: ${tool}"
                ALL_VALID=false
            fi
        done
        if $ALL_VALID; then
            v_pass "V-AG-05" "tools 合法"
        fi
    else
        v_pass "V-AG-05" "tools 未設定（繼承全部）"
    fi

    # --- V-AG-06: disallowedTools ---
    DTOOLS=$(get_field "disallowedTools")
    if [[ -n "$DTOOLS" ]]; then
        ALL_VALID=true
        IFS=',' read -ra DT_ARRAY <<< "$DTOOLS"
        for tool in "${DT_ARRAY[@]}"; do
            tool=$(echo "$tool" | xargs)
            if ! echo "$tool" | grep -qE "^(${VALID_TOOLS}|mcp__)" ; then
                v_fail "V-AG-06" "不合法的 disallowedTool: ${tool}"
                ALL_VALID=false
            fi
        done
        if $ALL_VALID; then
            v_pass "V-AG-06" "disallowedTools 合法"
        fi
    else
        v_pass "V-AG-06" "disallowedTools 未設定"
    fi

    # --- V-AG-07: tools 和 disallowedTools 不同時存在 ---
    if [[ -n "$TOOLS" && -n "$DTOOLS" ]]; then
        v_fail "V-AG-07" "tools 和 disallowedTools 不應同時存在"
    else
        v_pass "V-AG-07" "tools/disallowedTools 無衝突"
    fi

    # --- V-AG-08: model ---
    MODEL=$(get_field "model")
    if [[ -z "$MODEL" ]]; then
        v_pass "V-AG-08" "model 未設定（預設 inherit）"
    elif echo "$MODEL" | grep -qE "^(${VALID_MODELS})$"; then
        v_pass "V-AG-08" "model 合法: ${MODEL}"
    else
        v_fail "V-AG-08" "model 不合法: ${MODEL}"
    fi

    # --- V-AG-19: color ---
    COLOR=$(get_field "color")
    if [[ -z "$COLOR" ]]; then
        v_pass "V-AG-19" "color 未設定（選填）"
    elif echo "$COLOR" | grep -qE "^(${VALID_COLORS})$"; then
        v_pass "V-AG-19" "color 合法: ${COLOR}"
    else
        v_fail "V-AG-19" "color 不合法: ${COLOR}（合法值：red/blue/green/yellow/purple/orange/pink/cyan）"
    fi

    # --- V-AG-09: permissionMode ---
    PERM=$(get_field "permissionMode")
    if [[ -z "$PERM" ]]; then
        v_pass "V-AG-09" "permissionMode 未設定（預設 default）"
    elif echo "$PERM" | grep -qE "^(${VALID_PERM_MODES})$"; then
        v_pass "V-AG-09" "permissionMode 合法: ${PERM}"
    else
        v_fail "V-AG-09" "permissionMode 不合法: ${PERM}"
    fi

    # --- V-AG-10: maxTurns ---
    MT_TYPE=$(get_field_type "maxTurns")
    if [[ "$MT_TYPE" == "missing" ]]; then
        v_pass "V-AG-10" "maxTurns 未設定（無限制）"
    elif [[ "$MT_TYPE" == "int" ]]; then
        MT_VAL=$(get_field "maxTurns")
        if [[ "$MT_VAL" -gt 0 ]]; then
            v_pass "V-AG-10" "maxTurns 為正整數: ${MT_VAL}"
        else
            v_warn "V-AG-10" "maxTurns 應為正整數: ${MT_VAL}"
        fi
    else
        v_warn "V-AG-10" "maxTurns 應為整數，實際為: ${MT_TYPE}"
    fi

    # --- V-AG-11: memory ---
    MEM=$(get_field "memory")
    if [[ -z "$MEM" ]]; then
        v_pass "V-AG-11" "memory 未設定（選填）"
    elif echo "$MEM" | grep -qE "^(${VALID_MEMORY})$"; then
        v_pass "V-AG-11" "memory 合法: ${MEM}"
    else
        v_fail "V-AG-11" "memory 不合法: ${MEM}"
    fi

    # --- V-AG-12: skills 引用 ---
    SKILLS_TYPE=$(get_field_type "skills")
    if [[ "$SKILLS_TYPE" == "missing" ]]; then
        v_pass "V-AG-12" "skills 未設定"
    else
        v_warn "V-AG-12" "skills 引用存在（無法在此驗證是否存在）"
    fi

    # --- V-AG-13: mcpServers ---
    MCP_TYPE=$(get_field_type "mcpServers")
    if [[ "$MCP_TYPE" == "missing" ]]; then
        v_pass "V-AG-13" "mcpServers 未設定"
    else
        v_warn "V-AG-13" "mcpServers 引用存在（無法在此驗證）"
    fi

    # --- V-AG-14: hooks ---
    HOOKS_TYPE=$(get_field_type "hooks")
    if [[ "$HOOKS_TYPE" == "missing" ]]; then
        v_pass "V-AG-14" "hooks 未設定"
    elif [[ "$HOOKS_TYPE" == "dict" ]]; then
        v_pass "V-AG-14" "hooks 結構為物件"
    else
        v_fail "V-AG-14" "hooks 必須為物件類型: ${HOOKS_TYPE}"
    fi

    # --- V-AG-17: frontmatter 路徑不可硬編碼 ---
    HARDCODED_PATHS=$(echo "$FRONTMATTER" | grep -oE '"/[^ "]+\.sh"' 2>/dev/null | grep -v 'CLAUDE_PLUGIN_ROOT' || true)
    if [[ -z "$HARDCODED_PATHS" ]]; then
        v_pass "V-AG-17" "無硬編碼路徑"
    else
        while IFS= read -r path; do
            [[ -z "$path" ]] && continue
            v_fail "V-AG-17" "frontmatter 不可硬編碼路徑: ${path}，必須用 \${CLAUDE_PLUGIN_ROOT}"
        done <<< "$HARDCODED_PATHS"
    fi

    # --- V-AG-18: hooks 中引用的腳本存在 ---
    HOOK_REFS=$(echo "$FRONTMATTER" | grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^ "]*' 2>/dev/null || true)
    if [[ -n "$HOOK_REFS" ]]; then
        while IFS= read -r ref; do
            [[ -z "$ref" ]] && continue
            actual_path=$(echo "$ref" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${TARGET_PLUGIN_ROOT}|")
            if [[ -f "$actual_path" ]]; then
                if [[ -x "$actual_path" ]]; then
                    v_pass "V-AG-18" "腳本存在且可執行: ${ref}"
                else
                    v_fail "V-AG-18" "腳本缺少執行權限: ${ref}"
                fi
            else
                v_fail "V-AG-18" "引用的腳本不存在: ${ref}"
            fi
        done <<< "$HOOK_REFS"
    else
        v_pass "V-AG-18" "無腳本引用"
    fi

    # --- V-AG-15: 有系統提示內容 ---
    BODY_TRIMMED=$(echo "$BODY" | sed '/^$/d' | head -1)
    if [[ -n "$BODY_TRIMMED" ]]; then
        v_pass "V-AG-15" "有系統提示內容"
    else
        v_warn "V-AG-15" "Frontmatter 下方缺少系統提示"
    fi

    echo "" >&2
done

v_summary "Agent"
