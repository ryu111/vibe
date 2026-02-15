# Registry 模組 Delta Spec

## ADDED Requirements

### Requirement: DESIGN Stage 定義

registry.js 的 STAGES 物件新增 DESIGN entry，定義 designer agent 與 DESIGN 階段的映射。

#### Scenario: DESIGN 在 STAGE_ORDER 中的位置

WHEN registry.js 被載入
THEN STAGE_ORDER 為 `['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']`
AND STAGE_ORDER.indexOf('DESIGN') === 2
AND STAGE_ORDER.indexOf('DESIGN') > STAGE_ORDER.indexOf('ARCH')
AND STAGE_ORDER.indexOf('DESIGN') < STAGE_ORDER.indexOf('DEV')

#### Scenario: DESIGN Stage 屬性

WHEN 讀取 STAGES.DESIGN
THEN agent === 'designer'
AND emoji === '\u{1F3A8}'（調色盤）
AND label === '設計'
AND color === 'cyan'

#### Scenario: Agent-to-Stage 映射

WHEN 讀取 AGENT_TO_STAGE
THEN AGENT_TO_STAGE['designer'] === 'DESIGN'
AND NAMESPACED_AGENT_TO_STAGE['vibe:designer'] === 'DESIGN'

#### Scenario: 映射總數

WHEN 計算 agentToStage 映射數量
THEN 短名稱映射數量 === 9
AND namespaced 映射數量 === 9
AND 總計 === 18

## MODIFIED Requirements

### Requirement: STAGE_ORDER 長度

STAGE_ORDER 的長度從 8 變為 9。所有依賴 STAGE_ORDER 長度的邏輯需更新。

完整 STAGE_ORDER：`['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']`
