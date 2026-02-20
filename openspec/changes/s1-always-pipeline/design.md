# 架構設計：S1 Always-Pipeline 架構

## 現有結構分析

### 目錄結構概覽

```
plugins/vibe/scripts/
├── hooks/
│   ├── task-classifier.js       ← UserPromptSubmit: 呼叫 ctrl.classify()
│   ├── pipeline-guard.js        ← PreToolUse(*): 呼叫 ctrl.canProceed()
│   ├── pipeline-check.js        ← Stop: 引用 SYSTEM_MARKER
│   └── task-guard.js            ← Stop: 引用 SYSTEM_MARKER
└── lib/
    ├── flow/
    │   ├── classifier.js        ← 三層分類器（Layer 1 + 1.5 + 2 fallback）~257 行
    │   └── pipeline-controller.js ← classify() 統一 API ~220 行
    └── sentinel/
        └── guard-rules.js       ← evaluate() 工具防護 ~270 行
```

### 關鍵模式與慣例

1. **classifier.js 是純函式模組**：無副作用，匯出常數 + 純函式。pipeline-controller.js 是唯一消費端。
2. **SYSTEM_MARKER 跨模組引用**：pipeline-check.js 和 task-guard.js 直接從 classifier.js import。
3. **classifyWithConfidence 回傳格式**：`{ pipeline, confidence, source, matchedRule }` 被 controller 和測試廣泛使用。
4. **controller.classify() 的回饋循環防護**：COMPLETE 30s 冷卻、CANCELLED 抑制、ACTIVE 忽略、stale 偵測 -- 全部是為了防止 stop hook feedback 誤觸發 pipeline。
5. **guard-rules.evaluate() 短路鏈**：7 步規則，AskUserQuestion 目前不在白名單中。

### 介面邊界

```
classifier.js
  ├── SYSTEM_MARKER (const)        → pipeline-check.js, task-guard.js, 測試
  ├── extractExplicitPipeline()    → classifyWithConfidence() 內部
  ├── classifyByHeuristic()        → classifyWithConfidence() 內部, 測試
  ├── classifyWithConfidence()     → pipeline-controller.js classify()
  ├── mapTaskTypeToPipeline()      → （歷史遺留，可能被 controller 引用）
  └── buildPipelineCatalogHint()   → pipeline-controller.js classify()

pipeline-controller.js classify()
  ├── 消費 classifyWithConfidence()
  ├── 消費 buildPipelineCatalogHint()
  ├── 產出 systemMessage（Layer 2 分類指令 / DAG 建立指令）
  └── 產出 additionalContext（知識庫提示）

guard-rules.js evaluate()
  └── READ_ONLY_TOOLS 白名單（無 AskUserQuestion）
```

### 核心問題診斷

| 問題 | 根因 | 現有緩解 | S1 解法 |
|------|------|---------|---------|
| regex 誤判 | `改成` 命中 fix-change；問句命中 bugfix | 負面排除正則（越加越複雜） | 刪除 regex 層 |
| Main Agent 不聽 | Layer 2 是 advisory systemMessage | 8 條決策表 + 偏向提示 | 簡化為 10 行表格 + 明確行動指令 |
| 選錯 pipeline 死鎖 | pipelineActive=true + Main Agent 被阻擋 | cancel skill 逃生門 | AskUserQuestion 白名單 + 更精準的分類 |
| 回饋循環 | stop hook reason 被重分類 | SYSTEM_MARKER + 30s 冷卻 + cancelled 抑制 | SYSTEM_MARKER 保留（最小化）+ 大幅簡化回饋防護 |

---

## 方案 A：Minimal Deletion（最小刪除 + systemMessage 強化）

### 核心思路

保留 classifier.js 的 system-feedback 偵測（SYSTEM_MARKER + emoji 前綴），只刪除使用者意圖分類的 heuristic 規則。回饋循環防護大幅簡化但保留核心安全網。

### 目錄樹

```
plugins/vibe/scripts/lib/flow/
├── classifier.js           ← 刪 HEURISTIC_RULES/classifyByHeuristic/buildPipelineCatalogHint
│                              保留 SYSTEM_MARKER/extractExplicitPipeline/isSystemFeedback（新）
└── pipeline-controller.js  ← classify() 簡化回饋循環 + 新 systemMessage

plugins/vibe/scripts/lib/sentinel/
└── guard-rules.js          ← READ_ONLY_TOOLS 新增 AskUserQuestion
```

### 介面定義

**classifier.js（~80 行）**

```javascript
// 保留
const SYSTEM_MARKER = '<!-- VIBE_SYSTEM -->';

function extractExplicitPipeline(prompt) { ... }  // 不變

// 新增：從 HEURISTIC_RULES 的 system-feedback 規則提取為獨立函式
function isSystemFeedback(prompt) {
  const t = prompt.trim();
  if (t.includes(SYSTEM_MARKER)) return true;
  if (/^[⛔⚠️✅🔄📋➡️📌📄]/.test(t)) return true;
  if (/^(Background task|Task .+ (completed|finished|failed)|Result from|Output from)/i.test(t)) return true;
  return false;
}

// 簡化
async function classifyWithConfidence(prompt) {
  if (!prompt?.trim()) return { pipeline: 'none', confidence: 0, source: 'fallback', matchedRule: 'empty' };
  const explicit = extractExplicitPipeline(prompt);
  if (explicit) return { pipeline: explicit, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' };
  if (isSystemFeedback(prompt)) return { pipeline: 'none', confidence: 0.9, source: 'system', matchedRule: 'system-feedback' };
  return { pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' };
}

// 保留（向後相容）
function mapTaskTypeToPipeline(taskType) { ... }

module.exports = { SYSTEM_MARKER, classifyWithConfidence, extractExplicitPipeline, isSystemFeedback, mapTaskTypeToPipeline };
```

**pipeline-controller.js classify()（~140 行）**

刪除項：
- COMPLETE 30s 冷卻（原因：system-feedback 偵測已足夠攔截 stop hook reason）
- cancelled 抑制的「非顯式分類」分支（原因：不再有 heuristic 誤觸發）
- stale 偵測中的複雜邏輯（簡化為：ACTIVE + 非顯式 = 靜默忽略；ACTIVE + 顯式 = 重設）

保留項：
- Barrier 超時巡檢（獨立於分類邏輯）
- 已分類 + 同一 pipeline 不重複
- 升降級判斷
- DAG 建立邏輯（template/custom）

新 systemMessage（`source === 'main-agent'` 路徑）：

```
你是 Pipeline 路由器。分析使用者需求，選擇最合適的工作流。

| Pipeline | 適用場景 | 使用方式 |
|----------|---------|---------|
| chat | 問答、研究、解釋、查詢、trivial | 直接回答，不呼叫 pipeline |
| fix | hotfix、一行修改、改設定/常量 | /vibe:pipeline [pipeline:fix] |
| quick-dev | bugfix + 補測試、小改動（2-5 檔案） | /vibe:pipeline [pipeline:quick-dev] |
| standard | 新功能（無 UI）、大重構 | /vibe:pipeline [pipeline:standard] |
| full | 新功能（含 UI） | /vibe:pipeline [pipeline:full] |
| test-first | TDD 工作流 | /vibe:pipeline [pipeline:test-first] |
| ui-only | 純 UI/樣式調整 | /vibe:pipeline [pipeline:ui-only] |
| review-only | 程式碼審查 | /vibe:pipeline [pipeline:review-only] |
| docs-only | 純文件更新 | /vibe:pipeline [pipeline:docs-only] |
| security | 安全修復 | /vibe:pipeline [pipeline:security] |

判斷原則：
- 偏向使用 pipeline（寧可多走品質流程也不要漏）
- 不確定時用 AskUserQuestion 問使用者選擇 pipeline
- 複合任務：分解後依序執行
```

**guard-rules.js**

```javascript
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskList', 'TaskGet',
  'AskUserQuestion',  // S1: Main Agent 不確定時可詢問使用者
]);
```

### 資料流

```
UserPromptSubmit
  ↓
task-classifier.js → ctrl.classify(sessionId, prompt)
  ↓
classifier.classifyWithConfidence(prompt)
  ├── Layer 1: [pipeline:xxx] → { source: 'explicit' }
  ├── system-feedback → { source: 'system', pipeline: 'none' }
  └── fallback → { source: 'main-agent', pipeline: 'none' }
  ↓
controller.classify():
  ├── source === 'explicit' → 建 DAG + systemMessage 委派指令
  ├── source === 'system' → return null（不輸出）
  └── source === 'main-agent' → systemMessage 注入 pipeline 選擇表
  ↓
Main Agent 收到 systemMessage:
  ├── 判斷為問答 → 直接回答（不呼叫 pipeline）
  ├── 判斷為編碼任務 → 呼叫 /vibe:pipeline [pipeline:xxx]
  └── 不確定 → AskUserQuestion（guard 放行）
```

### 優勢

1. **最小侵入性**：只刪 heuristic 規則，保留 system-feedback 防護層
2. **API 完全相容**：classifyWithConfidence 回傳格式不變，consumer 零修改
3. **回饋循環自然消失**：刪除 heuristic 後，stop hook reason 只會命中 system-feedback 或 main-agent，不再誤觸發 pipeline
4. **SYSTEM_MARKER 保留**：pipeline-check.js 和 task-guard.js 的引用不需修改

### 劣勢

1. **system-feedback 偵測仍是 regex**：emoji 前綴和英文通知模式仍靠正則，新的 hook 輸出格式可能漏接
2. **回饋循環防護 "可能" 不夠**：雖然理論上 system-feedback 已足夠，但刪除 30s 冷卻和 cancelled 抑制有小風險
3. **isSystemFeedback 單獨匯出**：新增 export 不是 breaking change，但增加了 API 表面積

---

## 方案 B：Aggressive Cleanup（激進清理 + 回饋防護重構）

### 核心思路

除了方案 A 的刪除項，進一步重構 controller.classify() 的回饋循環邏輯。將 system-feedback 偵測從 classifier.js 移到 controller.classify() 內部（因為它只有這一個消費端），讓 classifier.js 回歸純粹的「顯式提取」角色。

### 目錄樹

同方案 A，但 classifier.js 更精簡（~40 行）。

### 介面定義

**classifier.js（~40 行）**

```javascript
const SYSTEM_MARKER = '<!-- VIBE_SYSTEM -->';

function extractExplicitPipeline(prompt) { ... }  // 不變

// classifyWithConfidence 極簡化：只有 explicit + fallback
async function classifyWithConfidence(prompt) {
  if (!prompt?.trim()) return { pipeline: 'none', confidence: 0, source: 'fallback', matchedRule: 'empty' };
  const explicit = extractExplicitPipeline(prompt);
  if (explicit) return { pipeline: explicit, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' };
  return { pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' };
}

function mapTaskTypeToPipeline(taskType) { ... }

module.exports = { SYSTEM_MARKER, classifyWithConfidence, extractExplicitPipeline, mapTaskTypeToPipeline };
```

**pipeline-controller.js classify()**

system-feedback 偵測內嵌到 classify() 的最前端：

```javascript
async function classify(sessionId, prompt, options = {}) {
  // 系統回饋快篩（stop hook reason / emoji 前綴 / 系統通知）
  if (isSystemFeedback(prompt)) return { output: null };

  const result = await classifyWithConfidence(prompt);
  // ... 其餘邏輯
}

// 私有函式（不匯出）
function isSystemFeedback(prompt) {
  if (!prompt) return false;
  const t = prompt.trim();
  if (t.includes(SYSTEM_MARKER)) return true;
  if (/^[⛔⚠️✅🔄📋➡️📌📄]/.test(t)) return true;
  if (/^(Background task|Task .+ (completed|finished|failed)|Result from|Output from)/i.test(t)) return true;
  return false;
}
```

回饋循環防護進一步簡化：

```javascript
// ACTIVE → 只有顯式 [pipeline:xxx] 才允許重分類
if (ds.isActive(state) && result.source !== 'explicit') {
  return { output: null };
}

// CANCELLED → 只有顯式才允許重啟
if (state?.meta?.cancelled && result.source !== 'explicit') {
  return { output: null };
}

// COMPLETE → 直接重設（不需冷卻期）
if (state && ds.isComplete(state)) {
  state = result.source === 'explicit' ? ds.resetKeepingClassification(state) : ds.reset(state);
  ds.writeState(sessionId, state);
}
```

### 資料流

同方案 A，但 system-feedback 檢查移到 controller 層（在呼叫 classifyWithConfidence 之前）。

### 優勢

1. **classifier.js 極簡**：~40 行，職責單一（顯式提取 + fallback），易於理解和測試
2. **回饋防護集中**：所有防護邏輯在 controller.classify() 一個函式內，不分散到 classifier
3. **刪除 30s 冷卻 + stale 偵測**：system-feedback 快篩在最前端，stop hook reason 永遠不會到達分類邏輯
4. **isSystemFeedback 不匯出**：不增加 API 表面積

### 劣勢

1. **測試需要 mock controller**：isSystemFeedback 是私有函式，無法直接單元測試；需要透過 classify() 的整合測試間接驗證
2. **回饋防護安全性**：刪除 30s 冷卻有理論風險 -- 若 stop hook reason 文字不含 SYSTEM_MARKER 且不以 emoji 開頭，會被分類為 main-agent
3. **SYSTEM_MARKER 匯出位置**：仍從 classifier.js 匯出（pipeline-check.js / task-guard.js 依賴），語意上是否合適？

---

## 方案 C：Split Module（拆分模組 + system-feedback 獨立）

### 核心思路

將 SYSTEM_MARKER 和 isSystemFeedback 提取到獨立的 `system-marker.js` 模組，讓 classifier.js / pipeline-controller.js / pipeline-check.js / task-guard.js 都從同一處引用。

### 目錄樹

```
plugins/vibe/scripts/lib/flow/
├── system-marker.js         ← 新模組：SYSTEM_MARKER + isSystemFeedback()
├── classifier.js            ← ~40 行（同方案 B）
└── pipeline-controller.js   ← 引用 system-marker.js

plugins/vibe/scripts/hooks/
├── pipeline-check.js        ← 改引用 system-marker.js
└── task-guard.js            ← 改引用 system-marker.js
```

### 優勢

1. **語意最清晰**：SYSTEM_MARKER 不再綁定在 classifier.js 中
2. **isSystemFeedback 可直接測試**：獨立匯出

### 劣勢

1. **新增檔案**：多一個模組維護
2. **修改引用路徑**：pipeline-check.js 和 task-guard.js 需要改 import
3. **過度設計**：SYSTEM_MARKER 只有 4 個消費者，獨立模組的價值不大

---

## 方案比較

| 面向 | 方案 A：Minimal Deletion | 方案 B：Aggressive Cleanup | 方案 C：Split Module |
|------|-------------------------|---------------------------|---------------------|
| 複雜度 | 低 | 中 | 中 |
| 可擴展性 | 中（isSystemFeedback 可獨立擴展） | 中（私有函式限制擴展） | 高（獨立模組） |
| 破壞性 | 最低（API 完全相容） | 低（刪 export 是 breaking） | 中（改 import 路徑） |
| 實作成本 | ~2 小時 | ~2.5 小時 | ~3 小時 |
| 測試成本 | 低（isSystemFeedback 可直接測試） | 中（需 mock controller） | 低（獨立模組直接測試） |
| 回饋循環安全性 | 高（保留 30s 冷卻可選） | 中（依賴 system-feedback 完整覆蓋） | 中（同 B） |
| classifier.js 行數 | ~80 | ~40 | ~40 |

## 決策

選擇方案 A：Minimal Deletion。

**原因**：

1. **最小破壞原則**：方案 A 的 API 完全向後相容。classifyWithConfidence 的回傳格式不變，只是 `source` 新增 `'system'` 值（但消費端只檢查 `'explicit'`，新值不影響）。
2. **isSystemFeedback 可測試**：作為 export 可直接單元測試，覆蓋 system-feedback 偵測的所有邊界情況。方案 B 將其藏為私有函式，反而增加測試難度。
3. **安全餘量**：保留 controller.classify() 中的 ACTIVE 忽略邏輯（非顯式 + ACTIVE = 靜默忽略），作為 system-feedback 遺漏時的安全網。方案 B 完全依賴 system-feedback 覆蓋率。
4. **SYSTEM_MARKER 位置不動**：4 個消費者的 import 路徑不變，零 breaking change。方案 C 的新模組在此階段過度設計（只有 4 個消費者）。
5. **回饋循環簡化足夠安全**：
   - 30s 冷卻可以安全刪除：stop hook reason 都以 SYSTEM_MARKER 前綴（pipeline-check.js L36）或 emoji 開頭（task-guard.js L106, L133），必定被 isSystemFeedback 攔截。
   - cancelled 抑制可以簡化：刪除 heuristic 後，非顯式分類只有 `main-agent`（pipeline: 'none'），不會建 DAG，所以即使通過也只是注入 systemMessage，不會啟動 pipeline。
   - stale 偵測保留但簡化：只用於 ACTIVE 狀態的顯式重分類場景。

### 刪除項安全性分析

| 刪除項 | 安全性 | 理由 |
|--------|--------|------|
| QUESTION_PATTERNS | 安全 | Main Agent 有完整 context，比 regex 判斷更準確 |
| FILE_PATH_PATTERN | 安全 | 只被 question 規則的負面排除引用 |
| HEURISTIC_RULES 6 條 | 安全 | 所有使用者意圖分類交由 Main Agent |
| classifyByHeuristic() | 安全 | 被 HEURISTIC_RULES 刪除連帶刪除 |
| buildPipelineCatalogHint() | 安全 | pipeline 清單直接內嵌到新 systemMessage |
| PRIORITY_ORDER / CATALOG_WINDOW | 安全 | buildPipelineCatalogHint 專用常量 |
| 30s 冷卻 | 安全 | stop hook reason 以 SYSTEM_MARKER 前綴，isSystemFeedback 攔截 |
| cancelled 非顯式抑制 | **需保留簡化版** | 防止 cancelled state 被 main-agent fallback 重設 |

### 修改項

| 修改項 | 說明 |
|--------|------|
| classifyWithConfidence() | 新增 system-feedback 判斷（在 explicit 之後、main-agent 之前） |
| controller.classify() source='main-agent' 路徑 | systemMessage 從 8 條決策表改為 10 行表格 |
| controller.classify() COMPLETE 路徑 | 刪除 30s 冷卻，直接 reset |
| controller.classify() CANCELLED 路徑 | 簡化：cancelled + source !== 'explicit' + pipelineId !== 'none' → return null |
| guard-rules.js READ_ONLY_TOOLS | 新增 'AskUserQuestion' |

## 風險與取捨

### 風險 1：Main Agent 仍不聽 systemMessage

**可能性**：中。即使 systemMessage 用更簡潔的表格格式，Main Agent（Sonnet 或 Opus）仍可能直接回答而非選擇 pipeline。

**緩解**：
- systemMessage 使用 `你是 Pipeline 路由器` 的角色設定（比 `Pipeline 自主分類：根據任務性質選擇 pipeline` 更強制）
- pipeline-guard 在 Relay 模式仍阻擋 Main Agent 直接寫碼，形成硬約束
- 新增 `不確定時用 AskUserQuestion` 提供第三選項（避免模型在 "直接回答" 和 "選 pipeline" 之間猶豫）

### 風險 2：AskUserQuestion 白名單被濫用

**可能性**：低。AskUserQuestion 是互動工具，不寫檔、不執行指令。

**緩解**：
- AskUserQuestion 有獨立的 PreToolUse(AskUserQuestion) hook（remote-hub ask-intercept），已有監控
- 若 Main Agent 過度使用 AskUserQuestion，可以在 pipeline-guard 加頻率限制（S2 議題）

### 風險 3：system-feedback 遺漏

**可能性**：低。目前所有 stop hook reason 都以 SYSTEM_MARKER 前綴。

**緩解**：
- 保留 emoji 前綴偵測作為第二層防護
- 保留英文通知模式偵測作為第三層防護
- controller.classify() 的 ACTIVE 忽略邏輯作為安全網（即使 system-feedback 遺漏，ACTIVE 狀態下的非顯式分類仍被忽略）

### 風險 4：測試大量重寫

**可能性**：確定。classifier-and-console-filter.test.js 有 ~167 個測試案例，其中 Part 1b-2 到 1b-6 全部與 heuristic 相關。

**緩解**：
- 刪除 heuristic 相關測試（~70 個），新增 isSystemFeedback 和新 systemMessage 測試（~20 個）
- 保留 Part 1a（extractExplicitPipeline）和 Part 1c（fallback）測試
- pipeline-catalog-integration.test.js 影響較小（主要測試 registry 常量和 Layer 1 顯式覆寫）

## 遷移計畫

### Phase 1：classifier.js 簡化（最高優先）

1. 新增 `isSystemFeedback()` 函式
2. 簡化 `classifyWithConfidence()`（3 層 → explicit + system-feedback + main-agent）
3. 刪除 HEURISTIC_RULES / classifyByHeuristic / buildPipelineCatalogHint / QUESTION_PATTERNS / FILE_PATH_PATTERN / PRIORITY_ORDER / CATALOG_WINDOW
4. 更新 module.exports（刪除 classifyByHeuristic / buildPipelineCatalogHint，新增 isSystemFeedback）

### Phase 2：pipeline-controller.js classify() 簡化

1. 刪除 `buildPipelineCatalogHint` import
2. 簡化 COMPLETE 路徑（刪除 30s 冷卻）
3. 簡化 CANCELLED 路徑
4. 新增 `source === 'system'` 快速返回（isSystemFeedback 匹配 → return null）
5. 替換 `source === 'main-agent'` 路徑的 systemMessage（新 pipeline 選擇表）

### Phase 3：guard-rules.js AskUserQuestion 白名單

1. `READ_ONLY_TOOLS` 新增 `'AskUserQuestion'`

### Phase 4：測試更新

1. 刪除 classifier-and-console-filter.test.js 的 heuristic 相關測試
2. 新增 isSystemFeedback 單元測試
3. 新增 classifyWithConfidence 簡化版測試
4. 新增 AskUserQuestion guard 放行測試
5. 調整 pipeline-catalog-integration.test.js 的預期

### Phase 5：驗證

1. 執行全部測試確認通過
2. E2E 驗證：Main Agent 收到 systemMessage 後正確選擇 pipeline
3. E2E 驗證：Main Agent 不確定時使用 AskUserQuestion
4. 回歸驗證：stop hook reason 不觸發 pipeline
