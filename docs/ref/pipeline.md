# Pipeline v3 -- 動態 DAG 架構

> Vibe Pipeline v3 架構文檔。涵蓋宣告式狀態、DAG 排程引擎、Controller API、Hook Stack、訊息格式與 v2 遷移。

---

## 1. 架構總覽

### 核心理念

Pipeline v3 採用三元架構：

- **Pipeline Agent（智慧）** -- `pipeline-architect` agent 根據使用者需求和專案環境，動態產出最佳的 DAG 執行計劃
- **Pipeline Skill（規則）** -- `/vibe:pipeline` skill 作為啟動入口，讀取環境 context 後委派 agent
- **Hook Stack（邊界）** -- 5 個核心 hook 組成防護閉環，每個 hook 精簡為 controller 方法的代理

### v2 vs v3 變更摘要

| 維度 | v2（FSM） | v3（DAG） |
|------|-----------|-----------|
| 狀態模型 | 有限狀態機 + 手動轉換矩陣 | 宣告式 stages + derivePhase() 自動推導 |
| Pipeline 結構 | 靜態模板（10 種固定 stages 序列） | DAG（有向無環圖）動態生成 |
| 執行方式 | 嚴格串行 | 支援並行（共享依賴的 stages 同步執行） |
| 邏輯分布 | 散落在 6+ 個 hook 腳本 | 集中在 pipeline-controller.js |
| Hook 職責 | 包含業務邏輯 | 純代理（解析 stdin -> 呼叫 controller -> 輸出結果） |
| systemMessage 長度 | ~2200 tokens | ~200 tokens |
| 模板選擇 | task-classifier regex | pipeline-architect agent 語意分析 |
| 回退機制 | pendingRetry flat flag | pendingRetry.stages 陣列（支援多 stage 回退） |

### 模組依賴圖

```
                       ┌──────────────────────────────┐
                       │     pipeline-controller.js   │ <── 統一 API
                       │   classify / canProceed /     │
                       │   onDelegate / onStageComplete│
                       │   / onSessionStop             │
                       └──────┬───┬───┬───┬───┬───────┘
                              │   │   │   │   │
              ┌───────────────┤   │   │   │   └──────────────────┐
              │               │   │   │   │                      │
              v               v   │   v   v                      v
     ┌────────────┐  ┌──────────┐ │ ┌──────────┐        ┌──────────────┐
     │  dag-state  │  │dag-utils │ │ │  verdict  │        │   classifier │
     │  .js        │  │  .js     │ │ │  .js      │        │   .js        │
     │             │  │          │ │ │           │        │ (Layer 1/2)  │
     │ PHASES      │  │linearToDag│ │ │parseVerdict│       └──────────────┘
     │ STAGE_STATUS│  │validateDag│ │ └──────────┘
     │ derivePhase │  │topoSort  │ │
     │ readState   │  │buildBP   │ │
     │ writeState  │  │resolveAgt│ │
     └─────────────┘  └──────────┘ │
                                   v
                          ┌──────────────────┐
                          │  skip-predicates  │
                          │  .js              │
                          │                  │
                          │  shouldSkip()     │
                          └──────────────────┘
                                   │
              ┌────────────────────┤
              v                    v
     ┌──────────────┐    ┌──────────────────┐
     │ retry-policy  │    │ state-migrator   │
     │ .js           │    │ .js              │
     │               │    │                  │
     │shouldRetryStage│   │ ensureV3()       │
     └───────────────┘    └──────────────────┘

 ── Hook Stack（每個 hook 精簡為 controller 代理）──

 ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
 │task-classifier│  │pipeline-guard│  │delegation-tracker│
 │(UserPrompt)   │  │(PreToolUse)  │  │(PreToolUse Task) │
 │ ctrl.classify │  │ctrl.canProceed│ │ ctrl.onDelegate  │
 └──────────────┘  └──────────────┘  └──────────────────┘

 ┌──────────────────┐  ┌──────────────┐
 │ stage-transition  │  │pipeline-check│
 │  (SubagentStop)   │  │   (Stop)     │
 │ctrl.onStageComplete│ │ctrl.onSessionStop│
 └───────────────────┘  └──────────────┘
```

---

## 2. 宣告式狀態（v3 State Schema）

> 檔案路徑：`plugins/vibe/scripts/lib/flow/dag-state.js`

### 完整欄位定義

```javascript
{
  version: 3,                    // schema 版本（遷移用）
  sessionId: string,             // ECC session ID

  // -- 分類 --
  classification: {
    pipelineId: string,          // 'full' | 'standard' | ... | 'none'
    taskType: string,            // 'feature' | 'bugfix' | 'research' | ...（向後相容）
    source: string,              // 'explicit' | 'regex' | 'pending-llm' | 'llm'
    confidence: number,          // 0~1
    matchedRule: string,         // 'explicit' | 'strong-question' | 'action:feature' | ...
    classifiedAt: ISO8601,
  } | null,

  // -- 環境 --
  environment: {                 // pipeline-init 偵測
    language: { name, version },
    framework: { name, version },
    frontend: { detected: boolean },
    // ...
  },
  openspecEnabled: boolean,
  needsDesign: boolean,          // ARCH 完成後動態偵測

  // -- DAG --
  dag: {                         // pipeline-architect 產出（或 linearToDag 自動生成）
    [stageId]: {
      deps: string[],            // 依賴的 stage ID 列表
    },
  } | null,
  enforced: boolean,             // 是否強制委派（Main Agent 不可直接寫碼）
  blueprint: [                   // 執行步驟（buildBlueprint 產出）
    { step: number, stages: string[], parallel: boolean },
  ] | null,

  // -- 各 stage 狀態 --
  stages: {
    [stageId]: {
      status: 'pending'|'active'|'completed'|'failed'|'skipped',
      agent: string | null,      // 執行的 agent 名稱
      verdict: { verdict, severity } | null,  // 品質階段的結論
      reason: string,            // skipped 原因
      startedAt: ISO8601 | null,
      completedAt: ISO8601 | null,
    },
  },

  // -- 重試 --
  retries: { [stageId]: number },  // 每個 stage 已回退次數
  pendingRetry: {                  // 等待 DEV 修復的回退資訊
    stages: [{ id: string, severity: string, round: number }],
  } | null,

  // -- 元資訊 --
  meta: {
    initialized: boolean,
    cancelled: boolean,
    lastTransition: ISO8601,
    reclassifications: [{ from, to, at }],
    pipelineRules: string[],
  },
}
```

### derivePhase() 推導邏輯

Phase 不是手動設定的值，而是從 state 自動推導的衍生屬性。推導規則（短路求值）：

```
1. state 不存在 / cancelled / 無 DAG / DAG 為空  -> IDLE
2. pendingRetry.stages 有內容                     -> RETRYING
3. 所有 stages 為 completed 或 skipped            -> COMPLETE
4. 任一 stage 為 active                           -> DELEGATING
5. 其餘（有 DAG 但無 active）                     -> CLASSIFIED
```

| Phase | 含義 | Main Agent 可用工具 |
|-------|------|-------------------|
| IDLE | 無 pipeline / 已取消 | 所有工具 |
| CLASSIFIED | 已分類、等待委派 | Task / Skill + 唯讀（Read/Grep/Glob/WebSearch/WebFetch） |
| DELEGATING | Sub-agent 執行中 | 所有工具（sub-agent 內部） |
| RETRYING | 等待 DEV 修復 | Task / Skill + 唯讀 |
| COMPLETE | Pipeline 完成 | 所有工具 |

### STAGE_STATUS 生命週期

```
                    markStageActive()
  pending ──────────────────────────────> active
    ^                                      │
    │                                      ├── markStageCompleted()  -> completed
    │                                      └── markStageFailed()    -> failed
    │
    │  resetStageToPending()
    └────────────── failed
                    （回退重跑時重設為 pending）

  pending ── markStageSkipped() ──> skipped
             （shouldSkip() 判定跳過）
```

---

## 3. DAG 排程引擎

> 檔案路徑：`plugins/vibe/scripts/lib/flow/dag-utils.js`

### DAG 資料結構

DAG 是一個物件，每個 key 是 stage ID，value 包含 `deps`（依賴列表）：

```javascript
// 線性範例（PLAN -> ARCH -> DEV -> REVIEW -> DOCS）
{
  PLAN:   { deps: [] },
  ARCH:   { deps: ['PLAN'] },
  DEV:    { deps: ['ARCH'] },
  REVIEW: { deps: ['DEV'] },
  DOCS:   { deps: ['REVIEW'] },
}

// 並行範例（DEV 完成後 REVIEW + TEST 並行，兩者都完成後 DOCS）
{
  DEV:    { deps: [] },
  REVIEW: { deps: ['DEV'] },
  TEST:   { deps: ['DEV'] },
  DOCS:   { deps: ['REVIEW', 'TEST'] },
}

// TDD 範例（帶後綴 ID）
{
  'TEST:write':  { deps: [] },
  DEV:           { deps: ['TEST:write'] },
  'TEST:verify': { deps: ['DEV'] },
}
```

### 核心函式

**linearToDag(stages)** -- 從線性 stage 列表建立串行 DAG

```javascript
linearToDag(['DEV', 'REVIEW', 'TEST'])
// => { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['REVIEW'] } }
```

**validateDag(dag)** -- 驗證 DAG 結構合法性

檢查項目：
1. DAG 必須是非空物件
2. 每個 stage 的 `deps` 必須是陣列
3. 依賴的 stage 必須存在於 DAG 中
4. 基礎 stage 名稱必須在 `STAGES` 中已定義
5. 不能有環（透過拓撲排序檢查）

```javascript
validateDag(dag)
// => { valid: true, errors: [] }
// => { valid: false, errors: ['TEST: 依賴 DEV 不存在於 DAG 中'] }
```

**topologicalSort(dag)** -- Kahn's algorithm 拓撲排序

回傳 stage ID 的執行順序。有環時拋出 Error。

**buildBlueprint(dag)** -- 從 DAG 提取執行步驟

共享同一批依賴的 stages 歸為同一步（可並行）：

```javascript
buildBlueprint({
  PLAN:   { deps: [] },
  ARCH:   { deps: ['PLAN'] },
  DEV:    { deps: ['ARCH'] },
  REVIEW: { deps: ['DEV'] },
  TEST:   { deps: ['DEV'] },
  DOCS:   { deps: ['REVIEW', 'TEST'] },
})
// => [
//   { step: 1, stages: ['PLAN'],            parallel: false },
//   { step: 2, stages: ['ARCH'],            parallel: false },
//   { step: 3, stages: ['DEV'],             parallel: false },
//   { step: 4, stages: ['REVIEW', 'TEST'],  parallel: true },
//   { step: 5, stages: ['DOCS'],            parallel: false },
// ]
```

**getBaseStage(stageId)** -- 從帶後綴 ID 取基礎名稱

```javascript
getBaseStage('TEST:write')  // => 'TEST'
getBaseStage('DEV')          // => 'DEV'
```

**resolveAgent(stageId, stageMap)** -- 解析 stage 對應的 agent 和 skill

先查 `pipeline.json` 的 provides 映射，再 fallback 到 `STAGES` 定義：

```javascript
resolveAgent('DEV', stageMap)
// => { agent: 'developer', skill: '/vibe:dev', plugin: 'vibe' }
```

### 並行排程邏輯

`getReadyStages(state)` 是排程核心。回傳所有依賴已滿足（completed 或 skipped）且自身為 pending 的 stages：

```javascript
// 假設 DAG: DEV -> [REVIEW + TEST] -> DOCS
// DEV completed, REVIEW pending, TEST pending, DOCS pending
getReadyStages(state)  // => ['REVIEW', 'TEST'] （兩個可同時開始）
```

當 `getReadyStages()` 回傳多個 stage 時，controller 會在 systemMessage 中同時列出所有委派指令，Main Agent 需要依序或並行委派它們。

---

## 4. Pipeline Controller API

> 檔案路徑：`plugins/vibe/scripts/lib/flow/pipeline-controller.js`

Pipeline Controller 是所有 hook 的唯一邏輯入口。5 個方法各對應一個 hook 事件。

### classify(sessionId, prompt)

**觸發時機**：UserPromptSubmit（使用者送出 prompt 時）

**流程**：
1. Layer 1/2 分類（classifyWithConfidence）
2. 檢查既有 state：COMPLETE -> reset；同 pipeline -> 跳過
3. 升級/降級判斷（priority 比較 + stale 檢查 10min）
4. 設定 classification 到 state

**分支**：

| 情境 | 輸出 |
|------|------|
| none / 無 stages | `additionalContext` -- 直接回答 |
| explicit（`[pipeline:xxx]`） | 直接 `linearToDag()` 建 DAG + `systemMessage` 委派 |
| 非 explicit | `systemMessage` 指示呼叫 `/vibe:pipeline` skill |

**顯式路徑（快速路徑）**：使用者用 `[pipeline:full]` 語法時，跳過 pipeline-architect agent，直接從模板建立線性 DAG。同時執行 `shouldSkip()` 跳過不需要的 stages（如後端專案跳過 DESIGN）。

### canProceed(sessionId, toolName, toolInput)

**觸發時機**：PreToolUse（任何工具呼叫前）

**防護層級**（短路求值）：

```
1. EnterPlanMode        -> 無條件 block
2. Bash DANGER_PATTERNS -> 無條件 block（rm -rf /、DROP TABLE 等 8 種）
3. 無 state / 未初始化   -> allow
4. 未 enforced          -> allow
5. DELEGATING phase     -> allow（sub-agent 內部不阻擋）
6. 已取消               -> allow
7. CLASSIFIED/RETRYING  -> Task/Skill/唯讀 allow，其餘 block
8. Bash 寫檔偵測        -> 程式碼檔案 block
9. Write/Edit/Notebook  -> block
10. AskUserQuestion     -> block（PLAN 階段除外）
11. 其餘                -> allow
```

**唯讀白名單**：`Read`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`TaskList`、`TaskGet`

### onDelegate(sessionId, agentType, toolInput)

**觸發時機**：PreToolUse Task（委派 sub-agent 時）

**行為**：
1. 解析 agent 短名（`vibe:architect` -> `architect`）
2. 查找對應 stage（`AGENT_TO_STAGE` 映射）
3. pendingRetry 防護：RETRYING 階段只允許 DEV（阻擋其他 agent）
4. 標記 stage 為 active

### onStageComplete(sessionId, agentType, transcriptPath)

**觸發時機**：SubagentStop（sub-agent 結束時）

這是最複雜的方法，處理三種分支：

**分支 A -- 回退（shouldRetry = true）**：
1. 品質 stage（REVIEW/TEST/QA/E2E）verdict 為 FAIL:CRITICAL 或 FAIL:HIGH
2. 未超過 MAX_RETRIES（預設 3）
3. DAG 中有 DEV stage
4. 設定 `pendingRetry` -> 委派 DEV 修復

**分支 B -- 回退重驗（DEV 完成 + pendingRetry 存在）**：
1. DEV 修復完成後，重設所有 failed stages 為 pending
2. 清除 pendingRetry
3. 重新委派失敗的品質 stages

**分支 C -- 正常前進**：
1. 標記完成
2. 遞迴跳過判斷（新 ready stages 可能需要 skip）
3. 計算下一批 ready stages
4. 全部完成 -> buildCompleteOutput()
5. 有 ready -> 發出委派指令（支援並行 `stage1 + stage2`）
6. 無 ready 但有 active -> 等待其他 stage 完成

**pipeline-architect 完成的特殊處理**：
1. 從 transcript 解析 `<!-- PIPELINE_DAG_START -->` 標記
2. validateDag() 驗證
3. 非法 DAG -> 降級為 `{ DEV: { deps: [] } }`
4. 設定 DAG + 跳過判斷 + 計算第一批 ready stages

### onSessionStop(sessionId)

**觸發時機**：Stop（Claude 嘗試結束對話時）

**行為**：
- COMPLETE / IDLE -> 放行
- enforced + 有遺漏 stages -> `continue: false` 硬阻擋 + systemMessage 列出遺漏

---

## 5. 執行流程（完整時序）

### 正常路徑

```
使用者 prompt
  |
  v
task-classifier hook (UserPromptSubmit)
  |-- ctrl.classify()
  |   |-- Layer 1: [pipeline:xxx] 顯式? -> 快速路徑（直接建 DAG）
  |   |-- Layer 2: regex 分類 + 信心度
  |   └-- 低信心度? -> systemMessage 指示呼叫 /vibe:pipeline
  |
  v
Main Agent 呼叫 /vibe:pipeline skill
  |-- 委派 pipeline-architect agent
  |
  v
delegation-tracker hook (PreToolUse Task)
  |-- ctrl.onDelegate() -> 標記 agent stage active
  |
  v
pipeline-architect agent 分析需求
  |-- 輸出 <!-- PIPELINE_DAG_START --> ... <!-- PIPELINE_DAG_END -->
  |
  v
stage-transition hook (SubagentStop)
  |-- ctrl.onStageComplete()
  |   |-- 解析 DAG -> validateDag() -> setDag()
  |   |-- shouldSkip() 跳過判斷
  |   |-- getReadyStages() 計算第一批
  |   └-- systemMessage: "Pipeline 已建立。 -> 委派 PLAN"
  |
  v
Main Agent 委派第一個 stage（如 planner）
  |
  v
delegation-tracker hook
  |-- 標記 PLAN active
  |
  v
planner agent 執行
  |
  v
stage-transition hook
  |-- PLAN completed -> getReadyStages() -> ARCH ready
  |-- systemMessage: "PLAN -> ARCH。 -> 執行 /vibe:architect"
  |
  v
  ... 依序執行各 stage ...
  |
  v
最後一個 stage 完成
  |-- isComplete(state) = true
  |-- systemMessage: "Pipeline 完成！"
  |
  v
pipeline-check hook (Stop)
  |-- phase = COMPLETE -> 放行
```

### 並行路徑

```
DEV 完成
  |
  v
stage-transition hook
  |-- getReadyStages() -> ['REVIEW', 'TEST']（共享 DEV 依賴）
  |-- systemMessage: "DEV -> REVIEW + TEST（並行）。-> /vibe:review + /vibe:tdd"
  |
  v
Main Agent 依序委派 REVIEW 和 TEST
  |
  v
REVIEW 完成（SubagentStop）
  |-- REVIEW completed, TEST 仍 active
  |-- getReadyStages() -> []（DOCS 依賴 TEST 未完成）
  |-- systemMessage: "REVIEW 完成。等待 TEST 完成..."
  |
  v
TEST 完成（SubagentStop）
  |-- TEST completed
  |-- getReadyStages() -> ['DOCS']
  |-- systemMessage: "TEST -> DOCS。-> /vibe:doc-sync"
```

### 回退路徑

```
REVIEW 完成，verdict = FAIL:HIGH
  |
  v
stage-transition hook
  |-- shouldRetryStage() -> { shouldRetry: true }
  |-- markStageFailed(REVIEW)
  |-- setPendingRetry({ stages: [{ id: 'REVIEW', severity: 'HIGH', round: 1 }] })
  |-- systemMessage: "REVIEW FAIL:HIGH（1/3）。-> /vibe:dev"
  |
  v
Main Agent 委派 DEV 修復
  |
  v
DEV 完成（SubagentStop）
  |-- pendingRetry 存在 + currentStage = DEV
  |-- markStageCompleted(DEV)
  |-- resetStageToPending(REVIEW)
  |-- clearPendingRetry()
  |-- systemMessage: "DEV 修復完成 -> 重跑 REVIEW。-> /vibe:review"
  |
  v
REVIEW 再次執行
  |-- verdict = PASS -> 正常前進
```

### 無 DEV 安全閥

```
review-only pipeline: { REVIEW: { deps: [] } }
  |
  v
REVIEW FAIL:HIGH
  |-- DAG 無 DEV stage
  |-- 強制繼續（markStageCompleted）
  |-- systemMessage: "REVIEW FAIL 但無 DEV 可回退，強制繼續。"
```

### 強制繼續（MAX_RETRIES 耗盡）

```
第 3 輪 REVIEW FAIL:HIGH
  |-- retryCount >= MAX_RETRIES (3)
  |-- shouldRetryStage() -> { shouldRetry: false, reason: '已達回退上限' }
  |-- 正常前進（不再回退）
```

---

## 6. Hook Stack（5 核心 hook）

v3 的每個 hook 腳本精簡為 3 層結構：

```javascript
safeRun('hook-name', (data) => {
  // 1. 解析 stdin JSON
  // 2. 呼叫 controller 方法
  // 3. 輸出結果（stdout JSON / stderr + exit 2）
});
```

`safeRun()`（來自 `hook-utils.js`）提供安全包裝：JSON 解析失敗或 handler 拋異常時記入 hook-logger 並 exit 0（不阻擋）。

### 各 hook 職責

| Hook | 事件 | Controller 方法 | 輸出管道 |
|------|------|----------------|---------|
| task-classifier | UserPromptSubmit | `ctrl.classify()` | stdout（additionalContext / systemMessage） |
| pipeline-guard | PreToolUse * | `ctrl.canProceed()` | allow: exit 0 / block: stderr + exit 2 |
| delegation-tracker | PreToolUse Task | `ctrl.onDelegate()` | allow: exit 0 / block: stderr + exit 2 |
| stage-transition | SubagentStop | `ctrl.onStageComplete()` | stdout（systemMessage + continue: true） |
| pipeline-check | Stop | `ctrl.onSessionStop()` | stdout（continue: false + systemMessage） |

### 事件流向

```
UserPromptSubmit
  |
  v
task-classifier  ------>  classify()  ------> systemMessage / additionalContext
                                |
                                v
                          /vibe:pipeline skill
                                |
                                v
                          pipeline-architect agent
                                |
PreToolUse Task                 |
  |                             |
  v                             v
delegation-tracker -> onDelegate() -> markStageActive()
  |
  v
PreToolUse *
  |
  v
pipeline-guard ----> canProceed() ----> allow / block

SubagentStop
  |
  v
stage-transition -> onStageComplete() -> markStageCompleted()
  |                                       + getReadyStages()
  v                                       + systemMessage: next stage

Stop
  |
  v
pipeline-check ---> onSessionStop() ---> continue: false (if incomplete)
```

---

## 7. Message 格式

v3 的 systemMessage 設計原則：只告訴模型「下一步做什麼」，不重複 context。

### 建立 Pipeline

```
⛔ Pipeline [standard]（PLAN -> ARCH -> DEV -> REVIEW -> TEST -> DOCS）已建立。
-> 執行 /vibe:scope
```

### pipeline-architect 產出

```
⛔ Pipeline 已建立（6 階段，1 跳過，1 組並行）。
📋 新功能需要完整品質流程，DESIGN 跳過（後端專案）
-> 執行 /vibe:scope
```

### 正常前進（串行）

```
✅ PLAN -> ARCH
-> 執行 /vibe:architect
📋 OpenSpec：planner 已建立 proposal.md...
```

### 正常前進（並行）

```
✅ DEV -> REVIEW + TEST（並行）
-> /vibe:review + /vibe:tdd
🔒 安全提示：REVIEW 已完成...
```

### 回退

```
🔄 REVIEW FAIL:HIGH（1/3）
-> 執行 /vibe:dev
```

### 回退重驗

```
🔄 DEV 修復完成 -> 重跑 REVIEW
-> 執行 /vibe:review
```

### Pipeline 完成

```
✅ Pipeline 完成！
已完成：PLAN -> ARCH -> DEV -> REVIEW -> TEST -> DOCS
⏭️ 跳過：DESIGN

📌 後續動作：
1️⃣ 執行 /vibe:verify 最終驗證
2️⃣ 向使用者報告成果
3️⃣ AskUserQuestion（multiSelect: true）提供選項
⚠️ Pipeline 自動模式已解除。
```

### 閉環阻擋（pipeline-check）

```
⛔ Pipeline 未完成！缺：TEST, DOCS
- 測試：/vibe:tdd
- 文件整理：委派 doc-updater
必須使用 Skill/Task 委派下一階段。禁止純文字回覆。
```

### Token 對比

v2 的 systemMessage 包含完整的 pipeline 規則禁止列表（約 2200 tokens），v3 精簡為行動指令（約 200 tokens），依賴 pipeline-guard hook 硬阻擋取代冗長的文字禁令。

---

## 8. v2 -> v3 遷移

> 檔案路徑：`plugins/vibe/scripts/lib/flow/state-migrator.js`

### 自動遷移機制

`pipeline-controller.js` 的 `loadState()` 在每次讀取 state 時呼叫 `ensureV3()`，自動偵測版本並遷移。使用者無需任何手動操作。

### 版本偵測

```javascript
detectVersion(state)
// version: 3             -> 3（已是 v3）
// phase + context 存在   -> 2（v2 FSM 格式）
// 其餘                   -> 0（無法辨識）
```

### 欄位映射表

| v2 欄位 | v3 欄位 | 轉換邏輯 |
|--------|--------|---------|
| `context.pipelineId` | `classification.pipelineId` | 直接映射 |
| `context.taskType` | `classification.taskType` | 直接映射 |
| `context.environment` | `environment` | 提升到頂層 |
| `context.openspecEnabled` | `openspecEnabled` | 提升到頂層 |
| `context.needsDesign` | `needsDesign` | 提升到頂層 |
| `context.expectedStages` | `dag`（linearToDag 建立） | 線性 stages 轉 DAG |
| `progress.completedAgents` | `stages[x].status = completed` | 透過 AGENT_TO_STAGE 映射推導 |
| `progress.skippedStages` | `stages[x].status = skipped` | 直接映射 |
| `progress.currentStage` + `phase=DELEGATING` | `stages[x].status = active` | 當前活躍 stage |
| `progress.pendingRetry.stage` | `pendingRetry.stages[0].id` | 單值 -> 陣列 |
| `progress.retries` | `retries` | 直接映射 |
| `meta.cancelled` | `meta.cancelled` | 直接映射 |
| `meta.reclassifications` | `meta.reclassifications` | 直接映射 |
| `meta.lastTransition` | `meta.lastTransition` | 直接映射 |
| --（不存在） | `meta.migratedFrom = 'v2'` | 遷移標記 |
| --（不存在） | `meta.migratedAt` | 遷移時間 |

### 遷移保證

- **無損**：所有已完成的進度（completed agents、skipped stages）保留
- **自動**：`loadState()` 每次讀取時透明遷移
- **向後相容**：v3 API（`derivePhase`、`isEnforced` 等）在遷移後的 state 上正常運作
- **blueprint 為 null**：v2 沒有 blueprint 概念，遷移後為 null（不影響排程，getReadyStages 只依賴 DAG）

---

## 9. 參考模板（10 種）

v3 的模板定義在 `registry.js` 的 `REFERENCE_PIPELINES`。pipeline-architect agent 可以參考這些模板，也可以動態產出自訂 DAG。

使用者以 `[pipeline:xxx]` 語法指定模板時，controller 走快速路徑（linearToDag + skip），不經 agent。

| ID | stages（線性 DAG） | enforced | 說明 |
|----|-------------------|:--------:|------|
| `full` | PLAN -> ARCH -> DESIGN -> DEV -> REVIEW -> TEST -> QA -> E2E -> DOCS | Y | 新功能（含 UI），完整 9 階段 |
| `standard` | PLAN -> ARCH -> DEV -> REVIEW -> TEST -> DOCS | Y | 新功能（無 UI）、大重構 |
| `quick-dev` | DEV -> REVIEW -> TEST | Y | Bugfix + 補測試、小改動 |
| `fix` | DEV | Y | Hotfix、config、一行修改 |
| `test-first` | TEST -> DEV -> TEST | Y | TDD 工作流（雙 TEST 循環） |
| `ui-only` | DESIGN -> DEV -> QA | Y | 純 UI/樣式調整 |
| `review-only` | REVIEW | Y | 程式碼審查 |
| `docs-only` | DOCS | Y | 純文件更新 |
| `security` | DEV -> REVIEW -> TEST | Y | 安全修復（REVIEW 含安全審查） |
| `none` | （空） | N | 問答、研究、trivial |

### pipeline-architect 動態 DAG 範例

pipeline-architect 可以產出超越模板的自訂 DAG，例如並行排程：

```json
{
  "dag": {
    "PLAN":   { "deps": [] },
    "ARCH":   { "deps": ["PLAN"] },
    "DEV":    { "deps": ["ARCH"] },
    "REVIEW": { "deps": ["DEV"] },
    "TEST":   { "deps": ["DEV"] },
    "DOCS":   { "deps": ["REVIEW", "TEST"] }
  },
  "enforced": true,
  "rationale": "標準功能開發，REVIEW 和 TEST 可並行",
  "blueprint": [
    { "step": 1, "stages": ["PLAN"],            "parallel": false },
    { "step": 2, "stages": ["ARCH"],            "parallel": false },
    { "step": 3, "stages": ["DEV"],             "parallel": false },
    { "step": 4, "stages": ["REVIEW", "TEST"],  "parallel": true },
    { "step": 5, "stages": ["DOCS"],            "parallel": false }
  ]
}
```

### 跳過規則（skip-predicates.js）

在 DAG 建立後、首次排程前，每個 stage 都會經過 `shouldSkip()` 檢查：

| Stage | 跳過條件 | 原因 |
|-------|---------|------|
| DESIGN | 非前端專案（無前端框架 + `frontend.detected = false` + `needsDesign = false`） | 純後端/CLI 專案不需視覺設計 |
| E2E | 純 API 框架（express / fastify / hono / koa / nest） | 純 API 專案不需瀏覽器測試 |

跳過後 `getReadyStages()` 會視同依賴已滿足，不會阻塞後續 stages。

---

## 附錄：三層分類器

> 檔案路徑：`plugins/vibe/scripts/lib/flow/classifier.js`

Pipeline v3 保留 v2 的三層級聯分類器，但 Layer 3 的角色從直接決策變為輔助建議（pipeline-architect agent 負責最終決策）。

| Layer | 機制 | 信心度 | 觸發條件 |
|-------|------|:------:|---------|
| 1 | `[pipeline:xxx]` 顯式語法 | 1.0 | prompt 包含語法標記 |
| 2 | Regex 級聯（疑問守衛 -> trivial -> 弱探索 -> 動作關鍵字） | 0.5~0.95 | Layer 1 未命中 |
| 3 | LLM Sonnet 語意分類 | 0.85 | Layer 2 信心度 < adaptive threshold |

**Layer 2 內部優先級**：
1. Phase 0：強動作信號（「更新 xxx.md」等明確動作意圖）
2. Phase 1：Strong Question Guard（6 類中文疑問信號 + 英文 WH）
3. Phase 2：Trivial Detection（hello world / poc / demo）
4. Phase 3：Weak Explore（看看 / 查看 / 說明）
5. Phase 4：Action Keywords（tdd / feature / refactor / bugfix / docs）
6. Default：quickfix

**Adaptive Threshold**：根據 `classifier-stats.json` 的修正率動態調整（0.5 或 0.7），環境變數 `VIBE_CLASSIFIER_THRESHOLD` 最高優先。
