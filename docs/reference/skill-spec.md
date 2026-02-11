# Skill 規格書

## 概述

Skills 是 Claude Code 的可擴展能力模組，透過 SKILL.md 檔案為 Claude 添加專業知識、工作流程和工具。Skills 遵循 Agent Skills 開放標準，並在此基礎上擴展了呼叫控制（invocation control）、子代理執行（sub-agent execution）和動態內容注入（dynamic content injection）等能力。

Custom Slash Commands 已合併進 Skills 系統。`.claude/commands/` 目錄仍然受到支援，但當同名的 skill 和 slash command 同時存在時，skill 優先。

---

## 檔案結構

```
skill-name/
├── SKILL.md              # 主要指令（必要）
├── references/           # 參考文件（按需載入）
├── examples/             # 範例檔案（按需載入）
├── scripts/              # 可執行腳本（可直接執行，無需載入 context）
└── assets/               # 輸出用資源（模板、圖片等，不載入 context）
```

### 各目錄用途

| 目錄 | 說明 | 載入行為 |
|------|------|----------|
| `SKILL.md` | 主要指令檔案，包含 frontmatter 和指令內容 | 觸發時載入 |
| `references/` | 詳細參考文件，供 Claude 按需讀取 | 按需載入 |
| `examples/` | 使用範例檔案，供 Claude 按需讀取 | 按需載入 |
| `scripts/` | 可執行腳本，可直接執行而不需要讀入 context | 不載入 context，直接執行 |
| `assets/` | 輸出用資源，如模板、圖片等 | 不載入 context |

---

## 存放位置與優先順序

Skills 的存放位置決定其優先順序，由高到低為：

| 優先順序 | 來源 | 位置 |
|----------|------|------|
| 1（最高） | Enterprise | Managed settings |
| 2 | Personal | `~/.claude/skills/` |
| 3 | Project | `.claude/skills/` |
| 4（最低） | Plugin | `plugin/skills/` |

### 命名空間

- Plugin skills 使用 `plugin-name:skill-name` 格式的命名空間
- 使用者呼叫時為 `/plugin-name:skill-name`

### 自動探索

- 支援 monorepo 中巢狀的 `.claude/skills/` 目錄，會自動探索
- 透過 `--add-dir` 指定的目錄中，其 `.claude/skills/` 也會被載入

---

## SKILL.md 完整格式

### Frontmatter 欄位

```yaml
---
name: skill-name
description: >-
  Generates detailed code review reports for pull requests,
  including security analysis and performance suggestions.
argument-hint: "[action] [options]"
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
context: fork
agent: Explore
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"
---
```

### Frontmatter 欄位詳解

| 欄位 | 必要 | 類型 | 預設值 | 說明 |
|------|------|------|--------|------|
| `name` | 否 | string | 目錄名稱 | Skill 的唯一識別名。僅允許小寫字母、數字和連字號（`-`），最多 64 字元 |
| `description` | 建議 | string | markdown 第一段 | Claude 用此判斷何時自動載入該 skill。**最佳實踐**：使用第三人稱撰寫，包含觸發詞。若未提供，會使用 SKILL.md body 的第一段 |
| `argument-hint` | 否 | string | 無 | 在 `/skill` 後顯示的自動完成提示文字 |
| `disable-model-invocation` | 否 | boolean | `false` | 設為 `true` 時，Claude 不能自動載入此 skill，description 也不會放入 context。使用者仍可手動透過 `/name` 呼叫 |
| `user-invocable` | 否 | boolean | `true` | 設為 `false` 時，此 skill 從 `/` 選單中隱藏。**注意**：此設定僅控制選單可見性，不阻止 Skill 工具的程式化調用 |
| `allowed-tools` | 否 | string（逗號分隔） | 繼承全部 | 限制此 skill 可使用的工具。支援模式語法，例如 `Bash(python *)` |
| `model` | 否 | string | 當前模型 | 執行此 skill 時使用的模型。可選值：`sonnet`、`opus`、`haiku` |
| `context` | 否 | string | 無（inline） | 設為 `fork` 時，在隔離的子代理中執行 |
| `agent` | 否 | string | `general-purpose` | 當 `context: fork` 時，指定子代理的類型 |
| `hooks` | 否 | object（YAML） | 無 | 生命週期 hooks，支援 `PreToolUse`、`PostToolUse`、`Stop` |

### 待確認欄位

以下欄位在社群實戰 plugin (ECC) 中出現，但尚未在官方文檔中確認：

| 欄位 | 類型 | 說明 | 來源 |
|------|------|------|------|
| `version` | string | Skill 版本號（如 `"2.0.0"`） | ECC continuous-learning-v2 |
| `tools` | string | `allowed-tools` 的可能別名 | ECC eval-harness |
| `command` | boolean | 標記此 .md 為 command 而非 skill | ECC evolve command |

> **注意**：使用前需實測確認。Claude Code 的 YAML parser 對未知欄位採寬容策略（忽略不報錯），因此社群使用≠官方支援。若為無效欄位，不會報錯但也不會生效。

---

## 呼叫控制矩陣

| 設定 | 使用者 `/name` | Claude 自動載入 | description 在 context |
|------|----------------|-----------------|------------------------|
| 預設（兩者皆預設值） | ✅ | ✅ | ✅ 常駐 |
| `disable-model-invocation: true` | ✅ | ❌ | ❌ 不載入 |
| `user-invocable: false` | ❌（選單隱藏） | ✅ | ✅ 常駐 |

---

## 指令內容語法

Frontmatter 下方的 Markdown 即為 skill 的指令內容，在 skill 被觸發時送給 Claude。

### 內容類型

Skill 內容可分為兩種類型，選擇何種類型影響呼叫方式和 `context` 設定：

| 類型 | 說明 | 呼叫方式 | context 建議 |
|------|------|----------|-------------|
| **Reference（參考知識）** | 慣例、模式、風格指南、領域知識。Claude 在主對話中搭配上下文使用 | 自動載入為主 | inline（預設） |
| **Task（任務步驟）** | 部署、提交、程式碼生成等具體動作的逐步說明 | `/name` 手動呼叫為主 | `fork`（隔離執行） |

**Reference 範例**：API 設計慣例、程式碼風格規範、框架用法指南
**Task 範例**：部署流程、commit 工作流、測試執行、PR 生成

### 變數替換

| 變數 | 說明 | 範例 |
|------|------|------|
| `$ARGUMENTS` | 所有傳入參數 | `/skill foo bar` → `"foo bar"` |
| `$ARGUMENTS[N]` | 0-based 索引取得第 N 個參數 | `/skill foo bar` → `$ARGUMENTS[0]` = `"foo"`，`$ARGUMENTS[1]` = `"bar"` |
| `$N` | `$ARGUMENTS[N]` 的簡寫 | `$0` = `$ARGUMENTS[0]`，`$1` = `$ARGUMENTS[1]` |
| `${CLAUDE_SESSION_ID}` | 當前 session ID | |

**`$ARGUMENTS` 自動附加行為**：若 skill 內容中不存在 `$ARGUMENTS` 變數引用，傳入的參數會以 `ARGUMENTS: <value>` 的格式自動附加到內容末尾。

### 動態內容注入

使用 `` !`command` `` 語法，在 skill 內容送給 Claude **之前**執行 shell 命令。這是一種預處理機制：

```markdown
---
name: pr-summary
description: Summarizes the current PR changes with diff context.
---

目前的 PR diff：
!`gh pr diff`

變更的檔案清單：
!`gh pr diff --name-only`

請總結這個 PR 的變更。
```

**動態內容注入規則**：

- **預處理**：命令在 skill 內容送給 Claude 之前執行
- **完全取代**：命令輸出完全取代佔位符
- **透明性**：Claude 只看到渲染後的結果，不知道原始的 `` !`command` `` 語法
- **錯誤處理**：命令失敗時替換為空字串

---

## `context: fork` 完整行為

將 `context` 設為 `fork` 時，skill 會在隔離的子代理中執行：

```yaml
---
name: deep-analysis
description: Performs deep code structure analysis in an isolated context.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob
---

分析 $ARGUMENTS 的程式碼結構...
```

### Fork 模式特性

- **隔離 context**：建立獨立的 context，不存取主對話歷史
- **Skill 即 prompt**：skill 的指令內容成為子代理的 task prompt
- **Agent 類型**：由 `agent` 欄位決定執行環境（模型、工具、權限），預設為 `general-purpose`
- **也載入**：CLAUDE.md 會一併載入到子代理中
- **適合場景**：任務指令明確、需要獨立執行的 skills
- **不適合場景**：純指引類（guidance）的 skills，因為無法存取主對話上下文

### Skill Fork vs Subagent 預載比較

| 方法 | System Prompt | Task | 額外載入 |
|------|--------------|------|---------|
| Skill `context: fork` | 來自 agent 類型（`Explore`、`Plan` 等） | SKILL.md 內容 | CLAUDE.md |
| Subagent 預載 skills | 子代理的 markdown 主體 | Claude 的委派訊息 | 預載 skills + CLAUDE.md |

---

## 載入機制：三層漸進揭露

Skills 採用三層漸進揭露機制，以最佳化 context window 使用：

| 層次 | 內容 | 載入時機 | 大小限制 |
|------|------|----------|----------|
| Metadata | name + description | 永遠在 context 中 | 約 100 詞 |
| SKILL.md body | 完整指令內容 | 被觸發時載入 | 建議 < 5,000 詞 |
| Bundled resources | `references/`、`examples/` 中的檔案 | Claude 按需載入 | 無上限 |

**scripts/ 特殊行為**：`scripts/` 目錄中的腳本可直接執行，不需要讀入 context。

### SKILL.md Body 內部揭露結構（D-1 ~ D-6）

三層漸進揭露控制「何時載入」，以下規則控制 Body **內部的排列順序**，確保 Claude 在字元預算內優先取得最關鍵的資訊。

| 規則 | 要求 | 說明 |
|:----:|------|------|
| D-1 | 角色 → 工作流程，緊密相連 | `## 你的角色` 後必須立即接 `## 工作流程`，中間不插入其他章節 |
| D-2 | 工作流程在前 30 行內 | 從 frontmatter 結束算起，工作流程必須在前 30 行內開始 |
| D-3 | 參考區段使用 `## 參考：` 前綴 | 所有非核心資訊（格式定義、閾值表、對照表）統一使用 `## 參考：XXX` 標題 |
| D-4 | 格式 / Schema 在工作流程之後 | JSON Schema、輸出格式模板等必須放在 `---` 分隔線之後的參考區段 |
| D-5 | 揭露深度 ≤ 3 層 | Body 內最多 3 層揭露：角色→工作流程→參考，不再細分 |
| D-6 | 大型參考移至 `references/` | 超過 100 行的參考資料應移至 `references/` 目錄，由 Claude 按需讀取 |

**標準 Body 結構**：

```markdown
## 你的角色            ← 第 1 層：1-2 句話定位
## 工作流程            ← 第 2 層：核心步驟（前 30 行內）
---                    ← 分隔線：以下為參考資料
## 參考：XXX           ← 第 3 層：格式 / 閾值 / 對照表
## 關鍵原則            ← 邊緣情況和注意事項
## 使用者要求
$ARGUMENTS             ← 最末：使用者輸入
```

**反模式**：

```
❌ 角色 → JSON Schema → 分數表 → 閾值表 → 工作流（太晚出現）
❌ 角色 → 工作流 → 大量範例（200+ 行，應移至 references/）
✅ 角色 → 工作流 → --- → 參考格式 → 參考閾值 → 原則
```

---

## 字元預算

- **預設值**：15,000 字元
- **環境變數覆寫**：可透過 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 環境變數覆寫
- **超過預算**：超過字元預算的 skills 會被排除，不會載入
- **檢查方式**：使用 `/context` 指令可檢查目前 skills 的載入狀況和排除的 skills

---

## 權限控制

### 停用所有 Skills

在 `/permissions` 中 deny `Skill` 即可停用所有 skills。

### 允許/拒絕特定 Skills

| 語法 | 效果 |
|------|------|
| `Skill(name)` | 精確匹配特定 skill |
| `Skill(name *)` | 前綴匹配，匹配以 `name` 開頭的所有 skills |

### 隱藏個別 Skill

在 skill 的 frontmatter 中設定 `disable-model-invocation: true`，可阻止 Claude 自動載入。

---

## Extended Thinking

在 skill 的指令內容中包含 `ultrathink` 關鍵字可啟用 Extended Thinking 模式。

---

## CLI 相關

| 選項 | 說明 |
|------|------|
| `--disable-slash-commands` | 停用所有 skills |
| 載入時機 | Skills 在 session 啟動時載入，手動新增 skill 後需重啟 session |

---

## 驗證規則

Skill 必須通過以下驗證才算正確：

| 規則 | 驗證內容 | 嚴重度 |
|------|---------|--------|
| V-SK-01 | `SKILL.md` 存在於 `skills/<name>/` 下 | Error |
| V-SK-02 | Frontmatter 為合法 YAML | Error |
| V-SK-03 | `name` 欄位僅包含小寫字母、數字和連字號，最多 64 字元 | Error |
| V-SK-04 | `description` 欄位存在且非空 | Warning |
| V-SK-05 | `argument-hint` 為合法字串 | Warning |
| V-SK-06 | `disable-model-invocation` 為布林值 | Error |
| V-SK-07 | `user-invocable` 為布林值 | Error |
| V-SK-08 | `allowed-tools` 中的工具名稱合法，模式語法正確 | Error |
| V-SK-09 | `model` 值為 `sonnet`、`opus`、`haiku` 之一 | Error |
| V-SK-10 | `context` 值為 `fork` 或未設定 | Error |
| V-SK-11 | `context: fork` 時 `agent` 欄位存在 | Warning |
| V-SK-12 | `hooks` 結構合法，支援 `PreToolUse`、`PostToolUse`、`Stop` | Error |
| V-SK-13 | 動態內容 `` !`cmd` `` 的命令可執行 | Warning |
| V-SK-14 | 引用的腳本檔案存在且有執行權限 | Error |
| V-SK-15 | Frontmatter 下方有實際指令內容 | Warning |
| V-SK-16 | Body 結構符合 D-1 ~ D-6 揭露規則 | Warning |

### 合法工具名稱清單

```
Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch,
Task, TaskCreate, TaskGet, TaskList, TaskUpdate, TaskOutput,
NotebookEdit, AskUserQuestion, Skill, KillShell, MCPSearch,
ExitPlanMode, LSP, mcp__<server>__<tool>
```

工具名稱也支援模式語法，例如 `Bash(python *)` 表示僅允許以 `python` 開頭的 Bash 命令。

---

## 疑難排解

### Skill 未觸發

1. 檢查 `description` 是否包含使用者會自然說出的關鍵字
2. 確認 skill 出現在「有哪些 skills 可用？」的回覆中
3. 嘗試重新表述請求以更貼近 description
4. 若 skill 可手動呼叫，使用 `/skill-name` 直接呼叫

### Skill 觸發過於頻繁

1. 讓 `description` 更加具體
2. 若只想手動呼叫，加上 `disable-model-invocation: true`

### Claude 看不到所有 Skills

Skills 的 description 會載入 context。若 skills 數量多，可能超過字元預算（預設 15,000 字元）。執行 `/context` 檢查被排除的 skills。可透過 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 環境變數增加限制。

---

## 最佳實踐

### Description 撰寫

- 使用第三人稱撰寫（例如 "Generates..." 而非 "Generate..."）
- 包含觸發詞，幫助 Claude 判斷何時自動載入
- 簡潔但資訊充足

### Body 撰寫

- **必須遵循 D-1 ~ D-6 揭露結構**（見「載入機制」章節），這不是建議 — 是必要條件
- 使用祈使語態（例如 "分析程式碼結構" 而非 "你應該分析程式碼結構"）
- SKILL.md 保持在 500 行以下，詳細參考資料移至獨立檔案
- 格式定義、JSON Schema、輸出模板等放在 `---` 分隔線之後，使用 `## 參考：` 前綴
- 超過 100 行的參考資料移至 `references/` 目錄
- 避免與其他 skills 重複內容

---

## 範例

### 最小範例

```yaml
---
name: hello
description: Greets the user and introduces available capabilities.
---

用中文跟使用者打招呼，並簡介目前可用的功能。
```

### 完整範例

```yaml
---
name: git-flow
description: >-
  Automates Git workflows including commit formatting,
  branch creation, PR generation, and release management.
argument-hint: "[commit|branch|pr|release] [options]"
allowed-tools: Read, Bash, Grep, Glob
model: sonnet
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/scripts/validate-git-op.sh"
---

## 你的角色
你是 Git 工作流自動化助手。

## 支援的操作
- `commit` — 規範化 commit（Conventional Commits 格式）
- `branch` — 建立規範化 branch
- `pr` — 建立 PR 並自動生成摘要
- `release` — 建立 release 並更新 changelog

## 當前操作
使用者要求：$ARGUMENTS

## 規則
1. Commit message 必須符合 Conventional Commits
2. Branch 名稱必須有 feature/fix/chore 前綴
3. PR 必須包含摘要、變更清單、測試計劃
```

### 子代理模式範例

```yaml
---
name: deep-analysis
description: >-
  Performs deep structural analysis of codebases in an
  isolated context, including module dependencies and API surfaces.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob
model: sonnet
---

分析 $ARGUMENTS 的程式碼結構，包含：
1. 模組依賴關係
2. 公開 API 介面
3. 設計模式識別
```

### 僅供 Claude 自動呼叫的範例

```yaml
---
name: auto-lint-check
description: >-
  Checks code quality automatically when Claude detects
  potential lint issues in modified files.
user-invocable: false
allowed-tools: Bash, Read
---

檢查目前修改的檔案是否有 lint 問題。
如果有，列出問題並建議修正方式。
```
