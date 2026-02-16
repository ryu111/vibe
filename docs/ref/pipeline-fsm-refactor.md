# Pipeline FSM 重構設計書

> **狀態**：提案
> **日期**：2026-02-16
> **範圍**：Pipeline Workflow 狀態管理重構 — 從旗標（flags）遷移到有限狀態機（FSM）
> **影響**：7 支 hook 腳本 + 2 支 flow 模組 + 1 支 sentinel 模組

---

## 0. 問題定義：Pipeline ≠ Workflow

目前程式碼將兩個不同層次的概念混在同一個 `pipeline-state-{sessionId}.json` 裡：

| 層次 | 定義 | 範例 | 性質 |
|------|------|------|------|
| **Pipeline**（模板） | 跑哪些 stage、什麼順序 | `standard: PLAN→ARCH→DEV→REVIEW→TEST→DOCS` | 靜態資料，分類後不變 |
| **Workflow**（流程控制） | 怎麼驅動 pipeline 跑完 | 初始化→分類→委派→監控→轉場→回退→完成→清理 | 動態執行狀態 |

```javascript
// 現況：兩層混在同一個物件
{
  // ── Pipeline 層（靜態） ──
  pipelineId: 'standard',
  expectedStages: ['PLAN','ARCH','DEV','REVIEW','TEST','DOCS'],

  // ── Workflow 層（動態旗標） ──
  delegationActive: true,       // 委派中？
  currentStage: 'DEV',          // 目前階段？
  pendingRetry: { stage: 'TEST', severity: 'CRITICAL', round: 1 },  // 待回退？
  pipelineEnforced: true,       // 強制模式？
  initialized: true,            // 已初始化？
  // ...更多旗標
}
```

**本次重構目標**：把 Workflow 層從散落的旗標升級為顯式 FSM，Pipeline 層保持不變。

---

## 1. 現況問題

### 1.1 用旗標組合隱式表達狀態

Pipeline 的「狀態」由 5+ 個 boolean/object flag 排列組合決定：

| 語意 | 判斷方式 |
|------|---------|
| 已初始化未分類 | `initialized=true && pipelineId=null` |
| 已分類等待委派 | `pipelineId存在 && delegationActive=false && pendingRetry=null` |
| Sub-agent 執行中 | `delegationActive=true && currentStage='DEV'` |
| 品質失敗待回退 | `pendingRetry={stage:'TEST',...} && delegationActive=false` |
| 回退修復後待重驗 | `pendingRetry存在 && currentStage='DEV'`（在 stage-transition 裡） |
| Pipeline 完成 | `expectedStages.every(s => stageResults[s]?.verdict === 'PASS')` |

沒有一個欄位能直接回答「pipeline 現在在幹嘛」。

### 1.2 State 寫入散佈在 5 支 Hook

```
pipeline-init.js      → initialized, environment, pipelineRules
task-classifier.js    → pipelineId, expectedStages, pipelineEnforced, taskType
delegation-tracker.js → delegationActive=true, currentStage
stage-transition.js   → completed, stageResults, retries, pendingRetry,
                         delegationActive=false, pipelineEnforced, stageIndex
pipeline-check.js     → fs.unlinkSync(statePath)  // 直接刪檔
```

每支 hook 各自 `read JSON → modify fields → write JSON`，沒有中央驗證層。

### 1.3 清理邏輯碎片化

旗標歸零分散在 4 處，沒有統一的「清除所有 workflow 狀態」動作：

| 位置 | 做什麼 | 風險 |
|------|--------|------|
| `resetPipelineState()`（task-classifier.js:85-101） | 手動 delete/reset 15 個欄位 | 新增欄位忘記加 → 殘留 |
| `state.delegationActive = false`（stage-transition.js:266） | 每次 SubagentStop 清除 | 如果 SubagentStop 沒觸發 → 永久卡 true |
| `state.pipelineEnforced = false`（stage-transition.js:257） | Pipeline 完成時清除 | 與 pipeline-check 刪檔之間有時間差 |
| `fs.unlinkSync(statePath)`（pipeline-check.js:96） | 核彈式刪除整個 state 檔 | 其他 hook 可能還在讀 |

### 1.4 `autoEnforce()` 副作用

`stage-transition.js:71-105` 的 `autoEnforce()` 會在 Workflow 執行中途偷改 Pipeline 層的資料：

```javascript
// 手動走 PLAN→ARCH 後，autoEnforce 偷改 pipelineId 和 expectedStages
state.pipelineId = isFrontend ? 'full' : 'standard';  // ← Pipeline 身份突變
state.expectedStages = PIPELINES[state.pipelineId].stages;
state.pipelineEnforced = true;
state.taskType = 'feature';
```

Pipeline 層應該在分類時決定、執行期不可變。中途突變讓 debug 和推理都變困難。

### 1.5 `delegationActive` 作為門禁的脆弱性

`guard-rules.js:73` 靠 `state.delegationActive` 決定是否放行 sub-agent 的 Write/Edit：

```javascript
if (state.delegationActive) return { decision: 'allow' };  // guard-rules.js:73
```

但 `delegationActive` 的生命週期跨越兩支 hook：
- delegation-tracker 設 `true`
- stage-transition 設 `false`

如果 SubagentStop 不觸發（sub-agent crash），`delegationActive` 永久卡在 `true`，pipeline-guard 形同虛設。唯一的恢復手段是 `session-cleanup` 在 3 天後刪除 stale 檔案。

---

## 2. 設計方案：顯式有限狀態機（FSM）

### 2.1 FSM 狀態定義

用一個 `phase` 欄位取代所有 boolean flag：

| Phase | 語意 | 對應原旗標 |
|-------|------|-----------|
| `IDLE` | Session 已初始化，等待任務 | `initialized=true, pipelineId=null` |
| `CLASSIFIED` | 任務已分類，等待委派 | `pipelineId存在, delegationActive=false` |
| `DELEGATING` | Sub-agent 正在執行 | `delegationActive=true` |
| `STAGE_DONE` | 階段完成，決定下一步 | SubagentStop 剛觸發，尚未決定前進/回退 |
| `RETRYING` | 品質失敗，等待 DEV 回退 | `pendingRetry存在, delegationActive=false` |
| `COMPLETE` | Pipeline 全部完成 | 所有 stage PASS |

### 2.2 合法轉換（Transitions）

```
                        ┌─────────────────────────────────┐
                        │                                 │
         classify       │    delegate       agent_done    │
 IDLE ──────────→ CLASSIFIED ──────→ DELEGATING ──────→ STAGE_DONE
  ↑                     ↑                                 │  │  │
  │                     │              advance(has_next)   │  │  │
  │                     └─────────────────────────────────┘  │  │
  │                                                          │  │
  │     new_task     COMPLETE ←──── advance(all_done) ───────┘  │
  └──────────────────────┘                                      │
                                                                │
                                    retry_needed                │
                          RETRYING ←────────────────────────────┘
                              │
                              │ delegate_dev
                              ↓
                          DELEGATING
```

**轉換表**（完整枚舉）：

| 當前 Phase | 事件 | 目標 Phase | 觸發者 |
|-----------|------|-----------|--------|
| `IDLE` | `CLASSIFY` | `CLASSIFIED` | task-classifier |
| `CLASSIFIED` | `DELEGATE` | `DELEGATING` | delegation-tracker |
| `DELEGATING` | `AGENT_DONE` | `STAGE_DONE` | stage-transition |
| `STAGE_DONE` | `ADVANCE` | `CLASSIFIED` | stage-transition（有下一階段） |
| `STAGE_DONE` | `FINISH` | `COMPLETE` | stage-transition（無下一階段） |
| `STAGE_DONE` | `RETRY` | `RETRYING` | stage-transition（品質失敗） |
| `RETRYING` | `DELEGATE` | `DELEGATING` | delegation-tracker（委派 DEV） |
| `COMPLETE` | `RESET` | `IDLE` | task-classifier（新任務） |
| `*`（任意） | `CANCEL` | `IDLE` | /vibe:cancel |

非法轉換（例如 `IDLE → DELEGATE`）直接拋錯，不會靜默產生不一致狀態。

### 2.3 衍生查詢取代旗標讀取

| 原旗標 | FSM 衍生函式 | 邏輯 |
|--------|-------------|------|
| `state.delegationActive` | `isDelegating(state)` | `phase === 'DELEGATING'` |
| `state.pipelineEnforced` | `isEnforced(state)` | `phase ∉ {IDLE, COMPLETE} && context.enforced` |
| `state.pendingRetry` | `isRetrying(state)` | `phase === 'RETRYING'` |
| `state.initialized` | `isInitialized(state)` | `phase !== undefined`（state 存在即已初始化） |
| `isPipelineComplete()` | `isComplete(state)` | `phase === 'COMPLETE'` |

**pipeline-guard 的改動**（guard-rules.js）：

```javascript
// 之前：讀 5 個 flag
if (!state.initialized) return { decision: 'allow' };
if (!state.taskType) return { decision: 'allow' };
if (!state.pipelineEnforced) return { decision: 'allow' };
if (state.delegationActive) return { decision: 'allow' };
if (state.cancelled) return { decision: 'allow' };

// 之後：讀 1 個 phase
if (!isEnforced(state)) return { decision: 'allow' };
if (isDelegating(state)) return { decision: 'allow' };
```

### 2.4 State 結構重組

```javascript
// ===== 新結構 =====
{
  sessionId: 'abc123',
  phase: 'DELEGATING',              // ← 唯一狀態指示器

  // 不可變 Context（分類時設定，執行期不變）
  context: {
    pipelineId: 'standard',
    expectedStages: ['PLAN','ARCH','DEV','REVIEW','TEST','DOCS'],
    enforced: true,                  // 從 PIPELINES[pipelineId].enforced 取
    taskType: 'feature',
    environment: { /* env-detect 結果 */ },
    openspecEnabled: false,
    pipelineRules: [ /* 委派規則 */ ],
    classifiedAt: '2026-02-16T10:00:00Z',
    classificationSource: 'regex',
    classificationConfidence: 0.85,
  },

  // 進度追蹤（只由 transition() 修改）
  progress: {
    currentStage: 'DEV',
    stageIndex: 2,
    completedAgents: ['planner', 'architect'],
    completedStages: ['PLAN', 'ARCH'],
    stageResults: {
      PLAN: { verdict: 'PASS', severity: null },
      ARCH: { verdict: 'PASS', severity: null },
    },
    retries: {},
    skippedStages: [],
    retryTarget: null,               // 取代 pendingRetry 物件
    retryRound: 0,
  },

  // 元資訊
  meta: {
    lastTransition: '2026-02-16T10:05:00Z',
    reclassifications: [],
  },
}
```

**結構分層原則**：

| 區塊 | 誰可以改 | 何時改 |
|------|---------|-------|
| `phase` | `transition()` | 每次狀態變化 |
| `context` | `transition(CLASSIFY)` | 只在分類時設一次 |
| `progress` | `transition()` | 每次階段推進 |
| `meta` | `transition()` | 記錄歷史 |

### 2.5 中央 Transition 函式

所有 hook 不再直接改 state，統一呼叫 `transition(state, event)`：

```javascript
// scripts/lib/flow/state-machine.js

const VALID_TRANSITIONS = {
  'IDLE:CLASSIFY':      'CLASSIFIED',
  'CLASSIFIED:DELEGATE': 'DELEGATING',
  'DELEGATING:AGENT_DONE': 'STAGE_DONE',
  'STAGE_DONE:ADVANCE': 'CLASSIFIED',
  'STAGE_DONE:FINISH':  'COMPLETE',
  'STAGE_DONE:RETRY':   'RETRYING',
  'RETRYING:DELEGATE':  'DELEGATING',
  'COMPLETE:RESET':     'IDLE',
};

function transition(state, event) {
  const key = `${state.phase}:${event.type}`;
  const nextPhase = VALID_TRANSITIONS[key];

  // CANCEL 是特殊事件，任何 phase 都能轉到 IDLE
  if (event.type === 'CANCEL') {
    return createIdleState(state.sessionId, state.context?.environment);
  }

  if (!nextPhase) {
    throw new Error(`Invalid transition: ${state.phase} + ${event.type}`);
  }

  // 根據事件類型，產生新的 state（immutable）
  switch (event.type) {
    case 'CLASSIFY':
      return {
        ...state,
        phase: nextPhase,
        context: {
          pipelineId: event.pipelineId,
          expectedStages: event.stages,
          enforced: event.enforced,
          taskType: event.taskType,
          environment: state.context?.environment || {},
          openspecEnabled: state.context?.openspecEnabled || false,
          pipelineRules: state.context?.pipelineRules || [],
          classifiedAt: new Date().toISOString(),
          classificationSource: event.source,
          classificationConfidence: event.confidence,
        },
        progress: createEmptyProgress(),
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'DELEGATE':
      return {
        ...state,
        phase: nextPhase,
        progress: {
          ...state.progress,
          currentStage: event.stage,
        },
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'AGENT_DONE':
      return {
        ...state,
        phase: nextPhase,
        progress: {
          ...state.progress,
          stageResults: {
            ...state.progress.stageResults,
            [state.progress.currentStage]: event.verdict || { verdict: 'UNKNOWN' },
          },
          completedAgents: state.progress.completedAgents.includes(event.agent)
            ? state.progress.completedAgents
            : [...state.progress.completedAgents, event.agent],
          completedStages: state.progress.completedStages.includes(state.progress.currentStage)
            ? state.progress.completedStages
            : [...state.progress.completedStages, state.progress.currentStage],
        },
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'ADVANCE':
      return {
        ...state,
        phase: nextPhase,
        progress: {
          ...state.progress,
          stageIndex: event.nextIndex,
          currentStage: null,
          retryTarget: null,
          retryRound: 0,
        },
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'RETRY':
      return {
        ...state,
        phase: nextPhase,
        progress: {
          ...state.progress,
          retryTarget: event.retryTarget,
          retryRound: (state.progress.retries[event.retryTarget] || 0) + 1,
          retries: {
            ...state.progress.retries,
            [event.retryTarget]: (state.progress.retries[event.retryTarget] || 0) + 1,
          },
          currentStage: null,
        },
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'FINISH':
      return {
        ...state,
        phase: nextPhase,
        progress: { ...state.progress, currentStage: null },
        meta: { ...state.meta, lastTransition: new Date().toISOString() },
      };

    case 'RESET':
      return createIdleState(state.sessionId, state.context?.environment);

    default:
      throw new Error(`Unknown event type: ${event.type}`);
  }
}
```

### 2.6 Hook 改動摘要

每支 hook 從「直接讀寫旗標」改為「呼叫 transition + 寫入結果」：

#### pipeline-init.js

```javascript
// 之前
fs.writeFileSync(statePath, JSON.stringify({
  sessionId, initialized: true, completed: [],
  expectedStages: [], pipelineId: null, pipelineRules, environment: env, ...
}));

// 之後
const state = createIdleState(sessionId, env, { pipelineRules, openspecEnabled });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
```

#### task-classifier.js

```javascript
// 之前（15 欄位手動設定 + resetPipelineState 手動清除）
state.pipelineId = newPipelineId;
state.taskType = newTaskType;
state.expectedStages = newStages;
state.pipelineEnforced = newPipelineEnforced;
// ...

// 之後
const newState = transition(state, {
  type: 'CLASSIFY',
  pipelineId: newPipelineId,
  stages: newStages,
  enforced: newPipelineEnforced,
  taskType: newTaskType,
  source: result.source,
  confidence: result.confidence,
});
fs.writeFileSync(statePath, JSON.stringify(newState, null, 2));
```

#### delegation-tracker.js

```javascript
// 之前
state.delegationActive = true;
state.currentStage = mappedStage;

// 之後
const newState = transition(state, { type: 'DELEGATE', stage: mappedStage });
```

#### stage-transition.js（最大改動）

```javascript
// 之前：4 個分支各自改不同 flag 組合
if (shouldRetry) {
  state.retries[currentStage] = retryCount + 1;
  state.pendingRetry = { stage: currentStage, severity, round };
} else if (state.pendingRetry && currentStage === 'DEV') {
  delete state.pendingRetry;
} else if (nextStage) {
  state.stageIndex = resolved.index;
} else {
  state.pipelineEnforced = false;
}
state.delegationActive = false;  // 底部統一清除

// 之後：每個分支一個 transition 呼叫
let newState = transition(state, { type: 'AGENT_DONE', verdict, agent: agentType });

if (shouldRetry) {
  newState = transition(newState, { type: 'RETRY', retryTarget: currentStage });
} else if (nextStage) {
  newState = transition(newState, { type: 'ADVANCE', nextIndex: resolved.index });
} else {
  newState = transition(newState, { type: 'FINISH' });
}
```

#### pipeline-guard.js + guard-rules.js

```javascript
// 之前：5 個前置條件
if (!state.initialized) return allow;
if (!state.taskType) return allow;
if (!state.pipelineEnforced) return allow;
if (state.delegationActive) return allow;
if (state.cancelled) return allow;

// 之後：2 個語意明確的判斷
if (!isEnforced(state)) return allow;
if (isDelegating(state)) return allow;
```

#### pipeline-check.js

```javascript
// 之前：計算 missing stages 後刪檔
if (missing.length === 0) {
  try { fs.unlinkSync(statePath); } catch (_) {}
}

// 之後：讀 phase
if (isComplete(state)) {
  try { fs.unlinkSync(statePath); } catch (_) {}
}
```

---

## 3. `autoEnforce` 的處理

### 問題

`autoEnforce()` 在 stage-transition 執行中途偷改 `pipelineId`、`expectedStages`、`pipelineEnforced`，違反 Pipeline 層不可變原則。

### 方案：分類時一步到位

把 `autoEnforce` 的時機提前到 task-classifier：

| 場景 | 之前 | 之後 |
|------|------|------|
| 使用者說「開始規劃」 | classifier → `none` → 手動 `/vibe:scope` → PLAN 完成 → ARCH 完成 → `autoEnforce()` 偷改為 `standard` | classifier → `none` → 手動 `/vibe:scope` → stage-transition 偵測到 PLAN 完成 → **觸發重新分類** → `standard` |
| 使用者說「實作新功能」 | classifier → `standard`（正常路徑） | 不變 |

具體做法：stage-transition 在 `STAGE_DONE` 且 `context.pipelineId` 為低優先級（`none`/`fix`）時，發出 `RECLASSIFY` 事件，由 task-classifier 邏輯統一處理升級。不再有中途偷改。

---

## 4. 清理機制對比

### 之前：4 處手動清理

```
resetPipelineState()  → 手動清 15 個欄位（task-classifier.js:85-101）
delegationActive=false → stage-transition.js:266
pipelineEnforced=false → stage-transition.js:257
fs.unlinkSync()       → pipeline-check.js:96
```

### 之後：2 種乾淨的歸零路徑

| 路徑 | 觸發 | 做什麼 |
|------|------|--------|
| **正常完成** | `transition(state, {type:'FINISH'})` → `phase='COMPLETE'` → pipeline-check 刪檔 | FSM 到 COMPLETE，所有衍生查詢自動回傳正確值；pipeline-check 刪檔做物理清理 |
| **新任務覆蓋** | `transition(state, {type:'RESET'})` → `phase='IDLE'` → 然後 `CLASSIFY` | 回到空白狀態，不需手動清欄位 |
| **取消** | `transition(state, {type:'CANCEL'})` → `phase='IDLE'` | 同上 |

`resetPipelineState()` 函式可以刪除。不再需要手動追蹤「哪些欄位要清」。

---

## 5. 回退（Retry）流程對比

### 之前：靠 `pendingRetry` 物件 + `currentStage === 'DEV'` 判斷

```
REVIEW FAIL:CRITICAL
  → stage-transition 設 pendingRetry = { stage:'REVIEW', severity:'CRITICAL', round:1 }
  → stage-transition 設 delegationActive = false
  → Main Agent 委派 DEV
  → delegation-tracker 設 delegationActive = true
  → DEV 完成
  → stage-transition 判斷 pendingRetry 存在 && currentStage === 'DEV'
  → delete pendingRetry
  → 指示重跑 REVIEW
```

問題：`pendingRetry` 和 `delegationActive` 分別在不同 hook 設定/清除，中間如果斷掉就不一致。

### 之後：FSM Phase 驅動

```
REVIEW FAIL:CRITICAL
  → transition(AGENT_DONE)  → phase = STAGE_DONE
  → transition(RETRY)       → phase = RETRYING, retryTarget = 'REVIEW'
  → Main Agent 委派 DEV
  → transition(DELEGATE)    → phase = DELEGATING（從 RETRYING 合法轉換）
  → DEV 完成
  → transition(AGENT_DONE)  → phase = STAGE_DONE
  → 偵測 retryTarget 存在 → 指示重跑 REVIEW
  → transition(ADVANCE)     → phase = CLASSIFIED, retryTarget = null
  → 委派 REVIEW
  → transition(DELEGATE)    → phase = DELEGATING
```

差異：
- 每一步都是合法轉換，非法操作直接拋錯
- `RETRYING` 是顯式 phase，不是靠 `pendingRetry` 物件推算
- 不存在「`delegationActive` 卡在 true」的問題，因為 phase 只可能是明確的 6 種之一

---

## 6. 實作計畫

### Phase 1：新增 FSM 核心（不改現有 hook）

| 檔案 | 動作 | 說明 |
|------|------|------|
| `scripts/lib/flow/state-machine.js` | 新增 | FSM 核心：PHASES、transition()、衍生查詢、createIdleState() |
| `scripts/lib/flow/state-machine.test.js` | 新增 | 單元測試：所有合法轉換 + 非法轉換 + 邊界案例 |

### Phase 2：遷移 Hook（逐支替換）

按依賴順序遷移：

| 順序 | Hook | 改動 |
|:----:|------|------|
| 1 | `pipeline-init.js` | `createIdleState()` 取代手動建構 |
| 2 | `guard-rules.js` | `isDelegating()` / `isEnforced()` 取代旗標讀取 |
| 3 | `pipeline-guard.js` | 配合 guard-rules 改動（極小） |
| 4 | `task-classifier.js` | `transition(CLASSIFY)` / `transition(RESET)` 取代手動寫入 + `resetPipelineState()` |
| 5 | `delegation-tracker.js` | `transition(DELEGATE)` 取代 `delegationActive=true` |
| 6 | `stage-transition.js` | `transition(AGENT_DONE/ADVANCE/RETRY/FINISH)` 取代所有分支旗標操作；移除 `autoEnforce()` |
| 7 | `pipeline-check.js` | `isComplete()` 取代 stage 比對邏輯 |

### Phase 3：清理

| 動作 | 說明 |
|------|------|
| 刪除 `resetPipelineState()` | 被 `transition(RESET)` 取代 |
| 刪除 `autoEnforce()` | 被分類時一步到位取代 |
| 更新 `docs/ref/pipeline.md` §4 | Hook 實作規格同步 |
| 更新 CLAUDE.md | State 結構描述同步 |

### 向後相容

- State file 路徑不變：`~/.claude/pipeline-state-{sessionId}.json`
- 新 state 結構加入 `schemaVersion: 2`
- `transition()` 遇到舊格式（無 `phase` 欄位）自動遷移為 `IDLE`

---

## 7. 效益總結

| 面向 | 之前（flags） | 之後（FSM） |
|------|-------------|------------|
| 當前狀態判斷 | 推算 5+ flag 組合 | 讀 `state.phase`（一個字串） |
| 合法性驗證 | 無（任何 hook 可設任何 flag） | `transition()` 驗證合法轉換，非法直接拋錯 |
| 清理 / 歸零 | 手動清 15 欄位 × 4 處清理點 | `transition(RESET)` 或 `transition(CANCEL)` |
| 新增欄位 | 改 `resetPipelineState` + 所有讀取處 | 加進 `context` / `progress`，`transition()` 自動處理 |
| Debug | 讀完整 JSON 推算「現在在哪」 | `phase: 'RETRYING'` 一目了然 |
| 不一致風險 | 多 hook read-modify-write 可能交錯 | `transition()` 是純函式，輸入→輸出確定 |
| autoEnforce 副作用 | Pipeline 身份中途突變 | Pipeline context 分類後不可變 |
| delegationActive 卡住 | SubagentStop 不觸發 → 永久 true | phase 只有 6 種，不存在「卡在 DELEGATING」的隱性路徑 |
