# Flow 模組 Delta Spec

## ADDED Requirements

### Requirement: PIPELINE_ROUTE 協議

Sub-agent 在輸出末尾附加結構化路由指令 `<!-- PIPELINE_ROUTE: {...} -->`，取代 v3 的 `<!-- PIPELINE_VERDICT: ... -->`。JSON 包含 verdict（PASS/FAIL）、route（NEXT/DEV/BARRIER/COMPLETE/ABORT）、severity、context_file、hint、barrierGroup 欄位。

#### Scenario: 正常解析 PIPELINE_ROUTE
WHEN stage-transition 從 agent transcript 解析到合法的 PIPELINE_ROUTE JSON
THEN parseRoute() 返回完整的 RouteResult 物件（verdict + route + 可選欄位）

#### Scenario: PIPELINE_ROUTE 解析失敗（E1 fallback）
WHEN agent transcript 中找不到 PIPELINE_ROUTE 標記（agent 遺漏或格式錯誤）
THEN parseRoute() 返回 null
AND stage-transition 使用預設值 `{ verdict: 'PASS', route: 'NEXT' }`
AND 發射 ROUTE_FALLBACK Timeline 事件

#### Scenario: QUALITY stage 解析失敗觸發重新委派
WHEN QUALITY stage（REVIEW/TEST/QA/E2E）的 PIPELINE_ROUTE 解析失敗
AND 該 stage 的 crash count < 3
THEN stage-transition 重新委派同一個 stage（不是預設 PASS）
AND state.crashes[stage] 遞增

#### Scenario: QUALITY stage 連續 crash 3 次
WHEN QUALITY stage 連續 3 次 PIPELINE_ROUTE 解析失敗
THEN 降級為 E1 fallback（PASS + warning）
AND 發射 AGENT_CRASH Timeline 事件

---

### Requirement: Schema Validation + Policy Enforcement

stage-transition 對 PIPELINE_ROUTE 執行兩層驗證：Layer 1 格式正確性、Layer 2 邏輯正確性。

#### Scenario: Schema Validation 攔截不合法 verdict
WHEN parsed PIPELINE_ROUTE 的 verdict 不在 ['PASS', 'FAIL'] 中
THEN validateRoute() 自動修正（預設為 PASS）並記錄 warning 欄位，不返回 null

#### Scenario: Schema Validation 攔截不合法 route
WHEN parsed PIPELINE_ROUTE 的 route 不在 ['NEXT', 'DEV', 'BARRIER', 'COMPLETE', 'ABORT'] 中
THEN validateRoute() 自動設定預設 route（PASS→NEXT, FAIL→DEV）並記錄 warning 欄位，不返回 null

#### Scenario: FAIL 缺少 severity 自動補全
WHEN verdict 為 FAIL 且 severity 欄位缺失
THEN validateRoute() 自動設定 severity = 'MEDIUM'

#### Scenario: Policy Enforcement 修正 PASS + DEV 矛盾
WHEN verdict 為 PASS 但 route 為 DEV
THEN enforcePolicy() 強制將 route 改為 NEXT
AND 附加 warning 欄位說明策略覆寫

#### Scenario: Policy Enforcement 攔截超限重試
WHEN route 為 DEV 且 state.retries[stage] >= maxRetries
THEN enforcePolicy() 強制將 route 改為 NEXT
AND 附加 warning 欄位說明重試上限

#### Scenario: Policy Enforcement 強制並行節點使用 BARRIER
WHEN stage 有 barrier 配置但 route 不是 BARRIER
THEN enforcePolicy() 強制將 route 改為 BARRIER
AND 自動補全 barrierGroup 欄位

#### Scenario: Policy Enforcement 偵測無 DEV 的 FAIL 回退
WHEN route 為 DEV 但 DAG 中不存在 DEV stage
THEN enforcePolicy() 強制將 route 改為 NEXT
AND 附加 warning 說明無 DEV 可回退

---

### Requirement: context_file 物理隔離

品質報告寫入暫存檔 `~/.claude/pipeline-context-{sid}-{stage}.md`，Main Agent 只在 systemMessage 中看到路徑，不看到內容。

#### Scenario: 品質 agent 寫入 context_file
WHEN QUALITY agent（REVIEW/TEST/QA/E2E）完成審查
THEN agent 先將完整報告寫入 `~/.claude/pipeline-context-{sessionId}-{stage}.md`
AND PIPELINE_ROUTE 的 context_file 欄位包含該路徑
AND agent 最終回應只含一行結論 + PIPELINE_ROUTE 標記

#### Scenario: stage-transition systemMessage 不含報告內容
WHEN 品質 stage FAIL 回退到 DEV
THEN systemMessage 只包含路由指令（如「DEV FAIL -> 委派 /vibe:dev」）
AND systemMessage 不包含品質報告特徵字串（C-1/H-1/CRITICAL 等問題描述）
AND systemMessage 長度 < 200 tokens

#### Scenario: DEV agent 讀取 context_file
WHEN DEV agent 被回退委派且 Node Context 含 context_files 路徑
THEN DEV agent 使用 Read 工具讀取 context_file 內容
AND 根據報告中的問題進行修復

#### Scenario: context_file 不存在時降級（E6/E13）
WHEN DEV agent 嘗試讀取 context_file 但檔案不存在
THEN DEV agent 從 Node Context 的 hint 欄位取得提示
AND 使用 Grep/Glob 自行定位問題
AND 正常完成工作並輸出 PIPELINE_ROUTE

#### Scenario: session-cleanup 清理 context files
WHEN SessionStart hook 觸發
THEN session-cleanup 清理過時的 `pipeline-context-*.md` 檔案（> 3 天）

---

### Requirement: Node Context 動態注入

每個 stage 委派時注入 Node Context JSON（prev/next/onFail/barrier/env/retryContext）。

#### Scenario: 首次委派注入 Node Context
WHEN stage-transition 決定委派下一個 stage
THEN buildNodeContext() 生成包含 node（stage/prev/next/onFail/barrier）、context_files、env、retryContext 的 JSON
AND JSON 注入到 systemMessage 中
AND JSON 大小 < 500 tokens

#### Scenario: 回退委派注入 retryContext
WHEN DEV stage 因 REVIEW FAIL 而被回退委派
THEN Node Context 的 retryContext 包含 round、reflectionFile 路徑、failedStage
AND retryContext.hint 提示 agent 先閱讀反思記憶

#### Scenario: context_file 透傳
WHEN 前驅 stage 完成且 ROUTE 含 context_file
THEN context_file 路徑存入 state.stages[stage].contextFile
AND 後繼 stage 的 Node Context 的 context_files 陣列包含該路徑

#### Scenario: 並行節點的 Node Context 包含 barrier 資訊
WHEN stage 被委派且 DAG 中含 barrier 配置
THEN Node Context 的 node.barrier 包含 group、total、siblings 欄位

---

### Requirement: Reflexion Memory

跨迭代反思記憶檔案 `reflection-memory-{sid}-{stage}.md`，記錄每輪 FAIL 的反思摘要。

#### Scenario: FAIL 回退時寫入反思
WHEN stage-transition 處理 FAIL 回退
THEN writeReflection() 在 `~/.claude/reflection-memory-{sid}-{failedStage}.md` 追加一個 Round section
AND 包含 Verdict、失敗 stage、關鍵問題、context_file 路徑
AND 每輪反思 <= 500 chars

#### Scenario: 反思記憶累積上限
WHEN 反思檔案總大小 >= 3000 chars
THEN 自動截斷最舊的 Round section，保留最近 5 輪

#### Scenario: PASS 後清理反思記憶
WHEN 之前 FAIL 的 stage 最終 PASS
THEN 刪除對應的 reflection-memory 檔案

#### Scenario: session-cleanup 清理反思記憶
WHEN SessionStart hook 觸發
THEN 清理過時的 `reflection-memory-*.md` 檔案（> 3 天）

---

### Requirement: shouldStop 多維收斂條件

取代 v3 的 shouldRetryStage()，2 條件觸發停止（PASS / MAX_RETRIES）+ 2 觀察信號（收斂停滯 / 趨勢下降）判斷迭代行為。

#### Scenario: PASS 觸發停止
WHEN verdict 為 PASS
THEN shouldStop() 返回 `{ stop: true, reason: 'quality-gate-passed', action: 'NEXT' }`

#### Scenario: MAX_RETRIES 觸發停止
WHEN retryCount >= maxRetries
THEN shouldStop() 返回 `{ stop: true, reason: 'max-retries-exhausted', action: 'FORCE_NEXT' }`

#### Scenario: 收斂停滯為觀察信號（不觸發停止）
WHEN retryHistory 最近 2 輪的 severity 相同
THEN shouldStop() 返回 `{ stop: false, reason: 'convergence-stall-observed', action: 'RETRY' }`
AND 包含 warning 描述停滯狀態

> **v4 設計決策**：收斂停滯不觸發強制停止，僅記錄觀察。迭代仍繼續直到 PASS 或 MAX_RETRIES 耗盡。

#### Scenario: 趨勢改善不觸發停止
WHEN retryHistory 最近一輪 severity 低於前一輪
THEN shouldStop() 返回 `{ stop: false, action: 'RETRY' }`
AND 包含 note 描述改善趨勢

---

### Requirement: Barrier 並行計數器

並行節點透過 barrier 同步，使用獨立的 `barrier-state-{sid}.json`。

#### Scenario: 建立 Barrier
WHEN stage-transition 需要委派多個並行 stage
THEN 建立 barrier group（total/completed/results/next/startTime/resolved）
AND 寫入 `barrier-state-{sid}.json`

#### Scenario: 更新 Barrier（部分完成）
WHEN 並行 stage 之一完成且 barrier 未全到齊
THEN updateBarrier() 更新 completed 和 results
AND 不產出 systemMessage（等待其他 stage）

#### Scenario: 全到齊 + 全 PASS
WHEN barrier 所有 stage 都完成且全部 PASS
THEN mergeBarrierResults() 返回 `{ verdict: 'PASS', route: 'NEXT', target: barrier.next }`
AND 委派 barrier.next stage

#### Scenario: 全到齊 + 有 FAIL（Worst-Case-Wins）
WHEN barrier 所有 stage 都完成且至少一個 FAIL
THEN mergeBarrierResults() 取嚴重度最高的 FAIL
AND 合併所有 FAIL 的 context_files 到 `pipeline-context-{sid}-MERGED.md`
AND 返回 `{ verdict: 'FAIL', route: 'DEV', severity: highest, context_file: merged }`

#### Scenario: Barrier Timeout
WHEN barrier 建立超過 5 分鐘仍未全到齊
THEN checkTimeout() 返回 true
AND 強制前進到 barrier.next + warning

#### Scenario: Barrier 計數器損毀恢復
WHEN barrier-state JSON 解析失敗
THEN rebuildBarrierFromState(state) 從主 state 的 stage 完成狀態重建 barrier

#### Scenario: 跨 Barrier 回退重設
WHEN QA/E2E FAIL 回退到 DEV，跨越 post-dev barrier
THEN post-dev barrier 的 REVIEW/TEST stages 重設為 pending
AND barrier-state 的 post-dev group 重設（completed:[], results:{}, resolved:false）

---

### Requirement: templateToDag 模板升級

v4 的 DAG 節點含 next/onFail/maxRetries/barrier 欄位，取代 v3 的純 deps 結構。

#### Scenario: standard pipeline 生成含 barrier 的 DAG
WHEN templateToDag('standard', ['PLAN','ARCH','DEV','REVIEW','TEST','DOCS'])
THEN DAG 中 REVIEW 和 TEST 有 barrier.group = 'post-dev'
AND REVIEW.onFail = 'DEV', TEST.onFail = 'DEV'
AND REVIEW.maxRetries = 3, TEST.maxRetries = 3
AND REVIEW.next = ['DOCS'], TEST.next = ['DOCS']
AND DOCS.deps = ['REVIEW', 'TEST']

#### Scenario: fix pipeline 不生成 barrier
WHEN templateToDag('fix', ['DEV'])
THEN DAG 只有 DEV 節點
AND DEV.onFail = null, DEV.barrier = null

#### Scenario: test-first pipeline 序列處理
WHEN templateToDag('test-first', ['TEST','DEV','TEST'])
THEN DAG 中 TEST 出現兩次（TEST:write, TEST:verify）
AND 無 barrier（序列執行）
AND TEST:verify.onFail = 'DEV'

---

### Requirement: Atomic Write

所有 state 寫入使用 write-to-tmp + fs.renameSync 模式。

#### Scenario: 正常寫入
WHEN atomicWrite(filePath, data) 被呼叫
THEN 先寫入 `{filePath}.tmp`
AND 然後 fs.renameSync 到目標路徑

#### Scenario: 寫入中斷不損毀原檔
WHEN atomicWrite 寫入 .tmp 時進程中斷
THEN 原檔保持不變（.tmp 可能殘留但不影響讀取）

---

### Requirement: v3 -> v4 State 遷移

state-migrator.js 新增 ensureV4() 函式，自動將 v3 state 遷移為 v4 格式。

#### Scenario: v3 state 自動遷移
WHEN readState() 讀到 version:3 的 state
THEN ensureV4() 將其轉換為 v4 格式
AND 新增 pipelineActive（從 derivePhase != IDLE/COMPLETE 推導）
AND 新增 activeStages（從 stages 中 status=active 的項目推導）
AND 新增 retryHistory（從 retries 推導空陣列）
AND 新增 crashes（空物件）
AND 移除 enforced、meta.cancelled（pendingRetry 保留作為向後相容 fallback，v4.1 移除）

#### Scenario: v4 state 不遷移
WHEN readState() 讀到 version:4 的 state
THEN ensureV4() 直接返回不修改

---

## MODIFIED Requirements

### Requirement: onStageComplete 路由邏輯

**完整修改後內容**：

stage-transition hook 透過 controller.onStageComplete() 處理 Sub-agent 完成事件。v4 版本的處理流程：

1. 解析 PIPELINE_ROUTE（parseRoute），失敗時觸發 E1 fallback
2. Schema Validation + Policy Enforcement（validateRoute + enforcePolicy）
3. shouldStop() 多維收斂判斷（取代 v3 的 shouldRetryStage）
4. FAIL 回退時 writeReflection() 記錄反思
5. 更新 pipeline-state（markStageCompleted/markStageFailed + retryHistory 追加）
6. 生成下一個 Node Context（buildNodeContext + getRetryContext）
7. 處理 BARRIER route（updateBarrier → 全到齊時 mergeBarrierResults）
8. 產出 systemMessage（路由指令 + Node Context JSON）

### Requirement: onDelegate 委派追蹤

**完整修改後內容**：

delegation-tracker hook 透過 controller.onDelegate() 追蹤委派事件。v4 版本新增：

1. 將 stage push 到 state.activeStages 陣列（並行時多個）
2. 記錄 agent->stage 映射（供 stage-transition 反查）
3. pendingRetry 防護（v3 邏輯保留）
4. markStageActive 標記

### Requirement: pipeline-controller.classify 分類邏輯

**完整修改後內容**：

classify() 在 v4 中的變更：

1. 已知模板使用 templateToDag()（取代 linearToDag）生成含 barrier/onFail/next 的 DAG
2. DAG 建立後設定 state.pipelineActive = true（Phase 3 以後）
3. none pipeline 不設 pipelineActive
4. 其餘分類邏輯不變（LLM-first + Layer 1 顯式）

### Requirement: session-cleanup 清理範圍

**完整修改後內容**：

session-cleanup 在 v4 中新增 3 類檔案清理：

1. `pipeline-context-*.md`（context file，> 3 天）
2. `reflection-memory-*.md`（反思記憶，> 3 天）
3. `barrier-state-*.json`（barrier state，> 3 天）

清理邏輯沿用現有 `cleanStaleFiles()` 模式。

---

## REMOVED Requirements

### Requirement: PIPELINE_VERDICT 協議

Reason: 被 PIPELINE_ROUTE 協議取代。PIPELINE_VERDICT 只有 PASS/FAIL:severity 兩種格式，無法表達路由指令（NEXT/DEV/BARRIER/COMPLETE/ABORT）和 context_file 路徑。

Migration: Phase 0-1 期間 verdict.js 保留作為 fallback。Phase 5 移除 verdict.js 和 registry.js 的 VERDICT_REGEX。Agent .md 從 `<!-- PIPELINE_VERDICT: ... -->` 遷移到 `<!-- PIPELINE_ROUTE: {...} -->`。

### Requirement: shouldRetryStage 單維判斷

Reason: 被 shouldStop 多維收斂條件取代。v3 的 shouldRetryStage 只看 verdict + retryCount，缺少收斂停滯偵測和趨勢分析。

Migration: Phase 1 重寫 retry-policy.js。controller.onStageComplete() 從 shouldRetryStage() 切換到 shouldStop()。測試從 retry-policy.test.js 中更新。

### Requirement: derivePhase 5-phase 路由判斷

Reason: Guard 簡化為 pipelineActive 布林值後，derivePhase 不再用於路由判斷。保留為 Dashboard/Timeline 顯示用途，但邏輯簡化（v4 版本 5 條件短路，不依賴 enforced/pendingRetry/meta.cancelled）。

Migration: Phase 3 重寫 guard-rules.js 移除 derivePhase 依賴。dag-state.js 的 derivePhase() 改為 v4 邏輯。isEnforced() 移除（被 pipelineActive 取代）。

### Requirement: v3 pendingRetry 機制

Reason: **DEFERRED REMOVAL**：v4 保留 pendingRetry 作為向後相容層，計劃在 v4.1 完全移除。v4 新增的 PIPELINE_ROUTE 驅動回退與 pendingRetry 並存，pendingRetry 作為 fallback。v4 的回退主要由 PIPELINE_ROUTE 的 route:DEV 指令驅動，retryHistory 記錄完整歷史，shouldStop() 從歷史中判斷。

Migration: Phase 3 保留 setPendingRetry/clearPendingRetry/getPendingRetry 作為 fallback。controller.onDelegate() 優先從 retryHistory + stage status 判斷，pendingRetry 作為次要防護。Phase 5（v4.1）完全移除 pendingRetry。

### Requirement: enforced 欄位

Reason: v4 使用 pipelineActive 布林值取代。pipelineActive 語意更清晰（pipeline 是否正在執行），不需要從多個條件推導。

Migration: Phase 3 從 dag-state.js 的 state schema 移除 enforced。isEnforced() 移除。guard-rules 改用 pipelineActive。
