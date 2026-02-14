---
name: hook-diag
description: >-
  Hook 錯誤診斷 — 查看、分析、清除 hook error log。
  觸發詞：hook-diag、hook 錯誤、hook error、hook log、hook 診斷。
argument-hint: $ARGUMENTS
allowed-tools: Bash, Read
---

# /hook-diag — Hook 錯誤診斷

讀取 `~/.claude/hook-errors.log`，分析 hook 錯誤模式，協助定位和修復問題。

## 指令

| 子指令 | 說明 |
|--------|------|
| （無）/ `status` | 顯示統計摘要 — 各 hook 錯誤次數、最後發生時間 |
| `show [N]` | 顯示最近 N 筆 log（預設 20） |
| `clear` | 清除 log 檔案 |

## 執行規則

### 1. 解析 `$ARGUMENTS`

從使用者意圖判斷子指令：
- 「看看 hook 有什麼錯」「hook 狀態」→ `status`
- 「最近的 hook error」「show 50」→ `show`
- 「清除」「reset log」→ `clear`

### 2. 子指令實作

#### status（預設）

```bash
node -e "
const logger = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/hook-logger.js');
const s = logger.stats();
console.log(JSON.stringify(s, null, 2));
"
```

將結果格式化為表格：

```
## Hook 錯誤統計

| Hook | 次數 | 最後發生 | 最近錯誤 |
|------|:----:|---------|---------|
| auto-lint | 3 | 2026-02-14 03:21 | Cannot find module... |

總計：N 筆錯誤
```

- 如果 total = 0，顯示「沒有 hook 錯誤記錄」
- 按次數降序排列

#### show

```bash
node -e "
const logger = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/hook-logger.js');
const lines = logger.read(${N:-20});
console.log(lines.join('\n'));
"
```

直接顯示 log 內容，每行格式：`[時間] hook名: 錯誤訊息`。

#### clear

```bash
node -e "
const logger = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/hook-logger.js');
const ok = logger.clear();
console.log(ok ? 'CLEARED' : 'FAILED');
"
```

清除後確認：「Hook error log 已清除。」

### 3. 輸出格式

- 統計結果用 markdown 表格
- 有高頻錯誤時（同一 hook > 5 次），主動建議排查方向
- log 為空時簡潔回報，不贅述

## 使用者要求

$ARGUMENTS
