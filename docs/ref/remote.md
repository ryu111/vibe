# remote — Telegram 遠端控制

> **優先級**：高
> **定位**：遠端控制 — Pipeline 進度推播、狀態查詢、tmux 遠端操作
> **Telegram 先行**，之後可擴充其他通訊管道
> **核心概念**：遊戲外掛模式 — 讀取狀態（pipeline state files）+ 注入輸入（tmux send-keys）

---

## 1. 概述

remote 是 Vibe marketplace 的遠端控制 plugin。三大功能軸：

1. **推播** — Pipeline stage 完成 → Telegram 通知（使用者手機收到進度）
2. **查詢** — 從 Telegram 查詢 /status /stages → 讀 state files 直接回覆
3. **遠端控制** — `/say <訊息>` → tmux send-keys → 注入到同一個 Claude Code session

### 架構概覽

```
Claude Code (tmux session)
    ↓ SubagentStop 事件
    ↓
remote-sender.js → 讀 pipeline-state → Telegram 推播 ──→ 使用者手機
                                                          ↓
                                                     /status /say
                                                          ↓
bot.js daemon (long polling) ← Telegram Bot API ←────── 使用者手機
    ↓
    ├── 查詢類 → 讀 state files → 回覆 Telegram
    └── 控制類 → tmux send-keys → Claude Code (同一 session)
```

### 解耦原則

- remote **不 import** flow 的程式碼（零依賴）
- Agent → Stage 映射硬編碼在 remote-sender.js 內
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
| `remote` | 主控 — start/stop/status/send/test |
| `remote-config` | 設定教學 — show/verify/guide |

### Hooks（4 個）

| 事件 | Matcher | Script | 說明 |
|------|---------|--------|------|
| PreToolUse | `AskUserQuestion` | `remote-ask-intercept.js` | 互動式選單（攔截 → Telegram inline keyboard） |
| SessionStart | `startup\|resume` | `remote-autostart.js` | 自動啟動 bot daemon |
| SubagentStop | `*` | `remote-sender.js` | Pipeline stage 完成推播 |
| Stop | `*` | `remote-receipt.js` | /say 已讀回條（✓→✅） |

### Scripts（6 個）

| 名稱 | 類型 | 說明 |
|------|------|------|
| `remote-ask-intercept.js` | hook | PreToolUse: 攔截 AskUserQuestion → Telegram inline keyboard |
| `remote-autostart.js` | hook | SessionStart: 偵測 → 啟動 daemon |
| `remote-sender.js` | hook | SubagentStop: 讀 state → 推播 Telegram |
| `remote-receipt.js` | hook | Stop: 讀 pending → editMessageText ✅ |
| `bot-manager.js` | lib | Daemon 生命週期（isRunning/start/stop/getState） |
| `telegram.js` | lib | Telegram Bot API 封裝（sendMessage/editMessageText/sendMessageWithKeyboard/answerCallbackQuery/editMessageReplyMarkup/getUpdates/getMe） |

### 其他

| 名稱 | 說明 |
|------|------|
| `bot.js` | 背景 daemon — long polling + 查詢指令 + tmux 遠端控制 |

---

## 4. 認證方式

兩種方式（擇一）：

**方式 A：環境變數**（`~/.zshrc`）
```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."   # @BotFather 取得
export TELEGRAM_CHAT_ID="987654321"              # 目標 chat ID
```

**方式 B：.env 檔案**（推薦）
```bash
# ~/.claude/remote.env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

優先順序：環境變數 > .env 檔案。所有入口點第一步檢查 credentials，缺少時 exit 0（靜默降級）。

---

## 5. 推播通知

### 觸發時機

SubagentStop hook — flow plugin 的 stage-transition.js 先更新 state file（buildOrder 1），remote-sender.js 後讀取（buildOrder 6）。

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
🏗️ architect 完成（ARCH）
結果：✅ PASS
進度：📋 ✅ → 🏗️ ✅ → 💻 ⏳ → 🔍 → 🧪 → ✅ → 🌐 → 📝
Session: a1b2c3d4
```

> 進度條格式：已完成 ✅ → 進行中 ⏳ → 待處理（顯示 stage emoji）
> Namespaced agent（如 `flow:architect`）自動去除前綴映射

**Pipeline 全部完成**：
```
🎉 Pipeline 完成
任務：feature | 結果：✅ PASS
📋 ✅ → 🏗️ ✅ → 💻 ✅ → 🔍 ✅ → 🧪 ✅ → ✅ ✅ → 🌐 ✅ → 📝 ✅
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

# bot daemon 注入文字到同一 session（分步送出）
tmux send-keys -t {pane} -l "幫我加登入頁面"
tmux send-keys -t {pane} Enter
```

### tmux pane 偵測

1. `$CLAUDE_TMUX_PANE`（環境變數，最可靠）
2. `tmux list-panes -a` + `pane_current_command` 掃描 → 找 `claude` 進程
3. `pgrep -x claude` + `ps -o ppid=` → 進程樹回溯到 tmux pane
4. `$TMUX_PANE`（回退）

### 安全

- 只回應指定 `TELEGRAM_CHAT_ID` 的使用者
- `/say` 前綴與查詢指令明確區隔
- 所有 `/say` 指令記錄到 `~/.claude/remote-bot.log`

### 已讀回條 + 完成偵測

`/say` 發送後自動追蹤 Claude Code 的處理狀態，使用 Hook 精確偵測：

```
使用者：「幫我加登入頁面」

  ✓ 已傳送          ← sendKeys 成功（立即）+ 寫 state file
  ✅ 完成            ← Stop hook 偵測到回合結束 → editMessageText
```

**機制**：bot.js 發送後寫入 `~/.claude/remote-say-pending.json`（含 messageId）。Claude Code 回合結束時 Stop hook（`remote-receipt.js`）讀取 state file → `editMessageText` 更新為 ✅ → 刪除 state file。

**特性**：
- Hook-based 精確偵測（非 polling），零資源消耗
- State file 10 分鐘過期自動清理
- 無 pending → hook 靜默退出（exit 0）
- `stop_hook_active` 防迴圈保護

### 互動式選單（AskUserQuestion → Telegram）

當 Claude 呼叫 AskUserQuestion 時，PreToolUse hook 攔截並將選項發送到 Telegram：

```
Claude: AskUserQuestion({questions, options})
    ↓ PreToolUse hook
remote-ask-intercept.js
    ↓ 讀取 tool_input → Telegram sendMessageWithKeyboard
    ↓ 寫 remote-ask-pending.json → 輪詢 remote-ask-response.json
    ↓
bot.js daemon
    ↓ callback_query → answerCallbackQuery
    ↓ 單選：直接寫 response｜多選：toggle ☑/☐ → 確認後寫 response
    ↓
Hook 讀到 response
    ↓ { continue: false, systemMessage: "使用者選擇了：..." }
```

**State Files**：
- `~/.claude/remote-ask-pending.json` — hook 寫、daemon 讀（含 messageId/questions/selections）
- `~/.claude/remote-ask-response.json` — daemon 寫、hook 讀（含 selectedLabels）

**特性**：
- Hook 直接發送 Telegram 訊息（避免 30s long polling 延遲）
- 55 秒超時回退到正常 TUI（`continue: true`）
- 多選模式：☐/☑ toggle + editMessageReplyMarkup 即時更新
- `continue: false` + `systemMessage` 阻止 TUI 顯示，答案注入 Claude context
- 無 credentials → 靜默放行（`continue: true`）

---

## 8. Daemon 生命週期

| 面向 | 設計 |
|------|------|
| PID 檔 | `~/.claude/remote-bot.pid`（全域） |
| 存活偵測 | `process.kill(pid, 0)`（無 port） |
| 啟動 | `spawn('node', [botPath], { detached, stdio: 'ignore' })` |
| 自動啟動 | SessionStart hook → remote-autostart.js |
| 手動控制 | `/remote start\|stop\|status` |
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
| 完成偵測 | Stop hook + state file | 精確、零 polling 消耗 |
| 狀態更新 | editMessageText | 同一訊息就地更新、不洗版 |
| 互動式選單 | PreToolUse hook + inline keyboard | 攔截 AskUserQuestion，Telegram 直接回答 |
| 選單發送者 | Hook 直接發（非 daemon） | 避免 30s long polling 延遲 |
| callback 接收者 | Daemon（bot.js） | 已有 polling 機制，不重複 |
| 超時策略 | 55s 後 `continue: true` | 回退到正常 TUI，不阻塞 Claude |

---

## 10. 未來擴充

- **更多控制指令** — /cancel、/checkpoint、/restart 等從 Telegram 操作工作流
- **豐富監控** — context 使用量、token 消耗、即時輸出視窗
- **多 session 管理** — 同時監控/控制多個 tmux session 的 Claude Code
- **Claude Control API** — 當 Anthropic 開放 session 控制 API，替換 tmux 為原生呼叫
