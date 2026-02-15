# Pipeline 委派架構

> **定位**：Agent Pipeline 的完整設計規格 — 任務分類、階段轉換、跨 plugin 解耦、使用者可見文字
> **擁有者**：vibe plugin / flow 模組（pipeline 順序 + 轉換邏輯）
> **協作者**：統一在 `pipeline.json` 的 `provides` 欄位宣告
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
docs/ref/vibe.md              ← vibe plugin 設計文件（自動生成）
docs/plugin-specs.json         ← 數量統計
dashboard/scripts/generate.js  ← pipeline 視覺化
plugins/vibe/pipeline.json     ← stage 順序 + provides 統一定義
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
│    command hook                         │
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
| ① | task-classifier | UserPromptSubmit | command | 軟→強 | additionalContext / systemMessage | 分類任務類型 + 按需注入委派規則 |
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

## 3. 統一 Pipeline 定義

### 3.1 統一 pipeline.json（所有 stages + provides 集中在一個檔案）

```json
// plugins/vibe/pipeline.json
{
  "stages": ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
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
    "PLAN":   { "agent": "planner",        "skill": "/vibe:scope" },
    "ARCH":   { "agent": "architect",      "skill": "/vibe:architect" },
    "DEV":    { "agent": "developer",      "skill": null },
    "REVIEW": { "agent": "code-reviewer",  "skill": "/vibe:review" },
    "TEST":   { "agent": "tester",         "skill": "/vibe:tdd" },
    "QA":     { "agent": "qa",             "skill": "/vibe:qa" },
    "E2E":    { "agent": "e2e-runner",     "skill": "/vibe:e2e" },
    "DOCS":   { "agent": "doc-updater",    "skill": "/vibe:doc-sync" }
  }
}
```

> 所有 stage 定義（`stages` + `stageLabels`）和 agent 映射（`provides`）統一在 `plugins/vibe/pipeline.json`。只有在**新增全新的 pipeline stage** 時才需要修改 `stages`。

### 3.2 pipeline.json 設計原則

> **重要**：pipeline 資料放在獨立的 `pipeline.json` 而非 `plugin.json`，因為 Claude Code 的 `plugin.json` schema 嚴格驗證，不允許自定義欄位（Unrecognized key 錯誤）。

`pipeline-discovery.js` 仍支援動態掃描多 plugin 的 `pipeline.json`，確保未來擴展性（如新增獨立 plugin 可宣告自己的 `provides`）。

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
| 只裝 flow | PLAN → ARCH → DESIGN → DEV |
| flow + sentinel | PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E |
| flow + evolve | PLAN → ARCH → DESIGN → DEV → DOCS |
| 全裝 | PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS |
| 移除 sentinel | 自動跳過 REVIEW、TEST、QA、E2E，無需改任何 config |
| 純 API + 全裝 | PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → ~~E2E~~ → DOCS（智慧跳過） |

---

## 4. Hook 實作規格

### 4.1 task-classifier（UserPromptSubmit · command hook）

**腳本**：`scripts/hooks/task-classifier.js`

關鍵字分類（7 類型），保守預設（quickfix），feature 需正向匹配：

```
research / quickfix / bugfix / feature / refactor / test / tdd
```

Stage 對應：

| 類型 | 階段 |
|------|------|
| research | （空） |
| quickfix | DEV |
| bugfix | DEV → TEST |
| feature | PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS |
| refactor | ARCH → DEV → REVIEW |
| test | TEST |
| tdd | TEST → DEV → REVIEW |

首次分類為開發型任務（feature/refactor/tdd）時，透過 `systemMessage` 注入完整 pipeline 委派規則。
支援中途重新分類（漸進式升級）：升級時合併階段，降級時阻擋以保持 pipeline 不中斷。

**知識 Skills 自動注入**（v1.0.21）：

讀取 `state.environment`（由 pipeline-init 的 env-detect 寫入），根據語言/框架自動注入對應的知識 skills 參考：

| 偵測結果 | 注入的 Skill |
|---------|-------------|
| TypeScript | `/vibe:typescript-patterns` |
| Python | `/vibe:python-patterns` |
| Go | `/vibe:go-patterns` |
| React/Vue/Next.js/Svelte/Angular | `/vibe:frontend-patterns` |
| Express/Fastify/Hono | `/vibe:backend-patterns` |
| 任何語言偵測 | `/vibe:coding-standards` + `/vibe:testing-patterns` |

注入位置：systemMessage（feature/refactor/tdd）或 additionalContext（其他分類）的「可用知識庫」區塊。

### 4.2 pipeline-rules（SessionStart · 合併在 pipeline-init.js）

合併在 `pipeline-init.js` 中，在環境偵測的同時注入 pipeline 規則。

> **Note**：跨 session context 載入由 claude-mem 的 SessionStart hook 獨立處理。

**輸出**：JSON `{ "additionalContext": "..." }`

#### Claude 看到的 additionalContext 內容（動態產生）：

```
[Pipeline 委派規則]
程式碼變更應透過對應的 sub-agent 執行，而非 Main Agent 直接處理：
- 規劃：planner（/vibe:scope）
- 架構：architect（/vibe:architect）
- 開發：developer
- 審查：code-reviewer（/vibe:review）
- 測試：tester（/vibe:tdd）
- 文件：doc-updater（/vibe:doc-sync）
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

**邏輯**（v1.0.21 — 含智慧回退/重驗/跳過/context 注入/自動 enforce/自動檢查點/階段提示）：

1. `stop_hook_active === true` → exit 0（防無限迴圈，必須第一步檢查）
2. `discoverPipeline()` 動態載入 pipeline 配置
3. `agentToStage[agent_type]` 查找所屬 stage
4. `parseVerdict(agent_transcript_path)` 從 transcript JSONL 解析 `PIPELINE_VERDICT` 標記
5. `shouldRetryStage()` 判斷是否需要回退
6. **自動 enforce**：下一階段為 DEV+ 且 `pipelineEnforced=false` → 自動升級（見下方說明）
7. **回退路徑**：品質階段 FAIL:CRITICAL/HIGH → 設定 `pendingRetry` 標記 → 回到 DEV
8. **回退重驗路徑**：DEV 完成且 `pendingRetry` 存在 → 消費標記 → 強制重跑原品質階段
9. **前進路徑**：智慧跳過判斷 → 階段 context 注入 + POST_STAGE_HINTS 注入 → 指示下一步
10. 更新 state file（含 `stageResults`、`retries`、`pendingRetry`、`pipelineEnforced`）
11. **自動檢查點**（v1.0.21）：非回退時，建立 `git tag -f vibe-pipeline/{stage}` 標記
12. 輸出 `{ "continue": true, "systemMessage": "..." }`

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

**回退重驗機制**（v1.0.6）：

回退流程使用 `pendingRetry` 狀態標記確保 DEV 修復後**必定重跑品質檢查**，不會跳到後續階段：

```
REVIEW FAIL:CRITICAL
  → 設定 pendingRetry = { stage: "REVIEW", severity: "CRITICAL", round: 1 }
  → systemMessage: "回退到 DEV 修復"
DEV 完成修復
  → 偵測 pendingRetry 存在 + currentStage === DEV
  → 消費 pendingRetry 標記
  → systemMessage: "回退重驗 — 重新執行 REVIEW"（專用訊息，與正常前進不同）
REVIEW 重跑
  → PASS → 正常前進到 TEST
  → FAIL → 再次回退（retries +1）
```

三分支判斷順序：`shouldRetry`（回退）→ `pendingRetry && DEV`（回退重驗）→ `else`（正常前進）

**自動 Pipeline Enforce**（v1.0.16）：

修補手動觸發 `/vibe:scope` + `/vibe:architect` 時 task-classifier 未分類為 feature 的缺口。
當 stage-transition 判斷下一階段為 DEV 或更後面（REVIEW/TEST/QA/E2E/DOCS）且 `pipelineEnforced=false` 時，自動升級：

```
if nextStage ∈ [DEV, REVIEW, TEST, QA, E2E, DOCS] && !pipelineEnforced:
  1. pipelineEnforced → true
  2. taskType: quickfix/research → feature
  3. expectedStages: 不含 REVIEW → 補全為完整 pipeline
```

這確保即使使用者用「開始規劃」等語句（task-classifier 無法匹配為 feature），手動走完 PLAN → ARCH 後，pipeline-guard 仍會正確阻擋 Main Agent 直接寫碼。

**自動檢查點**（v1.0.21）：

每個階段正常完成（非回退）後，自動建立輕量 git tag 作為可回溯的檢查點：

```js
function autoCheckpoint(stage, sessionId) {
  try {
    const tagName = `vibe-pipeline/${stage.toLowerCase()}`;
    execSync(`git tag -f "${tagName}"`, { stdio: 'pipe', timeout: 5000 });
  } catch (_) {} // 靜默失敗（不影響 pipeline 流程）
}
```

- Tag 格式：`vibe-pipeline/{stage}`（如 `vibe-pipeline/dev`、`vibe-pipeline/review`）
- 使用 `-f` 強制覆寫，每個階段只保留最新一次
- 回退情境不建立 tag（`shouldRetry` 時跳過）
- 失敗靜默處理，不中斷 pipeline

**POST_STAGE_HINTS 階段後提示**（v1.0.21）：

特定階段完成後，在下一階段的 context 中注入品質意識提示：

| 完成階段 | 注入提示 |
|---------|---------|
| REVIEW | 安全提示 — 建議在 TEST 也關注 auth/input validation/injection，pipeline 完成後可深度掃描 |
| TEST | 覆蓋率提示 — 建議關注覆蓋率，pipeline 完成後可用 `/vibe:coverage` 取得報告 |

提示以 `additionalContext` 附加在階段 context 後方，不影響核心指令。

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
  "pipelineEnforced": true,
  "taskType": "feature",
  "completed": ["planner", "architect", "designer", "developer"],
  "expectedStages": ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "skippedStages": ["E2E"],
  "stageResults": {
    "REVIEW": { "verdict": "FAIL", "severity": "HIGH" },
    "TEST": { "verdict": "PASS", "severity": null }
  },
  "retries": { "REVIEW": 1 },
  "pendingRetry": { "stage": "REVIEW", "severity": "HIGH", "round": 1 },
  "lastTransition": "2026-02-09T14:30:00Z"
}
```

> `pendingRetry` 僅在品質階段回退時設定，DEV 修復完成後消費（delete）。不存在時表示正常流程。
> `pipelineEnforced` 可由 task-classifier 初始設定，或由 stage-transition 自動升級（v1.0.16）。

#### Claude 看到的 systemMessage 內容：

**正常前進**（v1.0.22 精簡版）：

```
⛔ [Pipeline] developer✅ → REVIEW（審查）
➡️ 執行方法：使用 Skill 工具呼叫 /vibe:review
禁止 AskUserQuestion。已完成：PLAN → ARCH → DESIGN → DEV
```

**智慧回退**（v1.0.22 精簡版）：

```
🔄 [Pipeline 回退] REVIEW FAIL:HIGH（1/3）
回退原因：HIGH 等級問題需要修復
執行：使用 Task 工具委派給 vibe:developer agent（subagent_type: "vibe:developer"）
修復後 stage-transition 會指示重跑 REVIEW。禁止 AskUserQuestion。
已完成：PLAN → ARCH → DESIGN → DEV → REVIEW
```

**回退重驗**（DEV 修復完成後，v1.0.22 精簡版）：

```
🔄 [回退重驗] DEV 修復完成（第 1 輪）→ 重跑 REVIEW（審查）
執行：使用 Skill 工具呼叫 /vibe:review
不可跳過，不可跳到其他階段。禁止 AskUserQuestion。
已完成：PLAN → ARCH → DESIGN → DEV → REVIEW
```

**Pipeline 結束**（v1.0.21 三步驟閉環）：

```
✅ [Pipeline 完成] doc-updater 已完成（文件整理階段）。
所有階段已完成：PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS

📋 請執行以下步驟：
1️⃣ 執行 /vibe:verify 進行綜合驗證（Build → Types → Lint → Tests → Git 狀態）
2️⃣ 向使用者報告成果摘要
3️⃣ 使用 AskUserQuestion（multiSelect: true）提供後續選項：
   - 提交並推送（git commit + push）
   - 覆蓋率分析（/vibe:coverage）
   - 安全掃描（/vibe:security）
   - 知識進化（/vibe:evolve — 將本次經驗進化為可重用能力）
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
已完成：PLAN → ARCH → DESIGN → DEV
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
  4. state 存在且 cancelled === true → cleanup + exit 0（/vibe:cancel 手動取消）
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

**手動取消**：`/vibe:cancel` skill 設定 `cancelled: true` → 下次 Stop hook 放行。

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
> 接下來建議進行程式碼審查（REVIEW），我可以使用 `/vibe:review` 啟動。
> 要繼續嗎？

**結束前發現遺漏時：**

> 本次工作大致完成，但 task-classifier 建議的 REVIEW 和 TEST 階段尚未執行。
> 這些階段可以幫助確保程式碼品質。要跳過還是繼續？

**Pipeline 完整結束時：**

> 所有階段都已完成（PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → DOCS）。
> 以下是本次工作摘要：...

---

## 6. 實作檔案清單

### 新建

| 優先 | 檔案 | 說明 |
|:----:|------|------|
| 1 | `plugins/vibe/pipeline.json` | Stage 順序 + provides 統一定義 |
| 2 | `plugins/vibe/scripts/lib/pipeline-discovery.js` | 共用掃描邏輯（§3.3） |
| 3 | `plugins/vibe/scripts/hooks/stage-transition.js` | SubagentStop hook（§4.3） |
| 4 | `plugins/vibe/scripts/hooks/pipeline-check.js` | Stop hook（§4.4） |
| 5 | `plugins/vibe/scripts/hooks/task-guard.js` | Stop hook — 任務鎖定（§4.5） |

### 修改

| 優先 | 檔案 | 變動 |
|:----:|------|------|
| 5 | `plugins/vibe/scripts/hooks/pipeline-init.js` | 環境偵測 + pipeline-rules 注入（§4.2） |
| 6 | `plugins/vibe/hooks/hooks.json` | 統一 21 hooks 定義 |
| 7 | `plugins/vibe/pipeline.json` | 所有 stages + provides |
| 10 | `docs/ref/vibe.md` | 自動生成 — 含所有 skills/agents/hooks/scripts |
| 11 | `docs/plugin-specs.json` | vibe hooks 21、scripts 37 |
| 12 | `dashboard/scripts/generate.js` | Pipeline 視覺化同步更新 |

### vibe.md 自動同步

> **已完成** — vibe.md 由 `dashboard/scripts/generate-vibe-doc.js` 自動生成，
> 包含所有 skills、agents、hooks、scripts 的完整清單。
> Stop hook 觸發 → `refresh.js` → `generate.js` → vibe.md 自動更新。

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
  "stages": ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "DOCS"],
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
  "expectedStages": ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST"],
  "skippedStages": [],
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
PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS
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

---

## 8. Timeline 統一事件模組（v1.0.16）

### 8.1 定位

Timeline 是 Pipeline 的統一事件記錄層，取代 Dashboard 和 Remote 各自獨立的資料流。
所有 hook/agent/skill/task 的使用摘要統一寫入 Timeline，消費端（Dashboard、Remote）按需訂閱。

```
Hooks ──emit()──→ Timeline（JSONL）──watch()──→ Dashboard Consumer
                                              ──watch()──→ Remote Consumer
```

### 8.2 核心模組

| 檔案 | 功能 |
|------|------|
| `scripts/lib/timeline/schema.js` | 23 種事件類型、6 分類、envelope 建構/驗證 |
| `scripts/lib/timeline/timeline.js` | emit / query / queryLast / watch / cleanup / listSessions |
| `scripts/lib/timeline/consumer.js` | createConsumer 宣告式訂閱（分類展開、錯誤隔離、replay） |
| `scripts/lib/timeline/index.js` | 統一 re-export 入口 |

### 8.3 事件類型（22 種 × 5 分類）

| 分類 | 事件 | 數量 |
|------|------|:----:|
| **session** | session.start | 1 |
| **task** | task.classified · prompt.received · delegation.start · task.incomplete | 4 |
| **pipeline** | stage.start · stage.complete · stage.retry · pipeline.complete · pipeline.incomplete | 5 |
| **quality** | tool.blocked · tool.guarded · quality.lint · quality.format · quality.test-needed | 5 |
| **remote** | ask.question · ask.answered · turn.summary · say.sent · say.completed · compact.suggested · compact.executed | 7 |

### 8.4 儲存格式

- **路徑**：`~/.claude/timeline-{sessionId}.jsonl`
- **格式**：Append-only JSONL（每行一個 JSON envelope）
- **Envelope**：`{ id, type, sessionId, timestamp, data }`
- **截斷**：超過 2000 筆時自動保留最近 1500 筆
- **與 pipeline-state 共存**：Timeline 記錄事件歷史，pipeline-state 記錄當前快照，兩者互補

### 8.5 Consumer 模式

```js
const consumer = createConsumer({
  name: 'dashboard',
  types: ['pipeline', 'quality'],  // 支援分類名展開
  handlers: {
    'stage.complete': (event) => updateUI(event),
    '*': (event) => logEvent(event),
  },
  onError: (name, err) => logger.error(name, err),
});
consumer.start(sessionId, { replay: true });
```

### 8.6 實作階段

| Phase | 狀態 | 內容 |
|:-----:|:----:|------|
| 1 | ✅ 完成 | Timeline Core（schema + timeline + consumer + 55 tests） |
| 2 | ✅ 完成 | Hook emit 整合（17 hooks 加入 `emit()` 呼叫） |
| 3 | ✅ 完成 | Dashboard 整合 Timeline consumer（server.js 事件推播 + UI 事件面板） |
| 4 | ✅ 完成 | Remote 整合 Timeline consumer（bot.js 事件推播 + `/timeline` 查詢） |
| 5 | ✅ 完成 | 清理收斂（Phase 狀態同步、文件對齊） |