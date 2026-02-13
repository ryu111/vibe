# tmux 使用指南

> 搭配 Vibe notify plugin 使用，讓 Claude Code 可以在背景持續運作並透過 Telegram 遠端控制。

## 為什麼需要 tmux

```
沒有 tmux                        有 tmux
┌──────────────┐                 ┌──────────────┐
│ 終端機關掉   │                 │ 終端機關掉   │
│ → Claude 死  │                 │ → Claude 還活著（在 tmux 裡）
│ → 工作中斷   │                 │ → 隨時 attach 回來
│ → 無法遠端   │                 │ → Telegram /say 遠端控制
└──────────────┘                 └──────────────┘
```

tmux 讓 Claude Code 跑在一個「虛擬終端」裡，你關掉電腦螢幕、斷開 SSH、甚至登出帳號，Claude Code 都還在跑。

## 核心三招

日常只需要這三個操作：

```bash
# 1. 建立 session 並進入（第一次用）
tmux new -s claude

# 2. 離開但不關閉（detach）
#    按 Ctrl+B，放開，再按 d

# 3. 回來（attach）
tmux a
```

## 日常工作流程

```
早上開工
  │
  ├── 有 session？ ──→ tmux a（直接回去）
  │
  └── 沒有？ ──→ tmux new -s claude
                  └── cd ~/projects/vibe && claude
                                │
                          （正常工作...）
                                │
                 午餐離開 → Ctrl+B d
                                │
                 人在外面 → Telegram /say 幫我跑測試
                                │
                   回來了 → tmux a（繼續看結果）
                                │
                 下班離開 → Ctrl+B d
                                │
                   隔天 ──→ tmux a（一切都在）
```

## 搭配 notify 遠端控制

tmux 是 notify plugin `/say` 指令的基礎：

```
Telegram                         你的 Mac
┌──────────────┐                 ┌──────────────────────────┐
│ /say 跑測試  │ ───────────────>│ notify daemon (bot.js)   │
│              │   Telegram API  │      │                    │
│              │                 │      │ tmux send-keys     │
│              │                 │      ↓                    │
│              │                 │ tmux pane                 │
│              │                 │ └── Claude Code           │
│              │                 │     └── 「跑測試」← 出現！│
└──────────────┘                 └──────────────────────────┘
```

notify daemon 透過 `tmux send-keys` 把文字「打」進 Claude Code 所在的 pane，Claude Code 以為是你親手輸入的。

### 功能與 tmux 依賴關係

| notify 功能 | 需要 tmux | 原理 |
|-------------|:---------:|------|
| 推播通知（stage 完成 → Telegram） | 不需要 | hook 直接呼叫 Telegram API |
| 查詢狀態（`/status`、`/stages`） | 不需要 | 讀取 pipeline state files |
| 遠端控制（`/say 指令`） | **需要** | `tmux send-keys` 注入 |

## 偶爾用到的操作

| 情境 | 指令 |
|------|------|
| 查看現有 session | `tmux ls` |
| session 壞了，砍掉重來 | `tmux kill-session -t claude` |
| tmux 裡捲動看歷史輸出 | `Ctrl+B` → `[`，方向鍵捲動，`q` 退出 |

## 安裝

```bash
brew install tmux
```

## 常見問題

### Q: 我人在電腦前也要用 tmux 嗎？

是的。養成「永遠在 tmux 裡開 Claude Code」的習慣，這樣隨時可以 detach 離開，notify 遠端控制也能正常運作。

### Q: tmux 裡開的 Claude Code 跟直接開有什麼不同？

完全沒有不同。tmux 只是一個「容器」，不會影響 Claude Code 的任何行為。

### Q: 為什麼不能用 tmux 去連接已經在外面開的 Claude Code？

`tmux send-keys` 只能控制 tmux 自己管理的 pane。外面的終端程式，tmux 碰不到。所以必須在 tmux **裡面**開 Claude Code。

### Q: Ctrl+B d 之後 Claude Code 還在跑嗎？

是的。Detach 只是斷開你的「視窗」，tmux session 和裡面的所有程式都繼續在背景執行。
