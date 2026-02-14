---
name: cancel
description: 取消鎖定 — 解除 task-guard 阻擋 + 退出 pipeline 模式，允許直接操作。觸發詞：cancel、取消、解除鎖定、放行、退出 pipeline。
argument-hint: ""
allowed-tools: Read, Write
---

## 你的角色

你是任務鎖定和 pipeline 模式的手動解除器。處理兩種情境：
1. **task-guard 鎖定**：反覆阻擋結束回合
2. **pipeline 模式**：pipeline-guard 阻擋直接 Write/Edit/AskUserQuestion/EnterPlanMode，強制透過 sub-agent

## 工作流程

### 1. 偵測狀態

讀取以下兩個 state file（sessionId 從環境取得）：
- `~/.claude/task-guard-state-{sessionId}.json` — task-guard 狀態
- `~/.claude/pipeline-state-{sessionId}.json` — pipeline 狀態

### 2. 顯示現況

告知使用者：
- **Task-guard**：被阻擋次數、未完成任務
- **Pipeline**：目前任務類型、是否強制 pipeline（`pipelineEnforced`）、委派狀態（`delegationActive`）、已完成階段

### 3. 解除鎖定

根據偵測結果執行：

**Task-guard 解除**：將 `task-guard-state` 的 `cancelled` 設為 `true`

**Pipeline 解除**：將 `pipeline-state` 的以下欄位重設：
- `pipelineEnforced` → `false`（停止 pipeline-guard 阻擋）
- `delegationActive` → `false`（重設委派狀態）

### 4. 確認結果

告知使用者：
- 已解除哪些鎖定
- 現在可以直接使用 Write/Edit（如果解除了 pipeline）
- 下次結束回合不會被阻擋（如果解除了 task-guard）

## 使用場景

- task-guard 反覆阻擋但無法推進
- task-classifier 誤分類導致 pipeline 模式不應啟動
- 使用者想中途切換到手動操作模式
- 安全閥之外的手動逃生門

## 注意事項

- 解除 pipeline 後，Main Agent 可以直接 Write/Edit — 不再強制透過 sub-agent
- 已完成的 pipeline 階段記錄會保留（不刪除 state file，只重設 flag）
- 這是單次操作 — 下一個 session 的 task-guard 和 pipeline 會重新啟動
- 如果只是暫時困難，建議先嘗試其他方式推進任務

## 使用者要求

$ARGUMENTS
