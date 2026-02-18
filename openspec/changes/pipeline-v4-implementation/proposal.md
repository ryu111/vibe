# Pipeline v4 -- 分散式節點自治架構

## 為什麼（Why）

### 問題描述

Pipeline v3 採用集中式 DAG 狀態管理，所有路由決策由 `pipeline-controller.js` 中央控制（697 行）。經過 v1.0.56~v1.0.62 的連續修復，暴露了三類結構性問題：

| 問題 | 根因 | 歷史實例 |
|------|------|---------|
| **Phase 推導錯誤** | `derivePhase()` 5~6 個條件分支（含安全網），任一判斷錯誤導致 guard 間隙 | v1.0.56 「分類但無 DAG」間隙 |
| **全域狀態腐敗** | 單一 JSON 檔案被多個 hook 並行讀寫 | v1.0.58 cancel 死鎖（suggest-compact 寫入競態） |
| **Main Agent 資訊洩漏** | systemMessage 含詳細問題報告，Main Agent 看到問題後嘗試繞過 guard 自行修復 | v3 現存：REVIEW FAIL 後 Main Agent 直接 Edit |

### 核心洞察

> **Main Agent 不應該知道「要修什麼」，只應該知道「要路由到哪」。**

v4 目標：Main Agent 成為純粹的訊息匯流排（Message Relay），路由決策由節點自治完成。

### 預期效益

1. **context_file 物理隔離**：Main Agent 的 Context Window 不再包含品質報告 token（預估省 2000+ tokens/回退）
2. **Guard 簡化**：5 phases x 多條件分支 -> 1 個布林值 `pipelineActive`
3. **可擴展性**：新增 stage 只需寫一個 Node agent（不改 controller/guard/skip-predicates）
4. **並行加速**：REVIEW + TEST 可同時執行（Barrier 機制）
5. **迭代品質**：Reflexion Memory + Self-Refine + 多維收斂條件減少無效回退

## 變更內容（What Changes）

### 核心協議新增

1. **PIPELINE_ROUTE 協議**：Sub-agent 在輸出末尾附加 `<!-- PIPELINE_ROUTE: {...} -->`，包含 verdict/route/severity/context_file 等欄位，取代 v3 的 `<!-- PIPELINE_VERDICT: ... -->`
2. **Node Context 動態注入**：每個 stage 的 systemMessage 注入 prev/next/onFail/maxRetry/barrier 配置，agent 自主判斷 verdict 和 route
3. **context_file 物理隔離**：詳細報告寫入 `~/.claude/pipeline-context-{sid}-{stage}.md`，PIPELINE_ROUTE 只傳遞檔案路徑

### 架構變更

4. **Guard 簡化**：guard-rules.js 從 5 phase 判斷（IDLE/CLASSIFIED/DELEGATING/RETRYING/COMPLETE）簡化為 `pipelineActive` 二元判斷 -- **BREAKING**
5. **State Schema 演進**：新增 `pipelineActive`/`activeStages`/`retryHistory`/`crashes` 欄位，移除 `enforced`/`meta.cancelled`，保留 `pendingRetry` 作為向後相容 fallback（v4.1 移除） -- **BREAKING**（需 v3->v4 遷移器）
6. **Barrier 並行計數器**：新增 `barrier-state-{sessionId}.json` 獨立檔案，Worst-Case-Wins 合併策略
7. **DAG 模板升級**：`linearToDag()` 升級為 `templateToDag()`，自動加入 barrier group 和 onFail 欄位
8. **Atomic Write**：所有 state 寫入改用 write-to-tmp + rename 模式

### 迭代優化新增

9. **Reflexion Memory**：`reflection-memory-{sid}-{stage}.md` -- 跨迭代反思記憶
10. **Self-Refine 微迴圈**：品質 agent .md 嵌入 Generate->Feedback->Refine 指令
11. **shouldStop 多維收斂**：取代 v3 的 `shouldRetryStage()`，2 條件觸發停止（PASS / MAX_RETRIES）+ 2 觀察信號（收斂停滯 / 趨勢下降，僅記錄不觸發強制停止）
12. **Policy Enforcement**：Schema Validation + Logic Correctness 兩層驗證

### 邊界情境防護

13. **23 個邊界情境**：E1~E23 全部在設計文件中定義防護機制
14. **6 個新增 Timeline 事件**：ROUTE_FALLBACK / AGENT_CRASH / PIPELINE_CANCELLED / TRANSCRIPT_LEAK_WARNING / PIPELINE_ABORTED / RETRY_EXHAUSTED

## 能力定義（Capabilities）

- [ ] Cap-1：context_file 寫入/讀取/清理生命週期管理
- [ ] Cap-2：PIPELINE_ROUTE 解析器（parseRoute 取代 parseVerdict）
- [ ] Cap-3：Schema Validation + Policy Enforcement 兩層驗證
- [ ] Cap-4：Node Context 動態生成器（buildNodeContext）
- [ ] Cap-5：Guard 簡化為 pipelineActive 二元判斷
- [ ] Cap-6：Barrier 計數器 + Worst-Case-Wins 合併 + Timeout
- [ ] Cap-7：templateToDag() -- 模板自動加入 barrier group 和 onFail
- [ ] Cap-8：Reflexion Memory 寫入/讀取/注入
- [ ] Cap-9：shouldStop() 多維收斂條件
- [ ] Cap-10：Self-Refine 品質 agent 指令嵌入
- [ ] Cap-11：Atomic Write 統一寫入
- [ ] Cap-12：v3->v4 State 遷移器
- [ ] Cap-13：品質 agent 回應格式約束（transcript 防洩漏）
- [ ] Cap-14：Session cleanup 清理 context file + reflection memory + barrier state

## 影響分析（Impact）

### 受影響檔案

#### 核心 lib（重寫/大改）
| 檔案 | 變更類型 | 說明 |
|------|---------|------|
| `scripts/lib/flow/pipeline-controller.js` | **重寫** | 697 行 -> 移除集中式路由邏輯，保留 classify/canProceed API 但內部大改 |
| `scripts/lib/flow/dag-state.js` | **大改** | derivePhase() v4 邏輯 + pipelineActive 欄位 + activeStages 陣列 + 移除 enforced（pendingRetry 保留為 fallback，v4.1 移除） |
| `scripts/lib/sentinel/guard-rules.js` | **大改** | 移除 phase 依賴，簡化為 pipelineActive 判斷 |
| `scripts/lib/flow/verdict.js` | **廢棄** | 被 PIPELINE_ROUTE 解析器取代 |
| `scripts/lib/flow/retry-policy.js` | **重寫** | shouldRetryStage() -> shouldStop() 多維收斂 |
| `scripts/lib/flow/dag-utils.js` | **擴充** | 新增 templateToDag() 取代 linearToDag() |

#### 核心 lib（新增）
| 檔案 | 說明 |
|------|------|
| `scripts/lib/flow/route-parser.js` | **新增** -- PIPELINE_ROUTE 解析 + Schema Validation |
| `scripts/lib/flow/barrier.js` | **新增** -- Barrier 計數器 + 合併 + Timeout |
| `scripts/lib/flow/node-context.js` | **新增** -- Node Context 動態生成（buildNodeContext + getRetryContext） |
| `scripts/lib/flow/reflection.js` | **新增** -- Reflexion Memory 寫入/讀取 |
| `scripts/lib/flow/atomic-write.js` | **新增** -- Atomic Write 工具函式 |
| `scripts/lib/flow/state-migrator.js` | **擴充** -- v3->v4 遷移邏輯 |

#### Hook 腳本（薄代理模式不變，內部邏輯隨 controller 調整）
| 檔案 | 變更類型 | 說明 |
|------|---------|------|
| `scripts/hooks/stage-transition.js` | **擴充** | 從 controller.onStageComplete() 薄代理變為較厚邏輯（ROUTE 解析 + barrier + context_file 存儲） |
| `scripts/hooks/pipeline-guard.js` | **微調** | 仍為 controller.canProceed() 代理，但 canProceed 內部邏輯簡化 |
| `scripts/hooks/delegation-tracker.js` | **擴充** | 新增 activeStages push + agent->stage 映射記錄 |
| `scripts/hooks/pipeline-check.js` | **微調** | onSessionStop 內部邏輯配合 pipelineActive |
| `scripts/hooks/task-classifier.js` | **微調** | classify() 配合新 state schema |
| `scripts/hooks/session-cleanup.js` | **擴充** | 新增 context file + reflection memory + barrier state 清理 |
| `scripts/hooks/pipeline-init.js` | **擴充** | pipeline-resume 需處理 barrier state 恢復 |

#### Agent 定義（12 個 .md 檔案）
| Agent | 變更類型 | 說明 |
|------|---------|------|
| `agents/code-reviewer.md` | **大改** | PIPELINE_VERDICT -> PIPELINE_ROUTE + context_file 寫入 + 回應格式約束 + Self-Refine |
| `agents/tester.md` | **大改** | 同上 |
| `agents/qa.md` | **大改** | 同上 |
| `agents/e2e-runner.md` | **大改** | 同上 |
| `agents/developer.md` | **中改** | 讀取 context_file + PIPELINE_ROUTE(PASS/NEXT) |
| `agents/planner.md` | **中改** | PIPELINE_ROUTE(PASS/NEXT) + context_file（可選） |
| `agents/architect.md` | **中改** | 同上 |
| `agents/designer.md` | **中改** | 同上 |
| `agents/doc-updater.md` | **中改** | 同上 |
| `agents/security-reviewer.md` | **中改** | PIPELINE_ROUTE + context_file + Self-Refine |
| `agents/pipeline-architect.md` | **小改** | DAG 結構需含 barrier/onFail/maxRetries 欄位 |
| `agents/build-error-resolver.md` | **不改** | 非 pipeline stage |

#### 其他受影響
| 檔案 | 說明 |
|------|------|
| `scripts/lib/registry.js` | 新增 PIPELINE_ROUTE_REGEX，VERDICT_REGEX 保留向後相容 |
| `scripts/lib/timeline/schema.js` | 新增 6 個事件類型 |
| `scripts/lib/timeline/formatter.js` | 新增事件格式化 |
| `web/index.html` | Dashboard 適配 v4 state + barrier 視覺化 |
| `server.js` | 新增 barrier 事件廣播 |
| `bot.js` | Remote 適配 v4 state 格式 |

#### 明確不需修改
| 檔案 | 原因 |
|------|------|
| `scripts/lib/flow/classifier.js` | 分類邏輯不變（LLM-first 架構） |
| `scripts/lib/flow/pipeline-discovery.js` | 動態發現機制不變 |
| `scripts/lib/flow/env-detector.js` | 偵測邏輯不變，結果改注入 Node Context |
| `scripts/lib/flow/counter.js` | compact 計數不變 |
| `scripts/lib/sentinel/lang-map.js` | 語言映射不變 |
| `scripts/lib/sentinel/tool-detector.js` | 工具偵測不變 |
| `scripts/hooks/post-edit.js` | PostToolUse 邏輯不變 |
| `scripts/hooks/suggest-compact.js` | 需微調但核心不變（移除 pipeline-state 寫入） |
| `scripts/hooks/check-console-log.js` | Stop hook 邏輯不變 |

### 受影響模組
- **flow**: 核心重構目標
- **sentinel**: guard-rules 大改
- **dashboard**: adaptV3 需升級為 adaptV4
- **remote**: bot.js state 讀取適配
- **timeline**: 新增 6 個事件類型

### registry.js 變更
是 -- 新增 `PIPELINE_ROUTE_REGEX`，保留 `VERDICT_REGEX`（向後相容期間）

### hook 變更
- **stage-transition**: 從薄代理擴充為 ROUTE 解析 + barrier 邏輯
- **delegation-tracker**: 新增 activeStages 管理
- **pipeline-guard**: 內部邏輯簡化
- **pipeline-check**: 配合 pipelineActive
- **session-cleanup**: 新增 3 類檔案清理
- **pipeline-init**: barrier state 恢復

## 階段分解

### Phase 0：Context Protocol（v3.2）

> **目標**：先解決「資訊洩漏」，不改路由邏輯。風險最低的起步。

- **產出**：
  - 4 個品質 agent .md 加入 context_file 寫入指令和回應格式約束
  - 5 個 IMPL agent .md 加入 context_file 讀取指令
  - stage-transition systemMessage 不再包含詳細報告，改為路徑引用
  - session-cleanup 新增 context file 清理
  - 品質 agent .md 加入 Self-Refine 微迴圈指令（純 prompt engineering）

- **修改檔案**：
  - `plugins/vibe/agents/code-reviewer.md` -- context_file 寫入 + 回應格式約束 + Self-Refine
  - `plugins/vibe/agents/tester.md` -- 同上
  - `plugins/vibe/agents/qa.md` -- 同上
  - `plugins/vibe/agents/e2e-runner.md` -- 同上
  - `plugins/vibe/agents/security-reviewer.md` -- context_file + Self-Refine
  - `plugins/vibe/agents/developer.md` -- 讀取 context_file
  - `plugins/vibe/agents/planner.md` -- context_file（可選）
  - `plugins/vibe/agents/architect.md` -- context_file（可選）
  - `plugins/vibe/agents/designer.md` -- context_file（可選）
  - `plugins/vibe/agents/doc-updater.md` -- context_file（可選）
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- onStageComplete systemMessage 改為路徑引用（不含報告內容）
  - `plugins/vibe/scripts/hooks/session-cleanup.js` -- 新增 `pipeline-context-*.md` 清理

- **依賴**：無前置條件
- **風險**：
  - 低：只改 systemMessage 內容和 agent 讀取方式，不改路由邏輯
  - Agent prompt 遵循度：agent 可能不遵守回應格式約束（guard 仍為最後防線）
- **驗收條件**：
  1. REVIEW FAIL 後，Main Agent context window 不含品質報告特徵字串（C-1/H-1/CRITICAL）
  2. 回退場景的 systemMessage < 200 tokens
  3. Main Agent 收到 FAIL 後不嘗試 Edit/Write（pipeline-guard 阻擋計數 = 0）
  4. 現有 28 個測試檔全過（不改測試）

### Phase 1：PIPELINE_ROUTE 協議（v4.0-alpha）

> **目標**：品質 agent 輸出結構化路由指令，stage-transition 解析 ROUTE JSON 取代 verdict regex。

- **產出**：
  - `route-parser.js` -- PIPELINE_ROUTE 解析器（parseRoute 取代 parseVerdict）
  - `retry-policy.js` -- shouldStop() 多維收斂條件（取代 shouldRetryStage）
  - `reflection.js` -- Reflexion Memory 寫入/讀取
  - Schema Validation + Policy Enforcement 兩層驗證
  - 品質 agent .md 從 PIPELINE_VERDICT 改為 PIPELINE_ROUTE 輸出
  - stage-transition 解析 PIPELINE_ROUTE
  - retryHistory 寫入 pipeline-state

- **修改檔案**：
  - `plugins/vibe/scripts/lib/flow/route-parser.js` -- **新增**（parseRoute + validateRoute）
  - `plugins/vibe/scripts/lib/flow/retry-policy.js` -- **重寫**（shouldStop 取代 shouldRetryStage）
  - `plugins/vibe/scripts/lib/flow/reflection.js` -- **新增**（writeReflection + readReflection）
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- onStageComplete 改用 parseRoute + shouldStop + writeReflection
  - `plugins/vibe/agents/code-reviewer.md` -- PIPELINE_VERDICT -> PIPELINE_ROUTE
  - `plugins/vibe/agents/tester.md` -- 同上
  - `plugins/vibe/agents/qa.md` -- 同上
  - `plugins/vibe/agents/e2e-runner.md` -- 同上
  - `plugins/vibe/agents/security-reviewer.md` -- 同上
  - `plugins/vibe/agents/developer.md` -- PIPELINE_ROUTE(PASS/NEXT)
  - `plugins/vibe/agents/planner.md` -- PIPELINE_ROUTE(PASS/NEXT)
  - `plugins/vibe/agents/architect.md` -- PIPELINE_ROUTE(PASS/NEXT)
  - `plugins/vibe/agents/designer.md` -- PIPELINE_ROUTE(PASS/NEXT)
  - `plugins/vibe/agents/doc-updater.md` -- PIPELINE_ROUTE(PASS/NEXT)
  - `plugins/vibe/scripts/lib/registry.js` -- 新增 PIPELINE_ROUTE_REGEX
  - `plugins/vibe/scripts/lib/timeline/schema.js` -- 新增 ROUTE_FALLBACK/RETRY_EXHAUSTED 事件
  - `plugins/vibe/scripts/lib/timeline/formatter.js` -- 新增事件格式化
  - `plugins/vibe/scripts/hooks/session-cleanup.js` -- 新增 reflection memory 清理

- **依賴**：Phase 0 完成（agent 已習慣 context_file）
- **風險**：
  - 中：verdict.js -> route-parser.js 是協議切換，需要 fallback 機制
  - Agent prompt 遵循度：agent 可能輸出格式錯誤的 PIPELINE_ROUTE（E1 fallback 已設計）
  - **自我修改風險**：pipeline-controller.js 修改期間，pipeline hooks 仍然活躍。建議用 `[pipeline:fix]` 或 `/vibe:cancel` 後直接修改
- **驗收條件**：
  1. REVIEW FAIL 時 parseRoute 成功解析 PIPELINE_ROUTE JSON
  2. parseRoute 失敗時 E1 fallback 觸發（預設 PASS/NEXT + warning）
  3. shouldStop() 收斂停滯偵測返回觀察信號（stop: false），不觸發 FORCE_NEXT
  4. Reflexion Memory 正確寫入和讀取
  5. Policy Enforcement 覆寫矛盾路由（PASS+DEV -> NEXT）
  6. 現有回退壓力測試（e2e-hook-chain）通過

### Phase 2：Node Context 動態注入（v4.0-beta）

> **目標**：每個 stage 委派時注入完整 Node Context，agent 從中讀取拓撲和環境資訊。

- **產出**：
  - `node-context.js` -- buildNodeContext() + getRetryContext()
  - stage-transition 委派時 systemMessage 包含 Node Context JSON
  - context_file 透傳機制（ROUTE.context_file -> 下一個節點的 Node Context）
  - IMPL agent .md 加入 PIPELINE_ROUTE(PASS/NEXT) 輸出指令

- **修改檔案**：
  - `plugins/vibe/scripts/lib/flow/node-context.js` -- **新增**
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- onStageComplete 和 onDelegate 注入 Node Context
  - `plugins/vibe/scripts/lib/flow/dag-state.js` -- 新增 stages[].contextFile 欄位
  - `plugins/vibe/scripts/hooks/delegation-tracker.js` -- 新增 activeStages push + agent->stage 映射

- **依賴**：Phase 1 完成（PIPELINE_ROUTE 協議已就緒）
- **風險**：
  - 中：Node Context 大小需控制（避免 systemMessage 過大占用 context window）
  - agent 可能忽略 Node Context 中的 onFail 資訊（Policy Enforcement 作為最後防線）
- **驗收條件**：
  1. REVIEW agent 收到的 Node Context 包含 prev/next/onFail/barrier 資訊
  2. DEV 回退時 Node Context 包含 retryContext（reflexion memory 路徑）
  3. context_file 從前驅 stage 正確透傳到後繼 stage
  4. Node Context JSON 大小 < 500 tokens

### Phase 3：Guard 簡化 + State Schema 演進（v4.0-rc）

> **目標**：guard-rules.js 從 5 phase 判斷簡化為 pipelineActive 二元判斷。State schema 升級。

- **產出**：
  - guard-rules.js 重寫（移除 derivePhase 依賴）
  - dag-state.js state schema v4 化（pipelineActive / activeStages / retryHistory / crashes）
  - state-migrator.js v3->v4 遷移邏輯
  - `atomic-write.js` -- 統一 Atomic Write 工具函式
  - derivePhase() v4 版本（僅供 Dashboard/Timeline 顯示用）
  - pipeline-controller cancel API 簡化（直接設 pipelineActive=false）

- **修改檔案**：
  - `plugins/vibe/scripts/lib/sentinel/guard-rules.js` -- **重寫**（~30 行）
  - `plugins/vibe/scripts/lib/flow/dag-state.js` -- **大改**（v4 state schema + derivePhase v4）
  - `plugins/vibe/scripts/lib/flow/state-migrator.js` -- **擴充**（ensureV4 遷移函式）
  - `plugins/vibe/scripts/lib/flow/atomic-write.js` -- **新增**
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- 配合新 state schema
  - `plugins/vibe/scripts/hooks/pipeline-guard.js` -- 微調（仍為 canProceed 代理）
  - `plugins/vibe/scripts/hooks/pipeline-check.js` -- 配合 pipelineActive
  - `plugins/vibe/skills/cancel/SKILL.md` -- 簡化 cancel 流程

- **依賴**：Phase 2 完成（Node Context 已就緒）
- **風險**：
  - **高**：Guard 是 pipeline 安全的最後防線，簡化過程中任何遺漏都可能導致 Main Agent 越權
  - **BREAKING**：v3 state 檔案格式不相容，必須有遷移器
  - Dashboard adaptV3() 需升級為 adaptV4()
- **驗收條件**：
  1. guard-rules.js 不含 derivePhase/PHASES/CLASSIFIED/RETRYING 等 v3 概念
  2. pipelineActive=true 時，Write/Edit/Bash 寫入被阻擋
  3. pipelineActive=false 時，所有工具放行
  4. v3 state 檔案被 state-migrator 正確遷移為 v4 格式
  5. cancel 直接設 pipelineActive=false，不需 CANCEL_STATE_FILE_RE 逃生口
  6. pipeline-catalog-validation 所有場景通過
  7. guard-rules 測試全面重寫並通過

### Phase 4：Barrier 並行（v4.0）

> **目標**：並行節點同步機制。風險最高，最後實作。

- **產出**：
  - `barrier.js` -- Barrier 計數器 + Worst-Case-Wins 合併 + Timeout
  - `dag-utils.js` 新增 `templateToDag()` -- 自動加入 barrier group 和 onFail
  - stage-transition 支援 route:BARRIER 處理
  - barrier-state-{sessionId}.json 獨立檔案管理
  - 並行委派 systemMessage 生成
  - Dashboard 並行狀態顯示

- **修改檔案**：
  - `plugins/vibe/scripts/lib/flow/barrier.js` -- **新增**（createBarrier/updateBarrier/mergeBarrierResults/checkTimeout）
  - `plugins/vibe/scripts/lib/flow/dag-utils.js` -- **擴充**（templateToDag 取代 linearToDag）
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- classify 使用 templateToDag + onStageComplete 處理 BARRIER route
  - `plugins/vibe/scripts/hooks/stage-transition.js` -- barrier 邏輯
  - `plugins/vibe/scripts/hooks/session-cleanup.js` -- barrier state 清理
  - `plugins/vibe/scripts/hooks/pipeline-init.js` -- barrier state 恢復（pipeline-resume）
  - `plugins/vibe/scripts/lib/timeline/schema.js` -- 新增 AGENT_CRASH/PIPELINE_ABORTED 等事件
  - `plugins/vibe/web/index.html` -- 並行狀態視覺化
  - `plugins/vibe/server.js` -- barrier 事件廣播
  - `plugins/vibe/scripts/lib/registry.js` -- 待確認：Pipeline Catalog 是否需要新增 barrier 相關欄位

- **依賴**：Phase 3 完成（pipelineActive guard 已就緒）
- **風險**：
  - **高**：ECC 是否支持單一 response 中多個 Task tool_use blocks **待驗證**
  - 並行 hook 觸發順序假設（SubagentStop 串行觸發）**待驗證**
  - barrier 計數器損毀恢復（從 pipeline-state 重建）
  - 跨 barrier 回退時 stage 重設邏輯複雜
  - **退化策略**：若 ECC 不支持並行 Task，barrier 退化為序列收集結果（無損退化）
- **驗收條件**：
  1. REVIEW + TEST 並行委派，barrier 收齊後統一決定路由
  2. Worst-Case-Wins：REVIEW PASS + TEST FAIL -> 整體 FAIL -> 合併 context_file -> DEV
  3. Barrier timeout 5 分鐘超時強制前進
  4. barrier-state JSON 損毀時從 pipeline-state 重建
  5. 跨 barrier 回退時被跨越的 barrier group 重設
  6. Dashboard 正確顯示並行 stage 狀態

### Phase 5：清理 + 文件同步（v4.1）

> **目標**：移除 v3 死碼，同步所有文件。

- **產出**：
  - 移除 verdict.js（或標記 deprecated）
  - 移除 dag-state.js 中 v3 專用函式
  - 移除 pipeline-controller.js 中 v3 路由邏輯殘留
  - Dashboard/Timeline consumer 適配 PIPELINE_ROUTE 事件
  - CLAUDE.md 更新（v4 架構描述）
  - docs/ref/pipeline.md 更新
  - openspec change 歸檔

- **修改檔案**：
  - `plugins/vibe/scripts/lib/flow/verdict.js` -- 標記 deprecated 或移除
  - `plugins/vibe/scripts/lib/flow/dag-state.js` -- 清理 v3 函式
  - `plugins/vibe/scripts/lib/flow/pipeline-controller.js` -- 清理 v3 殘留
  - `plugins/vibe/web/index.html` -- adaptV4() 清理
  - `plugins/vibe/bot.js` -- v4 state 直讀
  - `CLAUDE.md` -- v4 架構更新
  - `docs/ref/pipeline.md` -- v4 文件更新
  - `docs/ref/pipeline-v4.md` -- 標記為「已實作」
  - 測試檔案 -- v3 相關測試清理/更新

- **依賴**：Phase 4 完成
- **風險**：低（純清理）
- **驗收條件**：
  1. 無 v3 專用死碼殘留
  2. 所有測試通過
  3. CLAUDE.md 與實作完全同步
  4. openspec change 歸檔至 archive/

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| **自我修改風險**：pipeline hooks 攔截自己的修改 | 高 | 使用 `[pipeline:fix]` 或 `/vibe:cancel` 後修改；Phase 0-1 不改路由邏輯 |
| **Guard 簡化遺漏**：pipelineActive 二元判斷可能有未覆蓋場景 | 高 | Phase 3 前列舉所有 v3 guard 場景並建立對照測試；pipeline-catalog-validation 回歸 |
| **ECC 並行 Task 未驗證**：不確定 ECC 是否支持多 Task blocks | 高 | Phase 4 前用實驗驗證；退化策略已設計（序列收集，無損退化） |
| **v3->v4 遷移正確性**：state schema breaking change | 中 | state-migrator 遷移器 + 完整遷移測試 |
| **Agent prompt 遵循度**：agent 不遵守 PIPELINE_ROUTE 格式 | 中 | Schema Validation + E1 fallback（預設 PASS/NEXT） |
| **Transcript 洩漏**：agent 回應含完整報告 | 中 | 三道防線：context_file + 回應約束 + guard 阻擋 |
| **900+ 測試遷移**：大量測試依賴 v3 API | 中 | 分階段遷移，每個 Phase 有獨立驗收條件 |
| **Barrier 計數器損毀** | 低 | Atomic Write + 從 pipeline-state 重建 |
| **context_file 過大** | 低 | 5000 chars 上限 + session-cleanup |
| **Reflexion Memory 累積** | 低 | 每輪 500 chars，6 輪上限 3000 chars |

## 回滾計畫

### Phase 0-1 回滾（最安全）

Phase 0-1 不改路由邏輯，回滾只需：
1. 還原 agent .md（移除 PIPELINE_ROUTE/context_file 指令）
2. 還原 pipeline-controller.js 的 systemMessage 格式
3. 刪除新增的 route-parser.js/reflection.js

### Phase 2-3 回滾（需遷移器）

Phase 2-3 改了 state schema：
1. 還原 guard-rules.js 到 v3 版本
2. 還原 dag-state.js 到 v3 版本
3. state-migrator 反向遷移（v4->v3），或手動刪除 pipeline-state 檔案重新開始
4. 清理 context file + reflection memory + barrier state

### Phase 4 回滾（獨立移除）

Barrier 機制相對獨立：
1. 刪除 barrier.js
2. templateToDag() 回退為 linearToDag()
3. 刪除 barrier-state 檔案
4. stage-transition 移除 BARRIER 處理邏輯

### 緊急回滾（全局）

使用 git checkpoint 機制：
```bash
git tag -l "vibe-pipeline/*"     # 查看所有 stage checkpoint
git checkout vibe-pipeline/phase-0  # 回到 Phase 0 完成點
```

每個 Phase 完成時打 tag `vibe-pipeline/v4-phase-{N}`，確保任意階段可回滾。

## 附錄：設計文件交叉索引

| 本文 Phase | 設計文件 Section | 關鍵機制 |
|:----------:|:---------------:|---------|
| Phase 0 | 7.Phase 0 + 3.3 + 10.2 | context_file + 回應約束 + Self-Refine |
| Phase 1 | 7.Phase 1 + 3.2 + 6.3 + 10.1 + 10.3 | PIPELINE_ROUTE + validation + reflexion + shouldStop |
| Phase 2 | 7.Phase 2 + 3.1 + 4.2 + 4.3 | Node Context + buildNodeContext + relay |
| Phase 3 | 7.Phase 3 + 4.1 + C.1 | Guard 簡化 + v4 state schema |
| Phase 4 | 7.Phase 4 + 5.1~5.4 + 8.1 | Barrier + templateToDag + 並行 |
| Phase 5 | 7.Phase 5 | 清理 |
| 全局 | 9 + 11.1~11.6 | 風險 + 23 個邊界情境（E1~E23） |
