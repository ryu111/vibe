# Task-Classifier Hook Delta Spec（Phase 2）

## ADDED Requirements

### Requirement: LLM 結果 session 快取
task-classifier.js MUST 在 state 中新增 `llmClassification` 欄位，快取同一 session 的 LLM 分類結果，避免重複 API 呼叫。

#### Scenario: 首次 pending-llm 觸發 LLM 呼叫
WHEN `classifyWithConfidence()` 回傳 `source: 'pending-llm'`
AND `state.llmClassification` 不存在
THEN MUST 呼叫 `classifyWithLLM(prompt)`
AND 成功時 MUST 將結果寫入 `state.llmClassification`

#### Scenario: 快取命中跳過 LLM 呼叫
WHEN `classifyWithConfidence()` 回傳 `source: 'pending-llm'`
AND `state.llmClassification` 已存在
THEN MUST 直接使用 `state.llmClassification` 的結果
AND MUST 不呼叫 `classifyWithLLM()`

#### Scenario: LLM 呼叫失敗不寫入快取
WHEN `classifyWithLLM()` 回傳 `null`
THEN MUST 不寫入 `state.llmClassification`
AND source MUST 設為 `'regex-low'`
AND MUST 注入 `buildPipelineCatalogHint()` 到 additionalContext

#### Scenario: Pipeline 重設清除快取
WHEN `resetPipelineState()` 被呼叫（上一個 pipeline 完成後新任務開始）
THEN MUST 刪除 `state.llmClassification`
AND 下一次 pending-llm 觸發時 MUST 重新呼叫 LLM API

### Requirement: state.classificationSource 記錄 LLM 來源
當 LLM 分類成功時，`state.classificationSource` MUST 記錄為 `'llm'`。當快取命中時，MUST 記錄為 `'llm-cached'`。

#### Scenario: 首次 LLM 成功
WHEN `classifyWithLLM()` 回傳有效結果
THEN `state.classificationSource` MUST 為 `'llm'`

#### Scenario: 快取命中
WHEN `state.llmClassification` 快取命中
THEN `state.classificationSource` MUST 為 `'llm-cached'`

#### Scenario: LLM 失敗
WHEN `classifyWithLLM()` 回傳 null
THEN `state.classificationSource` MUST 為 `'regex-low'`

## MODIFIED Requirements

### Requirement: resetPipelineState 清除 LLM 快取
`resetPipelineState()` 函式 MUST 新增清除 `state.llmClassification` 的邏輯。

完整修改後的函式（新增部分）：
```javascript
function resetPipelineState(state) {
  // ... 現有邏輯不變 ...
  delete state.llmClassification; // 新增：清除 LLM 快取
}
```

#### Scenario: 完整重設包含 LLM 快取
WHEN `resetPipelineState()` 被呼叫
THEN `state.llmClassification` MUST 被刪除
AND 其他所有現有重設行為 MUST 不變
