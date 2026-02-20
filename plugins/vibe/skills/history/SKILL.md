---
description: Pipeline 歷史查詢 — 查看近期 pipeline 執行記錄和統計分析
argument-hint: "[pipelineId] [limit]"
---

# Pipeline 歷史查詢

## 任務

讀取 `~/.claude/pipeline-history.jsonl`，根據使用者需求過濾並呈現 pipeline 執行歷史。

## 執行步驟

### 1. 讀取歷史檔案

使用 Read 工具讀取 `~/.claude/pipeline-history.jsonl`。

若檔案不存在，回應：「尚無 pipeline 執行歷史。執行任何 pipeline 後，完成記錄將自動儲存。」

### 2. 解析 JSONL

逐行解析 JSON（每行一筆記錄），跳過損毀行。

每筆記錄欄位：
- `pipelineId` — pipeline 類型（如 standard, quick-dev）
- `sessionId` — session 識別碼
- `startedAt` — 開始時間（ISO 格式，可能為 null）
- `completedAt` — 完成時間（ISO 格式）
- `durationMs` — 執行時長（毫秒，可能為 null）
- `totalRetries` — 總回退次數
- `totalCrashes` — 總 crash 次數
- `stageResults` — 各 stage 結果陣列 `[{ stageId, verdict, retries }]`
- `finalResult` — 最終結果（COMPLETE / CANCELLED / UNKNOWN）
- `cancelled` — 是否被取消

### 3. 套用過濾條件

從 `$ARGUMENTS` 解析：
- 若指定 `pipelineId`（如 `standard`、`quick-dev`）→ 只顯示該類型
- 若指定數字 `limit`（如 `5`）→ 只顯示最近 N 筆
- 預設：顯示最近 10 筆

按 `completedAt` 降序排列（最新在前）。

### 4. 輸出格式

#### 4.1 執行記錄表格

```
## 近期 Pipeline 執行記錄（最近 N 筆）

| # | Pipeline | 結果 | 時長 | 回退 | 完成時間 |
|---|---------|------|------|------|---------|
| 1 | standard | ✅ COMPLETE | 12m 30s | 1 | 2026-02-21 10:15 |
| 2 | quick-dev | ✅ COMPLETE | 3m 10s | 0 | 2026-02-21 09:00 |
```

時長格式：
- < 60s → `Xs`（如 `45s`）
- < 60m → `Xm Ys`（如 `3m 10s`）
- >= 60m → `Xh Ym`（如 `1h 15m`）
- null → `--`

結果圖示：
- `COMPLETE` → `✅ COMPLETE`
- `CANCELLED` → `⚠️ CANCELLED`
- 其他 → `❓ UNKNOWN`

#### 4.2 各 Stage 詳情（展開最新一筆）

```
### 最近一次詳情：standard（2026-02-21 10:15）

| Stage | 結果 | 回退次數 |
|-------|------|---------|
| PLAN  | PASS | 0 |
| DEV   | PASS | 1 |
| REVIEW | PASS | 0 |
```

#### 4.3 統計摘要

```
## 統計摘要（共 N 筆）

- 總執行次數：N
- 成功率：X%（成功定義：COMPLETE 且所有 stage PASS）
- 平均時長：Xm Ys
- 最常使用：standard（N 次）
- 各 Stage 失敗率：REVIEW 20%, TEST 10%
```

若無記錄或過濾後為空，說明原因並提示使用方式。

## 備註

- 歷史檔案為全域共享（不隔離 session），所有 pipeline 完成後自動追加
- 最多保留 100 筆記錄，SessionStart 時自動截斷
- 歷史記錄於 pipeline **成功完成**時寫入（COMPLETE）
