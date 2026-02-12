# notify — Telegram 雙向通訊

> **優先級**：高
> **定位**：通訊整合 — Pipeline 進度推播、狀態查詢、tmux 遠端控制
> **Telegram 先行**，之後可擴充 LINE
> **核心概念**：遊戲外掛模式 — 讀取狀態（pipeline state files）+ 注入輸入（tmux send-keys）

---

## 1. 概述

notify 是 Vibe marketplace 的通訊整合 plugin。三大功能軸：

1. **推播** — Pipeline stage 完成 → Telegram 通知（使用者手機收到進度）
2. **查詢** — 從 Telegram 查詢 /status /stages → 讀 state files 直接回覆
3. **遠端控制** — `/say <訊息>` → tmux send-keys → 注入到同一個 Claude Code session

### 架構概覽

```
Claude Code (tmux session)
    ↓ SubagentStop 事件
    ↓
notify-sender.js → 讀 pipeline-state → Telegram 推播 ──→ 使用者手機
                                                          ↓
                                                     /status /say
                                                          ↓
bot.js daemon (long polling) ← Telegram Bot API ←────── 使用者手機
    ↓
    ├── 查詢類 → 讀 state files → 回覆 Telegram
    └── 控制類 → tmux send-keys → Claude Code (同一 session)
```

### 解耦原則

- notify **不 import** flow 的程式碼（零依賴）
- Agent → Stage 映射硬編碼在 notify-sender.js 內
- 有 flow → pipeline stage 通知完整
- 無 flow → daemon 仍可運作（/status 掃描 state files，/say 注入 tmux）

---

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **即時通知** | Pipeline stage 完成後秒級推播到手機 |
| 2 | **遠端監控** | 離開電腦也能查看所有 session 進度 |
| 3 | **遠端控制** | tmux send-keys 注入同一 session，不開新的 |
| 4 | **靜默降級** | 未設定 credentials 時靜默跳過，零干擾 |

---

## 3. 組件清單

### Skills（2 個）

| 名稱 | 說明 |
|------|------|
| `notify` | 主控 — start/stop/status/send/test |
| `notify-config` | 設定教學 — show/verify/guide |

### Hooks（2 個）

| 事件 | Matcher | Script | 說明 |
|------|---------|--------|------|
| SessionStart | `startup\|resume` | `notify-autostart.js` | 自動啟動 bot daemon |
| SubagentStop | `*` | `notify-sender.js` | Pipeline stage 完成推播 |

### Scripts（4 個）

| 名稱 | 類型 | 說明 |
|------|------|------|
| `notify-autostart.js` | hook | SessionStart: 偵測 → 啟動 daemon |
| `notify-sender.js` | hook | SubagentStop: 讀 state → 推播 Telegram |
| `bot-manager.js` | lib | Daemon 生命週期（isRunning/start/stop/getState） |
| `telegram.js` | lib | Telegram Bot API 封裝（sendMessage/getUpdates/getMe） |

### 其他

| 名稱 | 說明 |
|------|------|
| `bot.js` | 背景 daemon — long polling + 查詢指令 + tmux 遠端控制 |

---

## 4. 認證方式

環境變數（`~/.zshrc`）：

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."   # @BotFather 取得
export TELEGRAM_CHAT_ID="987654321"              # 目標 chat ID
```

所有入口點第一步檢查 credentials，缺少時 exit 0（靜默降級）。

---

## 5. 推播通知

### 觸發時機

SubagentStop hook — flow plugin 的 stage-transition.js 先更新 state file（buildOrder 1），notify-sender.js 後讀取（buildOrder 6）。

### Agent → Stage 映射（硬編碼）

| Agent | Stage |
|-------|-------|
| planner | PLAN |
| architect | ARCH |
| developer | DEV |
| code-reviewer | REVIEW |
| tester | TEST |
| qa | QA |
| e2e-runner | E2E |
| doc-updater | DOCS |

### 通知格式

**Stage 完成**：
```
🏗️ *architect* 完成（ARCH）
結果：✅ PASS
進度：📋 ✅ → 🏗️ ⏳ → 💻 → ⬜ → ⬜ → ⬜ → ⬜ → ⬜
Session: `a1b2c3d4`
```

**Pipeline 全部完成**：
```
🎉 *Pipeline 完成*
任務：feature | 結果：✅ PASS
📋 ✅ → 🏗️ ✅ → 💻 ✅ → 🔍 ✅ → 🧪 ✅ → ✅ QA → 🌐 ✅ → 📝 ✅
```

---

## 6. Telegram 指令

### 查詢類（無副作用）

| 指令 | 說明 |
|------|------|
| `/status` | 列出活躍 session 進度 |
| `/stages [sid]` | 指定 session 的 stage 詳情 |
| `/help` | 可用指令列表 |
| `/ping` | 測試 bot 存活 + uptime |

### 控制類（有副作用）

| 指令 | 說明 |
|------|------|
| `/say <訊息>` | tmux send-keys 傳送到 Claude Code |
| `/tmux` | 顯示 tmux 連線狀態 |

非指令訊息（不以 `/` 開頭）自動視為 `/say`。

---

## 7. 遠端控制

### tmux send-keys 機制

```bash
# 使用者在 tmux 內啟動 Claude Code
tmux new -s claude
claude

# bot daemon 注入文字到同一 session
tmux send-keys -t {pane} "幫我加登入頁面" Enter
```

### tmux pane 偵測

1. `$CLAUDE_TMUX_PANE`（環境變數，最可靠）
2. `tmux list-panes -a -F "#{pane_id} #{pane_current_command}"` → 找 `claude` 進程
3. `$TMUX_PANE`（回退）

### 安全

- 只回應指定 `TELEGRAM_CHAT_ID` 的使用者
- `/say` 前綴與查詢指令明確區隔
- 所有 `/say` 指令記錄到 `~/.claude/notify-bot.log`

---

## 8. Daemon 生命週期

| 面向 | 設計 |
|------|------|
| PID 檔 | `~/.claude/notify-bot.pid`（全域） |
| 存活偵測 | `process.kill(pid, 0)`（無 port） |
| 啟動 | `spawn('node', [botPath], { detached, stdio: 'ignore' })` |
| 自動啟動 | SessionStart hook → notify-autostart.js |
| 手動控制 | `/notify start\|stop\|status` |
| 優雅關閉 | SIGTERM/SIGINT → 清理 PID → exit 0 |
| 錯誤恢復 | polling 失敗 → 5s 後重試 |

---

## 9. 關鍵決策

| 決策 | 結論 | 原因 |
|------|------|------|
| Hook 事件 | SubagentStop | 精確匹配 stage 完成時機 |
| Agent→Stage 映射 | 硬編碼 | 零依賴原則 |
| Daemon runtime | Node.js | 比 Bun 更通用 |
| Long polling vs Webhook | Long polling | 無需公開 IP |
| 遠端控制 | tmux send-keys | 直接注入同一 session |
| 認證缺失 | 靜默跳過 | graceful degradation |
| PID 管理 | 全域 | Daemon 跨 session 共享 |

---

## 10. 未來擴充

- **LINE Messaging API** — 新增 `line.js` API 封裝，`/notify-config` 支援多頻道
- **Claude Control API** — 當 Anthropic 開放 session 控制 API，替換 tmux 為原生呼叫
- **WebSocket Gateway** — 參考 OpenClaw 架構，建立本地 Gateway 統一多頻道
