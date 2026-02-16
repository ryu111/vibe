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
- `~/.claude/pipeline-state-{sessionId}.json` — pipeline 狀態（FSM 結構）

### 2. 顯示現況

告知使用者：
- **Task-guard**：被阻擋次數、未完成任務
- **Pipeline**：目前 phase（`state.phase`）、pipeline ID（`state.context.pipelineId`）、當前階段（`state.progress.currentStage`）、已完成階段

### 3. 解除鎖定

根據偵測結果執行：

**Task-guard 解除**：將 `task-guard-state` 的 `cancelled` 設為 `true`

**Pipeline 解除**：修改 `pipeline-state` 的 FSM 狀態：
- `phase` → `'IDLE'`（停止 pipeline-guard 阻擋）
- `meta.cancelled` → `true`（標記已取消）
- 清理 `~/.claude/vibe-patch-*.patch` 殘留快照（遍歷刪除）

### 4. 取消原因回饋（Correction Loop）

**條件**：解除的是 pipeline 且原 `phase` 在 `['CLASSIFIED', 'DELEGATING', 'RETRYING']`（enforced 狀態）

使用 AskUserQuestion 詢問取消原因（multiSelect: false）：

| 選項 | label | description |
|------|-------|-------------|
| A | 分類錯誤 | 分類器選擇的 pipeline 不正確，我要指定正確的 |
| B | 不需要 pipeline | 這個任務不需要走 pipeline 流程 |
| C | 跳過回饋 | 不提供回饋，直接繼續 |

**如果選擇 A（分類錯誤）**：

使用第二個 AskUserQuestion 讓使用者選擇正確的 pipeline（multiSelect: false）：

| 選項 | label | description |
|------|-------|-------------|
| 1 | full | 完整開發（9 階段，含 UI 設計） |
| 2 | standard | 標準開發（6 階段，無 UI） |
| 3 | quick-dev | 快速開發（3 階段：DEV→REVIEW→TEST） |
| 4 | fix | 快速修復（1 階段：DEV） |

如果 4 個選項不夠，使用者可在 Other 中輸入其他 pipeline ID（test-first/ui-only/review-only/docs-only/security/none）。

### 5. 自動蒐集誤判語料

當解除的是 pipeline 且原 phase 在 enforced 狀態時，記錄到語料檔和統計檔。

**語料檔路徑**：`~/.claude/classifier-corpus.jsonl`

讀取 pipeline-state 中的資訊，追加一行 JSONL：
```json
{
  "prompt": "觸發 pipeline 的原始 prompt（從 state 或 transcript 取得）",
  "actual": "state.context.taskType",
  "pipelineId": "state.context.pipelineId",
  "cancelled": true,
  "reason": "classification-error | no-pipeline-needed | skipped",
  "expectedPipeline": "使用者選擇的正確 pipeline（僅 reason=classification-error 時有值）",
  "layer": "state.meta.layer",
  "confidence": "state.meta.classificationConfidence",
  "source": "state.meta.classificationSource",
  "matchedRule": "state.meta.matchedRule",
  "completedStages": [],
  "timestamp": "ISO"
}
```

**統計檔路徑**：`~/.claude/classifier-stats.json`

讀取現有統計檔（不存在則初始化），更新 `recentWindow` 滑動窗口：

```json
{
  "recentWindow": [
    {
      "pipelineId": "state.context.pipelineId",
      "layer": 2,
      "source": "regex",
      "corrected": true,
      "expectedPipeline": "full",
      "timestamp": "ISO"
    }
  ],
  "totalClassifications": 42,
  "totalCorrections": 3
}
```

更新規則：
- **分類錯誤**（reason=classification-error）：`corrected=true` + `expectedPipeline` 填入使用者選擇 + `totalCorrections` +1
- **不需要 pipeline / 跳過**：`corrected=false`
- `totalClassifications` +1
- `recentWindow` 保留最近 50 筆（超過時移除最舊的）

使用 Write 工具追加 corpus / 覆寫 stats（如果檔案不存在則建立）。這步驟靜默執行，不需要告知使用者。

### 6. 確認結果

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
- 已完成的 pipeline 階段記錄會保留（不刪除 state file，只重設 phase）
- 這是單次操作 — 下一個 session 的 task-guard 和 pipeline 會重新啟動
- 如果只是暫時困難，建議先嘗試其他方式推進任務
- 回饋是可選的 — 使用者可選「跳過回饋」快速退出

## 使用者要求

$ARGUMENTS
