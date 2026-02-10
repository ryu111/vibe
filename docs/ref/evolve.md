# evolve — 知識進化

> **優先級**：低
> **定位**：知識進化 + 文件同步 — instincts 聚類進化為 skills/agents，偵測並更新過時文件
> **合併自**：原 learner + 原 docs
> **ECC 對應**：continuous-learning-v2 + /evolve command + doc-updater agent
> **記憶層**：claude-mem（外部 plugin，推薦搭配但非必要依賴）

---

## 1. 概述

evolve 是 Vibe marketplace 的知識進化 plugin。它做兩件互補的事：

1. **進化**：從 instincts 聚類 → 進化為 skills/agents
2. **文件**：偵測程式碼變更 → 自動更新文件 → 保持同步

### 與 claude-mem 的關係

```
claude-mem（底層，獨立 plugin）     evolve（上層，獨立 plugin）
┌──────────────────────┐          ┌──────────────────────┐
│ PostToolUse: 觀察捕獲  │          │ evolve: 聚類 → skill │
│ Stop: session 摘要     │  ←讀取─  │ doc-sync: 文件同步   │
│ SessionStart: 注入     │          │ doc-updater: 自動更新│
│ SQLite + Chroma 儲存   │          │                      │
└──────────────────────┘          └──────────────────────┘
```

**解耦原則**：
- evolve **不 import** mem 的程式碼，**不 require** mem
- 有 mem → evolve 可從 mem 的觀察資料聚類出 instincts
- 無 mem → evolve 仍可運作，使用者手動提供 instincts 或從對話提取

核心理念：**觀察由 mem 處理，進化由 evolve 處理。文件是程式碼的影子。**

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **碎片化知識** | Atomic instincts（Problem + Solution + When to Use） |
| 2 | **進化路徑** | instincts → cluster → skill/agent |
| 3 | **文件同步** | 程式碼變更後偵測過時文件並更新 |

---

## 3. 組件清單

### Skills（2 個）

| 名稱 | 說明 |
|------|------|
| `evolve` | 知識進化 — instincts 聚類 → 進化為 skill/agent |
| `doc-sync` | 文件同步 — 偵測程式碼與文件不同步，生成或更新文件 |

### Agents（1 個）

| 名稱 | Model | 權限 | 說明 |
|------|:-----:|:----:|------|
| `doc-updater` | haiku | 可寫 | 分析程式碼變更並更新對應文件 |

### Hooks / Scripts

無。觀察捕獲和 session 摘要由 claude-mem 處理。

---

## 4. Skills 詳細設計

### 4.1 evolve — 知識進化

```yaml
name: evolve
description: 知識進化 — 將 instincts 聚類並進化為 skills 或 agents。
```

**Instinct 格式**：

```json
{
  "id": "inst-20260209-001",
  "confidence": 0.5,
  "occurrences": 1,
  "problem": "Next.js API route 回傳 405",
  "solution": "檢查 export 的 HTTP method 名稱，App Router 使用命名導出",
  "when_to_use": "Next.js App Router API route 回傳非預期 HTTP status",
  "tags": ["next.js", "api-routes"]
}
```

**信心分數**：

| 分數 | 狀態 | 行為 |
|:----:|------|------|
| 0.3 | 初始 | 新觀察 |
| 0.5 | 確認 | 第二次觀察 |
| 0.7 | 成熟 | 多次成功應用 |
| 0.9 | 可進化 | 考慮進化為 skill |
| < 0.3 | 衰退 | 長期未使用，自動降級 |

**進化路徑**：

```
Observation → Instinct(0.3) → Cluster(≥3, avg≥0.7) → Skill/Agent
```

| 進化目標 | 條件 |
|---------|------|
| Cluster | ≥3 instincts 有相同 tag |
| Skill | avg confidence ≥ 0.7，instincts ≥ 5 |
| Agent | avg confidence ≥ 0.8，instincts ≥ 8，需多步驟 |

**資料來源**：
- 有 mem → 從 mem 的 SQLite/Chroma 讀取觀察紀錄
- 無 mem → 從當前對話提取，或使用者手動輸入

**mem 觀察類型對應**（有 mem 時）：

| mem 觀察類型 | evolve instinct 分類 |
|-------------|---------------------|
| bugfix 🔴 | problem-solution |
| feature 🟣 | why-it-exists, what-changed |
| refactor 🔄 | pattern, trade-off |
| change ✅ | what-changed |
| discovery 🔵 | how-it-works, gotcha |
| decision ⚖️ | why-it-exists, trade-off |

**mem 讀取方式**：
- MCP 工具：`search` → `timeline` → `get_observations`（3 層漸進式，省 token）
- 直接查詢：`~/.claude-mem/claude-mem.db`（SQLite FTS5）

**注意**：`CLAUDE_MEM_SKIP_TOOLS` 預設跳過 `Skill`，意味著 `/evolve:evolve` 本身的執行不會被 mem 觀察記錄。instincts 來源是其他工具的觀察，而非 evolve skill 自身。

### 4.2 doc-sync — 文件同步

```yaml
name: doc-sync
description: 文件同步 — 偵測程式碼與文件不同步，生成或更新文件。涵蓋 README、API docs、JSDoc、CHANGELOG。
```

**能力範圍**（合併原 doc-gen + doc-sync）：

| 操作 | 說明 |
|------|------|
| 偵測過時 | git diff → 分析變更 → 檢查對應文件是否過時 |
| 生成新文件 | 從程式碼產生 README、API Reference、JSDoc |
| 更新現有 | 機械性變更自動套用，語意性變更產出建議 |
| CHANGELOG | 從 git log + conventional commits 產生 |

---

## 5. Agent 詳細設計

### 5.1 doc-updater（可寫）

```yaml
---
name: doc-updater
description: >-
  分析程式碼變更並自動更新對應文件。機械性變更自動套用，
  語意性變更產出建議供人工審查。
tools: Read, Write, Edit, Bash, Grep, Glob
model: haiku
color: green
maxTurns: 30
permissionMode: acceptEdits
memory: project
---
```

**工作流**：分析 git diff → 識別受影響文件 → 機械性變更自動更新 → 語意性變更產出建議

**品質標準**：描述準確反映程式碼、範例可直接執行、不過度文件化。

---

## 6. 目錄結構

```
plugins/evolve/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── evolve/
│   │   └── SKILL.md
│   └── doc-sync/
│       └── SKILL.md
└── agents/
    └── doc-updater.md
```

---

## 7. 驗收標準

| # | 條件 |
|:-:|------|
| E-01 | Plugin 可載入，2 個 skill 可呼叫 |
| E-02 | doc-updater agent 可觸發 |
| E-03 | evolve skill 可從對話或 mem 資料聚類 instincts |
| E-04 | doc-sync 可從 TS 專案偵測過時文件並更新 |
| E-05 | doc-sync 可從程式碼生成 README |
| E-06 | 無 mem 時仍可正常運作（graceful degradation） |
| E-07 | forge:scaffold 驗證全 PASS |

---

## 8. plugin.json

```json
{
  "name": "evolve",
  "version": "0.1.0",
  "description": "知識進化 — instincts 聚類進化、文件偵測與同步",
  "skills": ["./skills/"],
  "agents": [
    "./agents/doc-updater.md"
  ],
  "pipeline": {
    "DOCS": { "agent": "doc-updater", "skill": "/evolve:doc-sync" }
  }
}
```
