# Hook 組件規格書

## 概述

Hook 是 Claude Code 的事件驅動自動化機制。當特定事件發生時，Hook 自動觸發並執行預定義的動作。
系統共有 **14 個事件**與 **3 種 hook 類型**（command / prompt / agent）。

---

## 一、事件完整清單（14 個）

### 可阻擋事件（exit code 2 可阻擋）

| Event | 觸發時機 | Matcher 對象 | exit 2 效果 |
|-------|---------|-------------|------------|
| `PreToolUse` | 工具呼叫執行前 | 工具名稱 | 阻擋工具呼叫 |
| `PermissionRequest` | 權限對話框即將顯示 | 工具名稱 | 拒絕權限 |
| `UserPromptSubmit` | 使用者提交 prompt 後、Claude 處理前 | 不支援 matcher | 阻擋並清除 prompt |
| `Stop` | 主代理完成回應時（使用者中斷不觸發） | 不支援 matcher | 阻止 Claude 停止 |
| `SubagentStop` | 子代理完成回應時 | agent type 名稱 | 阻止子代理停止 |
| `TeammateIdle` | Agent Team 隊友即將閒置 | 不支援 matcher | 阻止隊友閒置（僅 exit code，不支援 prompt/agent hook） |
| `TaskCompleted` | 任務標記完成時 | 不支援 matcher | 阻止任務完成（僅 exit code） |

### 不可阻擋事件

| Event | 觸發時機 | Matcher 對象 |
|-------|---------|-------------|
| `SessionStart` | session 開始或恢復 | `startup` / `resume` / `clear` / `compact` |
| `PostToolUse` | 工具成功完成後 | 工具名稱 |
| `PostToolUseFailure` | 工具執行失敗後 | 工具名稱 |
| `SubagentStart` | 子代理啟動時 | agent type 名稱 |
| `Notification` | 系統通知時 | `permission_prompt` / `idle_prompt` / `auth_success` / `elicitation_dialog` |
| `PreCompact` | 上下文壓縮前 | `manual` / `auto` |
| `SessionEnd` | session 結束時 | `clear` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other` |

---

## 二、每個事件的詳細規格

### SessionStart

**觸發時機**：session 開始或恢復時。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `source` | string | 觸發來源（`startup` / `resume` / `clear` / `compact`） |
| `model` | string | 目前使用的模型 |
| `agent_type` | string（選填） | 代理類型 |

**專有輸出**：
- stdout 純文字 → 加入 Claude 上下文
- JSON `hookSpecificOutput.additionalContext` → 加入上下文

**特殊**：可存取 `$CLAUDE_ENV_FILE` 環境變數，寫入 `export` 語句以持久化環境變數。

```bash
#!/bin/bash
# 範例：在 SessionStart hook 中持久化環境變數
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export MY_VAR=value' >> "$CLAUDE_ENV_FILE"
fi
```

---

### UserPromptSubmit

**觸發時機**：使用者提交 prompt 後、Claude 開始處理前。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `prompt` | string | 使用者提交的 prompt 內容 |

**注入上下文的兩種方式**（exit code 0）：

1. **純文本 stdout**（更簡單）：非 JSON 的純文字直接加入上下文
2. **JSON `additionalContext`**（結構化）：使用下方 JSON 格式

兩種方式都會注入 Claude 上下文。純 stdout 在 transcript 中顯示為 hook 輸出；`additionalContext` 更隱蔽。

**專有輸出**（`hookSpecificOutput`）：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `decision` | string | `"block"` → 阻擋並清除 prompt（搭配 exit 0 + JSON 使用） |
| `reason` | string | 阻擋時顯示給使用者的原因（不加入上下文） |
| `additionalContext` | string | 加入 Claude 上下文 |

---

### PreToolUse（最重要的事件）

**觸發時機**：工具呼叫執行前。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `tool_name` | string | 工具名稱 |
| `tool_input` | object | 工具輸入參數（結構因工具而異，見下方） |
| `tool_use_id` | string | 工具呼叫唯一識別碼 |

**各工具的 `tool_input` 結構**：

| 工具 | tool_input 欄位 |
|------|----------------|
| `Bash` | `command`, `description`, `timeout`, `run_in_background` |
| `Write` | `file_path`, `content` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `Read` | `file_path`, `offset`, `limit` |
| `Glob` | `pattern`, `path` |
| `Grep` | `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline` |
| `WebFetch` | `url`, `prompt` |
| `WebSearch` | `query`, `allowed_domains`, `blocked_domains` |
| `Task` | `prompt`, `description`, `subagent_type`, `model` |

**決策控制**（透過 `hookSpecificOutput`，非 top-level）：

| 欄位 | 值 | 說明 |
|------|-----|------|
| `permissionDecision` | `"allow"` | 繞過權限直接允許 |
| `permissionDecision` | `"deny"` | 阻擋工具呼叫 |
| `permissionDecision` | `"ask"` | 提示使用者確認 |
| `permissionDecisionReason` | string | `allow`/`ask` 時顯示給使用者；`deny` 時顯示給 Claude |
| `updatedInput` | object | 修改工具輸入（搭配 `allow` 或 `ask`） |
| `additionalContext` | string | 加入 Claude 上下文 |

> **注意**：舊的 top-level `decision`（`"approve"` / `"block"`）已棄用，請使用 `hookSpecificOutput` 中的 `permissionDecision`。

---

### PermissionRequest

**觸發時機**：權限對話框即將顯示時。

**限制**：非互動模式（`-p`）不觸發此事件。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `tool_name` | string | 工具名稱 |
| `tool_input` | object | 工具輸入參數 |
| `permission_suggestions` | array | 權限建議清單 |

> **注意**：此事件的輸入**無** `tool_use_id`。

**決策控制**（`hookSpecificOutput.decision`）：

| 欄位 | 說明 |
|------|------|
| `behavior` | `"allow"` 或 `"deny"` |
| `updatedInput` | 修改工具輸入（僅 `allow` 時有效） |
| `updatedPermissions` | 更新權限設定（僅 `allow` 時有效） |
| `message` | 拒絕訊息（僅 `deny` 時有效） |
| `interrupt` | boolean，是否中斷（僅 `deny` 時有效） |

---

### PostToolUse

**觸發時機**：工具成功完成後。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `tool_name` | string | 工具名稱 |
| `tool_input` | object | 工具輸入參數 |
| `tool_response` | object | 工具回傳結果 |
| `tool_use_id` | string | 工具呼叫唯一識別碼 |

**專有輸出**（top-level）：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `decision` | string | `"block"` → `reason` 回饋給 Claude |
| `reason` | string | 阻擋原因 |
| `additionalContext` | string | 加入 Claude 上下文 |
| `updatedMCPToolOutput` | any | 更新 MCP 工具輸出（僅 MCP 工具適用） |

---

### PostToolUseFailure

**觸發時機**：工具執行失敗後。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `tool_name` | string | 工具名稱 |
| `tool_input` | object | 工具輸入參數 |
| `tool_use_id` | string | 工具呼叫唯一識別碼 |
| `error` | string | 錯誤訊息 |
| `is_interrupt` | boolean（選填） | 是否為中斷導致 |

**專有輸出**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `additionalContext` | string | 加入 Claude 上下文 |

---

### Notification

**觸發時機**：系統通知時。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `message` | string | 通知訊息內容 |
| `title` | string（選填） | 通知標題 |
| `notification_type` | string | 通知類型（`permission_prompt` / `idle_prompt` / `auth_success` / `elicitation_dialog`） |

**限制**：不能阻擋或修改通知。

---

### SubagentStart

**觸發時機**：子代理啟動時。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `agent_id` | string | 子代理唯一識別碼 |
| `agent_type` | string | 子代理類型 |

**限制**：不能阻擋。`additionalContext` 會注入子代理上下文。

---

### SubagentStop

**觸發時機**：子代理完成回應時。

> **注意**：Agent frontmatter 中的 `Stop` hook 會自動轉換為此事件（見第十節「Stop → SubagentStop 自動轉換」）。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `stop_hook_active` | boolean | 是否為 stop hook 觸發後的再次評估 |
| `agent_id` | string | 子代理唯一識別碼 |
| `agent_type` | string | 子代理類型 |
| `agent_transcript_path` | string | 子代理 transcript 路徑 |

**決策控制**：與 `Stop` 相同格式（top-level `decision: "block"`）。

---

### Stop

**觸發時機**：主代理完成回應時。使用者中斷不觸發。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `stop_hook_active` | boolean | 是否為 stop hook 觸發後的再次評估 |

**決策控制**（top-level）：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `decision` | string | `"block"` → 阻止 Claude 停止 |
| `reason` | string | **必填**，阻擋原因 |

**防止無限迴圈**：必須檢查 `stop_hook_active`，當值為 `true` 時應 exit 0 讓 Claude 正常停止。

```bash
#!/bin/bash
INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

# 防止無限迴圈：若已被 stop hook 觸發過，直接放行
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# 正常邏輯...
```

---

### TeammateIdle

**觸發時機**：Agent Team 隊友完成工作並停止時，自動通知主管（Team Lead）。

> **Agent Teams** 是實驗性功能（需設定 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）。多個 Claude Code 實例組成團隊，隊友獨立工作並可直接互相通訊。與 Subagents 不同，Agent Teams 中的隊友是完全獨立的 Claude 實例。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `teammate_name` | string | 隊友名稱 |
| `team_name` | string | 團隊名稱 |

**限制**：
- 僅支援 exit code 決策，不支援 JSON 決策
- **不支援 prompt / agent hook**
- exit 2 時 stderr 作為回饋

---

### TaskCompleted

**觸發時機**：Agent Team 共享任務清單中的任務被標記完成時。任務具有 pending → in-progress → completed 三種狀態，支援依賴關係（依賴未完成的任務不能被認領）。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `task_id` | string | 任務識別碼 |
| `task_subject` | string | 任務主題 |
| `task_description` | string（可能缺失） | 任務描述 |
| `teammate_name` | string（可能缺失） | 執行隊友名稱 |
| `team_name` | string（可能缺失） | 團隊名稱 |

**限制**：僅支援 exit code 決策（exit 2 + stderr）。

---

### PreCompact

**觸發時機**：上下文壓縮前。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `trigger` | string | `"manual"` 或 `"auto"` |
| `custom_instructions` | string | 手動觸發時有值 |

**限制**：無法阻擋。

---

### SessionEnd

**觸發時機**：session 結束時。

**專有輸入欄位**：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `reason` | string | 結束原因（`clear` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`） |

**限制**：無法阻擋。

---

## 三、三種 Hook 類型

### 1. Command Hook（`type: "command"`）

執行 shell 命令，最靈活也最常用。

```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh",
  "timeout": 30,
  "statusMessage": "正在檢查...",
  "async": false,
  "once": false
}
```

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"command"` |
| `command` | string | 是 | 要執行的 shell 命令 |
| `timeout` | number | 否 | 超時秒數，預設 **60 秒** |
| `statusMessage` | string | 否 | 自訂 spinner 訊息 |
| `once` | boolean | 否 | `true` = 每 session 只執行一次（僅 Skills 和 Slash Commands） |
| `async` | boolean | 否 | `true` = 背景執行，不阻擋流程 |

**輸入**：JSON 透過 stdin 傳入。
**輸出**：JSON 透過 stdout 回傳 + exit code。

**Exit Code 語義**：

| Exit Code | 意義 | 行為 |
|-----------|------|------|
| `0` | 成功 | 解析 stdout JSON。stdout 在 verbose mode (ctrl+o) 顯示，但 `UserPromptSubmit` 和 `SessionStart` 會注入 Claude 上下文 |
| `2` | 阻擋 | 阻擋動作。**僅使用 stderr**（stdout 中的 JSON 被忽略），僅可阻擋事件有效 |
| 其他 | 錯誤 | 非阻擋錯誤。stderr 在 verbose mode 顯示為 `Failed with non-blocking status code: {stderr}`，繼續執行 |

**Exit Code 2 各事件行為**：

| 事件 | 行為 |
|------|------|
| `PreToolUse` | 阻擋工具呼叫，向 Claude 顯示 stderr |
| `PermissionRequest` | 拒絕權限，向 Claude 顯示 stderr |
| `PostToolUse` | 向 Claude 顯示 stderr（工具已執行） |
| `UserPromptSubmit` | 阻擋並清除 prompt，僅向使用者顯示 stderr |
| `Stop` / `SubagentStop` | 阻止停止，向 Claude 顯示 stderr |
| `Notification` / `PreCompact` / `SessionStart` / `SessionEnd` | 僅向使用者顯示 stderr，無法阻擋 |

**Async 限制**：
- 僅 command hook 支援 `async`
- 無法阻擋或回傳決策
- 輸出在下一個對話回合傳遞
- 多次觸發不去重複

---

### 2. Prompt Hook（`type: "prompt"`）

將 hook 輸入和自訂 prompt 送給快速 LLM（Haiku）做單輪評估。適用於所有 hook 事件，特別適合需要上下文感知判斷的場景。

```json
{
  "type": "prompt",
  "prompt": "評估以下操作是否安全：$ARGUMENTS",
  "model": "haiku",
  "timeout": 30,
  "statusMessage": "正在評估安全性...",
  "once": false
}
```

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"prompt"` |
| `prompt` | string | 是 | 送給模型的提示文字。使用 `$ARGUMENTS` 作為 hook 輸入 JSON 的佔位符；若無 `$ARGUMENTS`，輸入 JSON 會附加到 prompt |
| `model` | string | 否 | 模型名稱，預設快速模型（Haiku） |
| `timeout` | number | 否 | 超時秒數，預設 **30 秒** |
| `statusMessage` | string | 否 | 自訂 spinner 訊息 |
| `once` | boolean | 否 | `true` = 每 session 只執行一次（僅 Skills 和 Slash Commands） |

**回應格式**：
```json
{ "ok": true }                              // 允許
{ "ok": false, "reason": "原因說明" }       // 阻擋（僅可阻擋事件有效）
```

**最佳適用場景**：`Stop`、`SubagentStop`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`。

**不支援事件**：`TeammateIdle`。

---

### 3. Agent Hook（`type: "agent"`）

生成有工具存取權的子代理，可多輪調查後做決策。

```json
{
  "type": "agent",
  "prompt": "檢查所有測試是否通過：$ARGUMENTS",
  "model": "haiku",
  "timeout": 120,
  "statusMessage": "代理正在檢查...",
  "once": false
}
```

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"agent"` |
| `prompt` | string | 是 | Agent 的任務提示，`$ARGUMENTS` 替換為 hook 輸入 JSON |
| `model` | string | 否 | 模型名稱，預設快速模型 |
| `timeout` | number | 否 | 超時秒數，預設 **60 秒** |
| `statusMessage` | string | 否 | 自訂 spinner 訊息 |
| `once` | boolean | 否 | `true` = 每 session 只執行一次（僅 Skills 和 Slash Commands） |

**Agent 可用工具**：`Read`, `Grep`, `Glob`（唯讀）
**最大輪數**：50
**回應格式**：與 prompt hook 相同。

**不支援事件**：`TeammateIdle`。

---

## 四、通用輸入欄位

所有事件的 hook 都會收到以下基本輸入欄位：

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.json",
  "cwd": "/Users/sbu/projects/my-app",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `session_id` | string | 目前 session 的唯一識別碼 |
| `transcript_path` | string | Transcript 檔案路徑 |
| `cwd` | string | 目前工作目錄 |
| `permission_mode` | string | 權限模式 |
| `hook_event_name` | string | 觸發的事件名稱 |

---

## 五、通用輸出欄位

以下欄位可在任何 hook 的 JSON 輸出（stdout，exit code 0）中使用：

| 欄位 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `continue` | boolean | `true` | `false` = 停止 Claude 所有處理。**優先順序高於** `decision: "block"` |
| `stopReason` | string | — | `continue` 為 `false` 時的停止原因（顯示給使用者，不顯示給 Claude） |
| `suppressOutput` | boolean | `false` | `true` = 隱藏 verbose mode (ctrl+o) 輸出 |
| `systemMessage` | string | — | 顯示給使用者的警告訊息 |

### `continue: false` vs `decision: "block"` 的差別

| 欄位 | 行為 | 適用對象 |
|------|------|----------|
| `continue: false` | **完全停止** Claude 所有處理 | 所有事件 |
| `decision: "block"` | 阻擋特定動作並回饋給 Claude 繼續 | PreToolUse / PostToolUse / Stop / SubagentStop |

`continue: false` 在所有情況下**優先於** `decision: "block"`。

---

## 六、決策控制模式總覽表

| 事件 | 決策模式 | 可用欄位 |
|------|---------|---------|
| `UserPromptSubmit` | Top-level decision | `decision: "block"`, `reason` |
| `PostToolUse` | Top-level decision | `decision: "block"`, `reason`, `updatedMCPToolOutput` |
| `PostToolUseFailure` | Top-level decision | `decision: "block"`, `reason` |
| `Stop` | Top-level decision | `decision: "block"`, `reason`（必填） |
| `SubagentStop` | Top-level decision | `decision: "block"`, `reason` |
| `PreToolUse` | hookSpecificOutput | `permissionDecision`（allow/deny/ask）, `updatedInput` |
| `PermissionRequest` | hookSpecificOutput | `decision.behavior`（allow/deny）, `updatedInput`, `updatedPermissions` |
| `TeammateIdle` | Exit code only | exit 2 + stderr |
| `TaskCompleted` | Exit code only | exit 2 + stderr |
| `SessionStart` | Context injection | `additionalContext` |
| `Notification` | Context injection | `additionalContext` |
| `SubagentStart` | Context injection | `additionalContext` |
| `PreCompact` | 無決策 | — |
| `SessionEnd` | 無決策 | — |

---

## 七、hooks.json Schema

```json
{
  "description": "選填（僅 plugin hooks）",
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<regex 或 expression>",
        "description": "此 hook group 的用途說明（選填）",
        "hooks": [
          {
            "type": "command|prompt|agent",
            "command": "...",
            "prompt": "...",
            "model": "...",
            "timeout": 600,
            "statusMessage": "...",
            "async": false,
            "once": false
          }
        ]
      }
    ]
  }
}
```

### Hook Group 欄位

| 欄位 | 必要 | 說明 |
|------|------|------|
| `matcher` | 視事件 | 匹配條件（正則或 expression 語法，見第八節） |
| `description` | 否 | 此 hook group 的用途說明，純文檔化用途 |
| `hooks` | 是 | 此 group 下的 hook 陣列 |

### 結構層級說明

```
hooks.json
└── hooks                           # 根物件
    └── <EventName>                  # 事件名稱（區分大小寫）
        └── [array of hook groups]   # 每個 group 有 matcher + hooks
            ├── matcher              # 匹配條件（選用，視 event 而定）
            ├── description          # 用途說明（選用，文檔化）
            └── hooks                # 此 group 下的 hook 清單
                └── [hook]           # 單個 hook（command/prompt/agent）
```

---

## 八、Matcher 語法

Matcher 支援兩種語法：**正則表達式**（基礎）和 **Expression 語法**（進階）。

### 8.1 正則表達式語法（基礎）

匹配工具名稱或事件來源，大小寫敏感。

| 範例 | 說明 |
|------|------|
| `"Bash"` | 精確匹配 Bash 工具 |
| `"Edit\|Write"` | OR 匹配 Edit 或 Write |
| `"mcp__.*"` | 正則匹配所有 MCP 工具 |
| `"*"` / `""` / 省略 | 匹配所有 |

**MCP 工具命名格式**：`mcp__<server>__<tool>`

### 8.2 Expression 語法（進階）

支援條件式匹配工具輸入參數，可組合多個條件。

| 語法 | 說明 | 範例 |
|------|------|------|
| `tool == "Name"` | 工具名稱精確匹配 | `tool == "Bash"` |
| `tool_input.field matches "regex"` | 工具輸入欄位正則匹配 | `tool_input.command matches "(npm run dev\|pnpm dev)"` |
| `&&` | 邏輯 AND | `tool == "Bash" && tool_input.command matches "rm"` |
| `\|\|` | 邏輯 OR | `tool == "Edit" \|\| tool == "Write"` |
| `!(...)` | 否定 | `!(tool_input.file_path matches "README\\.md")` |

#### Expression 語法範例

```json
// 攔截特定 Bash 命令
"matcher": "tool == \"Bash\" && tool_input.command matches \"(npm run dev|pnpm dev|yarn dev)\""

// 匹配特定副檔名的 Write 操作
"matcher": "tool == \"Write\" && tool_input.file_path matches \"\\.(ts|tsx)$\""

// 排除特定檔案
"matcher": "tool == \"Edit\" && !(tool_input.file_path matches \"README\\.md\")"

// 組合條件
"matcher": "tool == \"Write\" && tool_input.file_path matches \"\\.(md|txt)$\" && !(tool_input.file_path matches \"CHANGELOG\")"
```

#### 可用的 `tool_input` 欄位

Expression 中可引用的 `tool_input` 欄位取決於工具類型（見第二節各工具的 `tool_input` 結構）。

### 8.3 各事件的 Matcher 對象

| 事件 | Matcher 匹配對象 | 範例 |
|------|----------------|------|
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | 工具名稱（支援 expression） | `"Write"`, `tool == "Bash" && ...` |
| `PermissionRequest` | 工具名稱 | `"Write\|Edit"` |
| `SessionStart` | 來源類型 | `"startup"`, `"resume"`, `"startup\|resume"` |
| `PreCompact` | 觸發類型 | `"manual"`, `"auto"` |
| `SubagentStart` / `SubagentStop` | agent type 名稱 | — |
| `Notification` | 通知類型 | `"permission_prompt"` |
| `SessionEnd` | 結束原因 | `"clear"`, `"logout"` |
| `UserPromptSubmit` / `Stop` / `TeammateIdle` / `TaskCompleted` | 不支援 matcher | 省略即可 |

---

## 九、環境變數

| 環境變數 | 說明 | 適用範圍 |
|---------|------|---------|
| `$CLAUDE_PROJECT_DIR` | 專案根目錄 | 所有 hook |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin 根目錄 | Plugin hook |
| `$CLAUDE_ENV_FILE` | 持久化環境變數檔案路徑 | 僅 `SessionStart` |
| `$CLAUDE_CODE_REMOTE` | 遠端（Web）環境時為 `"true"`，本機 CLI 環境未設定或空 | 所有 hook |

---

## 十、Hook 位置與範圍

| 位置 | 範圍 | 說明 |
|------|------|------|
| `~/.claude/settings.json` | 所有專案 | 全域使用者設定 |
| `.claude/settings.json` | 單一專案 | 可 commit 到版本控制 |
| `.claude/settings.local.json` | 單一專案 | 應加入 gitignore |
| Managed policy | 組織全域 | 由組織管理 |
| Plugin `hooks/hooks.json` | Plugin 啟用時 | 隨 plugin 啟用/停用 |
| Skill / Agent frontmatter | 元件活躍時 | 隨元件生命週期，**僅支援 PreToolUse、PostToolUse、Stop** |

### Frontmatter 支援的事件

Skills、Agents 和 Slash Commands 的 frontmatter 中只能使用以下 3 個事件：

| 事件 | 說明 |
|------|------|
| `PreToolUse` | 工具呼叫前攔截 |
| `PostToolUse` | 工具完成後檢查 |
| `Stop` | 元件完成時評估（agent 中自動轉換為 SubagentStop） |

> **注意**：其他事件（SessionStart、SessionEnd、Notification 等）只能在 `hooks.json` 或 `settings.json` 中定義。

### Stop → SubagentStop 自動轉換

Agent frontmatter 中定義的 `Stop` hook 會在運行時**自動轉換為 `SubagentStop`** 事件。這是因為子代理完成時觸發的事件是 `SubagentStop`，而非 `Stop`（`Stop` 僅對主代理觸發）。

因此在 agent `.md` 檔案中：

```yaml
---
hooks:
  Stop:
    - hooks:
        - type: command
          command: "./scripts/check.sh"
---
```

等同於在 `hooks.json` 中定義 `SubagentStop` 事件。此轉換對 Skill frontmatter **不適用**（Skill 中的 Stop 就是 Stop）。

---

## 十一、快照機制

- Claude Code 在**啟動時**擷取 hooks 的快照
- Session 中途對外部 hooks 的修改**不會立即生效**
- 修改會警告使用者，需在 `/hooks` 選單中審查
- 透過 `/hooks` 新增的 hook **立即生效**

---

## 十二、限制與安全

### 執行行為

- Hook 以系統使用者完整權限執行（可存取使用者所有檔案和認證）
- **預設 timeout**：60 秒（command）、30 秒（prompt）、60 秒（agent），每個 hook 可獨立配置
- **個別超時不影響其他 hook**
- 匹配的 hooks **平行執行**，自動去重複
- `async` 僅 command hook 支援
- `Stop` 不在使用者中斷時觸發
- Shell profile 中的 `echo` 會干擾 JSON 解析

### Frontmatter 限制

- **Skills / Agents / Slash Commands frontmatter 僅支援 3 個事件**：`PreToolUse`、`PostToolUse`、`Stop`
- `once` 欄位僅在 Skills 和 Slash Commands 中有效，Agents 不支援

### 安全控制

- `allowManagedHooksOnly: true`：僅允許 managed hooks（企業管理員設定）
- `disableAllHooks: true`：完全停用所有 hooks
- `TeammateIdle` 不支援 prompt / agent hook

### 安全最佳實踐

1. **驗證和清理輸入** — 永遠不要盲目信任 stdin 資料
2. **引用 shell 變數** — 使用 `"$VAR"` 而非 `$VAR`
3. **阻止路徑遍歷** — 檢查檔案路徑中的 `..`
4. **使用絕對路徑** — 為腳本指定完整路徑（用 `"$CLAUDE_PROJECT_DIR"` 或 `"${CLAUDE_PLUGIN_ROOT}"`）
5. **跳過敏感檔案** — 避免 `.env`、`.git/`、金鑰等

---

## 十三、驗證規則

Hook 必須通過以下驗證：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-HK-01 | `hooks.json` 為合法 JSON | Error |
| V-HK-02 | 根物件有 `hooks` 欄位 | Error |
| V-HK-03 | Event 名稱為合法值（區分大小寫） | Error |
| V-HK-04 | 每個 hook group 有 `hooks` 陣列 | Error |
| V-HK-05 | 每個 hook 有合法 `type`（`command` / `prompt` / `agent`） | Error |
| V-HK-06 | command hook 的命令可執行 | Error |
| V-HK-07 | command hook 引用的腳本存在 | Error |
| V-HK-08 | prompt / agent hook 有 `prompt` 欄位 | Error |
| V-HK-09 | matcher 為合法正則表達式 | Error |
| V-HK-10 | 不可阻擋事件的 hook 不應期望 exit code 2 | Warning |
| V-HK-11 | 腳本使用 `${CLAUDE_PLUGIN_ROOT}` 而非硬編碼路徑 | Warning |
| V-HK-12 | `timeout` 為正整數 | Warning |
| V-HK-13 | `statusMessage` 為字串類型（若提供） | Warning |
| V-HK-14 | `once` 為布林類型（若提供），且僅用於 Skills 和 Slash Commands 的 hooks | Warning |
| V-HK-15 | `async` 為布林類型且僅用於 command hook（若提供） | Warning |
| V-HK-16 | hook entry 無多餘欄位（白名單：type/command/prompt/model/timeout/statusMessage/once/async） | Error |
| V-HK-17 | hook group 無多餘欄位（白名單：matcher/hooks/description） | Error |

### 合法 Event 名稱（14 個）

```
SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, PostToolUseFailure, Notification, SubagentStart,
SubagentStop, Stop, TeammateIdle, TaskCompleted, PreCompact, SessionEnd
```

---

## 十四、偵錯

### 基本方法

| 方法 | 說明 |
|------|------|
| `claude --debug` | 啟用 debug 模式，支援分類過濾（例如 `"api,hooks"`） |
| `Ctrl+O` | 切換 verbose mode，顯示 hook 執行進度和輸出 |
| `/hooks` | 互動式選單，檢視、新增、管理 hooks |

### Debug 輸出範例

```
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Getting matching hook commands for PostToolUse with query: Write
[DEBUG] Found 1 hook matchers in settings
[DEBUG] Matched 1 hooks for query "Write"
[DEBUG] Found 1 hook commands to execute
[DEBUG] Executing hook command: <命令> with timeout 60000ms
[DEBUG] Hook command completed with status 0: <stdout>
```

### 故障排除清單

1. **檢查配置** — 執行 `/hooks` 確認 hook 已註冊
2. **驗證 JSON 語法** — 確保 settings.json 有效
3. **手動測試命令** — 先在終端機執行 hook 命令
4. **檢查執行權限** — 確保腳本有 `+x` 權限
5. **注意大小寫** — matcher 匹配工具名稱時區分大小寫

---

## 範例

### PostToolUse — 編輯後自動檢查

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/post-edit-check.sh",
        "timeout": 15,
        "statusMessage": "正在檢查編輯結果..."
      }]
    }]
  }
}
```

### PreToolUse — 工具呼叫前攔截

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pre-commit-check.sh",
        "timeout": 30,
        "statusMessage": "正在檢查命令安全性..."
      }]
    }]
  }
}
```

### Stop — 完成度評估

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "評估 Claude 是否完成了使用者的所有要求。檢查是否有遺漏的任務或未解決的問題。如果都完成了回傳 {\"ok\": true}，否則回傳 {\"ok\": false, \"reason\": \"未完成的事項\"}。\n\n$ARGUMENTS",
        "model": "haiku",
        "timeout": 15,
        "statusMessage": "正在評估完成度..."
      }]
    }]
  }
}
```

### SessionStart — 環境載入

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh",
        "timeout": 10,
        "statusMessage": "正在載入環境設定..."
      }]
    }]
  }
}
```

### PreToolUse — Agent Hook 安全審查

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "agent",
        "prompt": "檢查以下 Bash 命令是否安全。讀取相關檔案確認命令不會造成破壞。$ARGUMENTS",
        "timeout": 60,
        "statusMessage": "代理正在審查命令安全性..."
      }]
    }]
  }
}
```
