# Pipeline 委派架構

> **定位**：Agent Pipeline 的完整設計規格 — 任務分類、階段轉換、跨 plugin 解耦、使用者可見文字
> **擁有者**：flow plugin（pipeline 順序 + 轉換邏輯）
> **協作者**：各 plugin 透過 `pipeline.json` 的 `provides` 欄位自行宣告
> **中央參考**：任何影響工作流的變動都與此文件相關 — 新增/移除 agent、調整 stage、修改 plugin 組合時，必須回來更新此文件

---

## 0. 變動影響範圍

Pipeline 是 Vibe marketplace 的骨幹。以下變動都需要回來檢查此文件：

| 變動類型 | 影響範圍 |
|---------|---------|
| 新增 agent | 對應 plugin 的 `pipeline.json.provides` 宣告 |
| 新增 pipeline stage | `pipeline.json` 的 `stages` 順序 |
| 新增/移除 plugin | 自動生效（動態發現），但需確認 `pipeline.json` 的 `provides` 欄位 |
| 修改 agent 名稱 | 對應 plugin 的 `pipeline.json.provides` 宣告 |
| 修改使用者可見文字 | 本文件 §5 + Claude 行為模式 |
| 修改 dashboard | `dashboard/scripts/generate.js` 的 pipeline 視覺化 |

**連動清單**（改 pipeline 時需一併檢查）：

```
docs/ref/pipeline.md          ← 本文件（規格）
docs/ref/flow.md              ← flow plugin 設計文件
docs/ref/{plugin}.md          ← 受影響 plugin 的設計文件
docs/plugin-specs.json         ← 數量統計
dashboard/scripts/generate.js  ← pipeline 視覺化
plugins/flow/pipeline.json     ← stage 順序定義
plugins/*/pipeline.json         ← 各 plugin 的 pipeline 宣告（provides 欄位）
```

---

## 1. 核心決策

| 決策 | 結論 | 原因 |
|------|------|------|
| Orchestrator agent | **不需要** | Sub-agent 無法再生 sub-agent，hooks 已足夠 |
| 委派方式 | **A+D 方案**（hooks-only） | 4 層防禦，無需額外 agent |
| 規則存放 | **全部在 hooks 內**，不依賴 CLAUDE.md | Plugin 可攜性 — 別人裝了就生效 |
| 跨 plugin 耦合 | **靜態順序 + 動態發現** | flow 管順序，各 plugin 自己宣告 agent |
| Pipeline 配置 | `pipeline.json`（flow 管順序）+ 各 plugin 的 `pipeline.json.provides` | 零人工維護，安裝/移除自動生效 |

---

## 2. 四層防禦機制

```
使用者送出訊息
    │
    ▼
┌─────────────────────────────────────────┐
│ ① task-classifier（UserPromptSubmit）    │  ← 軟建議：分類 + 建議階段
│    prompt hook · haiku · 10s            │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ ② pipeline-rules（SessionStart）         │  ← 軟建議：注入委派規則
│    command hook · 10s · state file 防重複│
└─────────────────────────────────────────┘
    │
    ▼
  Main Agent 委派 sub-agent 執行
    │
    ▼
┌─────────────────────────────────────────┐
│ ③ stage-transition（SubagentStop）       │  ← 強建議：完成 → 下一步
│    command hook · 10s                   │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ ④ pipeline-check（Stop）                 │  ← 強建議：檢查遺漏階段
│    command hook · 10s                   │
└─────────────────────────────────────────┘
```

### 各層詳細

| # | 名稱 | 事件 | 類型 | 強度 | 輸出管道 | 說明 |
|:-:|------|------|:----:|:----:|:--------:|------|
| ① | task-classifier | UserPromptSubmit | prompt | 軟建議 | additionalContext | 分類任務類型，建議 pipeline 階段 |
| ② | pipeline-rules | SessionStart | command | 軟建議 | additionalContext | 注入委派規則（哪些工作該給 sub-agent） |
| ③ | stage-transition | SubagentStop | command | 強建議 | systemMessage | Agent 完成後判斷：前進/回退/跳過 |
| ④ | pipeline-check | Stop | command | 強建議 | systemMessage | 結束前檢查是否有遺漏的建議階段 |

### 輸出管道差異

| 管道 | 誰看得到 | 強度 | 用途 |
|------|:--------:|:----:|------|
| `additionalContext` | 只有 Claude | 軟 | 背景知識、建議（Claude 可忽略） |
| `systemMessage` | 只有 Claude | 強 | 系統級指令（Claude 幾乎不會忽略） |
| `statusMessage` | 使用者（狀態列） | — | 進度提示（純 UI） |
| `stderr`（exit 0） | 使用者（終端） | — | 動態警告/提醒 |
| `stderr`（exit 2） | 使用者（終端） | 硬阻擋 | 阻止工具執行 |

---

## 3. 跨 Plugin 解耦方案

### 3.1 flow 擁有 pipeline 順序（靜態，幾乎不需更新）

```json
// plugins/flow/pipeline.json
{
  "stages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "stageLabels": {
    "PLAN": "規劃",
    "ARCH": "架構",
    "DEV": "開發",
    "REVIEW": "審查",
    "TEST": "測試",
    "QA": "行為驗證",
    "E2E": "端對端測試",
    "DOCS": "文件整理"
  },
  "provides": {
    "PLAN": { "agent": "planner",   "skill": "/flow:plan" },
    "ARCH": { "agent": "architect",  "skill": "/flow:architect" },
    "DEV":  { "agent": "developer",  "skill": null }
  }
}
```

> flow 的 `pipeline.json` 同時包含全域定義（`stages` + `stageLabels`）和自身提供的 stages（`provides`）。其他 plugin 只需 `provides` 欄位。只有在**新增全新的 pipeline stage** 時才需要修改 `stages`。

### 3.2 各 plugin 自行宣告 pipeline 位置

在 plugin 根目錄放置 `pipeline.json`，透過 `provides` 欄位宣告此 plugin 提供的 pipeline stages：

> **重要**：pipeline 資料放在獨立的 `pipeline.json` 而非 `plugin.json`，因為 Claude Code 的 `plugin.json` schema 嚴格驗證，不允許自定義欄位（Unrecognized key 錯誤）。

**flow**（`plugins/flow/pipeline.json`）：

```json
{
  "stages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "stageLabels": { ... },
  "provides": {
    "PLAN": { "agent": "planner",   "skill": "/flow:plan" },
    "ARCH": { "agent": "architect",  "skill": "/flow:architect" },
    "DEV":  { "agent": "developer",  "skill": null }
  }
}
```

**sentinel**（`plugins/sentinel/pipeline.json`）：

```json
{
  "provides": {
    "REVIEW": { "agent": "code-reviewer",  "skill": "/sentinel:review" },
    "TEST":   { "agent": "tester",          "skill": "/sentinel:tdd" },
    "QA":     { "agent": "qa",              "skill": "/sentinel:qa" },
    "E2E":    { "agent": "e2e-runner",      "skill": "/sentinel:e2e" }
  }
}
```

**evolve**（`plugins/evolve/pipeline.json`）：

```json
{
  "provides": {
    "DOCS": { "agent": "doc-updater",  "skill": "/evolve:doc-sync" }
  }
}
```

> flow 的 `pipeline.json` 同時包含 `stages`（順序）和 `provides`（自己提供的 stages）。其他 plugin 只需 `provides` 欄位。

### 3.3 Runtime 動態發現邏輯

```js
// scripts/lib/pipeline-discovery.js — 共用模組
'use strict';
const fs = require('fs');
const path = require('path');

function discoverPipeline() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginsDir = path.join(pluginRoot, '..');

  // 讀取 flow 的 stage 順序
  const pipelineConfig = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, 'pipeline.json'), 'utf8')
  );

  const stageMap = {};      // stage → { agent, skill, plugin }
  const agentToStage = {};  // agent name → stage name

  // 掃描所有已安裝 plugin 的 pipeline.json
  for (const dir of fs.readdirSync(pluginsDir)) {
    const pipePath = path.join(pluginsDir, dir, 'pipeline.json');
    if (!fs.existsSync(pipePath)) continue;

    const pipeFile = JSON.parse(fs.readFileSync(pipePath, 'utf8'));
    if (!pipeFile.provides) continue;

    // 讀取 plugin 名稱（用於標記來源）
    let pluginName = dir;
    const pjPath = path.join(pluginsDir, dir, '.claude-plugin', 'plugin.json');
    try {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      pluginName = pj.name || dir;
    } catch (_) {}

    for (const [stage, config] of Object.entries(pipeFile.provides)) {
      stageMap[stage] = { ...config, plugin: pluginName };
      if (config.agent) agentToStage[config.agent] = stage;
    }
  }

  return {
    stageOrder: pipelineConfig.stages,
    stageLabels: pipelineConfig.stageLabels,
    stageMap,
    agentToStage,
  };
}

// 查找下一個「已安裝」的 stage
function findNextStage(stageOrder, stageMap, currentStage) {
  const idx = stageOrder.indexOf(currentStage);
  for (let i = idx + 1; i < stageOrder.length; i++) {
    if (stageMap[stageOrder[i]]) return stageOrder[i];
  }
  return null; // pipeline 結束
}

module.exports = { discoverPipeline, findNextStage };
```

### 3.4 安裝組合與 Graceful Degradation

| 安裝組合 | 實際 pipeline |
|---------|--------------|
| 只裝 flow | PLAN → ARCH → DEV |
| flow + sentinel | PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E |
| flow + evolve | PLAN → ARCH → DEV → DOCS |
| 全裝 | PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E → DOCS |
| 移除 sentinel | 自動跳過 REVIEW、TEST、QA、E2E，無需改任何 config |
| 純 API + 全裝 | PLAN → ARCH → DEV → REVIEW → TEST → QA → ~~E2E~~ → DOCS（智慧跳過） |

---

## 4. Hook 實作規格

### 4.1 task-classifier（UserPromptSubmit · prompt hook）

**無需 script** — 純 prompt hook，ECC 原生處理。

hooks.json 定義：

```json
{
  "hooks": [{
    "type": "prompt",
    "prompt": "Classify this user request into exactly one type.\n\nTypes:\n- research: read-only exploration, questions, understanding code\n- quickfix: trivial change (rename, color, typo) — 1-2 files\n- bugfix: fix specific broken behavior — needs verification\n- feature: new capability — needs planning, architecture, full pipeline\n- refactor: restructure existing code — needs architecture review\n- test: add or fix tests only\n- docs: documentation only\n- tdd: user explicitly requested TDD workflow\n\nStage mappings:\n- research: []\n- quickfix: [\"DEV\"]\n- bugfix: [\"DEV\", \"TEST\"]\n- feature: [\"PLAN\", \"ARCH\", \"DEV\", \"REVIEW\", \"TEST\", \"DOCS\"]\n- refactor: [\"ARCH\", \"DEV\", \"REVIEW\"]\n- test: [\"TEST\"]\n- docs: [\"DOCS\"]\n- tdd: [\"TEST\", \"DEV\", \"REVIEW\"]\n\nRespond with ONLY this JSON: {\"decision\":\"allow\",\"type\":\"...\",\"stages\":[...]}",
    "model": "haiku",
    "timeout": 10
  }]
}
```

> **Prompt hook 回應格式**：必須包含 `decision` 欄位（`"allow"` 放行）。
> 其餘欄位（`type`、`stages`）作為 `additionalContext` 注入，供 Claude 參考。

### 4.2 pipeline-rules（SessionStart · 合併在 pipeline-init.js）

合併在 `pipeline-init.js` 中，在環境偵測的同時注入 pipeline 規則。

> **Note**：跨 session context 載入由 claude-mem 的 SessionStart hook 獨立處理。

**輸出**：JSON `{ "additionalContext": "..." }`

#### Claude 看到的 additionalContext 內容（動態產生）：

```
[Pipeline 委派規則]
程式碼變更應透過對應的 sub-agent 執行，而非 Main Agent 直接處理：
- 規劃：planner（/flow:plan）
- 架構：architect（/flow:architect）
- 開發：developer
- 審查：code-reviewer（/sentinel:review）
- 測試：tester（/sentinel:tdd）
- 文件：doc-updater（/evolve:doc-sync）
task-classifier 會建議需要的階段，請依建議執行。
未安裝的 plugin 對應的階段可以跳過。
```

> 上方清單由 `discoverPipeline()` 動態產生，反映實際安裝的 plugin。

### 4.3 stage-transition（SubagentStop · command hook）

**腳本**：`scripts/hooks/stage-transition.js`

hooks.json 定義：

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

**輸入**（stdin JSON）：

```json
{
  "stop_hook_active": false,
  "agent_id": "...",
  "agent_type": "developer",
  "agent_transcript_path": "..."
}
```

**邏輯**（v0.3.0 — 含智慧回退/跳過/context 注入）：

1. `stop_hook_active === true` → exit 0（防無限迴圈，必須第一步檢查）
2. `discoverPipeline()` 動態載入 pipeline 配置
3. `agentToStage[agent_type]` 查找所屬 stage
4. `parseVerdict(agent_transcript_path)` 從 transcript JSONL 解析 `PIPELINE_VERDICT` 標記
5. `shouldRetryStage()` 判斷是否需要回退
6. **回退路徑**：品質階段 FAIL:CRITICAL/HIGH → 回到 DEV → 重試同一品質階段
7. **前進路徑**：智慧跳過判斷 → 階段 context 注入 → 指示下一步
8. 更新 state file（含 `stageResults`、`retries`）
9. 輸出 `{ "continue": true, "systemMessage": "..." }`

**智慧回退機制**：

| 條件 | 行為 |
|------|------|
| PIPELINE_VERDICT: PASS | 正常前進 |
| PIPELINE_VERDICT: FAIL:CRITICAL/HIGH | 回退到 DEV 修復後重試 |
| PIPELINE_VERDICT: FAIL:MEDIUM/LOW | 正常前進（只是建議） |
| 無 VERDICT | 正常前進（graceful degradation） |
| 回退次數 ≥ MAX_RETRIES | 強制前進 + 警告 |

- 每個品質階段（REVIEW/TEST/QA/E2E）有獨立的回退計數器
- 預設上限 3 輪（`CLAUDE_PIPELINE_MAX_RETRIES` 環境變數可覆寫）

**智慧跳過**：
- 純 API 框架（express/fastify/hono/koa/nest）自動跳過 E2E 階段
- 基於 `state.environment.framework.name` 判斷

**階段 context 注入**：
- QA → 強調 API/CLI 行為正確性，不寫測試碼
- E2E（UI 專案）→ 強調瀏覽器使用者流程
- E2E（API 專案）→ 強調跨步驟資料一致性

**PIPELINE_VERDICT 協議**：sentinel agents 在報告末尾輸出 HTML comment 標記：

```
<!-- PIPELINE_VERDICT: PASS -->
<!-- PIPELINE_VERDICT: FAIL:CRITICAL -->
<!-- PIPELINE_VERDICT: FAIL:HIGH -->
<!-- PIPELINE_VERDICT: FAIL:MEDIUM -->
<!-- PIPELINE_VERDICT: FAIL:LOW -->
```

stage-transition 從 `agent_transcript_path`（JSONL）最後 20 行中搜尋此標記。

**State file**：`~/.claude/pipeline-state-{sessionId}.json`

> 使用 session ID 區分，避免多視窗同時使用時 state 互相覆蓋。
> `sessionId` 從 hook stdin 的 `session_id` 取得。

```json
{
  "sessionId": "abc123",
  "initialized": true,
  "completed": ["planner", "architect", "developer"],
  "expectedStages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "stageResults": {
    "REVIEW": { "verdict": "FAIL", "severity": "HIGH" },
    "TEST": { "verdict": "PASS", "severity": null }
  },
  "retries": { "REVIEW": 1 },
  "lastTransition": "2026-02-09T14:30:00Z"
}
```

#### Claude 看到的 systemMessage 內容：

**正常前進**：

```
⚠️ [Pipeline 指令] developer 已完成（開發階段）。
你**必須立即**執行下一階段：REVIEW（審查）。
➡️ 執行方法：使用 Skill 工具呼叫 /sentinel:review
⛔ Pipeline 自動模式：不要使用 AskUserQuestion，完成後直接進入下一階段。
已完成：PLAN → ARCH → DEV
```

**智慧回退**：

```
🔄 [Pipeline 回退] code-reviewer 完成（審查階段），但發現 HIGH 等級問題。
回退原因：HIGH 等級問題需要修復
回退次數：1/3

你**必須**執行以下步驟：
1️⃣ 先回到 DEV 階段修復 HIGH 等級問題 → 使用 Task 工具委派給 developer agent
2️⃣ 修復完成後重新執行 REVIEW（審查）→ 使用 Skill 工具呼叫 /sentinel:review

⛔ Pipeline 自動模式：不要使用 AskUserQuestion，修復後直接重新執行品質檢查。
已完成：PLAN → ARCH → DEV → REVIEW
```

**Pipeline 結束**：

```
✅ [Pipeline 完成] e2e-runner 已完成（端對端測試階段）。
所有階段已完成：PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E
向使用者報告成果。
```

不認識的 agent（不在任何 plugin 的 pipeline 宣告中）→ exit 0，不輸出。

### 4.4 pipeline-check（Stop · command hook · 強建議）

**腳本**：`scripts/hooks/pipeline-check.js`

hooks.json 定義：

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

**輸入**（stdin JSON）：`{ "stop_hook_active": false }`

**邏輯**：

1. `stop_hook_active === true` → exit 0
2. 讀取 state file，不存在 → exit 0（沒有進行中的 pipeline）
3. 比較 `expectedStages` vs 已完成的 stages
4. 有遺漏 → 輸出 `systemMessage`
5. 全完成或無 pipeline → 清理 state file → exit 0

#### Claude 看到的 systemMessage 內容（有遺漏時）：

```
[Pipeline 提醒] 以下建議階段尚未執行：REVIEW, TEST
已完成：PLAN → ARCH → DEV
如果是刻意跳過，請向使用者說明原因。
```

全完成或無 pipeline → 不輸出任何 systemMessage。

### 4.5 task-guard（Stop · command hook · 絕對阻擋）

**腳本**：`scripts/hooks/task-guard.js`

**定位**：吸納自 ralph-wiggum plugin 的 Stop hook blocking 技術。與 pipeline-check 互補 — pipeline-check 用 systemMessage 建議；task-guard 用 `decision: "block"` 強制阻擋。

hooks.json 定義：

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

**State file**：`~/.claude/task-guard-state-{sessionId}.json`

```json
{
  "blockCount": 0,
  "maxBlocks": 5,
  "cancelled": false,
  "activatedAt": "2026-02-09T14:30:00Z"
}
```

> `maxBlocks` 可透過環境變數 `CLAUDE_TASK_GUARD_MAX_BLOCKS` 覆寫。

**TodoWrite 狀態讀取**：Hook stdin 不含 TodoWrite 資訊。task-guard 透過 `transcript_path` 讀取對話紀錄 JSONL，解析最後一次 TodoWrite 呼叫的 `input.todos` 陣列來判斷任務狀態。

**完成判定**：transcript 中最後一次 TodoWrite 的 todos 陣列全部為 `completed`。無 TodoWrite 記錄時不阻擋。

**邏輯**：

```
Stop 觸發
  1. stop_hook_active === true → exit 0（防迴圈）
  2. 讀取 transcript，找最後一次 TodoWrite
  3. 無 TodoWrite → exit 0（無任務追蹤）
  4. state 存在且 cancelled === true → cleanup + exit 0（/flow:cancel 手動取消）
  5. state 存在且 blockCount >= maxBlocks → cleanup + exit 0 + 警告（安全閥）
  6. TodoWrite 全部 completed → cleanup + exit 0（任務完成）
  7. 否則 → blockCount++ → 輸出 block
```

**Block 輸出**：

```json
{
  "decision": "block",
  "reason": "繼續完成未完成的任務",
  "systemMessage": "⚠️ 任務尚未完成（第 2/5 次阻擋）\n\n未完成項目：\n- [ ] 撰寫單元測試\n- [ ] 執行 lint 檢查\n\n請繼續完成以上項目。如果確實無法繼續，請告知使用者原因。"
}
```

**Counter 規則**：
- 只有 Stop hook 實際 block 時才 +1（agent 切換不計入）
- 完成或取消時歸零 + 清理 state file
- 5 次上限（可透過 `CLAUDE_TASK_GUARD_MAX_BLOCKS` 環境變數覆寫）= Claude 嘗試停止 5 次都被擋回去，第 6 次無條件放行

**手動取消**：`/flow:cancel` skill 設定 `cancelled: true` → 下次 Stop hook 放行。

**Scope Creep 處理**：不限制。Claude 中途加 todo → guard 持續有效。安全閥（5 次）防止真正的無限迴圈。

**Stop ≠ Session 結束**：Stop 只是 Claude 結束當前回合，session 依然開著。使用者可以繼續輸入新需求 → 新的 TodoWrite → task-guard 重新啟動。

---

## 5. 使用者可見文字規範

Pipeline hooks 的 systemMessage / additionalContext **對使用者不可見**。
使用者能感知到的只有以下兩類：

### 5.1 statusMessage（狀態列 — 短暫顯示）

| Hook | statusMessage |
|------|--------------|
| session-start（含 pipeline-rules） | `載入工作環境...` |
| stage-transition | `處理 pipeline 轉換...` |
| pipeline-check | `檢查工作完整性...` |

### 5.2 Claude 的自然語言回應（間接可見）

Claude 收到 systemMessage 後會用自然語言向使用者報告。
以下是期望的行為模式（非硬性規定，但 systemMessage 強度夠高，Claude 幾乎都會遵循）：

**Agent 完成，有下一步時：**

> developer 完成了開發階段的工作。
> 接下來建議進行程式碼審查（REVIEW），我可以使用 `/sentinel:review` 啟動。
> 要繼續嗎？

**結束前發現遺漏時：**

> 本次工作大致完成，但 task-classifier 建議的 REVIEW 和 TEST 階段尚未執行。
> 這些階段可以幫助確保程式碼品質。要跳過還是繼續？

**Pipeline 完整結束時：**

> 所有階段都已完成（PLAN → ARCH → DEV → REVIEW → TEST → DOCS）。
> 以下是本次工作摘要：...

---

## 6. 實作檔案清單

### 新建

| 優先 | 檔案 | 說明 |
|:----:|------|------|
| 1 | `plugins/flow/pipeline.json` | Stage 順序定義 |
| 2 | `plugins/flow/scripts/lib/pipeline-discovery.js` | 共用掃描邏輯（§3.3） |
| 3 | `plugins/flow/scripts/hooks/stage-transition.js` | SubagentStop hook（§4.3） |
| 4 | `plugins/flow/scripts/hooks/pipeline-check.js` | Stop hook（§4.4） |
| 5 | `plugins/flow/scripts/hooks/task-guard.js` | Stop hook — 任務鎖定（§4.5） |

### 修改

| 優先 | 檔案 | 變動 |
|:----:|------|------|
| 5 | `plugins/flow/scripts/hooks/pipeline-init.js` | 環境偵測 + pipeline-rules 注入（§4.2） |
| 6 | `plugins/flow/hooks/hooks.json` | 新增 SubagentStop、Stop 兩個 hook 定義 |
| 7 | `plugins/flow/pipeline.json` | `provides` 欄位（flow 同時有 `stages`） |
| 8 | `plugins/sentinel/pipeline.json` | `provides` 欄位 |
| 9 | `plugins/evolve/pipeline.json` | `provides` 欄位 |
| 10 | `docs/ref/flow.md` | Skills 6、Hooks 7（移除 session）、Scripts 9（移除 session）、驗收 16 條 |
| 11 | `docs/plugin-specs.json` | flow hooks 7、scripts 9；evolve hooks 0、scripts 0 |
| 12 | `dashboard/scripts/generate.js` | Pipeline 視覺化同步更新 |

### flow.md 具體更新

> **已完成** — 以下變更已直接套用到 `docs/ref/flow.md`。

**Skills**：5→6（+`cancel`）

**Hooks 表格**新增 3 行：

| 事件 | 名稱 | 類型 | 強度 | 說明 |
|------|------|:----:|:----:|------|
| SubagentStop | stage-transition | command | 強建議 | Agent 完成後建議下一個 pipeline 階段 |
| Stop | pipeline-check | command | 強建議 | 結束前檢查是否有遺漏的建議階段 |
| Stop | task-guard | command | 絕對阻擋 | 未完成任務時阻擋退出 |

**Scripts 表格**新增 4 行：

| 腳本 | 位置 | 功能 |
|------|------|------|
| `stage-transition.js` | `scripts/hooks/` | Pipeline 階段轉換 + state 管理 |
| `pipeline-check.js` | `scripts/hooks/` | 結束前遺漏階段檢查 |
| `task-guard.js` | `scripts/hooks/` | 任務完成前阻擋退出 |
| `pipeline-discovery.js` | `scripts/lib/` | 跨 plugin pipeline 動態發現 |

**驗收標準**新增 8 條（F-09 ~ F-16）：

| # | 條件 |
|:-:|------|
| F-09 | stage-transition 在 agent 完成後建議下一步 |
| F-10 | pipeline-check 偵測遺漏階段並提醒 |
| F-11 | 只裝 flow 時 pipeline 只含 PLAN → ARCH → DEV |
| F-12 | 全裝時 pipeline 含完整 6 個階段 |
| F-13 | 移除 sentinel 後自動跳過 REVIEW、TEST |
| F-14 | task-guard 在有未完成 todo 時阻擋退出 |
| F-15 | task-guard 達 5 次阻擋後強制放行 |
| F-16 | `/flow:cancel` 可手動解除 task-guard |

### plugin-specs.json 更新

```json
"flow": {
  "expected": {
    "skills": ["plan", "architect", "compact", "checkpoint", "env-detect", "cancel"],
    "hooks": 7,
    "scripts": 9
  }
}
```

---

## 7. 並行執行架構

### 7.1 核心限制

| 限制 | 說明 |
|------|------|
| 前景 Sub-agent | 同一時間只能有 **1 個**前景 sub-agent |
| 背景 Sub-agent | 可多個，透過 Task 工具的 `run_in_background: true` 啟動 |
| SubagentStop | **只有前景 sub-agent** 結束時才觸發 |
| statusMessage | 背景 sub-agent 的 hook **不會**顯示 statusMessage |
| 輸出取回 | 背景 sub-agent 結果需透過 Read 工具讀取 `output_file` |

### 7.2 並行宣告（pipeline.json 擴充）

在 `pipeline.json` 新增 `parallel` 欄位，在設計時就決定哪些階段可以並行：

```json
{
  "stages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST", "DOCS"],
  "parallel": {
    "REVIEW+TEST": {
      "stages": ["REVIEW", "TEST"],
      "description": "審查和測試可同時進行",
      "foreground": "REVIEW",
      "background": ["TEST"]
    }
  }
}
```

**規則**：
- `foreground`：佔前景的 stage（觸發 SubagentStop）
- `background`：背景執行的 stages（不觸發 SubagentStop）
- 未宣告在 `parallel` 中的 stage 預設串行執行

### 7.3 agent-tracker Hook（提案）

**問題**：hooks 無法原生得知「哪個 agent 正在做什麼」。SubagentStop 只告訴你「某個 agent 結束了」，PreToolUse/PostToolUse 不含 agent 資訊。

**方案**：在 PreToolUse 上監聽 Task 工具呼叫，追蹤 agent 生命週期。

```
事件：PreToolUse（matcher: "Task"）
觸發：每次 Task 工具被呼叫時
```

**追蹤邏輯**：
1. 攔截 Task 工具的輸入參數（含 `subagent_type`、`description`、`run_in_background`）
2. 寫入 `pipeline-state.json` 的 `activeAgents` 陣列
3. 搭配 SubagentStop（前景）和定期檢查 output_file（背景）更新狀態

**擴充 pipeline-state.json**：

```json
{
  "completed": ["planner", "architect"],
  "expectedStages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST"],
  "activeAgents": [
    {
      "type": "developer",
      "stage": "DEV",
      "background": false,
      "startedAt": "2026-02-09T15:00:00Z"
    },
    {
      "type": "tester",
      "stage": "TEST",
      "background": true,
      "outputFile": "/tmp/claude-agent-xxx.jsonl",
      "startedAt": "2026-02-09T15:00:05Z"
    }
  ],
  "lastTransition": "2026-02-09T15:00:00Z"
}
```

### 7.4 stage-transition 並行群組完成偵測

當使用並行執行時，stage-transition 需要增強：

```
SubagentStop 觸發（前景 agent 完成）
  1. 標記該 agent 為 completed
  2. 檢查是否屬於 parallel group
  3. 是 → 檢查 group 內所有 agents 是否都完成
     - 前景：SubagentStop 自動偵測
     - 背景：檢查 output_file 是否存在最終輸出
  4. 群組全部完成 → 建議下一個 stage
  5. 群組部分完成 → systemMessage 報告進度，等待剩餘
```

### 7.5 statusMessage 可見性規則

| 情境 | statusMessage 可見？ | 原因 |
|------|:-------------------:|------|
| 前景 agent 的 hook | ✅ | 正常 hook 流程 |
| 背景 agent 的 hook | ❌ | 背景 agent 無 UI 管道 |
| Stop hook（主 agent） | ✅ | 狀態列正常運作 |
| SubagentStop hook | ✅ | 前景 agent 結束時觸發 |
| SessionStart hook | ✅ | Session 開始時觸發 |

### 7.6 V1 策略：全串行

**初期實作不需並行**。所有 pipeline 階段串行執行：

```
PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E → DOCS
 │       │      │      │       │     │     │      │
 └───────┴──────┴──────┴───────┴─────┴─────┴──────┘
         全部前景，逐一執行（含智慧回退 + 智慧跳過）
```

**V1 已包含**：
- SubagentStop 正常運作
- 智慧回退（品質階段失敗 → DEV → 重試，每階段最多 3 輪）
- 智慧跳過（純 API 專案自動跳過 E2E 瀏覽器測試）
- 階段 context 注入（QA/E2E 各有專屬提示）
- statusMessage 全部可見
- 不需 agent-tracker hook

**並行執行留待 V2**：當串行版本穩定後，再啟用 `parallel` 欄位 + agent-tracker。