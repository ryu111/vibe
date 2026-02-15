# Pipeline Check Delta Spec

## MODIFIED Requirements

### Requirement: 排除已跳過的階段

pipeline-check 在計算 missing stages 時，排除 `state.skippedStages` 中記錄的階段。

完整修改後邏輯：

```js
const skipped = state.skippedStages || [];
const missing = state.expectedStages.filter(s =>
  pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
);
```

#### Scenario: DESIGN 被跳過不報缺漏

WHEN expectedStages 包含 'DESIGN'
AND state.skippedStages 包含 'DESIGN'
AND DESIGN 未出現在 completedStages 中
THEN missing 不包含 'DESIGN'

#### Scenario: E2E 被跳過不報缺漏

WHEN expectedStages 包含 'E2E'
AND state.skippedStages 包含 'E2E'
AND E2E 未出現在 completedStages 中
THEN missing 不包含 'E2E'

#### Scenario: 無 skippedStages 欄位時的回退

WHEN state.skippedStages 不存在
THEN skipped = []（空陣列）
AND 行為與修改前一致
