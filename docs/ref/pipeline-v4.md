# Pipeline v4 -- Node-based 分散式架構（設計草案）

> Pipeline v4 架構設計草案。從集中式 DAG 控制器演進為分散式節點自治模型。
> 狀態：**概念設計階段** -- 尚未實作。

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
| **Phase 推導錯誤** | `derivePhase()` 8 個條件分支，任一判斷錯誤 → guard 間隙 | v1.0.56 「分類但無 DAG」間隙 |
| **全域狀態腐敗** | 單一 JSON 檔案被多個 hook 並行讀寫 | v1.0.58 cancel 死鎖（suggest-compact 寫入競態） |
| **Main Agent 自行修復** | systemMessage 包含詳細問題報告 → Main Agent「看到」問題 → 嘗試繞過 guard 自行修復 | v1.0.73 REVIEW FAIL 後 Main Agent 直接用 Edit 修復 |

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
| Guard 複雜度 | 5 phases × 多條件 × 2 入口 | 二元：`pipeline active → relay mode` |
| 資訊流 | Sub-agent → state file → Main Agent → 下一個 Sub-agent | Node → Route 指令 → Main Agent relay → 下一個 Node |
| 並行 | `getReadyStages()` DAG 查詢 | Barrier 計數器 |
| 新增 stage | 改 registry + controller + guard + skip-predicates | 寫一個新 Node agent |

### 架構圖

```
                    ┌─────────────────────┐
                    │     Main Agent      │
                    │   (Message Bus)     │
                    │                     │
                    │  只做三件事：        │
                    │  1. 接收 ROUTE 指令  │
                    │  2. 傳遞 context     │
                    │  3. 管理 barrier     │
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
     │  TEST      │   │ retries:0/3│   │ retries:0/3│
     │ ]          │   │            │   │            │
     └────────────┘   └────────────┘   └────────────┘
```

---

## 3. Node 協議

### 3.1 Node Context（委派時傳入）

每個節點在被委派時，收到自己的拓撲資訊：

```json
{
  "node": {
    "stage": "REVIEW",
    "prev": ["DEV"],
    "next": ["TEST"],
    "onFail": {
      "target": "DEV",
      "maxRetries": 3,
      "currentRound": 1
    },
    "onPass": {
      "target": "TEST"
    },
    "barrier": null
  },
  "context": "<前一個節點的 opaque output>"
}
```

### 3.2 PIPELINE_ROUTE（節點輸出）

節點完成時，輸出結構化路由指令（取代 v3 的 `PIPELINE_VERDICT`）：

```
<!-- PIPELINE_ROUTE: {
  "verdict": "FAIL",
  "severity": "CRITICAL",
  "route": "DEV",
  "context": "C-1: adaptV3 clearing breaks 7 downstream features\nH-1: !alive catches undefined",
  "hint": "修復 isPipelineComplete 旗標邏輯"
} -->
```

**關鍵設計**：`context` 欄位是 **opaque** 的 -- Main Agent 不解析，直接透傳給下一個節點。Main Agent 只讀 `route` 欄位決定下一步。

### 3.3 路由指令類型

| route 值 | 語意 | Main Agent 行為 |
|-----------|------|----------------|
| `"NEXT"` | 成功，前進到下一個節點 | 委派 `node.onPass.target` |
| `"DEV"` | 失敗，回退到 DEV 修復 | 委派 DEV，帶入 `context` |
| `"BARRIER"` | 並行節點之一完成 | 計數，等待所有並行節點完成 |
| `"COMPLETE"` | 最後一個節點完成 | Pipeline 結束，解除 relay mode |
| `"ABORT"` | 不可恢復的錯誤 | Pipeline 異常終止 |

### 3.4 向後相容

v4 PIPELINE_ROUTE 向後相容 v3 PIPELINE_VERDICT：

```
PIPELINE_VERDICT: PASS        → PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" }
PIPELINE_VERDICT: FAIL:HIGH   → PIPELINE_ROUTE: { "verdict": "FAIL", "route": "DEV", "severity": "HIGH" }
```

`stage-transition` hook 優先解析 PIPELINE_ROUTE，fallback 到 PIPELINE_VERDICT。

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

### 4.2 Relay 邏輯（取代 pipeline-controller）

Main Agent 的行為由 stage-transition hook 的 systemMessage 驅動：

```
Sub-agent 輸出 PIPELINE_ROUTE
        │
        v
stage-transition hook 解析 route
        │
        ├── route=NEXT → systemMessage: "➡️ 委派 {next stage}"
        ├── route=DEV  → systemMessage: "➡️ 委派 DEV（帶入 context）"
        ├── route=BARRIER → 計數 → 全到齊？ → systemMessage: "➡️ 委派 {next stage}"
        └── route=COMPLETE → systemMessage: "Pipeline 完成。relay mode 解除。"
```

Main Agent **只看 systemMessage 中的委派指令**，不看 sub-agent 的詳細輸出。

### 4.3 資訊隔離

v3 的問題：Main Agent 收到 REVIEW 的完整報告（包含具體 bug 描述），因此「知道」可以修什麼。

v4 的解法：

```
v3 資訊流（洩漏）：
  REVIEW agent → transcript（含完整報告）→ Main Agent 可見

v4 資訊流（隔離）：
  REVIEW agent → PIPELINE_ROUTE.context（opaque）→ Main Agent 只讀 route
                                                  → context 透傳給 DEV agent
```

Main Agent 的 systemMessage 只包含路由指令：
```
🔄 REVIEW FAIL → 委派 /vibe:dev（context 已附加在委派 prompt 中）
```

不包含：
```
❌ C-1: adaptV3 clearing expectedStages breaks 7 downstream features...
❌ H-1: !alive catches undefined...
```

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

完成時輸出：
```json
{ "route": "BARRIER", "barrierGroup": "post-dev" }
```

### 5.2 Barrier 計數器

stage-transition hook 維護一個簡單計數器（取代 DAG 的 `getReadyStages()` 查詢）：

```javascript
// barrier-state-{sessionId}.json
{
  "post-dev": { "total": 2, "completed": ["REVIEW"], "next": "QA" }
}
```

當 `completed.length === total` → 發出委派指令到 `next`。

### 5.3 vs v3 DAG 查詢

| 面向 | v3 `getReadyStages()` | v4 Barrier |
|------|:---:|:---:|
| 查詢方式 | 遍歷 DAG 所有節點，檢查 deps 是否滿足 | 讀取計數器，檢查 `completed.length === total` |
| 複雜度 | O(stages × deps) | O(1) |
| 狀態修改 | 讀取全域 state | 修改獨立的 barrier 檔案 |
| 競態風險 | 高（全域 state 並行寫入） | 低（每個 barrier group 獨立檔案） |

---

## 6. 節點自治 vs Policy 上限

### 6.1 節點自主決策

每個節點根據自己的結果和 Node Context 做出路由決策：

```javascript
// REVIEW agent 的決策邏輯（agent .md 中定義）
if (hasCriticalOrHigh) {
  if (node.onFail.currentRound < node.onFail.maxRetries) {
    output PIPELINE_ROUTE: { route: "DEV", context: issues }
  } else {
    output PIPELINE_ROUTE: { route: "NEXT", warning: "exceeded retry limit" }
  }
} else {
  output PIPELINE_ROUTE: { route: "NEXT" }
}
```

### 6.2 Policy 透過 Node Context 傳遞

中央策略（如 MAX_RETRIES）不需要集中管理 -- 透過 Node Context 傳入：

```json
{
  "onFail": {
    "target": "DEV",
    "maxRetries": 3,
    "currentRound": 1
  }
}
```

每次回退後，`currentRound + 1` 更新在下一次委派的 Node Context 中。

### 6.3 不可信節點防護

如果節點輸出了非法的 route（如 round 超過 maxRetries 仍輸出 DEV）：

stage-transition hook 作為最後防線：
```javascript
if (route.route === 'DEV' && nodeContext.onFail.currentRound >= nodeContext.onFail.maxRetries) {
  // 強制覆寫為 NEXT
  route.route = 'NEXT';
  route.warning = 'policy override: exceeded maxRetries';
}
```

---

## 7. 漸進遷移路線

### Phase 1：PIPELINE_ROUTE 協議（v4.0-alpha）

**改動範圍**：Agent 定義 + stage-transition hook

1. 品質 agents（code-reviewer, tester, qa）輸出 PIPELINE_ROUTE（取代 PIPELINE_VERDICT）
2. stage-transition 優先解析 PIPELINE_ROUTE，fallback 到 PIPELINE_VERDICT
3. 其他模組不變

**驗證**：現有 e2e-hook-chain 測試擴充 ROUTE 解析場景

### Phase 2：Node Context 注入（v4.0-beta）

**改動範圍**：pipeline-controller + delegation-tracker

1. 委派時自動注入 Node Context（prev/next/onFail/barrier）
2. systemMessage 從包含詳細報告 → 只包含路由指令
3. Context 透傳機制（ROUTE.context → 下一個節點的委派 prompt）

**驗證**：Main Agent 資訊隔離測試（確認 Edit/Write 不被嘗試）

### Phase 3：Guard 簡化（v4.0-rc）

**改動範圍**：guard-rules.js

1. 移除 phase 依賴（不再呼叫 `derivePhase()`）
2. 簡化為 `pipelineActive` 二元判斷
3. 移除 CLASSIFIED/RETRYING 區分

**驗證**：guard-rules 測試重寫 + pipeline-catalog-validation 回歸

### Phase 4：Barrier 並行（v4.0）

**改動範圍**：stage-transition + barrier state

1. 實作 barrier 計數器
2. 並行節點委派 + barrier 同步
3. 移除 `getReadyStages()` DAG 查詢（改用 barrier）

**驗證**：並行場景壓力測試

### Phase 5：清理（v4.1）

1. 移除 `dag-state.js` 中未使用的 phase 相關函式（guard 不再需要）
2. 移除 `pipeline-controller.js` 中的集中式路由邏輯
3. Dashboard/Timeline consumer 適配 PIPELINE_ROUTE 事件

---

## 8. 保留的 v3 機制

以下 v3 機制在 v4 中保留（不移除）：

| 機制 | 原因 |
|------|------|
| `derivePhase()` | Dashboard/Timeline/formatter 仍需要 phase 顯示 |
| `pipeline-state-{sid}.json` | Dashboard 監控需要全域狀態快照 |
| Pipeline Catalog（10 模板） | 模板用於生成 Node Context 拓撲 |
| `pipeline-architect` agent | 自訂 DAG 仍需要 agent 分析 |
| PIPELINE_VERDICT | 向後相容（v4 優先讀 ROUTE，fallback VERDICT） |

---

## 9. 風險評估

| 風險 | 嚴重度 | 緩解 |
|------|:------:|------|
| 節點輸出格式錯誤 | 中 | stage-transition fallback 到 v3 VERDICT 解析 |
| Context 過大（透傳累積） | 低 | 每次透傳限制 2000 chars，超出截斷 |
| 並行 barrier 遺漏（節點 crash） | 中 | Barrier timeout（5 分鐘未全到齊 → 強制前進） |
| Agent .md 改動影響 | 高 | Phase 1 先在品質 agents 試行，漸進遷移 |
| Dashboard 狀態不一致 | 低 | 保留全域 state 快照（write-through） |

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
    "context": {
      "type": "string",
      "maxLength": 2000,
      "description": "透傳給下一個節點的 opaque context"
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

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
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
      "description": "後繼節點 ID"
    },
    "onFail": {
      "type": "object",
      "properties": {
        "target": { "type": "string" },
        "maxRetries": { "type": "integer" },
        "currentRound": { "type": "integer" }
      }
    },
    "onPass": {
      "type": "object",
      "properties": {
        "target": { "type": "string" }
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
}
```
