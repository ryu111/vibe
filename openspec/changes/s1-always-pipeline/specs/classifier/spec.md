# classifier.js Delta Spec

## ADDED Requirements

### Requirement: isSystemFeedback 函式

從 HEURISTIC_RULES 的 system-feedback 規則提取為獨立的具名純函式，偵測 hook 系統輸出（stop hook reason / emoji 前綴 / 系統通知），避免被分類為使用者意圖。

#### Scenario: SYSTEM_MARKER 前綴偵測
WHEN prompt 包含 `<!-- VIBE_SYSTEM -->` 字串（任意位置）
THEN isSystemFeedback 回傳 true

#### Scenario: Emoji 前綴偵測
WHEN prompt 以下列 emoji 開頭：⛔ ⚠️ ✅ 🔄 📋 ➡️ 📌 📄
THEN isSystemFeedback 回傳 true

#### Scenario: 英文系統通知偵測
WHEN prompt 以 "Background task" / "Task XXX completed" / "Task XXX finished" / "Task XXX failed" / "Result from" / "Output from" 開頭（不區分大小寫）
THEN isSystemFeedback 回傳 true

#### Scenario: 一般使用者輸入
WHEN prompt 不符合以上三個條件
THEN isSystemFeedback 回傳 false

### Requirement: classifyWithConfidence 新增 system source

classifyWithConfidence 在 explicit 判斷之後、main-agent fallback 之前，插入 isSystemFeedback 判斷。

#### Scenario: system-feedback 分類
WHEN prompt 被 isSystemFeedback 判定為系統回饋
THEN 回傳 `{ pipeline: 'none', confidence: 0.9, source: 'system', matchedRule: 'system-feedback' }`

## MODIFIED Requirements

### Requirement: classifyWithConfidence 回傳格式

classifyWithConfidence 的回傳物件格式 `{ pipeline, confidence, source, matchedRule }` 保持不變。source 欄位新增 `'system'` 值（新增值，非 breaking change）。

完整的 source 值域：
- `'explicit'`：Layer 1 顯式 `[pipeline:xxx]` 匹配
- `'system'`：系統回饋偵測（原 heuristic:system-feedback）
- `'main-agent'`：交由 Main Agent 判斷（fallback）
- `'fallback'`：空 prompt

#### Scenario: Layer 1 顯式匹配（不變）
WHEN prompt 包含合法的 `[pipeline:xxx]` 語法
THEN 回傳 `{ pipeline: xxx, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' }`

#### Scenario: 空 prompt（不變）
WHEN prompt 為空、null、undefined 或只有空白
THEN 回傳 `{ pipeline: 'none', confidence: 0, source: 'fallback', matchedRule: 'empty' }`

#### Scenario: 一般 prompt fallback（修改）
WHEN prompt 非顯式、非系統回饋、非空
THEN 回傳 `{ pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' }`
（原本 heuristic 會在此之前攔截，現在直接 fallback）

### Requirement: module.exports

module.exports 刪除 `classifyByHeuristic` 和 `buildPipelineCatalogHint`，新增 `isSystemFeedback`。

完整 exports：
- `SYSTEM_MARKER`（常數，不變）
- `classifyWithConfidence`（主 API，不變）
- `extractExplicitPipeline`（Layer 1，不變）
- `isSystemFeedback`（新增）
- `mapTaskTypeToPipeline`（向後相容，不變）

## REMOVED Requirements

### Requirement: QUESTION_PATTERNS 常數
Reason: 問答偵測交由 Main Agent 判斷（Main Agent 有完整對話 context，比 regex 更準確）
Migration: 無需遷移，Main Agent 的 systemMessage 中「chat」選項覆蓋此場景

### Requirement: FILE_PATH_PATTERN 常數
Reason: 只被 question 規則的負面排除引用，隨 question 規則一併刪除
Migration: 無

### Requirement: HEURISTIC_RULES 陣列
Reason: 6 條規則中，5 條用於使用者意圖分類（交由 Main Agent），1 條（system-feedback）提取為 isSystemFeedback
Migration: system-feedback 邏輯遷移到 isSystemFeedback()

### Requirement: classifyByHeuristic 函式
Reason: HEURISTIC_RULES 刪除後無存在意義
Migration: 測試中所有 classifyByHeuristic 呼叫改為 isSystemFeedback 呼叫

### Requirement: buildPipelineCatalogHint 函式
Reason: pipeline 清單直接內嵌到 controller.classify() 的新 systemMessage（靜態表格），不再需要動態裁剪
Migration: pipeline-controller.js 刪除 buildPipelineCatalogHint import

### Requirement: PRIORITY_ORDER / CATALOG_WINDOW 常數
Reason: buildPipelineCatalogHint 專用常量，隨函式一併刪除
Migration: 無
