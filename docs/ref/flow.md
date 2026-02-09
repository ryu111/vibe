# flow — 開發工作流

> **優先級**：高（第二個建構）
> **定位**：開發全生命週期 — 規劃、架構、compact、session 持久化、環境偵測
> **合併自**：原 flow + 原 session
> **ECC 對應**：planner/architect agents + suggest-compact hook + session hooks + /plan /checkpoint commands

---

## 1. 概述

flow 是 Vibe marketplace 的開發工作流引擎。它管理**從 session 開始到結束**的完整生命週期：載入前次 context → 規劃 → 架構設計 → context 管理 → 儲存進度。

合併 session 的原因：計畫進度和 session 持久化本質上是同一件事 — 都是「接續上次的工作」。

核心理念：**先想清楚再寫碼，上次結束的地方 = 這次開始的地方。**

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **Session 連續性** | SessionStart/End hooks 自動載入/儲存 context |
| 2 | **需求結構化** | 模糊需求 → 分階段實作計畫 |
| 3 | **架構設計** | 分析現有程式碼庫，提出符合慣例的方案 |
| 4 | **Context 管理** | 追蹤 tool calls，在邏輯邊界建議 compact |
| 5 | **環境感知** | 自動偵測語言/框架/PM/工具，供其他 plugin 使用 |
| 6 | **Checkpoint** | 手動建立工作檢查點，可回溯恢復 |

---

## 3. 組件清單

### Skills（5 個）

| 名稱 | 說明 |
|------|------|
| `plan` | 功能規劃 — 需求分析 + 分階段計畫 |
| `architect` | 架構設計 — 程式碼庫分析 + 多方案比較 |
| `compact` | 策略性壓縮 — context 管理 + compact 建議 |
| `checkpoint` | 工作檢查點 — 建立/列出/恢復 checkpoint |
| `env-detect` | 環境偵測 — 語言/框架/PM/工具 偵測 |

### Agents（2 個）

| 名稱 | Model | 權限 | 說明 |
|------|:-----:|:----:|------|
| `planner` | opus | 唯讀 | 需求分析 + 分階段計畫 + 風險評估 |
| `architect` | opus | 唯讀 | 程式碼庫分析 + 架構方案 + 介面設計 |

### Hooks（4 個）

| 事件 | 名稱 | 類型 | 說明 |
|------|------|:----:|------|
| SessionStart | load-context | command | 載入前次 context + 環境偵測 |
| SessionEnd | save-context | command | 儲存當前 context + 清理舊 sessions |
| PreToolUse | suggest-compact | command | 追蹤 tool calls，達 50 建議 compact |
| PreCompact | log-compact | command | 記錄 compact 事件 + 重設計數 |

---

## 4. Skills 詳細設計

### 4.1 plan — 功能規劃

```yaml
name: plan
description: 功能規劃 — 將需求轉化為分階段實作計畫。分析可行性、依賴、風險。
```

**UX 流程**：推斷技術棧 → planner agent 分析 → 展示分階段計畫 → 確認範圍 → 執行

**產出格式**：

```markdown
# 功能規劃：{名稱}
## 摘要（目標、影響範圍、預估階段）
## 階段分解（每階段：產出、依賴、風險、驗收）
## 風險摘要
## 依賴圖
```

### 4.2 architect — 架構設計

```yaml
name: architect
description: 架構設計 — 分析程式碼庫，提出 2-3 個方案比較優劣。
```

**UX 流程**：掃描結構 → architect agent 分析 → 展示多方案（目錄樹 + 介面 + 資料流）→ 使用者選擇

### 4.3 compact — 策略性壓縮

```yaml
name: compact
description: 策略性壓縮 — 追蹤 context 使用量，在邏輯邊界建議 compact。
```

**ECC 機制**：50 calls 閾值，每 25 calls 提醒，在邏輯邊界建議（非機械提醒）。

### 4.4 checkpoint — 工作檢查點

```yaml
name: checkpoint
description: 工作檢查點 — 建立/列出/恢復。結合 git stash/commit 實現狀態保存。
```

**操作**：
- **建立**：`git stash create` 或 `git commit` + metadata（時間、描述、修改檔案、任務進度）
- **列出**：表格顯示 ID、時間、描述、檔案數
- **恢復**：預覽變更 → 確認 → `git stash apply` 或 `git checkout`

**Checkpoint 格式**：

```json
{
  "id": "chk-20260209-001",
  "timestamp": "2026-02-09T14:30:00Z",
  "description": "完成 API endpoint，開始寫測試",
  "git_ref": "stash@{0}",
  "modified_files": ["src/api.ts", "src/types.ts"],
  "task_progress": {
    "current_phase": "Phase 2",
    "completed": ["API design", "Type definitions"],
    "remaining": ["Tests", "Documentation"]
  }
}
```

### 4.5 env-detect — 環境偵測

```yaml
name: env-detect
description: 環境偵測 — 偵測專案技術棧、套件管理器、可用工具。
```

**偵測順序**（PM，源自 ECC）：env var → 專案設定 → package.json → lock file → 全域設定 → fallback

**環境摘要格式**：

```json
{
  "languages": { "primary": "typescript", "secondary": ["css"] },
  "framework": { "name": "next.js", "version": "14.2.0" },
  "packageManager": { "name": "pnpm", "lockFile": "pnpm-lock.yaml" },
  "tools": {
    "linter": "eslint", "formatter": "prettier",
    "test": "vitest", "bundler": "turbopack"
  }
}
```

---

## 5. Agents 詳細設計

### 5.1 planner（唯讀）

```yaml
---
name: planner
description: >-
  Analyzes requirements and creates phased implementation plans
  with risk assessment and dependency analysis.
tools: Read, Grep, Glob
model: opus
color: purple
maxTurns: 30
permissionMode: plan
memory: project
---
```

**工作流**：理解需求 → 掃描專案 → 識別影響 → 拆解階段 → 評估風險 → 產出計畫

### 5.2 architect（唯讀）

```yaml
---
name: architect
description: >-
  Analyzes codebase structure and conventions, then designs
  2-3 architecture proposals with directory trees, interfaces,
  and data flow diagrams.
tools: Read, Grep, Glob
model: opus
color: cyan
maxTurns: 30
permissionMode: plan
memory: project
---
```

**工作流**：掃描結構 → 分析慣例 → 識別邊界 → 設計 2-3 方案 → 產出目錄樹+介面+資料流

---

## 6. Hooks 詳細設計

### 6.1 SessionStart: load-context

```json
{
  "matcher": "startup|resume",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.js",
    "timeout": 10,
    "once": true,
    "statusMessage": "載入工作環境..."
  }]
}
```

**行為**：
1. 讀取最近 session 檔案（`~/.claude/sessions/`）
2. 載入前次 context（修改中的檔案、任務進度）
3. 偵測專案環境（語言/框架/PM/工具）
4. 產出 hookSpecificOutput 供 Claude 參考

### 6.2 SessionEnd: save-context

```json
{
  "matcher": null,
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-end.js",
    "timeout": 10,
    "statusMessage": "儲存工作進度..."
  }]
}
```

**行為**：收集 session 資訊 → 寫入 session 檔案 → 清理過舊的（保留最近 10 個）

**Session 檔案格式**：

```json
{
  "id": "sess-20260209-143000",
  "repo": "my-app",
  "timestamp": "2026-02-09T14:30:00Z",
  "summary": "實作用戶認證 API — Phase 2/3 完成",
  "modified_files": ["src/auth.ts"],
  "task_progress": { "current_phase": "Phase 2", "completed": [...], "remaining": [...] },
  "environment": { "language": "typescript", "framework": "next.js", "packageManager": "pnpm" }
}
```

### 6.3 PreToolUse: suggest-compact

50 calls 閾值 → 每 25 calls 提醒 → 在邏輯邊界建議（不阻擋）

### 6.4 PreCompact: log-compact

記錄 compact 事件 → 重設 tool call 計數器

---

## 7. Scripts

| 腳本 | 位置 | 功能 |
|------|------|------|
| `session-start.js` | `scripts/hooks/` | 載入 context + 環境偵測 |
| `session-end.js` | `scripts/hooks/` | 儲存 context |
| `suggest-compact.js` | `scripts/hooks/` | 追蹤 tool calls |
| `log-compact.js` | `scripts/hooks/` | 記錄 compact 事件 |
| `session-manager.js` | `scripts/lib/` | Session CRUD |
| `env-detector.js` | `scripts/lib/` | 環境偵測 |
| `counter.js` | `scripts/lib/` | tool call 計數器 |

---

## 8. 目錄結構

```
plugins/flow/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── plan/
│   │   └── SKILL.md
│   ├── architect/
│   │   └── SKILL.md
│   ├── compact/
│   │   └── SKILL.md
│   ├── checkpoint/
│   │   └── SKILL.md
│   └── env-detect/
│       └── SKILL.md
├── agents/
│   ├── planner.md
│   └── architect.md
├── hooks/
│   └── hooks.json
└── scripts/
    ├── hooks/
    │   ├── session-start.js
    │   ├── session-end.js
    │   ├── suggest-compact.js
    │   └── log-compact.js
    └── lib/
        ├── session-manager.js
        ├── env-detector.js
        └── counter.js
```

---

## 9. 驗收標準

| # | 條件 |
|:-:|------|
| F-01 | Plugin 可載入，5 個 skill 可呼叫 |
| F-02 | 2 個 agent 可觸發 |
| F-03 | SessionStart hook 載入前次 context |
| F-04 | SessionEnd hook 儲存 context |
| F-05 | suggest-compact 50+ calls 後提醒 |
| F-06 | Checkpoint 可建立/列出/恢復 |
| F-07 | env-detect 正確偵測 TS/Python/Go 環境 |
| F-08 | forge:scaffold 驗證全 PASS |

---

## 10. plugin.json

```json
{
  "name": "flow",
  "version": "0.1.0",
  "description": "開發工作流 — 規劃、架構、compact、session 持久化、環境偵測",
  "skills": ["./skills/"],
  "agents": [
    "./agents/planner.md",
    "./agents/architect.md"
  ]
}
```
