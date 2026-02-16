# Formatter 模組 Delta Spec（Phase 3）

## MODIFIED Requirements

### Requirement: task.classified 格式化升級
formatter.js 的 `formatEventText()` 中 `task.classified` case MUST 升級為包含 Layer 和信心度資訊的格式。

舊格式：
```
分類=feature, 預期階段=[PLAN,ARCH,DEV,REVIEW,TEST,DOCS]
```

新格式：
```
分類=standard L2(0.80) [action:feature]
```

#### Scenario: 完整格式（有 layer + confidence + matchedRule）
WHEN event.data 包含 `{ pipelineId: 'standard', layer: 2, confidence: 0.8, matchedRule: 'action:feature' }`
THEN formatEventText MUST 回傳 `"分類=standard L2(0.80) [action:feature]"`

#### Scenario: Layer 1 顯式覆寫
WHEN event.data 包含 `{ pipelineId: 'full', layer: 1, confidence: 1.0, matchedRule: 'explicit' }`
THEN formatEventText MUST 回傳 `"分類=full L1(1.00) [explicit]"`

#### Scenario: Layer 3 LLM 分類
WHEN event.data 包含 `{ pipelineId: 'standard', layer: 3, confidence: 0.85, source: 'llm', matchedRule: 'weak-explore' }`
THEN formatEventText MUST 回傳 `"分類=standard L3(0.85) [weak-explore]"`

#### Scenario: 向後相容（舊格式 data）
WHEN event.data 不包含 `layer` 欄位（舊版 timeline 資料）
THEN formatEventText MUST 回退到顯示 `"分類={pipelineId||taskType}, 預期階段=[...]"` 的舊格式
AND MUST 不拋出例外

#### Scenario: 升級分類
WHEN event.data 包含 `{ reclassified: true, from: 'fix', pipelineId: 'quick-dev', layer: 2, confidence: 0.8, matchedRule: 'action:bugfix' }`
THEN formatEventText MUST 包含升級資訊，如 `"升級 fix->quick-dev L2(0.80) [action:bugfix]"`

#### Scenario: 信心度格式
WHEN confidence 為 0.8
THEN MUST 顯示為 `0.80`（固定兩位小數）

#### Scenario: 下游自動受益
WHEN formatEventText 格式變更
THEN Dashboard UI（server.js formatEvent）MUST 自動顯示新格式
AND Remote consumer（bot.js handleTimeline）MUST 自動顯示新格式
AND Timeline skill（/vibe:timeline）MUST 自動顯示新格式
AND 這些下游消費端 MUST 不需任何修改
