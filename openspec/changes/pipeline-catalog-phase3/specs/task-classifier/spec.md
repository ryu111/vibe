# Task-Classifier Hook Delta Spec（Phase 3）

## ADDED Requirements

### Requirement: emit payload 擴充分類決策資訊
task-classifier.js 的兩處 `emit(EVENT_TYPES.TASK_CLASSIFIED, ...)` 呼叫 MUST 在 data payload 中新增 `layer`、`confidence`、`source`、`matchedRule` 四個欄位。

#### Scenario: 初始分類 emit（Layer 1 顯式覆寫）
WHEN 使用者輸入 "實作功能 [pipeline:full]"
THEN emit data MUST 包含 `{ layer: 1, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' }`

#### Scenario: 初始分類 emit（Layer 2 regex）
WHEN 使用者輸入 "建立一個 REST API server"
THEN emit data MUST 包含 `{ layer: 2, confidence: 0.8, source: 'regex', matchedRule: 'action:feature' }`

#### Scenario: 初始分類 emit（Layer 3 LLM 成功）
WHEN Layer 2 信心度低觸發 Layer 3 且 LLM 成功回應
THEN emit data MUST 包含 `{ layer: 3, confidence: 0.85, source: 'llm', matchedRule: 'weak-explore' }`
AND matchedRule 保留 Layer 2 的原始值

#### Scenario: 初始分類 emit（Layer 3 LLM 快取命中）
WHEN Layer 2 信心度低但 state.llmClassification 已有快取
THEN emit data MUST 包含 `{ layer: 3, source: 'llm-cached' }`

#### Scenario: 初始分類 emit（Layer 3 LLM 失敗）
WHEN Layer 2 信心度低但 LLM 呼叫失敗
THEN emit data MUST 包含 `{ layer: 2, source: 'regex-low', matchedRule: '...' }`
AND layer 保持為 2（因為最終結果仍由 Layer 2 決定）

#### Scenario: 升級分類 emit
WHEN 從 fix 升級到 quick-dev
THEN emit data MUST 包含 `{ reclassified: true, from: 'fix', layer: ..., confidence: ..., source: ..., matchedRule: ... }`

#### Scenario: layer 值決定邏輯
WHEN source 為 'explicit' THEN layer MUST 為 1
WHEN source 為 'regex' THEN layer MUST 為 2
WHEN source 為 'llm' 或 'llm-cached' THEN layer MUST 為 3
WHEN source 為 'regex-low' THEN layer MUST 為 2
WHEN source 為 'pending-llm' THEN MUST 不出現在 emit 中（pending-llm 是中間態，emit 前已解析為 llm/llm-cached/regex-low）

### Requirement: resetPipelineState 清除 correctionCount
`resetPipelineState()` MUST 新增清除 `state.correctionCount` 的邏輯。

#### Scenario: 完整重設
WHEN `resetPipelineState()` 被呼叫
THEN `state.correctionCount` MUST 被設為 0（或 delete）
AND 其他所有現有重設行為 MUST 不變

## MODIFIED Requirements

### Requirement: emit data 結構完整定義
task-classifier.js 的 TASK_CLASSIFIED emit data 完整結構如下（Phase 1+2+3 合併後）：

```javascript
emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
  pipelineId: newPipelineId,           // Phase 1
  taskType: newTaskType,               // Phase 1
  expectedStages: newStages,           // Phase 1
  reclassified: false,                 // Phase 1
  from: oldPipelineId,                 // Phase 1（升級時）
  layer: determineLayer(result),       // Phase 3 NEW
  confidence: result.confidence,       // Phase 3 NEW
  source: result.source,              // Phase 3 NEW
  matchedRule: result.matchedRule,     // Phase 3 NEW
});
```

#### Scenario: 向後相容
WHEN Timeline consumer 或 Dashboard 只讀取 pipelineId/taskType/expectedStages
THEN MUST 不受新增欄位影響
