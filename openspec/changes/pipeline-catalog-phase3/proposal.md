# Pipeline Catalog Phase 3 -- 分類智慧化升級

## 為什麼（Why）

Pipeline Catalog Phase 1（三層分類器框架 + 10 種模板）和 Phase 2（Sonnet LLM 完善 + session 快取 + 環境變數配置 + 路由器文件）已完成並歸檔。三層分類器已能正確處理大部分場景，但目前是一個「靜態系統」——分類決策不可觀測、分類錯誤不可回饋、閾值無法自適應。

具體痛點：

1. **分類決策不透明**：`task.classified` Timeline 事件只記錄最終結果（pipelineId + taskType），不記錄觸發了哪一層（Layer 1/2/3）、信心度多少、匹配了哪個 regex。出問題時無法快速定位是哪一層的判斷偏差。

2. **誤判回饋斷路**：`/cancel` 時的 `classifier-corpus.jsonl` 已有基礎，但缺乏結構化的「分類錯誤」標記。使用者只能被動取消 pipeline，無法告訴系統「分類本身就錯了」vs「我只是不想走 pipeline」。

3. **閾值靜態固定**：`VIBE_CLASSIFIER_THRESHOLD`（預設 0.7）是一次性設定的常數。如果 Layer 2 regex 頻繁被修正（使用者常取消 regex 分類的結果），應該自動降低閾值讓更多案例觸發 Layer 3 LLM 分類。

4. **Pipeline 選擇不夠互動**：`/vibe:pipeline` 目前是純知識 skill（顯示 10 種模板文件），使用者無法在 pipeline 開始前透過 AskUserQuestion 互動式選擇模板。需要明確觸發分類結果而非僅提供參考文件。

5. **Phase 2 收尾未完成**：`openspec/changes/pipeline-catalog/` 目錄（Phase 2 的 proposal/design/specs/tasks）尚未歸檔到 `archive/`，delta specs 未合併到 `openspec/specs/`。

## 變更內容（What Changes）

### 1. Classification Analytics -- Timeline 事件擴充

- 擴充 `task.classified` 事件的 data payload，新增 `layer`（1/2/3）、`confidence`、`source`（explicit/regex/llm/regex-low/llm-cached）、`matchedRule`（觸發的具體 regex 或 action pattern）欄位
- task-classifier.js 的 emit 呼叫補齊新欄位（兩處：初始分類 + 升級分類）
- formatter.js 的 `task.classified` 格式化加入 Layer/信心度顯示
- Dashboard UI（web/index.html）在事件面板中可視化分類決策的 Layer 分佈

### 2. Correction Loop -- 結構化誤判回饋

- cancel SKILL.md 升級：`/cancel` 時新增 AskUserQuestion 詢問「為什麼取消？」選項：(a) 分類錯誤 (b) 不需要 pipeline (c) 其他原因
- 選項 (a) 進一步詢問「正確的 pipeline 應該是？」（從 10 種模板中選），記錄到 `classifier-corpus.jsonl`
- corpus 格式升級：新增 `expectedPipeline`、`layer`、`confidence` 欄位，提供更精確的修正資訊
- 新增 `correction_count` 統計到 pipeline-state（累計修正次數，供 Adaptive Confidence 使用）

### 3. Adaptive Confidence -- 動態閾值調整（Phase 3A：基礎版）

- 新增 `~/.claude/classifier-stats.json` 全域統計檔案（跨 session 持久化）
  - 記錄 Layer 2 regex 分類的「修正率」（被 /cancel + 選擇「分類錯誤」的比例）
  - 記錄 Layer 3 LLM 分類的修正率（做為對照基準）
- classifier.js 新增 `getAdaptiveThreshold()` 函式：讀取 stats 檔案，如果 Layer 2 修正率 > 30%，自動將閾值從 0.7 降低到 0.5（觸發更多 Layer 3）
- 漸進式設計：Phase 3 只做兩檔位（0.7 / 0.5），不做連續自適應（避免過度工程）
- `VIBE_CLASSIFIER_THRESHOLD` 環境變數仍有最高優先級（手動設定覆蓋自適應）

### 4. Pipeline Template Selection UX -- 互動式選擇器

- `/vibe:pipeline` skill 升級為雙模式：
  - **無參數**：顯示 10 種模板 + AskUserQuestion 讓使用者選擇（multiSelect: false）
  - **有參數**（如 `/vibe:pipeline full`）：顯示指定模板詳情（現有行為）
- 使用者選擇模板後，以 `[pipeline:xxx]` 語法注入到後續 prompt 處理（走 Layer 1 顯式覆寫路徑）
- **注意**：此 UX 升級是 skill 層面的改進，不改動 classifier.js 核心邏輯

### 5. Phase 2 收尾 -- 歸檔與 Spec 合併

- `openspec/changes/pipeline-catalog/` 歸檔到 `openspec/changes/archive/2026-02-16-pipeline-catalog-phase2/`
- delta specs 合併到 `openspec/specs/`（classifier/task-classifier/pipeline-skill/claude-md）
- 清理 `openspec/changes/pipeline-catalog/` 目錄

## 能力定義（Capabilities）

- [ ] CAP-1：Classification Analytics -- `task.classified` 事件包含 layer/confidence/source/matchedRule 欄位
- [ ] CAP-2：Analytics Dashboard -- Dashboard UI 可視化分類 Layer 分佈（統計圖表或表格）
- [ ] CAP-3：Correction Loop -- `/cancel` 流程支援「分類錯誤」回饋 + 正確 pipeline 選擇
- [ ] CAP-4：Structured Corpus -- `classifier-corpus.jsonl` 包含 expectedPipeline/layer/confidence 結構化欄位
- [ ] CAP-5：Adaptive Threshold -- classifier.js 根據歷史修正率自動調整 Layer 2→3 閾值（兩檔位）
- [ ] CAP-6：Pipeline Selector UX -- `/vibe:pipeline` 無參數時提供 AskUserQuestion 互動式選擇
- [ ] CAP-7：Phase 2 Archive -- pipeline-catalog Phase 2 歸檔 + delta specs 合併

## 影響分析（Impact）

- **受影響檔案**：
  - `plugins/vibe/scripts/hooks/task-classifier.js` -- emit 呼叫補齊 layer/confidence/source/matchedRule 欄位
  - `plugins/vibe/scripts/lib/flow/classifier.js` -- classifyWithConfidence() 回傳值擴充 matchedRule + getAdaptiveThreshold() 新增
  - `plugins/vibe/scripts/lib/timeline/formatter.js` -- formatEventText() 的 task.classified case 加入 Layer 顯示
  - `plugins/vibe/skills/cancel/SKILL.md` -- 新增分類錯誤回饋流程
  - `plugins/vibe/skills/pipeline/SKILL.md` -- 升級為互動式選擇器
  - `plugins/vibe/web/index.html` -- 事件面板分類 Layer 可視化
  - `plugins/vibe/server.js` -- 待確認是否需要新增 classification stats 端點
  - `openspec/changes/pipeline-catalog/` -- 歸檔
  - `openspec/specs/` -- 合併 delta specs
  - 新增 `~/.claude/classifier-stats.json` -- 全域分類統計（runtime 產生，不在 repo 中）

- **無需修改的檔案**：
  - `registry.js` -- PIPELINES/PIPELINE_PRIORITY 不變，模板定義不受分類智慧化影響
  - `pipeline.json` -- 階段定義不變
  - `stage-transition.js` -- 前進/回退邏輯不變（不依賴分類細節）
  - `pipeline-guard.js` -- 硬阻擋邏輯由 state.pipelineEnforced 驅動，不受分類層級影響
  - `guard-rules.js` -- 純規則模組不變
  - `delegation-tracker.js` -- 委派追蹤不變
  - `pipeline-init.js` -- 環境偵測不變
  - `hooks.json` -- 不需新增 hook entry（所有邏輯在 task-classifier 內部 + cancel skill 流程）
  - `schema.js` -- EVENT_TYPES.TASK_CLASSIFIED 已存在，只需擴充 data payload（不需新增事件類型）

- **受影響模組**：flow（classifier + task-classifier）、timeline（formatter）、dashboard（web/index.html）
- **registry.js 變更**：否
- **hook 變更**：task-classifier（emit payload 擴充）
- **hooks.json 變更**：否

## 階段分解

### Phase 1：Classification Analytics（可觀測性基礎）
- **產出**：
  - classifier.js 的 `classifyWithConfidence()` 回傳值新增 `matchedRule` 欄位（標記命中的具體 regex pattern 名稱，如 `'strong-question'`/`'trivial'`/`'weak-explore'`/`'action:feature'`/`'default'`）
  - task-classifier.js 的兩處 `emit(EVENT_TYPES.TASK_CLASSIFIED, ...)` 補齊 `layer`、`confidence`、`source`、`matchedRule` 到 data payload
  - formatter.js 的 `formatEventText()` task.classified case 升級：顯示 `分類=feature L2(0.80) [action:feature]` 格式
  - Timeline skill 和 Dashboard 事件面板自動受益（消費 formatEventText 的下游）
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/lib/flow/classifier.js`
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/task-classifier.js`
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/lib/timeline/formatter.js`
- **依賴**：無
- **風險**：
  - **低**。純增量擴充（新增欄位到現有 data 結構），不改變分類行為
  - `classifyWithConfidence()` 回傳值新增 `matchedRule` 是向後相容的（現有消費端不讀此欄位）
  - formatter.js 的格式變更僅影響顯示，不影響邏輯
- **驗收條件**：
  - Timeline 事件中的 task.classified 包含 layer/confidence/source/matchedRule 四個欄位
  - `formatEventText()` 輸出包含 Layer 資訊（如 `L1`/`L2`/`L3`）
  - 現有 formatter 測試通過（需更新 `task.classified` 的預期輸出格式）
  - classifier 測試 222+ 全通過（零回歸）

### Phase 2：Correction Loop（誤判回饋閉環）
- **產出**：
  - cancel SKILL.md 升級：新增分類錯誤回饋流程（AskUserQuestion 三選項 + 正確 pipeline 選擇）
  - `classifier-corpus.jsonl` 格式升級：新增 `expectedPipeline`、`layer`、`confidence`、`source` 欄位
  - pipeline-state 新增 `correctionCount` 計數器（cancel 時 +1，resetPipelineState 時清除）
  - 新增 `~/.claude/classifier-stats.json` 統計檔案：累計各 Layer/source 的修正次數
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/skills/cancel/SKILL.md`
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/task-classifier.js`（resetPipelineState 新增 correctionCount 清除）
- **依賴**：Phase 1（需要 layer/confidence/source 欄位供 corpus 記錄）
- **風險**：
  - **中**。cancel skill 的 AskUserQuestion 流程新增了使用者互動步驟，可能讓取消操作變得更繁瑣
  - **緩解**：AskUserQuestion 選項中包含「跳過回饋」選項，不強制使用者回答
  - `classifier-corpus.jsonl` 格式變更向後相容（新增欄位，不刪除舊欄位）
  - cancel skill 是 Reference 型（由 Claude 直接執行），不走 sub-agent 委派，pipeline-guard 不會攔截其中的 Write 操作（cancel 會先解除 pipelineEnforced）
- **驗收條件**：
  - `/cancel` 時顯示三選項 AskUserQuestion
  - 選擇「分類錯誤」+ 選擇正確 pipeline 後，`classifier-corpus.jsonl` 新增一行包含 expectedPipeline 欄位
  - `classifier-stats.json` 正確累計修正次數
  - 選擇「不需要 pipeline」時行為與現有相同（只解除鎖定）

### Phase 3：Adaptive Confidence 基礎版（動態閾值）
- **產出**：
  - classifier.js 新增 `getAdaptiveThreshold()` 函式：讀取 `~/.claude/classifier-stats.json`，計算 Layer 2 修正率
  - 兩檔位邏輯：修正率 > 30% → 閾值 0.5（觸發更多 Layer 3）；否則 → 保持 0.7
  - `VIBE_CLASSIFIER_THRESHOLD` 環境變數仍有最高優先級（覆蓋自適應）
  - `classifyWithConfidence()` 整合 `getAdaptiveThreshold()`
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/lib/flow/classifier.js`
- **依賴**：Phase 2（需要 classifier-stats.json 累積足夠修正資料）
- **風險**：
  - **中**。自適應閾值改變了分類行為——更多案例會觸發 Layer 3 LLM 呼叫，增加延遲和 API 成本
  - **緩解**：(1) 兩檔位設計限制了影響範圍（最多從 0.7 降到 0.5）(2) `VIBE_CLASSIFIER_THRESHOLD` 環境變數可手動覆蓋 (3) 只有 `classifier-stats.json` 累積足夠資料（至少 10 次分類、3+ 次修正）時才啟用自適應
  - **待確認**：修正率計算的時間窗口——是全歷史累計還是最近 N 次？建議最近 50 次（避免早期誤判永久影響）
- **驗收條件**：
  - 無 `classifier-stats.json` 時，`getAdaptiveThreshold()` 回傳預設 0.7
  - 修正率 < 30% 時，閾值為 0.7
  - 修正率 > 30% 時，閾值自動降為 0.5
  - `VIBE_CLASSIFIER_THRESHOLD=0.8` 時，無論修正率多少都使用 0.8
  - classifier 測試新增 adaptive threshold 相關測試案例

### Phase 4：Pipeline Template Selection UX（互動式選擇器）
- **產出**：
  - `/vibe:pipeline` SKILL.md 升級為雙模式
  - 無參數模式：列出 10 種模板摘要 + AskUserQuestion（multiSelect: false）讓使用者選擇
  - 選擇後 skill 輸出指引 Claude 在後續 prompt 使用 `[pipeline:xxx]` 語法（走 Layer 1 路徑）
  - 有參數模式：顯示指定模板詳情（維持現有行為）
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/skills/pipeline/SKILL.md`
- **依賴**：無（與 Phase 1~3 獨立，可並行）
- **風險**：
  - **低**。Skill 層面變更，不影響 classifier 核心邏輯或 hook 行為
  - AskUserQuestion 在 pipeline 模式下會被 pipeline-guard 攔截（exit 2），但 `/vibe:pipeline` 通常在 pipeline 啟動前使用（此時 pipelineEnforced=false），不會衝突
  - **待確認**：如果使用者在 pipeline 進行中呼叫 `/vibe:pipeline` 切換模板，是否需要特殊處理？建議 SKILL.md 中標記「pipeline 進行中不支援切換」
- **驗收條件**：
  - `/vibe:pipeline`（無參數）顯示 AskUserQuestion 選單
  - 選擇 `full` 後，Claude 在後續 prompt 處理中正確觸發 full pipeline
  - `/vibe:pipeline full`（有參數）行為與現有完全一致
  - 驗證腳本 V-SK 通過

### Phase 5：Phase 2 收尾 + 全面驗證（歸檔 + 品質守衛）
- **產出**：
  - `openspec/changes/pipeline-catalog/` 歸檔到 `openspec/changes/archive/2026-02-16-pipeline-catalog-phase2/`
  - delta specs（classifier/task-classifier/pipeline-skill/claude-md）合併到 `openspec/specs/`
  - 全面回歸測試（所有測試檔案 + 驗證腳本 + CLAUDE.md 數字校驗）
  - plugin.json 版號更新
  - CLAUDE.md 同步更新（如有需要）
- **修改檔案**：
  - `openspec/changes/pipeline-catalog/` -- 移動到 archive
  - `openspec/specs/` -- 合併 delta specs
  - `plugins/vibe/.claude-plugin/plugin.json` -- 版號更新
  - `CLAUDE.md` -- 如有需要同步更新
- **依賴**：Phase 1~4 全部完成
- **風險**：
  - **低**。歸檔和合併是檔案操作，不影響 runtime 行為
  - delta specs 合併需注意是否有衝突（如 classifier spec 已存在於 openspec/specs/ 中）
- **驗收條件**：
  - `openspec/changes/pipeline-catalog/` 目錄已清空（或移除）
  - `openspec/changes/archive/2026-02-16-pipeline-catalog-phase2/` 包含完整的 proposal/design/specs/tasks
  - 所有測試通過（0 失敗）
  - 驗證腳本全過（V-SK/V-AG/V-HK/V-SC）
  - `claude-md-check` 不報數字不一致
  - Phase 2 tasks.md 中的未完成項目（3.5, 5.2, 5.3, 6.1~6.4）已處理或標記為「Phase 3 涵蓋」

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| Adaptive Confidence 改變分類行為，觸發更多 LLM 呼叫 | 中 | 兩檔位限制影響範圍 + 環境變數手動覆蓋 + 最少 10 次分類門檻 |
| cancel 流程新增互動步驟讓取消操作更繁瑣 | 中 | 提供「跳過回饋」選項，不強制使用者回答 |
| classifier-stats.json 跨 session 累積可能被汙染（測試環境混入） | 低 | session-cleanup 不清理此檔案（刻意保留），但提供 `/vibe:health` 重設選項 |
| classifyWithConfidence() 回傳值新增欄位影響現有消費端 | 低 | 純增量（新增欄位），現有消費端只讀 pipeline/confidence/source，不受 matchedRule 影響 |
| Pipeline selector UX 在 pipeline 進行中被呼叫 | 低 | SKILL.md 中明確標記「pipeline 進行中不支援切換」+ pipeline-guard 攔截 AskUserQuestion |
| Phase 2 歸檔的 delta specs 與現有 specs 衝突 | 低 | 歸檔前先檢查 openspec/specs/ 目錄是否已有同名 spec |
| Adaptive threshold 的修正率計算未考慮時間衰減 | 低 | Phase 3 只做最近 50 次滑動窗口，不做全歷史累計 |

## 回滾計畫

每個 Phase 都有獨立的 git tag（`vibe-pipeline/phase3-N`），回滾策略：

1. **Phase 1 失敗**：移除 classifyWithConfidence 的 matchedRule 欄位 + 還原 emit payload + 還原 formatter 格式。分類行為完全不受影響（純顯示層變更）。
2. **Phase 2 失敗**：還原 cancel SKILL.md + 移除 correctionCount + 移除 classifier-stats.json 寫入邏輯。corpus 檔案保留但停止結構化記錄。
3. **Phase 3 失敗**：移除 getAdaptiveThreshold()，classifyWithConfidence 回退到固定 LLM_CONFIDENCE_THRESHOLD。`VIBE_CLASSIFIER_THRESHOLD=0.7` 環境變數可在不改程式碼的情況下立即還原行為。
4. **Phase 4 失敗**：還原 pipeline SKILL.md 到純知識模式。不影響分類器或 pipeline 行為。
5. **Phase 5 失敗**：歸檔操作可逆（從 archive 移回 changes）。

**緊急回滾**：`VIBE_CLASSIFIER_THRESHOLD=0.7` 環境變數可在不改程式碼的情況下停用 Adaptive Confidence，恢復 Phase 2 的靜態行為。
