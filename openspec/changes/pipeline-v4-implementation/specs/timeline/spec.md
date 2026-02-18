# Timeline 模組 Delta Spec

## ADDED Requirements

### Requirement: v4 新增 Timeline 事件類型

v4 在邊界情境處理中新增 6 個 Timeline 事件類型。

#### Scenario: ROUTE_FALLBACK 事件
WHEN PIPELINE_ROUTE 解析失敗且使用預設 PASS/NEXT
THEN 發射 ROUTE_FALLBACK 事件
AND 攜帶 `{ stage, warning }` 資料

#### Scenario: AGENT_CRASH 事件
WHEN Sub-agent 異常終止（無 PIPELINE_ROUTE 且 crash count 達到上限）
THEN 發射 AGENT_CRASH 事件
AND 攜帶 `{ stage, crashCount }` 資料

#### Scenario: PIPELINE_CANCELLED 事件
WHEN 使用者 /vibe:cancel 取消 pipeline
THEN 發射 PIPELINE_CANCELLED 事件
AND 攜帶 `{ reason, completedStages }` 資料

#### Scenario: TRANSCRIPT_LEAK_WARNING 事件
WHEN Sub-agent 回應超過 500 字元且該 stage 是 QUALITY stage
THEN 發射 TRANSCRIPT_LEAK_WARNING 事件
AND 攜帶 `{ stage, responseLength }` 資料

#### Scenario: PIPELINE_ABORTED 事件
WHEN Sub-agent 輸出 route: ABORT
THEN 發射 PIPELINE_ABORTED 事件
AND 攜帶 `{ stage, reason }` 資料

#### Scenario: RETRY_EXHAUSTED 事件
WHEN shouldStop() 因 max-retries-exhausted 觸發 FORCE_NEXT
THEN 發射 RETRY_EXHAUSTED 事件
AND 攜帶 `{ stage, retryCount, reason }` 資料

> **備註**：收斂停滯（convergence-stall-observed）為純觀察信號，不直接觸發 RETRY_EXHAUSTED。收斂停滯記錄為獨立的觀察事件，迭代繼續直到 PASS 或 MAX_RETRIES 耗盡。

---

## MODIFIED Requirements

### Requirement: schema.js 事件類型列表

**完整修改後內容**：

EVENT_TYPES 從 23 個擴充為 29 個（新增 6 個 v4 事件）：

```
既有：SESSION_START, TASK_CLASSIFIED, DELEGATION_START, STAGE_START,
      STAGE_COMPLETE, STAGE_RETRY, PIPELINE_STARTED, PIPELINE_COMPLETE,
      PIPELINE_INCOMPLETE, TOOL_BLOCKED, TOOL_USED, TASK_GUARD_COMPLETE,
      COMPACT_LOGGED, ASK_QUESTION, ASK_ANSWERED, SUGGEST_COMPACT,
      BOT_COMMAND, REMOTE_RECEIPT, POST_EDIT_LINT, POST_EDIT_FORMAT,
      POST_EDIT_TEST, CONSOLE_LOG_CHECK, TOOL_USED

新增：ROUTE_FALLBACK, AGENT_CRASH, PIPELINE_CANCELLED,
      TRANSCRIPT_LEAK_WARNING, PIPELINE_ABORTED, RETRY_EXHAUSTED
```

分類新增 `safety` 分類（包含 AGENT_CRASH / PIPELINE_ABORTED / TRANSCRIPT_LEAK_WARNING）。

### Requirement: formatter.js 事件格式化

**完整修改後內容**：

formatter.js 新增 6 個事件的格式化支援。各事件的 formatEventText 輸出：

- ROUTE_FALLBACK: `"Route 解析失敗={stage} fallback=PASS/NEXT"`
- AGENT_CRASH: `"Agent 異常={stage} crash#{crashCount}"`
- PIPELINE_CANCELLED: `"Pipeline 取消 已完成={completedStages}"`
- TRANSCRIPT_LEAK_WARNING: `"Transcript 洩漏警告={stage} {responseLength}chars"`
- PIPELINE_ABORTED: `"Pipeline 異常終止={stage} 原因={reason}"`
- RETRY_EXHAUSTED: `"重試耗盡={stage} {retryCount}次 原因={reason}"`

## REMOVED Requirements

（無移除）
