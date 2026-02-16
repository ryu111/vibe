# Pipeline Catalog 架構升級 Phase 2 -- Main Agent Sonnet 路由器 + LLM 分類器完善

## 為什麼（Why）

Pipeline Catalog Phase 1 已完成（已歸檔 `archive/2026-02-16-pipeline-catalog/`），成功建立了：
- 10 種 Pipeline 模板（PIPELINES 常量 in registry.js）
- 三層分類器框架（Layer 1 顯式覆寫 + Layer 2 regex 信心度 + Layer 3 LLM 佔位）
- `/vibe:pipeline` skill 作為路由知識源
- task-classifier 動態化（從 PIPELINES 讀取，非硬編碼 STAGE_MAPS）
- stage-transition 適配（pipeline 子集前進 + TDD stageIndex 追蹤）

但三個關鍵缺口尚未填補：

1. **Layer 3 LLM 分類器未完善**：`classifier.js` 已有 `classifyWithLLM()` 函式（Haiku 模型 + https API），但需求要求使用 **Sonnet** 而非 Haiku 來提高模糊意圖的分類準確度。且目前 LLM 結果缺乏 session 內快取、閾值不可配置、無降級提示整合。

2. **Main Agent 模型降級未實現**：目前使用者以 Opus 作為 Main Agent，成本高但在 pipeline 模式下 Main Agent 僅做路由（理解意圖 -> 選擇 pipeline -> 委派 sub-agent），Sonnet 足以勝任。需要提供明確的配置指引和驗證，確保 Sonnet Main Agent + Opus sub-agents（planner/architect/reviewer）的組合在所有場景下正常運作。

3. **驗證缺口**：Phase 1 的 tasks.md 中 7.1-7.5 驗證任務未完成（全面回歸測試、classifier 167 測試、CLAUDE.md 數字校驗、驗證腳本、端對端手動測試）。

## 變更內容（What Changes）

### 1. Layer 3 LLM 分類器完善（升級 classifier.js）
- `classifyWithLLM()` 模型從 Haiku 升級為 **Sonnet**（`claude-sonnet-4-20250514`），提升模糊意圖分類準確度
- 新增 `VIBE_CLASSIFIER_THRESHOLD` 環境變數（預設 `0.7`），控制 Layer 2 -> Layer 3 降級閾值
- 新增 `VIBE_CLASSIFIER_MODEL` 環境變數（預設 `claude-sonnet-4-20250514`），允許使用者覆寫 LLM 模型
- LLM 結果 session 內快取：`classifyWithLLM()` 的結果寫入 pipeline-state，同一 session 不重複呼叫
- `buildPipelineCatalogHint()` 在 LLM 不可用時注入 `additionalContext`，提示使用者可用 `[pipeline:xxx]` 語法覆寫
- task-classifier.js 整合：`pending-llm` source 觸發 `classifyWithLLM()`，成功則覆寫結果，失敗則降級到 regex-low + 注入目錄提示

### 2. Main Agent Sonnet 路由器配置（新增文件 + skill 更新）
- 更新 `/vibe:pipeline` SKILL.md，新增「Main Agent 模型建議」章節，說明 `claude --model sonnet` 或 `ANTHROPIC_MODEL=sonnet` 的使用方式
- 新增 CLAUDE.md「Main Agent 路由器模式」章節，說明 Sonnet Main Agent + Opus sub-agents 的推薦配置
- 驗證所有 hook systemMessage 在 Sonnet Main Agent 下的行為（pipeline-guard 硬阻擋不依賴模型能力，安全）
- 驗證 task-classifier 的分類品質在 Sonnet Main Agent 下不受影響（classifier.js 是 command hook，不依賴 Main Agent 模型）
- **注意**：Main Agent 模型由 CLI `--model` 參數或環境變數控制，非 plugin 可設定。Plugin 只能提供指引和最佳化。

### 3. 全面驗證閉環
- 執行所有 19 個測試檔案確認功能正確
- 確認 classifier 所有測試通過（含新增的 Layer 3 測試）
- CLAUDE.md 數字校驗（claude-md-check 通過）
- 驗證腳本全過（V-SK/V-AG/V-HK/V-SC）
- 端對端手動測試：Sonnet Main Agent + 各種 prompt -> 正確 pipeline 選擇 -> 階段正確前進

## 能力定義（Capabilities）

- [ ] CAP-1：Layer 3 Sonnet LLM 分類 -- classifier.js 的 `classifyWithLLM()` 升級為 Sonnet 模型，模型可配置
- [ ] CAP-2：LLM 分類閾值可配置 -- `VIBE_CLASSIFIER_THRESHOLD` 環境變數控制 Layer 2 -> Layer 3 降級點
- [ ] CAP-3：LLM 結果 session 快取 -- 同一 session 內不重複呼叫 LLM API
- [ ] CAP-4：task-classifier Layer 3 整合 -- `pending-llm` 觸發 LLM 分類 + 失敗降級 + 目錄提示注入
- [ ] CAP-5：Main Agent Sonnet 路由器文件 -- pipeline skill + CLAUDE.md 指引 Sonnet Main Agent 配置
- [ ] CAP-6：全面驗證 -- 19 測試檔案 + classifier 測試 + CLAUDE.md 校驗 + 驗證腳本 + E2E

## 影響分析（Impact）

- **受影響檔案**：
  - `plugins/vibe/scripts/lib/flow/classifier.js` -- Layer 3 LLM 模型升級 + 閾值配置 + 快取邏輯
  - `plugins/vibe/scripts/hooks/task-classifier.js` -- Layer 3 整合（pending-llm -> classifyWithLLM -> fallback）
  - `plugins/vibe/skills/pipeline/SKILL.md` -- 新增 Main Agent 模型建議章節
  - `CLAUDE.md` -- 新增 Main Agent 路由器模式說明
  - `plugins/vibe/tests/classifier-and-console-filter.test.js` -- Layer 3 測試案例
  - 新增 `plugins/vibe/tests/layer3-llm-classifier.test.js` -- Layer 3 專屬測試

- **無需修改的檔案**：
  - `registry.js` -- PIPELINES/PIPELINE_PRIORITY/TASKTYPE_TO_PIPELINE 不變
  - `pipeline.json` -- 階段定義不變
  - `stage-transition.js` -- 前進/回退邏輯不變（不依賴分類器模型）
  - `pipeline-guard.js` -- 硬阻擋邏輯由 state.pipelineEnforced 驅動，不依賴 Main Agent 模型
  - `guard-rules.js` -- 純規則模組不變
  - `delegation-tracker.js` -- 委派追蹤不變
  - `pipeline-init.js` -- 環境偵測不變
  - `pipeline-check.js` -- 完整性檢查不變
  - `pipeline-discovery.js` -- 動態發現不變
  - `hooks.json` -- 不需新增 hook entry（Layer 3 在 task-classifier command hook 內部以 https 呼叫實現）

- **受影響模組**：flow（classifier + task-classifier）
- **registry.js 變更**：否
- **hook 變更**：task-classifier（Layer 3 整合邏輯）
- **hooks.json 變更**：否

## 階段分解

### Phase 1：Layer 3 LLM 分類器完善（核心引擎）
- **產出**：
  - classifier.js 的 `classifyWithLLM()` 模型從 Haiku 升級為 Sonnet
  - 新增 `VIBE_CLASSIFIER_MODEL` 環境變數（預設 `claude-sonnet-4-20250514`）
  - 新增 `VIBE_CLASSIFIER_THRESHOLD` 環境變數（預設 `0.7`）
  - LLM prompt 最佳化：注入 10 種 pipeline 目錄 + 分類原則
  - LLM 逾時從 8s 調整為 10s（Sonnet 比 Haiku 稍慢）
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/lib/flow/classifier.js`
- **依賴**：無（classifier.js 已有 Layer 3 骨架）
- **風險**：
  - **低**。只修改 LLM 模型 ID 和新增環境變數讀取，不影響 Layer 1/2 邏輯
  - Sonnet API 呼叫成本比 Haiku 高（~$0.003 -> ~$0.01/次），但只在 Layer 2 信心度 < 0.7 時觸發
  - `ANTHROPIC_API_KEY` 不存在時靜默降級（已有此邏輯）
- **驗收條件**：
  - `classifyWithLLM('優化一下效能')` 回傳有效的 pipeline ID（如 `quick-dev`）
  - `VIBE_CLASSIFIER_THRESHOLD=1.0` 時 Layer 3 永不觸發
  - `VIBE_CLASSIFIER_MODEL=claude-haiku-4-5-20251001` 可回退到 Haiku
  - 無 API key 時 `classifyWithLLM()` 回傳 null，不報錯

### Phase 2：task-classifier Layer 3 整合 + 快取（接線）
- **產出**：
  - task-classifier.js 在 `classifyWithConfidence()` 回傳 `source: 'pending-llm'` 時呼叫 `classifyWithLLM()`
  - LLM 分類成功 -> 覆寫 pipeline/confidence/source
  - LLM 分類失敗 -> 保留 regex 結果 + 注入 `buildPipelineCatalogHint()` 到 additionalContext
  - LLM 結果寫入 pipeline-state（`classificationSource: 'llm'`），同一 session 後續 prompt 不重複呼叫
  - 新增 `classificationConfidence` 和 `classificationSource` 到 state（debug 追蹤用）
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/task-classifier.js`
- **依賴**：Phase 1
- **風險**：
  - **中**。task-classifier 是 Pipeline 入口點，但 Layer 3 是純增量邏輯（新 if 分支），不影響現有 Layer 1/2 路徑
  - LLM 呼叫增加 1-2 秒延遲（僅低信心度 prompt 觸發），使用者可感知
  - 緩解：`VIBE_CLASSIFIER_THRESHOLD=1.0` 可完全停用 Layer 3
- **驗收條件**：
  - 模糊 prompt（如「看看這個」，信心度 0.6）觸發 Layer 3 並正確分類
  - 明確 prompt（如「建立 REST API」，信心度 0.8）不觸發 Layer 3
  - Layer 3 失敗時 state 記錄 `classificationSource: 'regex-low'` + additionalContext 包含 pipeline 目錄
  - 同一 session 第二次 prompt 不重複呼叫 LLM（讀 state 快取）

### Phase 3：Layer 3 測試 + 全面驗證（品質守衛）
- **產出**：
  - 新增 Layer 3 專屬測試（模擬 LLM 回傳、fallback 行為、threshold 設定、快取行為）
  - 執行所有 19 個現有測試檔案確認回歸
  - CLAUDE.md 數字校驗通過
  - 驗證腳本（V-SK/V-AG/V-HK/V-SC）全過
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/tests/classifier-and-console-filter.test.js`（新增 Layer 3 測試區段）
  - 或新增 `/Users/sbu/projects/vibe/plugins/vibe/tests/layer3-llm-classifier.test.js`（獨立測試檔）
- **依賴**：Phase 2
- **風險**：
  - **低**。純測試，不影響產品程式碼
  - LLM 測試需 mock（不實際呼叫 API），確認 classifier 的 LLM 整合路徑正確即可
- **驗收條件**：
  - Layer 3 測試覆蓋：成功分類、失敗降級、threshold 邊界、快取命中、model 覆寫
  - 所有 19 個測試檔案通過（0 失敗）
  - `claude-md-check` hook 不報數字不一致

### Phase 4：Main Agent Sonnet 路由器配置指引（文件）
- **產出**：
  - `/vibe:pipeline` SKILL.md 新增「Main Agent 模型建議」章節
  - CLAUDE.md 新增「Main Agent 路由器模式」說明
  - 記錄 `claude --model sonnet` 或 `alias vc='claude --model sonnet --plugin-dir ...'` 用法
  - 說明 Sonnet Main Agent + Opus sub-agents（planner/architect/reviewer）的成本效益分析
  - 驗證清單：確認 pipeline-guard systemMessage 在 Sonnet 下被正確遵守
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/skills/pipeline/SKILL.md`
  - `/Users/sbu/projects/vibe/CLAUDE.md`
- **依賴**：Phase 3（驗證完成後才寫文件）
- **風險**：
  - **低**。純文件變更，不影響功能
  - 待確認：Sonnet Main Agent 是否能可靠遵守 systemMessage 中的委派指令（ECC 的 pipeline-guard 是 exit 2 硬阻擋，不依賴模型遵從性，這點安全）
- **驗收條件**：
  - `/vibe:pipeline` SKILL.md 包含 Sonnet 路由器使用指引
  - CLAUDE.md 包含推薦的 Main Agent 模型配置
  - 手動測試：`claude --model sonnet` + pipeline 模式完整走完不出錯

### Phase 5：端對端驗證（整合測試）
- **產出**：
  - 手動端對端測試報告（各種 prompt -> pipeline 選擇 -> 階段前進 -> 完成）
  - Sonnet Main Agent 端對端驗證（委派正確、systemMessage 遵守、pipeline-guard 正常）
  - Layer 3 真實 API 呼叫驗證（非 mock）
  - OpenSpec change 歸檔到 archive
- **修改檔案**：
  - 無新增程式碼
  - `openspec/changes/pipeline-catalog/` -> 歸檔到 `openspec/changes/archive/`
- **依賴**：Phase 4
- **風險**：
  - **低**。純驗證，不修改程式碼
  - Layer 3 真實 API 呼叫需要 `ANTHROPIC_API_KEY`，CI 環境可能無法測試
- **驗收條件**：
  - 至少測試以下 prompt 類型並記錄結果：
    - 強疑問句 -> none pipeline
    - 明確 feature -> standard/full pipeline
    - 模糊意圖（低信心度）-> Layer 3 觸發 -> 正確分類
    - `[pipeline:xxx]` 顯式覆寫 -> Layer 1 直接命中
    - TDD prompt -> test-first pipeline 三步循環正確
  - Sonnet Main Agent 在 pipeline 模式下不嘗試直接寫碼（pipeline-guard 攔截）

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| Sonnet LLM 呼叫增加延遲（1-2 秒） | 低 | 僅低信心度時觸發；`VIBE_CLASSIFIER_THRESHOLD=1.0` 可停用 |
| Sonnet API 成本高於 Haiku（~$0.01 vs ~$0.003） | 低 | 僅低信心度時觸發；session 快取避免重複呼叫 |
| Sonnet Main Agent 可能不嚴格遵守 systemMessage | 低 | pipeline-guard 是 exit 2 硬阻擋，不依賴模型遵從性 |
| `ANTHROPIC_API_KEY` 不存在導致 Layer 3 不可用 | 低 | 靜默降級到 Layer 2 + 注入目錄提示（已實作） |
| LLM 回傳非法 pipeline ID | 低 | `classifyWithLLM()` 已驗證回傳的 pipeline ID 是否在 PIPELINES 中 |
| task-classifier Layer 3 整合改壞現有邏輯 | 中 | Layer 3 是純新增 if 分支，不修改 Layer 1/2 路徑；完整回歸測試 |
| Sonnet 模型 ID 變更導致 API 失敗 | 低 | `VIBE_CLASSIFIER_MODEL` 環境變數可覆寫；使用完整模型 ID 避免短名問題 |

## 回滾計畫

每個 Phase 都有獨立的 git checkpoint，回滾策略：

1. **Phase 1 失敗**：`classifyWithLLM()` 回退到 Haiku 模型 ID。零功能影響（Layer 3 只在低信心度觸發）。
2. **Phase 2 失敗**：task-classifier 移除 Layer 3 分支，回退到 `pending-llm` 不觸發 LLM（現有行為）。系統退化為 Layer 1+2（零成本 regex 分類），完全可用。
3. **Phase 3 失敗**：純測試回滾，不影響功能。
4. **Phase 4 失敗**：文件回退，不影響功能。
5. **Phase 5 失敗**：驗證發現問題時，按具體問題回退到對應 Phase。

**緊急回滾**：`VIBE_CLASSIFIER_THRESHOLD=1.0` 環境變數可在不改程式碼的情況下完全停用 Layer 3。
