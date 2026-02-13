---
name: dashboard
description: Pipeline 儀表板控制 — 啟動、停止、重啟、查詢狀態、開啟瀏覽器。觸發詞：dashboard、儀表板、監控。
argument-hint: "[start|stop|status|open|restart] — 留空顯示狀態"
allowed-tools: Read, Bash, Grep, Glob
---

## 你的角色

你是 Pipeline Dashboard 的管理者。透過 server-manager.js 管理 dashboard server 生命週期，並向使用者回報狀態。

## 指令對照

| 指令 | 動作 |
|------|------|
| `status`（預設） | 查詢 server 狀態、port、PID、URL |
| `start` | 啟動 dashboard server（已啟動則顯示狀態） |
| `stop` | 停止 dashboard server |
| `restart` | 停止後重新啟動 |
| `open` | 用 `open` 指令在瀏覽器開啟 dashboard |

## 工作流程

1. **判斷指令**：從 `$ARGUMENTS` 解析子指令（留空 = `status`）
2. **執行操作**：用 Bash 呼叫 server-manager.js 對應函式
3. **回報結果**：顯示操作結果和 server 狀態

## 操作範例

### 查詢狀態
```bash
node -e "const m = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/server-manager.js'); (async()=>{ const r = await m.isRunning(); const s = m.getState(); const ip = m.getLanIP(); console.log(JSON.stringify({running:r, state:s, lanIP:ip, port:m.PORT})) })()"
```

### 啟動
```bash
node -e "const m = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/server-manager.js'); (async()=>{ if(await m.isRunning()){console.log('already running');return} const r=m.start(); console.log(JSON.stringify(r)) })()"
```

### 停止
```bash
node -e "const m = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/server-manager.js'); console.log(JSON.stringify(m.stop()))"
```

### 開啟瀏覽器
```bash
open "http://localhost:3800"
```

## 參考：輸出格式

```
## Dashboard 狀態

- **狀態**：執行中 / 已停止
- **PID**：12345
- **Port**：3800
- **Local**：http://localhost:3800
- **LAN**：http://192.168.x.x:3800
- **啟動時間**：2026-02-12T00:00:00Z
```

## 使用者要求

$ARGUMENTS
