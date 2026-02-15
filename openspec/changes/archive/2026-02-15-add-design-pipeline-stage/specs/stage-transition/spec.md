# Stage Transition Delta Spec

## ADDED Requirements

### Requirement: DESIGN 階段條件跳過

stage-transition 在 ARCH 完成後判斷是否路由到 DESIGN 階段。根據環境偵測結果和 state 標記決定。

#### Scenario: 前端專案路由到 DESIGN

WHEN currentStage === 'ARCH' 完成
AND state.environment.framework.name 屬於 FRONTEND_FRAMEWORKS
THEN nextStageCandidate === 'DESIGN'
AND systemMessage 包含 'DESIGN（設計）'
AND systemMessage 包含 '/vibe:design'

#### Scenario: 後端專案跳過 DESIGN

WHEN currentStage === 'ARCH' 完成
AND state.environment.framework.name === 'express'（或其他後端框架）
AND state.needsDesign !== true
THEN DESIGN 被跳過
AND skippedStages 包含 'DESIGN（純後端/CLI 專案不需視覺設計）'
AND nextStageCandidate === 'DEV'

#### Scenario: needsDesign 強制路由

WHEN currentStage === 'ARCH' 完成
AND state.needsDesign === true
AND state.environment.framework.name 不屬於 FRONTEND_FRAMEWORKS
THEN nextStageCandidate === 'DESIGN'（即使是後端專案）

#### Scenario: 無框架偵測結果

WHEN currentStage === 'ARCH' 完成
AND state.environment.framework === null
AND state.needsDesign !== true
THEN DESIGN 被跳過
AND nextStageCandidate === 'DEV'

### Requirement: skippedStages State 記錄

stage-transition 在跳過階段時，將被跳過的 stage 名稱記錄到 `state.skippedStages` 陣列。

#### Scenario: DESIGN 跳過記錄

WHEN DESIGN 階段被跳過
THEN state.skippedStages 包含 'DESIGN'
AND state file 被寫入

#### Scenario: E2E 跳過記錄（統一模式）

WHEN E2E 階段被跳過（isApiOnly === true）
THEN state.skippedStages 包含 'E2E'
AND state file 被寫入

#### Scenario: skippedStages 初始化

WHEN state.skippedStages 不存在
THEN 初始化為空陣列 []

#### Scenario: 多階段跳過累積

WHEN DESIGN 和 E2E 都被跳過
THEN state.skippedStages === ['DESIGN', 'E2E']

### Requirement: DESIGN 階段 OpenSpec Context 注入

stage-transition 在路由到 DESIGN 階段時注入 OpenSpec 相關的上下文提示。

#### Scenario: OpenSpec 啟用時的 DESIGN Context

WHEN state.openspecEnabled === true
AND nextStageCandidate === 'DESIGN'
THEN stageContext 包含 'OpenSpec：architect 已產出 design.md，designer 請讀取 openspec/changes/ 中的 proposal.md 和 design.md 後產出 design-system.md 和 design-mockup.html'

### Requirement: POST_STAGE_HINTS 調整

ARCH 階段完成後的提示從指向 DEV 改為指向 DESIGN（如果 DESIGN 未被跳過）。

#### Scenario: ARCH 完成後有 DESIGN

WHEN ARCH 完成且 DESIGN 未被跳過
THEN POST_STAGE_HINTS.ARCH 提示設計相關內容

#### Scenario: DESIGN 完成後指向 DEV

WHEN DESIGN 完成
THEN POST_STAGE_HINTS.DESIGN 提示 developer 參考 design-system.md

### Requirement: FRONTEND_FRAMEWORKS 提取為共用常量

FRONTEND_FRAMEWORKS 清單從 task-classifier 的 `buildKnowledgeHints` 函式內部提取到 stage-transition 可引用的位置。

#### Scenario: FRONTEND_FRAMEWORKS 包含 8 種框架

WHEN 讀取 FRONTEND_FRAMEWORKS
THEN 包含 'next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular'

## MODIFIED Requirements

### Requirement: DEV_OR_LATER 自動 enforce 範圍

DEV_OR_LATER 陣列需包含 DESIGN（因為 DESIGN 在 DEV 之前，但手動觸發 PLAN → ARCH 後進入 DESIGN 也應觸發 auto-enforce）。

完整範圍：`['DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']`

注意：原名 DEV_OR_LATER 不再完全準確，但為減少破壞性保持不改名。
