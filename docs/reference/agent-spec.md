# Agent（子代理）規格書

## 概述

Agent 是 Claude Code 中的專用子代理，擁有獨立的 context、工具權限和系統提示。透過 Task 工具或 Claude 自動委派來啟動，適合處理需要獨立思考和多步驟推理的專門任務。每個 agent 以一個 `.md` 檔案定義，frontmatter 描述能力配置，body 為系統提示。

---

## Frontmatter 完整欄位

```yaml
---
name: code-reviewer
description: >-
  Reviews code quality including correctness, security,
  performance and maintainability analysis.
tools: Read, Grep, Glob
disallowedTools: Write, Edit
model: sonnet
color: blue
permissionMode: default
maxTurns: 30
skills:
  - api-conventions
  - error-handling-patterns
mcpServers:
  - database-server
  - command: npx
    args: ["-y", "@example/mcp-server"]
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/scripts/validate.sh"
memory: project
---
```

### 欄位詳解

| 欄位 | 必要 | 類型 | 預設值 | 說明 |
|------|------|------|--------|------|
| `name` | 是 | string | — | Agent 的唯一識別名，使用 kebab-case |
| `description` | 是 | string | — | Claude 用此決定何時委派任務給此 agent |
| `tools` | 否 | string / array | 繼承全部 | 允許使用的工具清單。支援 `Task(agent_type)` 語法來限制可產生的子代理類型 |
| `disallowedTools` | 否 | string / array | — | 明確拒絕的工具清單 |
| `model` | 否 | string | `inherit` | 執行模型。可選值：`sonnet`、`opus`、`haiku`、`inherit`。可被 `ANTHROPIC_DEFAULT_*_MODEL` 和 `CLAUDE_CODE_SUBAGENT_MODEL` 環境變數覆寫 |
| `permissionMode` | 否 | string | `default` | 權限模式，共六個選項（見下方） |
| `maxTurns` | 否 | number | 無限制 | 最大 agentic turns 數量 |
| `skills` | 否 | array | — | 啟動時預載入的 skills。完整內容會注入子代理。**注意**：子代理不繼承父對話的 skills |
| `mcpServers` | 否 | array | — | 此 agent 可用的 MCP servers。可以是伺服器名稱字串，或內聯定義物件 |
| `hooks` | 否 | object | — | 生命週期 hooks，**僅支援 PreToolUse、PostToolUse、Stop**（3 個事件）。frontmatter 中的 `Stop` hook 會自動轉換為 `SubagentStop` |
| `color` | 否 | string | — | Agent 在 IDE 中的視覺標示顏色。可選值：`red`、`blue`、`green`、`yellow`、`purple`、`orange`、`pink`、`cyan` |
| `memory` | 否 | string | — | 持久記憶範圍。可選值：`user`、`project`、`local` |

### 已確認不存在的欄位

| 欄位 | 來源 | 說明 |
|------|------|------|
| `run_mode` | ECC observer agent | 社群使用，非官方支援。前景/背景執行由 Task 工具的 `run_in_background` 參數控制，非 frontmatter 欄位 |
| `once` | — | 僅在 Skill frontmatter 中生效，agent frontmatter 不支援 |

> **注意**：Claude Code 的 YAML parser 對未知欄位採寬容策略（忽略不報錯），因此社群使用≠官方支援。

---

## permissionMode 六個選項

| 模式 | 說明 | 適用場景 |
|------|------|----------|
| `default` | 需要使用者確認所有敏感操作 | 一般用途 |
| `acceptEdits` | 自動接受檔案編輯操作 | 需要頻繁修改檔案的 agent |
| `delegate` | 只能協調和委派，不能直接寫碼 | 主管型 agent（如 Agent Teams Team Lead） |
| `dontAsk` | 完全自主，不詢問使用者 | 高信任度的自動化任務 |
| `bypassPermissions` | 繞過所有權限檢查。**最高優先順序**，不可被其他設定覆寫 | 完全受信任的系統級 agent |
| `plan` | 唯讀模式，只能讀取和規劃 | 研究和分析用途的 agent |

---

## 工具完整清單

### 所有內建工具

| 工具名稱 | 說明 |
|----------|------|
| `AskUserQuestion` | 向使用者提問 |
| `Bash` | 執行 shell 命令 |
| `TaskOutput` | 讀取子任務輸出 |
| `Edit` | 編輯檔案 |
| `ExitPlanMode` | 退出 plan mode |
| `Glob` | 檔案模式搜尋 |
| `Grep` | 內容搜尋 |
| `KillShell` | 終止 shell 行程 |
| `MCPSearch` | 搜尋 MCP 工具 |
| `NotebookEdit` | 編輯 Jupyter notebook |
| `Read` | 讀取檔案 |
| `Skill` | 呼叫 skill |
| `Task` | 建立並執行子任務 |
| `TaskCreate` | 建立子任務 |
| `TaskGet` | 取得子任務狀態 |
| `TaskList` | 列出子任務 |
| `TaskUpdate` | 更新子任務 |
| `WebFetch` | 擷取網頁內容 |
| `WebSearch` | 網頁搜尋 |
| `Write` | 寫入檔案 |
| `LSP` | Language Server Protocol 操作 |

### MCP 工具格式

MCP 工具使用 `mcp__<server>__<tool>` 格式命名。例如：`mcp__database-server__query`。

### Task(agent_type) 語法

在 `tools` 欄位中使用 `Task(agent_type)` 語法，可限制此 agent 能產生的子代理類型。例如：

```yaml
tools: Read, Grep, Task(Explore)
```

表示此 agent 只能使用 Read、Grep 工具，以及產生 `Explore` 類型的子代理。

---

## Memory 機制

### 記憶範圍

| 範圍 | 儲存位置 | 適用場景 |
|------|----------|----------|
| `user` | `~/.claude/agent-memory/<name>/` | 跨專案通用的學習和記憶 |
| `project` | `.claude/agent-memory/<name>/` | 專案特定的知識（可 git 追蹤） |
| `local` | `.claude/agent-memory-local/<name>/` | 個人本地記憶（gitignored） |

### 記憶行為

- **自動注入**：系統自動將 `MEMORY.md` 的前 200 行注入到 agent 的 system prompt
- **超過 200 行**：當 `MEMORY.md` 超過 200 行時，會要求子代理進行整理
- **工具自動啟用**：啟用 memory 後，`Read`、`Write`、`Edit` 工具會自動啟用，確保 agent 可以讀寫記憶檔案
- **跨 session**：記憶跨 session 存活

### 記憶結構範例

```
.claude/agent-memory/code-reviewer/
├── MEMORY.md            # 主記憶檔（前 200 行自動注入）
├── patterns.md          # 常見問題模式
└── project-rules.md     # 專案特定規則
```

---

## 前景/背景執行

### 前景執行

- 阻塞主對話，主對話等待子代理完成
- 支援所有工具，包括 MCP 工具

### 背景執行

- 與主對話同時運行，不阻塞
- **MCP 工具不可用**：背景子代理無法使用 MCP 工具
- **預先請求權限**：啟動前會預先請求所需權限
- **澄清問題**：背景子代理的澄清問題（AskUserQuestion）會失敗，但子代理會繼續執行

### 操作

| 操作 | 說明 |
|------|------|
| `Ctrl+B` | 將前景子代理切換到背景 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | 環境變數，完全停用背景任務 |

---

## Stop → SubagentStop 自動轉換

### 機制說明

Agent frontmatter 中定義的 `Stop` hook 會在運行時**自動轉換**為 `SubagentStop` 事件。這是因為子代理完成時觸發的事件本來就是 `SubagentStop`，而非 `Stop`（`Stop` 僅對主代理觸發）。

```yaml
---
name: my-agent
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/scripts/check-completion.sh"
---
```

上述 frontmatter 中的 `Stop` 會被自動轉換為 `SubagentStop`，在子代理完成回應時觸發。

### SubagentStop 輸入欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| `stop_hook_active` | boolean | 是否為 stop hook 觸發後的再次評估 |
| `agent_id` | string | 子代理唯一識別碼 |
| `agent_type` | string | 子代理類型 |
| `agent_transcript_path` | string | 子代理 transcript 路徑 |

### 防止無限迴圈

**必須**檢查 `stop_hook_active`。當 hook 阻擋子代理停止後，子代理繼續執行並再次嘗試停止時，`stop_hook_active` 會為 `true`。此時應讓子代理正常停止，否則會陷入無限迴圈。

```bash
#!/bin/bash
INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

# 防止無限迴圈
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# 正常檢查邏輯...
```

### Matcher

SubagentStop 的 matcher 匹配 **agent type 名稱**，與 SubagentStart 一致。

---

## 子代理恢復（Resume）

- **預設行為**：每次建立新的子代理實例
- **恢復機制**：可恢復先前的子代理，保留完整歷史
- **Transcript 儲存位置**：`~/.claude/projects/{project}/{sessionId}/subagents/`

---

## 停用特定子代理

| 方法 | 語法 |
|------|------|
| permissions.deny | `Task(subagent-name)` |
| CLI | `--disallowedTools "Task(Explore)"` |

---

## 內建 Agent 完整清單

| 名稱 | 模型 | 工具權限 | 用途 |
|------|------|----------|------|
| `Explore` | Haiku | 唯讀（Read, Grep, Glob） | 快速搜尋和探索 |
| `Plan` | Inherit | 唯讀（Read, Grep, Glob） | Plan mode 下的研究 |
| `general-purpose` | Inherit | 全部 | 複雜多步驟任務 |
| `Bash` | Inherit | Bash | 在獨立終端中執行命令 |
| `statusline` | Sonnet | — | `/statusline` 設定用 |
| `Claude Code 指南` | Haiku | — | 使用者詢問功能問題時使用 |

---

## `--agents` CLI JSON 格式

透過 CLI 的 `--agents` 參數可以 JSON 格式定義 agent。JSON schema 欄位與 frontmatter 一一對應：

```json
{
  "name": "code-reviewer",
  "description": "Reviews code quality including correctness and security.",
  "tools": ["Read", "Grep", "Glob"],
  "disallowedTools": [],
  "model": "sonnet",
  "permissionMode": "default",
  "maxTurns": 30,
  "skills": ["api-conventions"],
  "mcpServers": ["database-server"],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/validate.sh"
          }
        ]
      }
    ]
  },
  "memory": "project"
}
```

### JSON 與 Frontmatter 對應

| JSON 欄位 | Frontmatter 欄位 | 類型差異 |
|-----------|------------------|----------|
| `name` | `name` | 無 |
| `description` | `description` | 無 |
| `tools` | `tools` | JSON 為 array，frontmatter 可為 string 或 array |
| `disallowedTools` | `disallowedTools` | JSON 為 array，frontmatter 可為 string 或 array |
| `model` | `model` | 無 |
| `permissionMode` | `permissionMode` | 無 |
| `maxTurns` | `maxTurns` | 無 |
| `skills` | `skills` | 無 |
| `mcpServers` | `mcpServers` | 無 |
| `hooks` | `hooks` | 無 |
| `memory` | `memory` | 無 |

---

## Agent Teams（實驗性）

> **注意**：Agent Teams 是實驗性功能，需設定 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 啟用。

Agent Teams 與 Subagents 是兩種不同的並行化機制：

| 面向 | Subagents | Agent Teams |
|------|-----------|-------------|
| **Context** | 自己的 context window，結果返回呼叫者 | 自己的 context window，完全獨立 |
| **通訊** | 僅向主代理報告結果 | 隊友可直接互相傳訊（message / broadcast） |
| **協調** | 主代理管理所有工作 | 共享任務清單，自我協調 |
| **最適合** | 專注任務，只需結果 | 需要討論和協作的複雜工作 |
| **Token 成本** | 較低（結果摘要返回） | 較高（每個隊友是獨立 Claude 實例） |

### 架構

| 元件 | 角色 |
|------|------|
| **Team Lead（主管）** | 建立團隊、生成隊友、協調工作的主 session |
| **Teammates（隊友）** | 各自處理任務的獨立 Claude Code 實例 |
| **Task List** | 共享工作項目清單（pending → in-progress → completed），支援依賴關係 |
| **Mailbox** | 代理間通訊的訊息系統 |

### 關鍵行為

- **Context 載入**：隊友載入 CLAUDE.md、MCP servers、skills，但**不繼承**主管的對話歷史
- **權限**：繼承主管的權限設定，生成後可個別調整
- **委派模式**：限制主管只能使用協調工具（Shift+Tab 切換）
- **計畫審批**：可要求隊友在 plan mode 工作，主管審批後才實作
- **任務認領**：使用檔案鎖防止競爭條件
- **儲存位置**：`~/.claude/teams/{team-name}/config.json` + `~/.claude/tasks/{team-name}/`
- **顯示模式**：`in-process`（主終端內）/ `tmux`（分割窗格）/ `auto`（自動偵測）

### 相關 Hook 事件

| 事件 | 觸發時機 |
|------|---------|
| `TeammateIdle` | 隊友完成工作並停止時 |
| `TaskCompleted` | 共享任務清單中的任務被標記完成時 |

### 最佳使用案例

- 研究和審查（多角度同時調查）
- 新模組或功能（各自擁有獨立部分）
- 競爭假設除錯（並行測試不同理論）
- 跨層協調（前端/後端/測試各由不同隊友負責）

### Agent Teams 限制

1. 每 session 一個團隊，無法巢狀
2. 主管固定，無法轉移領導權
3. In-process 隊友無 session 恢復（`/resume` 不恢復隊友）
4. 分割窗格僅支援 tmux 或 iTerm2
5. 權限在生成時繼承，無法在生成時為個別隊友設定不同權限

---

## 觸發方式

Agent 可透過以下六種方式觸發：

| 方式 | 說明 |
|------|------|
| 1. 自動委派 | Claude 根據 agent 的 `description` 自動判斷是否需要委派 |
| 2. 明確請求 | 使用者在對話中明確要求使用某個 agent |
| 3. `claude --agent <name>` | CLI 直接指定以特定 agent 啟動 |
| 4. `--agents` JSON | CLI 以 JSON 格式定義並啟動 agent |
| 5. Hook agent type | 透過 hook 中的 `type: "agent"` 觸發 |
| 6. Task tool | 在對話或 skill 中使用 Task 工具明確指定 agent |

---

## 所有限制

| # | 限制 | 說明 |
|---|------|------|
| 1 | 不支援巢狀子代理 | 子代理不能產生其他子代理 |
| 2 | 背景子代理無 MCP | 背景執行的子代理無法使用 MCP 工具 |
| 3 | 背景子代理澄清問題失敗 | 背景子代理的 AskUserQuestion 會失敗，但子代理會繼續執行 |
| 4 | 有限的環境資訊 | 子代理只接收系統提示和基礎環境資訊 |
| 5 | 不繼承父對話 Skills | 子代理不會繼承父對話中載入的 skills |
| 6 | `Task(agent_type)` 限制 | `Task(agent_type)` 語法僅對 `--agent` 主執行緒有效 |
| 7 | Session 啟動時載入 | Agent 定義在 session 啟動時載入，之後新增需重啟 |
| 8 | `bypassPermissions` 最高優先 | `bypassPermissions` 為最高優先順序，不可被其他設定覆寫 |
| 9 | 自動壓縮 | 子代理在 context 使用達 95% 時自動壓縮。可透過 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 環境變數調整 |
| 10 | `once` 不支援 | Agent frontmatter 不支援 `once` 欄位，該功能僅限 Skill frontmatter |
| 11 | Stop → SubagentStop | Agent frontmatter 中的 `Stop` hook 會自動轉換為 `SubagentStop` 事件 |
| 12 | Frontmatter hooks 僅 3 事件 | 僅支援 `PreToolUse`、`PostToolUse`、`Stop`，其他事件只能在 hooks.json/settings.json 定義 |

---

## 驗證規則

Agent 必須通過以下驗證：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-AG-01 | `.md` 檔案存在於 `agents/` 下 | Error |
| V-AG-02 | Frontmatter 為合法 YAML | Error |
| V-AG-03 | `name` 欄位存在且為 kebab-case | Error |
| V-AG-04 | `description` 欄位存在且非空 | Error |
| V-AG-05 | `tools` 中的工具名稱合法，`Task(agent_type)` 語法正確 | Error |
| V-AG-06 | `disallowedTools` 中的工具名稱合法 | Error |
| V-AG-07 | `tools` 和 `disallowedTools` 不同時存在 | Error |
| V-AG-08 | `model` 為 `sonnet`、`opus`、`haiku`、`inherit` 之一 | Error |
| V-AG-09 | `permissionMode` 為 `default`、`acceptEdits`、`dontAsk`、`bypassPermissions`、`plan` 之一 | Error |
| V-AG-10 | `maxTurns` 為正整數 | Warning |
| V-AG-11 | `memory` 為 `user`、`project`、`local` 之一 | Error |
| V-AG-12 | `skills` 引用的 skill 存在 | Warning |
| V-AG-13 | `mcpServers` 引用的伺服器存在或內聯定義合法 | Warning |
| V-AG-14 | `hooks` 結構合法 | Error |
| V-AG-15 | Frontmatter 下方有系統提示內容 | Warning |
| V-AG-16 | `color` 為 `red`、`blue`、`green`、`yellow`、`purple`、`orange`、`pink`、`cyan` 之一（若有填寫） | Warning |

---

## 範例

### 唯讀分析 Agent

```yaml
---
name: code-reviewer
description: >-
  Reviews code quality including correctness, security,
  performance and maintainability. Produces structured reports.
tools: Read, Grep, Glob
model: sonnet
color: blue
maxTurns: 30
memory: project
---

你是一個資深程式碼審查員。

## 審查原則
1. 正確性優先
2. 安全性不可妥協
3. 效能問題只在明顯時提出
4. 可維護性建議要具體

## 審查流程
1. 先了解整體變更範圍
2. 逐檔案分析
3. 交叉引用相關程式碼
4. 產出結構化報告

## 輸出格式
- Critical: 必須修復的問題
- Warning: 建議修復的問題
- Info: 改善建議
```

### 有寫入權限的 Agent

```yaml
---
name: knowledge-keeper
description: >-
  Analyzes project changes and automatically updates
  knowledge base documentation to keep it current.
tools: Read, Write, Edit, Grep, Glob
model: haiku
color: green
maxTurns: 20
permissionMode: acceptEdits
memory: project
---

你是專案知識庫的維護者。

## 職責
1. 分析最近的程式碼變更
2. 更新相關文件
3. 維護知識庫的一致性

## 規則
1. 不修改程式碼，只更新文件
2. 保持文件與程式碼同步
3. 使用清晰的繁體中文撰寫
```

### 使用 MCP 的 Agent

```yaml
---
name: db-analyst
description: >-
  Queries and analyzes database schemas and data patterns
  using MCP database connections.
tools: Read, Grep, Glob
mcpServers:
  - database-server
  - command: npx
    args: ["-y", "@example/analytics-server"]
model: sonnet
maxTurns: 20
permissionMode: default
---

你是資料庫分析專家。

## 能力
1. 查詢資料庫結構
2. 分析資料模式
3. 提供最佳化建議

## 規則
1. 唯讀操作，不執行寫入查詢
2. 敏感資料遮蔽處理
```

### 帶 Stop Hook 的 Agent（Stop → SubagentStop 轉換）

```yaml
---
name: task-checker
description: >-
  Executes multi-step tasks and verifies completion
  before stopping. Stop hook ensures all steps are done.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
color: yellow
maxTurns: 50
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: >-
            檢查子代理是否完成了所有要求的任務。
            如果全部完成回傳 {"ok": true}，
            否則回傳 {"ok": false, "reason": "未完成的事項"}。
            $ARGUMENTS
          model: haiku
          timeout: 15
          statusMessage: "正在評估完成度..."
---

你是一個任務執行者，負責完成多步驟任務。

## 規則
1. 按順序執行每個步驟
2. 完成前確認所有步驟都已完成
3. Stop hook 會自動轉換為 SubagentStop，在你完成時觸發
```

### 完全自主的 Agent

```yaml
---
name: auto-formatter
description: >-
  Automatically formats and organizes code files according
  to project conventions without user interaction.
tools: Read, Write, Edit, Bash, Glob
model: haiku
maxTurns: 50
permissionMode: dontAsk
---

你是自動格式化工具。

## 職責
1. 執行程式碼格式化
2. 整理 import 順序
3. 修正空白和縮排

## 規則
1. 只做格式化，不改邏輯
2. 遵循專案的 .editorconfig 和 linter 設定
```
