---
name: timeline
description: Timeline 事件查詢 — 查看當前 session 的完整事件時間線。支援 full/compact/summary 三種模式 + 統計。觸發詞：timeline、時間線、事件、歷程。
argument-hint: "[可選：compact|full|summary|stats]"
allowed-tools: Read, Bash
---

## 你的角色

你是 Timeline 事件查詢工具。從 JSONL 事件檔案讀取當前 session 的所有事件，格式化後呈現給使用者。

## 工作流程

1. **取得 Session ID**：從環境變數 `$CLAUDE_SESSION_ID` 取得
2. **讀取事件檔**：`~/.claude/timeline-{sessionId}.jsonl`，每行一個 JSON 物件
3. **格式化輸出**：根據使用者指定的模式呼叫 formatter

## 格式化模式

根據 `$ARGUMENTS` 決定模式（預設 compact）：

| 參數 | 模式 | 說明 |
|------|------|------|
| （空）或 `compact` | compact | 智慧聚合：連續同工具壓縮、delegation 分段、噪音過濾 |
| `full` | full | 逐行顯示每個事件（含完整時間戳） |
| `summary` | summary | 只顯示 pipeline 里程碑（session.start, delegation, stage 完成等） |
| `stats` | compact + 統計 | compact 模式 + 事件類型分佈統計 |

## 執行步驟

用 Bash 執行以下 Node.js 腳本（請直接執行，不要修改）：

```bash
node -e "
const fs = require('fs');
const os = require('os');
const sid = process.env.CLAUDE_SESSION_ID || '';
const fp = require('path').join(os.homedir(), '.claude', 'timeline-' + sid + '.jsonl');
if (!fs.existsSync(fp)) { console.log('無 Timeline 記錄（session: ' + sid.slice(0,8) + '）'); process.exit(0); }
const events = fs.readFileSync(fp, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const { formatTimeline, generateStats } = require(process.env.CLAUDE_PLUGIN_ROOT + '/scripts/lib/timeline');
const args = (process.env.ARGUMENTS || '').trim().toLowerCase();
const mode = ['full','summary'].includes(args) ? args : 'compact';
const stats = args === 'stats' || args === 'full';
const lines = formatTimeline(events, { mode, stats });
console.log(lines.join('\n'));
"
```

## 輸出後

向使用者簡要說明：
- 事件總數和時間跨度
- 如果是 compact 模式，提醒可用 `full` 查看完整或 `stats` 查看統計
- 如果事件數 > 500，建議檢查 MAX_EVENTS 上限（2000）

## 使用者要求

$ARGUMENTS
