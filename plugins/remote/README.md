# Remote — Telegram 遠端監控與控制

Remote 讓你在手機上即時掌握 Claude Code 的工作狀態。

## 兩種模式

Remote 分為**被動通知**和**主動控制**兩層。被動層只需 Telegram Bot 即可運作；主動層額外需要 tmux。

### 被動通知（無需 tmux）

安裝 remote plugin + 設定 Telegram credentials 後自動生效：

| 功能 | 說明 | 觸發時機 |
|------|------|----------|
| 使用者輸入轉發 | `👤 你的訊息` | 每次輸入 prompt |
| 回合動作摘要 | `📋 回合：🤖回應 📝×2 ⚡×1` | 每個回合結束 |
| Pipeline 進度推播 | `🔍 REVIEW ✅ 5m (feature)` | 每個 stage 完成 |
| Pipeline 完成通知 | `🎉 Pipeline 完成 ✅ (feature) 26m` | 所有 stage 完成 |

適合場景：跑 pipeline 時離開電腦，手機被動接收進度。

### 主動控制（需要 tmux）

在 tmux session 中啟動 Claude Code 後，額外解鎖：

| 功能 | 說明 | 操作方式 |
|------|------|----------|
| 遠端對話 | 從手機發指令給 Claude | `/say <訊息>` 或直接打字 |
| 已讀回條 | 追蹤 Claude 是否處理完畢 | `✓ 已傳送` → `✅ 完成` |
| 遠端選擇 | AskUserQuestion inline keyboard | 按鈕或數字選擇 |
| 狀態查詢 | 查看 session/pipeline 進度 | `/status` `/stages` |

適合場景：出門後繼續和 Claude 對話、遠端回答問題。

## 快速開始

### 1. 設定 Telegram Bot

```bash
# 在 Claude Code 中執行
/remote-config guide
```

或手動：
1. 在 Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 取得 **Bot Token**
2. 找 [@userinfobot](https://t.me/userinfobot) → 取得你的 **Chat ID**
3. 寫入 `~/.claude/remote.env`：

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

### 2. 啟動（被動模式自動生效）

安裝 plugin 後，SessionStart hook 會自動啟動 bot daemon。被動通知立即可用。

### 3. 啟用主動控制（tmux）

```bash
# 建立 tmux session
tmux new -s claude

# 在 tmux 內啟動 Claude Code
claude

# 現在可以從 Telegram 發 /say 或直接打字
```

> 為什麼需要 tmux？Remote 的主動控制透過 `tmux send-keys` 將文字注入終端。
> 沒有 tmux 就無法「打字到 Claude」，但通知和查詢仍然正常運作。

## Telegram 指令

| 指令 | 說明 | 需要 tmux |
|------|------|:---------:|
| `/say <訊息>` | 傳送訊息給 Claude | ✅ |
| `/status` | 列出活躍 session 進度 | ❌ |
| `/stages [sid]` | 指定 session 的 stage 詳情 | ❌ |
| `/ping` | 測試 bot 存活 + uptime | ❌ |
| `/tmux` | 顯示 tmux 連線狀態 | ✅ |
| `/help` | 可用指令列表 | ❌ |
| 直接打字 | 等同 `/say`（自動轉發） | ✅ |

## Claude Code 指令

| 指令 | 說明 |
|------|------|
| `/remote start` | 手動啟動 bot daemon |
| `/remote stop` | 停止 bot daemon |
| `/remote status` | 查看 daemon 狀態 |
| `/remote test` | 發送測試訊息 |
| `/remote-config` | 設定教學與驗證 |

## 安全

- 只回應指定 `TELEGRAM_CHAT_ID` 的訊息
- Credentials 支援環境變數或 `.env` 檔案（不進 git）
- 缺少 credentials 時所有功能靜默降級（不報錯）
- 所有 `/say` 指令記錄到 `~/.claude/remote-bot.log`
