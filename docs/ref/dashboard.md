# Vibe Dashboard 規格文件

> 最後更新：2026-02-21 | 基於 vibe v5.0.5 實作（Phase 1-5 重設計）

---

## 1. 概述

### 1.1 系統定位

Vibe Dashboard 是 Pipeline v4/v5 的即時視覺監控系統，提供 Pipeline 執行狀態的全程視覺化——從 task-classifier 分類完成到最後一個 stage 結束。

**v5.0.5 重設計重點**：

- Tab 2 Pipeline 改為 SVG+HTML DAG 流程圖（取代 Snake Grid + Pixel Office）
- Tab 1 Dashboard 新增 StatsCards 統計卡片 + 動態 Pipeline 進度條
- Sidebar 自動排序（活躍優先 → 最近活動，移除排序下拉）
- Toolbar 精簡（保留全螢幕/導出/縮放，移除像素主題和聚焦模式按鈕）
- `/api/registry` 端點：前端動態取得 stages/pipelines/agents metadata（不再硬編碼）
- Agent 面板標題列顯示 Server heap 記憶體用量

### 1.2 系統架構

| 系統                 | 路徑                                                                         | 技術                              | 用途                      |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------- |
| **Runtime 即時監控** | `plugins/vibe/web/` (組件化) + `plugins/vibe/server.js`                    | Preact + HTM + Bun HTTP/WebSocket | 即時追蹤執行中的 pipeline |

注意：Build-time 靜態報告系統（`dashboard/`）已廢棄，`dashboard/config.json` 已移除。

**自動啟動流程**：

```
SessionStart hook
  → dashboard-autostart.js
  → net.createConnection（port 偵測，不需 curl）
  → 若 port 3800 無回應 → spawn server.js（detached）
  → TERM_PROGRAM=vscode → Simple Browser 開啟
  → 否則 macOS open 開啟瀏覽器
```

### 1.3 技術棧

**Runtime SPA（`web/` 組件化架構）**：

- Preact 10.25.4（ESM via `esm.sh`）+ HTM 3.1.1（tagged template literal JSX）
- 14 個 ES module 檔案（`app.js` + 9 個 component + 2 個 lib + 1 個 state）+ `styles.css`
- 字體：SF Mono / Cascadia Code / Fira Code（系統等寬，移除 Press Start 2P 像素字體）
- 色彩系統：Catppuccin Mocha（`:root` CSS 變數）
- 資料層：`/api/registry` 取代前端硬編碼的 SM/TYPE_LABELS/AGENT_ROSTER

**Web 目錄結構**：

```
web/
├── index.html              # HTML shell（14 行）
├── styles.css              # 主樣式（~336 行）
├── app.js                  # 應用主控制（~280 行，App + WebSocket + tabs）
├── lib/
│   ├── preact.js           # Preact CDN re-export hub
│   └── utils.js            # 共用 helpers（sid/now/elapsed/fmtSec/fmtDuration/fmtSize）
├── state/
│   └── pipeline.js         # 11 個 state accessor 函式
└── components/             # 9 個組件
    ├── sidebar.js          # Session 列表 + 側邊欄
    ├── dag-view.js         # DAG 流程圖 + layout 演算法
    ├── barrier-display.js  # Barrier 狀態顯示
    ├── agent-status.js     # Agent 面板 + 狀態燈
    ├── mcp-stats.js        # MCP 工具統計
    ├── stats-cards.js      # 8 張統計卡片
    ├── pipeline-progress.js# 進度條
    ├── confetti.js         # 完成慶祝動畫
    └── export-report.js    # 報告匯出
```

**後端（`server.js`）**：

- Bun HTTP + WebSocket Server（`Bun.serve()`）
- Port：`--port=` CLI 參數 > `VIBE_DASHBOARD_PORT` 環境變數 > 預設 3800
- PID 管理：`~/.claude/dashboard-server.pid`（JSON 格式：pid + port + startedAt）
- Timeline consumer（來自 `scripts/lib/timeline/consumer.js`）

---

## 2. 資料模型

### 2.1 Pipeline State（v4 DAG）

Pipeline state 儲存於 `~/.claude/pipeline-state-{sessionId}.json`，格式：

```json
{
  "version": 4,
  "dag": {
    "DEV": { "deps": [], "barrier": null, "onFail": "DEV", "next": "REVIEW" },
    "REVIEW": {
      "deps": ["DEV"],
      "barrier": "post-dev",
      "onFail": "DEV",
      "next": null
    },
    "TEST": {
      "deps": ["DEV"],
      "barrier": "post-dev",
      "onFail": "DEV",
      "next": null
    }
  },
  "stages": {
    "DEV": {
      "status": "completed",
      "verdict": { "verdict": "PASS" },
      "agent": "developer",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "completedAt": "2026-01-01T00:10:00.000Z",
      "contextFile": "~/.claude/pipeline-context-{sid}-DEV.md"
    }
  },
  "classification": {
    "pipelineId": "quick-dev",
    "taskType": "bugfix",
    "classifiedAt": "2026-01-01T00:00:00.000Z"
  },
  "pipelineActive": true,
  "activeStages": ["REVIEW", "TEST"],
  "retries": { "DEV": 0 },
  "crashes": { "REVIEW": 0 },
  "retryHistory": {
    "REVIEW": [{ "round": 1, "verdict": "FAIL", "severity": "HIGH" }]
  },
  "meta": {
    "classifiedAt": "2026-01-01T00:00:00.000Z",
    "lastTransition": "2026-01-01T00:10:00.000Z"
  }
}
```

### 2.2 Timeline Events（33 種類型，7 大類）

定義於 `scripts/lib/timeline/schema.js`，儲存格式為 `~/.claude/timeline-{sessionId}.jsonl`（append-only，後端上限 2000 筆）。

**Envelope 格式**：

```json
{
  "id": "uuid",
  "type": "stage.complete",
  "sessionId": "uuid",
  "timestamp": 1234567890000,
  "data": {}
}
```

**7 大分類與事件類型**：

| 分類       | 事件類型                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`  | `session.start`                                                                                                                                                                                                                                            |
| `task`     | `task.classified`, `prompt.received`, `delegation.start`, `task.incomplete`                                                                                                                                                                                |
| `agent`    | `tool.used`, `delegation.start`                                                                                                                                                                                                                            |
| `pipeline` | `stage.start`, `stage.complete`, `stage.retry`, `pipeline.complete`, `pipeline.incomplete`, `route.fallback`, `retry.exhausted`, `barrier.waiting`, `barrier.resolved`, `agent.crash`, `pipeline.cancelled`, `barrier.crash-guard`, `stage.crash-recovery` |
| `quality`  | `tool.blocked`, `tool.guarded`, `quality.lint`, `quality.format`, `quality.test-needed`                                                                                                                                                                    |
| `remote`   | `ask.question`, `ask.answered`, `turn.summary`, `say.sent`, `say.completed`, `compact.suggested`, `compact.executed`                                                                                                                                       |
| `safety`   | `agent.crash`, `safety.transcript-leak`, `barrier.crash-guard`, `stage.crash-recovery`                                                                                                                                                                     |

注意：`delegation.start` 同屬 `task` + `agent` 兩類；`agent.crash` 同屬 `pipeline` + `safety` 兩類。

### 2.3 Barrier State

儲存於 `~/.claude/barrier-state-{sessionId}.json`：

```json
{
  "groups": {
    "post-dev": {
      "siblings": ["REVIEW", "TEST"],
      "completed": ["REVIEW"],
      "results": {
        "REVIEW": { "verdict": "PASS", "route": "NEXT" }
      },
      "next": "QA",
      "total": 2,
      "resolved": false,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

**Barrier 生命週期**：

1. `createBarrierGroup`：stage-transition 委派 barrier sibling 時建立
2. `updateBarrier`（冪等）：每個 sibling 完成時更新 `completed` + `results`
3. `mergeBarrierResults`：所有 sibling 完成 → Worst-Case-Wins 合併（FAIL 優先）
4. `deleteBarrier`：FAIL 時清理 group
5. timeout force-unlock：absent sibling → 視為 FAIL

### 2.4 adaptState() 適配層

`adaptState(raw)` 函式（定義於 `web/app.js`）將 v4 DAG state 轉換為前端 UI 使用的 v2 相容扁平格式：

```js
// 輸入：v4 DAG state（含 dag + stages + classification）
// 輸出：前端 UI 相容格式
{
  expectedStages: [...],       // dag key 列表
  stageResults: {              // 展平 verdict 物件
    DEV: { verdict, severity, duration, completedAt }
  },
  currentStage: 'REVIEW',     // 第一個 active stage
  delegationActive: true,      // !!activeStage
  isPipelineComplete: false,   // 所有 stage completed/skipped/failed
  cancelled: false,            // pipelineActive=false 且未完成
  completed: [...],            // completed stage 對應的 agent 名稱
  skippedStages: [...],
  taskType, pipelineId,
  lastTransition, startedAt,
  retries, environment,
}
```

---

## 3. 通訊協議

### 3.1 WebSocket 訊息格式

**連線端點**：`ws://localhost:3800/ws`

**Server → Client 訊息類型**：

| 類型        | 觸發時機                             | Payload                                                                  |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `init`      | 新連線建立                           | `{ type, sessions, alive }` — 全量初始化 + 所有歷史 timeline 事件 replay |
| `update`    | pipeline-state 檔案變化（80ms 防抖） | `{ type, sessions }` — 全量 sessions 物件                                |
| `heartbeat` | heartbeat 檔案變化（500ms 防抖）     | `{ type, alive }` — sessionId → boolean 映射                             |
| `timeline`  | Timeline consumer 接收新事件         | `{ type, sessionId, event }` — 格式化後的單一事件                        |
| `barrier`   | barrier-state 檔案變化（80ms 防抖）  | `{ type, sessionId, barrierState }` — 完整 barrier state 或 null         |
| `pong`      | 收到 `ping`                          | 字串 `'pong'`                                                            |

**Client → Server**：

| 訊息   | 說明                 |
| ------ | -------------------- |
| `ping` | 保活心跳（每 25 秒） |

**WebSocket 重連策略**：指數退避，間隔 `300 * 2^retries`ms，上限 5000ms。

### 3.2 REST API

| 方法     | 路徑                    | 說明                                    | 回應                |
| -------- | ----------------------- | --------------------------------------- | ------------------- |
| `GET`    | `/api/sessions`         | 取得所有 sessions 物件                  | `{ [sid]: state }`  |
| `GET`    | `/api/clients`          | 查詢 WebSocket 連線數                   | `{ count: number }` |
| `POST`   | `/api/sessions/cleanup` | 批次清理（100% 完成 + stale 超 1 小時） | `{ ok, cleaned }`   |
| `DELETE` | `/api/sessions/{id}`    | 刪除指定 session state 檔案             | `{ ok, deleted }`   |
| `GET`    | `/*`                    | 靜態檔案（`web/` 目錄，路徑遍歷防護）   | 對應 MIME 類型      |

**安全**：DELETE 端點驗證 UUID 格式（`UUID_RE`），靜態檔案路徑必須在 `WEB_DIR` 內。

### 3.3 File Watcher

`fs.watch(CLAUDE_DIR)` 監聽 `~/.claude/` 目錄所有檔案變化：

| 檔案模式                | 防抖  | 處理                                                   |
| ----------------------- | ----- | ------------------------------------------------------ |
| `pipeline-state-*.json` | 80ms  | 解析並廣播 `update`；新 session 啟動 Timeline consumer |
| `barrier-state-*.json`  | 80ms  | 解析並廣播 `barrier`                                   |
| `heartbeat-*`           | 500ms | 廣播 `heartbeat`（`alive` 映射）                       |

**Session 過濾**：UUID_RE 正規表達式過濾測試產生的非 UUID session ID。

**isDisplayWorthy 判斷**：

- 有 DAG（`dag` 物件有 key）→ 顯示
- 有非 `none` 的 pipelineId → 顯示
- v2 相容：有 `expectedStages` → 顯示

**自動清理**：每 5 分鐘掃描，空 session（無 DAG 無分類）且超過 30 分鐘未活動 → 刪除檔案 + 廣播更新。

---

## 4. 視圖規格

### 4.1 Sidebar — Session 管理

**整體佈局**：

- 預設寬 230px，收合時 52px（切換按鈕：`◀/▶`）
- `grid-template-columns: var(--sidebar-w, 230px) 1fr`，過渡 0.3s

**Session Card（`.sc`）欄位**：

| 欄位    | 說明                                               |
| ------- | -------------------------------------------------- |
| 標題行  | Live 綠點（`livePulse` 動畫） + Pipeline 類型標籤  |
| 副標題  | Session ID 前 8 碼 + elapsed time                  |
| Meta 行 | 當前 stage emoji + 名稱 + 進度百分比               |
| 進度條  | 3px 高，`blue→green` 漸層，完成時純 `green`        |
| 刪除鈕  | hover 才顯示，點擊呼叫 `DELETE /api/sessions/{id}` |

**3 個 Session 群組**：

| 群組 CSS                        | 判斷條件                    | 透明度                    |
| ------------------------------- | --------------------------- | ------------------------- | ----------------- | -------------- |
| `live`（進行中）                | `\_alive                    |                           | delegationActive` | 100%，綠色邊框 |
| `active`（已完成，進度 = 100%） | `pct >= 100 && hasPipeline` | 55%（`.done`）            |
| `stale`（30 分鐘以上無活動）    | `age > 1800s`               | 40%（`.stale`），預設折疊 |

**排序選項**（排序 `<select>`）：

- `recent`：最近活動時間（`lastTransition` DESC）
- `progress`：完成進度（`pct` DESC）
- `type`：Pipeline 類型（字母排序）

排序規則：alive session 永遠排在最上面（`aliveFirst` 優先）。

**收合模式**（`.collapsed`）：

- 隱藏標題、副標題、Meta、進度條、分組標頭
- `.sc::before { content: attr(data-pct) }` 顯示進度百分比

**操作按鈕**：

- 已完成群組：「清理」按鈕（批次刪除）
- 過期群組：可展開 + 「清理」按鈕（呼叫 `POST /api/sessions/cleanup`）

### 4.2 Dashboard 視圖（Tab 1）

雙欄佈局（`.dash-grid`，`minmax(0, 1fr) minmax(0, 1fr)`），960px 以下單欄。

**左欄（`.dash-left`）**：

#### 4.2.1 Agent 狀態面板（`AgentStatus`）

14 個 agents，分 3 群組（系統 3 + Pipeline 9 + 輔助 2）：

| 群組     | Agents                                                                                      |
| -------- | ------------------------------------------------------------------------------------------- |
| 系統     | Main Agent（🎯），Explore（🔭），Plan（📐）                                                 |
| PIPELINE | planner, architect, designer, developer, code-reviewer, tester, qa, e2e-runner, doc-updater |
| 輔助     | security-reviewer（🛡️），build-error-resolver（🔧）                                         |

Grid 7 欄（`.agent-row`）：`16px 140px 68px 54px 64px 1fr 44px`（燈號 + 名稱 + 職責 + model + 狀態 + chips + 時長）

**8 種燈號狀態（`.al`）**：

| 狀態         | CSS 類別         | 視覺                                           |
| ------------ | ---------------- | ---------------------------------------------- |
| `running`    | `.al.running`    | green 脈衝（`alPulse 1.5s`）                   |
| `completed`  | `.al.completed`  | green 靜態                                     |
| `error`      | `.al.error`      | red 脈衝                                       |
| `delegating` | `.al.delegating` | purple 脈衝                                    |
| `waiting`    | `.al.waiting`    | yellow 脈衝                                    |
| `standby`    | `.al.standby`    | blue 空心圓（`border: 2px solid var(--blue)`） |
| `pending`    | `.al.pending`    | surface2 慢脈衝（`3s`）                        |
| `idle`       | `.al.idle`       | surface2 半透明（`opacity: 0.5`）              |

**統計列**：活躍數 / 完成數 / 總耗時 / 總 agents 數

**技術細節（`getAgentInfo`）**：

- Main Agent：依 `alive`（heartbeat）+ `delegationActive` 判斷
- Sub-agents：從 `delegation.start` timeline 事件偵測當前運行狀態
- Pipeline agents：從 `stageResults` 取得 completed/failed 結果
- Support agents：從 timeline 事件偵測是否曾被委派

#### 4.2.2 MCP 統計面板（`MCPStats`）

從 timeline `tool.used` 事件解析 `server:method` 格式，按 server 分組顯示：

- Server 名稱（cyan）+ 呼叫次數 + 比例條（相對最大值）+ 前 4 個方法名稱
- 無 MCP 呼叫時不渲染

#### 4.2.3 Pipeline 進度面板

條件顯示（有 pipeline 且未完成）：

- 每個 stage 一行：燈號 + emoji + stage ID + 中文標籤 + verdict 文字
- 燈號顏色：pass=green, fail/active=red, skipped=surface2

#### 4.2.4 完成摘要（雙 Card）

條件顯示（`isComplete && hasPipeline`）：

- 左 Card：Pipeline 類型、階段總數、總重試次數、已跳過階段、經過時間
- 右 Card：每個 stage 的耗時（秒）+ 工具呼叫次數

**右欄（`.dash-right`）**：里程碑事件流（「最近事件」）

只顯示以下事件類型（過濾 `tool.used` 噪音）：

```js
const MILESTONE_TYPES = [
  "delegation.start",
  "delegation.end",
  "stage.start",
  "stage.complete",
  "stage.retry",
  "pipeline.init",
  "pipeline.classified",
  "pipeline.complete",
  "pipeline.cancelled",
  "block.prevented",
  "ask.question",
  "ask.answered",
  "session.start",
];
```

> ⚠️ **已知問題**：`MILESTONE_TYPES` 包含 4 個在 `schema.js` 中不存在的事件類型，屬於歷史殘留（dead filter 條目）：
>
> - `delegation.end`（schema.js 只有 `delegation.start`，無 end 事件）
> - `pipeline.init`（schema.js 中不存在，分類事件為 `task.classified`）
> - `pipeline.classified`（schema.js 中不存在，應為 `task.classified`）
> - `block.prevented`（schema.js 中不存在，工具阻擋事件為 `tool.blocked`）
>
> 這 4 個類型永遠不會匹配到任何實際 timeline 事件，需要在 `index.html` 中修正對齊 `schema.js`。

### 4.3 Pipeline 視圖（Tab 2）

**v5.0.5 重設計**：Pipeline Tab 改為 SVG+HTML 混合 DAG 流程圖，取代原 Snake Grid + Pixel Office 雙模式。移除工具列像素主題按鈕。

#### 4.3.1 DAG 流程圖（`DagView`）

**DAG 佈局演算法（`computeDagLayout`）**：

- 拓撲排序：計算各 stage 最長路徑深度（`depth`），同深度垂直排列
- 節點尺寸：88×72px，水平間距 40px，垂直間距 20px
- SVG 貝茲曲線（`buildEdges`）：連接各 stage（`M x1,y1 C cx,y1 cx,y2 x2,y2`）

**DAG 節點狀態（`.dag-node`）**：

| 狀態        | CSS 類別              | 視覺                        |
| ----------- | --------------------- | --------------------------- |
| `completed` | `.dag-node.completed` | green 邊框                  |
| `active`    | `.dag-node.active`    | blue 邊框 + `dagPulse` 動畫 |
| `failed`    | `.dag-node.failed`    | red 邊框 + `dagShake` 動畫  |
| `skipped`   | `.dag-node.skipped`   | 半透明 dashed 邊框          |
| `pending`   | `.dag-node.pending`   | opacity 0.5                 |
| selected    | `.dag-node.selected`  | yellow 邊框                 |

**邊連線狀態（`.dag-edge`）**：

- `completed`：green 實線
- `active`：blue 虛線 + `dashFlow` 流動動畫
- `pending`：surface2 虛線

**Phase 分組框**（suffixed stages 如 `DEV:1`/`REVIEW:1`）：藍色半透明分組框 + 「Phase N」標題。

**節點點擊展開詳情（`.dag-detail`）**：verdict/耗時/重試次數/crash 數/重試歷史。

**Barrier 並行進度條（`BarrierDisplay`）**（條件顯示）：

- 每個 group：group ID + 完成計數（X/N）+ sibling stage 圖示（✅/❌/⏳）+ next stage 或「完成」標籤
- 未解決時「等待中...」黃色閃爍

### 4.4 Timeline 視圖（Tab 3）

**分類 Tab（`.tl-tab`）**：

| Tab      | 值         | 說明                                                 |
| -------- | ---------- | ---------------------------------------------------- |
| 全部     | `all`      | 所有事件                                             |
| 工具     | `agent`    | `cat === 'agent'`（`tool.used`、`delegation.start`） |
| Pipeline | `pipeline` | `cat === 'pipeline'`（stage/pipeline/barrier 事件）  |
| 品質     | `quality`  | `cat === 'quality'`（lint/format/blocked/guarded）   |
| 任務     | `task`     | `cat === 'task'`（ask/compact/say/turn.summary）     |

**時間 Chip（`.tl-chip`）**：全部 / 10m / 30m / 1h（時間窗篩選）

**事件列格式（`.tl-item`）**：

- 時間戳（`hh:mm:ss`，9px，`var(--overlay0)`）
- emoji + 事件描述文字（`formatEventText` 統一格式化）
- 色彩：pass=green, fail=red, active=blue（預設）

**前端事件上限**：200 筆（`[...list].slice(0, 200)`）

---

## 5. 互動規格

### 5.1 鍵盤快捷鍵

在 `window.addEventListener('keydown')` 處理（input/select 元素內不觸發，`metaKey/ctrlKey` 不觸發）：

| 快捷鍵    | 動作                                                             |
| --------- | ---------------------------------------------------------------- |
| `↑` / `k` | 選取上一個 session                                               |
| `↓` / `j` | 選取下一個 session                                               |
| `s` / `S` | 切換側邊欄展開/收合                                              |
| `f` / `F` | 切換全螢幕模式                                                   |
| `t` / `T` | 切換至 Timeline Tab                                              |
| `p` / `P` | 切換 default/pixel 主題                                          |
| `c` / `C` | 切換卡片聚焦模式                                                 |
| `1`       | 切換至 Dashboard Tab                                             |
| `2`       | 切換至 Pipeline Tab                                              |
| `3`       | 切換至 Timeline Tab                                              |
| `e` / `E` | 導出當前 session 報告（Markdown）                                |
| `?`       | 顯示快捷鍵提示 Toast（注意：提示內容不完整，缺少部分快捷鍵說明） |

縮放快捷鍵（攔截避免影響 VSCode）：

- `⌘+` / `⌘=`：放大 10%（上限 200%）
- `⌘-`：縮小 10%（下限 50%）
- `⌘0`：重設 100%

### 5.2 Session 自動跟隨

`useEffect` 監聽 `mergedSessions` + `liveSessions` 變化：

1. 找到 `_alive || delegationActive` 的 live session
2. 若該 session 不是當前選取的 → 自動切換
3. 若當前 active 消失 → 選最近的（live > done > 任意）

### 5.3 主題

v5.0.5 起移除 Pixel 主題（Pixel Office 視圖廢棄），工具列不再有「🎮 像素」按鈕，鍵盤 `P` 快捷鍵亦移除。

Dashboard 固定使用 Catppuccin Mocha 色彩系統（`:root` CSS 變數），系統等寬字體。

### 5.4 報告導出

**`exportReport(s, active, events, format)`**：

| 格式   | 檔名                  | 內容                                                              |
| ------ | --------------------- | ----------------------------------------------------------------- |
| `md`   | `pipeline-{id8}.md`   | Markdown 表格（stages）+ 前 30 筆 timeline                        |
| `json` | `pipeline-{id8}.json` | JSON（sessionId/pipelineId/progress/environment/stages/timeline） |

Blob URL 觸發下載（`a.click()`）。

### 5.5 Confetti 慶祝

條件：`progress === 100 && hasPipeline(s) && !confettiShown.current.has(active)`（每個 session 只觸發一次）

- 60 片彩紙（`.confetti-piece`），顏色使用 Catppuccin 8 色
- 隨機位置（`left: 0-100%`）、尺寸（5-12px × 3-8px）、持續時間（2.5-4.5s）
- 動畫：`confettiFall`（落下 + 旋轉 + 縮小 + 淡出）
- 4 秒後自動清除 (`setShowConfetti(false)`)
- 像素模式：彩紙為方形（`border-radius: 0`）

### 5.6 卡片聚焦模式（`.focus-cards`）

隱藏側邊欄 + 縮減主區 padding + 隱藏 summary/cards/timeline。
主要用途：在 VS Code Simple Browser 中最小化 UI 占用。

---

## 6. 視覺設計系統

### 6.1 色彩系統（Catppuccin Mocha）

`:root` 16 個 CSS 變數：

| 變數         | Hex       | 用途                       |
| ------------ | --------- | -------------------------- |
| `--bg`       | `#1e1e2e` | 主背景                     |
| `--surface0` | `#313244` | 卡片/面板背景              |
| `--surface1` | `#45475a` | 邊框/分隔線                |
| `--surface2` | `#585b70` | 禁用態/次要邊框            |
| `--overlay0` | `#6c7086` | 更次要文字/時間戳          |
| `--text`     | `#cdd6f4` | 主要文字                   |
| `--subtext0` | `#a6adc8` | 次要標籤                   |
| `--subtext1` | `#bac2de` | 次要文字                   |
| `--blue`     | `#89b4fa` | 連結/active 狀態/Tab 選取  |
| `--green`    | `#a6e3a1` | PASS/完成/連線             |
| `--red`      | `#f38ba8` | FAIL/錯誤/危險             |
| `--yellow`   | `#f9e2af` | 等待/開發階段              |
| `--purple`   | `#cba6f7` | planner/doc-updater/委派   |
| `--cyan`     | `#89dceb` | architect/MCP server       |
| `--pink`     | `#f5c2e7` | tester                     |
| `--orange`   | `#fab387` | retry/build-error-resolver |

### 6.2 動畫系統

前端定義 18+ CSS keyframe 動畫：

| 動畫名稱       | 用途                                                       | 參數                                  |
| -------------- | ---------------------------------------------------------- | ------------------------------------- |
| `cardPulse`    | AgentCard active 狀態脈衝                                  | 2s ease-in-out infinite               |
| `livePulse`    | Session card live 綠點                                     | 2s ease infinite                      |
| `alPulse`      | Agent 燈號脈衝（running/error/delegating/waiting/pending） | 1.5~3s ease infinite                  |
| `arrowFlowR/L` | 連接箭頭流動                                               | 1.2s ease-in-out infinite             |
| `turnFlow`     | 轉角 ↓ 流動                                                | 1.2s ease-in-out infinite             |
| `bounce`       | AgentCard active emoji 跳動                                | 1s ease infinite                      |
| `todoPulse`    | Todo 項目 active 點脈衝                                    | 1.5s ease infinite                    |
| `shimmer`      | 完成進度條光澤                                             | 2s linear infinite                    |
| `slideIn`      | Timeline 事件進場                                          | 0.3s ease（一次性）                   |
| `cardEnter`    | AgentCard 入場                                             | 0.5s ease-out backwards（交錯 delay） |
| `pixelPulse`   | 像素模式 active 邊框閃爍                                   | 1s steps(2) infinite                  |
| `wsTyping`     | 像素工位打字搖動                                           | 0.3s steps(2) infinite                |
| `wsCelebrate`  | 像素工位完成跳動                                           | 0.8s steps(2) infinite                |
| `wsFrustrated` | 像素工位失敗搖晃                                           | 0.3s steps(2) infinite                |
| `wsParty`      | 全部完成歡呼                                               | 1.2s ease-in-out infinite             |
| `confettiFall` | 彩紙下落                                                   | 2.5-4.5s ease-out forwards            |
| `maWalk`       | Main Agent 行走                                            | 0.4s steps(2) infinite                |
| `wsIdle`       | Main Agent / next 工位呼吸                                 | 2s steps(2) infinite                  |

### 6.3 像素角色系統

8 個 pipeline agent 各有獨立像素網格（`CHARS`，7×10 字元網格），透過 `charShadow()` 函式轉換為 CSS `box-shadow` 多值。

字元映射：

- `S` = 膚色（`SK = '#ffd8b4'`）
- `E` = 眼睛（`EY = '#222'`，可被 EXPR_PAL 覆蓋）
- `M` = 嘴巴（`MO = '#c47a5a'`，可被 EXPR_PAL 覆蓋）
- `L` = 腿（`LG = '#445'`）
- `B` = 衣服（各角色不同）
- `A` = 手臂（各角色不同）
- `P/H/X/G/C/O/W` = 各角色特色配件

表情覆蓋（`EXPR_PAL`）依狀態改變 E（眼睛）和 M（嘴巴）顏色：

- `active`：正常眼 `#222` + 嘴 `#c47a5a`
- `pass`：眼 `#ffd8b4`（瞇眼）+ 嘴 `#e88a6a`
- `fail`：眼 `#ff4444`（紅眼）+ 嘴 `#333`
- `skipped`：眼嘴膚腿全部灰化

**缺口**：DESIGN 階段（designer agent）無對應工位 — `CHARS` 中沒有 `designer` 的像素定義。

### 6.4 響應式斷點

| 寬度       | 佈局變化                                                                      |
| ---------- | ----------------------------------------------------------------------------- |
| `≤ 1100px` | Agent Grid 縮減欄寬；Snake Grid 改為 3 欄；隱藏箭頭；像素辦公室 ws 縮窄 100px |
| `≤ 960px`  | Dashboard 雙欄改單欄（`.dash-grid`）                                          |
| `≤ 800px`  | Agent Grid 隱藏 extra chips（`agent-extra`）                                  |
| `≤ 700px`  | 整體單欄佈局，Sidebar 改橫向滾動，Snake Grid 改 1 欄，像素辦公室箭頭隱藏      |

---

## 7. 元件樹

```
App
├── Confetti（60 片彩紙，條件渲染，`.confetti-wrap` + `.confetti-piece × 60`）
├── kbd-toast（鍵盤快捷鍵提示，2s 後消失）
├── Sidebar
│   ├── sb-toggle（展開/收合按鈕）
│   ├── filter-bar（排序 select）
│   ├── [group: 進行中] Session cards
│   ├── [group: 已完成] Session cards + cleanup-btn
│   └── [group: 過期] stale-toggle + Session cards（折疊）
└── Main
    ├── [heartbeatOnly] 對話中狀態 + Timeline 列表
    └── [hasPipeline]
        ├── h1（Session ID + 工具列）
        │   └── toolbar（像素/聚焦/全螢幕/MD/JSON/縮放/連線燈號）
        ├── main-tabs（Dashboard/Pipeline/Timeline）
        │
        ├── [Tab: dashboard]
        │   ├── dash-left
        │   │   ├── AgentStatus（14 agents, 3 群組）
        │   │   │   └── agent-row × 14
        │   │   ├── MCPStats（條件渲染）
        │   │   ├── [未完成] Pipeline 進度面板（燈號列表）
        │   │   └── [完成] 雙 Card（完成摘要 + 各階段耗時）
        │   └── dash-right
        │       └── mini-tl（里程碑事件流）
        │
        ├── [Tab: pipeline]
        │   ├── BarrierDisplay（條件渲染，有 barrier 時）
        │   └── DagView（SVG+HTML DAG 流程圖）
        │       ├── dag-svg（SVG 連線）
        │       ├── dag-node × N（各 stage 節點）
        │       ├── dag-phase × M（Phase 分組框，suffixed stages 時）
        │       └── dag-detail（點擊節點展開詳情）
        │
        └── [Tab: timeline]
            ├── tl-tabs（all/agent/pipeline/quality/task）
            ├── tl-filter（時間 chips + 清除按鈕）
            └── tl-items（事件列表，上限 200 筆）
```

---

## 8. 效能與限制

### 8.1 效能設計

| 機制              | 參數                                     | 說明                                      |
| ----------------- | ---------------------------------------- | ----------------------------------------- |
| File Watcher 防抖 | pipeline/barrier: 80ms，heartbeat: 500ms | 避免高頻寫入觸發過多廣播                  |
| Timeline 前端上限 | 200 筆                                   | 新事件插前端，`slice(0, 200)` 截斷        |
| Timeline 後端上限 | 2000 筆（`MAX_EVENTS`）                  | JSONL 檔案大小控制                        |
| WebSocket 重連    | 指數退避，上限 5s                        | 避免伺服器重啟後大量重連                  |
| 每秒 tick         | `setInterval(1s)`                        | 驅動 elapsed 更新 + timeline 時間篩選重算 |
| MCP 統計快取      | `useMemo([events])`                      | 避免每 tick 重算                          |
| Session 合併      | `useMemo([sessions, alive])`             | 合併 heartbeat 狀態                       |

### 8.2 已知限制

1. **Session 自動清理**：空 session（無 DAG 無分類）超過 30 分鐘才清理；display-worthy session 不自動清理
2. **Timeline Consumer 啟動時機**：新 session 在 pipeline-state 首次被偵測時啟動，可能遺漏分類前的早期事件
3. **stale 判斷（v5.0.5 已修復）**：`server.js` 現統一使用 30 分鐘（`STALE_THRESHOLD_MS`），與 sidebar 分組一致
4. **AGENT_EMOJI 重複（v5.0.5 已修復）**：`server.js` 現動態從 `registry.js` 建構，不再硬編碼
5. **前端 SM 物件（v5.0.5 已移除）**：新 Dashboard 透過 `/api/registry` 取得 stage metadata，無 `SM` 物件
6. **DESIGN stage Pixel 工位（已移除）**：Pixel Office 視圖廢棄，此問題不再存在
7. **skill 使用狀態顯示**：新 AgentStatus 面板不顯示 skill chip，此問題不再適用

### 8.3 效能建議

- 100+ sessions 時 sidebar 可能有 DOM 效能問題（Preact 未做虛擬列表）
- 高頻 `tool.used` 事件仍會發送到前端（WebSocket），只是 Dashboard Tab 的里程碑過濾掉，Timeline Tab 會全部顯示
