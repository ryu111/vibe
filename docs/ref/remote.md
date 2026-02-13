# remote — Telegram 遠端控制

> **優先級**：高
> **定位**：遠端控制 — Pipeline 進度推播、狀態查詢、tmux 遠端操作
> **Telegram 先行**，之後可擴充其他通訊管道
> **核心概念**：遊戲外掛模式 — 讀取狀態（pipeline state files）+ 注入輸入（tmux send-keys）

---

## 1. 概述

remote 是 Vibe marketplace 的遠端控制 plugin。五大功能軸：

1. **推播** — Pipeline stage 完成 → Telegram 通知（使用者手機收到進度）
2. **查詢** — 從 Telegram 查詢 /status /stages → 讀 state files 直接回覆
3. **遠端控制** — `/say <訊息>` → tmux send-keys → 注入到同一個 Claude Code session
4. **對話同步** — UserPromptSubmit → 使用者輸入轉發 + Stop → 回合摘要通知
5. **互動選單** — AskUserQuestion → Telegram inline keyboard + 數字回覆（非阻擋，遠端選擇）

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

### Hooks（5 個）

| 事件 | Matcher | Script | 說明 |
|------|---------|--------|------|
| PreToolUse | `AskUserQuestion` | `remote-ask-intercept.js` | 互動通知（非阻擋，inline keyboard + 遠端選擇） |
| UserPromptSubmit | `*` | `remote-prompt-forward.js` | 使用者輸入轉發到 Telegram |
| SessionStart | `startup\|resume` | `remote-autostart.js` | 自動啟動 bot daemon |
| SubagentStop | `*` | `remote-sender.js` | Pipeline stage 完成推播 |
| Stop | `*` | `remote-receipt.js` | /say 已讀回條 + 回合摘要通知 |

### Scripts（7 個）

| 名稱 | 類型 | 說明 |
|------|------|------|
| `remote-ask-intercept.js` | hook | PreToolUse: 非阻擋轉發 AskUserQuestion → inline keyboard 通知 + pending file |
| `remote-prompt-forward.js` | hook | UserPromptSubmit: 使用者輸入轉發到 Telegram |
| `remote-autostart.js` | hook | SessionStart: 偵測 → 啟動 daemon |
| `remote-sender.js` | hook | SubagentStop: 讀 state → 推播 Telegram |
| `remote-receipt.js` | hook | Stop: /say 已讀回條 + 回合摘要通知 |
| `bot-manager.js` | lib | Daemon 生命週期（isRunning/start/stop/getState） |
| `telegram.js` | lib | Telegram Bot API 封裝（sendMessage/editMessageText/sendMessageWithKeyboard/answerCallbackQuery/editMessageReplyMarkup/getUpdates/getMe） |
| `transcript.js` | lib | 共用 transcript JSONL 解析（parseLastAssistantTurn — 提取文字回應 + 工具統計） |

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
🔍 REVIEW ✅ 5m (feature)
  → 程式碼品質良好，無重大問題
📋✅ 🏗️✅ 💻✅ 🔍✅ 🧪⬜ ✅⬜ 🌐⬜ 📝⬜
```

> 格式：`{emoji} {STAGE} {verdict} {耗時} ({taskType}) {retry}`
> 含 agent 摘要（從 transcript 最後 assistant turn 提取，截斷 200 字）
> 進度條壓縮為無箭頭一行：已完成 ✅ / 失敗 ❌ / 待處理 ⬜
> Namespaced agent（如 `flow:architect`）自動去除前綴映射

**Stage 失敗（含回退）**：
```
🔍 REVIEW ❌ 3m (feature) (retry 1/3)
  → SQL injection 風險、缺少輸入驗證
📋✅ 🏗️✅ 💻✅ 🔍❌ 🧪⬜ ✅⬜ 🌐⬜ 📝⬜
```

**Pipeline 全部完成**：
```
🎉 Pipeline 完成 ✅ (feature) 26m
📋✅ 🏗️✅ 💻✅ 🔍✅ 🧪✅ ✅✅ 🌐✅ 📝✅
```

> 含總耗時（`initialized` 時間到完成時間）

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

### 互動通知 + 遠端選擇（AskUserQuestion → Telegram）

當 Claude 呼叫 AskUserQuestion 時，PreToolUse hook 將選項同步到 Telegram（非阻擋），支援 inline keyboard 按鈕和數字回覆兩種操作方式：

```
Claude: AskUserQuestion({questions, options})
    ↓ PreToolUse hook
remote-ask-intercept.js
    ↓ 讀取 tool_input → inline keyboard 通知（附選項編號 + 按鈕）
    ↓ 寫 remote-ask-pending.json（含 messageId）→ 立即放行 TUI（exit 0）
    ↓
TUI 正常顯示                  bot.js daemon
  ↓                              ↓ 收到 callback_query 或數字回覆
  ↓                              ↓ checkAskPending → 匹配 pending
使用者在終端操作                ↓ tmux send-keys 操控 TUI
  或                            ↓ 單選：一步完成 / 多選：toggle + ok 確認
Telegram 遠端選擇 ────────→ 完成（editMessageText 顯示結果）
```

**雙通道回答**：TUI 和 Telegram 都能回答，誰先操作用誰的。

**Telegram 通知格式**（附 inline keyboard）：

單選：
```
📋 下一步想做什麼？

1. 推送到 remote — git push + marketplace sync
2. 測試成功 — 確認全部功能正常
3. 還有問題 — 需要繼續調整

👉 點按鈕或回覆數字即可選擇

[推送到 remote]
[測試成功]
[還有問題]
```

多選：
```
📋 選擇要啟用的功能：

1. 功能 A — 說明
2. 功能 B — 說明
3. 功能 C — 說明

👉 點按鈕或數字勾選，輸入 ok 確認

[☐ 功能 A]
[☐ 功能 B]
[☐ 功能 C]
[✓ 確認]
```

**選擇後結果顯示**（editMessageText 取代原訊息 + 移除 keyboard）：
```
📋 下一步想做什麼？

✅ 已選擇：測試成功
```

**操作方式**：

| 輸入方式 | 單選 | 多選 |
|----------|------|------|
| Inline 按鈕 | 一步完成（按 = 選 + 確認） | toggle ☑/☐ → 按「確認」按鈕 |
| 數字回覆 | 一步完成（`2` → 選第 2 項） | `1 3` toggle → `ok` 確認 |

**tmux 鍵盤操作**：daemon 收到選擇後，用 tmux send-keys 發送 key name（非 literal text）操控 TUI：

| 模式 | 操作 | tmux 按鍵序列 |
|------|------|---------------|
| 單選 | 選第 N 項 | `Down`×(N-1) + `Enter`（一步完成） |
| 多選 toggle | 勾選第 M 項 | 數字鍵 `M`（TUI 自動 toggle） |
| 多選確認 | 提交選擇 | `Tab` 跳 Submit + `Enter` × 2（double submit） |

**多選 TUI 布局**（5 個位置層級）：
```
☐ 選項 1         ← 0
☐ 選項 2         ← 1
☐ ...            ← ...
☐ 選項 N         ← N-1
  Other           ← N（自由輸入）
  Submit          ← N+1（第一次 Enter）
  Cancel          ← N+2
  → Review 畫面  ← 第二次 Enter 確認
```

**多題支援**：AskUserQuestion 可包含多個問題（`questions` 陣列）。每題自動推進：
- 單選答完 → 自動推進到下一題（發新 keyboard 通知）
- 多選確認後 → 自動推進到下一題
- 最後一題完成 → 清理 pending

**State File**：
- `~/.claude/remote-ask-pending.json` — hook 寫、daemon 讀
  - 含 `questions`/`optionCount`/`multiSelect`/`messageId`/`questionIndex`/`totalQuestions`/`selections`/`waitingConfirm`

**特性**：
- Inline keyboard 按鈕 + 數字回覆雙模式
- 單選一步完成（按鈕或數字 → 立即確認），多選兩步（toggle → ok 確認）
- Callback query 和文字回覆共用同一套 tmux 操控邏輯
- 按鈕選擇後 editMessageText 就地更新結果（不洗版）
- 多選 toggle 後即時更新 keyboard 按鈕狀態（☑/☐）
- 分步送出按鍵 + 延遲（50ms 移動 / 100ms toggle / 100ms Tab）避免掉鍵
- 多題自動推進（每題發新 keyboard 通知）
- Pending 5 分鐘過期自動清理
- 無 credentials → 靜默放行（正常 TUI 顯示）

### 回合摘要通知

Stop hook 解析 transcript 最近一個回合，拆成兩則 Telegram 訊息：

**訊息 1：Claude 的文字回應**（有文字時才發）：
```
🤖 好的，我已經完成認證功能的實作。建立了 auth.js 和 login.vue 兩個檔案...
```

**訊息 2：工具統計一行摘要**（有工具時才發）：
```
📋 回合動作：📝×2 ✏️×3 ⚡×1 🤖×2 🔍×5 📖×3
```

> 工具圖示：📝 Write / ✏️ Edit / ⚡ Bash / 🤖 Task / 🔍 Search / 📖 Read

**特性**：
- 文字回應截斷至 500 字（Telegram 訊息上限 4096，留空間）
- 共用 `transcript.js` 的 `parseLastAssistantTurn()` 解析（只讀最後 64KB）
- 節流 10 秒（避免連續回合轟炸）
- 純文字發送（無 Markdown parse mode，避免特殊字元造成解析錯誤）

### 使用者輸入轉發

UserPromptSubmit hook 將使用者輸入同步到 Telegram：

```
👤 幫我加一個新功能：用戶登入頁面
```

**特性**：
- 純旁路轉發，不阻擋、不修改 prompt
- 過長 prompt 截斷至 3900 字元（Telegram 訊息上限 4096）

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
| 防衝突 | 啟動時 `pgrep -f bot.js` 清理殘留孤兒進程 |
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
| 互動通知 | PreToolUse hook + inline keyboard | 攔截 AskUserQuestion，按鈕 + 數字雙模式遠端選擇 |
| AskUserQuestion 策略 | 非阻擋（inline keyboard + tmux 鍵盤操作） | 按鈕直覺操作、數字快捷回覆、TUI 正常顯示 |
| 回合摘要 | Stop hook + transcript 解析 | 🤖 文字回應 + 📋 工具統計雙訊息 |
| Pipeline 通知 | 壓縮進度條 + 耗時/retry/摘要 | 手機小螢幕友善、資訊更豐富 |
| 輸入轉發 | UserPromptSubmit hook | 手機同步看到完整對話流 |

---

## 10. 未來擴充

- **更多控制指令** — /cancel、/checkpoint、/restart 等從 Telegram 操作工作流
- **豐富監控** — context 使用量、token 消耗、即時輸出視窗
- **多 session 管理** — 同時監控/控制多個 tmux session 的 Claude Code
- **Claude Control API** — 當 Anthropic 開放 session 控制 API，替換 tmux 為原生呼叫
