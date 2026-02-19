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

## P1：Cancel Skill 死鎖（嚴重度：中）

**現狀**：`/vibe:cancel` 需要修改 `pipeline-state-{sid}.json` 將 `pipelineActive` 設為 `false`，但 `pipeline-guard` 的 `*` matcher 阻擋了所有工具呼叫（包括 Skill 觸發的 Write/Edit/Bash）。

**目前 workaround**：cancel skill 委派 `vibe:developer` agent → `delegation-tracker` 將其加入 `activeStages` → guard rule 放行 → developer 內部修改 state file。

**正確修復**：在 guard 中加入 cancel 白名單（匹配 `pipeline-state-*.json` 的寫入操作），類似 v3 的 `CANCEL_STATE_FILE_RE` 但更精確。

---

## P2：onStageComplete() 多次 writeState（嚴重度：低）

**現狀**：`stage-transition` 的 `onStageComplete()` 中有多處 `writeState()` 呼叫，分散在不同邏輯分支。每次寫入都是完整的 JSON serialization + atomic write。

**影響**：效能浪費（單次 stage 完成可能觸發 2-3 次 writeState），且增加維護複雜度。

**改進方向**：收集所有 state 變更後統一寫入一次（collect-then-flush 模式）。

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

## P6：Context Window 壓縮（嚴重度：高）

**現狀**：MCP 工具過多時（如 chrome-mcp + claude-mem + 其他），ECC 的 context window 從 200k 壓縮到約 70k tokens。Pipeline 的 systemMessage 注入（Node Context + 委派指令）進一步消耗可用 context。

**影響**：Sub-agent 可用 context 不足 → agent 品質下降 → 更多 crash/fallback。

**緩解**：Node Context 三層截斷策略（reflectionContent → 清空 → 只保留 hint），但根因是 MCP 工具定義佔用了過多 context。

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

## P9：Transcript 洩漏無法完全防止（嚴重度：中）

**現狀**：Agent `.md` 規範了回應格式，但 LLM 不完全受控。品質 agent 偶爾仍會在最終回應中包含完整報告，導致 Main Agent 看到問題細節。

**務實態度**：guard 確保即使洩漏，Main Agent 也無法自行修復（所有寫入被阻擋）。洩漏的實際影響是 **token 浪費**（Main Agent context 被無用資訊佔用），而非 **行為越權**。

**改進方向**：在 `stage-transition` 中截斷 Sub-agent 回應（只保留 PIPELINE_ROUTE 後面的部分），但需確認 ECC 是否支援修改 transcript。

---

## P10：Suffixed Stage 追蹤複雜度（嚴重度：低）

**現狀**：`deduplicateStages()` 為 test-first 等 pipeline 產生 `TEST:2` 等 suffixed stage。`resolveSuffixedStage()` 處理追蹤歧義，但邏輯複雜（多候選逆序搜尋）。

**影響**：增加 crash recovery 和 barrier 邏輯的維護負擔。

**改進方向**：考慮用唯一 stage ID（如 `TEST_WRITE` / `TEST_VERIFY`）取代數字後綴，從源頭消除歧義。
