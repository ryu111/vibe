# Agents Delta Spec

## ADDED Requirements

### Requirement: QUALITY Agent 回應格式約束

品質 agent（code-reviewer/tester/qa/e2e-runner/security-reviewer）在 Pipeline 模式下遵守精簡回應格式，防止 transcript 洩漏。

#### Scenario: 品質 agent 最終回應格式
WHEN 品質 agent 在 Pipeline 模式下完成審查
THEN 最終回應只包含：
  - 一行結論（PASS/FAIL + 問題數量）
  - PIPELINE_ROUTE 標記
AND 禁止在最終回應中重複完整報告內容

#### Scenario: REVIEW agent 回應範例
WHEN code-reviewer 完成審查且結果為 FAIL
THEN 回應格式為：
  ```
  REVIEW 完成：FAIL（2 CRITICAL, 1 HIGH）

  <!-- PIPELINE_ROUTE: { "verdict":"FAIL", "route":"DEV", "severity":"CRITICAL", "context_file":"~/.claude/pipeline-context-{sid}-REVIEW.md", "hint":"修復旗標邏輯" } -->
  ```

---

### Requirement: QUALITY Agent Self-Refine 微迴圈

品質 agent 在 Pipeline 模式下執行 Generate-Feedback-Refine 三步迴圈，嘗試在 stage 內部自我修正。

#### Scenario: Self-Refine 降級 FAIL:HIGH
WHEN 品質 agent 發現 FAIL:HIGH 問題
AND 修正方案明確且風險低
THEN 可降級為 PASS（附帶修復建議寫入 context_file）
AND PIPELINE_ROUTE 輸出 route: NEXT

#### Scenario: Self-Refine 不降級 FAIL:CRITICAL
WHEN 品質 agent 發現 FAIL:CRITICAL 問題
THEN 永遠不降級
AND PIPELINE_ROUTE 輸出 route: DEV

#### Scenario: Self-Refine 不確定時維持 FAIL
WHEN 品質 agent 發現 FAIL:HIGH 問題但修正方案不確定或風險高
THEN 維持 FAIL
AND PIPELINE_ROUTE 輸出 route: DEV

---

### Requirement: QUALITY Agent context_file 寫入

品質 agent 在輸出 PIPELINE_ROUTE 前，先將完整報告寫入 context file。

#### Scenario: 寫入 context_file
WHEN 品質 agent 完成審查
THEN 使用 Write 工具將完整報告寫入 `~/.claude/pipeline-context-{sessionId}-{stage}.md`
AND 大小上限 5000 chars（超出時保留 TOP 5 問題完整描述，截斷其餘）
AND PIPELINE_ROUTE 的 context_file 欄位引用該路徑

---

### Requirement: IMPL Agent context_file 讀取

IMPL agent（planner/architect/designer/developer/doc-updater）在被委派時讀取前驅 stage 的 context_file。

#### Scenario: DEV agent 讀取回退 context
WHEN DEV agent 被回退委派
AND Node Context 的 context_files 陣列非空
THEN DEV agent 先讀取 context_file 了解問題
AND 再讀取 retryContext.reflectionFile 了解歷史嘗試

#### Scenario: IMPL agent 無 context_file
WHEN IMPL agent 被委派但 Node Context 的 context_files 為空
THEN agent 正常執行工作（context_file 是增強機制，非必要條件）

---

### Requirement: 所有 Agent 輸出 PIPELINE_ROUTE

所有 pipeline 內的 agent 在完成時輸出 PIPELINE_ROUTE 標記。

#### Scenario: IMPL agent 輸出固定 PASS/NEXT
WHEN IMPL agent（PLAN/ARCH/DESIGN/DEV/DOCS）完成工作
THEN 輸出 `<!-- PIPELINE_ROUTE: { "verdict":"PASS", "route":"NEXT" } -->`
AND 可選包含 context_file 路徑（實作摘要）

#### Scenario: QUALITY agent 輸出動態 route
WHEN QUALITY agent 完成審查
THEN 根據審查結果輸出 PIPELINE_ROUTE
AND verdict 為 PASS 時 route 為 NEXT
AND verdict 為 FAIL 時根據 Node Context.onFail 決定 route（DEV 或 NEXT）
AND 並行節點一律使用 route: BARRIER

---

## MODIFIED Requirements

### Requirement: code-reviewer.md Agent 定義

**完整修改後內容**：

code-reviewer.md 新增以下段落（附加在現有內容後）：

1. **Pipeline 模式回應格式**：最終回應只含一行結論 + PIPELINE_ROUTE
2. **context_file 寫入**：完整報告寫入 `~/.claude/pipeline-context-{sid}-REVIEW.md`
3. **Self-Refine 迴圈**：Phase 1 審查 → Phase 2 自我挑戰 → Phase 3 最終裁決
4. **結論標記**：從 `<!-- PIPELINE_VERDICT: ... -->` 改為 `<!-- PIPELINE_ROUTE: {...} -->`

### Requirement: tester.md Agent 定義

**完整修改後內容**：同 code-reviewer.md 的修改模式。stage 名稱為 TEST。

### Requirement: qa.md Agent 定義

**完整修改後內容**：同 code-reviewer.md 的修改模式。stage 名稱為 QA。

### Requirement: e2e-runner.md Agent 定義

**完整修改後內容**：同 code-reviewer.md 的修改模式。stage 名稱為 E2E。

### Requirement: security-reviewer.md Agent 定義

**完整修改後內容**：新增 context_file 寫入 + Self-Refine + PIPELINE_ROUTE 輸出。

### Requirement: developer.md Agent 定義

**完整修改後內容**：新增 context_file 讀取指令（回退時從 Node Context 的 context_files 路徑讀取前驅 stage 報告）+ PIPELINE_ROUTE(PASS/NEXT) 輸出。

### Requirement: planner.md / architect.md / designer.md / doc-updater.md Agent 定義

**完整修改後內容**：新增 PIPELINE_ROUTE(PASS/NEXT) 輸出 + 可選 context_file 欄位。

### Requirement: pipeline-architect.md Agent 定義

**完整修改後內容**：DAG 結構需含 next/onFail/maxRetries/barrier 欄位（配合 templateToDag 格式）。

---

## REMOVED Requirements

### Requirement: PIPELINE_VERDICT 結論標記格式

Reason: 被 PIPELINE_ROUTE JSON 格式取代。

Migration: Phase 1 將所有 agent .md 的結論標記從 `<!-- PIPELINE_VERDICT: PASS/FAIL:severity -->` 改為 `<!-- PIPELINE_ROUTE: { "verdict":"...", "route":"...", ... } -->`。Phase 0-1 過渡期間保持 verdict.js 作為 parseRoute 的 fallback。
