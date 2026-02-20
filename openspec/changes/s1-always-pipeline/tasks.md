# 實作任務

## 1. classifier.js 簡化

- [ ] 1.1 新增 `isSystemFeedback(prompt)` 函式：從 HEURISTIC_RULES 的 system-feedback 規則提取邏輯（SYSTEM_MARKER 偵測 + emoji 前綴 + 英文系統通知），放在 Layer 1 extractExplicitPipeline 之後 | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [ ] 1.2 修改 `classifyWithConfidence(prompt)`：在 explicit 判斷後插入 `isSystemFeedback` 判斷，匹配時回傳 `{ pipeline: 'none', confidence: 0.9, source: 'system', matchedRule: 'system-feedback' }`；刪除原有的 `classifyByHeuristic` 呼叫 | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [ ] 1.3 刪除以下常數和函式：`QUESTION_PATTERNS` 陣列、`FILE_PATH_PATTERN` 常數、`HEURISTIC_RULES` 陣列（6 條規則）、`classifyByHeuristic()` 函式、`buildPipelineCatalogHint()` 函式、`PRIORITY_ORDER` 常數、`CATALOG_WINDOW` 常數 | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [ ] 1.4 更新 `module.exports`：刪除 `classifyByHeuristic` 和 `buildPipelineCatalogHint`，新增 `isSystemFeedback` | files: `plugins/vibe/scripts/lib/flow/classifier.js`

## 2. pipeline-controller.js classify() 簡化

- [ ] 2.1 刪除 `buildPipelineCatalogHint` import（第 46 行的 require 解構） | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- [ ] 2.2 在 classify() 函式中，Barrier 巡檢之後、ACTIVE 判斷之前，新增 `source === 'system'` 快速返回：`if (result.source === 'system') return { output: null };` | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- [ ] 2.3 簡化 ACTIVE 路徑（約第 512-519 行）：刪除 stale 偵測（10 分鐘超時邏輯），改為 `if (ds.isActive(state) && result.source !== 'explicit') return { output: null };` | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- [ ] 2.4 簡化 COMPLETE 路徑（約第 529-548 行）：刪除 30 秒冷卻邏輯，直接走 reset 分支。顯式 → `ds.resetKeepingClassification(state)`；非顯式 → `ds.reset(state)` | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- [ ] 2.5 替換 `source === 'main-agent'`（`pipelineId === 'none'`）路徑的 systemMessage（約第 602-625 行）：替換為新的 pipeline 選擇表（10 行表格 + 判斷原則 + AskUserQuestion 引導 + 複合任務分解），刪除 `buildPipelineCatalogHint()` 呼叫 | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`

## 3. guard-rules.js AskUserQuestion 白名單

- [ ] 3.1 在 `READ_ONLY_TOOLS` Set 中新增 `'AskUserQuestion'`（約第 29-32 行） | files: `plugins/vibe/scripts/lib/sentinel/guard-rules.js`
- [ ] 3.2 更新 JSDoc 註解：Rule 6 描述改為「唯讀白名單 + AskUserQuestion 互動查詢」 | files: `plugins/vibe/scripts/lib/sentinel/guard-rules.js`

## 4. 測試更新

- [ ] 4.1 刪除 classifier-and-console-filter.test.js 的 Part 1b-2（classifyByHeuristic system-feedback，約第 150-173 行）、Part 1b-3（SYSTEM_MARKER 偵測，約第 182-219 行）、Part 1b-4（擴充 emoji 偵測，約第 221-280 行）、Part 1b-5（review-only heuristic，約第 282-345 行）、Part 1b-6（question heuristic 擴充，約第 346-391 行）| files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.2 刪除 Part 1d（buildPipelineCatalogHint 測試，約第 449-502 行） | files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.3 更新 Part 1 的 import：從 `{ classifyWithConfidence, extractExplicitPipeline, classifyByHeuristic, mapTaskTypeToPipeline, buildPipelineCatalogHint, SYSTEM_MARKER }` 改為 `{ classifyWithConfidence, extractExplicitPipeline, isSystemFeedback, mapTaskTypeToPipeline, SYSTEM_MARKER }` | files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.4 新增 isSystemFeedback 測試區段：SYSTEM_MARKER 偵測、8 種 emoji 偵測、英文系統通知、一般使用者輸入、邊界值（空字串/null/undefined），至少 15 個 test case | files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.5 調整 Part 1c fallback 測試（約第 442-447 行）：疑問句 `什麼是 pipeline?` 的預期從 `source: 'heuristic'` 改為 `source: 'main-agent'` | files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.6 新增分類場景測試：至少 20 個 asyncTest 覆蓋原 heuristic 命中的 prompt（fix-change/bugfix/question/review-only/docs），驗證全部回傳 `source: 'main-agent'` | files: `plugins/vibe/tests/classifier-and-console-filter.test.js`
- [ ] 4.7 新增 AskUserQuestion guard 放行測試：在 pipeline-system.test.js 或新增測試檔案中，驗證 evaluate('AskUserQuestion', {}, activeState) 回傳 allow | files: `plugins/vibe/tests/pipeline-system.test.js` 或新增測試檔
- [ ] 4.8 調整 pipeline-catalog-integration.test.js：若有測試引用 classifyByHeuristic 或 buildPipelineCatalogHint，更新或刪除對應預期 | files: `plugins/vibe/tests/pipeline-catalog-integration.test.js`

## 5. 驗證

- [ ] 5.1 執行 `node plugins/vibe/tests/classifier-and-console-filter.test.js`，確認所有測試通過
- [ ] 5.2 執行 `node plugins/vibe/tests/pipeline-catalog-integration.test.js`，確認所有測試通過
- [ ] 5.3 執行 `node plugins/vibe/tests/pipeline-system.test.js`，確認所有測試通過（含 AskUserQuestion 放行）
- [ ] 5.4 確認 classifier.js 行數約 60-80 行（從原 257 行大幅縮減）
- [ ] 5.5 確認 pipeline-controller.js classify() 函式行數約 140 行（從原 220 行縮減）
- [ ] 5.6 更新 CLAUDE.md 中 Classifier 相關描述（三層 → 兩層 + system-feedback）| files: `CLAUDE.md`
