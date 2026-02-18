# Sentinel 模組 Delta Spec

## ADDED Requirements

（無新增 — sentinel 模組只有 guard-rules.js 修改）

## MODIFIED Requirements

### Requirement: guard-rules evaluate() 評估邏輯

**完整修改後內容**：

v4 的 guard-rules.js 極度簡化，不依賴 derivePhase/PHASES/CLASSIFIED/RETRYING：

```
evaluate(toolName, toolInput, state):
  1. EnterPlanMode → 無條件阻擋
  2. Bash DANGER_PATTERNS → 無條件阻擋
  3. !state?.pipelineActive → allow（無 pipeline 或已完成/取消）
  4. Task / Skill → allow（委派工具）
  5. READ_ONLY_TOOLS → allow（唯讀研究）
  6. 其他 → block（Write/Edit/Bash 寫入/AskUserQuestion）
```

**變更點**：
- 移除 `isInitialized(state)` 檢查（pipelineActive=false 時已隱含）
- 移除 `isEnforced(state)` 檢查（pipelineActive 直接表達）
- 移除 `isDelegating(state)` 檢查（v4 不區分 CLASSIFIED/DELEGATING/RETRYING）
- 移除 `isCancelled(state)` 檢查（cancel 設 pipelineActive=false）
- 移除 `CANCEL_STATE_FILE_RE` 逃生口（cancel 由 Skill 觸發，不經過 guard）
- 移除 CLASSIFIED/RETRYING 區分（v4 只看 pipelineActive 布林值）
- 保留 Bash DANGER_PATTERNS（無條件阻擋，不受 pipeline 狀態影響）
- 保留 detectBashWriteTarget（pipelineActive 時攔截 Bash 寫入程式碼檔案）
- 保留 STAGE_SKILL_MAP（buildDelegateHint 仍需要）
- 阻擋訊息統一為「你是訊息匯流排（Relay），不是執行者」

**守護不變式**：
- pipelineActive=true 時，Main Agent 只能執行 Task/Skill/唯讀工具
- pipelineActive=false 時，所有工具放行（除了 EnterPlanMode 和 Bash 危險指令）
- isDelegating() 保留但只供 Dashboard/Timeline 顯示，不影響 guard 判斷

## REMOVED Requirements

### Requirement: Phase-based Guard 規則

Reason: v4 不需要區分 CLASSIFIED、DELEGATING、RETRYING 三種 phase。pipelineActive 布林值統一處理所有「pipeline 正在執行」的狀態。

Migration: Phase 3 重寫 guard-rules.js。移除對 dag-state 的 getPhase/isDelegating/isEnforced/isCancelled/isInitialized 的依賴（僅保留 pipelineActive 讀取）。guard-rules 測試全面重寫。

### Requirement: CANCEL_STATE_FILE_RE 逃生口

Reason: v3 的 cancel 流程需要 Main Agent 使用 Write 工具寫入 state file（pipeline-state/task-guard-state），guard-rules 需要特殊白名單放行這些寫入。v4 的 cancel 由 Skill 觸發（guard 白名單放行 Skill），內部呼叫 controller API 設定 pipelineActive=false，不需要 Write 工具寫入。

Migration: Phase 3 移除 CANCEL_STATE_FILE_RE 常量和相關的 cancel 逃生口邏輯。cancel skill 改為呼叫 controller.cancel() API。
