---
name: remote
description: >-
  Telegram 遠端控制服務管理 — 啟動/停止 daemon、查詢狀態、發送測試訊息。
  觸發詞：remote、遠端、telegram、bot。
arguments: $ARGUMENTS
---

# /remote — Telegram 遠端控制服務

管理 Telegram bot daemon 的生命週期和遠端控制功能。

## 指令

| 子指令 | 說明 |
|--------|------|
| `start` | 啟動 bot daemon |
| `stop` | 停止 bot daemon |
| `status` | 查詢 daemon 狀態 |
| `send <訊息>` | 手動發送 Telegram 訊息 |
| `test` | 發送測試通知驗證連線 |
| （無） | 顯示狀態摘要 |

## 執行規則

### 1. 解析 `$ARGUMENTS`

從使用者意圖判斷子指令：
- 「啟動」「start bot」→ `start`
- 「停止」「stop」→ `stop`
- 「狀態」「bot 在跑嗎」→ `status`
- 「發送」「傳送」→ `send`
- 「測試」→ `test`

### 2. 前置檢查

所有操作前先確認 credentials：

```bash
node -e "
const tg = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/telegram.js');
const creds = tg.getCredentials();
if (!creds) { console.log('MISSING'); process.exit(0); }
console.log('OK');
"
```

如果回傳 `MISSING`：
- 告知使用者需要設定 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`
- 建議使用 `/remote-config guide` 取得設定教學

### 3. 子指令實作

#### start
```bash
node -e "
const mgr = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/bot-manager.js');
if (mgr.isRunning()) {
  const s = mgr.getState();
  console.log(JSON.stringify({ running: true, pid: s.pid }));
} else {
  const r = mgr.start();
  console.log(JSON.stringify({ started: true, pid: r.pid }));
}
"
```

#### stop
```bash
node -e "
const mgr = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/bot-manager.js');
const r = mgr.stop();
console.log(JSON.stringify(r));
"
```

#### status
```bash
node -e "
const mgr = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/bot-manager.js');
const state = mgr.getState();
console.log(JSON.stringify(state || { running: false }));
"
```

#### send
```bash
node -e "
const tg = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/telegram.js');
const creds = tg.getCredentials();
tg.sendMessage(creds.token, creds.chatId, process.argv[1])
  .then(r => console.log('OK'))
  .catch(e => console.error(e.message));
" -- "使用者指定的訊息"
```

#### test
發送固定測試訊息：
```bash
node -e "
const tg = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/telegram.js');
const creds = tg.getCredentials();
tg.sendMessage(creds.token, creds.chatId, '🔔 Vibe Remote 測試成功！\nBot 連線正常。')
  .then(() => console.log('OK'))
  .catch(e => console.error(e.message));
"
```

### 4. 輸出格式

根據結果回報：
- 成功 → 簡潔確認（如「Bot 已啟動，PID: 12345」）
- 失敗 → 錯誤原因 + 建議修復方式
- 狀態 → PID、uptime、連線狀態
