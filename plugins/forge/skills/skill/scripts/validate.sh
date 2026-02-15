#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：validate.sh
# 用途：驗證 Skill 組件（V-SK-01 ~ V-SK-15）
# 呼叫方：/forge:skill 或 /forge:scaffold 組合呼叫
# 輸入：$1 = SKILL.md 路徑 或 skill 目錄路徑
# 輸出：stderr 驗證結果，exit code 0=通過 1=失敗
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${SCRIPT_DIR}/../../.."
source "${PLUGIN_ROOT}/scripts/lib/validate-common.sh"

# --- 解析輸入 ---
TARGET="${1:?用法: validate.sh <SKILL.md 路徑或 skill 目錄>}"

# 支援目錄或檔案路徑
if [[ -d "$TARGET" ]]; then
    SKILL_DIR="$TARGET"
    SKILL_FILE="${TARGET}/SKILL.md"
elif [[ -f "$TARGET" ]]; then
    SKILL_FILE="$TARGET"
    SKILL_DIR="$(dirname "$TARGET")"
else
    echo "錯誤：路徑不存在: $TARGET" >&2
    exit 1
fi

# 推導被驗證 skill 所屬 plugin 的根目錄（skills/{name}/SKILL.md → 往上 2 層）
TARGET_PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"

echo -e "${BOLD}驗證 Skill: ${SKILL_DIR}${NC}" >&2
echo "" >&2

# --- V-SK-01: SKILL.md 存在 ---
v_file_exists "V-SK-01" "$SKILL_FILE" "SKILL.md" || { v_summary "Skill"; exit 1; }

# --- 讀取檔案內容 ---
CONTENT=$(cat "$SKILL_FILE")

# --- 提取 frontmatter ---
if echo "$CONTENT" | head -1 | grep -q '^---'; then
    FRONTMATTER=$(echo "$CONTENT" | awk 'BEGIN{n=0} /^---$/{n++; next} n==1{print}')
    BODY=$(echo "$CONTENT" | awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}')
else
    FRONTMATTER=""
    BODY="$CONTENT"
fi

# --- V-SK-02: Frontmatter 為合法 YAML ---
if [[ -n "$FRONTMATTER" ]]; then
    if echo "$FRONTMATTER" | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" 2>/dev/null; then
        v_pass "V-SK-02" "Frontmatter 為合法 YAML"
    else
        v_fail "V-SK-02" "Frontmatter YAML 格式錯誤"
    fi
else
    v_fail "V-SK-02" "缺少 YAML frontmatter"
fi

# --- 輔助：從 frontmatter 提取欄位值 ---
get_field() {
    local field="$1"
    echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
val = data.get('$field', '')
if val is None: val = ''
print(val)
" 2>/dev/null || echo ""
}

get_field_type() {
    local field="$1"
    echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
val = data.get('$field')
if val is None:
    print('missing')
else:
    print(type(val).__name__)
" 2>/dev/null || echo "missing"
}

# --- V-SK-16: 檢查多餘欄位 ---
KNOWN_FIELDS="name description argument-hint allowed-tools hooks disable-model-invocation user-invocable model context agent"
EXTRA_FIELDS=$(echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
known = set('$KNOWN_FIELDS'.split())
extra = [k for k in data.keys() if k not in known]
for f in extra: print(f)
" 2>/dev/null || true)
if [[ -z "$EXTRA_FIELDS" ]]; then
    v_pass "V-SK-16" "無多餘欄位"
else
    while IFS= read -r field; do
        [[ -z "$field" ]] && continue
        v_fail "V-SK-16" "不支援的欄位: ${field}（可能是拼寫錯誤）"
    done <<< "$EXTRA_FIELDS"
fi

# --- V-SK-03: name 欄位 ---
NAME=$(get_field "name")
if [[ -n "$NAME" ]]; then
    if echo "$NAME" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' && [[ ${#NAME} -le 64 ]]; then
        v_pass "V-SK-03" "name 欄位合法: ${NAME}"
    else
        v_fail "V-SK-03" "name 必須為小寫字母、數字和連字號，最多 64 字元: ${NAME}"
    fi
else
    # name 非必要，可從目錄名稱衍生
    v_pass "V-SK-03" "name 欄位未設定（將從目錄名稱衍生）"
fi

# --- V-SK-04: description 欄位 ---
DESC=$(get_field "description")
if [[ -n "$DESC" ]]; then
    v_pass "V-SK-04" "description 欄位存在"
else
    v_warn "V-SK-04" "建議填寫 description 欄位"
fi

# --- V-SK-05: argument-hint 欄位 ---
HINT_TYPE=$(get_field_type "argument-hint")
if [[ "$HINT_TYPE" == "missing" ]]; then
    v_pass "V-SK-05" "argument-hint 未設定（選填）"
elif [[ "$HINT_TYPE" == "str" ]]; then
    v_pass "V-SK-05" "argument-hint 為合法字串"
else
    v_warn "V-SK-05" "argument-hint 應為字串類型，實際為: ${HINT_TYPE}"
fi

# --- V-SK-06: disable-model-invocation ---
DMI_TYPE=$(get_field_type "disable-model-invocation")
if [[ "$DMI_TYPE" == "missing" ]]; then
    v_pass "V-SK-06" "disable-model-invocation 未設定（預設 false）"
elif [[ "$DMI_TYPE" == "bool" ]]; then
    v_pass "V-SK-06" "disable-model-invocation 為布林值"
else
    v_fail "V-SK-06" "disable-model-invocation 必須為布林值，實際為: ${DMI_TYPE}"
fi

# --- V-SK-07: user-invocable ---
UI_TYPE=$(get_field_type "user-invocable")
if [[ "$UI_TYPE" == "missing" ]]; then
    v_pass "V-SK-07" "user-invocable 未設定（預設 true）"
elif [[ "$UI_TYPE" == "bool" ]]; then
    v_pass "V-SK-07" "user-invocable 為布林值"
else
    v_fail "V-SK-07" "user-invocable 必須為布林值，實際為: ${UI_TYPE}"
fi

# --- V-SK-08: allowed-tools ---
TOOLS=$(get_field "allowed-tools")
if [[ -n "$TOOLS" ]]; then
    VALID_TOOLS="Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch|Task|TaskCreate|TaskGet|TaskList|TaskUpdate|TaskOutput|NotebookEdit|AskUserQuestion|Skill|KillShell|MCPSearch|ExitPlanMode|LSP"
    ALL_VALID=true
    IFS=',' read -ra TOOL_ARRAY <<< "$TOOLS"
    for tool in "${TOOL_ARRAY[@]}"; do
        tool=$(echo "$tool" | xargs)  # trim
        tool_base=$(echo "$tool" | sed 's/(.*//')  # 去除模式語法
        if ! echo "$tool_base" | grep -qE "^(${VALID_TOOLS}|mcp__)" ; then
            v_fail "V-SK-08" "不合法的工具名稱: ${tool}"
            ALL_VALID=false
        fi
    done
    if $ALL_VALID; then
        v_pass "V-SK-08" "allowed-tools 中的工具名稱合法"
    fi
else
    v_pass "V-SK-08" "allowed-tools 未設定（繼承全部）"
fi

# --- V-SK-09: model ---
MODEL=$(get_field "model")
if [[ -z "$MODEL" ]]; then
    v_pass "V-SK-09" "model 未設定（使用當前模型）"
elif echo "$MODEL" | grep -qE '^(sonnet|opus|haiku)$'; then
    v_pass "V-SK-09" "model 合法: ${MODEL}"
else
    v_fail "V-SK-09" "model 必須為 sonnet、opus、haiku 之一: ${MODEL}"
fi

# --- V-SK-10: context ---
CTX=$(get_field "context")
if [[ -z "$CTX" ]]; then
    v_pass "V-SK-10" "context 未設定（inline 模式）"
elif [[ "$CTX" == "fork" ]]; then
    v_pass "V-SK-10" "context 為 fork"
else
    v_fail "V-SK-10" "context 必須為 fork 或未設定: ${CTX}"
fi

# --- V-SK-11: context: fork 時 agent 欄位 ---
if [[ "$CTX" == "fork" ]]; then
    AGENT=$(get_field "agent")
    if [[ -n "$AGENT" ]]; then
        v_pass "V-SK-11" "fork 模式下 agent 欄位存在: ${AGENT}"
    else
        v_warn "V-SK-11" "context: fork 時建議設定 agent 欄位"
    fi
else
    v_pass "V-SK-11" "非 fork 模式，跳過 agent 檢查"
fi

# --- V-SK-12: hooks 結構 ---
HOOKS_TYPE=$(get_field_type "hooks")
if [[ "$HOOKS_TYPE" == "missing" ]]; then
    v_pass "V-SK-12" "hooks 未設定（選填）"
elif [[ "$HOOKS_TYPE" == "dict" ]]; then
    # 檢查事件名稱合法性
    HOOK_EVENTS=$(echo "$FRONTMATTER" | python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin) or {}
hooks = data.get('hooks', {})
if isinstance(hooks, dict):
    for k in hooks: print(k)
" 2>/dev/null)
    VALID_EVENTS="PreToolUse|PostToolUse|Stop"
    ALL_VALID=true
    while IFS= read -r event; do
        [[ -z "$event" ]] && continue
        if ! echo "$event" | grep -qE "^(${VALID_EVENTS})$"; then
            v_fail "V-SK-12" "Skill hooks 不支援事件: ${event}（僅支援 PreToolUse/PostToolUse/Stop）"
            ALL_VALID=false
        fi
    done <<< "$HOOK_EVENTS"
    if $ALL_VALID; then
        v_pass "V-SK-12" "hooks 結構合法"
    fi
else
    v_fail "V-SK-12" "hooks 必須為物件類型，實際為: ${HOOKS_TYPE}"
fi

# --- V-SK-13: 動態內容命令（檢查 !`cmd` 語法） ---
DYNAMIC_CMDS=$(grep -oE '!\`[^`]+\`' "$SKILL_FILE" 2>/dev/null || true)
if [[ -z "$DYNAMIC_CMDS" ]]; then
    v_pass "V-SK-13" "無動態內容命令"
else
    while IFS= read -r cmd; do
        [[ -z "$cmd" ]] && continue
        # 提取命令（去除 !` 和 `）
        actual_cmd=$(echo "$cmd" | sed 's/^!\`//;s/\`$//')
        cmd_name=$(echo "$actual_cmd" | awk '{print $1}')
        if command -v "$cmd_name" &>/dev/null; then
            v_pass "V-SK-13" "動態命令可執行: ${cmd_name}"
        else
            v_warn "V-SK-13" "動態命令可能不可執行: ${actual_cmd}"
        fi
    done <<< "$DYNAMIC_CMDS"
fi

# --- V-SK-14: 引用的腳本存在且有執行權限 ---
SCRIPT_REFS=$(echo "$FRONTMATTER" | grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^ "]*' 2>/dev/null || true)
if [[ -z "$SCRIPT_REFS" ]]; then
    v_pass "V-SK-14" "無腳本引用"
else
    while IFS= read -r ref; do
        [[ -z "$ref" ]] && continue
        # 替換 ${CLAUDE_PLUGIN_ROOT} 為實際路徑
        actual_path=$(echo "$ref" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${TARGET_PLUGIN_ROOT}|")
        if [[ -f "$actual_path" ]]; then
            if [[ -x "$actual_path" ]]; then
                v_pass "V-SK-14" "腳本存在且可執行: ${ref}"
            else
                v_fail "V-SK-14" "腳本存在但缺少執行權限: ${ref}"
            fi
        else
            v_fail "V-SK-14" "引用的腳本不存在: ${ref}"
        fi
    done <<< "$SCRIPT_REFS"
fi

# --- V-SK-17: frontmatter 路徑不可硬編碼 ---
# 檢查 frontmatter 中是否有絕對路徑但沒用 ${CLAUDE_PLUGIN_ROOT}
FM_HARDCODED=$(echo "$FRONTMATTER" | grep -E '^[^#]*"/' 2>/dev/null | grep -v 'CLAUDE_PLUGIN_ROOT' || true)
if [[ -z "$FM_HARDCODED" ]]; then
    v_pass "V-SK-17" "frontmatter 無硬編碼路徑"
else
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        v_fail "V-SK-17" "frontmatter 不可硬編碼路徑，必須用 \${CLAUDE_PLUGIN_ROOT}: $(echo "$line" | xargs)"
    done <<< "$FM_HARDCODED"
fi

# --- V-SK-18: body 中 ${CLAUDE_PLUGIN_ROOT} 引用的檔案存在 ---
BODY_REFS=$(echo "$BODY" | python3 -c "
import sys, re
text = sys.stdin.read()
# 匹配 \${CLAUDE_PLUGIN_ROOT}/path/to/file
for m in re.finditer(r'\\\$\{CLAUDE_PLUGIN_ROOT\}/[^\s\x60\"\')\];,]+', text):
    print(m.group())
" 2>/dev/null || true)
if [[ -n "$BODY_REFS" ]]; then
    while IFS= read -r ref; do
        [[ -z "$ref" ]] && continue
        actual_path=$(echo "$ref" | sed "s|\\\${CLAUDE_PLUGIN_ROOT}|${TARGET_PLUGIN_ROOT}|")
        if [[ -e "$actual_path" ]]; then
            v_pass "V-SK-18" "引用路徑存在: ${ref}"
        else
            v_warn "V-SK-18" "引用路徑不存在: ${ref}"
        fi
    done <<< "$BODY_REFS"
else
    v_pass "V-SK-18" "body 中無 \${CLAUDE_PLUGIN_ROOT} 引用"
fi

# --- V-SK-15: 有實際指令內容 ---
BODY_TRIMMED=$(echo "$BODY" | sed '/^$/d' | head -1)
if [[ -n "$BODY_TRIMMED" ]]; then
    v_pass "V-SK-15" "有指令內容"
else
    v_warn "V-SK-15" "Frontmatter 下方缺少指令內容"
fi

# --- 摘要 ---
v_summary "Skill"
