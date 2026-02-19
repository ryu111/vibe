# Pipeline 已知問題與技術債務

> 從 `pipeline.md` 第 12 節提取。截至 v2.0.13（2026-02）的已知問題和改進空間。

---

## 優先級排序

| 優先級 | 問題 | 理由 |
|:------:|------|------|
| **高** | P6 Context Window | 直接影響 agent 品質和整體效能 |
| **中** | P4 系統通知誤分類 | 影響使用者體驗（不必要的 pipeline 啟動） |
| **中** | P1 Cancel 死鎖 | workaround 可運作但不優雅 |
| **中** | P9 Transcript 洩漏 | token 浪費，長 session 累積效應 |
| **低** | P2 多次 writeState | 效能微量損失 |
| **低** | P3 ABORT 未使用 | 死碼，不影響功能 |
| **低** | P5 Classifier 侷限 | Layer 2 作為 fallback 尚可接受 |
| **低** | P7 RAM 累積 | 有手動工具可用 |
| **低** | P8 Barrier Timeout | 極少觸發 |
| **低** | P10 Suffixed Stage | 功能正確，僅維護成本 |

---

## P1：Cancel Skill 死鎖（嚴重度：中）✅ 已修復

**修復內容（v2.0.7+）**：`guard-rules.js` 規則 6.5 新增白名單機制，放行以下 3 種 state file 的寫入（必須在 `~/.claude/` 目錄下）：

1. **pipeline-state-*.json** — cancel skill 解除 pipeline guard
2. **task-guard-state-*.json** — cancel skill 解除 task-guard
3. **classifier-corpus.jsonl** — cancel 語料回饋收集

**實作位置**：`plugins/vibe/scripts/lib/sentinel/guard-rules.js` 第 225-246 行（規則 6.5）

**特點**：
- 白名單是路徑級別約束（必須在 `~/.claude/` 下）
- 採用前綴+後綴匹配（避免過於寬鬆）
- 相比 v3 的 `CANCEL_STATE_FILE_RE`，更精確和可擴展

**測試**：`plugins/vibe/tests/guard-rules.test.js` 案例 3.5-3.10 覆蓋完整白名單邏輯

---

## P2：onStageComplete() 多次 writeState（嚴重度：低）✅ 已修復

**修復內容（v2.0.9+）**：在 `onStageComplete()` 中提前執行 `isComplete()` 檢查，合併分支 C（正常前進→完成）和 BARRIER-PASS→完成 的雙重 writeState。

**修復位置**：
1. **分支 C 正常前進**（行 1173-1194）：先檢查 isComplete → 修改 pipelineActive + activeStages → cleanupPatches → 單次 writeState
2. **BARRIER-PASS 完成**（行 1020-1027）：同樣先檢查 isComplete → 合併狀態修改 → 單次 writeState

**效果**：
- 消除 2 處雙重 writeState 的浪費（每處減少 1 次磁碟 I/O）
- autoCheckpoint 保持在 writeState 之後，時序不變

**測試**：現有 28+ 個測試檔驗證路由邏輯完整性，未發生重迴歸

---

## P3：ABORT Route 未實際使用（嚴重度：低）

**現狀**：`PIPELINE_ROUTE` schema 定義了 `route: "ABORT"`，E22 描述了處理邏輯，但實際上沒有任何 agent 的 `.md` 指導其輸出 ABORT。所有不可恢復情境（如 project 結構損壞）在實作中由 crash recovery 或 max-retries 處理。

**選項**：移除 ABORT route（簡化 schema）或在特定 agent 中加入 ABORT 輸出條件。

---

## P4：系統通知誤分類（嚴重度：中）✅ 已修復

**修復內容（v2.1.5+）**：三層防禦機制強化，確保系統訊息 100% 被正確攔截。

**修復層次**：

1. **結構化標記層（最可靠）**
   - 新增常數 `SYSTEM_MARKER = '<!-- VIBE_SYSTEM -->'`
   - pipeline-check.js 和 task-guard.js 中所有 block reason 和 systemMessage 都加上此標記前綴
   - classifier.js 的 `system-feedback` heuristic 優先檢查此標記（`t.includes(SYSTEM_MARKER)`）

2. **Emoji 防禦層（兜底）**
   - emoji 正則擴充從 `/^[⛔⚠️]/` → `/^[⛔⚠️✅🔄📋➡️📌📄]/`
   - 涵蓋所有 hook 可能的視覺標記

3. **英文通知模式層（最後防線）**
   - background task 完成通知、agent 回報、自動化觸發等通用英文模式

**實作位置**：
- `plugins/vibe/scripts/lib/flow/classifier.js` 第 29-34 行（SYSTEM_MARKER 定義）、第 88-95 行（system-feedback 規則擴充）
- `plugins/vibe/scripts/hooks/pipeline-check.js` — reason 前綴加入標記
- `plugins/vibe/scripts/hooks/task-guard.js` — systemMessage 前綴加入標記

**測試**：`plugins/vibe/tests/classifier-and-console-filter.test.js` 新增 11 個測試案例，驗證標記偵測、emoji 擴充、負面案例排除。

**效果**：系統訊息現在在最高優先級被攔截，即使後續 emoji 或模式新增，標記層始終有效。新格式通知也可通過更新 emoji 清單快速擴展。

---

## P5：Classifier Layer 1.5 侷限（嚴重度：低）⚠️ 部分修復

**修復內容（v2.1.5+）**：擴充啟發式規則，支援 review-only 和更多條件詢問句型。

**增強項目**：

1. **新增 review-only 單階段 pipeline**
   - 觸發：`review/審查/code review/程式碼審查/程式碼檢查` 關鍵字
   - 負面排除：`修改/修復/修正/重構/新增/建立/實作/refactor/fix/implement/add` — 防止誤判為開發任務
   - 實作：`plugins/vibe/scripts/lib/flow/classifier.js` 第 103-108 行

2. **Question 模式擴充**
   - 新增條件詢問句型：`能否/可以/有沒有/是否/是不是` 開頭
   - 不依賴末尾問號，適應多種敘述方式
   - 實作：`plugins/vibe/scripts/lib/flow/classifier.js` 第 63-66 行

3. **Pipeline 目錄提示裁剪（P6 Context Window 相關）**
   - `buildPipelineCatalogHint()` 現支援動態裁剪：有當前 pipelineId 時取相鄰 pipeline，無時列最常用 5 個
   - 節省 ~265 chars（相比全部 10 個）
   - 實作：`plugins/vibe/scripts/lib/flow/classifier.js` 第 196-236 行

**現狀與 Layer 2 分工**：
- Layer 1.5（regex）現已涵蓋：fix/docs-only/review-only/none + question 偵測（共 5 個單階段 pipeline）
- Layer 2（Main Agent）保留責任：multi-stage pipeline 判斷（full/standard/quick-dev/test-first/ui-only/security）

Layer 2 仍依賴 Main Agent 的 context 理解能力，但 systemMessage 注入現包含完整 pipeline 目錄提示，品質有保障。

**測試**：`plugins/vibe/tests/classifier-and-console-filter.test.js` 新增 13 個測試案例（review-only 正負面各 4+3 個、question 擴充 4 個）。

---

## P6：Context Window 壓縮（嚴重度：高）⚠️ 部分修復

**現狀**：MCP 工具過多時（如 chrome-mcp + claude-mem + 其他），ECC 的 context window 從 200k 壓縮到約 70k tokens。Pipeline 的 systemMessage 注入（Node Context + 委派指令）進一步消耗可用 context。

**影響**：Sub-agent 可用 context 不足 → agent 品質下降 → 更多 crash/fallback。

**已有緩解（v2.0.14+）**：
- `buildPipelineCatalogHint()` 動態裁剪 — 無參數時列 5 個最常用 pipeline 而非全部 10 個，節省 ~56%（600 chars → 265 chars）
- `formatNodeContext()` 改用 key-value 簡寫格式，去除 JSON 語法開銷，節省 ~70%（300-500 chars → 100 chars）
- `classify()` 中 `allSteps` 限制前 3 步 + 省略提示，減少長 pipeline 的步驟清單
- `suggest-compact` 整合洩漏偵測，當累積 leak >= 3000 字元時主動建議 compact

**根本限制**：MCP 工具定義佔用的 context 是平台層面問題，Pipeline 無法控制。上述優化專注於可控的注入量減少。

---

## P7：RAM 累積（嚴重度：中）✅ 已修復

**修復內容（v2.1.6+）**：在 `session-cleanup` 主流程中加入自動 RAM 水位偵測。

**修復層次**：

1. **RAM 閾值常數定義**
   - `RAM_WARN_MB = 4096`（4GB 警告）
   - `RAM_CRIT_MB = 8192`（8GB 嚴重）
   - 與 `ram-monitor.sh` 的 `WARN_THRESHOLD_MB` / `CRIT_THRESHOLD_MB` 保持一致

2. **checkRamWatermark() 函式實作**
   - 使用 `ps -eo rss,command` 一次取得所有進程
   - 匹配模式（與 ram-monitor.sh 同步）：`/(^|\/)claude( |$)/`、`/claude-in-chrome-mcp/`、`/chroma-mcp/`、`/uv tool uvx.*chroma/`、`/worker-service\.cjs/`、`/mcp-server\.cjs/`、`/vibe\/server\.js/`、`/vibe\/bot\.js/`
   - 累加匹配進程的 RSS（KB → MB 轉換）
   - 回傳 `{ totalMb: number, warning: string|null }`
   - 執行失敗時靜默回傳 `{ totalMb: 0, warning: null }`

3. **SessionStart hook 整合**
   - 在暫存檔清理（第 6 步）之後、輸出摘要之前呼叫
   - 有 warning 時合併到 `additionalContext` 輸出
   - RAM 警告獨立判斷，即使無清理動作也會輸出

**實作位置**：`plugins/vibe/scripts/hooks/session-cleanup.js`（第 1-40 行 checkRamWatermark() 函式 + 第 90-100 行主流程整合）

**特點**：
- 無額外依賴，純 JavaScript execSync 實作
- 執行時間 < 100ms
- 與 ram-monitor.sh 保持邏輯同步

**測試**：`plugins/vibe/tests/p7-p8-verification.test.js` 案例 P7-1~P7-26 覆蓋完整邏輯（RAM 累積、正常環境、timeout 處理等）

---

## P8：Barrier Timeout 可靠性（嚴重度：低）✅ 已修復

**修復內容（v2.1.6+）**：在 `pipeline-controller.classify()` 中加入 barrier timeout 主動巡檢機制。

**修復層次**：

1. **sweepTimedOutGroups() 函式實作**（barrier.js）
   - 讀取 barrier state → 遍歷未 resolved 的 groups
   - 對每個 group 呼叫 checkTimeout()
   - 超時時呼叫 updateBarrier() 填入 FAIL
   - 觸發 mergeBarrierResults() 合併結果
   - 回傳 `{ timedOut: Array<{ group, mergedResult, timedOutStages }> }`

2. **classify() 中主動巡檢**（pipeline-controller.js）
   - 在 `loadState` 之後、ACTIVE 判斷邏輯之後新增巡檢段
   - 條件：`state && ds.isActive(state) && !state?.meta?.cancelled`
   - 呼叫 `sweepTimedOutGroups(sessionId)`
   - 超時 barrier：markStageFailed 超時 stages + 發射 BARRIER_RESOLVED Timeline 事件 + 收集警告
   - 巡檢段 try-catch 包裹（失敗靜默）
   - 警告附加到 `output.additionalContext`

**實作位置**：
- `plugins/vibe/scripts/lib/flow/barrier.js`（第 150-200 行 sweepTimedOutGroups()）
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`（第 280-310 行 classify() 巡檢段）

**特點**：
- ECC hooks-only 約束下的務實方案（無定時器情況下的主動偵測）
- 冪等性設計（連續呼叫不會重複處理）
- 不依賴 UserPromptSubmit，在 SessionStart 即可自動啟動

**測試**：`plugins/vibe/tests/p7-p8-verification.test.js` 案例 P8-1~P8-25 覆蓋完整邏輯（超時 barrier 偵測、正常 barrier 不受影響、冪等性等）

---

## P9：Transcript 洩漏無法完全防止（嚴重度：中）⚠️ 部分修復

**現狀**：Agent `.md` 規範了回應格式，但 LLM 不完全受控。品質 agent 偶爾仍會在最終回應中包含完整報告，導致 Main Agent 看到問題細節。

**務實態度**：guard 確保即使洩漏，Main Agent 也無法自行修復（所有寫入被阻擋）。洩漏的實際影響是 **token 浪費**（Main Agent context 被無用資訊佔用），而非 **行為越權**。

**已有緩解（v2.0.14+）**：
- 4 個品質 agent（code-reviewer/tester/qa/e2e-runner）的 `.md` 加入 ⛔ **200 字元約束**，明確限制最終回應只輸出一句話結論 + PIPELINE_ROUTE
- `pipeline-controller.js` 新增 `getLastAssistantResponseLength()` 偵測 transcript 洩漏（> 500 chars 時 emit TRANSCRIPT_LEAK_WARNING 到 Timeline）
- `dag-state.js` 新增 `leakAccumulated` 欄位，追蹤洩漏累積量
- `suggest-compact.js` 整合洩漏感知（累積 >= 3000 字元時主動建議 compact）

**根本限制**：ECC SubagentStop hook 無法修改 `tool_result` 中的 agent 回應，洩漏攔截必須在源頭（agent .md 約束）。本方案結合「強約束」+「事後偵測」+「主動 compact」三層防禦。

---

## P10：Suffixed Stage 追蹤複雜度（嚴重度：低）

**現狀**：`deduplicateStages()` 為 test-first 等 pipeline 產生 `TEST:2` 等 suffixed stage。`resolveSuffixedStage()` 處理追蹤歧義，但邏輯複雜（多候選逆序搜尋）。

**影響**：增加 crash recovery 和 barrier 邏輯的維護負擔。

**改進方向**：考慮用唯一 stage ID（如 `TEST_WRITE` / `TEST_VERIFY`）取代數字後綴，從源頭消除歧義。
