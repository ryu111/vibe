# Classifier 模組 Delta Spec（Phase 2）

## ADDED Requirements

### Requirement: VIBE_CLASSIFIER_MODEL 環境變數
classifier.js MUST 支援 `VIBE_CLASSIFIER_MODEL` 環境變數覆寫 LLM 分類使用的模型。預設值為 `claude-sonnet-4-20250514`。

#### Scenario: 預設使用 Sonnet
WHEN `VIBE_CLASSIFIER_MODEL` 未設定
THEN `classifyWithLLM()` MUST 使用 `claude-sonnet-4-20250514` 模型

#### Scenario: 環境變數覆寫模型
WHEN `VIBE_CLASSIFIER_MODEL=claude-haiku-4-5-20251001`
THEN `classifyWithLLM()` MUST 使用 `claude-haiku-4-5-20251001` 模型

#### Scenario: 完整模型 ID
WHEN 設定 `VIBE_CLASSIFIER_MODEL`
THEN 值 MUST 為 Anthropic API 的完整模型 ID（非短名稱）
AND 傳入 API request body 的 `model` 欄位

### Requirement: VIBE_CLASSIFIER_THRESHOLD 環境變數
classifier.js MUST 支援 `VIBE_CLASSIFIER_THRESHOLD` 環境變數控制 Layer 2 到 Layer 3 的降級閾值。預設值為 `0.7`。

#### Scenario: 預設閾值 0.7
WHEN `VIBE_CLASSIFIER_THRESHOLD` 未設定
THEN Layer 2 信心度 < 0.7 的結果 MUST 標記為 `source: 'pending-llm'`

#### Scenario: 環境變數覆寫閾值
WHEN `VIBE_CLASSIFIER_THRESHOLD=0.5`
THEN 只有信心度 < 0.5 的結果才會標記為 `pending-llm`
AND 信心度 0.5~0.69 的結果 MUST 標記為 `source: 'regex'`

#### Scenario: 閾值設為 1.0 停用 Layer 3
WHEN `VIBE_CLASSIFIER_THRESHOLD=1.0`
THEN 所有 Layer 2 結果（最高信心度 0.95）MUST 觸發 `pending-llm`
AND 此行為等同停用 Layer 3 只在所有信心度等級都生效

**Note**：閾值 1.0 使所有結果都觸發 pending-llm，但如果 `ANTHROPIC_API_KEY` 不存在，LLM 呼叫會靜默降級。更精確的停用方式是不設定 `ANTHROPIC_API_KEY`。

#### Scenario: 閾值設為 0 啟用全部 Layer 3
WHEN `VIBE_CLASSIFIER_THRESHOLD=0`
THEN 所有 Layer 2 結果（包含信心度 0.95）都不會觸發 `pending-llm`
AND Layer 3 MUST 永不觸發

#### Scenario: 非法閾值降級
WHEN `VIBE_CLASSIFIER_THRESHOLD=abc`
THEN MUST 使用預設值 0.7（`parseFloat('abc')` 回傳 `NaN`，需做 fallback）

### Requirement: LLM 逾時調整
classifier.js 的 `LLM_TIMEOUT` MUST 從 8000ms 調整為 10000ms，以適配 Sonnet 模型較長的回應時間。

#### Scenario: API 呼叫在 10 秒內回應
WHEN LLM API 在 10 秒內回應
THEN MUST 正常處理結果

#### Scenario: API 呼叫超過 10 秒
WHEN LLM API 超過 10 秒未回應
THEN MUST 銷毀請求並回傳 null
AND 觸發降級路徑

## MODIFIED Requirements

### Requirement: classifyWithConfidence 閾值可配置
`classifyWithConfidence()` 中判斷 `pending-llm` 的閾值 MUST 從硬編碼 `0.7` 改為讀取 `VIBE_CLASSIFIER_THRESHOLD` 環境變數。

完整修改後的邏輯：
```
const threshold = parseFloat(process.env.VIBE_CLASSIFIER_THRESHOLD);
const LLM_CONFIDENCE_THRESHOLD = Number.isNaN(threshold) ? 0.7 : threshold;
const source = confidence < LLM_CONFIDENCE_THRESHOLD ? 'pending-llm' : 'regex';
```

#### Scenario: 預設行為不變
WHEN `VIBE_CLASSIFIER_THRESHOLD` 未設定
THEN 行為 MUST 與 Phase 1 完全一致（信心度 < 0.7 → pending-llm）

### Requirement: classifyWithLLM 模型升級
`classifyWithLLM()` MUST 使用 `VIBE_CLASSIFIER_MODEL` 環境變數指定的模型（預設 Sonnet）替代硬編碼的 Haiku 模型。

完整修改後的常量：
```
const LLM_MODEL = process.env.VIBE_CLASSIFIER_MODEL || 'claude-sonnet-4-20250514';
const LLM_TIMEOUT = 10000;
```

#### Scenario: 所有現有 Layer 3 介面測試通過
WHEN 執行現有 Layer 3 介面測試（無 API key → null、回傳 Promise 等）
THEN 全部 MUST 通過
AND 行為 MUST 與升級前一致
