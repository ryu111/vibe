# Classifier 模組 Delta Spec（Phase 3）

## ADDED Requirements

### Requirement: classifyWithConfidence 回傳 matchedRule 欄位
`classifyWithConfidence(prompt)` 回傳值 MUST 新增 `matchedRule` 字串欄位，標記命中的具體分類規則。

#### Scenario: Layer 1 顯式覆寫
WHEN prompt 包含 `[pipeline:full]` 語法
THEN matchedRule MUST 為 `'explicit'`

#### Scenario: Layer 2 強疑問信號
WHEN prompt 觸發 STRONG_QUESTION regex（如 "這是什麼？"）
THEN matchedRule MUST 為 `'strong-question'`

#### Scenario: Layer 2 Trivial 偵測
WHEN prompt 觸發 TRIVIAL regex（如 "做一個 hello world"）
THEN matchedRule MUST 為 `'trivial'`

#### Scenario: Layer 2 弱探索信號
WHEN prompt 觸發 WEAK_EXPLORE regex（如 "看看這個檔案"）
THEN matchedRule MUST 為 `'weak-explore'`

#### Scenario: Layer 2 動作關鍵字
WHEN prompt 觸發 ACTION_PATTERNS 中的 feature 規則
THEN matchedRule MUST 為 `'action:feature'`
AND 其他動作類型對應 `'action:tdd'`、`'action:test'`、`'action:refactor'`、`'action:bugfix'`、`'action:quickfix'`

#### Scenario: Layer 2 預設分類
WHEN prompt 不匹配任何 regex 規則
THEN matchedRule MUST 為 `'default'`

#### Scenario: Layer 3 LLM 分類
WHEN Layer 2 信心度低於閾值觸發 Layer 3
THEN matchedRule MUST 保留 Layer 2 原始值（Layer 3 不改寫 matchedRule）

#### Scenario: 向後相容
WHEN 現有消費端只讀取 `{ pipeline, confidence, source }`
THEN MUST 不受 matchedRule 新欄位影響（純增量）

### Requirement: getAdaptiveThreshold 函式
classifier.js MUST 匯出 `getAdaptiveThreshold()` 函式，根據歷史修正率動態調整 Layer 2 到 Layer 3 的降級閾值。

#### Scenario: 無 classifier-stats.json
WHEN `~/.claude/classifier-stats.json` 不存在
THEN MUST 回傳預設值 0.7

#### Scenario: stats 檔案損壞
WHEN `~/.claude/classifier-stats.json` 存在但 JSON parse 失敗
THEN MUST 回傳預設值 0.7
AND MUST 不拋出例外

#### Scenario: 修正率低於 30%
WHEN `recentWindow` 最近 50 次中 Layer 2 修正率 <= 30%
THEN MUST 回傳 0.7

#### Scenario: 修正率超過 30%
WHEN `recentWindow` 最近 50 次中 Layer 2 修正率 > 30%
THEN MUST 回傳 0.5

#### Scenario: 樣本不足
WHEN `recentWindow` 筆數 < 10
THEN MUST 回傳預設值 0.7（不啟用自適應）

#### Scenario: 環境變數最高優先
WHEN `VIBE_CLASSIFIER_THRESHOLD=0.8`
THEN MUST 回傳 0.8（無論修正率多少）
AND `getAdaptiveThreshold()` MUST 不讀取 stats 檔案

#### Scenario: 修正率計算公式
WHEN 計算 Layer 2 修正率
THEN 分子 = recentWindow 中 `layer === 2 && corrected === true` 的筆數
AND 分母 = recentWindow 中 `layer === 2` 的筆數
AND 若分母為 0 則修正率為 0

## MODIFIED Requirements

### Requirement: classifyWithConfidence 閾值改用自適應
`classifyWithConfidence()` 中判斷 `pending-llm` 的閾值 MUST 從靜態 `LLM_CONFIDENCE_THRESHOLD` 改為呼叫 `getAdaptiveThreshold()`。

完整修改後的邏輯：
```javascript
function classifyWithConfidence(prompt) {
  // ... Layer 1 / Layer 2 邏輯不變 ...
  const threshold = getAdaptiveThreshold();
  const source = confidence < threshold ? 'pending-llm' : 'regex';
  return { pipeline, confidence, source, matchedRule };
}
```

#### Scenario: 預設行為不變
WHEN `VIBE_CLASSIFIER_THRESHOLD` 未設定且無 stats 檔案
THEN 行為 MUST 與 Phase 2 完全一致（信心度 < 0.7 → pending-llm）

#### Scenario: 自適應啟用後行為變化
WHEN Layer 2 修正率 > 30% 且無環境變數覆寫
THEN 信心度 0.5~0.69 的分類 MUST 從 `pending-llm` 變為 `regex`
AND 只有信心度 < 0.5 的分類才觸發 `pending-llm`

### Requirement: classify 內部加入 matchedRule 追蹤（內部變更）
`classify()` 函式的公開介面（回傳 string）MUST 不變，但內部需支持 `classifyWithConfidence()` 取得 matchedRule。

實作方式：在 `classifyWithConfidence()` 中直接判斷 matchedRule，不改動 `classify()` 函式本身。

#### Scenario: classify 回傳值不變
WHEN 呼叫 `classify(prompt)`
THEN 回傳值 MUST 仍為 string 類型（7 種 taskType）
AND 現有 167+ 測試案例 MUST 全通過
