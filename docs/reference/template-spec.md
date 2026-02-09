# Template 組件規格書

## 概述

Template 分為兩類：
1. **組件模板**（Component Templates）— 建立新的 Skill/Agent/Hook/Script 時使用的標準格式
2. **專案模板**（Project Templates）— `/vibe:init` 用來初始化新專案的模板

組件模板是底層基礎，確保每次新建組件都有一致的格式，減少錯誤。

---

## 檔案結構

```
templates/
├── components/              # 組件模板
│   ├── skill.md             # Skill SKILL.md 的模板
│   ├── agent.md             # Agent .md 的模板
│   ├── hook-entry.json      # Hook 條目的模板
│   ├── script-entry.sh      # 入口腳本的模板
│   └── script-lib.sh        # 共用函式庫的模板
└── projects/                # 專案模板（Phase 4 再實作）
    ├── nextjs/
    ├── express-api/
    └── fullstack/
```

---

## 組件模板

### Skill 模板 — `templates/components/skill.md`

```yaml
---
name: {{SKILL_NAME}}
description: >-
  {{SKILL_DESCRIPTION}}
argument-hint: "{{ARGUMENT_HINT}}"
allowed-tools: {{ALLOWED_TOOLS}}
---

## 你的角色
{{ROLE_DESCRIPTION}}

## 規則
1. {{RULE_1}}
2. {{RULE_2}}

## 步驟
1. {{STEP_1}}
2. {{STEP_2}}

## 使用者要求
$ARGUMENTS
```

#### 佔位符說明

| 佔位符 | 說明 | 範例 |
|--------|------|------|
| `{{SKILL_NAME}}` | Skill 名稱（kebab-case） | `git-flow` |
| `{{SKILL_DESCRIPTION}}` | 功能描述 | `Git 工作流自動化` |
| `{{ARGUMENT_HINT}}` | 參數提示 | `[commit\|branch\|pr]` |
| `{{ALLOWED_TOOLS}}` | 允許的工具清單 | `Read, Write, Bash` |
| `{{ROLE_DESCRIPTION}}` | 角色定義 | `你是 Git 工作流助手` |
| `{{RULE_N}}` | 規則項目 | 根據功能填寫 |
| `{{STEP_N}}` | 執行步驟 | 根據功能填寫 |

---

### Agent 模板 — `templates/components/agent.md`

```yaml
---
name: {{AGENT_NAME}}
description: >-
  {{AGENT_DESCRIPTION}}
tools: {{TOOLS}}
model: {{MODEL}}
maxTurns: {{MAX_TURNS}}
memory: {{MEMORY_SCOPE}}
---

## 你的角色
{{ROLE_DESCRIPTION}}

## 能力範圍
- {{CAPABILITY_1}}
- {{CAPABILITY_2}}

## 工作流程
1. {{WORKFLOW_STEP_1}}
2. {{WORKFLOW_STEP_2}}

## 輸出規範
{{OUTPUT_FORMAT}}
```

#### 佔位符說明

| 佔位符 | 說明 | 預設值 |
|--------|------|--------|
| `{{AGENT_NAME}}` | Agent 名稱 | — |
| `{{AGENT_DESCRIPTION}}` | 功能描述 | — |
| `{{TOOLS}}` | 工具清單 | `Read, Grep, Glob` |
| `{{MODEL}}` | 模型 | `sonnet` |
| `{{MAX_TURNS}}` | 最大輪數 | `30` |
| `{{MEMORY_SCOPE}}` | 記憶範圍 | `project` |

---

### Hook 條目模板 — `templates/components/hook-entry.json`

```json
{
  "matcher": "{{MATCHER_PATTERN}}",
  "hooks": [
    {
      "type": "{{HOOK_TYPE}}",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/{{SCRIPT_NAME}}",
      "timeout": {{TIMEOUT}}
    }
  ]
}
```

#### 佔位符說明

| 佔位符 | 說明 | 範例 |
|--------|------|------|
| `{{MATCHER_PATTERN}}` | 匹配模式 | `Write\|Edit` |
| `{{HOOK_TYPE}}` | Hook 類型 | `command` |
| `{{SCRIPT_NAME}}` | 腳本檔名 | `post-edit-check.sh` |
| `{{TIMEOUT}}` | 超時秒數 | `15` |

---

### 入口腳本模板 — `templates/components/script-entry.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：{{SCRIPT_NAME}}
# 用途：{{SCRIPT_PURPOSE}}
# 呼叫方：{{CALLER}}
# 輸入：stdin JSON（{{INPUT_DESCRIPTION}}）
# 輸出：stdout JSON（{{OUTPUT_DESCRIPTION}}）
# Exit codes：0={{EXIT_0_MEANING}}, 2={{EXIT_2_MEANING}}
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

INPUT=$(cat)

main() {
    # {{MAIN_LOGIC_DESCRIPTION}}

    # TODO: 實作主邏輯
    output_json "pass" "{{DEFAULT_MESSAGE}}"
}

main
```

---

### 共用函式庫模板 — `templates/components/script-lib.sh`

```bash
#!/usr/bin/env bash
# ============================================================
# 共用函式庫：{{LIB_NAME}}.sh
# 用途：{{LIB_PURPOSE}}
# 使用方式：source "${SCRIPT_DIR}/lib/{{LIB_NAME}}.sh"
# ============================================================

# --- {{SECTION_NAME}} ---

# {{FUNCTION_DESCRIPTION}}
# 用法：{{FUNCTION_USAGE}}
# 參數：$1 = {{PARAM_1}}
# 回傳：{{RETURN_VALUE}}
{{FUNCTION_NAME}}() {
    local param="$1"
    # TODO: 實作
}
```

---

## 模板使用流程

### 建立新 Skill
```
1. 複製 templates/components/skill.md
2. 替換所有 {{}} 佔位符
3. 存放到 skills/<name>/SKILL.md
4. 執行 scripts/validate-component.sh skill skills/<name>/SKILL.md
5. 確認驗證通過
```

### 建立新 Agent
```
1. 複製 templates/components/agent.md
2. 替換所有 {{}} 佔位符
3. 存放到 agents/<name>.md
4. 執行 scripts/validate-component.sh agent agents/<name>.md
5. 確認驗證通過
```

### 建立新 Hook
```
1. 複製 templates/components/hook-entry.json
2. 替換佔位符
3. 將條目加入 hooks/hooks.json 的對應 event 陣列
4. 建立對應的腳本（從 script-entry.sh 模板開始）
5. chmod +x 腳本
6. 執行 scripts/validate-component.sh hook hooks/hooks.json
7. 確認驗證通過
```

### 建立新 Script
```
1. 複製 templates/components/script-entry.sh 或 script-lib.sh
2. 替換佔位符
3. 存放到 scripts/ 或 scripts/lib/
4. chmod +x
5. 執行 scripts/validate-component.sh script scripts/<name>.sh
6. 確認驗證通過
```

---

## 佔位符規範

| 規範 | 說明 |
|------|------|
| 格式 | `{{UPPER_SNAKE_CASE}}` |
| 必填 | 所有佔位符都必須被替換 |
| 驗證 | 完成替換後不應有殘留的 `{{}}` |
| 選用區塊 | 不需要的部分可以刪除（如不需要的規則或步驟） |

---

## 驗證規則

Template 本身的驗證：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-TM-01 | 模板檔案存在於 `templates/components/` 下 | Error |
| V-TM-02 | 所有佔位符使用 `{{UPPER_SNAKE_CASE}}` 格式 | Warning |
| V-TM-03 | .sh 模板有 shebang 和 strict mode | Error |
| V-TM-04 | .json 模板為合法 JSON（忽略佔位符） | Warning |
| V-TM-05 | .md 模板有 YAML frontmatter 區塊 | Warning |

從模板建立的組件驗證：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-TM-06 | 無殘留 `{{}}` 佔位符 | Error |
| V-TM-07 | 通過對應的組件驗證（V-SK/V-AG/V-HK/V-SC） | Error |
