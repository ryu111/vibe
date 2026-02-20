# 測試 Delta Spec

## ADDED Requirements

### Requirement: isSystemFeedback 單元測試

新增 isSystemFeedback 的獨立測試區段，取代原 classifyByHeuristic 的 system-feedback 測試。

#### Scenario: SYSTEM_MARKER 偵測
WHEN 測試 isSystemFeedback(`${SYSTEM_MARKER}任意文字`)
THEN 回傳 true

#### Scenario: Emoji 前綴偵測（8 種）
WHEN 測試 isSystemFeedback 對 ⛔/⚠️/✅/🔄/📋/➡️/📌/📄 開頭的字串
THEN 每種都回傳 true

#### Scenario: 英文系統通知偵測
WHEN 測試 "Background task completed" / "Task X finished" / "Result from Y"
THEN 每種都回傳 true

#### Scenario: 一般使用者輸入
WHEN 測試 "修復一個 bug" / "建立 REST API" / "什麼是 pipeline?"
THEN 每種都回傳 false

#### Scenario: 邊界值
WHEN 測試空字串 / null / undefined / 只有空白
THEN 回傳 false

### Requirement: classifyWithConfidence system source 測試

#### Scenario: system-feedback 回傳 source='system'
WHEN classifyWithConfidence 接收到系統回饋 prompt
THEN 回傳 `{ source: 'system', matchedRule: 'system-feedback' }`

### Requirement: AskUserQuestion guard 放行測試

#### Scenario: Relay 模式下 AskUserQuestion 放行
WHEN evaluate('AskUserQuestion', {}, activeState)
AND activeState.pipelineActive === true
AND activeState.activeStages === []
THEN 回傳 `{ decision: 'allow' }`

### Requirement: 分類場景測試（20+ 場景）

驗證移除 heuristic 後，各種 prompt 都正確 fallback 到 main-agent。

#### Scenario: 原 fix-change 命中的 prompt
WHEN classifyWithConfidence("把 MAX_RETRIES 改成 5")
THEN 回傳 `{ source: 'main-agent' }`（不再被 fix-change heuristic 攔截）

#### Scenario: 原 bugfix 命中的 prompt
WHEN classifyWithConfidence("修復認證 bug")
THEN 回傳 `{ source: 'main-agent' }`（不再被 bugfix heuristic 攔截）

#### Scenario: 原 question 命中的 prompt
WHEN classifyWithConfidence("什麼是 pipeline?")
THEN 回傳 `{ source: 'main-agent' }`（不再被 question heuristic 攔截）

#### Scenario: 原 review-only 命中的 prompt
WHEN classifyWithConfidence("review classifier.js")
THEN 回傳 `{ source: 'main-agent' }`（不再被 review-only heuristic 攔截）

#### Scenario: 原 docs 命中的 prompt
WHEN classifyWithConfidence("更新 README 文件")
THEN 回傳 `{ source: 'main-agent' }`（不再被 docs heuristic 攔截）

## MODIFIED Requirements

### Requirement: classifier-and-console-filter.test.js 重構

Part 1a（extractExplicitPipeline）：保留不變
Part 1b（classifyWithConfidence Layer 1）：保留不變
Part 1b-2 ~ 1b-6（classifyByHeuristic 系列）：全部刪除，替換為 isSystemFeedback 測試
Part 1c（fallback 行為）：調整預期（疑問句不再回傳 heuristic source）
Part 1d（buildPipelineCatalogHint）：全部刪除
Part 1g（mapTaskTypeToPipeline）：保留不變

### Requirement: pipeline-catalog-integration.test.js 調整

classifyWithConfidence 相關測試：確認移除 heuristic 後，非顯式 prompt 回傳 main-agent source。

## REMOVED Requirements

### Requirement: classifyByHeuristic 相關測試（~70 個）
Reason: classifyByHeuristic 函式已刪除
Migration: 刪除 Part 1b-2 到 1b-6 的所有測試，system-feedback 偵測移至 isSystemFeedback 測試

### Requirement: buildPipelineCatalogHint 測試（~6 個）
Reason: buildPipelineCatalogHint 函式已刪除
Migration: 刪除 Part 1d 的所有測試
