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

## P4：系統通知誤分類（嚴重度：中）

**現狀**：background task 完成通知（如 `vibe:developer 完成`）、`⚠️` 警告訊息、prompt hook 的 stop feedback 等系統訊息，可能被 classifier heuristic 誤判為 bugfix 或 feature，觸發不必要的 pipeline。

**已有緩解**（v2.0.13）：
- `system-feedback` heuristic 擴充為函式，覆蓋 3 組模式（pipeline feedback、⚠️ 警告、background task 通知）
- `bugfix` heuristic 排除清單加入 pipeline 關鍵詞
- active pipeline 抑制（30 秒冷卻期）

**殘留風險**：heuristic 是 pattern matching，新格式的系統訊息可能繞過現有規則。需持續觀察並擴充排除清單。

---

## P5：Classifier Layer 1.5 侷限（嚴重度：低）

**現狀**：regex heuristic（Layer 1.5）只處理明確的單階段 pipeline（fix/docs-only/none）。多階段任務必須由使用者顯式指定 `[pipeline:xxx]` 或依賴 Layer 2（Main Agent 判斷）。

**影響**：Layer 2 依賴 Main Agent 的 context 理解能力，偶爾會選擇不合適的 pipeline（如對大型重構選擇 fix 而非 standard）。

**改進方向**：擴充 Layer 1.5 的啟發式規則（如偵測「重構」+ 多檔案提及 → standard），但需平衡精確度和維護成本。

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

## P7：RAM 累積（嚴重度：中）

**現狀**：長時間 session 中，V8 記憶體碎片化 + chroma-mcp 孤兒進程 + chrome-mcp 殘留 + cache/log 累積，導致 RAM 持續增長。

**已有緩解**：`/vibe:health` 可偵測和清理，但需要使用者手動觸發。

**改進方向**：在 `session-cleanup`（SessionStart hook）中加入 RAM 水位偵測，自動觸發清理。

---

## P8：Barrier Timeout 可靠性（嚴重度：低）

**現狀**：ECC hooks-only 架構無定時器。Barrier timeout 偵測依賴下一次 hook 觸發（stage-transition 或 UserPromptSubmit）。如果使用者長時間不操作，timeout 不會被偵測到。

**實際影響**：極少發生。大部分 barrier timeout 場景由 crash recovery（SubagentStop）觸發偵測。

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
