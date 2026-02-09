# Script 組件規格書

## 概述

Script 是 Plugin 中的共用腳本，負責實作 Hooks 和 Skills 呼叫的實際邏輯。
遵循 DRY 原則，重複的功能提取為獨立腳本，被多個組件重用。

---

## 檔案結構

```
scripts/
├── post-edit-check.sh        # Hook 直接呼叫的「入口腳本」
├── pre-commit-check.sh
├── session-start.sh
├── lib/                      # 共用函式庫（被入口腳本 source）
│   ├── common.sh             # 通用工具函式
│   ├── lint.sh               # Lint 相關函式
│   ├── secrets.sh            # 敏感資訊偵測
│   └── json.sh               # JSON 處理輔助
└── validate-component.sh     # 組件驗證腳本
```

### 命名規則
- 入口腳本：kebab-case（如 `post-edit-check.sh`）
- 共用函式庫：放在 `scripts/lib/` 下

### 分類
1. **入口腳本**：Hook 或 Skill 直接呼叫的腳本
2. **共用函式庫**：被入口腳本 `source` 的共用邏輯
3. **工具腳本**：開發時使用的輔助腳本（如驗證）

---

## 標準腳本格式

### 入口腳本模板

```bash
#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：post-edit-check.sh
# 用途：PostToolUse hook — 檔案編輯後自動品質檢查
# 呼叫方：hooks.json → PostToolUse (Write|Edit)
# 輸入：stdin JSON（包含 tool_name, tool_input）
# 輸出：stdout JSON（feedback 回饋給 Claude）
# Exit codes：0=成功, 2=阻擋, 1=錯誤
# ============================================================

# --- 取得腳本所在目錄 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 載入共用函式庫 ---
source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/lint.sh"

# --- 讀取 stdin JSON ---
INPUT=$(cat)

# --- 解析輸入 ---
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# --- 主邏輯 ---
main() {
    # 檢查檔案是否存在
    if [[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]]; then
        output_json "skip" "無法取得檔案路徑"
        exit 0
    fi

    # 執行 lint
    local result
    result=$(lint_file "$FILE_PATH")

    if [[ $? -eq 0 ]]; then
        output_json "pass" "品質檢查通過"
    else
        output_feedback "warn" "品質檢查發現問題" "$result"
    fi
}

main
```

### 共用函式庫模板

```bash
#!/usr/bin/env bash
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

# 判斷是否為 CSS 檔案
is_css() {
    local ext
    ext=$(get_extension "$1")
    [[ "$ext" =~ ^(css|scss|less)$ ]]
}

# --- 工具檢查 ---

# 檢查命令是否可用
# 用法：require_cmd "eslint" || exit 0
require_cmd() {
    if ! command -v "$1" &>/dev/null; then
        return 1
    fi
}

# --- 日誌 ---

# 輸出到 stderr（不影響 stdout JSON）
log() {
    echo "[vibe] $*" >&2
}

log_warn() {
    echo "[vibe:warn] $*" >&2
}

log_error() {
    echo "[vibe:error] $*" >&2
}
```

---

## 輸入/輸出規範

### 輸入
所有 Hook 腳本從 **stdin** 接收 JSON：

```bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
```

### 輸出
Hook 腳本透過 **stdout** 回傳 JSON：

```bash
# 成功（不阻擋）
echo '{"result": "pass"}' && exit 0

# 阻擋（僅可阻擋事件）
echo '{"result": "block", "reason": "原因"}' && exit 2

# 帶回饋
echo '{"result": "warn", "feedback": "回饋內容"}' && exit 0
```

### 日誌
使用 **stderr** 輸出日誌（不影響 JSON 輸出）：

```bash
echo "[vibe] 檢查開始..." >&2
```

---

## 腳本撰寫規範

### 必要要素

| 項目 | 說明 |
|------|------|
| Shebang | `#!/usr/bin/env bash` |
| Strict mode | `set -euo pipefail` |
| 文件頭 | 腳本名稱、用途、呼叫方、輸入、輸出、exit codes |
| SCRIPT_DIR | 動態取得腳本目錄（避免硬編碼路徑） |
| 共用函式庫 | 重複邏輯透過 `source lib/xxx.sh` 引入 |

### 路徑處理
```bash
# ✅ 正確：使用 SCRIPT_DIR 或 CLAUDE_PLUGIN_ROOT
source "${SCRIPT_DIR}/lib/common.sh"
config="${CLAUDE_PLUGIN_ROOT}/config/rules.json"

# ❌ 錯誤：硬編碼路徑
source "/Users/sbu/projects/vibe/scripts/lib/common.sh"
```

### 錯誤處理
```bash
# 確保即使命令失敗也能輸出有用的 JSON
lint_file "$FILE_PATH" 2>/dev/null || {
    output_json "warn" "Lint 工具執行失敗（可能未安裝）"
    exit 0    # 不阻擋，只是提醒
}
```

### 安全規範
```bash
# ✅ 變數加引號
if [[ -f "$FILE_PATH" ]]; then

# ❌ 不安全
if [[ -f $FILE_PATH ]]; then

# ✅ 避免命令注入
jq -r '.tool_input.file_path' <<< "$INPUT"

# ❌ 危險：直接拼接使用者輸入
eval "lint $FILE_PATH"
```

---

## 依賴管理

### 外部工具依賴

腳本應該優雅地處理工具不存在的情況：

```bash
# 檢查 eslint 是否可用
if require_cmd "eslint"; then
    eslint_result=$(eslint "$FILE_PATH" --format json 2>/dev/null)
else
    log_warn "eslint 未安裝，跳過 JS/TS lint"
fi
```

### 常用外部依賴

| 工具 | 用途 | 安裝方式 |
|------|------|---------|
| `jq` | JSON 處理 | `brew install jq` |
| `eslint` | JS/TS lint | 專案內 `npx eslint` |
| `prettier` | 格式化 | 專案內 `npx prettier` |
| `tsc` | TypeScript check | 專案內 `npx tsc` |
| `ruff` | Python lint | `pip install ruff` |

### 專案內工具 vs 全域工具
```bash
# 優先使用專案內的工具，fallback 到全域
if [[ -f "${CWD}/node_modules/.bin/eslint" ]]; then
    ESLINT="${CWD}/node_modules/.bin/eslint"
elif require_cmd "eslint"; then
    ESLINT="eslint"
else
    log_warn "eslint 不可用"
    return 1
fi
```

---

## 驗證規則

Script 必須通過以下驗證：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-SC-01 | 檔案存在於 `scripts/` 下 | Error |
| V-SC-02 | 有執行權限（`chmod +x`） | Error |
| V-SC-03 | 有正確的 shebang（`#!/usr/bin/env bash`） | Error |
| V-SC-04 | 有 `set -euo pipefail` | Warning |
| V-SC-05 | 有文件頭註解 | Warning |
| V-SC-06 | 不包含硬編碼絕對路徑 | Error |
| V-SC-07 | 變數使用都有加引號 | Warning |
| V-SC-08 | 沒有使用 `eval` | Warning |
| V-SC-09 | source 的檔案存在 | Error |
| V-SC-10 | `bash -n` 語法檢查通過 | Error |

---

## 範例

### 完整入口腳本範例

```bash
#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：pre-commit-check.sh
# 用途：PreToolUse hook — Git commit 前品質檢查
# 呼叫方：hooks.json → PreToolUse (Bash)
# 輸入：stdin JSON（包含 tool_input.command）
# 輸出：stdout JSON（block 或 allow）
# Exit codes：0=允許, 2=阻擋
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/lint.sh"
source "${SCRIPT_DIR}/lib/secrets.sh"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

main() {
    # 只攔截 git commit 操作
    if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
        exit 0
    fi

    local errors=()

    # 1. 檢查 staged 檔案的 lint
    local staged_files
    staged_files=$(cd "$CWD" && git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)

    for file in $staged_files; do
        local full_path="${CWD}/${file}"
        if ! lint_file "$full_path" >/dev/null 2>&1; then
            errors+=("Lint 失敗: $file")
        fi
    done

    # 2. 檢查敏感資訊
    for file in $staged_files; do
        local full_path="${CWD}/${file}"
        local secret_result
        secret_result=$(check_secrets "$full_path" 2>/dev/null || true)
        if [[ -n "$secret_result" ]]; then
            errors+=("敏感資訊: $file — $secret_result")
        fi
    done

    # 3. 輸出結果
    if [[ ${#errors[@]} -gt 0 ]]; then
        local reason
        reason=$(printf '%s\n' "${errors[@]}")
        output_block "Commit 被阻擋：\n${reason}\n\n請修正後再嘗試 commit。"
    fi

    exit 0
}

main
```
