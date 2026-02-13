---
name: remote-config
description: >-
  Telegram 遠端控制設定教學與驗證 — 引導使用者建立 Bot、取得 Token 和 Chat ID。
  觸發詞：remote-config、遠端設定、telegram 設定、bot 設定。
arguments: $ARGUMENTS
---

# /remote-config — Telegram 設定管理

引導使用者完成 Telegram Bot 設定，驗證連線。

## 指令

| 子指令 | 說明 |
|--------|------|
| `show` | 顯示目前設定狀態（遮罩敏感資訊） |
| `verify` | 驗證 Token 和 Chat ID 是否有效 |
| `guide` | 顯示完整設定教學 |
| （無） | 同 `show` |

## 執行規則

### 1. 解析 `$ARGUMENTS`

從使用者意圖判斷子指令：
- 「顯示設定」「目前狀態」→ `show`
- 「驗證」「測試連線」→ `verify`
- 「教學」「怎麼設定」「guide」→ `guide`

### 2. 子指令實作

#### show

```bash
node -e "
const tg = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/telegram.js');
const creds = tg.getCredentials();
if (!creds) {
  console.log(JSON.stringify({ configured: false }));
} else {
  const masked = creds.token.slice(0, 5) + '...' + creds.token.slice(-4);
  console.log(JSON.stringify({ configured: true, token: masked, chatId: creds.chatId }));
}
"
```

回報格式：
- 已設定 → 顯示遮罩 Token（`12345...wxyz`）和 Chat ID
- 未設定 → 提示使用 `/remote-config guide`

#### verify

```bash
node -e "
const tg = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/telegram.js');
const creds = tg.getCredentials();
if (!creds) { console.log('MISSING'); process.exit(0); }
tg.getMe(creds.token)
  .then(bot => console.log(JSON.stringify({ valid: true, botName: bot.first_name, username: bot.username })))
  .catch(e => console.log(JSON.stringify({ valid: false, error: e.message })));
"
```

回報：
- 有效 → Bot 名稱 + username
- 無效 → 錯誤訊息 + 建議重新取得 Token

#### guide

直接輸出以下教學（不需執行腳本）：

**Step 1：建立 Telegram Bot**
1. 開啟 Telegram，搜尋 `@BotFather`
2. 傳送 `/newbot`
3. 設定 Bot 名稱和 username
4. 複製 API Token（格式：`123456:ABC-DEF...`）

**Step 2：取得 Chat ID**
1. 傳送任意訊息給你的 Bot
2. 在瀏覽器開啟：`https://api.telegram.org/bot<TOKEN>/getUpdates`
3. 找到 `"chat":{"id":XXXXXXX}` 中的數字

**Step 3：設定環境變數**
在 `~/.zshrc` 加入：
```bash
export TELEGRAM_BOT_TOKEN="你的 Token"
export TELEGRAM_CHAT_ID="你的 Chat ID"
```

執行 `source ~/.zshrc` 生效。

**Step 4：驗證**
執行 `/remote-config verify` 確認連線，然後 `/remote test` 發送測試訊息。
