# flow — 開發工作流

> **優先級**：高（第二個建構）
> **定位**：開發工作流 — 規劃、架構、compact、pipeline 管理、環境偵測
> **合併自**：原 flow + 原 session（session 持久化已移交 claude-mem）
> **ECC 對應**：planner/architect agents + suggest-compact hook + /plan /checkpoint commands

---

## 1. 概述

flow 是 Vibe marketplace 的開發工作流引擎。它管理**規劃 → 架構 → 實作**的完整 pipeline，以及 context 壓縮和環境偵測。

Session 持久化（跨 session context）已移交 **claude-mem**（獨立 plugin，推薦搭配但非依賴）。flow 專注於工作流本身。

核心理念：**先想清楚再寫碼，pipeline 引導每一步。**

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **需求結構化** | 模糊需求 → 分階段實作計畫 |
| 2 | **架構設計** | 分析現有程式碼庫，提出符合慣例的方案 |
| 3 | **Context 管理** | 追蹤 tool calls，在邏輯邊界建議 compact |
| 4 | **環境感知** | 自動偵測語言/框架/PM/工具，供其他 plugin 使用 |
| 5 | **Checkpoint** | 手動建立工作檢查點，可回溯恢復 |
| 6 | **Pipeline 管理** | 任務分類 → 階段轉換 → 完整性檢查 → 任務鎖定 |

---

## 3. 組件清單

### Skills（6 個）

| 名稱 | 說明 |
|------|------|
| `plan` | 功能規劃 — 需求分析 + 分階段計畫 |
| `architect` | 架構設計 — 程式碼庫分析 + 多方案比較 |
| `compact` | 策略性壓縮 — context 管理 + compact 建議 |
| `checkpoint` | 工作檢查點 — 建立/列出/恢復 checkpoint |
| `env-detect` | 環境偵測 — 語言/框架/PM/工具 偵測 |
| `cancel` | 取消任務鎖定 — 手動解除 task-guard，允許退出 |

### Agents（3 個）

| 名稱 | Model | 權限 | 說明 |
|------|:-----:|:----:|------|
| `planner` | opus | 唯讀 | 需求分析 + 分階段計畫 + 風險評估 |
| `architect` | opus | 唯讀 | 程式碼庫分析 + 架構方案 + 介面設計 |
| `developer` | sonnet | 可寫 | 按計畫實作程式碼 + 寫測試 + 遵循架構慣例 |

### Hooks（7 個）

| 事件 | 名稱 | 類型 | 強度 | 說明 |
|------|------|:----:|:----:|------|
| UserPromptSubmit | task-classifier | prompt | 軟建議 | 分類任務類型，注入建議的 pipeline 階段 |
| SessionStart | pipeline-init | command | — | 環境偵測 + pipeline 規則注入 |
| PreToolUse | suggest-compact | command | 軟建議 | 追蹤 tool calls，達 50 建議 compact |
| PreCompact | log-compact | command | — | 記錄 compact 事件 + 重設計數 |
| SubagentStop | stage-transition | command | 強建議 | Agent 完成後建議下一個 pipeline 階段 |
| Stop | pipeline-check | command | 強建議 | 結束前檢查是否有遺漏的建議階段 |
| Stop | task-guard | command | 絕對阻擋 | 未完成任務時阻擋退出（`decision: "block"`） |

> **Session 持久化**（載入/儲存 context）由 claude-mem 處理，不在 flow 範圍內。

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

### 4.6 cancel — 取消任務鎖定

```yaml
name: cancel
description: 取消任務鎖定 — 解除 task-guard，允許 Claude 正常結束。
```

**行為**：設定 state file `cancelled: true` → 下次 Stop hook 放行。

**使用場景**：
- Claude 卡住，反覆被 block 但無法推進
- 使用者決定中途放棄，切換到其他任務
- 安全閥之外的手動逃生門

---

## 5. Agents 詳細設計

### 5.1 planner（唯讀）

```yaml
---
name: planner
description: >-
  分析需求並建立分階段實作計畫，包含風險評估與依賴分析。
  釐清目標、範圍邊界、成功條件，產出可執行的計畫書。
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
  分析程式碼庫結構與慣例，設計 2-3 個架構方案，
  包含目錄樹、介面定義、資料流圖與取捨分析。
tools: Read, Grep, Glob
model: opus
color: cyan
maxTurns: 30
permissionMode: plan
memory: project
---
```

**工作流**：掃描結構 → 分析慣例 → 識別邊界 → 設計 2-3 方案 → 產出目錄樹+介面+資料流

### 5.3 developer（可寫）

```yaml
---
name: developer
description: >-
  依據 planner 的分階段計畫和 architect 的架構設計實作程式碼。
  參考 PATTERNS 知識庫，遵循專案慣例，撰寫測試，產出通過
  lint/format 的乾淨程式碼。
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
color: yellow
maxTurns: 60
permissionMode: acceptEdits
memory: project
---
```

**工作流**：載入 PATTERNS → 按階段實作 → 寫測試 → 自動 hooks 介入 → 產出可運行程式碼

**關鍵規則**：遵循 architect 方案的目錄結構和介面定義，不自行發明架構。

---

## 6. Hooks 詳細設計

### 6.1 UserPromptSubmit: task-classifier

```json
{
  "matcher": null,
  "hooks": [{
    "type": "prompt",
    "prompt": "Classify this user request into exactly one type. Respond ONLY with a JSON object.\n\nTypes:\n- research: read-only exploration, questions, understanding code\n- quickfix: trivial change (rename, color, typo) — 1-2 files\n- bugfix: fix specific broken behavior — needs verification\n- feature: new capability — needs planning, architecture, full pipeline\n- refactor: restructure existing code — needs architecture review\n- test: add or fix tests only\n- docs: documentation only\n- tdd: user explicitly requested TDD workflow\n\nStage mappings:\n- research: []\n- quickfix: [\"DEV\"]\n- bugfix: [\"DEV\", \"TEST\"]\n- feature: [\"PLAN\", \"ARCH\", \"DEV\", \"REVIEW\", \"TEST\", \"DOCS\"]\n- refactor: [\"ARCH\", \"DEV\", \"REVIEW\"]\n- test: [\"TEST\"]\n- docs: [\"DOCS\"]\n- tdd: [\"TEST\", \"DEV\", \"REVIEW\"]\n\nRespond: {\"type\":\"...\",\"stages\":[...]}",
    "model": "haiku",
    "timeout": 10
  }]
}
```

**強度：軟建議** — prompt hook 回應作為 `additionalContext` 注入，Claude 可自行判斷。

**行為**：
1. 每次使用者送出訊息時自動觸發（haiku，快速便宜）
2. 分類結果作為 `additionalContext` 注入，Claude 看到分類建議
3. Claude 結合完整對話 context 做最終決策 — **建議而非強制**

**任務類型與 Pipeline 對應**：

| 類型 | 啟動階段 | 典型場景 |
|------|---------|---------|
| research | — | 「這個 API 怎麼運作？」 |
| quickfix | DEV | 「把按鈕顏色改成藍色」 |
| bugfix | DEV → TEST | 「登入按鈕壞了」 |
| feature | PLAN → ARCH → DEV → REVIEW → TEST → DOCS | 「加上用戶認證系統」 |
| refactor | ARCH → DEV → REVIEW | 「把 auth 模組拆開」 |
| test | TEST | 「這個模組沒有測試」 |
| docs | DOCS | 「幫 API 寫文件」 |
| tdd | TEST(RED) → DEV(GREEN) → REVIEW | 「用 TDD 寫這個功能」 |

### 6.2 SessionStart: pipeline-init

```json
{
  "matcher": "startup|resume",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pipeline-init.js",
    "timeout": 10,
    "once": true,
    "statusMessage": "初始化工作環境..."
  }]
}
```

**行為**：
1. 偵測專案環境（語言/框架/PM/工具）
2. 注入 pipeline 委派規則（`additionalContext`）
3. 產出 hookSpecificOutput 供 Claude 參考

> **Note**：跨 session context（前次修改檔案、任務進度）由 claude-mem 的 SessionStart hook 處理。
> 此 hook 只負責環境偵測和 pipeline 規則注入。

### 6.3 PreToolUse: suggest-compact

50 calls 閾值 → 每 25 calls 提醒 → 在邏輯邊界建議（不阻擋）

### 6.4 PreCompact: log-compact

記錄 compact 事件 → 重設 tool call 計數器

### 6.5 SubagentStop: stage-transition

```json
{
  "matcher": null,
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/stage-transition.js",
    "timeout": 10,
    "statusMessage": "處理 pipeline 轉換..."
  }]
}
```

**強度：強建議** — Agent 完成時透過 `systemMessage` 建議下一個 pipeline 階段。

**邏輯**：
1. `stop_hook_active === true` → exit 0（防迴圈）
2. `discoverPipeline()` 載入配置
3. `agentToStage[agent_type]` 查找所屬 stage
4. `findNextStage()` 查找下一個已安裝 stage
5. 更新 `~/.claude/pipeline-state.json`
6. 輸出 `{ "continue": true, "systemMessage": "..." }`

詳見 → `docs/ref/pipeline.md` §4.3

### 6.6 Stop: pipeline-check

```json
{
  "matcher": null,
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pipeline-check.js",
    "timeout": 10,
    "statusMessage": "檢查工作完整性..."
  }]
}
```

**強度：強建議** — 結束前檢查遺漏階段，透過 `systemMessage` 提醒。

詳見 → `docs/ref/pipeline.md` §4.4

### 6.7 Stop: task-guard

```json
{
  "matcher": null,
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/task-guard.js",
    "timeout": 10,
    "statusMessage": "檢查任務完成狀態..."
  }]
}
```

**強度：絕對阻擋** — `decision: "block"` 阻止 Claude 結束回合，直到任務完成。

**吸納自**：ralph-wiggum plugin 的 Stop hook blocking 技術。

**啟動條件**：TodoWrite 存在未完成項目時自動啟動（state file 由首次 TodoWrite 呼叫時建立）。

**State file**：`~/.claude/task-guard-state.json`

```json
{
  "active": true,
  "blockCount": 0,
  "maxBlocks": 5,
  "cancelled": false,
  "snapshotCount": 8,
  "activatedAt": "2026-02-09T14:30:00Z"
}
```

**邏輯**：

```
Stop 觸發
  → stop_hook_active === true？ → exit 0（防迴圈）
  → state 不存在或 !active？ → exit 0（無 guard）
  → cancelled === true？ → cleanup + exit 0（手動取消）
  → blockCount >= maxBlocks？ → cleanup + exit 0（安全閥，輸出警告）
  → TodoWrite 全部 completed？ → cleanup + exit 0（任務完成）
  → 否則 → blockCount++ + 輸出 block：
    {
      "decision": "block",
      "reason": "繼續完成未完成的任務",
      "systemMessage": "⚠️ 任務尚未完成（第 N/5 次阻擋）\n\n未完成項目：\n- [ ] ...\n\n請繼續完成以上項目。"
    }
```

**Counter 規則**：
- 只有 Stop hook 實際 block 時才 +1
- Agent 切換（planner → developer）不計入
- 手動取消或完成時歸零

**完成判定**：TodoWrite 無 `pending` 或 `in_progress` 項目。

**與 pipeline-check 的關係**：pipeline-check 用 systemMessage 建議；task-guard 用 decision:block 強制。兩者互補 — pipeline-check 處理「忘了跑某階段」，task-guard 處理「做到一半就停」。

---

## 7. Scripts

| 腳本 | 位置 | 功能 |
|------|------|------|
| `pipeline-init.js` | `scripts/hooks/` | 環境偵測 + pipeline 規則注入 |
| `suggest-compact.js` | `scripts/hooks/` | 追蹤 tool calls |
| `log-compact.js` | `scripts/hooks/` | 記錄 compact 事件 |
| `stage-transition.js` | `scripts/hooks/` | Pipeline 階段轉換 + state 管理 |
| `pipeline-check.js` | `scripts/hooks/` | 結束前遺漏階段檢查 |
| `task-guard.js` | `scripts/hooks/` | 任務完成前阻擋退出 |
| `env-detector.js` | `scripts/lib/` | 環境偵測 |
| `counter.js` | `scripts/lib/` | tool call 計數器 |
| `pipeline-discovery.js` | `scripts/lib/` | 跨 plugin pipeline 動態發現 |

> Session CRUD（`session-manager.js`、`session-end.js`）已移除，由 claude-mem 處理。

---

## 8. 目錄結構

```
plugins/flow/
├── .claude-plugin/
│   └── plugin.json
├── pipeline.json                    ← Stage 順序定義
├── skills/
│   ├── plan/
│   │   └── SKILL.md
│   ├── architect/
│   │   └── SKILL.md
│   ├── compact/
│   │   └── SKILL.md
│   ├── checkpoint/
│   │   └── SKILL.md
│   ├── env-detect/
│   │   └── SKILL.md
│   └── cancel/
│       └── SKILL.md
├── agents/
│   ├── planner.md
│   ├── architect.md
│   └── developer.md
├── hooks/
│   └── hooks.json
└── scripts/
    ├── hooks/
    │   ├── pipeline-init.js         ← 環境偵測 + pipeline 規則
    │   ├── suggest-compact.js
    │   ├── log-compact.js
    │   ├── stage-transition.js
    │   ├── pipeline-check.js
    │   └── task-guard.js
    └── lib/
        ├── env-detector.js
        ├── counter.js
        └── pipeline-discovery.js
```

---

## 9. 驗收標準

| # | 條件 |
|:-:|------|
| F-01 | Plugin 可載入，6 個 skill 可呼叫 |
| F-02 | 3 個 agent 可觸發 |
| F-03 | task-classifier 在 UserPromptSubmit 時注入任務分類 |
| F-04 | pipeline-init 在 SessionStart 注入 pipeline 規則 + 偵測環境 |
| F-05 | suggest-compact 50+ calls 後提醒 |
| F-06 | Checkpoint 可建立/列出/恢復 |
| F-07 | env-detect 正確偵測 TS/Python/Go 環境 |
| F-08 | forge:scaffold 驗證全 PASS |
| F-09 | stage-transition 在 agent 完成後建議下一步 |
| F-10 | pipeline-check 偵測遺漏階段並提醒 |
| F-11 | 只裝 flow 時 pipeline 只含 PLAN → ARCH → DEV |
| F-12 | 全裝時 pipeline 含完整 6 個階段 |
| F-13 | 移除 sentinel 後自動跳過 REVIEW、TEST |
| F-14 | task-guard 在有未完成 todo 時阻擋退出 |
| F-15 | task-guard 達 5 次阻擋後強制放行 |
| F-16 | `/flow:cancel` 可手動解除 task-guard |

---

## 10. plugin.json

```json
{
  "name": "flow",
  "version": "0.1.0",
  "description": "開發工作流 — 規劃、架構、compact、pipeline 管理、環境偵測",
  "skills": ["./skills/"],
  "agents": [
    "./agents/planner.md",
    "./agents/architect.md",
    "./agents/developer.md"
  ],
  "pipeline": {
    "PLAN": { "agent": "planner",   "skill": "/flow:plan" },
    "ARCH": { "agent": "architect",  "skill": "/flow:architect" },
    "DEV":  { "agent": "developer",  "skill": null }
  }
}
```
