# Task Classifier Delta Spec

## MODIFIED Requirements

### Requirement: STAGE_MAPS.feature 包含 DESIGN

feature 類型的 expectedStages 靜態包含 DESIGN 階段。跳過邏輯由 stage-transition 處理。

完整定義：

```js
const STAGE_MAPS = {
  research: [],
  quickfix: ['DEV'],
  bugfix: ['DEV', 'TEST'],
  feature: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
  refactor: ['ARCH', 'DEV', 'REVIEW'],
  test: ['TEST'],
  tdd: ['TEST', 'DEV', 'REVIEW'],
};
```

#### Scenario: feature 類型 expectedStages

WHEN 任務分類為 feature
THEN expectedStages 包含 'DESIGN'
AND expectedStages.indexOf('DESIGN') === 2（在 ARCH 之後、DEV 之前）

#### Scenario: 非 feature 類型不含 DESIGN

WHEN 任務分類為 refactor, bugfix, quickfix, test, tdd, research
THEN expectedStages 不包含 'DESIGN'
