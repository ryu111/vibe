# 實作任務

## 1. Classification Analytics -- matchedRule 欄位（Phase 1）
- [x] 1.1 classifier.js `classifyWithConfidence()` 回傳值新增 `matchedRule` 欄位：Layer 1 回傳 `'explicit'`；Layer 2 根據命中的分支回傳 `'strong-question'`/`'trivial'`/`'weak-explore'`/`'action:{type}'`/`'default'` | files: `plugins/vibe/scripts/lib/flow/classifier.js`
- [x] 1.2 classifier.js 匯出列表新增 `getAdaptiveThreshold`（Phase 3 預留，此處先宣告但 Phase 1 暫不實作內容） | files: `plugins/vibe/scripts/lib/flow/classifier.js`

## 2. Classification Analytics -- emit 擴充（Phase 1）
- [x] 2.1 task-classifier.js 新增 `determineLayer(result)` 輔助函式：根據 `result.source` 回傳 layer（explicit→1, regex/regex-low→2, llm/llm-cached→3） | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 1.1
- [x] 2.2 task-classifier.js 初始分類 emit 呼叫補齊 `layer`/`confidence`/`source`/`matchedRule` | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 2.1
- [x] 2.3 task-classifier.js 升級分類 emit 呼叫補齊 `layer`/`confidence`/`source`/`matchedRule` | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 2.1

## 3. Classification Analytics -- 格式化升級（Phase 1）
- [x] 3.1 formatter.js `formatEventText()` 的 `task.classified` case 升級：有 layer 欄位時顯示 `"分類={pipelineId} L{layer}({confidence}) [{matchedRule}]"`；升級分類時加入 `"升級 {from}->{pipelineId}"`；無 layer 欄位時回退到舊格式 | files: `plugins/vibe/scripts/lib/timeline/formatter.js` | depends: 1.1

## 4. Correction Loop -- cancel SKILL.md 升級（Phase 2）
- [x] 4.1 cancel SKILL.md 新增「取消原因回饋」段落：在解除鎖定後（步驟 3 和 4 之間），如果原 `pipelineEnforced` 為 true，使用 AskUserQuestion 詢問三選項 | files: `plugins/vibe/skills/cancel/SKILL.md` | depends: 2.2
- [x] 4.2 cancel SKILL.md 新增「分類錯誤回饋」子流程：選擇「分類錯誤」後，AskUserQuestion 顯示 10 種 pipeline 選擇正確的 pipeline | files: `plugins/vibe/skills/cancel/SKILL.md` | depends: 4.1
- [x] 4.3 cancel SKILL.md 升級「自動蒐集誤判語料」段落：corpus JSONL 格式新增 `reason`/`expectedPipeline`/`pipelineId`/`layer`/`confidence`/`source`/`matchedRule` 欄位 | files: `plugins/vibe/skills/cancel/SKILL.md` | depends: 4.2
- [x] 4.4 cancel SKILL.md 新增「classifier-stats.json 更新」段落：分類錯誤時更新 corrections 計數 + recentWindow 追加；非分類錯誤時 recentWindow 追加 corrected=false | files: `plugins/vibe/skills/cancel/SKILL.md` | depends: 4.3
- [x] 4.5 task-classifier.js `resetPipelineState()` 新增 `delete state.correctionCount` | files: `plugins/vibe/scripts/hooks/task-classifier.js`

## 5. Adaptive Confidence -- 動態閾值（Phase 3）
- [x] 5.1 classifier.js 實作 `getAdaptiveThreshold()`：讀取 `~/.claude/classifier-stats.json` → 計算 recentWindow 中 Layer 2 修正率 → 兩檔位判斷（>30%→0.5, 否則→0.7）→ 環境變數覆寫 | files: `plugins/vibe/scripts/lib/flow/classifier.js` | depends: 4.4
- [x] 5.2 classifier.js `classifyWithConfidence()` 的閾值判斷從靜態 `LLM_CONFIDENCE_THRESHOLD` 改為呼叫 `getAdaptiveThreshold()` | files: `plugins/vibe/scripts/lib/flow/classifier.js` | depends: 5.1
- [x] 5.3 classifier.js 更新頂部 JSDoc 註解：新增 `getAdaptiveThreshold` 說明、`classifier-stats.json` 格式描述 | files: `plugins/vibe/scripts/lib/flow/classifier.js` | depends: 5.2

## 6. Pipeline Template Selection UX（Phase 4）
- [x] 6.1 pipeline SKILL.md 新增雙模式說明：無參數→AskUserQuestion 互動式選擇器；有參數→現有行為 | files: `plugins/vibe/skills/pipeline/SKILL.md`
- [x] 6.2 pipeline SKILL.md 新增 AskUserQuestion 選項格式定義：10 種 pipeline 的 label/description/value 模板 | files: `plugins/vibe/skills/pipeline/SKILL.md` | depends: 6.1
- [x] 6.3 pipeline SKILL.md 新增 pipeline 進行中處理說明：提示使用者先用 /cancel 退出 | files: `plugins/vibe/skills/pipeline/SKILL.md` | depends: 6.1

## 7. 測試（品質守衛）
- [x] 7.1 classifier 測試新增 `matchedRule` 欄位驗證：classifyWithConfidence 回傳值包含正確的 matchedRule | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 1.1
- [x] 7.2 classifier 測試新增 `getAdaptiveThreshold()` 測試：無 stats→0.7、修正率低→0.7、修正率高→0.5、樣本不足→0.7、環境變數覆寫 | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 5.2
- [x] 7.3 formatter 測試新增/更新 `task.classified` 格式驗證：新格式 `"分類=standard L2(0.80) [action:feature]"` + 舊格式向後相容 | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 3.1
- [x] 7.4 確認現有 245 classifier 測試全部通過（零回歸） | files: `plugins/vibe/tests/classifier-and-console-filter.test.js` | depends: 5.2
- [x] 7.5 執行所有 19 個測試檔案確認無回歸（882/882 通過） | depends: 7.4

## 8. Phase 2 收尾 -- 歸檔與合併（Phase 5）
- [x] 8.1 確認 `openspec/changes/archive/2026-02-16-pipeline-catalog-phase2/` 已包含完整的 proposal/design/specs/tasks（Phase 2 歸檔已完成） | files: `openspec/changes/archive/2026-02-16-pipeline-catalog-phase2/`
- [x] 8.2 Phase 2 delta specs 合併到 `openspec/specs/`：確認 classifier/task-classifier/pipeline-skill/claude-md spec 已包含 Phase 2 內容 | files: `openspec/specs/classifier/spec.md`, `openspec/specs/task-classifier/spec.md`, `openspec/specs/pipeline-skill/spec.md`, `openspec/specs/claude-md/spec.md`
- [x] 8.3 Phase 3 delta specs 合併到 `openspec/specs/`：classifier/task-classifier/pipeline-skill 新增 Phase 3 內容 + 新增 formatter/cancel-skill spec | files: `openspec/specs/` | depends: 7.5

## 9. 版號與文件同步
- [x] 9.1 plugin.json 更新 version（1.0.41 → 1.0.42） | files: `plugins/vibe/.claude-plugin/plugin.json` | depends: 7.5
- [ ] 9.2 確認 CLAUDE.md 所有數字正確（claude-md-check 通過）：scripts 數量不變（42）、skills 不變（32）、hooks 不變（22） | depends: 9.1
- [ ] 9.3 確認驗證腳本全過（V-SK/V-AG/V-HK/V-SC） | depends: 9.1

## 10. 驗證
- [ ] 10.1 端對端手動測試：模糊 prompt → Timeline 事件顯示 Layer/信心度/matchedRule | depends: 7.5
- [ ] 10.2 端對端手動測試：`/cancel` → 選擇「分類錯誤」→ 選擇正確 pipeline → 確認 corpus + stats 寫入 | depends: 7.5
- [ ] 10.3 端對端手動測試：累積修正到觸發 adaptive threshold（修正率 > 30%）→ 確認閾值變為 0.5 | depends: 7.5
- [ ] 10.4 端對端手動測試：`/vibe:pipeline`（無參數）→ AskUserQuestion 選擇器 → 選擇 pipeline → `[pipeline:xxx]` 語法注入 | depends: 7.5
- [ ] 10.5 確認 `VIBE_CLASSIFIER_THRESHOLD` 環境變數仍能覆寫 adaptive threshold | depends: 7.5
