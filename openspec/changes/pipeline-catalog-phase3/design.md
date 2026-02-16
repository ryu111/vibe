# 架構設計：Pipeline Catalog Phase 3 -- 分類智慧化升級

## 現有結構分析

### 目錄結構概覽

```
plugins/vibe/scripts/
├── lib/
│   ├── registry.js            ← PIPELINES/PIPELINE_PRIORITY/TASKTYPE_TO_PIPELINE
│   ├── flow/
│   │   └── classifier.js      ← 三層級聯分類器（classify/classifyWithConfidence/classifyWithLLM）
│   └── timeline/
│       ├── schema.js           ← 23 種 EVENT_TYPES + CATEGORIES
│       └── formatter.js        ← formatEventText/formatTimeline（三模式）
├── hooks/
│   └── task-classifier.js      ← UserPromptSubmit hook（emit TASK_CLASSIFIED）
plugins/vibe/skills/
├── cancel/SKILL.md             ← 取消鎖定 + 語料蒐集
├── pipeline/SKILL.md           ← Pipeline 模板路由知識
plugins/vibe/web/
└── index.html                  ← Dashboard runtime UI（Timeline 事件面板）
plugins/vibe/server.js          ← Dashboard server（formatEvent → WebSocket 推送）
```

### 關鍵模式與慣例

1. **classifier.js 純函式模組**：不讀寫 state file，只做分類計算。state 管理由 task-classifier.js hook 負責
2. **classifyWithConfidence 回傳結構**：`{ pipeline, confidence, source }` -- Phase 3 新增 `matchedRule`
3. **emit payload 結構**：`{ pipelineId, taskType, expectedStages, reclassified, [from] }` -- Phase 3 擴充 layer/confidence/source/matchedRule
4. **formatter.js formatEventText switch/case**：每種 EVENT_TYPE 一個 case，回傳格式化字串
5. **cancel SKILL.md 是 Reference skill**：由 Claude 直接執行（不 fork sub-agent），有 Read/Write 工具權限
6. **pipeline SKILL.md 是 Reference skill**：純知識展示，不觸發 pipeline
7. **command hook 進程隔離**：每次 UserPromptSubmit 是獨立 Node.js 進程，module-level 變數不跨呼叫
8. **~/.claude/ 檔案慣例**：session 隔離用 `{name}-{sessionId}.json`，全域共享用 `{name}.json`

### 介面邊界

- **classifier.js <-> task-classifier.js**：`classifyWithConfidence()` 回傳 `{ pipeline, confidence, source }` + `classifyWithLLM()` 回傳 `Promise<{pipeline, confidence, source}|null>`
- **task-classifier.js <-> timeline**：`emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, data)` 寫入 JSONL
- **timeline/schema.js <-> formatter.js**：EVENT_TYPES 常量 + createEnvelope 結構
- **server.js <-> formatter.js**：`formatEventText(event)` 取得文字描述
- **server.js <-> web/index.html**：WebSocket 推送 `{ type: 'timeline', sessionId, event: { time, ts, type, cat, emoji, text, eventType } }`
- **cancel SKILL.md <-> classifier-corpus.jsonl**：Write 工具追加 JSONL

## 方案 A：最小增量擴充（推薦）

在現有模組上做最小增量修改，不新增檔案、不拆分模組。

### 目錄樹

```
plugins/vibe/scripts/lib/flow/classifier.js     ← MODIFIED: +matchedRule +getAdaptiveThreshold
plugins/vibe/scripts/hooks/task-classifier.js    ← MODIFIED: emit payload 擴充 +correctionCount reset
plugins/vibe/scripts/lib/timeline/formatter.js   ← MODIFIED: task.classified 格式化升級
plugins/vibe/skills/cancel/SKILL.md              ← MODIFIED: +分類錯誤回饋流程
plugins/vibe/skills/pipeline/SKILL.md            ← MODIFIED: +互動式選擇器模式
~/.claude/classifier-stats.json                  ← NEW (runtime): 全域分類統計
```

### 介面定義

#### classifier.js 擴充

```typescript
// classifyWithConfidence 回傳值新增 matchedRule
interface ClassificationResult {
  pipeline: string;
  confidence: number;
  source: 'explicit' | 'regex' | 'pending-llm' | 'llm' | 'llm-cached' | 'regex-low';
  matchedRule: string;  // NEW: 'explicit' | 'strong-question' | 'trivial' | 'weak-explore' | 'action:{type}' | 'default'
}

// 新增函式
function getAdaptiveThreshold(): number;
// 讀取 ~/.claude/classifier-stats.json
// Layer 2 修正率 > 30% → 0.5；否則 → 0.7
// VIBE_CLASSIFIER_THRESHOLD 環境變數最高優先
```

#### task-classifier.js emit payload 擴充

```typescript
// TASK_CLASSIFIED event data（擴充）
interface TaskClassifiedData {
  pipelineId: string;
  taskType: string;
  expectedStages: string[];
  reclassified: boolean;
  from?: string;
  // NEW fields:
  layer: 1 | 2 | 3;         // 哪一層分類器決定的
  confidence: number;         // 分類信心度
  source: string;             // explicit/regex/llm/llm-cached/regex-low
  matchedRule: string;         // 命中的具體規則
}
```

#### classifier-stats.json 格式

```typescript
interface ClassifierStats {
  totalClassifications: number;    // 累計分類次數
  corrections: {
    total: number;                 // 總修正次數
    byLayer: { 1: number, 2: number, 3: number };  // 各層被修正次數
    bySource: { regex: number, llm: number };       // 各來源被修正次數
  };
  recentWindow: Array<{            // 最近 50 次分類記錄（滑動窗口）
    timestamp: string;
    layer: number;
    source: string;
    corrected: boolean;
  }>;
}
```

#### classifier-corpus.jsonl 格式升級

```typescript
// 現有格式（保留向後相容）
interface CorpusEntryLegacy {
  prompt: string;
  actual: string;      // taskType
  cancelled: boolean;
  completedStages: string[];
  timestamp: string;
}

// 擴充格式
interface CorpusEntryV2 extends CorpusEntryLegacy {
  expectedPipeline?: string;    // 使用者選擇的正確 pipeline
  layer?: number;               // 原始分類的 Layer
  confidence?: number;          // 原始信心度
  source?: string;              // 原始 source
  matchedRule?: string;         // 命中的規則
  reason?: 'wrong-classification' | 'no-pipeline' | 'other';  // 取消原因
}
```

### 資料流

#### Phase 1: Classification Analytics

```
使用者輸入 → task-classifier.js
  → classifyWithConfidence(prompt)
    → Layer 1: extractExplicitPipeline → matchedRule='explicit'
    → Layer 2: classify(prompt) → matchedRule='strong-question'/'trivial'/'weak-explore'/'action:{type}'/'default'
    → Layer 3: pending-llm → matchedRule 保留 Layer 2 的值
  → emit(TASK_CLASSIFIED, { ...existing, layer, confidence, source, matchedRule })
  → formatter.js formatEventText → "分類=standard L2(0.80) [action:feature]"
  → server.js formatEvent → WebSocket → Dashboard UI
```

#### Phase 2: Correction Loop

```
使用者 /cancel → cancel SKILL.md
  → AskUserQuestion: "為什麼取消？"
    (a) 分類錯誤 → AskUserQuestion: "正確的 pipeline？"
        → 選擇 pipeline → 寫入 corpus + stats
    (b) 不需要 pipeline → 現有行為
    (c) 其他原因 → 現有行為
  → 寫入 ~/.claude/classifier-stats.json
  → 更新 pipeline-state correctionCount
```

#### Phase 3: Adaptive Confidence

```
task-classifier.js → classifyWithConfidence()
  → getAdaptiveThreshold()
    → 讀取 ~/.claude/classifier-stats.json
    → 計算最近 50 次 Layer 2 修正率
    → 修正率 > 30% → threshold=0.5
    → 否則 → threshold=0.7
    → VIBE_CLASSIFIER_THRESHOLD 覆寫一切
  → confidence < threshold → pending-llm
```

### 優勢

- **最少新增檔案**：不新增 runtime 腳本，只修改現有模組。`classifier-stats.json` 是 runtime 檔案，不入 repo
- **介面向後相容**：`classifyWithConfidence` 新增 `matchedRule` 是純增量，現有消費端不受影響
- **cancel SKILL.md 直接執行**：不需新增 hook 或 script，Reference skill 有 Read/Write 工具權限
- **進程隔離友善**：`getAdaptiveThreshold()` 每次呼叫都讀檔案，不依賴模組級快取

### 劣勢

- **classifier.js 職責擴張**：加入 `getAdaptiveThreshold()` 後，classifier 從「純分類」變成「分類+閾值管理」
- **cancel SKILL.md 複雜度增加**：AskUserQuestion 流程 + corpus 寫入 + stats 寫入，SKILL.md 行數可能接近字元預算
- **classifier-stats.json 無清理機制**：跨 session 累積，需要 `/vibe:health` 提供重設選項（但不在 Phase 3 範圍內）

## 方案 B：Stats 模組抽離

將分類統計和自適應閾值邏輯抽離為獨立模組 `scripts/lib/flow/classifier-stats.js`。

### 目錄樹

```
plugins/vibe/scripts/lib/flow/classifier.js         ← MODIFIED: +matchedRule，閾值邏輯改呼叫 stats 模組
plugins/vibe/scripts/lib/flow/classifier-stats.js    ← NEW: 統計讀寫 + getAdaptiveThreshold + recordCorrection
plugins/vibe/scripts/hooks/task-classifier.js        ← MODIFIED: emit payload 擴充
plugins/vibe/scripts/lib/timeline/formatter.js       ← MODIFIED: task.classified 格式化
plugins/vibe/skills/cancel/SKILL.md                  ← MODIFIED: +分類錯誤回饋（呼叫 stats 描述）
plugins/vibe/skills/pipeline/SKILL.md                ← MODIFIED: +互動式選擇器
```

### 介面定義

#### classifier-stats.js（新模組）

```typescript
// 讀取統計
function readStats(): ClassifierStats;

// 記錄一次修正
function recordCorrection(correction: {
  prompt: string;
  originalPipeline: string;
  expectedPipeline: string;
  layer: number;
  source: string;
  matchedRule: string;
}): void;

// 記錄一次分類（供滑動窗口追蹤）
function recordClassification(entry: {
  layer: number;
  source: string;
  corrected: boolean;
}): void;

// 取得自適應閾值
function getAdaptiveThreshold(): number;

module.exports = { readStats, recordCorrection, recordClassification, getAdaptiveThreshold };
```

### 資料流

與方案 A 相同，但 stats 操作集中在 `classifier-stats.js` 模組。

### 優勢

- **職責清晰**：classifier.js 專注分類、classifier-stats.js 專注統計，符合 Single Responsibility
- **可測試性**：stats 模組可獨立單元測試（mock fs）
- **cancel SKILL.md 更簡潔**：只描述呼叫流程，不內嵌 stats 邏輯

### 劣勢

- **新增檔案**：多一個 `classifier-stats.js`，需更新 CLAUDE.md scripts 數量（42→43）+ `plugin-specs.json` + `docs/ref/vibe.md`
- **cancel SKILL.md 無法直接呼叫 JS 模組**：Reference skill 由 Claude 執行，需要用 Read/Write 工具操作 JSON 檔案，不能直接 import classifier-stats.js
- **過度工程風險**：stats 模組的唯一消費者是 classifier.js 的 `getAdaptiveThreshold()` 和 cancel SKILL.md 的 JSON 操作

## 方案比較

| 面向 | 方案 A（最小增量） | 方案 B（Stats 模組抽離） |
|------|:--:|:--:|
| 複雜度 | 低 | 中 |
| 可擴展性 | 中（未來可再拆分） | 高 |
| 破壞性 | 低（純增量） | 低（純增量 + 1 新檔案） |
| 實作成本 | 2-3 小時 | 3-4 小時 |
| 新增檔案數 | 0 | 1 |
| 文件同步成本 | 低 | 中（scripts 數量 +1） |
| cancel SKILL.md 實作 | 直接用 Read/Write 操作 JSON | 同左（Reference skill 限制） |
| 測試隔離 | 中（classifier.js 內部函式） | 高（獨立模組可 mock） |

## 決策

選擇**方案 A（最小增量擴充）**，原因：

1. **cancel SKILL.md 是 Reference skill**：無論哪個方案，SKILL.md 都只能用 Read/Write 工具操作 `classifier-stats.json`，不能直接 import JS 模組。因此新增 `classifier-stats.js` 模組的主要好處（封裝 stats 操作）在 cancel 場景下無法利用
2. **單一消費者不需過早抽離**：`getAdaptiveThreshold()` 目前只有 `classifyWithConfidence()` 一個消費者，遵循「最小增量 > 過度設計」原則（Phase 2 設計慣例）
3. **零文件同步成本**：不新增 runtime 腳本，不需更新 CLAUDE.md scripts 數量、plugin-specs.json、vibe.md 等文件鏈
4. **未來可拆分**：如果 Phase 4 需要更複雜的統計邏輯（如連續自適應、時間衰減），再將 `getAdaptiveThreshold()` 和相關邏輯提取為獨立模組

## 風險與取捨

### 設計風險

1. **cancel SKILL.md 字元預算**：新增 AskUserQuestion 流程 + pipeline 選擇 + corpus/stats 寫入指引，估計增加 2000-3000 字元。目前 SKILL.md 約 2500 字元，擴充後約 5000-5500 字元，仍在 15,000 字元預算內
2. **classifier-stats.json 損壞容錯**：`getAdaptiveThreshold()` 讀取失敗時必須 fallback 到預設值 0.7，不可因 JSON parse error 中斷分類流程
3. **滑動窗口大小**：50 次太少可能導致閾值頻繁切換，太多可能延遲自適應。建議從 50 開始，可通過環境變數 `VIBE_CLASSIFIER_WINDOW` 調整（Phase 3 暫不實作環境變數，硬編碼 50）
4. **AskUserQuestion 在 pipeline 外**：cancel SKILL.md 會先解除 `pipelineEnforced=false`，之後 AskUserQuestion 不會被 pipeline-guard 攔截。但如果 cancel 執行到一半失敗（解除了 pipelineEnforced 但未完成 AskUserQuestion），pipeline 狀態會不一致
5. **formatter 格式變更**：`task.classified` 的顯示格式從 `"分類=feature, 預期階段=[...]"` 變為 `"分類=standard L2(0.80) [action:feature]"`，Dashboard 和 Remote 的顯示會同步變更

### 取捨

- **兩檔位 vs 連續自適應**：選擇兩檔位（0.7/0.5）避免過度工程。連續自適應需要更複雜的數學模型（如 exponential moving average），且調試困難
- **cancel 回饋 vs 自動學習**：選擇手動回饋（使用者明確選擇正確 pipeline）而非自動從行為推斷（如觀察使用者在取消後的操作）。前者更可靠但依賴使用者參與
- **全域 stats vs session 隔離 stats**：選擇全域 `~/.claude/classifier-stats.json`（跨 session 累積），因為自適應需要足夠的歷史資料。代價是測試環境可能汙染生產統計

## 遷移計畫

### Phase 1: Classification Analytics

1. classifier.js `classifyWithConfidence()` 回傳值新增 `matchedRule` 欄位
2. task-classifier.js 兩處 emit 呼叫擴充 `layer`/`confidence`/`source`/`matchedRule`
3. formatter.js `task.classified` case 格式化升級
4. 驗證：現有 222+ classifier 測試全通過 + formatter 測試更新

### Phase 2: Correction Loop

1. cancel SKILL.md 新增 AskUserQuestion 三選項 + 正確 pipeline 選擇
2. classifier-corpus.jsonl 格式升級（新增欄位，向後相容）
3. 新增 `~/.claude/classifier-stats.json` 寫入邏輯（由 cancel SKILL.md 指引 Claude 執行）
4. task-classifier.js `resetPipelineState()` 新增 `correctionCount` 清除
5. 驗證：`/cancel` 手動測試三種路徑

### Phase 3: Adaptive Confidence

1. classifier.js 新增 `getAdaptiveThreshold()` 函式
2. `classifyWithConfidence()` 整合 `getAdaptiveThreshold()`（取代靜態 `LLM_CONFIDENCE_THRESHOLD`）
3. 驗證：adaptive threshold 單元測試 + 手動測試修正率觸發閾值切換

### Phase 4: Pipeline Template Selection UX

1. pipeline SKILL.md 升級為雙模式（無參數=互動式選擇器 / 有參數=現有行為）
2. 驗證：V-SK 驗證腳本通過

### Phase 5: 收尾

1. Phase 2 歸檔（pipeline-catalog → archive/2026-02-16-pipeline-catalog-phase2/）
2. Delta specs 合併到 openspec/specs/
3. 全面回歸測試 + 版號更新
