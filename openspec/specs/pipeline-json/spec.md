# pipeline.json Delta Spec

## ADDED Requirements

### Requirement: DESIGN Stage 宣告

pipeline.json 新增 DESIGN 階段定義，包含 stages 陣列、stageLabels 和 provides 映射。

#### Scenario: stages 陣列包含 DESIGN

WHEN 讀取 pipeline.json 的 stages
THEN stages === ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"]
AND stages.length === 9

#### Scenario: stageLabels 包含 DESIGN

WHEN 讀取 pipeline.json 的 stageLabels
THEN stageLabels.DESIGN === "設計"

#### Scenario: provides 包含 DESIGN

WHEN 讀取 pipeline.json 的 provides.DESIGN
THEN provides.DESIGN.agent === "designer"
AND provides.DESIGN.skill === "/vibe:design"

## MODIFIED Requirements

### Requirement: stages 順序完整性

pipeline.json 的 stages 陣列從 8 個增加到 9 個。DESIGN 插入在 ARCH 和 DEV 之間。

完整 stages：`["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"]`
