# 架構設計：Pipeline v4 分散式節點自治架構

## 現有結構分析

### 目錄結構概覽

Pipeline 核心位於 `plugins/vibe/scripts/lib/flow/`，6 個 hook 腳本在 `scripts/hooks/`：

```
scripts/lib/flow/
├── dag-state.js          ← v3 核心：state CRUD + derivePhase()（427 行）
├── dag-utils.js          ← DAG 工具：linearToDag/validateDag/topologicalSort（188 行）
├── pipeline-controller.js ← 統一 API：classify/canProceed/onDelegate/onStageComplete/onSessionStop（697 行）
├── verdict.js            ← PIPELINE_VERDICT 解析（49 行）
├── retry-policy.js       ← shouldRetryStage()（52 行）
├── skip-predicates.js    ← 階段跳過判斷（50 行）
├── state-migrator.js     ← v2->v3 遷移（168 行）
├── classifier.js         ← LLM-first 分類器
├── pipeline-discovery.js ← pipeline.json 動態發現
├── pipeline-resume.js    ← 跨 session 接續
├── env-detector.js       ← 環境偵測
└── counter.js            ← compact 計數

scripts/lib/sentinel/
└── guard-rules.js        ← Guard 規則（282 行）

scripts/hooks/
├── task-classifier.js    ← UserPromptSubmit: classify()
├── delegation-tracker.js ← PreToolUse(Task): onDelegate()
├── pipeline-guard.js     ← PreToolUse(*): canProceed()
├── stage-transition.js   ← SubagentStop: onStageComplete()
├── pipeline-check.js     ← Stop: onSessionStop()
├── pipeline-init.js      ← SessionStart: 環境偵測 + state 初始化
└── session-cleanup.js    ← SessionStart: 清理孤兒進程/過時檔案
```

### 關鍵模式與慣例

1. **Hook 薄代理模式**：所有 hook 腳本使用 `safeRun()` 包裹，核心邏輯在 `pipeline-controller.js`
2. **DAG 宣告式 State**：`pipeline-state-{sid}.json` 記錄全域狀態，phase 由 `derivePhase()` 推導
3. **registry.js Single Source of Truth**：所有 stage/agent/pipeline metadata 定義在此
4. **純函式模組**：verdict.js、retry-policy.js、skip-predicates.js、guard-rules.js 為純函式
5. **Timeline emit**：所有 hook 在關鍵路徑上發射 Timeline 事件
6. **Session 隔離**：State 檔案路徑含 `{sessionId}`

### 介面邊界

```
task-classifier ─→ controller.classify()
                      ↓
delegation-tracker ─→ controller.onDelegate()
                      ↓
pipeline-guard ──→ controller.canProceed() ─→ guard-rules.evaluate()
                      ↓
stage-transition ─→ controller.onStageComplete()
                      ↓ 內部呼叫
                      ├── verdict.parseVerdict()
                      ├── retry-policy.shouldRetryStage()
                      ├── dag-state.markStage*()
                      └── skip-predicates.shouldSkip()
                      ↓
pipeline-check ──→ controller.onSessionStop()
```

---

## 方案 A：漸進式演進（Phase-by-Phase In-Place）

### 核心策略

在現有 `pipeline-controller.js` 上逐 Phase 改造，每個 Phase 是獨立的 commit boundary。v3 函式逐步被 v4 對應函式取代，保持向後相容直到 Phase 5 清理。

### 目錄樹

```
scripts/lib/flow/
├── dag-state.js          ← 擴充：新增 pipelineActive / activeStages / retryHistory / crashes
├── dag-utils.js          ← 擴充：新增 templateToDag()
├── pipeline-controller.js ← 逐 Phase 改造（保留 5 API 簽名不變）
├── route-parser.js       ← 新增：PIPELINE_ROUTE 解析 + Schema Validation + Policy Enforcement
├── reflection.js         ← 新增：Reflexion Memory 讀寫
├── barrier.js            ← 新增：Barrier 計數器 + 合併
├── node-context.js       ← 新增：buildNodeContext() + getRetryContext()
├── atomic-write.js       ← 新增：atomicWrite() 工具函式
├── verdict.js            ← Phase 0-1 保留（fallback），Phase 5 移除
├── retry-policy.js       ← Phase 1 重寫為 shouldStop()
├── skip-predicates.js    ← 不變
├── state-migrator.js     ← 擴充：ensureV4()
└── ...（其餘不變）

scripts/lib/sentinel/
└── guard-rules.js        ← Phase 3 重寫為 pipelineActive 判斷
```

### 介面定義

```javascript
// route-parser.js（新增）
parseRoute(transcriptPath) → RouteResult | null
validateRoute(parsed) → RouteResult | null   // Schema Validation
enforcePolicy(route, state, stage) → RouteResult  // Policy Enforcement

// reflection.js（新增）
writeReflection(sessionId, stage, verdict, retryCount) → void
readReflection(sessionId, failedStage) → string | null
cleanReflections(sessionId) → void

// barrier.js（新增）
readBarrier(sessionId) → BarrierState
writeBarrier(sessionId, barrierState) → void
updateBarrier(sessionId, group, stage, routeResult) → { allComplete, mergedResult? }
mergeBarrierResults(barrier, sessionId) → RouteResult
checkTimeout(barrier, group) → boolean
rebuildBarrierFromState(state) → BarrierState

// node-context.js（新增）
buildNodeContext(dag, state, stage, sessionId) → NodeContext
getRetryContext(sessionId, stage, state) → RetryContext | null

// atomic-write.js（新增）
atomicWrite(filePath, data) → void

// retry-policy.js（Phase 1 重寫）
shouldStop(stage, verdict, retryCount, retryHistory, maxRetries) → StopResult
// StopResult: { stop: boolean, reason: string, action: 'NEXT'|'FORCE_NEXT'|'RETRY' }

// dag-utils.js（擴充）
templateToDag(pipelineId, stages) → DAG  // 自動加入 barrier/onFail/next/maxRetries

// guard-rules.js（Phase 3 重寫）
evaluate(toolName, toolInput, state) → { decision, message?, reason? }
// 內部只看 state.pipelineActive + 工具白名單
```

### 資料流

**Phase 0-1 正常路徑**：
```
Sub-agent 完成
  → stage-transition hook
  → parseRoute(transcript)  [Phase 1，Phase 0 仍用 parseVerdict]
  → enforcePolicy(route, state, stage)
  → shouldStop(stage, verdict, ...)  [Phase 1]
  → 更新 state（markStageCompleted / markStageFailed）
  → writeReflection()  [FAIL 時]
  → buildNodeContext() → systemMessage [Phase 2]
  → 輸出 JSON（systemMessage + continue:true）
```

**Phase 4 並行路徑**：
```
Sub-agent 完成（BARRIER route）
  → stage-transition hook
  → parseRoute → route.route === 'BARRIER'
  → updateBarrier(sid, group, stage, route)
  → allComplete?
    → NO:  systemMessage = '' （等待）
    → YES: mergeBarrierResults() → mergedRoute
           → 根據 mergedRoute 決定 NEXT 或 DEV
           → buildNodeContext() → systemMessage
```

### 優勢

1. **最低風險**：每個 Phase 是獨立的 commit，可隨時回滾到上一個 Phase
2. **測試漸進遷移**：每個 Phase 有明確的驗收條件，現有 900+ tests 持續通過
3. **符合慣例**：保持 hook 薄代理 + controller 集中邏輯的現有模式
4. **自我修改安全**：Phase 0-1 不改路由邏輯（pipeline-guard 不受影響），可安全用 pipeline 自身實作

### 劣勢

1. **controller.js 持續膨脹**：Phase 1-3 期間 controller 會同時包含 v3 和 v4 邏輯（過渡期冗餘）
2. **向後相容包袱**：v3 API 簽名不變意味著內部需要橋接層
3. **清理延遲**：直到 Phase 5 才能移除 v3 死碼

---

## 方案 B：Controller 重構拆分

### 核心策略

Phase 1 時將 `pipeline-controller.js`（697 行）拆分為多個職責明確的模組。每個 API 方法提取到獨立檔案，controller 退化為 re-export hub。v4 新增邏輯直接寫入對應模組，不混入 v3 程式碼。

### 目錄樹

```
scripts/lib/flow/
├── dag-state.js          ← 大改：v4 state schema
├── dag-utils.js          ← 擴充：templateToDag()
├── pipeline-controller.js ← 精簡為 re-export（~50 行）
├── classify.js           ← 新增：從 controller 提取 classify()
├── stage-router.js       ← 新增：從 controller 提取 onStageComplete()
├── session-guard.js      ← 新增：從 controller 提取 canProceed() + onDelegate()
├── session-stop.js       ← 新增：從 controller 提取 onSessionStop()
├── route-parser.js       ← 新增
├── reflection.js         ← 新增
├── barrier.js            ← 新增
├── node-context.js       ← 新增
├── atomic-write.js       ← 新增
├── retry-policy.js       ← 重寫
├── skip-predicates.js    ← 不變
├── state-migrator.js     ← 擴充
└── ...
```

### 介面定義

同方案 A 的新增模組介面，但額外拆分：

```javascript
// pipeline-controller.js（精簡為 re-export）
module.exports = {
  classify: require('./classify.js').classify,
  canProceed: require('./session-guard.js').canProceed,
  onDelegate: require('./session-guard.js').onDelegate,
  onStageComplete: require('./stage-router.js').onStageComplete,
  onSessionStop: require('./session-stop.js').onSessionStop,
};
```

### 資料流

同方案 A（API 簽名不變，hook 無需修改）。

### 優勢

1. **模組職責清晰**：每個檔案 100-200 行，易於理解和測試
2. **並行開發**：不同 Phase 可以修改不同檔案，減少衝突
3. **v3/v4 隔離**：v3 邏輯留在提取的檔案中，v4 新增邏輯在新檔案

### 劣勢

1. **大爆炸式拆分**：Phase 1 的拆分本身是高風險操作，需要同步修改所有 import 路徑
2. **測試大規模遷移**：28 個測試檔中許多直接 require controller，全部需要調整
3. **打破慣例**：v3 建立的「controller 統一 API」模式被改為分散模組，與 v1.0.53 的架構決策矛盾
4. **Phase 0 阻塞**：拆分需要在 Phase 0 之前完成，延遲最有價值的 context_file 改動

---

## 方案 C：Adapter 模式（雙軌並行）

### 核心策略

新建 `pipeline-controller-v4.js` 與 v3 `pipeline-controller.js` 並存。hook 腳本透過環境變數或 state version 欄位選擇使用哪個 controller。Phase 0-4 逐步遷移 hook 到 v4 controller，Phase 5 移除 v3。

### 目錄樹

```
scripts/lib/flow/
├── dag-state.js              ← 不改（v3 專用）
├── dag-state-v4.js           ← 新增（v4 state schema）
├── pipeline-controller.js    ← 不改（v3 保留）
├── pipeline-controller-v4.js ← 新增（v4 統一 API）
├── route-parser.js           ← 新增
├── reflection.js             ← 新增
├── barrier.js                ← 新增
├── node-context.js           ← 新增
├── atomic-write.js           ← 新增
├── retry-policy.js           ← 不改（v3 保留）
├── retry-policy-v4.js        ← 新增（shouldStop）
├── state-migrator.js         ← 擴充（v3<->v4 雙向遷移）
└── ...
```

### 優勢

1. **零風險 v3 回退**：v3 程式碼完全不動，任何時候可切回
2. **A/B 測試**：可在不同 session 使用不同版本驗證

### 劣勢

1. **嚴重程式碼重複**：dag-state、controller、retry-policy 都有兩份，維護成本翻倍
2. **hook 路由複雜**：每個 hook 需要判斷使用哪個 controller，增加意外行為風險
3. **違反 DRY 原則**：與專案「Single Source of Truth」設計哲學矛盾
4. **清理工作量最大**：Phase 5 需要移除整套 v3 檔案，影響範圍比方案 A/B 大

---

## 方案比較

| 面向 | 方案 A：漸進演進 | 方案 B：Controller 拆分 | 方案 C：Adapter 雙軌 |
|------|:---:|:---:|:---:|
| **複雜度** | 低 | 中 | 高 |
| **可擴展性** | 中 | 高 | 低（重複程式碼） |
| **破壞性** | 低（每 Phase 獨立） | 中（Phase 1 大拆分） | 最低（v3 不動） |
| **實作成本** | 最低 | 中 | 最高（雙份維護） |
| **測試遷移** | 漸進（每 Phase 調整相關測試） | 集中（Phase 1 大規模修改） | 最少（v3 測試不動） |
| **慣例一致** | 最佳（保持 controller 模式） | 偏離（拆分 controller） | 嚴重偏離（雙份檔案） |
| **自我修改風險** | 最低（Phase 0-1 不改路由） | 中（拆分影響 guard） | 低（v3 不動） |
| **Phase 0 啟動速度** | 最快（直接開始） | 慢（需先拆分） | 中（需先建立 v4 框架） |

## 決策

**選擇方案 A：漸進式演進**。

原因：

1. **風險最低**：設計文件明確指出 v3→v4 是漸進遷移（6 個 Phase），方案 A 的 Phase-by-Phase 改造與設計文件完全對齊。Phase 0 不改路由邏輯，可安全使用 pipeline 自身實作。

2. **符合慣例**：保持 v3 建立的「hook 薄代理 + controller 統一 API」模式。新增模組（route-parser、barrier、reflection、node-context）作為 controller 的內部依賴，不改變外部介面。

3. **測試漸進遷移**：每個 Phase 只調整相關測試，不需要一次性重寫 28 個測試檔。Phase 0 的驗收條件明確要求「現有測試全過」。

4. **controller 膨脹問題**：過渡期 controller 會包含 v3+v4 邏輯（估計 900 行），但 v4 新增邏輯已提取到獨立模組（route-parser 150 行、barrier 200 行、node-context 100 行、reflection 60 行），controller 本身只增加模組引用和橋接程式碼。Phase 5 清理後預估回到 500 行以下。

5. **自我修改安全**：Phase 0-1 期間 pipeline-guard 和 canProceed 邏輯不變，developer agent 可以安全修改 agent .md 和 controller 的 systemMessage 生成邏輯。Phase 3 修改 guard-rules 時建議使用 `[pipeline:fix]` 或 `/vibe:cancel`。

## 風險與取捨

### 設計層面風險

| 風險 | 嚴重度 | 緩解 |
|------|:------:|------|
| **自我修改**：pipeline hooks 攔截自己的修改 | 高 | Phase 0-1 不改路由邏輯；Phase 3 改 guard 時用 `[pipeline:fix]` |
| **controller 過渡期膨脹**：v3+v4 邏輯共存 | 中 | 新增邏輯提取到獨立模組，controller 只做組裝 |
| **Agent prompt 遵循度**：agent 不遵守 PIPELINE_ROUTE 格式 | 中 | E1 fallback（預設 PASS/NEXT）+ Schema Validation + Policy Enforcement |
| **ECC 並行 Task 未驗證** | 高 | Phase 4 前用實驗驗證；退化策略已設計（序列收集） |
| **900+ 測試遷移** | 中 | 分 Phase 遷移，每個 Phase 有獨立驗收條件 |
| **v3 State Schema BREAKING** | 中 | Phase 3 實作 state-migrator.ensureV4() + 完整遷移測試 |

### 架構取捨

1. **controller 統一 vs 拆分**：選擇不拆分（方案 A），代價是過渡期 controller 較肥。但保持了 hook 的穩定性（import 路徑不變）和慣例一致性。

2. **verdict.js 保留 vs 立即移除**：Phase 0-1 保留 verdict.js 作為 fallback（parseRoute 失敗時回退到 parseVerdict），Phase 5 移除。代價是過渡期有兩個解析器共存。

3. **State Schema 一次性切換 vs 漸進**：Phase 3 一次性切換到 v4 schema（新增 `pipelineActive`、`activeStages`、`retryHistory`、`crashes`），配合遷移器。漸進式擴充欄位會導致 guard-rules 無法完全簡化。

4. **Barrier 獨立檔案 vs 嵌入主 state**：barrier state 使用獨立檔案 `barrier-state-{sid}.json`，生命週期與主 state 不同（barrier 在一輪並行結束後可清理，主 state 跨 session 保留）。代價是多一個檔案需要管理。

## 遷移計畫

### Phase 0：Context Protocol（v3.2）

**目標**：解決資訊洩漏，不改路由邏輯。最低風險起步。

1. 品質 agent .md 加入 context_file 寫入指令 + 回應格式約束 + Self-Refine
2. IMPL agent .md 加入 context_file 讀取指令
3. controller.onStageComplete() systemMessage 不含詳細報告，改為路徑引用
4. session-cleanup 新增 context file 清理
5. 新增 `atomic-write.js`（所有 Phase 共用）

**驗收**：現有測試全過 + REVIEW FAIL 後 systemMessage < 200 tokens

### Phase 1：PIPELINE_ROUTE 協議（v4.0-alpha）

**目標**：結構化路由指令取代 verdict regex。

1. 新增 `route-parser.js`（parseRoute + validateRoute + enforcePolicy）
2. 重寫 `retry-policy.js`（shouldStop 取代 shouldRetryStage）
3. 新增 `reflection.js`（writeReflection + readReflection）
4. controller.onStageComplete() 改用 parseRoute + shouldStop + writeReflection
5. 品質 agent .md 從 PIPELINE_VERDICT 改為 PIPELINE_ROUTE
6. IMPL agent .md 加入 PIPELINE_ROUTE(PASS/NEXT)
7. registry.js 新增 PIPELINE_ROUTE_REGEX
8. Timeline schema 新增 ROUTE_FALLBACK/RETRY_EXHAUSTED 事件
9. session-cleanup 新增 reflection memory 清理

**驗收**：parseRoute 成功解析 + fallback 觸發 + shouldStop 收斂偵測 + 現有回退壓力測試通過

### Phase 2：Node Context 動態注入（v4.0-beta）

**目標**：每個 stage 委派時注入完整 Node Context。

1. 新增 `node-context.js`（buildNodeContext + getRetryContext）
2. controller.onStageComplete() 和 onDelegate() 注入 Node Context
3. dag-state.js 新增 `stages[].contextFile` 欄位
4. delegation-tracker 新增 activeStages push + agent->stage 映射
5. context_file 透傳機制（ROUTE.context_file -> 下一個節點的 Node Context）

**驗收**：Node Context 包含 prev/next/onFail/barrier + retryContext 注入 + < 500 tokens

### Phase 3：Guard 簡化 + State Schema 演進（v4.0-rc）

**目標**：guard 從 5 phases 簡化為 pipelineActive 布林值。

1. dag-state.js 大改（v4 state schema: pipelineActive/activeStages/retryHistory/crashes）
2. guard-rules.js 重寫（~50 行，只看 pipelineActive + 工具白名單）
3. state-migrator.js 新增 ensureV4()
4. atomic-write.js 統一寫入（取代 fs.writeFileSync）
5. derivePhase() v4 版本（僅供 Dashboard/Timeline）
6. cancel skill 簡化
7. pipeline-controller 配合新 state schema

**驗收**：guard-rules 不含 derivePhase + pipelineActive 二元判斷 + v3 state 遷移正確 + 全部測試通過

### Phase 4：Barrier 並行（v4.0）

**目標**：並行節點同步機制。

1. 新增 `barrier.js`（完整 Barrier 生命週期管理）
2. dag-utils.js 新增 `templateToDag()`（自動加入 barrier group/onFail/next/maxRetries）
3. controller.classify() 使用 templateToDag
4. stage-transition 處理 route:BARRIER
5. 並行委派 systemMessage 生成
6. session-cleanup/pipeline-init 處理 barrier state
7. Timeline schema 新增 AGENT_CRASH/PIPELINE_ABORTED 等事件
8. Dashboard 並行狀態顯示
9. ECC 並行 Task 驗證（可能需退化為序列）

**驗收**：並行委派 + Barrier 收齊 + Worst-Case-Wins + timeout + Dashboard 顯示

### Phase 5：清理 + 文件同步（v4.1）

**目標**：移除 v3 死碼，同步所有文件。

1. 移除/標記 deprecated verdict.js
2. 清理 dag-state.js v3 函式（enforced/pendingRetry/meta.cancelled）
3. 清理 controller v3 路由邏輯殘留
4. Dashboard adaptV3() 升級為 adaptV4()
5. bot.js v4 state 直讀
6. CLAUDE.md + docs/ref/pipeline.md 更新
7. openspec change 歸檔
8. 測試清理（v3 相關斷言移除）
