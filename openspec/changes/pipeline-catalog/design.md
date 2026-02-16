# 架構設計：Pipeline Catalog Phase 2 -- Layer 3 LLM 分類器 + Main Agent Sonnet 路由器

## 現有結構分析

### 目錄結構概覽（Phase 1 完成後的狀態）

```
plugins/vibe/
├── scripts/
│   ├── hooks/
│   │   └── task-classifier.js    ← 已整合 classifyWithConfidence + pending-llm 觸發 classifyWithLLM
│   └── lib/
│       ├── registry.js           ← PIPELINES / PIPELINE_PRIORITY / TASKTYPE_TO_PIPELINE
│       └── flow/
│           └── classifier.js     ← 三層級聯：Layer 1 顯式 + Layer 2 regex + Layer 3 骨架（Haiku, 8s timeout）
├── skills/pipeline/SKILL.md      ← 10 種 pipeline 路由知識
└── tests/
    ├── classifier-and-console-filter.test.js  ← 167+ tests + Layer 3 介面驗證
    └── pipeline-catalog-integration.test.js   ← pending-llm 標記驗證
```

### 關鍵模式與慣例

1. **Layer 3 骨架已存在**：`classifier.js` 已有完整的 `classifyWithLLM()` 函式 -- https 直呼 Anthropic API、JSON 解析、pipeline ID 驗證、timeout 處理、無 API key 靜默降級。
2. **task-classifier 已整合**：`pending-llm` source 已觸發 `classifyWithLLM()`，成功覆寫 / 失敗降級到 `regex-low` + `buildPipelineCatalogHint()` 注入。
3. **State debug 欄位**：`classificationConfidence` 和 `classificationSource` 已寫入 pipeline-state（兩處：初始分類 + 升級）。
4. **環境變數慣例**：Vibe 使用 `VIBE_` 前綴（如 `VIBE_DASHBOARD_PORT`）。

### 介面邊界

```
classifier.js::classifyWithLLM(prompt) → Promise<{pipeline, confidence, source}|null>
    ↑ 已被消費
task-classifier.js → if source === 'pending-llm' → await classifyWithLLM()
    ↓ 結果覆寫或降級
state: { classificationSource, classificationConfidence, pipelineId }
```

目前缺口：
- `LLM_MODEL` 硬編碼為 Haiku，需升級為 Sonnet 且可配置
- `LLM_TIMEOUT` 硬編碼為 8s，Sonnet 需調整
- 信心度閾值硬編碼為 `0.7`，需可配置
- LLM 結果無 session 快取（每次 pending-llm 都呼叫 API）
- LLM 分類的 system prompt 可最佳化（加入分類原則）
- 無 Main Agent Sonnet 路由器文件指引

---

## 方案 A：最小增量模式（In-place 升級）

### 核心理念
直接在現有 `classifyWithLLM()` 函式上修改常量和邏輯。環境變數控制模型和閾值。session 快取由 task-classifier 在 hook 層處理（讀寫 state）。

### 目錄樹

```
plugins/vibe/
├── scripts/
│   ├── hooks/
│   │   └── task-classifier.js    ← 修改：session 快取邏輯（讀/寫 state.llmClassification）
│   └── lib/flow/
│       └── classifier.js         ← 修改：LLM_MODEL → 環境變數、LLM_TIMEOUT 調整、閾值可配置
├── skills/pipeline/SKILL.md      ← 修改：新增「Main Agent 模型建議」章節
└── CLAUDE.md                     ← 修改：新增「Main Agent 路由器模式」說明
```

### 介面定義

```javascript
// classifier.js — 常量變更
const LLM_MODEL = process.env.VIBE_CLASSIFIER_MODEL || 'claude-sonnet-4-20250514';
const LLM_TIMEOUT = 10000; // Sonnet 比 Haiku 稍慢
const LLM_CONFIDENCE_THRESHOLD = parseFloat(process.env.VIBE_CLASSIFIER_THRESHOLD) || 0.7;

// classifyWithConfidence — 閾值使用常量
const source = confidence < LLM_CONFIDENCE_THRESHOLD ? 'pending-llm' : 'regex';

// classifyWithLLM — 模型使用常量（已自動生效）

// task-classifier.js — session 快取
if (state.llmClassification) {
  // 同一 session 已有 LLM 結果 → 直接使用
} else if (result.source === 'pending-llm') {
  const llmResult = await classifyWithLLM(prompt);
  if (llmResult) state.llmClassification = llmResult; // 快取
}
```

### 資料流

```
使用者 prompt
    ↓
classifyWithConfidence(prompt)
    ├─ Layer 1: extractExplicitPipeline → explicit
    ├─ Layer 2: regex + confidence
    │   └─ confidence < THRESHOLD → source: 'pending-llm'
    └─ 回傳 { pipeline, confidence, source }
    ↓
task-classifier.js（hook 層）
    ├─ 檢查 state.llmClassification → 快取命中
    ├─ source === 'pending-llm' + 無快取 → classifyWithLLM(prompt)
    │   ├─ 成功：覆寫 result + 寫入 state.llmClassification
    │   └─ 失敗：source='regex-low' + buildPipelineCatalogHint()
    └─ 更新 state（pipelineId, classificationSource 等）
```

### 優勢
- **變更最少**：只改 2 個常量 + 1 個閾值判斷 + task-classifier 加 ~10 行快取邏輯
- **零新檔案**：不新增任何模組或架構變更
- **快取在消費端**：task-classifier 是唯一的 classifyWithLLM 消費者，快取放這裡最自然
- **向後相容**：classifyWithLLM 的簽名和回傳結構不變

### 劣勢
- **快取邏輯分散**：快取在 task-classifier（hook 層）而非 classifier（函式庫層），概念上不夠內聚
- **多 session 場景**：快取依賴 state file（per-session），合理但增加 state 欄位

---

## 方案 B：函式庫內聚模式（Classifier 封裝快取）

### 核心理念
將 session 快取封裝在 `classifier.js` 內部，`classifyWithLLM()` 接受 `sessionId` 參數自行管理快取。快取使用 module-level Map（進程內快取），不依賴 state file。

### 目錄樹

```
plugins/vibe/
├── scripts/
│   ├── hooks/
│   │   └── task-classifier.js    ← 修改：傳入 sessionId，移除快取邏輯
│   └── lib/flow/
│       └── classifier.js         ← 修改：classifyWithLLM 加 sessionId + 內部 Map 快取
├── skills/pipeline/SKILL.md      ← 修改：同方案 A
└── CLAUDE.md                     ← 修改：同方案 A
```

### 介面定義

```javascript
// classifier.js — 進程內快取
const llmCache = new Map(); // sessionId → { pipeline, confidence, source }

/**
 * @param {string} prompt
 * @param {string} [sessionId] - 提供時啟用 session 快取
 */
function classifyWithLLM(prompt, sessionId) {
  if (sessionId && llmCache.has(sessionId)) {
    return Promise.resolve(llmCache.get(sessionId));
  }
  // ... API 呼叫 ...
  // 成功時：llmCache.set(sessionId, result);
}
```

### 優勢
- **內聚**：快取邏輯與 LLM 呼叫封裝在同一模組
- **零 state 膨脹**：不增加 state file 欄位
- **可測試**：純函式庫層的快取更容易單元測試

### 劣勢
- **進程生命週期問題**：command hook 每次執行是獨立的 Node.js 進程，`Map` 無法跨進程保留。也就是說 `llmCache` 在每次 UserPromptSubmit 觸發時都是空的。**這個方案在 command hook 架構下根本不可行。**
- **簽名變更**：`classifyWithLLM(prompt, sessionId)` 是 breaking change，需更新所有測試

---

## 方案 C：雙層快取模式（State file + 函式庫 API 升級）

### 核心理念
`classifier.js` 提供升級版的 `classifyWithLLM()` 介面，接受可選的 `cache` 物件（由呼叫者注入）。task-classifier 從 state file 讀取快取並注入。

### 目錄樹

同方案 A，無新檔案。

### 介面定義

```javascript
// classifier.js
/**
 * @param {string} prompt
 * @param {{ cache?: { pipeline, confidence, source } }} [options]
 * @returns {Promise<{pipeline, confidence, source}|null>}
 */
function classifyWithLLM(prompt, options = {}) {
  if (options.cache) return Promise.resolve(options.cache);
  // ... 原有 API 呼叫邏輯
}

// task-classifier.js
const cached = state.llmClassification || null;
const llmResult = await classifyWithLLM(prompt, { cache: cached });
if (llmResult && !cached) {
  state.llmClassification = llmResult; // 首次結果寫入 state
}
```

### 優勢
- **職責清晰**：classifier 負責 API 呼叫 + 快取短路，task-classifier 負責 state 持久化
- **靈活**：呼叫者決定快取策略（state file / memory / 無快取）
- **向後相容**：`options` 是可選的，不影響現有呼叫

### 劣勢
- **過度設計**：對只有一個消費者的函式增加 options 參數，增加了不必要的抽象層
- **快取邏輯仍然分散**：state 讀寫在 task-classifier，短路在 classifier，理解成本增加

---

## 方案比較

| 面向 | 方案 A：最小增量 | 方案 B：函式庫內聚 | 方案 C：雙層快取 |
|------|----------------|-------------------|----------------|
| 複雜度 | 最低 | 低 | 中 |
| 可行性 | 完全可行 | **不可行**（進程隔離） | 可行 |
| 變更行數 | ~30 行 | ~40 行 | ~45 行 |
| 破壞性 | 零（常量變更 + 新增快取邏輯） | 中（簽名變更） | 低（可選參數） |
| 慣例一致性 | 最高（state-driven 架構） | 低（違反 command hook 進程模型） | 中 |
| 可測試性 | 高 | — | 高 |
| 維護負擔 | 最低 | — | 中 |

## 決策

選擇**方案 A：最小增量模式（In-place 升級）**，原因：

1. **方案 B 不可行**：command hook 是獨立 Node.js 進程，module-level 快取無法跨執行保留。這是 ECC 架構的硬約束。

2. **方案 C 過度設計**：`classifyWithLLM()` 只有一個消費者（task-classifier），為單一消費者建立 options/cache 注入模式增加了不必要的複雜度。

3. **方案 A 最符合慣例**：Vibe 的 state-driven 架構（所有 hook 透過 state file 溝通）天然支援 session 快取。`state.llmClassification` 和現有的 `state.classificationSource`、`state.classificationConfidence` 同屬 debug/tracking 欄位，概念一致。

4. **變更面最小**：只修改 2 個程式碼檔案（classifier.js + task-classifier.js）+ 2 個文件（SKILL.md + CLAUDE.md），精確匹配 proposal.md 的影響分析。

## 風險與取捨

### 1. Sonnet API 延遲增加（中風險）
- **影響**：Sonnet 比 Haiku 慢，LLM_TIMEOUT 從 8s 提升到 10s。低信心度 prompt 的回應時間增加 1-3 秒
- **緩解**：(1) 僅低信心度（< 0.7）觸發，高信心度 prompt 零影響 (2) `VIBE_CLASSIFIER_THRESHOLD=1.0` 可完全停用 (3) session 快取避免重複呼叫
- **量化**：根據現有 classifier 測試，167 個案例中只有 weak explore 類（約 5 個）觸發 pending-llm。實際使用中估計 < 10% 的 prompt 會觸發 Layer 3

### 2. Sonnet API 成本增加（低風險）
- **影響**：Sonnet ~$0.01/次 vs Haiku ~$0.003/次（約 3 倍）
- **緩解**：(1) 每次呼叫只處理 < 500 字元的 prompt + 固定 system prompt，max_tokens=60 (2) session 快取確保同一 session 最多 1 次呼叫 (3) `VIBE_CLASSIFIER_MODEL` 允許降級回 Haiku

### 3. API key 不存在的降級路徑（低風險）
- **影響**：無 `ANTHROPIC_API_KEY` 時 Layer 3 完全不可用
- **緩解**：已有完整降級路徑 — `classifyWithLLM()` 回傳 null → source 設為 `regex-low` → `buildPipelineCatalogHint()` 注入 pipeline 目錄提示。使用者看到提示後可用 `[pipeline:xxx]` 顯式覆寫

### 4. LLM 回傳不穩定（低風險）
- **影響**：Sonnet 可能回傳非預期的 JSON 格式
- **緩解**：(1) 已有 JSON 解析 + pipeline ID 驗證邏輯 (2) 解析失敗回傳 null 觸發降級 (3) Sonnet 的指令遵從能力優於 Haiku，回傳格式穩定性預期更好

### 5. Session 快取 stale data（低風險）
- **影響**：同一 session 第一次分類的 LLM 結果被快取，後續不同類型的 prompt 可能受到影響
- **緩解**：task-classifier 的重新分類邏輯已處理 — 不同 pipelineId 觸發升級/降級判斷，快取只避免「相同 source=pending-llm 時重複呼叫 API」。如果 Layer 2 的新分類 source 不是 pending-llm（信心度 >= 0.7），根本不會查快取
- **設計決策**：快取鍵為 session 而非 prompt，因為同一 session 通常圍繞同一任務。跨任務場景由 `isPipelineComplete` + `resetPipelineState` 處理（重設時清除快取）

### 6. Main Agent Sonnet 遵從性（低風險）
- **影響**：Sonnet 可能不嚴格遵守 systemMessage 中的委派指令
- **緩解**：(1) pipeline-guard 是 exit 2 硬阻擋，不依賴模型遵從性 (2) Sonnet 對結構化 systemMessage 的遵從能力足夠 (3) 只是文件指引，使用者自行選擇是否切換

## 遷移計畫

### Step 1：classifier.js 常量升級（零破壞）
1. `LLM_MODEL` 改為環境變數讀取（`VIBE_CLASSIFIER_MODEL`，預設 Sonnet）
2. `LLM_TIMEOUT` 從 8000 調整為 10000
3. `classifyWithConfidence` 的閾值改為環境變數讀取（`VIBE_CLASSIFIER_THRESHOLD`，預設 0.7）
4. LLM system prompt 最佳化（加入分類原則 + 10 種 pipeline 目錄）

### Step 2：task-classifier.js 快取邏輯（純新增）
1. `pending-llm` 分支加入 state.llmClassification 讀取（快取命中）
2. LLM 成功結果寫入 state.llmClassification
3. `resetPipelineState()` 中清除 `llmClassification` 欄位

### Step 3：測試（純新增）
1. classifier 測試新增 Layer 3 環境變數覆寫案例
2. 新增 session 快取測試案例
3. 確認現有 167+ 測試全過

### Step 4：文件（純新增）
1. SKILL.md 新增「Main Agent 模型建議」章節
2. CLAUDE.md 新增「Main Agent 路由器模式」說明

### Step 5：全面驗證
1. 19 個測試檔案回歸
2. 驗證腳本通過
3. CLAUDE.md 數字校驗
