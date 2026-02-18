# Pipeline v4 架構演進建議書 (Gemini)

> **日期**: 2026-02-17
> **針對文件**: `docs/ref/pipeline-v4.md` (v4 設計草案)
> **狀態**: 建議與分析

---

## 1. 總體評價

Pipeline v4 的核心洞察 **「Main Agent 不應知道『要修什麼』，只應知道『要路由到哪』」** 非常精闢。將 Main Agent 降級為 "Message Bus" (Relay) 能有效解決 Main Agent 試圖繞過 Guard 自行修復的問題（v1.0.73 案例），這是目前架構中最大的不穩定因素之一。

從集中式 DAG 控制轉向分散式 Node 自治，雖然增加了個別 Node (Agent) 的複雜度，但降低了系統整體的耦合度，並使得「並行執行」變得更直觀（Barrier 機制）。

---

## 2. 架構建議與潛在挑戰

### 2.1 狀態管理的權衡 (State Management)

草案中提到 **「全域狀態腐敗」** 是 v3 的痛點，並建議 v4 使用獨立的 `barrier-state` 檔案。

*   **建議**：**謹慎評估狀態碎片化**。
    *   雖然拆分檔案能降低競態風險，但會導致 Dashboard 和 Debugging 的困難（Truth 分散在多個檔案）。
    *   **替代方案**：考慮維持單一 State 檔案，但實作 **Atomic Write** (寫入暫存檔 + `rename`) 或簡單的 **File Lock** 機制。對於 Node.js `fs` 操作，Atomic Write 通常足以解決大部分並發寫入導致的損毀問題。
    *   若堅持拆分，建議 Dashboard 需有聚合機制（Aggregate State）來呈現完整視圖。

### 2.2 路由的決定論性 (Nondeterminism in Routing)

v4 將路由決策交給 Agent (LLM) 輸出 `PIPELINE_ROUTE`。

*   **風險**：LLM 本質上是不可控的。如果 Agent 輸出的 Route JSON 格式錯誤，或邏輯自相矛盾（例如 `verdict: PASS` 但 `route: DEV`），會導致流程卡死。
*   **建議**：
    *   **Strict Schema Validation**：`stage-transition` hook 必須嚴格驗證 `PIPELINE_ROUTE` 的 Schema。
    *   **Safety Net (Fallback)**：保留 v3 的 `pipeline-controller` 邏輯作為 "Shadow Controller" 或 "Validator"。當 Agent 輸出的 Route 違反物理定律（例如在 PLAN 階段要求路由到 DOCS），由 hook 強制修正並發出警告（如草案 6.3 所述）。
    *   **Skill 輔助**：提供一個 `output_route` Skill 給 Agent 使用，確保輸出的 JSON 格式絕對正確，減少 Parse 錯誤。

### 2.3 資訊隔離的實作細節 (Information Isolation)

*   **建議**：確保 **Opaque Context** 真的對 Main Agent 不可見。
    *   如果 `context` 放在 `PIPELINE_ROUTE` JSON 中，Main Agent 的 Context Window 還是會吃到這些 Token。
    *   **優化**：Sub-agent 將詳細報告寫入一個 **暫存檔**，`PIPELINE_ROUTE` 中只傳遞 **檔案路徑** (`context_file_path`)。Main Agent 只負責傳遞這個路徑字串。
    *   這樣 Main Agent 就真的「完全瞎了」，只能看到路徑，看不到內容，且節省了 Main Agent 的 Token。

---

## 3. 與 v1.0.50 Hardening 的整合

v1.0.50 (Pipeline Hardening) 建立的防護網應無縫過渡到 v4：

| Hardening 功能 | v4 整合建議 |
| :--- | :--- |
| **Bash 防護 (H1)** | 繼續保留。v4 Guard 雖然簡化為 `pipelineActive` 判斷，但 `Bash` 寫入阻擋仍需作為最後防線（防止 Rogue Agent）。 |
| **框架偵測 (H2)** | `env-detector` 的結果應注入到 **Initial Node Context** 中，讓每個 Node 知道環境全貌。 |
| **Clear 重設 (H3)** | `/clear` 應同時清除全域 State 和所有的 Barrier State。 |
| **Checkpoint (H4)** | **Patch 路徑作為 Opaque Context 的一部分**。當 Route 為 `DEV` 時，Context 中應包含 `patch_path`，由接收端的 Developer Agent 讀取。 |

---

## 4. 遷移路線優化建議

建議在草案的 Phase 1 之前，增加一個 **Phase 0：Context Protocol**。

1.  **Phase 0 (Context Protocol)**：
    *   先不改變路由邏輯。
    *   修改現有 Agent，讓它們習慣從 `context` (檔案或變數) 讀取前一階段的產出，而不是依賴 Main Agent 的對話歷史。
    *   這可以先解決「資訊洩漏」問題，再處理「控制權轉移」。

2.  **Phase 4 (Barrier)**：
    *   並行執行涉及複雜的 UI/UX 問題（使用者如何看到兩個並行 Agent 的輸出？）。建議此階段配合 **Dashboard 2.0** 實作，讓 Dashboard 能同時顯示多個 Agent 的狀態。

---

## 5. 總結

v4 是一個正確且必要的演進方向。它將「業務邏輯」（如何修復、如何重試）回歸給最清楚狀況的 Worker (Agent)，讓 Manager (Main Agent) 回歸協調者的本質。

**Gemini 的核心建議：**
1.  **使用檔案路徑傳遞 Context**，實現真正的資訊隔離。
2.  **考慮 Atomic Write 取代狀態拆分**，降低系統複雜度。
3.  **Hardening 功能 (Patch, Bash Guard) 必須在 v4 中保留並適配。**
