# 架構設計：DESIGN 階段導入 Pipeline

## 現有結構分析

### 目錄結構概覽

Pipeline 的核心元件分佈在以下位置：

```
plugins/vibe/
├── scripts/lib/registry.js           ← STAGES/STAGE_ORDER 定義（Single Source of Truth）
├── pipeline.json                      ← stages 順序 + provides 映射
├── scripts/hooks/
│   ├── stage-transition.js            ← SubagentStop: 前進/回退/跳過 路由
│   ├── task-classifier.js             ← UserPromptSubmit: 分類 + STAGE_MAPS
│   ├── pipeline-init.js               ← SessionStart: 環境偵測 + state 初始化
│   ├── pipeline-guard.js              ← PreToolUse: 硬阻擋（state 驅動）
│   └── pipeline-check.js              ← Stop: 遺漏階段檢查
├── scripts/lib/
│   ├── flow/
│   │   ├── pipeline-discovery.js      ← 動態發現 pipeline 配置
│   │   ├── env-detector.js            ← 專案環境偵測（語言/框架/工具）
│   │   ├── uiux-resolver.js           ← ui-ux-pro-max 路徑偵測
│   │   └── classifier.js             ← 兩階段級聯分類器
│   └── sentinel/guard-rules.js        ← pipeline-guard 規則模組（純函式）
├── agents/
│   ├── designer.md                    ← 設計 agent（目前只有獨立模式）
│   └── architect.md                   ← 架構 agent（含前端設計整合區塊）
└── skills/design/SKILL.md             ← /vibe:design 入口
```

### 關鍵模式與慣例

1. **registry.js 是 STAGES 的 Single Source of Truth** -- `STAGE_ORDER = Object.keys(STAGES)`，物件 key 插入順序決定階段順序
2. **pipeline.json 宣告 stages + provides** -- `pipeline-discovery.js` 動態讀取，不依賴 registry
3. **stage-transition 智慧跳過模式** -- 純 API 專案跳過 E2E 的邏輯已有先例（`API_ONLY_FRAMEWORKS` + `isApiOnly`）
4. **STAGE_MAPS 靜態定義** -- task-classifier 中的 `STAGE_MAPS.feature` 是靜態陣列
5. **pipeline-guard 是 state 驅動** -- 讀取 `pipelineEnforced` + `delegationActive`，不硬編碼 stage 名稱
6. **env-detector 框架偵測** -- 已有前端/後端框架分類，`FRONTEND_FRAMEWORKS` 定義在 task-classifier

### 介面邊界

- **registry.js** <-> **pipeline.json**：兩者獨立定義 STAGES，需保持同步
- **stage-transition** <-> **pipeline-discovery**：前者呼叫後者的 `findNextStage()` 尋找下一階段
- **task-classifier** <-> **pipeline-init**：pipeline-init 寫入 `state.environment`，task-classifier 讀取判斷 expectedStages
- **designer.md** <-> **architect.md**：目前 architect 兼任 design-system 產出（Layer 2），需拆分

---

## 方案 A：跳過驅動（Skip-driven）

以 stage-transition 的跳過邏輯為核心。DESIGN 永遠存在於 STAGE_ORDER 中，但由 stage-transition 根據環境偵測決定是否跳過。

### 目錄樹

```
plugins/vibe/
├── scripts/lib/registry.js            ← 修改：新增 DESIGN entry
├── pipeline.json                      ← 修改：stages 插入 DESIGN + provides
├── scripts/hooks/
│   ├── stage-transition.js            ← 修改：DESIGN 跳過邏輯 + context 注入
│   └── task-classifier.js             ← 修改：STAGE_MAPS.feature 加入 DESIGN
├── agents/
│   ├── designer.md                    ← 修改：新增 Pipeline 模式區塊
│   └── architect.md                   ← 修改：移除前端設計整合區塊
└── openspec/schemas/vibe-pipeline/
    └── schema.yaml                    ← 修改：新增 design-system artifact
```

### 介面定義

**registry.js 新增 DESIGN entry：**

```js
const STAGES = {
  PLAN:   { agent: 'planner',    emoji: '\u{1F4CB}', label: '規劃',   color: 'purple' },
  ARCH:   { agent: 'architect',  emoji: '\u{1F3D7}\uFE0F', label: '架構', color: 'cyan' },
  DESIGN: { agent: 'designer',   emoji: '\u{1F3A8}', label: '設計',   color: 'cyan' },
  DEV:    { agent: 'developer',  emoji: '\u{1F4BB}', label: '開發',   color: 'yellow' },
  // ... 後續不變
};
```

**pipeline.json 新增 DESIGN：**

```json
{
  "stages": ["PLAN", "ARCH", "DESIGN", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "provides": {
    "DESIGN": { "agent": "designer", "skill": "/vibe:design" }
  }
}
```

**stage-transition 跳過邏輯：**

```js
// FRONTEND_FRAMEWORKS 提取為共用常量
const FRONTEND_FRAMEWORKS = ['next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular'];

// 在智慧跳過 while loop 中新增：
if (nextStageCandidate === 'DESIGN') {
  const needsDesign = state.needsDesign === true;
  const isFrontend = FRONTEND_FRAMEWORKS.includes(frameworkName);
  if (!needsDesign && !isFrontend) {
    skippedStages.push('DESIGN（純後端/CLI 專案不需視覺設計）');
    nextStageCandidate = findNextStage(...);
    continue;
  }
}
```

### 資料流

```
ARCH 完成 → SubagentStop 觸發 stage-transition
  │
  ├─ 前端專案（React/Vue/...）或 needsDesign=true
  │   → systemMessage: "⛔ [Pipeline] architect -> DESIGN（設計）"
  │   → designer agent 執行
  │   → 產出 design-system.md + design-mockup.html
  │   → SubagentStop → stage-transition → DEV
  │
  └─ 後端專案（Express/Fastify/...）且 needsDesign=false
      → skippedStages: ["DESIGN（純後端/CLI 專案不需視覺設計）"]
      → 直接路由到 DEV
```

### 優勢

- **最小變更**：跟 E2E 跳過邏輯完全一致的模式，開發者熟悉
- **pipeline-guard / pipeline-check / pipeline-init 零修改**：全部由 state 驅動，自動適配
- **回退相容**：品質階段回退到 DEV 時，DESIGN 不受影響（已在 DEV 之前完成）

### 劣勢

- **STAGE_MAPS.feature 靜態包含 DESIGN**：後端專案的 expectedStages 包含 DESIGN，但會被跳過。pipeline-check 比對 missing 時需正確排除被跳過的階段（但 pipeline-check 目前比對的是 `pipeline.stageMap[s]` 是否存在，DESIGN 會一直存在）
- **後端專案 pipeline-check 可能報 DESIGN 缺漏**：需要額外處理

---

## 方案 B：分類驅動（Classify-driven）

以 task-classifier 為核心。task-classifier 根據環境偵測結果動態決定 expectedStages 是否包含 DESIGN。stage-transition 只負責順序前進，不做 DESIGN 特殊跳過。

### 目錄樹

與方案 A 相同。

### 介面定義

**task-classifier STAGE_MAPS 改為動態函式：**

```js
// STAGE_MAPS.feature 改為函式
function getFeatureStages(envInfo) {
  const base = ['PLAN', 'ARCH'];
  const framework = envInfo?.framework?.name;
  const isFrontend = FRONTEND_FRAMEWORKS.includes(framework);
  const hasDesignSystem = envInfo?.tools?.designSystem;
  if (isFrontend || hasDesignSystem) {
    base.push('DESIGN');
  }
  base.push('DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS');
  return base;
}
```

**stage-transition 不需 DESIGN 跳過邏輯** -- 如果 expectedStages 不含 DESIGN，`findNextStage` 自然跳過（因為 stageMap 中 DESIGN 存在但 expectedStages 不含）。

等等 -- 但 `findNextStage` 是基於 `stageOrder` + `stageMap` 的，不參考 `expectedStages`。也就是說，即使 expectedStages 不含 DESIGN，stage-transition 的 `findNextStage` 仍然會路由到 DESIGN。

這意味著方案 B 要麼需要修改 `findNextStage` 讓它參考 expectedStages，要麼需要修改 stage-transition 的前進邏輯加入 expectedStages 過濾。

### 修正：stage-transition 參考 expectedStages

```js
// 在智慧跳過 while loop 中新增通用規則：
if (!state.expectedStages.includes(nextStageCandidate)) {
  skippedStages.push(`${nextStageCandidate}（不在預期階段中）`);
  nextStageCandidate = findNextStage(...);
  continue;
}
```

### 資料流

```
pipeline-init → env-detect → state.environment
  │
  ▼
task-classifier → classify('feature')
  │
  ├─ 前端專案 → expectedStages 含 DESIGN
  └─ 後端專案 → expectedStages 不含 DESIGN
  │
  ▼
ARCH 完成 → stage-transition → findNextStage → DESIGN
  │
  ├─ expectedStages 含 DESIGN → 正常路由
  └─ expectedStages 不含 DESIGN → 跳過
```

### 優勢

- **語意清晰**：expectedStages 精確反映專案需要的階段
- **pipeline-check 自動正確**：比對 expectedStages vs completed，不含 DESIGN 就不會報缺漏
- **通用跳過機制**：`expectedStages` 過濾可復用於未來新增的可選階段

### 劣勢

- **task-classifier 複雜度增加**：STAGE_MAPS.feature 從靜態常量變為函式，依賴環境偵測結果
- **時序依賴**：task-classifier 需要讀取 `state.environment`（由 pipeline-init 寫入），兩者的執行順序已保證（SessionStart 先於 UserPromptSubmit），但增加了耦合
- **stage-transition 新增通用跳過規則**：修改核心路由邏輯，需要更多測試覆蓋
- **STAGE_MAPS 動態化影響升級邏輯**：重新分類（research → feature）時需重新計算 expectedStages

---

## 方案 C：混合驅動（Hybrid）

結合方案 A 和 B 的優點。`STAGE_MAPS.feature` 保持靜態包含全部 9 階段（含 DESIGN），跳過邏輯集中在 `stage-transition`，但新增 `state.skippedStages` 陣列讓 `pipeline-check` 正確排除。

### 目錄樹

與方案 A 相同。

### 介面定義

**STAGE_MAPS.feature 靜態含 DESIGN：**

```js
const STAGE_MAPS = {
  feature: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
  // ...
};
```

**stage-transition 跳過時記錄到 state：**

```js
// 跳過邏輯（統一的模式）
if (!state.skippedStages) state.skippedStages = [];

if (nextStageCandidate === 'DESIGN' && !needsDesign && !isFrontend) {
  skippedStages.push('DESIGN（純後端/CLI 專案不需視覺設計）');
  state.skippedStages.push('DESIGN');
  nextStageCandidate = findNextStage(...);
  continue;
}

if (nextStageCandidate === 'E2E' && isApiOnly) {
  skippedStages.push('E2E（純 API 專案不需瀏覽器測試）');
  state.skippedStages.push('E2E');
  nextStageCandidate = findNextStage(...);
  continue;
}
```

**pipeline-check 排除已跳過的階段：**

```js
const skipped = state.skippedStages || [];
const missing = state.expectedStages.filter(s =>
  pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
);
```

### 資料流

```
task-classifier → STAGE_MAPS.feature（靜態 9 階段含 DESIGN）
  → expectedStages = ['PLAN', 'ARCH', 'DESIGN', 'DEV', ...]
  │
  ▼
ARCH 完成 → stage-transition
  │
  ├─ 前端專案 → DESIGN 正常路由
  └─ 後端專案 → DESIGN 被跳過 → state.skippedStages.push('DESIGN')
  │
  ▼
Stop → pipeline-check
  → missing = expectedStages - completed - skippedStages
  → DESIGN 不會被報為缺漏
```

### 優勢

- **最一致的模式**：E2E 跳過邏輯可統一改用 `state.skippedStages`，兩處跳過邏輯完全一致
- **STAGE_MAPS 保持靜態**：不增加 task-classifier 複雜度
- **pipeline-check 精確**：透過 `skippedStages` 明確排除，不會誤報

### 劣勢

- **新增 state 欄位**：`skippedStages` 增加 state file 的複雜度
- **stage-transition 略微複雜**：跳過時需要同時更新 display 和 state
- **E2E 現有跳過邏輯需一併重構**：為保持一致性，應將 E2E 跳過也改用 `state.skippedStages`

---

## 方案比較

| 面向 | 方案 A（跳過驅動） | 方案 B（分類驅動） | 方案 C（混合） |
|------|-------------------|-------------------|---------------|
| 複雜度 | 低 -- 僅新增跳過條件 | 中 -- STAGE_MAPS 動態化 + stage-transition 通用跳過 | 中 -- 新增 skippedStages state |
| 可擴展性 | 低 -- 每增一個可選階段需加一段 if | 高 -- expectedStages 通用篩選 | 高 -- skippedStages 通用模式 |
| 破壞性 | 極低 -- pipeline-guard/init/check 零改 | 中 -- task-classifier 核心邏輯變更 | 低 -- pipeline-check 小改 |
| 實作成本 | 低（~2 小時） | 高（~4 小時） | 中（~3 小時） |
| pipeline-check 正確性 | 需額外處理 | 自動正確 | 自動正確 |
| 模式一致性 | 與 E2E 跳過一致 | 全新模式 | 統一 E2E + DESIGN 跳過 |
| 測試影響 | 最小 | 多處 hardcode 需改 | 中等 |

---

## 決策

**選擇方案 C（混合驅動）**，原因：

1. **STAGE_MAPS 保持靜態**：task-classifier 是高頻執行的 hook（每次 UserPromptSubmit），保持簡單至關重要
2. **pipeline-check 精確**：`skippedStages` 明確記錄跳過原因，避免誤報
3. **模式統一**：E2E 跳過邏輯可一併重構到 `state.skippedStages`，形成可復用的跳過模式
4. **pipeline-guard / pipeline-init 零修改**：這些核心安全機制完全由 state 驅動，不需感知 DESIGN 階段

方案 A 雖然最簡單，但 pipeline-check 的誤報問題需要 ad-hoc 修補，不夠優雅。方案 B 的 STAGE_MAPS 動態化改變了 task-classifier 的核心模式，風險較高。方案 C 取兩者之長，新增 `state.skippedStages` 是乾淨的架構擴展。

---

## 風險與取捨

### 風險 1：STAGES 物件 key 順序

**問題**：`STAGE_ORDER = Object.keys(STAGES)`，DESIGN 必須插入在 ARCH 和 DEV 之間。JS 物件 key 順序為插入順序，只要在原始碼中 DESIGN 定義在正確位置即可。

**緩解**：在 registry.js 中加註釋標記順序重要性。測試驗證 `STAGE_ORDER[2] === 'DESIGN'`。

### 風險 2：前端偵測覆蓋率

**問題**：`env-detector.js` 偵測 11 種框架（8 前端 + 3 後端）。如果專案使用的前端技術不在清單中（如 Qwik、Solid），DESIGN 階段會被跳過。

**緩解**：architect 可在 pipeline state 設定 `state.needsDesign = true` 作為備選觸發。同時在 design.md 中標記是否需要設計階段。

### 風險 3：現有測試 hardcode

**問題**：14 個測試檔案中有多處 hardcode「8 個」stage 映射（如 `pipeline-system.test.js` 的 `'agentToStage 包含 8 個短名稱映射'`）。

**緩解**：Phase 6 全面掃描並更新。測試改為從 registry.js 動態取得預期數量而非 hardcode。

### 風險 4：DESIGN 階段使用者確認

**問題**：proposal.md 待確認事項 #3 -- DESIGN 是否需要突破 pipeline 自動模式允許 AskUserQuestion？

**決策**：不需要。DESIGN 階段遵循 pipeline 自動模式（禁止 AskUserQuestion）。designer 產出 HTML mockup 後，stage-transition 自動前進到 DEV。使用者可在 pipeline 完成後回顧 mockup 並決定是否需要調整。若設計不滿足，品質階段（REVIEW/QA）會回退。

### 風險 5：designer agent model

**決策**：維持 sonnet。DESIGN 階段主要呼叫 search.py 工具產出設計系統，不需要 opus 的深度推理。sonnet 足夠處理框架偵測和結果格式化。

### 取捨

- **不做使用者確認**：犧牲了「使用者預覽後再繼續」的體驗，但保持了 pipeline 自動模式的一致性
- **needsDesign 備選機制**：增加了 state 的複雜度，但提供了靈活的逃生口
- **E2E 跳過邏輯重構**：額外工作量，但建立了可復用的跳過模式

---

## 遷移計畫

### Phase 1：核心定義
1. registry.js 新增 DESIGN entry（ARCH 和 DEV 之間）
2. pipeline.json 新增 DESIGN stage + provides

### Phase 2：路由邏輯
3. stage-transition.js 新增 DESIGN 跳過邏輯 + `state.skippedStages`
4. 統一 E2E 跳過邏輯到 `state.skippedStages` 模式
5. pipeline-check.js 排除 `state.skippedStages`

### Phase 3：Agent 更新
6. designer.md 新增 Pipeline 模式
7. architect.md 移除前端設計整合區塊

### Phase 4：分類器 + OpenSpec
8. task-classifier.js STAGE_MAPS.feature 加入 DESIGN
9. stage-transition.js 新增 DESIGN OpenSpec context
10. schema.yaml 新增 design-system artifact

### Phase 5：文件同步
11. CLAUDE.md 多處更新（8->9 階段、Pipeline 表格、Agent 表格）
12. pipeline.md 更新
13. dashboard/config.json 更新
14. plugin.json 版號

### Phase 6：測試
15. 更新現有 hardcode 測試
16. 新增 DESIGN 階段專屬測試
