# Pipeline 分散式節點架構

> 當前已實作系統的技術規格文件。狀態：穩定運作（v2.0.2~v2.0.13 迭代穩定化）。

---

## 目錄

- [§1 架構總覽](#1-架構總覽)
- [§2 Node 協議](#2-node-協議)
- [§3 Main Agent Relay 機制](#3-main-agent-relay-機制)
- [§4 並行執行](#4-並行執行)
- [§5 節點自治與 Policy 上限](#5-節點自治與-policy-上限)
- [§6 Pipeline Catalog 與 DAG 映射](#6-pipeline-catalog-與-dag-映射)
- [§7 迭代優化機制](#7-迭代優化機制)
- [§8 邊界情境與防護](#8-邊界情境與防護)
- [§9 風險評估](#9-風險評估)
- [附錄 A PIPELINE_ROUTE Schema](#附錄-a-pipeline_route-schema)
- [附錄 B Node Context Schema](#附錄-b-node-context-schema)
- [附錄 C Pipeline State Schema](#附錄-c-pipeline-state-schema)
- [附錄 D 設計決策紀錄](#附錄-d-設計決策紀錄)

---

## 1. 架構總覽

### 1.1 核心設計

Pipeline 採用**分散式節點自治**模型。Main Agent 作為純粹的訊息匯流排（Message Relay），路由決策由各節點自主做出，再由 stage-transition hook 驗證並執行。

> **核心原則**：Main Agent 不應知道「要修什麼」，只應知道「要路由到哪」。

```
                    ┌─────────────────────┐
                    │     Main Agent      │
                    │   (Message Relay)   │
                    │                     │
                    │  只做兩件事：        │
                    │  1. 讀 systemMessage │
                    │  2. 委派 Sub-agent   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              v                v                v
     ┌────────────┐   ┌────────────┐   ┌────────────┐
     │ Node: DEV  │   │Node: REVIEW│   │ Node: TEST │
     │            │   │            │   │            │
     │ prev: ARCH │   │ prev: DEV  │   │ prev: DEV  │
     │ next: [    │   │ next: QA   │   │ next: QA   │
     │  REVIEW,   │   │ onFail:DEV │   │ onFail:DEV │
     │  TEST      │   │ maxRetry:3 │   │ maxRetry:3 │
     │ ]          │   │            │   │            │
     └────────────┘   └────────────┘   └────────────┘
```

**Guard 機制**（二元判斷）：

```javascript
function evaluate(toolName, toolInput, state) {
  // 無條件阻擋
  if (toolName === 'EnterPlanMode') return block;
  if (toolName === 'Bash') { const d = checkDanger(command); if (d) return d; }

  // 無 pipeline 或已完成 → 放行
  if (!state?.pipelineActive) return allow;

  // Pipeline active → Relay Mode
  // 只允許：Task/Skill（委派）+ 唯讀（研究）
  if (toolName === 'Task' || toolName === 'Skill') return allow;
  if (READ_ONLY_TOOLS.has(toolName)) return allow;

  // 其他全部阻擋（Write/Edit/Bash 寫入/AskUserQuestion）
  return block('你是訊息匯流排（Relay），不是執行者。依照 PIPELINE_ROUTE 委派下一個節點。');
}
```

Guard 只需一個布林值 `pipelineActive` + 工具白名單，不需要推導複雜的 phase 狀態。

### 1.2 動態流程圖

#### A. 正常路徑（PASS → NEXT → COMPLETE）

```
使用者 prompt
    │
    v
[task-classifier] ── 分類 ──→ [pipeline-controller.classify()]
    │                                    │
    │                           ┌────────┴────────┐
    │                           │                 │
    │                    顯式 [pipeline:xxx]    非顯式
    │                    直接建 DAG              systemMessage 引導
    │                                            /vibe:pipeline
    │                           └────────┬────────┘
    │                                    v
    │                           [DAG 建立完成]
    │                           pipelineActive = true
    │                                    │
    v                                    v
[pipeline-guard 啟用] ◄──── [stage-transition: systemMessage]
                                    "➡️ 委派 /vibe:scope"
                                         │
    ┌────────────────────────────────────┘
    v
[Main Agent 委派 PLAN] ──→ [planner agent]
    │                              │
    │                        輸出 PIPELINE_ROUTE:
    │                        { verdict:PASS, route:NEXT }
    │                              │
    v                              v
[stage-transition 解析] ◄─── [SubagentStop hook]
    │
    ├── 更新 pipeline-state（stage PLAN → completed）
    ├── 生成下一個 Node Context（stage=ARCH）
    └── systemMessage: "➡️ 委派 /vibe:architect"
         │
         v
[Main Agent 委派 ARCH] ──→ [architect agent]
    │                              │
   ...                        （重複循環）
    │
    v
[最後一個 stage 輸出 route: COMPLETE]
    │
    v
[stage-transition]
    ├── pipelineActive = false
    └── systemMessage: "✅ Pipeline 完成。自動模式解除。"
```

#### B. 回退路徑（FAIL → DEV → 重驗）

```
[Main Agent 委派 REVIEW] ──→ [code-reviewer agent]
    │                              │
    │                    ┌─── 發現 CRITICAL 問題 ───┐
    │                    │                          │
    │              寫入 context_file:          輸出 PIPELINE_ROUTE:
    │              ~/.claude/pipeline-          { verdict: FAIL,
    │              context-{sid}-REVIEW.md        route: DEV,
    │              （完整報告：C-1, H-1...）       context_file: "上述路徑",
    │                                             hint: "修復旗標邏輯" }
    │                                               │
    v                                               v
[stage-transition 解析] ◄──────────────────── [SubagentStop]
    │
    ├── Schema Validation ✓
    ├── Policy: currentRound(1) < maxRetries(3) ✓
    ├── 更新 retry state: REVIEW.round = 1
    ├── 生成 DEV Node Context:
    │     { stage: DEV,
    │       context_file: "~/.claude/pipeline-context-{sid}-REVIEW.md",
    │       next: ["REVIEW"] }
    │
    └── systemMessage:
         "🔄 REVIEW FAIL → 委派 /vibe:dev"
         （Main Agent 看不到 C-1, H-1 等細節）
              │
              v
[Main Agent 委派 DEV] ──→ [developer agent]
    │                           │
    │                    讀取 context_file
    │                    修復問題
    │                    輸出 PIPELINE_ROUTE: { verdict: PASS, route: NEXT }
    │                           │
    v                           v
[stage-transition] ── 生成 REVIEW Node Context（round=2）──→ 重驗
```

#### C. 並行路徑（Barrier 同步）

```
[DEV 完成，route: NEXT]
    │
    v
[stage-transition 解析]
    ├── next 有多個節點（REVIEW + TEST）
    ├── 建立 barrier: { group: "post-dev", total: 2 }
    └── systemMessage: "➡️ 並行委派 /vibe:review 和 /vibe:tdd"
         │
         ├──────────────────────┐
         v                      v
[Main Agent 委派 REVIEW]  [Main Agent 委派 TEST]
         │                      │
         v                      v
[REVIEW 完成]             [TEST 完成]
route: BARRIER            route: BARRIER
barrierGroup: post-dev    barrierGroup: post-dev
         │                      │
         v                      v
[stage-transition]        [stage-transition]
barrier.completed:        barrier.completed:
["REVIEW"]                ["REVIEW","TEST"]
1 < 2 → 等待              2 === 2 → 全到齊！
                                │
                                v
                          systemMessage:
                          "➡️ 委派 /vibe:qa"
```

---

## 2. Node 協議

### 2.1 Node Context（委派時傳入）

每個節點在被委派時，收到自己的拓撲資訊（以 `full` pipeline 的 REVIEW 節點為例）：

```json
{
  "node": {
    "stage": "REVIEW",
    "prev": ["DEV"],
    "next": ["QA"],
    "onFail": {
      "target": "DEV",
      "maxRetries": 3,
      "currentRound": 1
    },
    "barrier": { "group": "post-dev", "total": 2, "siblings": ["REVIEW", "TEST"] }
  },
  "context_files": ["~/.claude/pipeline-context-{sessionId}-{prevStage}.md"],
  "env": {
    "language": "TypeScript",
    "framework": "React",
    "frontend": { "detected": true }
  },
  "retryContext": null
}
```

### 2.2 PIPELINE_ROUTE（節點輸出）

節點完成時，輸出結構化路由指令：

```
<!-- PIPELINE_ROUTE: {
  "verdict": "FAIL",
  "severity": "CRITICAL",
  "route": "DEV",
  "context_file": "~/.claude/pipeline-context-abc123-REVIEW.md",
  "hint": "修復 isPipelineComplete 旗標邏輯"
} -->
```

**關鍵設計**：詳細報告寫入**暫存檔**（`context_file`），PIPELINE_ROUTE 只傳遞**檔案路徑**。Main Agent 只讀 `route` 欄位決定下一步，完全看不到問題細節。

#### Context File 規範

- **路徑格式**：`~/.claude/pipeline-context-{sessionId}-{stage}.md`
- **寫入者**：Sub-agent（在輸出 PIPELINE_ROUTE 前）
- **讀取者**：下一個 Sub-agent（由 stage-transition 注入到委派 prompt）
- **生命週期**：Pipeline 完成或 cancel 時由 session-cleanup 清理
- **大小上限**：5000 chars（超出時保留 TOP 5 問題的完整描述，截斷其餘）

### 2.3 Sub-agent 回應隔離（Transcript 防洩漏）

在 ECC 中，Sub-agent 完成後，其完整回應文字會作為 `Task` 工具的 result 回到 Main Agent 的 Context Window。兩道防線確保資訊不洩漏：

#### 品質 Agent 回應規範（REVIEW / TEST / QA / E2E）

```markdown
## 最終回應格式

1. 先將完整報告寫入 context file（使用 Write 工具）
2. 最終回應只包含：
   - 一行結論（PASS/FAIL + 問題數量）
   - PIPELINE_ROUTE 標記

範例：
REVIEW 完成：FAIL（2 CRITICAL, 1 HIGH）
<!-- PIPELINE_ROUTE: { "verdict":"FAIL", "route":"DEV", ... } -->

❌ 禁止在回應中重複完整報告內容。
```

#### 資訊隔離的兩道防線

| 防線 | 機制 | 隔離對象 |
|:----:|------|---------|
| **1. context_file** | 詳細報告寫入檔案，ROUTE 只含路徑 | systemMessage 中的資訊 |
| **2. 回應格式約束** | Agent .md 規範只輸出結論 + ROUTE | Task result 中的資訊 |

兩道防線缺一不可 — 第一道防止 hook 注入報告，第二道防止 transcript 洩漏。

### 2.4 路由指令類型

| route 值 | 語意 | Main Agent 行為 |
|-----------|------|----------------|
| `"NEXT"` | 成功，前進到下一個節點（**僅限非並行節點**） | stage-transition 從 DAG 查找 `node.next` 並委派 |
| `"DEV"` | 失敗，回退到 DEV 修復（**僅限非並行節點**） | 委派 DEV，帶入 `context_file` 路徑 |
| `"BARRIER"` | 並行節點完成（verdict 攜帶 PASS/FAIL） | barrier 合併結果，全到齊後決定路由 |
| `"COMPLETE"` | 最後一個節點完成 | Pipeline 結束，解除 relay mode |

#### 並行節點的路由規則

並行節點（`node.barrier != null`）**一律輸出 `route: BARRIER`**，不論 verdict 是 PASS 還是 FAIL：

```
PASS 情況：{ "verdict": "PASS", "route": "BARRIER", "barrierGroup": "post-dev" }
FAIL 情況：{ "verdict": "FAIL", "route": "BARRIER", "barrierGroup": "post-dev",
             "severity": "CRITICAL", "context_file": "...", "hint": "..." }
```

**原因**：若並行節點直接輸出 DEV，另一個節點可能仍在執行中，導致 DEV 只看到部分問題，且 barrier 無法正常收斂。Barrier 合併確保所有並行結果都被收集後再統一決定路由（見 §4.2）。

---

## 3. Main Agent Relay 機制

### 3.1 Node Context 生成流程

Node Context 由 **stage-transition hook** 在每次委派時動態生成：

```
[DAG 結構]  +  [pipeline-state]  +  [env-detector]
     │                │                    │
     └────────┬───────┘                    │
              v                            v
     [buildNodeContext()]          讀取 env 快照
              │
              v
     Node Context JSON
     （注入到 systemMessage）
```

**生成邏輯**：

```javascript
function buildNodeContext(dag, state, stage, sessionId) {
  const node = dag[stage];

  // 取得所有前驅 stage 的 context files
  const prevStages = node.deps || [];
  const prevContextFiles = prevStages
    .map(s => state.stages?.[s]?.contextFile)
    .filter(Boolean);

  return {
    node: {
      stage,
      prev: prevStages,
      next: node.next || [],
      // QUALITY stage 有 onFail；IMPL stage 為 null
      onFail: node.onFail ? {
        target: node.onFail,
        maxRetries: node.maxRetries || 3,
        currentRound: (state.retries?.[stage] || 0) + 1  // 從持久化 state 讀取
      } : null,
      barrier: node.barrier || null
    },
    context_files: prevContextFiles,  // 前驅節點寫入的 context file 路徑（陣列）
    env: state.env || {},
    // Reflexion Memory 注入（getRetryContext 實作見 §7.1，反思記憶格式見 §7.1）
    retryContext: getRetryContext(sessionId, stage, state)
  };
}

/**
 * 從 Reflexion Memory 讀取回退上下文（§7.1 節詳述）
 * @param {string} sessionId
 * @param {string} stage - 委派目標（如 DEV）
 * @param {Object} state - pipeline state
 * @returns {Object|null} retryContext 或 null（首次執行）
 */
function getRetryContext(sessionId, stage, state) {
  // 從 state.retries 反向查找是哪個品質 stage 回退到此 stage
  const failedStage = Object.keys(state.retries || {})
    .find(s => (state.retries[s] || 0) > 0 && state.dag?.[s]?.onFail === stage);
  if (!failedStage) return null;
  const stateDir = path.join(os.homedir(), '.claude');
  const reflectionPath = path.join(stateDir,
    `reflection-memory-${sessionId}-${failedStage}.md`);
  if (!fs.existsSync(reflectionPath)) return null;
  return {
    round: (state.retries[failedStage] || 0) + 1,
    reflectionFile: reflectionPath,
    failedStage,
    hint: `⚠️ 你是因為 ${failedStage} FAIL 而被回退的。請先閱讀反思記憶。`
  };
}
```

**關鍵設計**：
- `currentRound` 從 `state.retries[stage]` 讀取（持久化在 pipeline-state 中），不依賴 Node 自行追蹤
- `context_file` 從 `state.stages[prevStage].contextFile` 讀取 — 每個 stage 完成時 stage-transition 將 ROUTE.context_file 存入 `state.stages[stage].contextFile`
- `env` 從 `state.env` 讀取（pipeline-init 時由 env-detector 寫入）
- `retryContext` 從 Reflexion Memory 檔案讀取（§7.1），首次執行時為 null
- `getRetryContext()` 透過 `state.retries` + `dag[s].onFail` 反向查找 failedStage，解決 stage 參數（委派目標 DEV）與反思記憶命名（品質 stage REVIEW）的錯位問題

### 3.2 Relay 邏輯

Main Agent 的行為完全由 stage-transition hook 的 systemMessage 驅動：

```
Sub-agent 完成
        │
        v
[stage-transition hook]
        │
        ├── 1. 解析 PIPELINE_ROUTE
        ├── 2. Schema Validation + Policy Enforcement
        ├── 3. 更新 pipeline-state（stage 狀態 + retry count）
        ├── 4. 生成下一個 Node Context
        └── 5. 產出 systemMessage（委派指令 + Node Context）
             │
             ├── route=NEXT    → "➡️ 委派 {skill}（Node Context: {...}）"
             ├── route=DEV     → "🔄 委派 /vibe:dev（Node Context: {...}）"
             ├── route=BARRIER → 更新計數 → 全到齊？→ "➡️ 委派 {next}"
             └── route=COMPLETE→ "✅ Pipeline 完成。自動模式解除。"
```

Main Agent **只看 systemMessage**，不看 sub-agent 的回應內容（回應被 §2.3 約束為一行結論）。

**進度追蹤（多階段 Pipeline）**：在多階段 pipeline 中（≥2 個 phase），systemMessage 會建議 Main Agent 使用 TaskCreate/TaskUpdate 建立進度追蹤：

```javascript
// 建議用法
TaskCreate({
  title: 'Phase 1: 核心功能實作',
  description: '實作資料模型 + API'
});

// 委派時更新狀態
TaskUpdate(taskId, { state: 'in_progress' });

// 完成時標記為完成
TaskUpdate(taskId, { state: 'completed' });
```

這讓使用者對 pipeline 進度有即時的視覺反饋，同時 TaskList 本身作為進度紀錄被保留。進度追蹤是可選的（Main Agent 可選擇不用），但在長流程中能顯著提升用戶體驗。

**自動 COMPLETE 規則**：當 Node 輸出 `route: NEXT` 但 DAG 中該 stage 的 `next` 為空陣列時，stage-transition 自動將其視為 `route: COMPLETE`。Node 不需要知道自己是否是最後一個 stage — stage-transition 統一處理。這簡化了 agent .md 的邏輯（所有 IMPL stage 都只需輸出 PASS/NEXT）。

### 3.3 PIPELINE_ROUTE 解析路徑（4 層 Fallback）

stage-transition hook 從 `agent_transcript_path`（SubagentStop hook stdin 欄位）讀取 Sub-agent transcript，經 4 層 fallback 解析路由：

```
parseRoute(transcriptPath) — 4 層 fallback：
  Layer 1：JSONL 掃描 → 搜尋 <!-- PIPELINE_ROUTE: {...} --> 標記
  Layer 2：v3 VERDICT fallback → 搜尋 PIPELINE_VERDICT 並轉換格式
  Layer 3：inferRouteFromContent → 從 agent 輸出文字語意推斷 PASS/FAIL
  Layer 4：null → 觸發 E1 fallback（crash 處理）
```

**Layer 3 inferRouteFromContent**：當 PIPELINE_ROUTE 和 PIPELINE_VERDICT 都找不到時（agent 忘記輸出標記），掃描 assistant message 文字內容推斷路由。信號優先序：
1. 強 FAIL 信號：CRITICAL/HIGH 問題計數 > 0（regex 匹配 `CRITICAL: 2`、`3 個 CRITICAL` 等）
2. 強 PASS 信號：`0 CRITICAL` / `全部通過` / `審查完成` 等
3. 弱 PASS 信號：200+ 字元的 assistant 輸出且無 FAIL 信號 → 推斷做了實質工作
4. 無法推斷 → null

**注意**：
- ECC 的 SubagentStop hook stdin 使用 `agent_transcript_path`（非 `transcript_path`）
- `parseRoute()` 掃描最後 30 行 transcript
- `inferRouteFromContent` 是 PIPELINE_ROUTE 雙層防禦的 Layer 2 安全網（Layer 1 是 agent.md ⛔ 強制聲明）
- 掃描失敗（4 層全部未匹配）→ 返回 null → 由 pipeline-controller 的 crash 處理接管

### 3.4 Stage 識別與狀態追蹤

stage-transition（SubagentStop hook）透過以下機制識別「哪個 stage 剛完成」：

```
delegation-tracker（PreToolUse Task hook）：
  1. 攔截 Task 工具呼叫
  2. 從 prompt / description 中解析目標 stage
  3. 寫入 state.activeStages（push "REVIEW"）
  4. stage-transition 讀取 state.activeStages 即知道是哪些 stage

```

**Hook 時序**（ECC 保證的執行順序）：

```
Main Agent 呼叫 Task(REVIEW)
    │
    ├── 1. PreToolUse(Task) → delegation-tracker → push state.activeStages = ["REVIEW"]
    ├── 2. PreToolUse(*)    → pipeline-guard      → 評估 pipelineActive → 放行 Task
    │
    ├── 3. Sub-agent 執行（Main Agent 被阻塞）
    │
    └── 4. SubagentStop     → stage-transition    → 從 state.activeStages 取出 "REVIEW"
                                                   → 解析 PIPELINE_ROUTE
                                                   → 更新 state + systemMessage

並行場景時序：
    ├── 1a. PreToolUse(Task) → delegation-tracker → push activeStages = ["REVIEW"]
    ├── 1b. PreToolUse(Task) → delegation-tracker → push activeStages = ["REVIEW","TEST"]
    ├── 2. pipeline-guard 放行兩個 Task
    ├── 3. 兩個 Sub-agents 執行
    ├── 4a. SubagentStop(REVIEW) → stage-transition → pop "REVIEW" from activeStages
    └── 4b. SubagentStop(TEST)   → stage-transition → pop "TEST" from activeStages
```

**Stage 識別機制**（並行時如何知道是哪個 stage 完成）：
- delegation-tracker 在 push 時同時記錄 **agent type → stage** 映射
- stage-transition 從 SubagentStop stdin 的 `agent_transcript_path` 解析 agent type
- 透過 `NAMESPACED_AGENT_TO_STAGE` 映射（registry.js）反查 stage name
- 從 activeStages 中 pop 該 stage

**pipelineActive 生命週期**：

| 事件 | pipelineActive | 設定者 |
|------|:-:|------|
| 顯式 `[pipeline:xxx]` 分類 | `true` | pipeline-controller.classify() |
| pipeline-architect DAG 建立 | `true` | stage-transition（解析 DAG 輸出） |
| 最後一個 stage 完成（route: COMPLETE） | `false` | stage-transition |
| 使用者 /vibe:cancel | `false` | cancel skill → controller API |
| Session /clear | `false` | pipeline-init（清除 state） |

### 3.5 資訊隔離

詳細報告透過 **檔案路徑隔離** 實現，Main Agent 完全看不到問題細節：

```
REVIEW agent → 詳細報告寫入檔案 → PIPELINE_ROUTE 只含路徑
             → Main Agent 只看 route + 路徑字串（不讀檔案內容）
             → stage-transition 把路徑注入下一個 agent 的委派 prompt
             → DEV agent 自行讀取檔案
```

Main Agent 的 systemMessage **只包含路由指令**：
```
🔄 REVIEW FAIL → 委派 /vibe:dev
```

Main Agent **完全不知道**：
```
❌ C-1: adaptState clearing expectedStages breaks 7 downstream features...
❌ H-1: !alive catches undefined...
```

這些細節只存在於 `~/.claude/pipeline-context-{sid}-REVIEW.md` 中，由 DEV agent 自行讀取。

---

## 4. 並行執行

### 4.1 Barrier 機制

並行節點透過 barrier 同步：

```
         ┌── REVIEW (barrier: "post-dev") ──┐
DEV ─────┤                                   ├── QA
         └── TEST   (barrier: "post-dev") ──┘
```

每個並行節點的 Node Context 包含：
```json
{
  "barrier": {
    "group": "post-dev",
    "total": 2,
    "siblings": ["REVIEW", "TEST"]
  }
}
```

完成時輸出（**一律使用 BARRIER route**）：
```json
// PASS
{ "verdict": "PASS", "route": "BARRIER", "barrierGroup": "post-dev" }

// FAIL（verdict 攜帶嚴重度和 context）
{ "verdict": "FAIL", "route": "BARRIER", "barrierGroup": "post-dev",
  "severity": "CRITICAL", "context_file": "~/.claude/pipeline-context-{sid}-TEST.md",
  "hint": "3 個測試失敗" }
```

### 4.2 Barrier 計數器與結果合併

stage-transition hook 維護一個計數器（取代全量 DAG 查詢）：

```javascript
// barrier-state-{sessionId}.json
// 此範例對應 full pipeline（post-dev barrier 後接 QA）
{
  "post-dev": {
    "total": 2,
    "completed": ["REVIEW"],
    "results": {
      "REVIEW": { "verdict": "PASS", "route": "BARRIER" }
    },
    "next": "QA",
    "createdAt": "2024-02-19T00:00:00.000Z"
  }
}
```

**合併邏輯**（當 `completed.length === total`）：

```javascript
// 回傳值為 stage-transition 內部路由結果（非 Node 輸出的 PIPELINE_ROUTE 格式）
// `target` 是額外欄位，供 stage-transition 決定委派目標
function mergeBarrierResults(barrier, state) {
  const routes = Object.values(barrier.results);
  const fails = routes.filter(r => r.verdict === 'FAIL');

  if (fails.length === 0) {
    // 全部 PASS → 前進到 barrier.next（若 next 為空則 COMPLETE）
    if (!barrier.next) return { verdict: 'PASS', route: 'COMPLETE' };
    return { verdict: 'PASS', route: 'NEXT', target: barrier.next };
  }

  // 任一 FAIL → Worst-Case-Wins
  const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  fails.sort((a, b) =>
    severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  );

  // 合併所有 FAIL 的 context files 到一個彙整檔
  const mergedContextFile = mergeContextFiles(fails, state.sessionId);
  // mergeContextFiles 實作：讀取各 fail.context_file，
  // 以 "## {stage} 結果\n{內容}" 格式串接，
  // 寫入 ~/.claude/pipeline-context-{sid}-MERGED.md
  // 大小上限同 context_file 規範（5000 chars）

  return {
    verdict: 'FAIL',
    route: 'DEV',
    severity: fails[0].severity,
    context_file: mergedContextFile,
    hint: fails.map(f => f.hint).filter(Boolean).join('; ')
  };
}
```

**Worst-Case-Wins 原則**：任一並行節點 FAIL → 整體 FAIL → 合併所有失敗報告 → 回退到 DEV。DEV agent 收到的 context file 包含所有並行節點的問題，一次修復到位。

### 4.3 寫入安全（Atomic Write）

主 pipeline state 和 barrier state 均使用 **Atomic Write**（三因子唯一暫存檔 + `fs.renameSync`）：

```javascript
// atomic-write.js — pid.timestamp.counter 三因子唯一性
let writeCounter = 0;
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${writeCounter++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);  // POSIX rename 是原子操作
}
```

**三因子設計**：`pid` 區分進程 + `timestamp` 區分時間 + `counter` 區分同一 tick 內的多次寫入。徹底消除暫存檔名衝突。

> Barrier state 使用獨立檔案（生命週期與主 state 不同），但寫入方式統一。

### 4.4 ECC 並行委派行為模型

```
ECC 並行委派時序：

Main Agent response 包含兩個 Task tool_use blocks：
  ┌── Task(REVIEW) ── Sub-agent 啟動 ──→ 執行中...
  │
  └── Task(TEST)   ── Sub-agent 啟動 ──→ 執行中...

  ↓ 時間流逝（Sub-agents 可能真正並行，也可能序列，由 ECC 決定）

  [REVIEW 完成] → SubagentStop hook #1 → stage-transition 處理
  （Main Agent 處理 REVIEW result）
  [TEST 完成]   → SubagentStop hook #2 → stage-transition 處理
  （Main Agent 處理 TEST result）
```

**已驗證行為**（v2.0.6 實測確認）：
- ECC 支持單一 response 中多個 Task tool_use blocks → 兩個 Sub-agent 依序啟動（非真正並行，但快速切換）
- SubagentStop hooks **依序觸發**（一個處理完才觸發下一個）— ECC hook 串行執行
- 因此 barrier state 的 read-modify-write 不會有並發競態
- Atomic Write 作為額外安全網

**實際行為**：Main Agent 序列委派（先 REVIEW 後 TEST），Barrier 序列收集結果。Pipeline 正確性完整，但不具真正的並行加速。此為無損退化，與設計預期一致。

---

## 5. 節點自治與 Policy 上限

### 5.1 節點自主決策

#### IMPL 階段（PLAN / ARCH / DESIGN / DEV / DOCS）

IMPL 階段一律輸出 `{ verdict: "PASS", route: "NEXT" }`：

```javascript
// DEV agent 完成後
// Step 1: 寫入 context file（實作摘要 — 可選）
Write("~/.claude/pipeline-context-{sid}-DEV.md", implementationSummary);

// Step 2: 固定路由（IMPL 不需要判斷 PASS/FAIL）
output PIPELINE_ROUTE: {
  verdict: "PASS", route: "NEXT",
  context_file: "~/.claude/pipeline-context-{sid}-DEV.md"
}

// Step 3: 最終回應
response: "DEV 完成：實作了 3 個檔案\n<!-- PIPELINE_ROUTE: {...} -->"
```

> IMPL 階段不需要判斷 FAIL — 如果寫不完（crash），由 E2 crash 處理。stage-transition 在 `next` 為空時自動轉為 COMPLETE（§3.2）。

#### QUALITY 階段（REVIEW / TEST / QA / E2E）

QUALITY 階段根據審查結果做路由決策，三道防線形成 defense-in-depth：

```javascript
// REVIEW agent 的決策邏輯（agent .md 中定義）
// 這是第一道（Agent 自主判斷）— 可能被第二道/第三道覆寫

// Step 1: 寫入 context file（完整報告）
Write("~/.claude/pipeline-context-{sid}-REVIEW.md", fullReport);

// Step 2: 根據結果和 Node Context 決定路由
if (hasCriticalOrHigh) {
  if (node.onFail.currentRound < node.onFail.maxRetries) {
    output PIPELINE_ROUTE: {
      verdict: "FAIL", route: "DEV",
      context_file: "~/.claude/pipeline-context-{sid}-REVIEW.md",
      hint: "修復 2 個 CRITICAL 問題"
    }
  } else {
    output PIPELINE_ROUTE: {
      verdict: "FAIL", route: "NEXT",
      warning: "exceeded retry limit"
    }
  }
} else {
  output PIPELINE_ROUTE: { verdict: "PASS", route: "NEXT" }
}

// Step 3: 最終回應只含結論（§2.3 規範）
response: "REVIEW 完成：FAIL（2 CRITICAL）\n<!-- PIPELINE_ROUTE: {...} -->"
```

**三道 Retry 防線**：

```
第一道（Agent 自主）：根據 node.onFail 做初步判斷 → 輸出 PIPELINE_ROUTE
    │
    v
第二道（Policy Enforcement，§5.3）：修正邏輯矛盾
    ├── PASS+DEV → 強制 NEXT
    └── DEV + retries≥maxRetries → 強制 NEXT
    │
    v
第三道（shouldStop()，§7.3）：收斂偵測（唯一新增能力）
    └── retryCount >= maxRetries → FORCE_NEXT（停止條件）
```

**重疊關係**：第一道和第二道的 MAX_RETRIES 判斷有意重疊（defense-in-depth）。第二道修正不合法路由，第三道判斷合法 FAIL 是否值得重試。

### 5.2 Policy 傳遞與 Retry 持久化

中央策略（如 MAX_RETRIES）透過 Node Context 傳入，但 **retry 計數持久化在 pipeline-state 中**：

```
┌─────────────────────────────────┐
│ pipeline-state-{sid}.json       │
│                                 │
│   retries: {                    │  ◄── 持久化源（stage-transition 讀寫）
│     "REVIEW": 1,                │
│     "TEST": 0                   │
│   }                             │
└────────────┬────────────────────┘
             │ stage-transition 讀取
             v
┌─────────────────────────────────┐
│ Node Context（動態生成）         │
│                                 │
│   onFail: {                     │  ◄── 每次委派時填入最新值
│     target: "DEV",              │
│     maxRetries: 3,              │
│     currentRound: 2             │  ◄── 從 state.retries.REVIEW + 1
│   }                             │
└─────────────────────────────────┘
```

**折衷設計**：
- **持久化**：`pipeline-state.retries` 由 stage-transition **獨占讀寫**
- **傳遞**：Node Context 的 `onFail.currentRound` 是唯讀快照
- **決策**：Node 根據 `currentRound` vs `maxRetries` 做路由決策
- **防護**：stage-transition 的 Policy Enforcement 作為最後防線（§5.3）

### 5.3 不可信節點防護

節點是 LLM，輸出本質上不可控。stage-transition hook 執行兩層驗證：

#### Layer 1：Schema Validation（格式正確性）

```javascript
function validateRoute(parsed) {
  // 必要欄位
  if (!parsed.verdict || !parsed.route) return null;
  // 合法 verdict
  if (!['PASS', 'FAIL'].includes(parsed.verdict)) return null;
  // 合法 route
  if (!['NEXT', 'DEV', 'BARRIER', 'COMPLETE'].includes(parsed.route)) return null;
  // FAIL 必須有 severity
  if (parsed.verdict === 'FAIL' && !parsed.severity) parsed.severity = 'MEDIUM';
  // BARRIER 缺 barrierGroup → 補預設值 "default"（不拒絕）
  if (parsed.route === 'BARRIER' && !parsed.barrierGroup) parsed.barrierGroup = 'default';
  return parsed;
}
```

驗證失敗 → 預設 `{ verdict: 'PASS', route: 'NEXT' }` + warning: "route-parse-failed"。

#### Layer 2：Policy Enforcement（邏輯正確性）

```javascript
// 規則 1：矛盾檢查：PASS 不能路由到 DEV
if (route.verdict === 'PASS' && route.route === 'DEV') {
  route.route = 'NEXT';
  route.warning = 'policy override: PASS cannot route to DEV';
}

// 規則 2：重試上限（從持久化 state 讀取，不依賴 Node Context 快照）
const stage = state.activeStages?.[0] || currentStage;
const currentRetries = (state.retries?.[stage] || 0);
const maxRetries = state.dag?.[stage]?.maxRetries || 3;
if (route.route === 'DEV' && currentRetries >= maxRetries) {
  route.route = 'NEXT';
  route.warning = `policy override: exceeded maxRetries (${currentRetries}/${maxRetries})`;
}

// 規則 3：無 DEV 節點的 pipeline（如 review-only/docs-only）→ FAIL 不回退
if (route.route === 'DEV' && !state.dag?.DEV) {
  route.route = 'NEXT';
  route.warning = 'policy override: no DEV stage in DAG, forced NEXT';
}

// 規則 4：並行節點必須使用 BARRIER route
// 只有在確實並行場景才強制（other siblings 為 active）
// pending 狀態的 sibling 代表尚未開始，不算並行執行
const node = state.dag?.[stage];
if (node?.barrier && route.route !== 'BARRIER') {
  const siblings = node.barrier.siblings || [];
  const otherSiblings = siblings.filter(s => s !== stage);
  const hasActiveSiblings = otherSiblings.some(s =>
    state.stages?.[s]?.status === 'active'  // 只有 active 才是真正並行
  );
  if (hasActiveSiblings) {
    route.route = 'BARRIER';
    route.barrierGroup = node.barrier.group;
    route.warning = 'policy override: parallel node with active siblings must use BARRIER';
  }
}

// 注意：實際路由目標由 stage-transition 從 DAG 計算（E14），
// Node 不指定目標 stage。Policy Enforcement 從 state（持久化源）讀取 retries，
// 而非 Node Context（快照）。
```

---

## 6. Pipeline Catalog 與 DAG 映射

### 6.1 Pipeline Catalog（10 種模板）

`registry.js` 的 `PIPELINES` 定義 10 種參考模板。`[pipeline:xxx]` 顯式指定時直接建立 DAG；非顯式則由 pipeline-architect 動態生成：

| 模板 | DAG 拓撲 | Barrier Group | onFail 目標 |
|------|----------|:-------------:|:-----------:|
| **full** | PLAN→ARCH→DESIGN→DEV→[REVIEW∥TEST]→[QA∥E2E]→DOCS | `post-dev`(REVIEW,TEST), `post-qa`(QA,E2E) | QUALITY→DEV |
| **standard** | PLAN→ARCH→DEV→[REVIEW∥TEST]→DOCS | `post-dev`(REVIEW,TEST) | QUALITY→DEV |
| **quick-dev** | DEV→[REVIEW∥TEST] | `post-dev`(REVIEW,TEST) | QUALITY→DEV |
| **fix** | DEV | （無） | （無） |
| **test-first** | TEST:write→DEV→TEST:verify | （無，序列） | TEST:verify→DEV |
| **ui-only** | DESIGN→DEV→QA | （無） | QA→DEV |
| **review-only** | REVIEW | （無） | （無，FAIL 強制 COMPLETE） |
| **docs-only** | DOCS | （無） | （無） |
| **security** | DEV→[REVIEW∥TEST] | `post-dev`(REVIEW,TEST) | QUALITY→DEV |
| **none** | （不建 DAG） | — | — |

**Barrier 規則**：當兩個 QUALITY stages 共享相同的前驅（如 REVIEW+TEST 都依賴 DEV），自動歸入同一 barrier group。`siblings` 欄位列出同組成員，`total` 自動計算。

**onFail 規則**：QUALITY stages（REVIEW/TEST/QA/E2E）的 `onFail` 指向最近的 IMPL stage（通常是 DEV）。IMPL stages（PLAN/ARCH/DESIGN/DEV/DOCS）的 `onFail` 為 `null`。無 DEV 的 pipeline（如 review-only）中 QUALITY FAIL 不回退，直接以 `WARNING` 完成。

### 6.2 DAG 範例

`[pipeline:standard]` 生成的 DAG：

```json
{
  "PLAN":   { "deps": [], "next": ["ARCH"], "onFail": null },
  "ARCH":   { "deps": ["PLAN"], "next": ["DEV"], "onFail": null },
  "DEV":    { "deps": ["ARCH"], "next": ["REVIEW", "TEST"], "onFail": null },
  "REVIEW": { "deps": ["DEV"], "next": ["DOCS"], "onFail": "DEV",
              "maxRetries": 3, "barrier": { "group": "post-dev", "total": 2, "siblings": ["REVIEW", "TEST"] } },
  "TEST":   { "deps": ["DEV"], "next": ["DOCS"], "onFail": "DEV",
              "maxRetries": 3, "barrier": { "group": "post-dev", "total": 2, "siblings": ["REVIEW", "TEST"] } },
  "DOCS":   { "deps": ["REVIEW", "TEST"], "next": [], "onFail": null }
}
```

### 6.3 多組 Barrier 的回退語意

`full` pipeline 有 `post-dev`(REVIEW,TEST) 和 `post-qa`(QA,E2E) 兩組 barrier。當 `post-qa` FAIL 回退到 DEV 時，跨越了 `post-dev` barrier — stage-transition 將 **QA/E2E 和 REVIEW/TEST 都重設為 pending**，DEV 重設為 active。

> **設計決策**：跨 barrier 回退時，被跨越的 barrier group 內的 stages 必須重跑。原因：DEV 的新修改可能影響 REVIEW/TEST 的結論，保留 `completed` 狀態（跳過重跑）可能讓未經驗證的新修改直達後續 stage，違反品質閉環原則。

> **barrier-state 連動重設**：stage-transition 在重設 pipeline-state 中的 stages 狀態時，必須同步重設 `barrier-state-{sid}.json` 中被跨越的 barrier group：`completed: []`、`results: {}`、`resolved: false`。否則第二輪 REVIEW/TEST 完成時 barrier 會讀到舊結果，導致計數異常。

### 6.4 衍生值：derivePhase()

`derivePhase()` 從 state 即時推導當前 phase，供 Dashboard/Timeline/formatter 使用（純函式，不修改 state）：

```
derivePhase(state) 依序短路判斷：
  ① !pipelineActive → IDLE
     （含 cancel 場景：cancel 設 pipelineActive=false → 一律 IDLE，
       無論 stages 狀態如何）
  ② !dag → CLASSIFIED（有 pipelineActive 但無 DAG）
  ③ activeStages.length > 0 → DELEGATING
  ④ 全部 completed/skipped → COMPLETE
  ⑤ 有 failed stage 且 retries > 0 → RETRYING
  ⑥ 其餘（有 DAG + 有 pending）→ CLASSIFIED
```

注意：Guard 使用 `pipelineActive` 布林值而非 `derivePhase`，不受 phase 推導影響。

---

## 7. 迭代優化機制

三層迭代優化機制協同運作，提升 pipeline 的修復效率：

```
                    ┌─────────────────────────────────────────┐
                    │         Stage 內 Self-Refine            │
                    │   (品質 Agent 自我修正 → 減少回退)       │
                    └──────────────┬──────────────────────────┘
                                   │ 仍然 FAIL
                                   v
                    ┌─────────────────────────────────────────┐
                    │       多維收斂條件（shouldStop）         │
                    │   判斷是否值得繼續迭代                    │
                    ├── stop=true  → FORCE_NEXT               │
                    ├── stop=false → RETRY                    │
                    └──────────────┬──────────────────────────┘
                                   │ RETRY
                                   v
                    ┌─────────────────────────────────────────┐
                    │       Reflexion Memory                   │
                    │   (記錄反思 → 注入下一輪 DEV context)    │
                    └─────────────────────────────────────────┘
```

### 7.1 Reflexion Memory（跨迭代反思記憶）

**問題**：FAIL 回退路徑中，DEV agent 是全新 session。它收到 `context_file`（reviewer 的完整報告），但不知道這是第幾輪、上一輪修了什麼、為什麼沒通過。可能重複嘗試已經失敗的修復策略。

**機制**：新增 `reflection-memory-{sessionId}-{failedStage}.md` 結構化反思檔案。檔名中的 `{failedStage}` 是觸發 FAIL 的品質 stage（如 REVIEW），而非回退目標（DEV）。DEV agent 在回退時讀取此檔案，了解是哪個 stage 因什麼原因打回。

```
檔案路徑：~/.claude/reflection-memory-{sessionId}-{failedStage}.md
寫入時機：stage-transition 處理 FAIL 回退前
讀取時機：pipeline-controller 委派回退目標（通常是 DEV）時注入 Node Context
清理時機：failedStage PASS 後刪除對應檔案 / session 結束

格式：
## 反思記憶（{stage}）

### Round 1（{timestamp}）
- **Verdict**：FAIL:HIGH
- **失敗 stage**：REVIEW
- **關鍵問題**：[從 verdict.hint 提取]
- **嘗試的修復**：[從 DEV transcript 提取已修改的檔案列表]
- **結論**：修復不完整，遺漏了 X 情境

### Round 2（{timestamp}）
- **Verdict**：FAIL:MEDIUM
- **改善**：severity 從 HIGH 降至 MEDIUM
- **殘留問題**：[具體描述]
```

**寫入邏輯**（stage-transition 內）：

```javascript
// FAIL 回退前，記錄反思
function writeReflection(sessionId, stage, verdict, retryCount) {
  const filePath = `~/.claude/reflection-memory-${sessionId}-${stage}.md`;
  const round = retryCount + 1;

  // 大小限制：每輪 ≤ 500 chars，總計 ≤ 3000 chars
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing.length >= 3000) {
    // 截斷最舊的 round，保留最近的反思
    const sections = existing.split(/(?=### Round )/);
    const trimmed = sections.slice(-5).join('');  // 防禦性上限 5 輪
    fs.writeFileSync(filePath, trimmed);
  }

  const entry = [
    `### Round ${round}（${new Date().toISOString()}）`,
    `- **Verdict**：${verdict.verdict}:${verdict.severity || 'N/A'}`,
    `- **失敗 stage**：${stage}`,
    `- **關鍵問題**：${verdict.hint || '（無）'}`,
    `- **context_file**：${verdict.context_file || '（無）'}`,
    ''
  ].join('\n');

  // Append 模式（累積多輪反思）
  fs.appendFileSync(filePath, entry);
}
```

**設計決策**：
- 使用 Markdown 檔案（而非 JSON）— 讓 LLM 可以直接閱讀，減少解析層
- Append 模式累積 — 每輪反思加入新 section，agent 可以看到趨勢
- 與 `context_file` 分離 — context_file 是本輪的詳細報告，reflection memory 是跨輪的摘要
- 大小限制：每輪反思 ≤ 500 chars，總計 ≤ 3000 chars — 超過時截斷最舊的 round

### 7.2 Stage 內 Self-Refine 微迴圈

**問題**：跨 stage 回退的代價高昂（新 agent session + context 重建）。但很多 FAIL:HIGH 問題只需幾行修改。

**機制**：在 QUALITY agents（REVIEW / TEST / QA / E2E）的 `.md` 中嵌入 Self-Refine 指令，讓品質 agent 在自身 session 內嘗試一輪「假設修正」後再做最終裁決。

**Agent .md 增強**（以 REVIEW 為例）：

```markdown
## Self-Refine 迴圈

1. **Phase 1 — 審查**：完整審查程式碼，標記所有問題
2. **Phase 2 — 自我挑戰**：對 FAIL:HIGH 以上的問題，嘗試構思修正方案
   - 修正方案是否明確且可實作？
   - 修正是否引入新問題？
   - 如果修正方案清晰且風險低 → 降級為 PASS（附帶修復建議作為 context_file）
   - 如果修正方案不確定或風險高 → 維持 FAIL（回退到 DEV）
3. **Phase 3 — 最終裁決**：根據 Phase 2 結果輸出 PIPELINE_ROUTE

### 判斷指引
- FAIL:CRITICAL → **永遠不降級**，直接回退
- FAIL:HIGH + 修正方案明確 → 可降級為 PASS + 建議
- FAIL:HIGH + 修正方案不確定 → 維持 FAIL
- FAIL:MEDIUM/LOW → 不觸發回退（現有行為不變）
```

**實作特點**：
- **不改 hook 架構** — 純 prompt engineering，在 agent .md 中加入指令
- **不增加 API 呼叫** — Self-Refine 在同一個 agent session 內完成
- **保守策略** — CRITICAL 永遠不降級，只有 HIGH + 明確方案才降級
- **context_file 作為載體** — 降級的修復建議寫入 context_file，下一個 stage 可讀取

**預期效果**：減少 30-50% 的跨 stage 回退，特別是那些「reviewer 能看出問題也能看出解法」的情境。

### 7.2a 三信號驗證（S6）

**問題**：QUALITY 品質 agents 的判斷完全依賴 LLM，可能過度嚴格或遺漏邊界案例。程式碼的某些方面（如 lint 錯誤）具有確定性，應以自動化工具作為信號而非 LLM 推測。

**機制**：在 Node Context 中注入**三信號驗證**，提供確定性的 lint 和 test 結果作為品質 agents 的決策參考：

```javascript
signals: {
  lint: { errors: 5, warnings: 2 } | null,    // ESLint / Ruff 實際運行結果，無錯誤時設為 null
  test: { runner: 'jest', available: true }   // 測試框架可用性（不實際執行，避免耗時）
}
```

**collectSignals() 實作**（`node-context.js`）：

- **lint 信號**：嘗試執行專案的 linter（eslint / ruff）取得實際的 error/warning 計數；若執行失敗或超時 → 回傳 null（不阻擋 pipeline）
- **test 信號**：檢查環境中是否有測試框架可用（jest / pytest / mocha），標記 runner 和 available 欄位；不實際執行測試（避免耗時）

**SIGNAL_STAGES 定義**：只在 REVIEW / TEST / QA / SECURITY 階段注入 signals 欄位。DEV / ARCH / PLAN / DESIGN / DOCS 等 IMPL stages 無 signals（設為 null）。

**Code-Reviewer 使用指引**：

- `signals.lint = null`（無 lint 信號）→ 進行完整 lint 檢查
- `signals.lint.errors = 0 && warnings = 0` → **跳過 lint 問題**報告（確定性信號覆蓋），將注意力集中在語意、邏輯、架構審查
- `signals.lint.errors > 0` → 在 HIGH 或 MEDIUM 區段報告 lint 錯誤，附上實際數量
- `signals.test.available = true` → 記錄專案有測試框架可用，期望提交時應包含測試

**低信心升級邏輯**：當 review 結果信心不足（線索不充分、無法確定問題嚴重度）時，在 PIPELINE_ROUTE 中加入 `"uncertain": true` 欄位，系統會提示 Main Agent 在回退前確認是否需要修復。

**預期效果**：
- 減少誤報（lint 0 error 被 LLM 報告為風格問題）
- 提升審查效率（減少語法層檢查，專注語意層）
- 降低虛假重試（確定信號可重現，LLM 推測可能誤判）

### 7.3 shouldStop — 多維收斂條件

`shouldStop()` 是 `retry-policy.js` 中的唯一停止判斷入口。

**與 §5.3 Policy Enforcement 的關係**：
- Policy Enforcement 是路由**修正層**，處理 Schema 驗證後的邏輯矛盾（如 PASS+DEV → 修正為 NEXT）
- `shouldStop()` 是**收斂判斷層**，判斷「合法的 FAIL 是否值得重試」
- **呼叫順序**：stage-transition 先執行 Schema Validation + Policy Enforcement，修正路由異常；再呼叫 `shouldStop()` 判斷是否繼續迭代
- 兩者職責不重疊，MAX_RETRIES 有意在兩層都判斷（defense-in-depth）

```javascript
/**
 * 多維停止條件
 * @param {string} stage - 當前 stage
 * @param {Object} verdict - 最新 verdict
 * @param {number} retryCount - 已重試次數
 * @param {Array} retryHistory - 歷史 verdict 摘要陣列
 * @param {number} maxRetriesForStage - 該 stage 的最大重試次數
 * @returns {{ stop: boolean, reason: string, action: string }}
 */
function shouldStop(stage, verdict, retryCount, retryHistory, maxRetriesForStage) {
  // (1) 品質門檻通過
  if (verdict?.verdict === 'PASS') {
    return { stop: true, reason: 'quality-gate-passed', action: 'NEXT' };
  }

  // (2) 最大重試次數（從 DAG 定義讀取，由呼叫者傳入）
  const maxRetries = maxRetriesForStage || 3;
  if (retryCount >= maxRetries) {
    return { stop: true, reason: 'max-retries-exhausted', action: 'FORCE_NEXT' };
  }

  // (3) 趨勢分析（附加日誌資訊，不影響停止決策）
  //     收斂停滯（連續同 severity）只作為觀察信號，不觸發 stop。
  //     retryCount < maxRetries 時仍應允許回退。
  const trend = analyzeTrend(retryHistory);
  const stagnation = detectStagnation(retryHistory);

  return {
    stop: false, reason: 'retry-needed', action: 'RETRY',
    ...(trend ? { trend } : {}),
    ...(stagnation ? { stagnation } : {})
  };
}
```

**Pipeline State 擴充**：

```json
{
  "retryHistory": {
    "REVIEW": [
      { "round": 1, "severity": "HIGH", "hint": "flag logic error", "timestamp": 1708300100 },
      { "round": 2, "severity": "MEDIUM", "hint": "edge case missing", "timestamp": 1708300200 }
    ]
  }
}
```

**停止條件關係**：

```
shouldStop() ────────┬─ (1) PASS          → NEXT（正常前進）
                     │
                     ├─ (2) MAX_RETRIES   → FORCE_NEXT（強制前進 + warning）
                     │
                     └─ (3) 趨勢分析      → RETRY + trend（非停止，僅日誌）
```

### 7.4 三層機制的執行時序

1. 品質 agent 完成審查（含 Self-Refine 微迴圈 — agent .md 層面，不經 hook）
2. 品質 agent 輸出 PIPELINE_ROUTE（verdict + route）
3. stage-transition hook 觸發（SubagentStop 事件）：
   a. 解析 PIPELINE_ROUTE（parseRoute）
   b. Schema Validation + Policy Enforcement（§5.3 — 修正不合法路由，含 MAX_RETRIES 覆寫）
   c. shouldStop() 分析收斂（§7.3 — 條件 (2) MAX_RETRIES 與 b 有意重疊作為 defense-in-depth）
   d. 若 RETRY → writeReflection() 記錄反思
   e. 生成下一個 Node Context（buildNodeContext + getRetryContext 注入反思記憶）
   f. 產出 systemMessage（委派指令）
4. Main Agent 委派 DEV（讀取 systemMessage 指令）
5. DEV agent 讀取反思記憶 + context_file，避免重複失敗策略
6. DEV 完成 → 回到步驟 1

**並行場景的 shouldStop 行為**：barrier 合併（§4.2 `mergeBarrierResults()`）產出的 FAIL 結果進入 shouldStop() 時，以 **severity 最高的 FAIL stage** 作為 `stage` 參數、合併後的 `severity` 作為 `verdict.severity`、該 stage 的 `retryHistory` 作為收斂判斷依據。

### 7.5 Goal Objects 量化成功標準（S7）

**問題**：Pipeline 完成時，agent 不知道「做到什麼程度算成功」。REVIEW agent 發現 MEDIUM 問題要不要回退？TEST agent 80% 覆蓋率夠不夠？DOCS agent 文件變更要不要同步？

**機制**：在 OpenSpec 的 `proposal.md` 中定義 Goal 區塊，明確列出量化的成功標準（success_criteria）和約束條件（constraints）。Agent 在完成工作時參照 Goal 驗證達成度。

**Goal 結構**：

```yaml
## Goal

success_criteria:
  - metric: test_coverage
    target: ">= 80%"
    weight: 0.3              # 相對重要性（總和 = 1.0）
  - metric: lint_clean
    target: "0 errors"
    weight: 0.2
  - metric: functional
    description: "使用者可以登入並看到 dashboard"
    weight: 0.5

constraints:
  - type: hard
    rule: "不修改公開 API 簽名"
  - type: soft
    rule: "偏好函式式風格"
```

**規則**：
- **success_criteria**：至少 2 個，每個必須有 `metric` + `target`（量化）或 `description`（質性）
- **weight**：反映各指標相對重要性，總和必須 = 1.0
- **constraints**：hard（必須遵守）vs soft（偏好，可權衡）

**Agent 使用指引**：

| Agent | 使用方式 |
|-------|---------|
| **planner** | 從 proposal 推斷合理的成功標準，若使用者未明確定義則預設常識標準 |
| **code-reviewer** | 驗證 success_criteria 達成；未達成的指標標記為 MEDIUM/HIGH；hard constraint 違反標記為 CRITICAL |
| **tester** | 從 success_criteria 推導測試案例；量化指標（如 coverage >= 80%）轉換為自動化測試驗證 |

**範例**：

```markdown
## Goal

success_criteria:
  - metric: functional_completeness
    description: "user 可完成登入→查詢→登出完整流程"
    weight: 0.5
  - metric: test_coverage
    target: ">= 85%"
    weight: 0.3
  - metric: performance
    target: "response_time < 200ms (p99)"
    weight: 0.2

constraints:
  - type: hard
    rule: "不修改 auth middleware 公開 API"
  - type: hard
    rule: "DB schema 無破壞性變更"
  - type: soft
    rule: "使用非同步 I/O"
```

**設計決策**：Goal Objects 是**可選的**（無 Goal 時 agent 按既有邏輯運行，保持向後兼容）。如果 proposal 含有 Goal 區塊，agent 應優先參考；無 Goal 時按專案預設標準（如 test coverage >= 80%）執行。

---

## 8. 邊界情境與防護

### 8.1 死鎖 / 卡住（Deadlock / Stuck）

#### E1：Sub-agent 沒有輸出 PIPELINE_ROUTE

**場景**：Sub-agent 完成工作但忘記輸出 PIPELINE_ROUTE 標記（prompt 遵循度不足）。

**防護**（四層 fallback，詳見 §3.3 `parseRoute()`）：

```
stage-transition 解析邏輯（四層 fallback）：
  Layer 1：掃描 transcript JSONL 找 <!-- PIPELINE_ROUTE: {...} --> → 成功 → 使用
  Layer 2：v3 VERDICT fallback → 搜尋 PIPELINE_VERDICT 並轉換格式
  Layer 3：inferRouteFromContent → 從 agent 輸出文字語意推斷 PASS/FAIL
  Layer 4：全部失敗（source='none'）→ 根據 stage 類型處理：
     ├── IMPL stage（PLAN/ARCH/DESIGN/DEV/DOCS）→ 視為 PASS，正常前進
     └── QUALITY stage（REVIEW/TEST/QA/E2E）→ 檢查 transcript 是否有 assistant 訊息：
         ├── 有 assistant 訊息 → 視為 CRASH，走 E2 crash 處理流程
         └── 無 assistant 訊息（極早期崩潰）→ 視為 PASS，正常前進
             + Timeline emit: AGENT_CRASH 事件（note: early-crash）
```

**差異說明**：IMPL stage 沒有 PIPELINE_ROUTE 是正常行為（IMPL 不強制輸出路由標記），直接前進。QUALITY stage 若有實質 assistant 輸出卻沒有路由，說明 agent 完成了工作但沒有輸出格式控制標記，走 E2 crash 重新委派流程（最多 3 次；3 次後 Pipeline 強制終止）。

---

#### E2：Sub-agent crash / 異常中止

**場景**：Sub-agent 在執行中被中斷（context overflow、timeout、使用者按 Ctrl+C）。

**防護**：

```
stage-transition 處理流程：
  1. 嘗試從 transcript 解析 PIPELINE_ROUTE（四層 fallback，見 §3.3 E1）
  2. 無路由輸出（source='none'）時，依 stage 類型處理：
     ├── IMPL stage（PLAN/ARCH/DESIGN/DEV/DOCS）：
     │   無 PIPELINE_ROUTE → 視為正常完成，進入分支 C 正常前進（PASS）
     │   （IMPL stage 不強制輸出 PIPELINE_ROUTE，已完成工作不需重跑）
     │
     └── QUALITY stage（REVIEW/TEST/QA/E2E）：
         檢查 transcript 是否有 assistant 訊息：
         ├── 有 assistant 訊息但無路由 → 視為 CRASH，重新委派同一 stage
         │   state.crashes[stage] += 1
         │   systemMessage: "⛔ {stage} agent 無 PIPELINE_ROUTE 輸出（第 N/3 次）。立即重新委派。"
         └── 無 assistant 訊息（極早期崩潰）→ 視為正常完成，進入分支 C（PASS）
  3. 記錄 Timeline 事件：AGENT_CRASH
  4. crashes[stage] >= 3 → Pipeline 強制終止
     state.pipelineActive = false
     systemMessage: "⛔ {stage} crash 達 3 次上限，Pipeline 異常終止。自動模式已解除。"
```

**關鍵決策**：
- IMPL stage 無 PIPELINE_ROUTE → 視為 PASS 正常前進（IMPL 不強制輸出路由標記）
- QUALITY stage 有 assistant 輸出但無路由 → **視為 crash**，重新委派（crash ≠ 通過審查）
- QUALITY stage 3 次 crash → **Pipeline 強制終止**（不是降級 PASS；3 次都失敗說明 agent 有根本問題，強制終止避免死鎖）

**並行節點 crash 的特殊處理**：若 crash 的 stage 是 barrier 的一部分（如 REVIEW crash 但 TEST 已完成）：
- crash 不計入 barrier.completed（因為沒有 ROUTE 輸出）
- 重新委派後正常完成 → 計入 barrier.completed → 觸發合併
- 3 次 crash 後 → Pipeline 強制終止（state.pipelineActive = false，自動模式解除）

**Barrier-crash guard**（v2.0.8）：防止 barrier sibling crash 後下游 stage 被提前委派。場景：REVIEW crash（pending+crashed）而 TEST 完成 → Branch C（非 barrier 收斂路徑）嘗試路由到 DOCS。Guard 機制：從 `readyStages` 排除 barrier.next 的下游 stage（如 DOCS），強制先重跑 crashed sibling（REVIEW）。重跑完成後 barrier 正常收斂。

---

#### E3：Barrier 永遠不齊

**場景**：兩個並行節點（REVIEW + TEST），其中一個 crash 或卡住 → barrier 永遠等不齊。

**防護**：

```
Barrier Timeout 機制：
  1. barrier 建立時記錄 createdAt（ISO 8601 字串）
  2. 每次 stage-transition 觸發時檢查：
     if (barrier.completed.length < barrier.total &&
         Date.now() - new Date(barrier.createdAt).getTime() > BARRIER_TIMEOUT_MS) {
       // 5 分鐘超時
       const missing = barrier.siblings.filter(s => !barrier.completed.includes(s));
       barrier.timedOut = true;
       barrier.missingStages = missing;
       // 強制前進，記錄 warning
       systemMessage: "⚠️ Barrier 超時（缺 {missing}），強制前進到 {next}。"
     }
  3. BARRIER_TIMEOUT_MS = 5 * 60 * 1000（可配置）
```

**補充**：超時不等於失敗 — 缺席的 stage 可能稍後完成（SubagentStop 觸發），此時只更新計數但不重複觸發 next。用 `barrier.resolved = true` 標記已處理。

**備用觸發**：根據 ECC 已知行為，Sub-agent 中斷時 SubagentStop hook 仍然觸發（只是 transcript 可能不完整），因此 E3 的超時檢查主要由 stage-transition 每次觸發時執行。若極端情況下 SubagentStop 未觸發，下一次 **UserPromptSubmit**（task-classifier hook）可偵測 barrier timeout 並發出警告。

---

#### E4：Pipeline active 但無下一步指令

**場景**：stage-transition 處理完成但 systemMessage 為空（程式 bug 或邊界情境）。

**防護**：

```
多層安全網：
  1. stage-transition 生成 systemMessage 後，斷言檢查：
     if (!systemMessage || systemMessage.trim() === '') {
       // Emergency fallback
       const pendingStages = Object.entries(state.stages || {})
         .filter(([_, s]) => s.status === 'pending')
         .map(([name]) => name);
       if (pendingStages.length > 0) {
         systemMessage = `➡️ 委派 ${STAGE_SKILL_MAP[pendingStages[0]]}`;
       } else {
         // 真的無下一步 → 可能 DAG 設計有問題
         systemMessage = '⚠️ Pipeline 狀態異常：無可用階段。使用 /vibe:cancel 退出。';
         state.pipelineActive = false;  // 解除 guard，避免死鎖
       }
     }

  2. suggest-compact 長時間偵測：
     連續 5 次唯讀操作且 pipelineActive = true
     → nudge: "Pipeline 等待委派，請按照 systemMessage 指示操作。"

  3. 下一次 UserPromptSubmit 或 Stop hook 觸發時，
     偵測上次委派 timestamp 超過 30 分鐘
     → systemMessage: "⏸️ Pipeline 長時間無活動，建議使用 /vibe:cancel 退出。"
     （注：ECC hooks-only 架構無定時器，此為事件驅動偵測）
```

---

#### E5：無限重試循環

**場景**：REVIEW 一直 FAIL，DEV 一直修但修不好 → 無限 FAIL→DEV→FAIL 循環。

**防護**：

```
三層保護：
  1. Node Context 限制（Node 自主決策）：
     currentRound(3) >= maxRetries(3)
     → Node 輸出: { verdict: FAIL, route: NEXT, warning: "exceeded retry limit" }

  2. Policy Enforcement（stage-transition 覆寫）：
     即使 Node 仍輸出 route: DEV，Policy 強制改為 NEXT + warning

  3. 耗盡後的 UX：
     systemMessage 包含品質警告：
     "⚠️ {stage} 已達重試上限（{maxRetries} 次），品質風險前進。
      問題摘要：{hint from last FAIL route}"
     → 繼續到下一階段，但 Pipeline 完成訊息中標記此 stage 為 ⚠️
```

---

#### E6：context_file 寫入失敗

**場景**：Sub-agent 嘗試寫入 `~/.claude/pipeline-context-{sid}-REVIEW.md` 但失敗（磁碟滿、權限錯誤）。

**防護**：

```
降級策略：
  1. Sub-agent 寫入失敗 → PIPELINE_ROUTE 中 context_file 為 null
  2. stage-transition 偵測到 context_file 為 null：
     ├── route = NEXT → 正常前進（不需 context）
     └── route = DEV → hint 欄位作為 fallback context
         （hint 最多 200 字，足以描述「修復什麼」但不洩漏完整報告）
  3. 下一個 Node 的 Node Context 中 context_file = null
     → Node 按無 context 模式運行（自行檢查程式碼）
```

**設計原則**：context_file 是**增強機制**，不是**必要條件**。沒有 context_file，pipeline 仍能運行，只是 DEV agent 需要自行定位問題（效率降低但不卡住）。

---

### 8.2 恢復 / 接手（Recovery / Handoff）

#### E7：Session 中斷後恢復

**場景**：使用者在 Pipeline 執行中關閉 terminal / Ctrl+C，稍後在新 session 恢復。

**防護**（pipeline-resume 機制）：

```
pipeline-init（SessionStart hook）：
  1. findIncompletePipelines()：
     掃描 ~/.claude/pipeline-state-*.json
     過濾：pipelineActive = true && sessionId ≠ 當前 session
  2. 找到未完成 pipeline：
     ├── 自動接續：
     │   建立新 state（新 sessionId）+ 複製 DAG + retries + context files
     │   systemMessage: "🔄 接續未完成的 Pipeline..."
     └── DEV 階段 active 時的特殊處理：
         markStage(DEV, PENDING)  // active → pending（agent 已不在）
         systemMessage 提示重新委派

  3. Barrier state 恢復：
     已完成的 barrier.completed 保留
     未完成的並行節點重新委派
```

**新增考量**：
- **context_file 存活性**：context_file 跨 session 可能被 session-cleanup 清理。pipeline-resume 時需要檢查 context_file 是否仍然存在，不存在時降級為無 context 模式（E6/E13 機制）。
- **barrier state 遷移**：若舊 session 有未完成的 barrier（如 REVIEW 完成但 TEST 未完成），新 session 需要：(1) 複製 `barrier-state-{oldSid}.json` → `barrier-state-{newSid}.json`（路徑含 sessionId 需重寫） (2) 已完成的 `barrier.completed` 保留 (3) 主 state 中對應的 `stages[stage].contextFile` 路徑也需更新 (4) 未完成的並行節點重設為 pending → 重新委派 (5) 若已完成節點被 crash 後重新委派過（E2），其 `barrier.results` 中的結果仍然有效。

---

#### E8：使用者想跳過某階段

**場景**：使用者覺得 QA 不必要，想跳過直接到 DOCS。

**防護**：

```
/vibe:pipeline skip QA 流程：
  1. 使用者在對話中表達跳過意圖
  2. Main Agent 呼叫 /vibe:pipeline skip QA
     → pipeline-controller.skipStage('QA')
     → markStageSkipped('QA')
     → stage-transition 重新計算 next
     → systemMessage: "⏭️ 跳過 QA，委派 /vibe:doc-sync"

  3. 跳過的 stage 在 Pipeline 完成摘要中標記 ⏭️
  4. guard 規則不變（pipelineActive 仍為 true）
```

**限制**：不允許跳過正在 active 的 stage（需等完成或 cancel）。

---

#### E9：使用者想取消 Pipeline

**場景**：使用者在 Pipeline 中途想放棄整個 pipeline。

**防護**（/vibe:cancel 機制）：

```
/vibe:cancel 流程：
  1. 設定 state.pipelineActive = false
  2. state.enforced = false
  3. state.activeStages = []（清空委派追蹤）
  4. state.meta.cancelled = true（向後相容保留）
  5. 清理 ~/.claude/vibe-patch-*.patch 殘留快照
  6. 可選：蒐集分類錯誤語料到 classifier-corpus.jsonl

v4 實際機制與已知限制：
  - cancel skill 由 Main Agent 直接執行（讀取 + 修改 state file）
  - 但 pipeline-guard 阻擋 Write/Edit/Bash → cancel skill 無法直接寫入
  - 解法（workaround）：cancel skill 委派 vibe:developer agent，
    delegation-tracker 將其加入 activeStages → guard rule 4 放行 →
    developer 內部修改 state file
  - guard 只看 pipelineActive 布林值 → false 即放行
```

**已知技術債務**：cancel 需要透過委派 developer agent 來繞過 guard 限制。正確做法是在 guard 中加入 cancel 白名單（類似 v3 的 CANCEL_STATE_FILE_RE），但目前的 workaround 可運作。

---

#### E10：使用者想從特定階段重新開始

**場景**：Pipeline 完成了，但使用者對 REVIEW 結果不滿意，想從 REVIEW 重新跑。

**防護**：

```
/vibe:pipeline restart REVIEW 流程：
  1. 重設指定 stage 及其後續所有 stage 為 PENDING
  2. pipelineActive = true
  3. 重設 retries[REVIEW] = 0
  4. 清理對應的 context files
  5. systemMessage: "🔄 從 REVIEW 重新開始。委派 /vibe:review"
```

---

#### E11：多 Session 衝突

**場景**：使用者開了兩個 terminal，都在同一個 project 目錄，都啟動了 pipeline。

**防護**：

```
Session 隔離：
  每個 session 有獨立的 pipeline-state-{sessionId}.json
  → 互不干擾（state 層面）

  但 codebase 層面有衝突風險：
  1. pipeline-init 檢查：是否有其他 active pipeline state file？
     if (activeOtherSessions.length > 0) {
       systemMessage 警告：
       "⚠️ 偵測到另一個 session 正在執行 Pipeline ({pipelineId})。
        同時修改 codebase 可能產生衝突。"
     }
  2. 不阻擋（只警告）— 使用者可能有意同時處理不同功能
```

---

### 8.3 資訊流（Information Flow）

#### E12：Agent 違反 §2.3 回應格式（Transcript 洩漏）

**場景**：REVIEW agent 在最終回應中包含完整報告（違反 §2.3 規範），導致 Main Agent 看到問題細節。

**防護**：

```
三道防線（縱深防禦）：

  1. Agent .md 約束（預防層）：
     品質 agent 的 .md 明確規範回應格式（§2.3）

  2. pipeline-guard 阻擋（執行層）：
     即使 Main Agent 看到問題並嘗試修復：
     → Edit/Write → 被 guard 阻擋
     → 只能委派 sub-agent

  3. 監控 + 改進（反饋層）：
     stage-transition 檢查 Sub-agent 回應長度：
     if (responseLength > 500 chars && stage is QUALITY) {
       Timeline emit: TRANSCRIPT_LEAK_WARNING
       // 不阻擋流程，但標記為改進項
     }
```

**務實態度**：100% 防止 transcript 洩漏是不可能的（LLM 不完全受控）。重要的是**即使洩漏，guard 仍然阻擋 Main Agent 自行修復**。context_file 解決的是**token 浪費**，guard 解決的是**行為越權**。

---

#### E13：context_file 被手動刪除

**場景**：使用者或 session-cleanup 刪除了 `~/.claude/pipeline-context-{sid}-REVIEW.md`，但 DEV agent 被委派時需要讀取它。

**防護**：

```
DEV agent 讀取 context_file 的防禦邏輯（寫在 agent .md 中）：

  1. 嘗試讀取 context_file 路徑
  2. 檔案不存在 → 降級：
     ├── 從 Node Context 的 hint 欄位取得提示
     ├── 自行用 Grep/Glob 搜尋問題
     └── 根據 git diff 推斷需要修復的範圍
  3. 正常完成工作 + 輸出 PIPELINE_ROUTE
```

**設計原則**：同 E6 — context_file 是增強機制，不是必要條件。

---

#### E14：Node Context 與 DAG 不一致（stale）

**場景**：DAG 在 pipeline-architect 產出後被手動修改（或 state 寫入不一致），導致 Node Context 中的拓撲資訊過時。

**防護**：

```
stage-transition 動態修正（不依賴 Node 輸出的 target）：

  1. Node 輸出 route: NEXT
  2. stage-transition 不看 Node 說的 target，而是自行查 DAG：
     const next = findNextReadyStage(state.dag, stage);
     // findNextReadyStage 會跳過 skipped/completed stages
  3. 如果 Node 指定的 target 與實際 next 不同 → warning + 用實際 next

本質：Node Context 的 next 是「參考資訊」（幫助 Node 決策），
      stage-transition 的 DAG 查詢是「執行權威」。
```

Node Context 是每次委派時動態生成的（§3.1），天然避免 stale。

---

### 8.4 並行（Parallel）

#### E15：並行結果矛盾（REVIEW PASS + TEST FAIL）

**場景**：REVIEW 和 TEST 並行執行，REVIEW 通過但 TEST 失敗。

**防護**（使用 §4.2 Barrier 合併機制）：

```
Worst-Case-Wins 策略（§4.2 mergeBarrierResults()）：

  1. 並行節點一律輸出 route: BARRIER（§2.4）
  2. Barrier 計數器收齊所有結果
  3. 合併邏輯：
     ├── 全部 PASS → 前進到 barrier.next
     └── 任一 FAIL → 整體 FAIL：
         ├── 取嚴重度最高的 FAIL
         ├── 合併所有 context_files 到彙整檔
         └── 回退到 DEV（帶完整問題報告）
  4. DEV 收到合併後的 context file：
     "## REVIEW 結果\n{review 報告}\n## TEST 結果\n{test 報告}"
     → 一次看到所有問題，一次修復
```

---

#### E16：Barrier 計數器損毀

**場景**：barrier-state 檔案損毀（寫入中斷 / JSON parse 錯誤）。

**防護**：

```
Atomic Write + 損毀恢復：

  1. 所有 barrier state 寫入使用 atomicWrite()（§4.3）
     → 大幅降低損毀機率

  2. 讀取時 JSON.parse 失敗 → 重建：
     try {
       barrier = JSON.parse(fs.readFileSync(barrierPath));
     } catch {
       // 從 pipeline-state 重建
       barrier = rebuildBarrierFromState(state);
       // state.stages 記錄了哪些 stage 已完成
       // → 推算 barrier.completed
     }

  3. pipeline-state 是 barrier 的備份源（stage 完成狀態是 SoT）
```

---

#### E17：並行 context_file 衝突

**場景**：REVIEW 和 TEST 同時寫入 context_file，路徑相同 → 互相覆蓋。

**防護**：

```
路徑設計避免衝突：

  context_file 路徑包含 stage 名稱：
  ~/.claude/pipeline-context-{sessionId}-{STAGE}.md

  REVIEW → pipeline-context-abc123-REVIEW.md
  TEST   → pipeline-context-abc123-TEST.md

  → 天然不衝突（stage 名稱不同）
```

---

### 8.5 邊界（Boundary）

#### E18：單階段 Pipeline（fix 模板）

**場景**：`[pipeline:fix]` 只有 DEV 一個階段。DAG 只有一個節點。

**防護**：

```
正常處理：
  1. DAG: { DEV: { deps: [], next: [] } }
  2. DEV 完成 → route: NEXT 或 COMPLETE
  3. stage-transition：next 為空 → 自動視為 COMPLETE
  4. pipelineActive = false

注意：單階段 pipeline 的 FAIL route 應該是 NEXT（無 DEV 可回退）
      → Policy Enforcement 處理（§5.3 已涵蓋）
```

---

#### E19：空 DAG（none pipeline）

**場景**：分類為 `none`（問答/研究），沒有建立 DAG。

**防護**：

```
none pipeline 不觸發 guard：
  1. classify() 結果為 none → 不設 pipelineActive
  2. guard evaluate()：!state?.pipelineActive → allow
  3. 使用者可自由使用所有工具
```

`pipelineActive` 布林值的語意清晰，根本消除 none pipeline 被誤 enforce 的 bug。

---

#### E20：所有階段跳過

**場景**：使用者連續跳過所有 stage → DAG 中所有 stage 都是 skipped。

**防護**：

```
stage-transition 檢查：
  if (allStagesSkippedOrCompleted(state)) {
    state.pipelineActive = false;
    systemMessage: "✅ Pipeline 完成（所有階段已跳過/完成）。"
  }
```

---

#### E21：Pipeline 進行中新的使用者請求

**場景**：Pipeline 在 DEV 階段，使用者突然發新 prompt："順便把 README 也更新一下"。

**防護**：

```
task-classifier 處理邏輯：

  1. Pipeline active 時收到新 prompt
  2. 新 prompt 含 [pipeline:xxx] → 拒絕：
     additionalContext: "⚠️ 已有 Pipeline 執行中。完成或取消後再啟動新 Pipeline。"
  3. 新 prompt 不含 pipeline 標記：
     ├── guard 仍然 active → Main Agent 只能委派
     └── 一律注入 additionalContext:
         "⚠️ Pipeline 執行中。此訊息已記錄，下次委派時 Sub-agent 可見。"
         （不嘗試區分「相關補充」vs「無關需求」— guard 已保障行為正確性）
```

---

#### E22：（已移除）ABORT Route

> **v2.1.7 移除**：ABORT route 從未被任何 agent 實際輸出，屬於死碼。所有不可恢復場景由 crash 計數器（MAX_CRASHES=3）自動處理。舊 transcript 中的 `route: "ABORT"` 會被 `validateRoute()` 自動修正為 `DEV`。

---

#### E23：maxRetries 耗盡的 UX

**場景**：REVIEW 連續 3 次 FAIL（maxRetries 耗盡），品質有風險但 pipeline 需要繼續。

**防護**：

```
UX 設計：

  1. 耗盡時不靜默前進 — 明確通知：
     systemMessage:
     "⚠️ REVIEW 已達重試上限（3/3），以下問題仍未解決：
      [{hint from FAIL routes}]
      Pipeline 將帶風險前進到下一階段。"

  2. Pipeline 完成摘要中標記：
     "REVIEW: ⚠️ FAIL（3/3 重試耗盡）"

  3. Timeline emit: RETRY_EXHAUSTED（供 Dashboard 顯示）

  4. 不暫停（pipeline 自動繼續）
     理由：暫停會破壞自動化流程。使用者可在完成後回頭處理。
```

---

### 8.6 Timeline 事件類型

邊界情境處理中引入以下 Timeline 事件，供 Dashboard/Remote consumer 訂閱：

| 事件名稱 | 觸發場景 | 攜帶資料 | 參考節 |
|----------|---------|---------|:------:|
| `ROUTE_FALLBACK` | PIPELINE_ROUTE 解析失敗 → 預設 PASS/NEXT | `{ stage, warning }` | E1 |
| `AGENT_CRASH` | Sub-agent 異常終止（無 PIPELINE_ROUTE） | `{ stage, crashCount }` | E2 |
| `PIPELINE_CANCELLED` | 使用者 /vibe:cancel | `{ reason, completedStages }` | E9 |
| `TRANSCRIPT_LEAK_WARNING` | Sub-agent 回應超過長度閾值（可能含報告） | `{ stage, responseLength }` | E12 |
| `RETRY_EXHAUSTED` | shouldStop 條件 (2) 觸發 FORCE_NEXT | `{ stage, retryCount, reason }` | E5 |

### 向下相容移除（v5.0.0+）

**v3 Pipeline State 遷移支援已移除**：

從 v2.0.9 到 v2.2.8，系統提供自動遷移機制（`state-migrator.js`），將 v3 舊格式的 pipeline state（及更早版本）升級為 v4 結構。

**自 v5.0.0 起，此遷移機制已刪除**：

- `state-migrator.js` 中的 `migrateStateVersion()` 函式已移除
- 不再識別並轉換 v3 格式的 `pipeline-state-{sid}.json`
- 舊 v3 state 檔案會被視為無效並被系統忽略（pipeline-init 檢查版本字段時拒絕 v3 state）

**影響**：

- **新 session**（v5.0.0 之後啟動）：無影響，直接建立 v4 state
- **恢復舊 session**（v2.2.8 或更早的 session ID）：
  - 若 `~/.claude/pipeline-state-{sessionId}.json` 格式為 v3 → 被忽略
  - Pipeline 重新初始化為新 v4 state（狀態丟失）
  - 舊 session 的進度無法恢復

**遷移建議**：

如果使用者有進行中的 v2.2.8 pipeline session，應在升級至 v5.0.0 前完成。升級後無法恢復舊 session 的 pipeline 狀態。

---

## 9. 風險評估

| 風險 | 嚴重度 | 緩解 | 實際狀態 |
|------|:------:|------|:--------:|
| **Transcript 洩漏**（Sub-agent 回應含完整報告） | **高** | 三道防線：context_file + 回應格式約束（§2.3）+ guard 阻擋寫入 | ⚠️ 仍會發生（LLM 不完全受控），但 guard 保證即使洩漏也無法自行修復 |
| 節點輸出格式錯誤 | 中 | 四層 fallback（§3.3）：PIPELINE_ROUTE → VERDICT → inferRouteFromContent → 預設值 | ✅ Layer 3 大幅降低 fallback 到預設值的機率 |
| Context file 路徑錯誤或檔案不存在 | 中 | Sub-agent 讀取前檢查 `fs.existsSync`，不存在時按無 context 處理 | ✅ 穩定 |
| Context file 過大（累積） | 低 | 每次寫入限制 5000 chars（§2.2）+ session-cleanup 定期清理 | ✅ 穩定 |
| 並行 barrier 遺漏（節點 crash） | 中 | Barrier timeout + barrier-crash guard（§8.1 E2）排除 crashed sibling 下游 | ✅ 穩定 |
| Agent .md 改動影響 | 中 | ⛔ 強制輸出聲明（非條件式），降低遺漏機率 | ✅ 穩定 |
| Retry 計數不一致 | 低 | stage-transition 獨占讀寫 + Policy Enforcement 覆寫（§5.3） | ✅ 穩定 |
| Dashboard 狀態不一致 | 低 | 保留全域 state 快照（Atomic Write） | ✅ 穩定 |
| State 寫入損毀 | 低 | Atomic Write（`pid.timestamp.counter` 三因子唯一性 + renameSync） | ✅ 穩定 |
| Self-Refine 降級不當 | 中 | CRITICAL 永不降級 + 降級建議寫入 context_file 供後續 stage 二次檢查 | ✅ 穩定 |
| Reflexion Memory 累積過大 | 低 | 每輪 ≤ 500 chars，總計 ≤ 3000 chars + PASS 後自動清理 | ✅ 穩定 |
| **系統通知誤分類** | 中 | background task 完成通知由 classifier 的 `isSystemFeedback()` 函式偵測（SYSTEM_MARKER + emoji 前綴），確保不觸發意外 pipeline；v2.2.0 整合為核心 Layer 1 | ✅ 已解決 |
| **Cancel skill 死鎖** | 中 | pipeline-guard 阻擋 cancel 寫入 state file，需透過委派 developer 繞過 | ⚠️ workaround 可運作 |
| Context Window 壓縮 | 高 | Node Context 三層截斷策略（reflectionContent → 清空 → 只保留 hint） | ⚠️ 根因為 MCP 工具定義佔用 |

---

## 附錄 A：完整 PIPELINE_ROUTE Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["verdict", "route"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["PASS", "FAIL"]
    },
    "route": {
      "type": "string",
      "enum": ["NEXT", "DEV", "BARRIER", "COMPLETE"]
    },
    "severity": {
      "type": "string",
      "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
      "description": "FAIL 時的嚴重度"
    },
    "context_file": {
      "type": "string",
      "description": "透傳給下一個節點的 context 檔案路徑（~/.claude/pipeline-context-{sid}-{stage}.md）。大小上限 5000 chars（見 §2.2）"
    },
    "hint": {
      "type": "string",
      "description": "給下一個節點的簡短提示"
    },
    "warning": {
      "type": "string",
      "description": "策略覆寫說明（如 exceeded retry limit）"
    },
    "barrierGroup": {
      "type": "string",
      "description": "並行 barrier 群組 ID（route=BARRIER 時必填）"
    }
  }
}
```

---

## 附錄 B：Node Context Schema

注意：實際傳入 Sub-agent 的格式使用 `node` wrapper（見 §2.1），Schema 定義 `node` 內部結構：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["node"],
  "properties": {
    "node": {
      "type": "object",
      "required": ["stage"],
      "properties": {
        "stage": {
          "type": "string",
          "description": "當前節點的 stage ID"
        },
        "prev": {
          "type": "array",
          "items": { "type": "string" },
          "description": "前驅節點 ID"
        },
        "next": {
          "type": "array",
          "items": { "type": "string" },
          "description": "後繼節點 ID（空陣列表示最後一個 stage）"
        },
        "onFail": {
          "type": ["object", "null"],
          "description": "QUALITY stage 必有；IMPL stage 為 null",
          "properties": {
            "target": { "type": "string" },
            "maxRetries": { "type": "integer" },
            "currentRound": { "type": "integer" }
          }
        },
        "barrier": {
          "type": ["object", "null"],
          "properties": {
            "group": { "type": "string" },
            "total": { "type": "integer" },
            "siblings": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }
      }
    },
    "context_files": {
      "type": "array",
      "items": { "type": "string" },
      "description": "前驅節點的 context 檔案路徑（barrier 收斂時可能有多個）"
    },
    "env": {
      "type": "object",
      "description": "env-detector 偵測結果（語言、框架、前端偵測）",
      "properties": {
        "language": { "type": "string" },
        "framework": { "type": "string" },
        "frontend": {
          "type": "object",
          "properties": {
            "detected": { "type": "boolean" }
          }
        }
      }
    },
    "retryContext": {
      "type": ["object", "null"],
      "description": "Reflexion Memory 摘要（首次執行為 null，回退時注入）。見 §7.1",
      "properties": {
        "round": {
          "type": "integer",
          "description": "當前回退輪次（從 state.retries[failedStage] + 1 計算）"
        },
        "reflectionFile": {
          "type": "string",
          "description": "反思記憶檔案路徑（~/.claude/reflection-memory-{sid}-{failedStage}.md）"
        },
        "failedStage": {
          "type": "string",
          "description": "觸發 FAIL 的品質 stage（如 REVIEW），用於定位反思記憶"
        },
        "hint": {
          "type": "string",
          "description": "給 agent 的閱讀提示"
        }
      }
    }
  }
}
```

---

## 附錄 C：Pipeline State Schema

Pipeline 使用兩個獨立的 state 檔案：

### C.1 主 State（`pipeline-state-{sessionId}.json`）

```json
{
  "sessionId": "abc-123",
  "pipelineActive": true,
  "classification": {
    "pipelineId": "standard",
    "taskType": "feature",
    "source": "explicit",
    "timestamp": 1708300000000
  },
  "dag": {
    "PLAN":   { "deps": [], "next": ["ARCH"], "onFail": null },
    "ARCH":   { "deps": ["PLAN"], "next": ["DEV"], "onFail": null },
    "DEV":    { "deps": ["ARCH"], "next": ["REVIEW", "TEST"], "onFail": null },
    "REVIEW": { "deps": ["DEV"], "next": ["DOCS"], "onFail": "DEV",
                "maxRetries": 3, "barrier": { "group": "post-dev", "total": 2, "siblings": ["REVIEW", "TEST"] } },
    "TEST":   { "deps": ["DEV"], "next": ["DOCS"], "onFail": "DEV",
                "maxRetries": 3, "barrier": { "group": "post-dev", "total": 2, "siblings": ["REVIEW", "TEST"] } },
    "DOCS":   { "deps": ["REVIEW", "TEST"], "next": [], "onFail": null }
  },
  "stages": {
    "PLAN":   { "status": "completed", "contextFile": null },
    "ARCH":   { "status": "completed", "contextFile": null },
    "DEV":    { "status": "completed", "contextFile": null },
    "REVIEW": { "status": "active",    "contextFile": null },
    "TEST":   { "status": "active",    "contextFile": null },
    "DOCS":   { "status": "pending",   "contextFile": null }
  },
  "activeStages": ["REVIEW", "TEST"],
  "retries": {
    "REVIEW": 0,
    "TEST": 0
  },
  "crashes": {},
  "retryHistory": {
    "REVIEW": [
      { "round": 1, "severity": "HIGH", "hint": "flag logic error", "timestamp": 1708300100 },
      { "round": 2, "severity": "MEDIUM", "hint": "edge case missing", "timestamp": 1708300200 }
    ]
  },
  "environment": {
    "languages": { "primary": "TypeScript" },
    "framework": { "name": "React" },
    "frontend": { "detected": true }
  },
  "meta": {
    "lastTransition": "2024-02-19T00:00:00.000Z",
    "reclassifications": []
  }
}
```

**寫入方式**：所有主 state 寫入均使用 **Atomic Write**（`atomicWrite()`，見 §4.3）。

**欄位說明**：

| 欄位 | 類型 | 說明 | 寫入者 |
|------|------|------|--------|
| `pipelineActive` | boolean | Guard 唯一判斷依據 | classify / stage-transition / cancel |
| `classification` | object | 分類結果 | task-classifier |
| `dag` | object | DAG 結構（建立後不變） | classify / pipeline-architect |
| `stages` | object | 各 stage 即時狀態 | stage-transition |
| `stages[].status` | enum | `pending` / `active` / `completed` / `failed` / `skipped` | stage-transition |
| `stages[].contextFile` | string? | 該 stage 產出的 context file 路徑 | stage-transition（從 ROUTE 讀取） |
| `activeStages` | string[] | 目前正在執行的 stages（並行時多個） | delegation-tracker |
| `retries` | object | 各 stage 重試計數 | stage-transition |
| `crashes` | object | 各 stage crash 計數 | stage-transition |
| `retryHistory` | object | 各 stage 的歷史 verdict 摘要陣列（§7.3 收斂偵測用）。格式：`{ [stage]: [{ round, severity, hint, timestamp }] }` | stage-transition |
| `environment` | object | 環境偵測結果（含 `languages`、`framework`、`frontend` 等巢狀欄位） | pipeline-init（via env-detector） |

### C.2 Barrier State（`barrier-state-{sessionId}.json`）

```json
{
  "post-dev": {
    "total": 2,
    "completed": ["REVIEW"],
    "results": {
      "REVIEW": { "verdict": "PASS", "route": "BARRIER" }
    },
    "next": "QA",
    "createdAt": "2024-02-19T00:00:00.000Z",
    "resolved": false
  }
}
```

**欄位說明**：

| 欄位 | 說明 |
|------|------|
| `total` | 並行節點總數 |
| `completed` | 已完成的節點 ID |
| `results` | 各節點的 PIPELINE_ROUTE（用於合併） |
| `next` | 全部到齊後的下一個 stage |
| `createdAt` | 建立時間 ISO 8601 字串（用於 timeout 偵測） |
| `resolved` | 是否已處理（防重複觸發） |

### C.3 Context File（`pipeline-context-{sessionId}-{stage}.md`）

暫存檔，由 Sub-agent 寫入，下一個 Sub-agent 讀取。格式為 Markdown，無 schema 限制。

**生命週期**：Pipeline 完成 / cancel / session-cleanup 時清理。

---

## 附錄 D：設計決策紀錄

| 決策 | 來源 | 處置 | 說明 |
|------|------|:----:|------|
| 檔案路徑傳遞 Context | Gemini 建議 2.3 | ✅ 採納 | `context_file` 取代 inline context，實現物理隔離 |
| Atomic Write | Gemini 建議 2.1 | ✅ 部分採納 | 主 state + barrier state 統一用 atomic write，barrier 仍獨立檔案 |
| Schema Validation + Policy Enforcement | Gemini 建議 2.2 | ✅ 採納 | 雙層驗證，強化 §5.3 |
| env-detector 注入 Node Context | Gemini 建議 3.H2 | ✅ 採納 | `env` 欄位加入 Node Context Schema |
| pipelineActive 二元 Guard | 架構決策 | ✅ 採納 | 取代複雜的 5-phase 推導，大幅降低 guard 實作複雜度 |
| Barrier 計數器 | 架構決策 | ✅ 採納 | 取代全量 DAG 查詢（O(stages×deps) → O(1)） |
| context_file 獨立暫存 | 架構決策 | ✅ 採納 | 解決 transcript 洩漏問題，實現 Main Agent 物理資訊隔離 |
| Reflexion Memory Markdown 格式 | 架構決策 | ✅ 採納 | 讓 LLM 可直接閱讀，減少解析層 |
| Shadow Controller | Gemini 建議 2.2 | ❌ 不採納 | 增加複雜度，違背精簡原則。Schema Validation + fallback 足夠 |
| output_route Skill | Gemini 建議 2.2 | ❌ 不採納 | Agent prompt 定義 JSON 格式即可，額外 Skill 過度工程化 |
| 單一 State + File Lock | Gemini 建議 2.1 | ❌ 不採納 | Barrier state 生命週期與主 state 不同，拆分更清晰 |
