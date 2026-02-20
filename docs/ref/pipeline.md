# Pipeline 分散式節點架構

> 技術規格文件。狀態：v5 穩定運作。

---

## 目錄

- [§1 架構總覽](#1-架構總覽)
- [§2 Node 協議](#2-node-協議)
- [§3 Main Agent Relay 機制](#3-main-agent-relay-機制)
- [§4 並行執行](#4-並行執行)
- [§5 Classifier（Always-Pipeline）](#5-classifieralways-pipeline)
- [§6 Phase-Level D-R-T](#6-phase-level-d-r-t)
- [§7 節點自治與 Policy](#7-節點自治與-policy)
- [§8 Pipeline Catalog 與 DAG](#8-pipeline-catalog-與-dag)
- [§9 迭代優化機制](#9-迭代優化機制)
- [§10 邊界情境與防護](#10-邊界情境與防護)
- [§11 風險評估](#11-風險評估)
- [附錄 A PIPELINE_ROUTE Schema](#附錄-a-pipeline_route-schema)
- [附錄 B Node Context Schema](#附錄-b-node-context-schema)
- [附錄 C Pipeline State Schema](#附錄-c-pipeline-state-schema)
- [附錄 D 設計決策紀錄](#附錄-d-設計決策紀錄)

---

## 1. 架構總覽

### 1.1 核心設計

Pipeline 採用**分散式節點自治**模型。Main Agent 作為純粹的訊息匯流排（Message Relay），路由決策由各節點自主做出，再由 stage-transition hook 驗證並執行。

> **核心原則**：Main Agent 不應知道「要修什麼」，只應知道「要路由到哪」。

```
                    ┌─────────────────────┐
                    │     Main Agent      │
                    │   (Message Relay)   │
                    │                     │
                    │  只做兩件事：        │
                    │  1. 讀 systemMessage │
                    │  2. 委派 Sub-agent   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              v                v                v
     ┌────────────┐   ┌────────────┐   ┌────────────┐
     │ Node: DEV  │   │Node: REVIEW│   │ Node: TEST │
     │            │   │            │   │            │
     │ prev: ARCH │   │ prev: DEV  │   │ prev: DEV  │
     │ next: [    │   │ next: QA   │   │ next: QA   │
     │  REVIEW,   │   │ onFail:DEV │   │ onFail:DEV │
     │  TEST      │   │ maxRetry:3 │   │ maxRetry:3 │
     │ ]          │   │            │   │            │
     └────────────┘   └────────────┘   └────────────┘
```

**Guard 機制**（二元判斷）：

Guard 只需一個布林值 `pipelineActive` + 工具白名單。`pipelineActive=true` 時，Main Agent 只能使用委派工具（Task/Skill）和白名單工具（Read/Grep/Glob/WebSearch/WebFetch/TaskList/TaskGet/TaskCreate/TaskUpdate/AskUserQuestion），其他全部阻擋。

**Rule 4.5 品質門防護**：REVIEW/TEST stage active 時，額外阻擋程式碼檔案的 Write/Edit（TEST 允許寫測試檔案，REVIEW 完全唯讀）。

**三個角色分工**：

| 角色 | 實體 | 職責 |
|------|------|------|
| Pipeline Agent | pipeline-architect（sonnet/plan） | 分析 prompt + 環境 → 產出 DAG |
| Pipeline Skill | `/vibe:pipeline` | 提供 stage 定義、DAG 結構規範、範例模板 |
| Hook Stack | 5 核心 hook | 防護 + 追蹤 + 引導 + 閉環 |

**五大機制**：

| 機制 | 說明 |
|------|------|
| context_file 物理隔離 | Sub-agent 報告寫入 `~/.claude/pipeline-context-{sid}-{stage}.md`，Main Agent 只看到路徑 |
| PIPELINE_ROUTE 協議 | Sub-agent 輸出 `<!-- PIPELINE_ROUTE: {...} -->`，stage-transition 解析路由 |
| Node Context 動態注入 | 每個 stage 的 systemMessage 注入 prev/next/onFail/maxRetry/retryContext |
| Barrier 並行 | REVIEW+TEST 等可並行，barrier 計數器 + Worst-Case-Wins 合併 |
| Reflexion Memory | `reflection-memory-{sid}-{stage}.md` — 跨迭代學習 |

### 1.2 動態流程

#### A. 正常路徑（PASS → NEXT → COMPLETE）

1. 使用者 prompt → task-classifier → `classify()` 分類
2. 顯式 `[pipeline:xxx]` 直接建 DAG；非顯式注入 systemMessage pipeline 選擇表
3. DAG 建立完成，`pipelineActive = true`
4. stage-transition 注入 systemMessage 委派指令 → Main Agent 委派 Sub-agent
5. Sub-agent 完成 → 輸出 PIPELINE_ROUTE `{verdict:"PASS", route:"NEXT"}`
6. stage-transition 解析 → 標記完成 → 推進下一個 stage → 注入新的 systemMessage
7. 最後一個 stage PASS → `pipelineActive = false` → Pipeline COMPLETE

#### B. 回退路徑（FAIL → DEV → 重驗）

1. QUALITY stage（如 REVIEW）FAIL → stage-transition 解析 `route:"DEV"`
2. 寫入 Reflexion Memory（記錄失敗原因和輪次）
3. DEV 重設為 pending，REVIEW 重設為 pending
4. 委派 DEV（注入 retryContext + context_file）→ DEV 修復 → 重新進入 REVIEW
5. 若 retries ≥ maxRetries → enforcePolicy 強制 `route:"NEXT"` 繼續

#### C. 並行路徑（Barrier 同步）

1. DEV PASS，next 為 `[REVIEW, TEST]` → 同時委派兩個 stage
2. 兩者各自輸出 `route:"BARRIER"` → updateBarrier 累計
3. 全部到齊 → mergeBarrierResults（Worst-Case-Wins）：
   - 全 PASS → NEXT → 推進後繼 stage
   - 任一 FAIL → DEV 回退（重設所有 barrier siblings）

---

## 2. Node 協議

### 2.1 Node Context（委派時傳入）

每個 Sub-agent 收到的 systemMessage 包含 Node Context，結構化描述其在 DAG 中的位置：

| 欄位 | 說明 |
|------|------|
| `node.stage` | 當前 stage ID（如 `REVIEW` 或 `REVIEW:1`） |
| `node.prev` | 前驅 stage ID 陣列 |
| `node.next` | 後繼 stage ID 陣列（空 = 最後一個 stage） |
| `node.onFail` | `{target, maxRetries, currentRound}` 或 null |
| `node.barrier` | `{group, total, siblings}` 或 null |
| `context_files` | 前驅 stage 的 context file 路徑（barrier 收斂時多個） |
| `env` | 環境偵測結果（語言、框架、前端） |
| `retryContext` | Reflexion Memory 摘要（首次為 null，回退時注入） |
| `wisdom` | 跨 stage 知識累積摘要（如有） |
| `signals` | 確定性信號結果（lint/test，僅 QUALITY stage） |
| `phaseScopeHint` | Phase 任務範圍（Phase-Level D-R-T 時注入） |

**截斷策略**：Node Context 上限 2500 chars，超出時三層降級 — 先清空 reflectionContent → 再清空 wisdom → 最後只保留 hint。

### 2.2 PIPELINE_ROUTE（節點輸出）

Sub-agent 完成後，在回應尾部輸出結構化路由指令：

`<!-- PIPELINE_ROUTE: {"verdict":"PASS","route":"NEXT","context_file":"..."} -->`

| 欄位 | 說明 |
|------|------|
| `verdict` | `PASS` / `FAIL` |
| `route` | `NEXT` / `DEV` / `BARRIER` / `COMPLETE` |
| `severity` | FAIL 時的嚴重度（`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`） |
| `context_file` | 品質報告的檔案路徑（`~/.claude/pipeline-context-{sid}-{stage}.md`） |
| `hint` | 給下一個節點的簡短提示 |
| `barrierGroup` | Barrier 群組 ID（route=BARRIER 時） |

**Context File 規範**：由 Sub-agent 使用 Write 工具寫入，上限 5000 chars。Main Agent 不讀取內容，只傳遞路徑。Pipeline 完成 / cancel / session-cleanup 時清理。

### 2.3 回應隔離

品質 Agent（REVIEW/TEST/QA/E2E）必須將詳細報告寫入 context_file，回應只返回一行結論。兩道防線：

1. **context_file 物理隔離**：報告寫入獨立檔案，不在回應中出現
2. **Guard 阻擋**：即使 Main Agent 看到報告內容，也無法自行修改程式碼

### 2.4 路由指令類型

| Route | 語意 | 觸發 |
|-------|------|------|
| `NEXT` | 前進到 DAG 中的下一個 stage | PASS 時 |
| `DEV` | 回退到 DEV stage 修復 | QUALITY FAIL 時 |
| `BARRIER` | 加入 barrier 等待其他並行 stage | 並行 QUALITY stage 時（無論 verdict） |
| `COMPLETE` | 結束 pipeline | 最後一個 stage PASS，或 next 為空時自動轉換 |

**Auto-COMPLETE 規則**：節點輸出 NEXT 但 DAG 中 next 為空陣列時，自動轉為 COMPLETE。

---

## 3. Main Agent Relay 機制

### 3.1 Node Context 生成

stage-transition hook 中的 `buildNodeContext()` 合成三個來源：

1. **DAG 拓撲**：prev/next/onFail/barrier 結構
2. **Pipeline State**：retry 計數、前驅 context file 路徑
3. **環境偵測**：env-detector 在 pipeline-init 時捕獲

**Retry Context 特殊處理**：DEV 因 REVIEW FAIL 而被委派時，需定位 REVIEW 的 Reflexion Memory 檔案。`getRetryContext()` 透過反查 `state.retries` 和 `dag[s].onFail` 映射，找到觸發 FAIL 的品質 stage。

**並行 Route 強制 BARRIER**：即使 verdict 為 PASS，有 barrier 的節點必須輸出 `route:"BARRIER"`（enforcePolicy Rule 4），因為其他並行節點可能仍在執行。

### 3.2 PIPELINE_ROUTE 解析（4 層 Fallback）

1. **Layer 1**：掃描 `<!-- PIPELINE_ROUTE: {...} -->` 標記
2. **Layer 2**：舊版 `<!-- PIPELINE_VERDICT: ... -->` fallback
3. **Layer 3**：`inferRouteFromContent` 語意推斷 — 分析最後 30 行，偵測 CRITICAL 計數、「全部通過」等信號
4. **Layer 4**：無法解析 → crash 處理（fallback 到 FAIL）

解析後經 `validateRoute`（schema 補完）→ `enforcePolicy`（4 規則覆寫）：

| 規則 | 條件 | 處置 |
|------|------|------|
| Rule 1 | PASS + route=DEV | 矛盾 → 強制 NEXT |
| Rule 2 | retries ≥ maxRetries | 強制 NEXT + `_retryExhausted` 標記 |
| Rule 3 | DAG 無 DEV stage | 強制 NEXT |
| Rule 4 | Barrier siblings 仍在 active | 強制 BARRIER |

### 3.3 Stage 識別與狀態追蹤

**delegation-tracker**（PreToolUse Task）攔截委派呼叫，從 prompt 中解析目標 stage，維護 `state.activeStages` 陣列。

**stage-transition**（SubagentStop）從 `agent_transcript_path` 解析 agent 類型，透過 `NAMESPACED_AGENT_TO_STAGE` 反查 stage 名稱，從 `activeStages` 移除。

**suffixed stage 追蹤**：Phase-Level D-R-T 產生的 `TEST:2` 等 suffixed stage，由 `resolveSuffixedStage` 逆序找「依賴已滿足 + pending/active」的最晚匹配。

### 3.4 進度追蹤（TaskList）

Pipeline active 且 stages ≥ 2 時，classify() 注入 TaskList 指引到 systemMessage，提示 Main Agent 使用 TaskCreate/TaskUpdate 追蹤各階段進度。Phase-Level D-R-T 時，`buildPhaseProgressSummary()` 額外建議為每個 Phase 建立獨立的 TaskList 條目。

Guard 白名單包含 TaskCreate/TaskUpdate，確保 Main Agent 在 pipeline active 時仍可更新進度。

### 3.5 資訊隔離

Main Agent 的 context 中不應出現 Sub-agent 的詳細工作內容。隔離實現：

| 層 | 機制 |
|----|------|
| context_file | 報告寫入獨立檔案，Main Agent 只傳遞路徑 |
| 回應格式約束 | 品質 Agent 只返回一行結論 |
| Guard 阻擋 | 即使洩漏，Main Agent 也無法自行修改 |

---

## 4. 並行執行

### 4.1 Barrier 機制

當 DEV PASS 且 next 包含多個 QUALITY stage（如 REVIEW + TEST），同時委派所有 stage。每個完成的 stage 輸出 `route:"BARRIER"` → `updateBarrier` 累計到 `barrier-state-{sid}.json`。

**生命週期**：createBarrierGroup → updateBarrier（冪等）→ mergeBarrierResults → FAIL 時 deleteBarrier + 清理 → timeout force-unlock

**合併規則**（Worst-Case-Wins）：任一 FAIL → 整組視為 FAIL → 回退到 DEV（所有 barrier siblings 重設為 pending）。

**跨 barrier 回退**：`full` pipeline 有 `post-dev` 和 `post-qa` 兩組 barrier。`post-qa` FAIL 回退到 DEV 時，`post-dev` 內的 REVIEW/TEST 也必須重設重跑，因為 DEV 新修改可能影響其結論。

**Barrier-crash guard**：若 barrier sibling 為 pending+crashed，從 readyStages 排除 barrier.next 下游 stage，強制先重跑 crashed sibling。

### 4.2 Atomic Write

所有 state 檔案寫入使用 `atomicWrite()`：以 `pid.timestamp.counter` 三因子唯一性產生暫存檔名，寫入後 `renameSync` 原子替換，避免並行寫入損毀。

### 4.3 ECC 並行委派行為

ECC 不支援真正的並行委派（Main Agent 一次只能發一個 Task call）。並行效果來自：第一個 Sub-agent 完成後，stage-transition 同時將兩個 stage 標記為 ready，Main Agent 依序委派但不等第一個完成就委派第二個。Barrier 計數器處理到齊時序。

---

## 5. Classifier（Always-Pipeline）

### 5.1 分類架構

v5 Always-Pipeline 分類器：所有使用者 prompt 都經過 pipeline 分類，由 Main Agent 主動選擇最適合的 pipeline。

**三層分類**：

| 層 | 機制 | 說明 |
|----|------|------|
| Layer 1 | 顯式 `[pipeline:xxx]` | 使用者在 prompt 中明確指定，直接建 DAG |
| System | `isSystemFeedback()` | 系統通知（SYSTEM_MARKER + emoji 前綴）跳過分類 |
| Layer 2 | Main Agent 主動選擇 | systemMessage 注入 10 行 pipeline 選擇表，Main Agent 根據完整對話 context 選擇 |

**Layer 2 流程**：classify() 返回 `{pipeline:'none', source:'main-agent'}`，不觸發 DAG 建立。同時注入 systemMessage 包含 pipeline 選擇表，Main Agent 自行判斷後呼叫 `/vibe:pipeline`。不確定時用 AskUserQuestion 反問使用者。

**isSystemFeedback() 偵測**：結構化 SYSTEM_MARKER 標記（最可靠）+ emoji 前綴（⛔⚠️✅🔄📋➡️📌📄）+ 英文通知模式（background task 回報）。

### 5.2 Pipeline 選擇表

注入到 systemMessage 的選擇表覆蓋 10 種 pipeline 模板，Main Agent 根據 prompt 語意匹配：

- 新功能含 UI → `full`
- 新功能/大重構 → `standard`
- bugfix/小改動 → `quick-dev`
- hotfix/一行修改 → `fix`
- TDD → `test-first`
- 純 UI → `ui-only`
- 純審查 → `review-only`
- 純文件 → `docs-only`
- 安全修復 → `security`
- 問答/研究 → `none`

---

## 6. Phase-Level D-R-T

### 6.1 概念

當 tasks.md 有 ≥ 2 個 `## Phase N: 標題` 分組時，`phase-parser.js` 自動解析並生成 suffixed stage DAG，讓每個 phase 擁有獨立的 D-R-T 循環。1 個 phase 或無 phase → 退化為標準單 D-R-T。

### 6.2 DAG 生成

`parsePhasesFromTasks()` 解析 tasks.md，`generatePhaseDag()` 生成 suffixed DAG：

例如 3 個 phase 的 `standard` pipeline：
```
PLAN → ARCH → DEV:1 → [REVIEW:1 ∥ TEST:1] → DEV:2 → [REVIEW:2 ∥ TEST:2] → DEV:3 → [REVIEW:3 ∥ TEST:3] → DOCS
```

每個 `:N` suffix 對應一個 phase，barrier/onFail/maxRetries 自動注入。

### 6.3 Phase 分組準則

由 Architect agent 決定分組（語意決策 → AI）：

- **功能內聚**：同一模組或功能路徑的 checkbox 放同一 phase
- **依賴鏈分離**：checkbox A 依賴 B 的產出 → B 在前驅 phase
- **大小平衡**：每個 phase 2-5 個 checkbox
- **phase 總數**：建議 3-7 個

### 6.4 Node Context Phase 範圍

DEV agent 收到 `phaseScopeHint`，列出當前 phase 的任務範圍，使其只聚焦相關 checkbox。

---

## 7. 節點自治與 Policy

### 7.1 節點類型

| 類型 | Stages | 路由行為 |
|------|--------|---------|
| IMPL | PLAN/ARCH/DESIGN/DEV/DOCS | 永遠 `route:"NEXT"`（onFail=null） |
| QUALITY | REVIEW/TEST/QA/E2E | 依判定結果 PASS→NEXT / FAIL→DEV / 有 barrier→BARRIER |

### 7.2 Retry 持久化

retry 計數由 stage-transition 集中管理（`state.retries`），不由個別節點追蹤。DEV 收到的 `onFail.currentRound` 是從 `state.retries[failedStage]` 計算，確保跨 session 一致。

retry-policy 分析收斂趨勢（improving/worsening/stable + 停滯偵測），retries ≥ maxRetries 時強制 FORCE_NEXT 繼續。

### 7.3 不可信節點防護

**Layer 1 — Schema Validation**：`validateRoute()` 補完缺失欄位、清理非法值。

**Layer 2 — Policy Enforcement**：`enforcePolicy()` 4 規則覆寫邏輯矛盾或違反策略的路由（見 §3.2）。

**PIPELINE_ROUTE 雙層防禦**：
- Layer 1 預防：Agent.md ⛔ 無條件輸出聲明（非條件式）
- Layer 2 安全網：`inferRouteFromContent` 從 agent 輸出語意推斷

---

## 8. Pipeline Catalog 與 DAG

### 8.1 Pipeline Catalog（10 種模板）

`registry.js` 的 `PIPELINES` 定義 10 種參考模板：

| 模板 | DAG 拓撲 | Barrier Group | onFail 目標 |
|------|----------|:-------------:|:-----------:|
| **full** | PLAN→ARCH→DESIGN→DEV→[REVIEW∥TEST]→[QA∥E2E]→DOCS | post-dev, post-qa | QUALITY→DEV |
| **standard** | PLAN→ARCH→DEV→[REVIEW∥TEST]→DOCS | post-dev | QUALITY→DEV |
| **quick-dev** | DEV→[REVIEW∥TEST] | post-dev | QUALITY→DEV |
| **fix** | DEV | （無） | （無） |
| **test-first** | TEST:write→DEV→TEST:verify | （無） | TEST:verify→DEV |
| **ui-only** | DESIGN→DEV→QA | （無） | QA→DEV |
| **review-only** | REVIEW | （無） | FAIL 強制 COMPLETE |
| **docs-only** | DOCS | （無） | （無） |
| **security** | DEV→[REVIEW∥TEST] | post-dev | QUALITY→DEV |
| **none** | （不建 DAG） | — | — |

**Barrier 規則**：兩個 QUALITY stages 共享相同前驅時，自動歸入同一 barrier group。

**onFail 規則**：QUALITY stage 的 onFail 指向最近的 IMPL stage（通常 DEV）。無 DEV 的 pipeline（如 review-only）FAIL 不回退，以 WARNING 完成。

### 8.2 衍生值 derivePhase()

純函式，從 state 即時推導當前 phase（供 Dashboard/Timeline 使用）：

| 條件（依序短路） | Phase |
|----------------|-------|
| `!pipelineActive` | IDLE |
| `!dag` | CLASSIFIED |
| `activeStages.length > 0` | DELEGATING |
| 全部 completed/skipped | COMPLETE |
| 有 failed + retries > 0 | RETRYING |
| 其餘 | CLASSIFIED |

Guard 使用 `pipelineActive` 布林值而非 derivePhase。

---

## 9. 迭代優化機制

三層迭代 + 四項輔助機制：

```
  Stage 內 Self-Refine（品質 Agent 自我修正 → 減少回退）
          │ 仍然 FAIL
          v
  多維收斂條件 shouldStop（判斷是否值得繼續）
  ├── stop=true  → FORCE_NEXT
  ├── stop=false → RETRY
          │ RETRY
          v
  Reflexion Memory（記錄反思 → 注入下一輪 DEV context）
```

### 9.1 Reflexion Memory

`reflection-memory-{sessionId}-{failedStage}.md` — 跨迭代反思記憶。

- **寫入時機**：stage-transition 處理 FAIL 回退前
- **讀取時機**：委派回退目標（DEV）時注入 Node Context
- **格式**：Markdown `## Round N` 分段，記錄 verdict、severity、關鍵問題
- **大小限制**：每輪 ≤ 500 chars，總計 ≤ 3000 chars，超過截斷最舊 round
- **清理**：failed stage PASS 後自動刪除

### 9.2 Self-Refine 微迴圈

品質 Agent 在自身 session 內嘗試修正後再做最終裁決，減少跨 stage 回退的高昂代價。

1. Phase 1 — 審查：完整審查，標記所有問題
2. Phase 2 — Self-Refine：對 MEDIUM 以下問題嘗試自行修正
3. Phase 3 — 最終裁決：修正後重新評估

**約束**：CRITICAL 永不降級；最多嘗試一輪 Self-Refine。

### 9.3 三信號驗證

`collectSignals()` 在 QUALITY stage（REVIEW/TEST/QA/SECURITY）委派前收集確定性信號：

| 信號 | 來源 | 說明 |
|------|------|------|
| lint | 執行 lint 指令 | 靜態分析結果（timeout 15 秒） |
| test | 執行 test 指令 | 測試結果 |

信號注入 Node Context 的 `signals` 欄位，品質 Agent 參考確定性信號做決策。低信心判定（uncertain）時自動升級。

### 9.4 shouldStop — 多維收斂條件

retry-policy 分析 `retryHistory` 陣列判斷是否繼續：

| 條件 | 結果 |
|------|------|
| PASS | NEXT |
| retries ≥ maxRetries | FORCE_NEXT |
| 趨勢分析（severity 改善/惡化/停滯） | 資訊性，不觸發停止 |

### 9.5 Goal Objects

proposal.md 中的 `## Goal` 區塊定義量化成功標準：

- `success_criteria`：可量化驗證的成功條件
- `constraints`：限制與邊界條件

code-reviewer 驗證達成度、tester 推導測試案例。

### 9.6 Wisdom Accumulation

`wisdom.js` — 跨 stage 知識傳遞。品質 stage PASS 後，自動提取學習筆記寫入 `pipeline-wisdom-{sid}.md`，後續 stage 讀取注入 Node Context。

- `extractWisdom(stageId, contextContent)` — 從 context_file 提取結構化摘要（markdown 要點優先，無要點時取前幾段）
- `writeWisdom(sessionId, stageId, summary)` — appendFileSync 追加
- `readWisdom(sessionId)` — 讀取並截斷到 500 chars

### 9.7 FIC 狀態壓縮

`status-writer.js` — 每個 stage PASS 後生成壓縮狀態摘要，寫入 `pipeline-status-{sid}.md`。於 Compact/Resume/Crash Recovery 時注入 additionalContext，降低 context 消耗。

摘要格式：已完成 stages（含時間）+ 進行中 stages + 待執行 stages + 決策記錄（從 wisdom 提取）。

---

## 10. 邊界情境與防護

### 10.1 死鎖 / 卡住

| 情境 | 偵測 | 處置 |
|------|------|------|
| Sub-agent 沒輸出 PIPELINE_ROUTE | 4 層 fallback，Layer 3 語意推斷 | 推斷失敗 → FAIL fallback |
| Sub-agent crash | transcript 為 null | crash 計數 +1，stage 重設為 pending，crash recovery 三層推斷 |
| Barrier 永遠不齊 | Barrier timeout（`createdAt` + 閾值） | force-unlock，absent → FAIL |
| Pipeline active 但無下一步 | pipeline-check（Stop hook） | `decision:"block"` 阻擋結束，reason 提示繼續委派 |
| 無限重試 | enforcePolicy Rule 2 | retries ≥ maxRetries → FORCE_NEXT |

### 10.2 恢復 / 接手

| 情境 | 機制 |
|------|------|
| Session 中斷恢復 | pipeline-init 讀取 state + FIC status → resume 注入 |
| 使用者想跳過 stage | `[pipeline:xxx]` 自訂 DAG 排除該 stage |
| 使用者想取消 | `/vibe:cancel` → pipelineActive=false + state 清理 |
| 多 Session 衝突 | session-cleanup 清理非本 session 的 COMPLETE state（5 分鐘寬限期） |

### 10.3 資訊流

| 情境 | 防護 |
|------|------|
| Transcript 洩漏 | context_file + 回應格式約束 + guard 阻擋寫入 |
| context_file 被刪除 | 按無 context 處理 |
| Node Context stale | 每次委派重新生成 |

### 10.4 並行

| 情境 | 機制 |
|------|------|
| 並行結果矛盾（REVIEW PASS + TEST FAIL） | Worst-Case-Wins → 整組 FAIL |
| Barrier 計數器損毀 | state-migrator 修復 + 防重複觸發（resolved flag） |
| 跨 barrier 回退 | 被跨越的 barrier group 內 stages 全部重設 |

### 10.5 邊界

| 情境 | 處置 |
|------|------|
| 單階段 Pipeline（fix） | 無 barrier/retry，PASS → COMPLETE |
| 空 DAG（none） | 不建 DAG，pipelineActive=false |
| maxRetries 耗盡 | FORCE_NEXT + WARNING 前綴 |
| COMPLETE→reset 競爭 | 30 秒冷卻期防止 classifier 覆寫 |

---

## 11. 風險評估

| 風險 | 嚴重度 | 緩解 | 狀態 |
|------|:------:|------|:----:|
| Transcript 洩漏 | 高 | context_file + 回應格式 + guard 阻擋 | ⚠️ LLM 不完全受控，但 guard 保底 |
| Context Window 壓縮 | 高 | Node Context 三層截斷 + FIC 狀態壓縮 | ⚠️ MCP 工具定義佔用根因 |
| 節點輸出格式錯誤 | 中 | 4 層 fallback | ✅ 穩定 |
| 系統通知誤分類 | 中 | isSystemFeedback() 三重偵測 | ✅ 已解決 |
| Cancel skill 死鎖 | 中 | 透過委派 developer 繞過 | ⚠️ workaround |
| 並行 barrier 遺漏 | 中 | Barrier timeout + crash guard | ✅ 穩定 |
| Self-Refine 降級不當 | 中 | CRITICAL 永不降級 | ✅ 穩定 |
| State 寫入損毀 | 低 | Atomic Write 三因子唯一性 | ✅ 穩定 |
| Reflexion Memory 累積 | 低 | 每輪 500 chars + PASS 自動清理 | ✅ 穩定 |

---

## 附錄 A：PIPELINE_ROUTE Schema

| 欄位 | 類型 | 必填 | 說明 |
|------|------|:----:|------|
| `verdict` | `"PASS"` / `"FAIL"` | ✅ | 裁定結果 |
| `route` | `"NEXT"` / `"DEV"` / `"BARRIER"` / `"COMPLETE"` | ✅ | 路由指令 |
| `severity` | `"CRITICAL"` / `"HIGH"` / `"MEDIUM"` / `"LOW"` | | FAIL 嚴重度 |
| `context_file` | string | | 品質報告檔案路徑 |
| `hint` | string | | 給下一節點的簡短提示 |
| `warning` | string | | 策略覆寫說明 |
| `barrierGroup` | string | | Barrier 群組 ID |

---

## 附錄 B：Node Context Schema

外層 `node` wrapper 包含：

| 欄位 | 類型 | 說明 |
|------|------|------|
| `node.stage` | string | 當前 stage ID |
| `node.prev` | string[] | 前驅 stage |
| `node.next` | string[] | 後繼 stage（空 = 最後） |
| `node.onFail` | object / null | `{target, maxRetries, currentRound}` |
| `node.barrier` | object / null | `{group, total, siblings}` |
| `context_files` | string[] | 前驅 context file 路徑 |
| `env` | object | 環境偵測（language, framework, frontend） |
| `retryContext` | object / null | `{round, reflectionFile, failedStage, hint}` |
| `wisdom` | string / null | 跨 stage 知識累積摘要 |
| `signals` | object / null | `{lint, test}` 確定性信號結果 |
| `phaseScopeHint` | string / null | Phase 任務範圍提示 |

---

## 附錄 C：Pipeline State Schema

### C.1 主 State（`pipeline-state-{sessionId}.json`）

| 欄位 | 類型 | 說明 | 寫入者 |
|------|------|------|--------|
| `sessionId` | string | Session 識別碼 | pipeline-init |
| `pipelineActive` | boolean | Guard 唯一判斷依據 | classify / stage-transition / cancel |
| `classification` | object | `{pipelineId, taskType, source, timestamp}` | task-classifier |
| `dag` | object | DAG 結構（建立後不變） | classify / pipeline-architect |
| `stages` | object | 各 stage 狀態 `{status, contextFile, completedAt, verdict}` | stage-transition |
| `stages[].status` | enum | `pending` / `active` / `completed` / `failed` / `skipped` | stage-transition |
| `activeStages` | string[] | 正在執行的 stages | delegation-tracker |
| `retries` | object | 各 stage 重試計數 | stage-transition |
| `crashes` | object | 各 stage crash 計數 | stage-transition |
| `retryHistory` | object | 歷史 verdict 摘要 `{[stage]: [{round, severity, hint, timestamp}]}` | stage-transition |
| `environment` | object | 環境偵測 `{languages, framework, frontend}` | pipeline-init |
| `phaseInfo` | object / null | Phase 名稱/tasks 映射（Phase-Level D-R-T 時） | phase-parser |
| `meta` | object | `{lastTransition, reclassifications}` | stage-transition |

### C.2 Barrier State（`barrier-state-{sessionId}.json`）

| 欄位 | 說明 |
|------|------|
| `total` | 並行節點總數 |
| `completed` | 已完成的節點 ID 陣列 |
| `results` | 各節點的 PIPELINE_ROUTE |
| `next` | 全部到齊後的下一 stage |
| `createdAt` | ISO 8601 建立時間 |
| `resolved` | 是否已處理 |

### C.3 輔助檔案

| 檔案 | 路徑 | 說明 |
|------|------|------|
| Context File | `pipeline-context-{sid}-{stage}.md` | Sub-agent 品質報告 |
| Reflexion Memory | `reflection-memory-{sid}-{stage}.md` | 跨迭代反思記憶 |
| Wisdom | `pipeline-wisdom-{sid}.md` | 跨 stage 知識累積 |
| Status | `pipeline-status-{sid}.md` | FIC 壓縮狀態摘要 |

所有檔案位於 `~/.claude/` 下，Pipeline 完成 / cancel / session-cleanup 時統一清理。

---

## 附錄 D：設計決策紀錄

| 決策 | 處置 | 說明 |
|------|:----:|------|
| context_file 路徑傳遞 | ✅ | 物理隔離，取代 inline context |
| Atomic Write | ✅ | 主 state + barrier state 統一原子寫入 |
| Schema Validation + Policy Enforcement | ✅ | 雙層驗證 |
| env-detector 注入 Node Context | ✅ | 環境偵測資訊傳遞 |
| pipelineActive 二元 Guard | ✅ | 取代 5-phase 推導 |
| Barrier 計數器 | ✅ | O(1) 取代全量 DAG 查詢 |
| Reflexion Memory Markdown | ✅ | LLM 可直接閱讀 |
| Barrier state 獨立 | ✅ | 生命週期與主 state 不同 |
| Always-Pipeline classifier | ✅ | 刪除 heuristic，Main Agent 主動選擇 |
| Phase-Level D-R-T | ✅ | ≥ 2 phase 自動生成 suffixed DAG |
| Wisdom Accumulation | ✅ | 品質 PASS 後自動提取跨 stage 知識 |
| FIC Status Compression | ✅ | Compact/Resume 時注入壓縮摘要 |
| TaskList 進度追蹤 | ✅ | classify() systemMessage 注入，Guard 白名單放行 |
| Phase 分組由 Architect 決定 | ✅ | 語意決策 → AI，2-5 items/phase |
