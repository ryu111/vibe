# 實作任務

## 1. Layer 3 LLM 分類器完善（核心引擎）
- [x] 1.1 classifier.js 的 `LLM_MODEL` 常量改為讀取 `VIBE_CLASSIFIER_MODEL` 環境變數（預設 `claude-sonnet-4-20250514`） | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [x] 1.2 classifier.js 的 `LLM_TIMEOUT` 從 8000 調整為 10000 | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [x] 1.3 classifier.js 新增 `LLM_CONFIDENCE_THRESHOLD` 常量，讀取 `VIBE_CLASSIFIER_THRESHOLD` 環境變數（預設 0.7，NaN fallback） | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [x] 1.4 `classifyWithConfidence()` 的閾值判斷從硬編碼 `0.7` 改為使用 `LLM_CONFIDENCE_THRESHOLD` 常量 | files: `plugins/vibe/scripts/lib/flow/classifier.js` | depends: 1.3
- [x] 1.5 更新 classifier.js 頂部 JSDoc 註解（Layer 3 描述從 Haiku 改為 Sonnet，加入環境變數說明） | files: `plugins/vibe/scripts/lib/flow/classifier.js`

## 2. Task-Classifier Session 快取（接線整合）
- [x] 2.1 `pending-llm` 分支加入 `state.llmClassification` 讀取邏輯（快取命中直接使用，標記 source 為 `llm-cached`） | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 1.4
- [x] 2.2 LLM 成功結果寫入 `state.llmClassification` | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 2.1
- [x] 2.3 `resetPipelineState()` 新增 `delete state.llmClassification` | files: `plugins/vibe/scripts/hooks/task-classifier.js`
- [x] 2.4 修復 `statePath` TDZ bug（Temporal Dead Zone — 使用在宣告前） | files: `plugins/vibe/scripts/hooks/task-classifier.js`

## 3. 測試（品質守衛）
- [x] 3.1 classifier 測試新增 `VIBE_CLASSIFIER_MODEL` 環境變數覆寫驗證 | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 1.1
- [x] 3.2 classifier 測試新增 `VIBE_CLASSIFIER_THRESHOLD` 閾值邊界測試（0 / 0.5 / 1.0 / NaN） | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 1.3
- [x] 3.3 新增 session 快取測試：首次呼叫 / 快取命中 / reset 清除 / LLM 失敗不寫入快取 | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 2.2
- [x] 3.4 確認現有 167+ classifier 測試全部通過（零回歸） — 實際 222 通過 | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 1.4
- [ ] 3.5 執行所有 19 個測試檔案確認無回歸 | depends: 3.4

## 4. Main Agent Sonnet 路由器文件（文件更新）
- [x] 4.1 SKILL.md 新增「Main Agent 模型建議」章節（CLI 用法、alias 範例、成本效益、安全保障） | files: `plugins/vibe/skills/pipeline/SKILL.md` | depends: 1.4
- [x] 4.2 SKILL.md 新增「Layer 3 環境變數」章節（VIBE_CLASSIFIER_MODEL、VIBE_CLASSIFIER_THRESHOLD） | files: `plugins/vibe/skills/pipeline/SKILL.md` | depends: 1.4
- [x] 4.3 CLAUDE.md 新增「Main Agent 路由器模式」說明（推薦配置、安全保障、環境變數列表） | files: `CLAUDE.md` | depends: 1.4

## 5. 版號與文件同步
- [x] 5.1 plugin.json 更新 version（1.0.39 → 1.0.40） | files: `plugins/vibe/.claude-plugin/plugin.json` | depends: 4.3
- [ ] 5.2 確認 CLAUDE.md 所有數字正確（claude-md-check 通過） | depends: 4.3
- [ ] 5.3 確認驗證腳本全過（V-SK/V-AG/V-HK/V-SC） | depends: 4.2

## 6. 驗證
- [ ] 6.1 端對端手動測試：模糊 prompt（低信心度）→ Layer 3 觸發 → 正確分類 | depends: 3.5
- [ ] 6.2 端對端手動測試：`VIBE_CLASSIFIER_THRESHOLD=0` → Layer 3 永不觸發 | depends: 3.5
- [ ] 6.3 端對端手動測試：`[pipeline:xxx]` 顯式覆寫 → Layer 1 直接命中（不觸發 Layer 3） | depends: 3.5
- [ ] 6.4 端對端手動測試：Sonnet Main Agent（`claude --model sonnet`）+ pipeline 模式完整走完 | depends: 4.3
