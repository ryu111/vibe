# pipeline-controller.js classify() Delta Spec

## ADDED Requirements

### Requirement: system source 快速返回

classify() 在接收到 classifyWithConfidence 的 `source === 'system'` 結果時，直接返回 null（不輸出、不修改 state）。

#### Scenario: stop hook reason 被系統回饋攔截
WHEN classifyWithConfidence 回傳 `{ source: 'system' }`
THEN classify() 回傳 `{ output: null }`
AND 不修改 pipeline state
AND 不輸出 systemMessage

### Requirement: 新 systemMessage pipeline 選擇表

source === 'main-agent' 路徑注入新格式的 systemMessage，包含 10 種 pipeline 的表格和判斷原則。

#### Scenario: 一般 prompt 注入 systemMessage
WHEN classifyWithConfidence 回傳 `{ source: 'main-agent' }`
AND 非 ACTIVE / 非 CANCELLED 狀態
THEN classify() 回傳 systemMessage 包含：
  - 角色設定：「你是 Pipeline 路由器」
  - 10 行 pipeline 表格（含 chat / fix / quick-dev / standard / full / test-first / ui-only / review-only / docs-only / security）
  - 判斷原則：偏向使用 pipeline / 不確定時 AskUserQuestion / 複合任務分解

#### Scenario: systemMessage 表格中的 chat 選項
WHEN Main Agent 判斷為問答/研究/解釋/查詢/trivial
THEN Main Agent 直接回答，不呼叫 pipeline（systemMessage 明確指示）

#### Scenario: systemMessage 引導 AskUserQuestion
WHEN Main Agent 無法確定應使用哪個 pipeline
THEN Main Agent 使用 AskUserQuestion 詢問使用者（systemMessage 明確指示）

## MODIFIED Requirements

### Requirement: COMPLETE 狀態處理

刪除 30 秒冷卻邏輯。COMPLETE 狀態下直接 reset，不再等待。

#### Scenario: COMPLETE + 顯式分類
WHEN pipeline 狀態為 COMPLETE
AND 新分類 source === 'explicit'
THEN 呼叫 ds.resetKeepingClassification(state)（保留前次分類供追蹤）
AND 繼續後續分類流程

#### Scenario: COMPLETE + 非顯式分類
WHEN pipeline 狀態為 COMPLETE
AND 新分類 source !== 'explicit'
THEN 呼叫 ds.reset(state)（完全重設）
AND 繼續後續分類流程

（刪除原本的「非顯式 + 30 秒內 → return null」路徑）

### Requirement: CANCELLED 狀態處理

簡化 cancelled 抑制邏輯。

#### Scenario: CANCELLED + 非顯式
WHEN state.meta.cancelled === true
AND 新分類 source !== 'explicit'
THEN classify() 回傳 `{ output: null }`

#### Scenario: CANCELLED + 顯式
WHEN state.meta.cancelled === true
AND 新分類 source === 'explicit'
THEN 呼叫 ds.reset(state)
AND 繼續後續分類流程

（簡化：刪除原本與 heuristic 相關的 cancelled 分支）

### Requirement: ACTIVE 狀態處理

簡化 stale 偵測。ACTIVE + 非顯式一律忽略（不再有 10 分鐘 stale 後允許重分類的路徑）。

#### Scenario: ACTIVE + 非顯式
WHEN pipeline 狀態為 ACTIVE（ds.isActive(state) === true）
AND 新分類 source !== 'explicit'
THEN classify() 回傳 `{ output: null }`

#### Scenario: ACTIVE + 顯式
WHEN pipeline 狀態為 ACTIVE
AND 新分類 source === 'explicit'
THEN 允許重分類（可能觸發升級/重設邏輯）

（刪除原本的「非顯式 + >10 分鐘 stale → 允許重分類」路徑）

### Requirement: import 清理

刪除從 classifier.js 引入的 `buildPipelineCatalogHint`。

完整 import：
```javascript
const { classifyWithConfidence } = require('./classifier.js');
```

（不再需要 buildPipelineCatalogHint，pipeline 清單內嵌到 systemMessage 字串中）

## REMOVED Requirements

### Requirement: 30 秒冷卻期（COMPLETE 狀態）
Reason: system-feedback 快篩已能攔截 stop hook reason。冷卻期存在的原因是 classifier heuristic 會將 stop hook 的 reason 文字誤分類為 bugfix/fix-change，現在 heuristic 已刪除，main-agent fallback 不會建立 DAG。
Migration: 直接刪除 `elapsedMs < 30000` 條件和相關程式碼

### Requirement: stale 偵測（ACTIVE 狀態 10 分鐘超時）
Reason: 簡化為 ACTIVE + 非顯式一律忽略。stale 場景由使用者顯式 `[pipeline:xxx]` 或 cancel 後重新開始處理。
Migration: 刪除 `elapsedMs < 10 * 60 * 1000` 條件和 stale fallthrough 邏輯

### Requirement: 8 條決策表 systemMessage
Reason: 替換為新格式的 10 行 pipeline 表格
Migration: controller.classify() 中替換 systemMessage 字串
