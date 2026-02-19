# 實作任務

## 0. Phase 0：Context Protocol（v3.2）

> 目標：解決資訊洩漏，不改路由邏輯。最低風險起步。

- [x] 0.1 新增 `atomic-write.js` 工具函式 | files: `plugins/vibe/scripts/lib/flow/atomic-write.js`
  - atomicWrite(filePath, data)：寫入 .tmp + fs.renameSync
  - 單元測試覆蓋：正常寫入、目錄不存在建立、JSON 序列化

- [x] 0.2 修改 4 個品質 agent .md（context_file 寫入 + 回應格式約束 + Self-Refine）| files: `plugins/vibe/agents/code-reviewer.md`, `plugins/vibe/agents/tester.md`, `plugins/vibe/agents/qa.md`, `plugins/vibe/agents/e2e-runner.md`
  - 新增「Pipeline 模式回應格式」段落：先寫入 context_file → 最終回應只含結論 + PIPELINE_VERDICT
  - 新增「context_file 寫入指令」：路徑 `~/.claude/pipeline-context-{sessionId}-{stage}.md`，大小上限 5000 chars
  - 新增「Self-Refine 迴圈」段落：Phase 1 審查 → Phase 2 自我挑戰 → Phase 3 最終裁決
  - 注意：Phase 0 仍用 PIPELINE_VERDICT，Phase 1 才改為 PIPELINE_ROUTE

- [x] 0.3 修改 security-reviewer.md（context_file + Self-Refine）| files: `plugins/vibe/agents/security-reviewer.md`
  - 同 0.2 模式，但安全審查專用的 Self-Refine 判斷指引

- [x] 0.4 修改 5 個 IMPL agent .md（context_file 讀取指令）| files: `plugins/vibe/agents/developer.md`, `plugins/vibe/agents/planner.md`, `plugins/vibe/agents/architect.md`, `plugins/vibe/agents/designer.md`, `plugins/vibe/agents/doc-updater.md`
  - 新增「context_file 讀取」段落：如果委派 prompt 含 context_file 路徑，先 Read 該檔案
  - developer.md 額外說明：回退時優先讀取 context_file 了解問題

- [x] 0.5 修改 pipeline-controller.js onStageComplete() systemMessage | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
  - FAIL 回退時 systemMessage 不含品質報告內容，只含路由指令（如「REVIEW FAIL -> 委派 /vibe:dev」）
  - systemMessage 長度 < 200 tokens
  - 品質階段完成後 qualityWarning 精簡（不重複報告內容）
  - 不改 parseVerdict/shouldRetryStage 呼叫（Phase 0 不改路由邏輯）

- [x] 0.6 修改 session-cleanup.js 新增 context file 清理 | files: `plugins/vibe/scripts/hooks/session-cleanup.js`
  - 新增 `pipeline-context-*.md` 清理（> 3 天）
  - 沿用現有 cleanStaleFiles() 模式

- [x] 0.7 Phase 0 驗證 | depends: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6
  - 執行現有 28 個測試檔確認全過（+ atomic-write.test.js = 29 個）
  - 驗證 systemMessage 精簡（FAIL 回退場景 < 200 tokens）
  - git tag `vibe-pipeline/v4-phase-0`

---

## 1. Phase 1：PIPELINE_ROUTE 協議（v4.0-alpha）

> 目標：結構化路由指令取代 verdict regex。

- [x] 1.1 新增 `route-parser.js` | files: `plugins/vibe/scripts/lib/flow/route-parser.js`
  - parseRoute(transcriptPath)：從 JSONL transcript 解析 PIPELINE_ROUTE JSON（掃描最後 30 行）
  - validateRoute(parsed)：Schema Validation（verdict/route 合法值、FAIL 缺 severity 補 MEDIUM、BARRIER 必有 barrierGroup）
  - enforcePolicy(route, state, stage)：Policy Enforcement（PASS+DEV→NEXT、retries>=max→NEXT、no-DEV→NEXT、parallel→BARRIER）
  - 單元測試：正常解析、各種格式錯誤、fallback、所有 Policy 規則
  - 注意：convertVerdictToRoute MEDIUM/LOW → route='NEXT'（保留 v3 shouldRetryStage severity 規則）

- [x] 1.2 重寫 `retry-policy.js` | files: `plugins/vibe/scripts/lib/flow/retry-policy.js`
  - shouldStop(stage, verdict, retryCount, retryHistory, maxRetries)
  - 條件：PASS → stop / retryCount >= maxRetries → stop / 趨勢分析（非停止，僅記錄）
  - 收斂停滯改為 detectStagnation() 純觀察，不觸發 stop（確保 retryCount < maxRetries 時仍可回退）
  - 保留 shouldRetryStage() 作為向後相容（標記 deprecated），Phase 5 移除
  - 更新 retry-policy.test.js

- [x] 1.3 新增 `reflection.js` | files: `plugins/vibe/scripts/lib/flow/reflection.js`
  - writeReflection(sessionId, stage, verdict, retryCount)：Markdown append 模式，每輪 <= 500 chars，總計 <= 3000 chars
  - readReflection(sessionId, failedStage)：讀取反思檔案
  - cleanReflections(sessionId)：清理指定 session 的所有反思檔案
  - cleanReflectionForStage(sessionId, stage)：PASS 後刪除特定 stage 的反思
  - 單元測試

- [x] 1.4 修改 pipeline-controller.js onStageComplete() | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 1.1, 1.2, 1.3
  - 引入 route-parser.parseRoute() 取代 verdict.parseVerdict()（保留 fallback：parseRoute 失敗時回退到 parseVerdict）
  - 引入 shouldStop() 取代 shouldRetryStage()
  - FAIL 回退時呼叫 writeReflection()
  - PASS 後呼叫 cleanReflectionForStage()
  - 新增 state.retryHistory[stage] 追加邏輯
  - 更新 FAIL 回退 systemMessage（引用 context_file 路徑而非報告內容）

- [x] 1.5 修改 registry.js 新增 PIPELINE_ROUTE_REGEX | files: `plugins/vibe/scripts/lib/registry.js`
  - 新增 `PIPELINE_ROUTE_REGEX = /<!-- PIPELINE_ROUTE:\s*([\s\S]*?)\s*-->/`
  - exports 新增 PIPELINE_ROUTE_REGEX
  - 保留 VERDICT_REGEX

- [x] 1.6 修改品質 agent .md（PIPELINE_VERDICT → PIPELINE_ROUTE）| files: `plugins/vibe/agents/code-reviewer.md`, `plugins/vibe/agents/tester.md`, `plugins/vibe/agents/qa.md`, `plugins/vibe/agents/e2e-runner.md`, `plugins/vibe/agents/security-reviewer.md`
  - 結論標記從 `<!-- PIPELINE_VERDICT: PASS/FAIL:severity -->` 改為 `<!-- PIPELINE_ROUTE: { "verdict":"...", "route":"...", ... } -->`
  - 新增 route 決策邏輯指引（根據 Node Context 的 onFail）
  - 新增 hint 欄位指引（簡短描述問題摘要，<= 200 字）

- [x] 1.7 修改 IMPL agent .md（PIPELINE_ROUTE 輸出）| files: `plugins/vibe/agents/developer.md`, `plugins/vibe/agents/planner.md`, `plugins/vibe/agents/architect.md`, `plugins/vibe/agents/designer.md`, `plugins/vibe/agents/doc-updater.md`
  - 新增固定 PIPELINE_ROUTE 輸出：`{ "verdict":"PASS", "route":"NEXT" }`
  - developer.md 額外：可選 context_file 欄位（實作摘要）

- [x] 1.8 修改 Timeline schema + formatter | files: `plugins/vibe/scripts/lib/timeline/schema.js`, `plugins/vibe/scripts/lib/timeline/formatter.js`
  - schema.js 新增 ROUTE_FALLBACK / RETRY_EXHAUSTED 事件類型（23→25 種）
  - formatter.js 新增對應事件的格式化邏輯

- [x] 1.9 修改 session-cleanup.js 新增 reflection memory 清理 | files: `plugins/vibe/scripts/hooks/session-cleanup.js`
  - 新增 `reflection-memory-*.md` 清理（> 3 天）

- [x] 1.10 Phase 1 驗證 | depends: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
  - 新增 route-parser.test.js（36 passed）
  - 新增 reflection.test.js（12 passed）
  - 更新 retry-policy.test.js（43 passed）
  - 更新 timeline.test.js（55 passed）
  - 更新 e2e-hook-chain.test.js（146 passed）
  - 更新 pipeline-catalog-validation.test.js（377 passed）
  - 全部 28 個測試檔 0 失敗

---

## 2. Phase 2：Node Context 動態注入（v4.0-beta）

> 目標：每個 stage 委派時注入完整 Node Context。

- [x] 2.1 新增 `node-context.js` | files: `plugins/vibe/scripts/lib/flow/node-context.js`
  - buildNodeContext(dag, state, stage, sessionId)：生成 NodeContext JSON
    - node: { stage, prev, next, onFail: { target, maxRetries, currentRound }, barrier }
    - context_files: 前驅 stage 的 contextFile 路徑陣列
    - env: state.environment 快照
    - retryContext: getRetryContext() 結果
  - getRetryContext(sessionId, stage, state)：透過 retries + dag.onFail 反向查找 failedStage，讀取反思記憶
  - 單元測試

- [x] 2.2 修改 dag-state.js 新增 stages[].contextFile | files: `plugins/vibe/scripts/lib/flow/dag-state.js` | depends: 2.1
  - setDag() 初始化時 stages[].contextFile = null
  - 新增 setStageContextFile(state, stageId, contextFilePath)
  - markStageCompleted 保留 contextFile 欄位（spread 已保留）

- [x] 2.3 修改 pipeline-controller.js 注入 Node Context | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 2.1, 2.2
  - onStageComplete()：
    - 從 ROUTE.context_file 存入 state.stages[stage].contextFile
    - 委派下一個 stage 時 systemMessage 包含 buildNodeContext() JSON
    - FAIL 回退委派 DEV 時注入 retryContext
  - 分支 A（FAIL 回退）、分支 B（DEV 重跑）、分支 C（正常前進）都注入 Node Context

- [x] 2.4 修改 delegation-tracker / pipeline-controller.onDelegate() | files: `plugins/vibe/scripts/hooks/delegation-tracker.js`, `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
  - onDelegate() 新增：push stage 到 state.activeStages 陣列（soft 引入）
  - 分支 C markStageCompleted 後從 activeStages 移除已完成 stage
  - delegation-tracker hook 保持薄代理不變

- [x] 2.5 Phase 2 驗證 | depends: 2.1, 2.2, 2.3, 2.4
  - 新增 node-context.test.js（25 tests，buildNodeContext + getRetryContext + 全場景）
  - 驗證 Node Context JSON < 500 tokens（MAX_NODE_CONTEXT_CHARS = 2000 chars）
  - 驗證 context_file 透傳（前驅 stage contextFile → 後繼 stage context_files）
  - 驗證 retryContext 注入（回退時 reflectionFile 路徑正確）
  - 全部 30 個測試檔 0 失敗
  - git tag `vibe-pipeline/v4-phase-2`

---

## 3. Phase 3：Guard 簡化 + State Schema 演進（v4.0-rc）

> 目標：guard 從 5 phases 簡化為 pipelineActive 布林值。**高風險 Phase，建議用 `[pipeline:fix]` 實作。**

- [x] 3.1 修改 dag-state.js v4 state schema | files: `plugins/vibe/scripts/lib/flow/dag-state.js`
  - createInitialState() 新增欄位：
    - pipelineActive: false
    - activeStages: []
    - retryHistory: {}
    - crashes: {}
  - 移除 Phase 5 才實際刪除的欄位（Phase 3 先新增 pipelineActive，保留 enforced 向後相容）
  - setDag() 同步設定 pipelineActive = true
  - cancel() 設定 pipelineActive = false（取代 meta.cancelled）
  - derivePhase() v4 版本：pipelineActive=false→IDLE / activeStages.length>0→DELEGATING / 全完成→COMPLETE / 有 failed+retries→RETRYING / 其餘→CLASSIFIED
  - 新增 isActive(state) = state?.pipelineActive === true（取代 isEnforced）

- [x] 3.2 修改 state-migrator.js 新增 ensureV4() | files: `plugins/vibe/scripts/lib/flow/state-migrator.js` | depends: 3.1
  - detectVersion() 識別 version:4
  - ensureV4(state)：v3→v4 遷移
    - pipelineActive 從 derivePhase(v3) != IDLE/COMPLETE 推導
    - activeStages 從 stages 中 status=active 推導
    - retryHistory 從 retries 推導空陣列
    - crashes 為空物件
    - version 設為 4
  - 更新 pipeline-controller.js loadState() 使用 ensureV4
  - 單元測試：v3→v4 遷移正確性

- [x] 3.3 重寫 guard-rules.js | files: `plugins/vibe/scripts/lib/sentinel/guard-rules.js` | depends: 3.1
  - evaluate() 簡化為 ~50 行：
    1. EnterPlanMode → block
    2. Bash DANGER_PATTERNS → block
    3. !state?.pipelineActive → allow
    4. Task/Skill → allow
    5. READ_ONLY_TOOLS → allow
    6. 其他 → block
  - 移除 derivePhase/getPhase/isDelegating/isEnforced/isCancelled/isInitialized import
  - 移除 CANCEL_STATE_FILE_RE
  - 保留 evaluateBashDanger/detectBashWriteTarget/isNonCodeFile/buildDelegateHint/STAGE_SKILL_MAP
  - 阻擋訊息統一為「你是訊息匯流排（Relay）」

- [x] 3.4 修改 pipeline-controller.js 配合 v4 state schema | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 3.1, 3.2
  - classify()：DAG 建立後 state.pipelineActive = true
  - onStageComplete()：最後一個 stage 完成時 state.pipelineActive = false
  - onStageComplete()：更新 state.activeStages（pop 完成的 stage）
  - onDelegate()：push activeStages
  - cancel：直接設 pipelineActive = false（移除 meta.cancelled 操作）

- [x] 3.5 修改 pipeline-controller.js onSessionStop() | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 3.1
  - 從 state.pipelineActive 判斷是否需要阻擋
  - 移除 state.enforced 檢查
  - 移除 derivePhase 呼叫（改用 pipelineActive + activeStages）

- [x] 3.6 統一 atomicWrite 寫入 | files: `plugins/vibe/scripts/lib/flow/dag-state.js`, `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 0.1
  - dag-state.js writeState() 改用 atomicWrite()
  - pipeline-controller 所有 ds.writeState 呼叫已透過 dag-state，不需額外修改

- [x] 3.7 修改 cancel skill 簡化 | files: `plugins/vibe/skills/cancel/SKILL.md`
  - cancel 流程：呼叫 controller API 設定 pipelineActive=false
  - 移除 v3 的 state file 直接寫入邏輯（改為 Skill→controller API→atomicWrite）

- [x] 3.8 Phase 3 驗證 | depends: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
  - 重寫 guard-rules.test.js（全面覆蓋 pipelineActive 邏輯）
  - 重寫 cancel-and-guard.test.js（v4 cancel 流程）
  - 更新 pipeline-catalog-validation.test.js（v4 state schema）
  - 新增 state-migrator v3→v4 測試
  - 執行全部測試確認通過
  - git tag `vibe-pipeline/v4-phase-3`

---

## 4. Phase 4：Barrier 並行（v4.0）

> 目標：並行節點同步機制。**高風險 Phase，需先驗證 ECC 並行 Task 行為。**

- [x] 4.1 ECC 並行 Task 實驗驗證
  - 實驗：在 ECC 中發送包含兩個 Task tool_use blocks 的 response
  - 觀察：(1) 兩個 Sub-agent 是否同時啟動 (2) SubagentStop hooks 的觸發順序 (3) Main Agent 是否收到兩個 tool_result
  - 記錄結果到 `docs/ref/pipeline-v4.md` 的 5.3 節
  - 結論：ECC 支持並行 Task（有多個 tool_use blocks），但 barrier 計數器設計無損退化（序列收集也正確運作）

- [x] 4.2 新增 `barrier.js` | files: `plugins/vibe/scripts/lib/flow/barrier.js`
  - readBarrier(sessionId) / writeBarrier(sessionId, barrierState)：使用 atomicWrite
  - createBarrierGroup(group, total, next, siblings)
  - updateBarrier(sessionId, group, stage, routeResult)：更新 completed + results，返回 { allComplete, mergedResult? }
  - mergeBarrierResults(barrier, sessionId)：Worst-Case-Wins 合併 + 合併 context_files
  - checkTimeout(barrier, group, timeoutMs?)：5 分鐘超時偵測
  - rebuildBarrierFromState(state)：從主 state 重建損毀的 barrier
  - deleteBarrier(sessionId)：清理
  - 單元測試（barrier.test.js 15 個測試全過）

- [x] 4.3 修改 dag-utils.js 新增 templateToDag() | files: `plugins/vibe/scripts/lib/flow/dag-utils.js` | depends: 4.2
  - templateToDag(pipelineId, stages)：自動加入 next/onFail/maxRetries/barrier 欄位
  - BARRIER_CONFIG 定義 full/standard/quick-dev 的並行節點設定
  - onFail 規則：QUALITY→最近的 IMPL（通常 DEV）、IMPL→null
  - 保留 linearToDag() 作為向後相容（templateToDag 內部呼叫）
  - 單元測試（template-dag.test.js 43 個測試全過）

- [x] 4.4 修改 pipeline-controller.js classify() 使用 templateToDag | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 4.3
  - 已知模板改用 templateToDag()（取代 linearToDag）
  - templateToDag 生成的 DAG 含 barrier/onFail/next

- [x] 4.5 修改 pipeline-controller.js onStageComplete() 處理 BARRIER | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js` | depends: 4.2, 4.4
  - route === 'BARRIER' 時：updateBarrier → allComplete=false 等待 / allComplete=true 合併繼續
  - route === 'ABORT' 時：pipelineActive=false + PIPELINE_ABORTED 事件
  - CRASH 處理：QUALITY stage + transcript 有 assistant 訊息但無路由 → 重新委派（< 3 次），≥ 3 次 ABORT
  - CRASH 條件精確：只針對 QUALITY stages + transcript 確實有 assistant 訊息（避免測試場景誤觸）

- [x] 4.6 修改 stage-transition.js 和 delegation-tracker.js | files: `plugins/vibe/scripts/hooks/stage-transition.js`, `plugins/vibe/scripts/hooks/delegation-tracker.js` | depends: 4.5
  - stage-transition：薄代理不變，barrier 邏輯由 controller 封裝
  - delegation-tracker：activeStages push 支援並行場景（已在 Phase 2 實作）

- [x] 4.7 修改 session-cleanup.js + pipeline-init.js | files: `plugins/vibe/scripts/hooks/session-cleanup.js`, `plugins/vibe/scripts/hooks/pipeline-init.js` | depends: 4.2
  - session-cleanup：新增 `barrier-state-*.json` 清理（> 3 天）
  - pipeline-resume：resume 時複製 barrier state 到新 session

- [x] 4.8 修改 Timeline schema + formatter（v4 事件補全）| files: `plugins/vibe/scripts/lib/timeline/schema.js`, `plugins/vibe/scripts/lib/timeline/formatter.js`
  - 新增 BARRIER_WAITING / BARRIER_RESOLVED / AGENT_CRASH / PIPELINE_ABORTED（25→29 種事件）
  - formatter 新增對應事件格式化

- [x] 4.9 修改 Dashboard 並行狀態顯示 | files: `plugins/vibe/web/index.html`, `plugins/vibe/server.js`
  - web/index.html：barrier 進度視覺化（group/完成數/stage 狀態圖示）
  - server.js：新增 barrier 事件廣播 + eventCat 涵蓋 barrier 事件

- [x] 4.10 Phase 4 驗證 | depends: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
  - 新增 barrier.test.js（15 個測試全過）
  - 新增 template-dag.test.js（43 個測試全過）
  - 修復 e2e-hook-chain.test.js CRASH 分支條件（146/146 全過）
  - 修復 timeline.test.js 事件數量斷言（25→29，55/55 全過）
  - 修復 design-pipeline-stage.test.js E2E 跳過（31/31 全過）
  - 全部 33 個測試檔執行，0 失敗
  - git tag `vibe-pipeline/v4-phase-4`

---

## 5. Phase 5：清理 + 文件同步（v4.1）

> 目標：移除 v3 死碼，同步所有文件。

- [ ] 5.1 移除 verdict.js | files: `plugins/vibe/scripts/lib/flow/verdict.js`, `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
  - 刪除 verdict.js 或標記 deprecated
  - 移除 controller 中 parseVerdict fallback 路徑
  - 移除 registry.js VERDICT_REGEX（或保留標記 deprecated）

- [ ] 5.2 清理 dag-state.js v3 欄位 | files: `plugins/vibe/scripts/lib/flow/dag-state.js`
  - 移除 enforced 欄位（createInitialState + setDag）
  - 移除 pendingRetry 欄位（setPendingRetry/clearPendingRetry/getPendingRetry）
  - 移除 meta.cancelled（被 pipelineActive=false 取代）
  - 移除 isEnforced()（被 isActive 取代）
  - derivePhase() 保留但只用 v4 邏輯
  - ~~移除向後相容函式（ensureV3 不再需要）~~ ✅ v2.0.12 已完成

- [ ] 5.3 清理 pipeline-controller.js v3 殘留 | files: `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
  - 移除 shouldRetryStage import
  - 移除 v3 回退邏輯（pendingRetry 分支）
  - 移除 v3 升級/降級判斷中的 v3 概念
  - 清理 buildStageContext 和 buildDelegationHint 中的 v3 相容邏輯

- [ ] 5.4 Dashboard/Remote 適配 v4 | files: `plugins/vibe/web/index.html`, `plugins/vibe/bot.js`, `plugins/vibe/scripts/lib/remote/remote-hub.js`
  - adaptV3() 改名為 adaptV4() 或移除（直讀 v4 state）
  - bot.js handleStatus/handleStages 使用 pipelineActive + activeStages
  - remote-hub.js 語義清理

- [ ] 5.5 更新 CLAUDE.md + 設計文件 | files: `CLAUDE.md`, `docs/ref/pipeline.md`, `docs/ref/pipeline-v4.md`
  - CLAUDE.md：v4 架構描述（pipelineActive、PIPELINE_ROUTE、Barrier、Node Context）
  - pipeline.md：v4 文件更新
  - pipeline-v4.md：標記為「已實作」

- [ ] 5.6 測試清理 | files: `plugins/vibe/tests/*.test.js`
  - 移除 v3 相關斷言（enforced/pendingRetry/meta.cancelled/PIPELINE_VERDICT）
  - 更新 pipeline-system.test.js 的 stage 映射
  - 確保所有測試使用 v4 API

- [ ] 5.7 OpenSpec 歸檔 | files: `openspec/changes/pipeline-v4-implementation/`, `openspec/changes/archive/`, `openspec/specs/`
  - 歸檔 change 到 `openspec/changes/archive/{date}-pipeline-v4-implementation/`
  - 合併 delta specs 到 `openspec/specs/flow/spec.md` 等

- [ ] 5.8 Phase 5 驗證 | depends: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
  - 確認無 v3 死碼殘留（grep PIPELINE_VERDICT / enforced / pendingRetry / meta.cancelled）
  - 執行全部測試確認通過
  - 確認 CLAUDE.md 與實作完全同步
  - docs/plugin-specs.json 數字同步
  - 更新 plugin.json 版號
  - git tag `vibe-pipeline/v4-phase-5`

---

## 6. 跨 Phase 驗證

- [ ] 6.1 每個 Phase 完成後執行全部 28+ 測試檔
- [ ] 6.2 確認 lint/format 通過
- [ ] 6.3 確認文件同步（CLAUDE.md + docs/ref/）
- [ ] 6.4 確認 dashboard-refresh 自動同步鏈正常
