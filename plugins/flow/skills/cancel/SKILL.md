---
name: cancel
description: 取消任務鎖定 — 解除 task-guard 阻擋，允許正常結束回合。觸發詞：cancel、取消、解除鎖定、放行。
argument-hint: ""
allowed-tools: Read, Write
---

## 你的角色

你是任務鎖定的手動解除器。當 task-guard 反覆阻擋 Claude 結束但無法繼續推進時，使用者可以用此 skill 手動解除鎖定。

## 工作流程

1. **讀取狀態**：讀取 `~/.claude/task-guard-state-{sessionId}.json`
2. **顯示現況**：告知使用者當前被阻擋的次數和未完成的任務
3. **設定取消**：將 state file 的 `cancelled` 欄位設為 `true`
4. **確認結果**：告知使用者已解除鎖定，下次結束回合不會被阻擋

## 使用場景

- Claude 卡住，反覆被 block 但無法推進任務
- 使用者決定中途放棄，切換到其他任務
- 安全閥（預設 5 次阻擋）之外的手動逃生門

## 注意事項

- 解除鎖定後，未完成的 TodoWrite 項目仍然存在，只是不再阻擋結束
- 這是單次操作 — 下一個 session 的 task-guard 會重新啟動
- 如果只是暫時困難，建議先嘗試其他方式推進任務，而非直接取消

## 使用者要求

$ARGUMENTS
