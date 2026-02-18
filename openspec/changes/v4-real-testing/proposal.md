# Pipeline v4 全面測試 — 62 場景矩陣

## 背景與動機

Pipeline v4 引入分散式節點架構，核心機制包含：
- **pipelineActive 布林守衛**（取代 v3 複雜的 5 phase 推導）
- **PIPELINE_ROUTE 協議**（Sub-agent 自主路由）
- **Node Context 動態注入**（prev/next/onFail/maxRetry/retryContext）
- **Barrier 並行**（REVIEW+TEST 等品質階段可並行執行）
- **Reflexion Memory**（跨迭代學習的 episodic memory）

現有測試覆蓋 v3 核心邏輯，但缺乏針對 v4 新機制的系統性測試。需要 62 個場景矩陣驗證 v4 全生命週期正確性。

## 測試矩陣（62 場景）

### A 分類邏輯（A01-A08）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| A01 | 顯式 [pipeline:standard] 分類 | classify() 回傳 systemMessage 含 pipelineId |
| A02 | 顯式 [pipeline:none] 不建 DAG | classify() 回傳分類指令 systemMessage |
| A03 | 非顯式 prompt-hook 分類 | source='prompt-hook'，回傳 null output |
| A04 | COMPLETE state 自動 reset | 再次分類前 state 被重設 |
| A05 | 升級分類（fix→standard） | PIPELINE_PRIORITY 升級判斷 |
| A06 | 降級不 stale 不重分類 | stale 檢查（10 分鐘窗口） |
| **A07** | **已取消 state 下顯式重啟** | **非顯式抑制，顯式重設 state** |
| **A08** | **已取消 state 下非顯式抑制** | **isCancelledState 判斷正確** |

### B DAG 建立（B01-B06）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| B01 | quick-dev templateToDag | deps 結構 + barrier 配置 |
| B02 | full pipeline templateToDag | 兩個 barrier groups |
| B03 | 重複 stage（test-first）→ pipeline-architect | hasUniqueStages=false |
| B04 | DESIGN skip（非前端） | shouldSkip 跳過 DESIGN |
| B05 | DESIGN 保留（前端） | needsDesign=true 不跳過 |
| B06 | 無效 DAG 驗證（環偵測） | validateDag 回傳 errors |

### C Guard 防護（C01-C07）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| **C01** | **pipelineActive=false → allow** | **3. v4 核心：放行** |
| **C02** | **pipelineActive=true + activeStages → allow** | **4. sub-agent 委派中** |
| **C03** | **pipelineActive=true + 無 activeStages + Write → block** | **7. must-delegate** |
| **C04** | **Read 唯讀白名單 → allow** | **6. READ_ONLY_TOOLS** |
| **C05** | **EnterPlanMode → block** | **1. 無條件** |
| **C06** | **Bash rm -rf / → block** | **2. DANGER_PATTERNS** |
| **C07** | **Bash echo > src/foo.js → block（pipelineActive）** | **2.5. 寫檔偵測** |

### D PIPELINE_ROUTE 解析（D01-D06）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| D01 | 正常 PASS PIPELINE_ROUTE | parseRoute source='route' |
| D02 | 正常 FAIL PIPELINE_ROUTE | verdict + severity + route |
| **D03** | **PIPELINE_VERDICT fallback（v3 格式）** | **source='verdict-fallback'** |
| **D04** | **validateRoute 補完（FAIL 缺 severity）** | **自動補 MEDIUM** |
| **D05** | **enforcePolicy Rule 1（PASS+DEV→NEXT）** | **邏輯矛盾修正** |
| **D06** | **enforcePolicy Rule 3（無 DEV→NEXT）** | **DAG 缺 DEV 強制 NEXT** |

### E 回退機制（E01-E07）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| E01 | REVIEW FAIL:HIGH → DEV 回退 | setPendingRetry + markStageFailed |
| E02 | DEV 完成後重跑 REVIEW | clearPendingRetry + resetStageToPending |
| E03 | REVIEW FAIL:MEDIUM → NEXT（不回退） | convertVerdictToRoute MEDIUM→NEXT |
| **E04** | **MAX_RETRIES 達上限（retries=3）** | **enforcePolicy Rule 2** |
| **E05** | **無 DEV 的 pipeline FAIL 強制繼續** | **review-only FAIL → 強制前進** |
| **E06** | **pendingRetry 跨 session 保留** | **readState + pendingRetry 不遺失** |
| **E07** | **retryHistory 追加記錄** | **addRetryHistory 每輪追加** |

### F Barrier 並行（F01-F06）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| **F01** | **REVIEW+TEST 雙 PASS** | **mergeBarrierResults 全 PASS** |
| **F02** | **REVIEW PASS + TEST FAIL** | **Worst-Case-Wins FAIL** |
| **F03** | **barrier 超時強制解鎖** | **checkTimeout → timedOut stages → FAIL** |
| **F04** | **barrier 回退後刪除計數器** | **deleteBarrier on FAIL route=DEV** |
| F05 | barrier group 冪等（重複 updateBarrier） | 同 stage 不重複計數 |
| **F06** | **severity 合併（CRITICAL+HIGH=CRITICAL）** | **SEVERITY_ORDER 排序** |

### G 閉環（G01-G07）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| G01 | 完成後 pipelineActive=false | onSessionStop 放行 |
| G02 | 未完成 → stop 阻擋 | continue: false |
| G03 | pendingRetry 優先（missing 首位） | DEV 排在 missing 最前 |
| G04 | active stage 在 missing 列表 | 正在執行的也列入 |
| **G05** | **連續阻擋 ≥3 → cancel 提示** | **pipelineCheckBlocks 計數** |
| **G06** | **onDelegate 重設阻擋計數** | **委派後計數器歸零** |
| **G07** | **pipelineActive=false → onSessionStop 返回 null** | **v4 核心：布林判斷** |

### H Node Context（H01-H05）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| **H01** | **buildNodeContext 基本注入** | **prev/next/onFail 正確** |
| **H02** | **context_files 從前驅 stage 讀取** | **state.stages[prev].contextFile** |
| **H03** | **retryContext 第一次為 null** | **無重試歷史時 null** |
| **H04** | **retryContext 有回退記錄** | **readReflection 非空** |
| **H05** | **Reflexion Memory PASS 後清除** | **cleanReflectionForStage** |

### I Timeline 事件（I01-I05）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| I01 | emit PIPELINE_CLASSIFIED 事件 | query 取得 1 筆 |
| I02 | emit STAGE_COMPLETE 事件 | query 取得含 stage 欄位 |
| I03 | emit BARRIER_WAITING 事件 | query 取得 barrierGroup |
| **I04** | **Timeline JSONL 持久化驗證** | **append-only, maxEvents=2000** |
| I05 | emit RETRY_EXHAUSTED 事件 | query 含 retryCount |

### J 邊界與錯誤（J01-J05）

| 場景 | 描述 | 測試目標 |
|------|------|---------|
| **J01** | **state 損壞（JSON 格式錯誤）** | **readState 回 null** |
| **J02** | **transcript 不存在 → parseRoute 回 none** | **source='none'** |
| **J03** | **v2→v4 遷移鏈** | **ensureV4 兩步遷移** |
| **J04** | **ABORT route → pipelineActive=false** | **強制終止解除 guard** |
| J05 | atomicWrite tmp 唯一性 | pid.timestamp.counter 三因子 |

## 實作策略

### Phase 1：Hook-Integration 測試（26 個場景）
- A07, A08（分類邊界）
- C01-C07（Guard 完整覆蓋）
- D03-D06（Route 解析驗證）
- E04-E07（回退邊界）
- F01-F04, F06（Barrier 生命週期）
- G05-G07（閉環邊界）
- H01-H05（Node Context）
- J01-J04（錯誤處理）
- I04（Timeline 持久化）

### 測試方法
- 直接 import 模組（非 hook 腳本）
- 使用 test-helpers.js 的 cleanTestStateFiles / cleanSessionState
- 含 `!` 的邏輯寫到暫存檔（zsh 歷史擴展問題）
