# Pipeline v4 -- Node-based 分散式架構（設計草案）

> Pipeline v4 架構設計草案。從集中式 DAG 控制器演進為分散式節點自治模型。
> 狀態：**概念設計階段** -- 尚未實作。
> 參考：Gemini 建議書 `pipeline-v4-建議書-gemini.md` 的有效建議已整合至本文件。

---

## 1. 設計動機

### v3 的結構性問題

Pipeline v3 採用集中式 DAG 狀態管理，所有路由決策由 `pipeline-controller.js` 中央控制：

```
Main Agent ──→ pipeline-controller ──→ Sub-agent
                    ↑                      │
                    └──── state file ←─────┘
```

這導致三類問題：

| 問題 | 根因 | 實例 |
|------|------|------|
| **Phase 推導錯誤** | `derivePhase()` 5~6 個條件分支（含安全網），任一判斷錯誤 → guard 間隙 | v1.0.56 「分類但無 DAG」間隙 |
| **全域狀態腐敗** | 單一 JSON 檔案被多個 hook 並行讀寫 | v1.0.58 cancel 死鎖（suggest-compact 寫入競態） |
| **Main Agent 自行修復** | systemMessage 包含詳細問題報告 → Main Agent「看到」問題 → 嘗試繞過 guard 自行修復 | 實際案例：REVIEW FAIL 後 Main Agent 直接用 Edit 修復（guard 阻擋但浪費 context） |

### 核心洞察

> **Main Agent 不應該知道「要修什麼」，只應該知道「要路由到哪」。**

v4 的設計目標：讓 Main Agent 成為純粹的訊息匯流排（message bus），路由決策由節點自己做出。

---

## 2. 架構總覽

### v3 vs v4 變更摘要

| 維度 | v3（集中式 DAG） | v4（分散式 Node） |
|------|-----------------|-------------------|
| 狀態模型 | 全域 `pipeline-state-{sid}.json` | 每個節點輸出 `PIPELINE_ROUTE` |
| 路由決策 | `pipeline-controller.js` 中央控制 | 節點自治（含 policy 上限） |
| Main Agent 角色 | Router + 接收詳細報告 | 純 Relay（只看路由指令） |
| Guard 複雜度 | 5 phases × 多條件分支（v1.0.58 統一 canProceed→evaluate 單入口） | 二元：`pipeline active → relay mode` |
| 資訊流 | Sub-agent → state file → Main Agent → 下一個 Sub-agent | Node → Route 指令 → Main Agent relay → 下一個 Node |
| 並行 | `getReadyStages()` DAG 查詢 | Barrier 計數器 |
| 新增 stage | 改 registry + controller + guard + skip-predicates | 寫一個新 Node agent |

### 靜態架構圖

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

### 動態流程圖（端到端）

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
    │                           │              /vibe:pipeline
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

## 3. Node 協議

### 3.1 Node Context（委派時傳入）

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

### 3.2 PIPELINE_ROUTE（節點輸出）

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

**關鍵設計**：詳細報告寫入 **暫存檔**（`context_file`），PIPELINE_ROUTE 只傳遞 **檔案路徑**。Main Agent 只讀 `route` 欄位決定下一步，完全看不到問題細節。

> **設計原則（來自 Gemini 建議 2.3）**：如果 context 放在 JSON 中，Main Agent 的 Context Window 仍會吃到這些 token。改用檔案路徑，Main Agent 只傳遞路徑字串 -- 真正的「完全瞎了」，且節省 token。

#### Context File 規範

- **路徑格式**：`~/.claude/pipeline-context-{sessionId}-{stage}.md`
- **寫入者**：Sub-agent（在輸出 PIPELINE_ROUTE 前）
- **讀取者**：下一個 Sub-agent（由 stage-transition 注入到委派 prompt）
- **生命週期**：Pipeline 完成或 cancel 時由 session-cleanup 清理
- **大小上限**：5000 chars（超出時保留 TOP 5 問題的完整描述，截斷其餘）

### 3.3 Sub-agent 回應隔離（Transcript 防洩漏）

> **關鍵問題**：在 ECC 中，Sub-agent 完成後，其完整回應文字會作為 `Task` 工具的 result 回到 Main Agent 的 Context Window。即使 PIPELINE_ROUTE 只含檔案路徑，如果 Sub-agent 的回應中包含完整報告，Main Agent 仍然會「看到」問題細節。

**解法**：Agent `.md` 中必須明確約束最終回應格式。

#### 品質 Agent 回應規範（REVIEW / TEST / QA / E2E）

```markdown
## 最終回應格式（Pipeline 模式）

當你在 Pipeline 模式下運行時，你的最終回應必須遵守以下格式：

1. 先將完整報告寫入 context file（使用 Write 工具）
2. 最終回應只包含：
   - 一行結論（PASS/FAIL + 問題數量）
   - PIPELINE_ROUTE 標記

範例：
---
REVIEW 完成：FAIL（2 CRITICAL, 1 HIGH）

<!-- PIPELINE_ROUTE: { "verdict":"FAIL", "route":"DEV", ... } -->
---

❌ 禁止在回應中重複完整報告內容。
```

#### 資訊隔離的兩道防線

| 防線 | 機制 | 隔離對象 |
|:----:|------|---------|
| **1. context_file** | 詳細報告寫入檔案，ROUTE 只含路徑 | systemMessage 中的資訊 |
| **2. 回應格式約束** | Agent .md 規範只輸出結論 + ROUTE | Task result 中的資訊 |

兩道防線缺一不可 — 第一道防止 hook 注入報告，第二道防止 transcript 洩漏。

### 3.4 路由指令類型

| route 值 | 語意 | Main Agent 行為 |
|-----------|------|----------------|
| `"NEXT"` | 成功，前進到下一個節點（**僅限非並行節點**） | stage-transition 從 DAG 查找 `node.next` 並委派 |
| `"DEV"` | 失敗，回退到 DEV 修復（**僅限非並行節點**） | 委派 DEV，帶入 `context_file` 路徑 |
| `"BARRIER"` | 並行節點完成（verdict 攜帶 PASS/FAIL） | barrier 合併結果，全到齊後決定路由 |
| `"COMPLETE"` | 最後一個節點完成 | Pipeline 結束，解除 relay mode |
| `"ABORT"` | 不可恢復的錯誤 | Pipeline 異常終止 |

#### 並行節點的路由規則

並行節點（`node.barrier != null`）**一律輸出 `route: BARRIER`**，不論 verdict 是 PASS 還是 FAIL：

```
PASS 情況：{ "verdict": "PASS", "route": "BARRIER", "barrierGroup": "post-dev" }
FAIL 情況：{ "verdict": "FAIL", "route": "BARRIER", "barrierGroup": "post-dev",
             "severity": "CRITICAL", "context_file": "...", "hint": "..." }
```

**為什麼不直接輸出 DEV？** 如果 TEST FAIL 立即路由到 DEV，而 REVIEW 仍在執行中：
1. DEV 只看到 TEST 的問題，遺漏 REVIEW 可能發現的 CRITICAL 問題
2. REVIEW 完成後無處可去（barrier 已被提前觸發）
3. 需要額外的「等待中斷」機制 — 增加不必要的複雜度

**Barrier 合併** → stage-transition 收齊所有結果後統一決定路由（見 5.2 節）。

---

## 4. Main Agent Relay 機制

### 4.1 Guard 簡化

v4 的 guard-rules 極度簡化 -- 不需要 phase 推導：

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

**差異**：
- v3：5 個 phase + 多條件分支 + 2 種阻擋理由
- v4：1 個布林值 `pipelineActive` + 工具白名單

**為什麼不需要區分 CLASSIFIED vs DELEGATING**：在 ECC 序列委派模式中，Main Agent 呼叫 Task 工具後等待 Sub-agent 完成，此期間不會有其他工具呼叫觸發 guard。Guard 只需在「Sub-agent 完成後、Main Agent 下一次操作前」生效 — 此時 Main Agent 只需委派下一個 stage（Task/Skill 放行），任何直接修改都被阻擋。在並行委派模式中（見 5.3 節），兩個 Task 結果依序返回，每次返回後 guard 評估點同上。v3 的 CLASSIFIED（等待委派）和 DELEGATING（正在委派）區分在 v4 中無意義。

### 4.2 Node Context 生成流程

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
    // Reflexion Memory 注入（getRetryContext 實作見下方，反思記憶格式見 10.1 節）
    retryContext: getRetryContext(sessionId, stage, state)
  };
}

/**
 * 從 Reflexion Memory 讀取回退上下文（10.1 節詳述）
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
- `retryContext` 從 Reflexion Memory 檔案讀取（10.1 節），首次執行時為 null
- `getRetryContext()` 透過 `state.retries` + `dag[s].onFail` 反向查找 failedStage，解決 stage 參數（委派目標 DEV）與反思記憶命名（品質 stage REVIEW）的錯位問題

### 4.3 Relay 邏輯

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
             ├── route=COMPLETE→ "✅ Pipeline 完成。自動模式解除。"
             └── route=ABORT   → "⛔ Pipeline 異常終止。"
```

Main Agent **只看 systemMessage**，不看 sub-agent 的回應內容（回應被 3.3 約束為一行結論）。

**自動 COMPLETE 規則**：當 Node 輸出 `route: NEXT` 但 DAG 中該 stage 的 `next` 為空陣列時，stage-transition 自動將其視為 `route: COMPLETE`。Node 不需要知道自己是否是最後一個 stage — stage-transition 統一處理。這簡化了 agent .md 的邏輯（所有 IMPL stage 都只需輸出 PASS/NEXT）。

#### PIPELINE_ROUTE 解析路徑

stage-transition hook 從 `agent_transcript_path`（SubagentStop hook stdin 欄位）讀取 Sub-agent transcript，解析 PIPELINE_ROUTE：

```javascript
function parseRoute(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  // Transcript 是 JSONL 格式，讀取最後一條 assistant message
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  // 從後往前掃描最後 MAX_SCAN_LINES 行（避免全量掃描長 transcript）
  const MAX_SCAN_LINES = 30;  // v3 parseVerdict 用 20 行，v4 放寬到 30
  const startIdx = Math.max(0, lines.length - MAX_SCAN_LINES);
  for (let i = lines.length - 1; i >= startIdx; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.role !== 'assistant') continue;

      // 在 message content 中搜尋 PIPELINE_ROUTE
      const text = typeof entry.content === 'string'
        ? entry.content
        : (entry.content || []).map(b => b.text || '').join('');

      const match = text.match(/<!-- PIPELINE_ROUTE:\s*([\s\S]*?)\s*-->/);
      if (match) {
        return JSON.parse(match[1]);
      }
    } catch (_) {}
  }
  return null;  // 解析失敗 → E1 fallback
}
```

**注意**：
- ECC 的 SubagentStop hook stdin 使用 `agent_transcript_path`（非 `transcript_path`），v3 的 stage-transition.js 已使用此欄位名
- `parseRoute()` 取代 v3 的 `verdict.js` 中 `parseVerdict()` 函式。v3 掃描最後 20 行，v4 放寬到 30 行以容納 PIPELINE_ROUTE 的較長 JSON 格式
- 掃描失敗（超過 30 行仍未找到）→ 返回 null → E1 fallback 處理

### 4.4 Stage 識別與狀態追蹤

stage-transition（SubagentStop hook）如何知道「哪個 stage 剛完成」：

```
delegation-tracker（PreToolUse Task hook）：
  1. 攔截 Task 工具呼叫
  2. 從 prompt / description 中解析目標 stage
  3. 寫入 state.activeStages（push "REVIEW"）
  4. stage-transition 讀取 state.activeStages 即知道是哪些 stage

v4 保留 v3 的 delegation-tracker 機制（不改變）。
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

delegation-tracker（步驟 1）在 stage-transition（步驟 4）之前執行，因此 `activeStages` 永遠是最新的。並行時用陣列 push/pop 維護，stage-transition 從陣列中移除完成的 stage。

**Stage 識別機制**（並行時如何知道是哪個 stage 完成）：
- delegation-tracker 在 push 時同時記錄 **agent type → stage** 映射
- stage-transition 從 SubagentStop stdin 的 `agent_transcript_path` 解析 agent type（與 v3 邏輯相同）
- 透過 `NAMESPACED_AGENT_TO_STAGE` 映射（registry.js）反查 stage name
- 從 activeStages 中 pop 該 stage

**pipelineActive 生命週期**：

| 事件 | pipelineActive | 設定者 |
|------|:-:|------|
| 顯式 `[pipeline:xxx]` 分類 | `true` | pipeline-controller.classify() |
| pipeline-architect DAG 建立 | `true` | stage-transition（解析 DAG 輸出） |
| 最後一個 stage 完成（route: COMPLETE） | `false` | stage-transition |
| 使用者 /vibe:cancel | `false` | cancel skill → controller API |
| route: ABORT | `false` | stage-transition |
| Session /clear | `false` | pipeline-init（清除 state） |

### 4.5 資訊隔離

v3 的問題：Main Agent 收到 REVIEW 的完整報告（包含具體 bug 描述），因此「知道」可以修什麼。

v4 的解法 -- **檔案路徑隔離**：

```
v3 資訊流（洩漏）：
  REVIEW agent → transcript（含完整報告）→ Main Agent Context Window 可見

v4 資訊流（徹底隔離）：
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
❌ C-1: adaptV3 clearing expectedStages breaks 7 downstream features...
❌ H-1: !alive catches undefined...
```

這些細節只存在於 `~/.claude/pipeline-context-{sid}-REVIEW.md` 中，由 DEV agent 自行讀取。

> **vs v3 原始 opaque 設計**：即使 JSON 中標記 context 為 "opaque"，Main Agent 的 Context Window 仍然包含完整內容（LLM 無法選擇性忽略 token）。檔案路徑是唯一能實現物理隔離的方式。

---

## 5. 並行執行

### 5.1 Barrier 機制

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

### 5.2 Barrier 計數器與結果合併

stage-transition hook 維護一個簡單計數器（取代 DAG 的 `getReadyStages()` 查詢）：

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
    "startTime": 1708300000000
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

#### 寫入安全

主 pipeline state 和 barrier state 均使用 **Atomic Write**（寫入暫存檔 + `fs.renameSync`）：

```javascript
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);  // POSIX rename 是原子操作
}
```

> **設計決策（來自 Gemini 建議 2.1）**：Atomic Write 解決並發寫入損毀，不需要 File Lock。Barrier state 仍使用獨立檔案（生命週期與主 state 不同），但寫入方式統一。

### 5.3 ECC 並行委派行為模型

v4 的 Barrier 機制依賴 Main Agent 能同時委派多個 Sub-agent。以下明確記錄 ECC 的實際行為：

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

**關鍵假設**（⚠️ **待驗證**：Phase 0 實作前需用實驗確認）：
- ECC 是否支持單一 response 中多個 Task tool_use blocks — **尚未驗證**
- SubagentStop hooks **依序觸發**（一個處理完才觸發下一個）— 基於 ECC hook 串行執行的已知行為
- 因此 barrier state 的 read-modify-write 不會有並發競態
- 即使 ECC 未來改為真正並行 hook 觸發，Atomic Write 提供最後防線

**退化策略**：若 ECC 不支持並行 Task：
- Main Agent 序列委派（先 REVIEW 完成後再 TEST）
- Barrier 退化為序列收集結果
- Pipeline 正確性不受影響，只是失去並行加速
- 此為 **無損退化**，不影響任何其他 v4 機制

**驗證方法**（建議在 Phase 0 之前執行）：
```
實驗：在 ECC 中發送包含兩個 Task tool_use blocks 的 response
觀察：(1) 兩個 Sub-agent 是否同時啟動
       (2) SubagentStop hooks 的觸發順序和時序
       (3) Main Agent 是否收到兩個 tool_result
```

### 5.4 vs v3 DAG 查詢

| 面向 | v3 `getReadyStages()` | v4 Barrier |
|------|:---:|:---:|
| 查詢方式 | 遍歷 DAG 所有節點，檢查 deps 是否滿足 | 讀取計數器，檢查 `completed.length === total` |
| 複雜度 | O(stages × deps) | O(1) |
| 狀態修改 | 讀取全域 state | 修改獨立的 barrier 檔案 |
| 競態風險 | 高（全域 state 並行寫入） | 低（每個 barrier group 獨立檔案） |

---

## 6. 節點自治 vs Policy 上限

### 6.1 節點自主決策

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

> IMPL 階段不需要判斷 FAIL — 如果寫不完（crash），由 E2 crash 處理。stage-transition 在 `next` 為空時自動轉為 COMPLETE（4.3 節）。

#### QUALITY 階段（REVIEW / TEST / QA / E2E）

QUALITY 階段根據審查結果做路由決策。注意：Agent 做第一層判斷，stage-transition 做第二層驗證（Policy Enforcement 6.3 + shouldStop 10.3），三層組成 defense-in-depth：

```javascript
// REVIEW agent 的決策邏輯（agent .md 中定義）
// 這是第一道（Agent 自主判斷）— 可能被第二道/第三道覆寫

// Step 1: 寫入 context file（完整報告）
Write("~/.claude/pipeline-context-{sid}-REVIEW.md", fullReport);

// Step 2: 根據結果和 Node Context 決定路由
if (hasCriticalOrHigh) {
  // Agent 根據 Node Context 的 onFail.currentRound 決定是否回退
  // （stage-transition 的 Policy Enforcement 會二次驗證此決策）
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

// Step 3: 最終回應只含結論（3.3 規範）
response: "REVIEW 完成：FAIL（2 CRITICAL）\n<!-- PIPELINE_ROUTE: {...} -->"
```

**三道 Retry 防線**（使用「道」避免與 6.3 節的 Layer 1/2 術語衝突）：

```
第一道（Agent 自主）：根據 node.onFail 做初步判斷 → 輸出 PIPELINE_ROUTE
    │
    v
第二道（Policy Enforcement，6.3 節）：修正邏輯矛盾
    ├── PASS+DEV → 強制 NEXT
    └── DEV + retries≥maxRetries → 強制 NEXT
    │
    v
第三道（shouldStop()，10.3 節）：收斂偵測（唯一新增能力）
    └── 連續 2 輪相同 severity → FORCE_NEXT（停滯偵測）
```

**重疊關係說明**：第一道和第二道的 MAX_RETRIES 判斷有意重疊（defense-in-depth — 即使 Agent 判斷錯誤，Policy 仍能攔截）。第二道和第三道的職責不重疊（6.3 修正不合法路由，10.3 偵測合法 FAIL 的收斂趨勢）。第三道的收斂停滯偵測是第一道/第二道無法覆蓋的新能力。

### 6.2 Policy 傳遞與 Retry 持久化

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

**為什麼不能純分散式**：Node Context 是委派時動態生成的一次性資料，Sub-agent 無法跨呼叫保持狀態。`currentRound` 必須在某處持久化，才能在「DEV → REVIEW → FAIL → DEV → REVIEW」循環中正確遞增。

**折衷設計**：
- **持久化**：`pipeline-state.retries` 由 stage-transition **獨占讀寫**
- **傳遞**：Node Context 的 `onFail.currentRound` 是唯讀快照
- **決策**：Node 根據 `currentRound` vs `maxRetries` 做路由決策
- **防護**：stage-transition 的 Policy Enforcement 作為最後防線（6.3 節）

### 6.3 不可信節點防護

節點是 LLM，輸出本質上不可控。stage-transition hook 是最後防線，執行兩層驗證：

#### Layer 1：Schema Validation（格式正確性）

```javascript
function validateRoute(parsed) {
  // 必要欄位
  if (!parsed.verdict || !parsed.route) return null;
  // 合法 verdict
  if (!['PASS', 'FAIL'].includes(parsed.verdict)) return null;
  // 合法 route
  if (!['NEXT', 'DEV', 'BARRIER', 'COMPLETE', 'ABORT'].includes(parsed.route)) return null;
  // FAIL 必須有 severity
  if (parsed.verdict === 'FAIL' && !parsed.severity) parsed.severity = 'MEDIUM';
  // BARRIER 必須有 barrierGroup
  if (parsed.route === 'BARRIER' && !parsed.barrierGroup) return null;
  return parsed;
}
```

驗證失敗 → 預設 `{ verdict: 'PASS', route: 'NEXT' }` + warning: "route-parse-failed"。

#### Layer 2：Policy Enforcement（邏輯正確性）

```javascript
// 矛盾檢查：PASS 不能路由到 DEV
if (route.verdict === 'PASS' && route.route === 'DEV') {
  route.route = 'NEXT';
  route.warning = 'policy override: PASS cannot route to DEV';
}

// 重試上限（從持久化 state 讀取，不依賴 Node Context 快照）
const stage = state.activeStages?.[0] || currentStage;
const currentRetries = (state.retries?.[stage] || 0);
const maxRetries = state.dag?.[stage]?.maxRetries || 3;
if (route.route === 'DEV' && currentRetries >= maxRetries) {
  route.route = 'NEXT';
  route.warning = `policy override: exceeded maxRetries (${currentRetries}/${maxRetries})`;
}

// 無 DEV 節點的 pipeline（如 review-only/docs-only）→ FAIL 不回退（見 8.1 節 onFail 規則）
if (route.route === 'DEV' && !state.dag?.DEV) {
  route.route = 'NEXT';
  route.warning = 'policy override: no DEV stage in DAG, forced NEXT';
}

// 並行節點必須使用 BARRIER route（見 3.4 節並行路由規則）
const node = state.dag?.[stage];
if (node?.barrier && route.route !== 'BARRIER') {
  route.route = 'BARRIER';
  route.barrierGroup = node.barrier.group;
  route.warning = 'policy override: parallel node must use BARRIER route';
}

// 注意：實際路由目標由 stage-transition 從 DAG 計算（E14 節），
// Node 不指定目標 stage。因此不需要拓撲違規檢查。
// Policy Enforcement 從 state（持久化源）讀取 retries，而非 Node Context（快照）。
```

---

## 7. 漸進遷移路線

### Phase 0：Context Protocol（v3.2）

> 來自 Gemini 建議 4.1 — 先解決「資訊洩漏」，再處理「控制權轉移」。

**改動範圍**：Agent 定義 + stage-transition hook（最小改動）

1. 品質 agents 完成後，將詳細報告寫入 **context file**（`~/.claude/pipeline-context-{sid}-{stage}.md`）
2. stage-transition 的 systemMessage 不再包含詳細報告，改為路徑引用
3. 後續 agent（如 DEV）從 context file 讀取前一階段產出
4. 此階段不引入 PIPELINE_ROUTE（先改資訊流，不改路由協議）

**目標**：讓 agents 習慣「從檔案讀 context」的模式，Main Agent 不再看到問題細節。
**驗證**（量化指標）：
1. **Transcript 檢查**：品質 agent 完成後，Main Agent 的 context window 中搜尋品質報告特徵字串（如 `C-1:`、`H-1:`、`CRITICAL`）— 預期出現次數 = 0（只在 context_file 中）
2. **systemMessage 長度**：回退場景的 systemMessage < 200 tokens（vs v3 可能 2000+ tokens）
3. **行為驗證**：Main Agent 收到 FAIL 後不嘗試 Edit/Write（只委派 DEV）— 透過 pipeline-guard 阻擋計數確認

**風險**：低（只改 systemMessage 內容和 agent 讀取方式，不改路由邏輯）。

### Phase 1：PIPELINE_ROUTE 協議（v4.0-alpha）

**改動範圍**：Agent 定義 + stage-transition hook

1. 品質 agents（code-reviewer, tester, qa）輸出 PIPELINE_ROUTE
2. PIPELINE_ROUTE 包含 `context_file` 路徑（Phase 0 已建立的機制）
3. Schema Validation + Policy Enforcement（6.3 節）
4. 其他模組不變

**驗證**：現有 e2e-hook-chain 測試擴充 ROUTE 解析場景

### Phase 2：Node Context 注入（v4.0-beta）

**改動範圍**：stage-transition + delegation-tracker

1. stage-transition 委派時自動注入 Node Context（prev/next/onFail/barrier/env）
2. systemMessage 只包含路由指令（Phase 0 已實現資訊隔離）
3. Context file 透傳機制（ROUTE.context_file → 下一個節點讀取）
4. env-detector 結果注入 Node Context `env` 欄位

**驗證**：Main Agent 資訊隔離測試（確認 Edit/Write 不被嘗試）

### Phase 3：Guard 簡化（v4.0-rc）

**改動範圍**：guard-rules.js

1. 移除 phase 依賴（不再呼叫 `derivePhase()`）
2. 簡化為 `pipelineActive` 二元判斷
3. 移除 CLASSIFIED/RETRYING 區分
4. Bash 寫入阻擋保留（Hardening H1）

**驗證**：guard-rules 測試重寫 + pipeline-catalog-validation 回歸

### Phase 4：Barrier 並行（v4.0）

**改動範圍**：stage-transition + barrier state

1. 實作 barrier 計數器（Atomic Write）
2. 並行節點委派 + barrier 同步
3. 移除 `getReadyStages()` DAG 查詢（改用 barrier）
4. Dashboard 適配並行狀態顯示（Agent Status 面板擴展）

**驗證**：並行場景壓力測試 + Dashboard 並行視覺確認

### Phase 5：清理（v4.1）

1. 移除 `dag-state.js` 中未使用的 phase 相關函式（guard 不再需要）
2. 移除 `pipeline-controller.js` 中的集中式路由邏輯
3. Dashboard/Timeline consumer 適配 PIPELINE_ROUTE 事件
4. 清理 context file（session-cleanup 整合）

---

## 8. 保留的 v3 機制

以下 v3 機制在 v4 中保留（不移除）：

| 機制 | 原因 |
|------|------|
| `derivePhase()` | Dashboard/Timeline/formatter 仍需要 phase 顯示。**v4 版本邏輯**（依序短路）：① `!pipelineActive` → IDLE（**涵蓋 cancel 場景**：cancel 設 `pipelineActive=false` → 一律 IDLE，無論 stages 狀態如何）② `activeStages.length > 0` → DELEGATING ③ 全部 `completed/skipped` → COMPLETE ④ 有 `failed` stage 且 `retries[stage] > 0` → RETRYING ⑤ 其餘（有 DAG + 有 pending）→ CLASSIFIED。不依賴 v3 的 `enforced`/`pendingRetry`/`meta.cancelled` 欄位 |
| `pipeline-state-{sid}.json` | Dashboard 監控需要全域狀態快照（Atomic Write 改善寫入安全） |
| Pipeline Catalog（10 模板） | 模板用於生成 Node Context 拓撲（見 8.1 模板→DAG 映射） |
| `pipeline-architect` agent | 自訂 DAG 仍需要 agent 分析 |

### 8.1 Pipeline Catalog → DAG 映射

已知模板（`[pipeline:xxx]` 語法）的 DAG 生成規則。v3 的 `linearToDag()` 在 v4 中升級為 `templateToDag()`，自動加入 barrier group 和 onFail 欄位：

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

**範例**：`[pipeline:standard]` 生成的 DAG：

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

**多組 Barrier 的回退語意**：`full` pipeline 有 `post-dev`(REVIEW,TEST) 和 `post-qa`(QA,E2E) 兩組 barrier。當 `post-qa` FAIL 回退到 DEV 時，跨越了 `post-dev` barrier — stage-transition 將 **QA/E2E 和 REVIEW/TEST 都重設為 pending**，DEV 重設為 active。

> **設計決策**：跨 barrier 回退時，被跨越的 barrier group 內的 stages 必須重跑。原因：DEV 的新修改可能影響 REVIEW/TEST 的結論（例如修復 QA 問題時重構了被 REVIEW 審查過的程式碼）。保留 `completed` 狀態（跳過重跑）雖然更快，但可能讓未經驗證的新修改直達後續 stage，違反品質閉環原則。

> **barrier-state 連動重設**：stage-transition 在重設 pipeline-state 中的 stages 狀態時，必須同步重設 `barrier-state-{sid}.json` 中被跨越的 barrier group：`completed: []`、`results: {}`、`resolved: false`。否則第二輪 REVIEW/TEST 完成時 barrier 會讀到舊結果，導致計數異常。

### 8.2 Hardening 功能整合

v1.0.50 建立的防護網在 v4 中保留並適配：

| Hardening 功能 | v4 整合方式 |
|:---|:---|
| **Bash 防護**（evaluateBashDanger） | 繼續保留。Guard 簡化為 `pipelineActive` 判斷，但 Bash 危險指令阻擋獨立運作（不受 pipeline 狀態影響） |
| **框架偵測**（env-detector） | 結果注入 Node Context `env` 欄位，讓每個 Node 知道環境全貌 |
| **Clear 重設** | `/clear` 同時清除主 state + barrier state + context files |
| **Checkpoint**（git tag + patch） | Patch 路徑作為 context file 的一部分。route=DEV 時，DEV agent 可從 context file 讀取 patch 資訊 |
| **Bash 寫檔偵測**（detectBashWriteTarget） | Pipeline active 時仍攔截 Bash 寫入程式碼檔案（防止 Rogue Agent 繞過） |

---

## 9. 風險評估

| 風險 | 嚴重度 | 緩解 |
|------|:------:|------|
| **Transcript 洩漏**（Sub-agent 回應含完整報告） | **高** | 雙道防線：context_file + 回應格式約束（3.3 節）。Agent .md 必須嚴格規範 |
| 節點輸出格式錯誤 | 中 | 雙層防護：Schema Validation → 預設 PASS/NEXT + warning |
| Context file 路徑錯誤或檔案不存在 | 中 | Sub-agent 讀取前檢查 `fs.existsSync`，不存在時按無 context 處理 |
| Context file 過大（累積） | 低 | 每次寫入限制 5000 chars（3.2 節） + session-cleanup 定期清理 |
| 並行 barrier 遺漏（節點 crash） | 中 | Barrier timeout（5 分鐘未全到齊 → 強制前進） |
| Agent .md 改動影響 | 高 | Phase 0 先改資訊流（不改路由），Phase 1 漸進遷移品質 agents |
| Retry 計數不一致 | 低 | stage-transition 獨占讀寫 + Policy Enforcement 覆寫（6.3 節） |
| Dashboard 狀態不一致 | 低 | 保留全域 state 快照（Atomic Write） |
| State 寫入損毀 | 低 | Atomic Write（write-to-tmp + rename） |
| Self-Refine 降級不當（FAIL:HIGH 降為 PASS 但問題未修） | 中 | CRITICAL 永不降級 + 降級建議寫入 context_file 供後續 stage 二次檢查（10.2 節） |
| Reflexion Memory 累積過大 | 低 | 每輪 ≤ 500 chars，6 輪上限 3000 chars + session 清理（10.1 節） |
| 收斂誤判（severity 相同但根因不同） | 低 | 僅比較 severity 等級（不依賴 LLM 生成的 hint 文字），連續 2 輪相同 severity 才觸發停滯偵測（10.3 節） |

---

## 10. 迭代優化機制

> **設計動機**：v3 的回退機制（FAIL → DEV → 重試）是「無記憶的粗粒度迴圈」— DEV agent 每次重啟時不知道上一輪為什麼失敗，品質 agent 無法在 stage 內部自我修正，停止條件只有 MAX_RETRIES 計數。v4 引入三層迭代優化機制，從學術研究（Self-Refine、Reflexion、Constitutional AI）中提取可在 ECC hooks-only 架構下實作的高價值模式。

### 10.1 Reflexion Memory（跨迭代反思記憶）

> 參考：Reflexion（Shinn et al., NeurIPS 2023）— 將環境回饋轉換為語言化的自我反思，存入 episodic memory，避免重複同樣的錯誤。

**問題**：v3 的 FAIL 回退路徑中，DEV agent 是全新 session。它收到 `context_file`（reviewer 的完整報告），但**不知道這是第幾輪、上一輪修了什麼、為什麼沒通過**。這導致 DEV 可能重複嘗試已經失敗的修復策略。

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

**Node Context 整合**（完整實作見 Section 4.2 的 `buildNodeContext` + `getRetryContext`）：

Reflexion Memory 的注入透過 `getRetryContext()` 函式完成。此函式透過 `state.retries` + `dag[s].onFail` 反向查找 failedStage（委派目標是 DEV，但反思記憶以品質 stage REVIEW 命名），然後讀取對應的反思檔案。詳細程式碼見 4.2 節。

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
    const trimmed = sections.slice(-5).join('');  // 防禦性上限 5 輪（容納自訂 maxRetries > 3 的場景）
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
- 大小限制：每輪反思 ≤ 500 chars，總計 ≤ 3000 chars — 超過時自動截斷最舊的 round（程式碼中的 `sections.slice(-5)` 保留最近 5 輪）

### 10.2 Stage 內 Self-Refine 微迴圈

> 參考：Self-Refine（Madaan et al., NeurIPS 2023）— Generate → Feedback → Refine 三步迴圈，同一 agent 自我改進。

**問題**：v3/v4 的回退粒度太粗 — REVIEW FAIL 必須回退到整個 DEV stage 重跑。但很多 FAIL:HIGH 問題只需幾行修改。跨 stage 回退的代價高昂（新 agent session + context 重建 + 使用者等待）。

**機制**：在 QUALITY agents（REVIEW / TEST / QA / E2E）的 `.md` 中嵌入 Self-Refine 指令，讓品質 agent 在自身 session 內嘗試一輪「假設修正」後再做最終裁決。

**Agent .md 增強**（以 REVIEW 為例）：

```markdown
## Self-Refine 迴圈（Pipeline 模式限定）

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
- **與 v3 verdict 格式相容** — Self-Refine 是 agent 內部推理過程，不依賴 PIPELINE_ROUTE 協議。在 Phase 0（Context Protocol）即可實施，因為 agent 仍使用既有的 verdict 輸出格式（v3 的 `PIPELINE_VERDICT` 或 v4 的 `PIPELINE_ROUTE`）

**降級後的下游處理**：當品質 agent 將 FAIL:HIGH 降級為 PASS 時，修復建議寫入 `context_file`。此時路由為 NEXT（前進），**不會觸發 DEV 回退**。修復建議作為「附帶建議」傳遞給後續 stage — 例如 TEST 可以據此生成針對性測試，但不要求即時修復。若建議涉及 CRITICAL 級問題，應維持 FAIL 而非降級（保守策略已保障）。

**預期效果**：減少 30-50% 的跨 stage 回退，特別是那些「reviewer 能看出問題也能看出解法」的情境。

### 10.3 多維收斂條件（shouldStop — 取代 v3 的 shouldRetryStage）

> 參考：Adaptive Stability Detection（2025）+ 業界實踐的固定上限 + 品質門檻多條件組合。

**與 Section 6.3 Policy Enforcement 的關係**：
- `shouldStop()` 是 `retry-policy.js` 中的**唯一停止判斷入口**，取代 v3 的 `shouldRetryStage()`
- Section 6.3 的 Policy Enforcement 是 `stage-transition` 內的**路由修正層**，處理 Schema 驗證後的邏輯矛盾（如 PASS+DEV → 修正為 NEXT）
- **呼叫順序**：stage-transition 先執行 Schema Validation + Policy Enforcement（6.3 節），修正路由異常；再呼叫 `shouldStop()` 判斷是否繼續迭代
- 兩者職責不重疊：Policy Enforcement 修正「不合法的路由」，shouldStop() 判斷「合法的 FAIL 是否值得重試」

**問題**：v3 的停止條件只有兩個 — `verdict: PASS`（品質通過）和 `retryCount >= MAX_RETRIES`（次數耗盡）。缺少兩類重要信號：(1) **收斂偵測**（同樣的問題反覆出現 = 無效迴圈）和 (2) **趨勢分析**（severity 在降還是不動）。

**升級後的停止判斷**（`retry-policy.js` — shouldStop 取代 v3 的 shouldRetryStage）：

```javascript
/**
 * 多維停止條件（4 條件 OR）
 *
 * @param {string} stage - 當前 stage
 * @param {Object} verdict - 最新 verdict
 * @param {number} retryCount - 已重試次數
 * @param {Array} retryHistory - 歷史 verdict 摘要陣列
 * @param {number} maxRetriesForStage - 該 stage 的最大重試次數（從 DAG 定義）
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

  // (3) 收斂偵測：連續 2 輪相同 severity → 停滯（不依賴 hint 文字比較）
  //     hint 是 LLM 生成的自然語言，措辭會因 session 而異，不適合精確比較。
  //     改用 severity 等級作為收斂信號 — 穩定且可預測。
  if (retryHistory.length >= 2) {
    const last = retryHistory[retryHistory.length - 1];
    const prev = retryHistory[retryHistory.length - 2];
    if (last.severity === prev.severity) {
      return { stop: true, reason: 'convergence-stall', action: 'FORCE_NEXT',
               warning: `⚠️ 連續兩輪 severity=${last.severity}，判定收斂停滯。強制前進。` };
    }
  }

  // (4) severity 趨勢分析（附加日誌資訊，不影響停止決策）
  //     趨勢分析不作為停止/重試條件 — 只附加 note 供 timeline/dashboard 顯示。
  //     實際停止決策由 (1)~(3) 決定。
  let trendNote = null;
  if (retryHistory.length >= 2) {
    const severityScore = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    const lastScore = severityScore[retryHistory[retryHistory.length - 1]?.severity] || 0;
    const prevScore = severityScore[retryHistory[retryHistory.length - 2]?.severity] || 0;
    if (lastScore < prevScore) trendNote = '📈 severity 趨勢改善';
    else if (lastScore > prevScore) trendNote = '📉 severity 趨勢惡化';
  }

  return { stop: false, reason: 'retry-needed', action: 'RETRY', ...(trendNote ? { note: trendNote } : {}) };
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

**4 個停止條件的關係**：

```
                     ┌─ (1) PASS          → NEXT（正常前進）
                     │
shouldStop() ────────┼─ (2) MAX_RETRIES   → FORCE_NEXT（強制前進 + warning）
                     │
                     ├─ (3) 收斂停滯      → FORCE_NEXT（無效迴圈偵測）
                     │
                     └─ (4) 趨勢分析      → RETRY + 📈（非停止，僅日誌）
```

### 10.4 三層機制的協作關係

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

**執行時序**：
1. 品質 agent 完成審查（含 Self-Refine 微迴圈 — agent .md 層面，不經 hook）
2. 品質 agent 輸出 PIPELINE_ROUTE（verdict + route）
3. stage-transition hook 觸發（SubagentStop 事件）：
   a. 解析 PIPELINE_ROUTE（parseRoute）
   b. Schema Validation + Policy Enforcement（6.3 節 — 修正不合法路由，含 MAX_RETRIES 覆寫）
   c. shouldStop() 分析收斂（10.3 節 — 條件 (2) MAX_RETRIES 與 b 有意重疊作為 defense-in-depth，條件 (3) 收斂停滯偵測是 b 無法覆蓋的新能力）
   d. 若 RETRY → writeReflection() 記錄反思
   e. 生成下一個 Node Context（buildNodeContext + getRetryContext 注入反思記憶）
   f. 產出 systemMessage（委派指令）
4. Main Agent 委派 DEV（讀取 systemMessage 指令）
5. DEV agent 讀取反思記憶 + context_file，避免重複失敗策略
6. DEV 完成 → 回到步驟 1

**並行場景的 shouldStop 行為**：barrier 合併（5.2 節 `mergeBarrierResults()`）產出的 FAIL 結果進入 shouldStop() 時，以 **severity 最高的 FAIL stage** 作為 `stage` 參數、合併後的 `severity` 作為 `verdict.severity`、該 stage 的 `retryHistory` 作為收斂判斷依據。例如 REVIEW PASS + TEST FAIL:HIGH → shouldStop 以 TEST 為 key 判斷是否收斂停滯。

### 10.5 遷移路線（整合到 Section 7 的 Phase 體系）

迭代機制的遷移嵌入 Section 7 的 Phase 計劃：

| 嵌入 Phase | 改動 | 影響範圍 | 依賴 |
|:----------:|------|---------|:----:|
| **Phase 0**（Context Protocol） | Agent .md 加入 Self-Refine 指令（純 prompt engineering，與 verdict 輸出格式無關，v3/v4 皆可用） | 4 個品質 agent 的 .md | 無（可提前實施） |
| **Phase 1**（QUALITY agents 遷移） | `retry-policy.js` 升級 shouldStop() | 1 個 JS 模組 | 無 |
| **Phase 1** | stage-transition 加入 writeReflection() | 1 個 hook + 1 個新檔案格式 | shouldStop |
| **Phase 2**（IMPL agents 遷移） | buildNodeContext() 注入反思記憶 | pipeline-controller | writeReflection |

Self-Refine（Agent .md 變更）可獨立於 v4 其他改動**提前實施** — 純 prompt engineering，零程式碼變更，零架構風險。

---

## 11. 邊界情境與防護機制

> v3 歷史教訓：v1.0.56~v1.0.61 連續修復 7 個死鎖/間隙 bug。v4 必須在設計階段窮盡所有邊界情境，避免重蹈覆轍。

### 11.1 死鎖 / 卡住（Deadlock / Stuck）

#### E1：Sub-agent 沒有輸出 PIPELINE_ROUTE

**場景**：Sub-agent 完成工作但忘記輸出 PIPELINE_ROUTE 標記（prompt 遵循度不足）。

```
[REVIEW agent 完成] → 輸出純文字報告（無 PIPELINE_ROUTE）
                    → stage-transition 解析失敗
                    → ???
```

**防護**：

```
stage-transition 解析邏輯（兩層 fallback）：
  1. 解析 PIPELINE_ROUTE → 成功 → 使用
  2. 解析失敗 → 根據 stage 類型推斷預設行為：
     ├── IMPL stage（PLAN/ARCH/DESIGN/DEV/DOCS）→ { verdict: PASS, route: NEXT }
     └── QUALITY stage（REVIEW/TEST/QA/E2E）→ { verdict: PASS, route: NEXT }
         + warning: "no-route-detected"
         + Timeline emit: ROUTE_FALLBACK 事件
```

**設計**：PIPELINE_ROUTE 是結構化 JSON 標記（`<!-- PIPELINE_ROUTE: {...} -->`），解析成功率高。兩層 fallback 確保永不卡住。

**QUALITY stage 特殊處理**：若 QUALITY stage（REVIEW/TEST/QA/E2E）解析失敗，先嘗試重新委派（與 E2 crash 策略一致，最多 3 次）。3 次都失敗才降級為 PASS + warning。IMPL stage 解析失敗直接預設 PASS（已完成工作不需重跑）。

**v3 教訓來源**：v1.0.56 — 分類但無 DAG 導致 guard 間隙，根因同樣是「缺少預設行為」。

---

#### E2：Sub-agent crash / 異常中止

**場景**：Sub-agent 在執行中被中斷（context overflow、timeout、使用者按 Ctrl+C）。

```
[DEV agent 執行中] → 突然中斷（無 PIPELINE_ROUTE 輸出）
                   → SubagentStop hook 仍然觸發
                   → agent_transcript_path 可能不完整
```

**防護**：

```
stage-transition 處理流程：
  1. 檢查 Sub-agent 回應是否為空/截斷
  2. 空回應 → 視為 crash：
     ├── IMPL stage（PLAN/ARCH/DESIGN/DEV/DOCS）：
     │   標記 stage FAILED + 不前進
     │   systemMessage: "⚠️ {stage} 中斷。重新委派 {skill} 繼續。"
     │   （保留 pipelineActive = true，等 suggest-compact 推動重新委派）
     │
     └── QUALITY stage（REVIEW/TEST/QA/E2E）：
         重新委派同一個 stage（不是預設 PASS）
         state.crashes[stage] += 1
         systemMessage: "⚠️ {stage} 中斷，自動重新委派。（crash #{count}）"
  3. 記錄 Timeline 事件：AGENT_CRASH
  4. crashes[stage] >= 3 → 停止重試，降級為 E1 fallback（PASS + warning）
     systemMessage: "⚠️ {stage} 連續 crash 3 次，降級放行。"
```

**關鍵決策**：
- IMPL stage crash → 不前進（程式碼可能寫到一半，預設 PASS 有損壞風險）
- QUALITY stage crash → **重新委派**（不是預設 PASS；crash ≠ 通過審查。但 3 次 crash 後降級放行避免死鎖）

**並行節點 crash 的特殊處理**：若 crash 的 stage 是 barrier 的一部分（如 REVIEW crash 但 TEST 已完成）：
- crash 不計入 barrier.completed（因為沒有 ROUTE 輸出）
- 重新委派後正常完成 → 計入 barrier.completed → 觸發合併
- 3 次 crash 後降級放行 → 以 `{ verdict: PASS, route: BARRIER }` 計入（不阻擋另一個已完成的節點）

---

#### E3：Barrier 永遠不齊

**場景**：兩個並行節點（REVIEW + TEST），其中一個 crash 或卡住 → barrier 永遠等不齊。

```
[REVIEW 完成] → barrier: 1/2 → 等待 TEST
[TEST crash]  → 永遠不會到 2/2
              → Pipeline 永久卡住
```

**防護**：

```
Barrier Timeout 機制：
  1. barrier 建立時記錄 startTime
  2. 每次 stage-transition 觸發時檢查：
     if (barrier.completed.length < barrier.total &&
         Date.now() - barrier.startTime > BARRIER_TIMEOUT_MS) {
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

```
[DAG 顯示下一步是 QA]
[systemMessage 生成失敗]
→ Main Agent 收到空 systemMessage
→ pipeline-guard 持續阻擋一切寫入
→ 使用者什麼都做不了
```

**防護**：

```
多層安全網：
  1. stage-transition 生成 systemMessage 後，斷言檢查：
     if (!systemMessage || systemMessage.trim() === '') {
       // Emergency fallback
       // 從 DAG 和 stages 狀態推算下一個 pending stage
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

  2. suggest-compact 長時間偵測（v3 已有，v4 保留）：
     連續 5 次唯讀操作且 pipelineActive = true
     → nudge: "Pipeline 等待委派，請按照 systemMessage 指示操作。"

  3. 下一次 UserPromptSubmit 或 Stop hook 觸發時，
     偵測上次委派 timestamp 超過 30 分鐘
     → systemMessage: "⏸️ Pipeline 長時間無活動，建議使用 /vibe:cancel 退出。"
     （注：ECC hooks-only 架構無定時器，此為事件驅動偵測）
```

**v3 教訓來源**：v1.0.58 的 classifiedReadCount — 偵測「Main Agent 一直讀但不委派」的模式。v4 保留此機制但移到 suggest-compact。

---

#### E5：無限重試循環

**場景**：REVIEW 一直 FAIL，DEV 一直修但修不好 → 無限 FAIL→DEV→FAIL 循環。

```
REVIEW round 1 → FAIL → DEV → REVIEW round 2 → FAIL → DEV → REVIEW round 3 → ???
```

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

**v3 教訓來源**：v1.0.45 壓力測試場景 R — MAX_RETRIES 耗盡。v3 用 `shouldRetryStage()` 對稱設計處理，v4 用 Policy Enforcement 作為最後防線更簡潔。

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

**設計原則**：context_file 是 **增強機制**，不是 **必要條件**。沒有 context_file，pipeline 仍能運行，只是 DEV agent 需要自行定位問題（效率降低但不卡住）。

---

### 11.2 恢復 / 接手（Recovery / Handoff）

#### E7：Session 中斷後恢復

**場景**：使用者在 Pipeline 執行中關閉 terminal / Ctrl+C，稍後在新 session 恢復。

```
Session A: PLAN ✓ → ARCH ✓ → DEV [執行中] → 中斷
Session B: 使用者重新開啟 → 如何接續？
```

**防護**（延續 v3 pipeline-resume 機制）：

```
pipeline-init（SessionStart hook）：
  1. findIncompletePipelines()：
     掃描 ~/.claude/pipeline-state-*.json
     過濾：pipelineActive = true && sessionId ≠ 當前 session
  2. 找到未完成 pipeline：
     ├── 自動接續（v3 行為保留）：
     │   建立新 state（新 sessionId）+ 複製 DAG + retries + context files
     │   systemMessage: "🔄 接續未完成的 Pipeline..."
     └── DEV 階段 active 時的特殊處理：
         markStage(DEV, PENDING)  // active → pending（agent 已不在）
         systemMessage 提示重新委派

  3. Barrier state 恢復：
     已完成的 barrier.completed 保留
     未完成的並行節點重新委派
```

**v3 教訓來源**：v1.0.55 pipeline-resume — 跨 session 接續。v4 保留但需處理 barrier state 的額外複雜度。

**新增考量**：
- **context_file 存活性**：v4 的 context_file 跨 session 可能被 session-cleanup 清理。pipeline-resume 時需要檢查 context_file 是否仍然存在，不存在時降級為無 context 模式（E6/E13 機制）。
- **barrier state 遷移**：若舊 session 有未完成的 barrier（如 REVIEW 完成但 TEST 未完成），新 session 需要：(1) 複製 `barrier-state-{oldSid}.json` → `barrier-state-{newSid}.json`（路徑含 sessionId 需重寫） (2) 已完成的 `barrier.completed` 保留 (3) 主 state 中對應的 `stages[stage].contextFile` 路徑也需更新（`pipeline-context-{oldSid}-{stage}.md` → `pipeline-context-{newSid}-{stage}.md`，或保留舊路徑並驗證檔案存在） (4) 未完成的並行節點重設為 pending → 重新委派 (5) 若已完成節點被 crash 後重新委派過（E2），其 `barrier.results` 中的結果仍然有效（已成功完成的 ROUTE 不需重跑）。

---

#### E8：使用者想跳過某階段

**場景**：使用者覺得 QA 不必要，想跳過直接到 DOCS。

```
目前在 TEST 完成，下一步是 QA
使用者："跳過 QA，直接到 DOCS"
```

**防護**：

```
/vibe:cancel 不是唯一選項 — 新增 stage skip 機制：

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

**防護**（延續 v3 /vibe:cancel 機制，簡化為 v4 版本）：

```
/vibe:cancel 流程：
  1. 設定 state.pipelineActive = false
  2. 清理 barrier state（如有）
  3. context files 保留（使用者可能手動參考）
  4. systemMessage: "🛑 Pipeline 已取消。自動模式解除。"
  5. Timeline emit: PIPELINE_CANCELLED

v4 簡化：
  - cancel skill 呼叫 controller API（JS 函式呼叫，非工具寫入）
  - controller API 內部使用 atomicWrite() 將 pipelineActive=false 寫入 state file
  - guard 只看 pipelineActive 布林值 → false 即放行
  - 不需要 v3 的 meta.cancelled / isCancelled() / CANCEL_STATE_FILE_RE 逃生口
  - 因為 cancel 由 Skill 觸發 → guard 白名單放行 Skill → 內部 API 呼叫不經過 guard
```

**v3 教訓來源**：v1.0.56~v1.0.58 cancel 逃生口 — v3 需要 CANCEL_STATE_FILE_RE 白名單讓 cancel 能寫入 state file（因為 guard 阻擋一切寫入）。v4 的 cancel 不需要寫入 state file（直接由 skill 呼叫 controller API），逃生口設計更簡潔。

---

#### E10：使用者想從特定階段重新開始

**場景**：Pipeline 完成了，但使用者對 REVIEW 結果不滿意，想從 REVIEW 重新跑。

```
Pipeline 已完成（所有 stage completed）
使用者："從 REVIEW 重新開始"
```

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

```
Session A: [pipeline:standard] → PLAN ✓ → ARCH [active]
Session B: [pipeline:fix] → DEV [active]
→ 兩個 session 修改同一個 codebase → 衝突
```

**防護**：

```
Session 隔離（v3 機制保留）：
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

### 11.3 資訊流（Information Flow）

#### E12：Agent 違反 3.3 回應格式（Transcript 洩漏）

**場景**：REVIEW agent 在最終回應中包含完整報告（違反 3.3 規範），導致 Main Agent 看到問題細節。

```
REVIEW agent 回應：
  "發現 3 個 CRITICAL 問題：
   C-1: adaptV3 clearing expectedStages breaks...
   C-2: getAgentInfo alive parameter missing...
   <!-- PIPELINE_ROUTE: {...} -->"

→ Main Agent 看到 C-1, C-2 → 可能嘗試自行修復
```

**防護**：

```
三道防線（縱深防禦）：

  1. Agent .md 約束（預防層）：
     品質 agent 的 .md 明確規範回應格式（3.3 節）

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

**務實態度**：100% 防止 transcript 洩漏是不可能的（LLM 不完全受控）。重要的是 **即使洩漏，guard 仍然阻擋 Main Agent 自行修復**。context_file 解決的是 **token 浪費**，guard 解決的是 **行為越權**。

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

```
DAG 說 REVIEW.next = ["QA"]
但 state 中 QA 已被 skip
→ REVIEW PASS → route: NEXT → 嘗試委派 QA → QA 是 skipped → ???
```

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

**v3 教訓來源**：v1.0.41 — auto-enforce 設新 pipelineId 時 expectedStages stale。v4 的 Node Context 是每次委派時動態生成的（4.2 節），天然避免 stale。

---

### 11.4 並行（Parallel）

#### E15：並行結果矛盾（REVIEW PASS + TEST FAIL）

**場景**：REVIEW 和 TEST 並行執行，REVIEW 通過但 TEST 失敗。

```
[REVIEW] → PASS, route: BARRIER
[TEST]   → FAIL, route: DEV (severity: CRITICAL)
→ Barrier 全到齊 → 該前進還是回退？
```

**防護**（使用 5.2 節 Barrier 合併機制）：

```
Worst-Case-Wins 策略（5.2 節 mergeBarrierResults()）：

  1. 並行節點一律輸出 route: BARRIER（3.4 節）
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

  1. 所有 barrier state 寫入使用 atomicWrite()（5.2 節）
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

### 11.5 邊界（Boundary）

#### E18：單階段 Pipeline（fix 模板）

**場景**：`[pipeline:fix]` 只有 DEV 一個階段。DAG 只有一個節點。

```
DEV → 完成 → route: COMPLETE → Pipeline 結束
```

**防護**：

```
正常處理：
  1. DAG: { DEV: { deps: [], next: [] } }
  2. DEV 完成 → route: NEXT 或 COMPLETE
  3. stage-transition：next 為空 → 自動視為 COMPLETE
  4. pipelineActive = false

注意：單階段 pipeline 的 FAIL route 應該是 NEXT（無 DEV 可回退）
      → Policy Enforcement 處理（6.3 節已涵蓋）
```

---

#### E19：空 DAG（none pipeline）

**場景**：分類為 `none`（問答/研究），沒有建立 DAG。

```
使用者："TypeScript 的 discriminated union 怎麼用？"
→ 分類: none
→ 不建立 DAG
→ pipelineActive = false
→ Main Agent 自由操作
```

**防護**：

```
none pipeline 不觸發 guard：
  1. classify() 結果為 none → 不設 pipelineActive
  2. guard evaluate()：!state?.pipelineActive → allow
  3. 使用者可自由使用所有工具
```

**v3 教訓來源**：v1.0.61 — none pipeline 被 enforce 的 bug。v4 用 `pipelineActive` 布林值替代 v3 的 `isEnforced()` 多條件推導，根本消除此類 bug。

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

```
Pipeline active（DEV 階段）
使用者新 prompt："更新 README"
→ task-classifier 觸發
→ 新 prompt 要併入現有 pipeline 還是獨立處理？
```

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

#### E22：Sub-agent 輸出 ABORT

**場景**：Sub-agent 遇到不可恢復的錯誤，輸出 `route: ABORT`。

```
DEV agent 發現 project 結構損壞
→ PIPELINE_ROUTE: { verdict: FAIL, route: ABORT, hint: "package.json 損毀" }
```

**防護**：

```
ABORT 處理：
  1. 立即停止 pipeline（pipelineActive = false）
  2. 保留所有 state + context files（供診斷）
  3. systemMessage: "⛔ Pipeline 異常終止：{hint}"
  4. Timeline emit: PIPELINE_ABORTED
  5. 不清理 state（使用者可用 /vibe:pipeline restart 恢復）
```

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

### 11.6 v3 歷史 Bug 對照表

以下列出 v3 的關鍵 bug 及其在 v4 中的結構性防護：

| v3 Bug | 版本 | 根因 | v4 結構性防護 |
|:-------|:----:|:-----|:-------------|
| 分類但無 DAG 間隙 | v1.0.56 | classify() 與 DAG 建立分離 | DAG 在 classify 時同步建立；pipelineActive 只在 DAG 存在時為 true |
| canProceed/evaluate 雙入口 | v1.0.57 | guard 邏輯在兩個函式中重複 | guard 簡化為一個函式 + 一個布林值 |
| suggest-compact 寫入競態 | v1.0.58 | 多個 hook 並行寫入同一 state file | Atomic Write + barrier 獨立檔案 + suggest-compact 不寫入 pipeline state |
| cancelled 狀態被覆蓋 | v1.0.58 | classify() 不尊重 cancelled 標記 | cancel 直接設 pipelineActive = false，後續 classify 不觸發（pipelineActive 已 false） |
| none pipeline 被 enforce | v1.0.61 | pipeline-architect fallback 設 enforced:true 到 none state | none pipeline 不設 pipelineActive（布林值語意清晰） |
| Main Agent 自行修復 | v3 現存 | systemMessage 含詳細報告 → Main Agent 看到問題 | context_file 物理隔離 + 回應格式約束 + guard 阻擋寫入 |
| stale expectedStages | v1.0.41 | auto-enforce 改 pipelineId 但忘改 expectedStages | Node Context 每次委派時動態生成（4.2 節），無 stale 問題 |

### 11.7 v4 新增 Timeline 事件類型

v4 在邊界情境處理中引入以下 Timeline 事件，供 Dashboard/Remote consumer 訂閱：

| 事件名稱 | 觸發場景 | 攜帶資料 | 參考節 |
|----------|---------|---------|:------:|
| `ROUTE_FALLBACK` | PIPELINE_ROUTE 解析失敗 → 預設 PASS/NEXT | `{ stage, warning }` | E1 |
| `AGENT_CRASH` | Sub-agent 異常終止（無 PIPELINE_ROUTE） | `{ stage, crashCount }` | E2 |
| `PIPELINE_CANCELLED` | 使用者 /vibe:cancel | `{ reason, completedStages }` | E9 |
| `TRANSCRIPT_LEAK_WARNING` | Sub-agent 回應超過長度閾值（可能含報告） | `{ stage, responseLength }` | E12 |
| `PIPELINE_ABORTED` | route: ABORT（不可恢復錯誤） | `{ stage, reason }` | E22 |
| `RETRY_EXHAUSTED` | shouldStop 條件 (2)/(3) 觸發 FORCE_NEXT | `{ stage, retryCount, reason }` | E5 |

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
      "enum": ["NEXT", "DEV", "BARRIER", "COMPLETE", "ABORT"]
    },
    "severity": {
      "type": "string",
      "enum": ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
      "description": "FAIL 時的嚴重度"
    },
    "context_file": {
      "type": "string",
      "description": "透傳給下一個節點的 context 檔案路徑（~/.claude/pipeline-context-{sid}-{stage}.md）。大小上限 5000 chars（見 3.2 節 Context File 規範）"
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

## 附錄 B：Node Context Schema

注意：實際傳入 Sub-agent 的格式使用 `node` wrapper（見 3.1 節），Schema 定義 `node` 內部結構：

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
      "description": "Reflexion Memory 摘要（首次執行為 null，回退時注入）。見 10.1 節",
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

## 附錄 C：v4 Pipeline State Schema

v4 使用兩個獨立的 state 檔案：

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
  "env": {
    "language": "TypeScript",
    "framework": "React",
    "frontend": { "detected": true }
  },
  "meta": {
    "createdAt": 1708300000000,
    "reclassifications": []
  }
}
```

**寫入方式**：所有主 state 寫入均使用 **Atomic Write**（`atomicWrite()`，見 5.2 節），取代 v3 的直接 `fs.writeFileSync`。

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
| `retryHistory` | object | 各 stage 的歷史 verdict 摘要陣列（10.3 節收斂偵測用）。格式：`{ [stage]: [{ round, severity, hint, timestamp }] }` | stage-transition |
| `env` | object | 環境偵測結果 | pipeline-init（via env-detector） |

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
    "startTime": 1708300000000,
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
| `startTime` | 建立時間（用於 timeout 偵測） |
| `resolved` | 是否已處理（防重複觸發） |

### C.3 Context File（`pipeline-context-{sessionId}-{stage}.md`）

暫存檔，由 Sub-agent 寫入，下一個 Sub-agent 讀取。格式為 Markdown，無 schema 限制。

**生命週期**：Pipeline 完成 / cancel / session-cleanup 時清理。

---

## 附錄 D：Gemini 建議採納紀錄

| 建議 | 來源 | 處置 | 說明 |
|------|------|:----:|------|
| 檔案路徑傳遞 Context | 2.3 | ✅ 採納 | `context_file` 取代 inline context，實現物理隔離 |
| Atomic Write | 2.1 | ✅ 部分採納 | 主 state + barrier state 統一用 atomic write，barrier 仍獨立檔案 |
| Phase 0 Context Protocol | 4.1 | ✅ 採納 | 遷移路線新增 Phase 0，先改資訊流再改路由 |
| Schema Validation | 2.2 | ✅ 採納 | 雙層驗證（Schema + Policy），強化 6.3 節 |
| env-detector 注入 Node Context | 3.H2 | ✅ 採納 | `env` 欄位加入 Node Context Schema |
| Hardening 整合對照表 | 3 | ✅ 採納 | 新增 8.2 節 |
| Shadow Controller | 2.2 | ❌ 不採納 | 增加複雜度，違背 v4 精簡原則。Schema Validation + fallback 足夠 |
| output_route Skill | 2.2 | ❌ 不採納 | Agent prompt 定義 JSON 格式即可，額外 Skill 過度工程化 |
| 單一 State + File Lock | 2.1 | ❌ 不採納 | Barrier state 生命週期與主 state 不同，拆分更清晰 |
