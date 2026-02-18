# Dashboard/Remote 模組 Delta Spec

## ADDED Requirements

### Requirement: Dashboard Barrier 視覺化

Dashboard 顯示並行 stage 的 barrier 狀態。

#### Scenario: 並行 stage 同時 active
WHEN pipeline-state 的 activeStages 包含多個 stage
THEN Agent Status 面板顯示多個 agent 同時 active
AND Pipeline 流程圖中對應的 stage cards 同時亮起

#### Scenario: Barrier 等待中
WHEN barrier-state 顯示部分完成（如 1/2）
THEN Dashboard 顯示 barrier 進度（如 "post-dev: 1/2 等待中"）

#### Scenario: Barrier 全到齊
WHEN barrier-state 所有 stage 完成
THEN Dashboard 更新為 barrier 已解決
AND 顯示合併結果（PASS 或 FAIL + 各 stage 結果）

---

## MODIFIED Requirements

### Requirement: Dashboard adaptV3() 適配層

**完整修改後內容**：

v4 Phase 5 時將 adaptV3() 升級為 adaptV4()。Phase 0-4 過渡期間 adaptV3() 繼續運作（v4 state 保持向後相容的必要欄位）。

adaptV4() 的核心差異：
- 從 `state.pipelineActive` 讀取 pipeline 狀態（取代 derivePhase 推導）
- 從 `state.activeStages` 讀取活躍 stage 列表（取代遍歷 stages 物件）
- 新增 barrier 狀態讀取（從 barrier-state-{sid}.json）
- retryHistory 顯示（歷史 severity 趨勢）

### Requirement: Remote bot.js State 讀取

**完整修改後內容**：

bot.js 的 handleStatus/handleStages 在 Phase 5 時從 v3 DAG 讀取改為 v4 直讀：
- 使用 pipelineActive 判斷 pipeline 狀態
- 從 activeStages 讀取活躍 stage
- 從 retryHistory 顯示重試歷史

## REMOVED Requirements

（無移除 — Dashboard/Remote 只有適配層修改）
