# vibe — 統一開發工作流 Plugin

> **版本**：1.0.4
> **定位**：全方位開發工作流 — 規劃、品質守衛、知識庫、即時監控、遠端控制
> **架構**：6 個功能模組合併為單一 plugin，共用 registry.js 統一 metadata

---

## 1. 概述

vibe 是 Vibe marketplace 的核心 plugin，合併了 6 個功能模組：

| 模組 | 定位 | 組件概要 |
|------|------|---------|
| **Flow** | 開發工作流 + Pipeline 管理 | 6S + 3A + 9H |
| **Sentinel** | 品質全鏈守衛 | 9S + 6A + 5H |
| **Patterns** | 語言/框架模式庫 | 8S |
| **Evolve** | 知識進化 + 文件同步 | 2S + 1A |
| **Dashboard** | Pipeline 即時儀表板 | 1S + 1H |
| **Remote** | Telegram 遠端控制 | 2S + 5H + 1 Daemon |

**合計**：29 Skills + 10 Agents + 20 Hooks + 30 Scripts

### 設計原則

- **先想清楚再寫碼**（Flow）— Pipeline 引導每一步
- **寫完就檢查**（Sentinel）— 問題不過夜
- **Claude 知道越多，寫越好**（Patterns）— 純知識注入
- **文件是程式碼的影子**（Evolve）— 自動同步
- **離開電腦也能掌控**（Remote）— 遊戲外掛模式

### 與外部 plugin 的關係

- **forge**：獨立 plugin（造工具的工具），不在 vibe 內
- **claude-mem**：獨立 plugin（記憶持久化），推薦搭配但非依賴
- **collab**：尚未實作，設計見 [collab.md](collab.md)

---

## 2. 完整組件清單

### Skills（28 個）

| # | 名稱 | 模組 | 說明 |
|:-:|------|:----:|------|
| 1 | `plan` | Flow | 功能規劃 — 需求分析 + 分階段計畫 |
| 2 | `architect` | Flow | 架構設計 — 程式碼庫分析 + 多方案比較 |
| 3 | `context-status` | Flow | Context 狀態查詢 — 使用量追蹤 + 壓縮建議 |
| 4 | `checkpoint` | Flow | 工作檢查點 — 建立/列出/恢復 |
| 5 | `env-detect` | Flow | 環境偵測 — 語言/框架/PM/工具 |
| 6 | `cancel` | Flow | 取消鎖定 — 解除 task-guard + 退出 pipeline 模式 |
| 7 | `review` | Sentinel | 程式碼審查 — 按嚴重程度排序 |
| 8 | `lint` | Sentinel | 靜態分析 — ESLint / Ruff / golangci-lint |
| 9 | `format` | Sentinel | 格式化 — Prettier / Ruff format / gofmt |
| 10 | `security` | Sentinel | 安全掃描 — OWASP Top 10 + secret 偵測 |
| 11 | `tdd` | Sentinel | TDD 工作流 — RED → GREEN → REFACTOR |
| 12 | `e2e` | Sentinel | E2E 測試 — agent-browser CLI |
| 13 | `qa` | Sentinel | 行為測試 — API/CLI/服務驗證 |
| 14 | `coverage` | Sentinel | 覆蓋率分析 — 目標 80%，關鍵路徑 100% |
| 15 | `verify` | Sentinel | 綜合驗證 — Build → Types → Lint → Tests → Git |
| 16 | `coding-standards` | Patterns | 通用編碼標準 |
| 17 | `frontend-patterns` | Patterns | 前端模式（React/Next.js/Vue） |
| 18 | `backend-patterns` | Patterns | 後端模式（API/middleware/ORM） |
| 19 | `db-patterns` | Patterns | 資料庫模式（PostgreSQL/Redis） |
| 20 | `typescript-patterns` | Patterns | TypeScript 進階模式 |
| 21 | `python-patterns` | Patterns | Python 進階模式 |
| 22 | `go-patterns` | Patterns | Go 進階模式 |
| 23 | `testing-patterns` | Patterns | 測試模式（unit/integration/e2e） |
| 24 | `evolve` | Evolve | 知識進化 — instincts 聚類 → skill/agent |
| 25 | `doc-sync` | Evolve | 文件同步 — 偵測過時 + 自動更新 |
| 26 | `dashboard` | Dashboard | 儀表板控制 — start/stop/status/open |
| 27 | `remote` | Remote | 遠端控制 — daemon 生命週期管理 |
| 28 | `remote-config` | Remote | 遠端設定教學 — Bot 建立 + 驗證 |
| 29 | `hook-diag` | 診斷 | Hook 錯誤診斷 — 查看/分析/清除 error log |

### Agents（10 個）

| # | 名稱 | 模組 | Model | 權限 | 色彩 | 說明 |
|:-:|------|:----:|:-----:|:----:|:----:|------|
| 1 | `planner` | Flow | opus | plan | purple | 需求分析 + 分階段計畫 |
| 2 | `architect` | Flow | opus | plan | cyan | 架構方案 + 介面設計 |
| 3 | `developer` | Flow | sonnet | acceptEdits | yellow | 按計畫實作 + 寫測試 |
| 4 | `code-reviewer` | Sentinel | opus | plan | blue | CRITICAL→LOW 品質報告 |
| 5 | `security-reviewer` | Sentinel | opus | plan | red | OWASP Top 10 安全報告 |
| 6 | `tester` | Sentinel | sonnet | acceptEdits | pink | 獨立測試視角 |
| 7 | `build-error-resolver` | Sentinel | haiku | acceptEdits | orange | 最小修復（最多 3 輪，maxTurns 15） |
| 8 | `e2e-runner` | Sentinel | sonnet | acceptEdits | green | UI/API 雙模式 E2E |
| 9 | `qa` | Sentinel | sonnet | acceptEdits | yellow | API/CLI 行為驗證 |
| 10 | `doc-updater` | Evolve | haiku | acceptEdits | purple | 程式碼變更 → 文件更新 |

### Hooks（20 個）

| # | 事件 | 名稱 | 模組 | 類型 | 強度 | 說明 |
|:-:|------|------|:----:|:----:|:----:|------|
| 1 | SessionStart | pipeline-init | Flow | command | — | 環境偵測 + state file 初始化 |
| 2 | SessionStart | dashboard-autostart | Dashboard | command | — | 自動啟動 WebSocket server |
| 3 | SessionStart | remote-autostart | Remote | command | — | 自動啟動 bot daemon |
| 4 | UserPromptSubmit | task-classifier | Flow | command | 軟→強 | 任務分類 + pipeline 階段注入 |
| 5 | UserPromptSubmit | remote-prompt-forward | Remote | command | — | 使用者輸入轉發 Telegram |
| 6 | PreToolUse(Task) | delegation-tracker | Flow | command | — | 標記 delegationActive |
| 7 | PreToolUse(W\|E) | dev-gate | Flow | command | 硬阻擋 | 阻擋 Main Agent 直寫碼 |
| 8 | PreToolUse(*) | suggest-compact | Flow | command | 軟建議 | 50 calls 建議 compact |
| 9 | PreToolUse(Bash) | danger-guard | Sentinel | command | 硬阻擋 | 攔截 rm -rf、DROP TABLE 等 |
| 10 | PreToolUse(Ask) | remote-ask-intercept | Remote | command | — | AskUserQuestion → inline keyboard |
| 11 | PostToolUse(W\|E) | auto-lint | Sentinel | command | 強建議 | 自動 lint + systemMessage |
| 12 | PostToolUse(W\|E) | auto-format | Sentinel | command | — | 自動格式化（靜默） |
| 13 | PostToolUse(W\|E) | test-check | Sentinel | prompt/haiku | 軟建議 | 商業邏輯修改 → 提醒跑測試 |
| 14 | PreCompact | log-compact | Flow | command | — | 記錄 compact + 重設計數 |
| 15 | SubagentStop | stage-transition | Flow | command | 強建議 | 判斷下一步（前進/回退/跳過） |
| 16 | SubagentStop | remote-sender | Remote | command | — | Pipeline stage 完成 → Telegram |
| 17 | Stop | pipeline-check | Flow | command | 強建議 | 結束前檢查遺漏階段 |
| 18 | Stop | task-guard | Flow | command | 硬阻擋 | 未完成任務時 block 退出 |
| 19 | Stop | check-console-log | Sentinel | command | 強建議 | 偵測殘留 console.log/debugger |
| 20 | Stop | remote-receipt | Remote | command | — | /say 已讀回條 + 回合摘要 |

### Scripts（30 個）

**Hook 腳本（19 個）** — `scripts/hooks/`

| 名稱 | 模組 | 對應 Hook # |
|------|:----:|:----------:|
| pipeline-init.js | Flow | 1 |
| task-classifier.js | Flow | 4 |
| delegation-tracker.js | Flow | 6 |
| dev-gate.js | Flow | 7 |
| suggest-compact.js | Flow | 8 |
| log-compact.js | Flow | 14 |
| stage-transition.js | Flow | 15 |
| pipeline-check.js | Flow | 17 |
| task-guard.js | Flow | 18 |
| auto-lint.js | Sentinel | 11 |
| auto-format.js | Sentinel | 12 |
| danger-guard.js | Sentinel | 9 |
| check-console-log.js | Sentinel | 19 |
| dashboard-autostart.js | Dashboard | 2 |
| remote-autostart.js | Remote | 3 |
| remote-prompt-forward.js | Remote | 5 |
| remote-ask-intercept.js | Remote | 10 |
| remote-sender.js | Remote | 16 |
| remote-receipt.js | Remote | 20 |

**共用函式庫（11 個）** — `scripts/lib/`

| 名稱 | 子目錄 | 說明 |
|------|--------|------|
| registry.js | （根） | 全域 metadata — STAGES/AGENTS/EMOJI |
| hook-logger.js | （根） | Hook 錯誤日誌 — 寫入 ~/.claude/hook-errors.log |
| env-detector.js | flow/ | 環境偵測（語言/框架/PM/工具） |
| counter.js | flow/ | tool call 計數器 |
| pipeline-discovery.js | flow/ | 跨 plugin pipeline 動態發現 |
| lang-map.js | sentinel/ | 副檔名→語言→工具映射 |
| tool-detector.js | sentinel/ | 偵測已安裝工具 + 快取 |
| server-manager.js | dashboard/ | Dashboard server 生命週期 |
| telegram.js | remote/ | Telegram Bot API 封裝 |
| transcript.js | remote/ | Transcript JSONL 解析 |
| bot-manager.js | remote/ | Bot daemon 生命週期 |

---

## 3. Flow 模組 — 開發工作流

### 核心理念

先想清楚再寫碼，Pipeline 引導每一步。

### Pipeline 8 階段

```
PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E → DOCS
```

詳見 → [pipeline.md](pipeline.md)

### Skills 設計

#### plan — 功能規劃

推斷技術棧 → planner agent 分析 → 展示分階段計畫 → 確認範圍 → 執行。
產出：摘要 + 階段分解 + 風險摘要 + 依賴圖。

#### architect — 架構設計

掃描結構 → architect agent 分析 → 展示多方案（目錄樹 + 介面 + 資料流）→ 使用者選擇。

#### context-status — Context 狀態查詢

50 calls 閾值，每 25 calls 提醒，在邏輯邊界建議（不阻擋）。

#### checkpoint — 工作檢查點

建立（`git stash create` / `git commit` + metadata）→ 列出 → 恢復（預覽 → 確認 → apply）。

#### env-detect — 環境偵測

偵測順序（PM）：env var → 專案設定 → package.json → lock file → 全域設定 → fallback。

#### cancel — 取消鎖定 + 退出 pipeline

處理兩種鎖定：(1) task-guard：設定 `cancelled: true` → 放行結束；(2) pipeline：重設 `pipelineEnforced=false` + `delegationActive=false` → 允許直接 Write/Edit。
使用場景：task-classifier 誤分類、Claude 卡住、中途切換手動模式。

### Agents 設計

**planner**（opus, plan, purple）— 理解需求 → 掃描專案 → 識別影響 → 拆解階段 → 評估風險 → 產出計畫。

**architect**（opus, plan, cyan）— 掃描結構 → 分析慣例 → 識別邊界 → 設計 2-3 方案 → 產出目錄樹+介面+資料流。

**developer**（sonnet, acceptEdits, yellow）— 載入 PATTERNS → 按階段實作 → 寫測試 → 自動 hooks 介入。遵循 architect 方案，不自行發明架構。

### Hooks 設計

#### task-classifier（UserPromptSubmit）

**漸進式升級**：keyword heuristic 分類（7 類型），初始為 `additionalContext`（軟），升級為 `systemMessage`（強）。

**分類順序**（先匹配先贏）：research → **trivial** → tdd → test → refactor → feature → quickfix → bugfix → default quickfix。

**Trivial 偵測**（v1.0.4）：hello world、poc、prototype、scaffold、boilerplate、練習用等明確簡單任務 → `quickfix`，不觸發完整 pipeline。

**任務類型優先級**（由低到高）：

| 優先級 | 類型 | 啟動階段 |
|:------:|------|---------|
| 0 | research | — |
| 1 | quickfix | DEV |
| 2 | test | TEST |
| 3 | bugfix | DEV → TEST |
| 4 | refactor | ARCH → DEV → REVIEW |
| 5 | tdd | TEST → DEV → REVIEW |
| 6 | feature | PLAN → ... → DOCS |

**升級機制**：新分類優先級 > 當前 → 觸發升級（注入 systemMessage + 跳過已完成階段）。降級靜默忽略。

#### pipeline-init（SessionStart）

偵測環境 + 初始化 state file。防重複：state file 已存在 `initialized: true` 時 exit 0。

#### delegation-tracker（PreToolUse:Task）

Task 呼叫時標記 `delegationActive=true`，讓 sub-agent 通過 dev-gate。

#### dev-gate（PreToolUse:Write|Edit）

Pipeline 模式下阻擋 Main Agent 直接 Write/Edit。雙層防禦：`systemMessage` ⛔ + `exit 2` 硬阻擋。`delegationActive=true` 時放行。

#### suggest-compact（PreToolUse:*）

追蹤所有 tool calls，50 次 → 建議 compact，每 25 次提醒。透過 `systemMessage` 注入建議（v1.0.3 修正：原用 stderr 導致 "hook error" 顯示）。

#### stage-transition（SubagentStop）

Agent 完成後判斷下一步：

1. `stop_hook_active === true` → exit 0（防迴圈）
2. `discoverPipeline()` 載入配置
3. `agentToStage[agent_type]` 查找所屬 stage
4. `parseVerdict()` 從 transcript 解析 PIPELINE_VERDICT
5. `shouldRetryStage()` 判斷是否回退
6. 更新 state file + systemMessage 指示下一步

**智慧回退**：FAIL:CRITICAL 或 FAIL:HIGH → 回到 DEV 修復 → 重試（每階段獨立 3 輪上限）。

**智慧跳過**：純 API 框架自動跳過 E2E 瀏覽器測試。

#### pipeline-check（Stop）

結束前檢查遺漏階段，透過 systemMessage 提醒。

#### task-guard（Stop）

讀取 transcript 中最後一次 TodoWrite，檢查未完成任務。`decision: "block"` 阻止退出。安全閥：5 次阻擋後強制放行。`/vibe:cancel` 可手動解除。

---

## 4. Sentinel 模組 — 品質全鏈

### 核心理念

寫完就檢查，測完就確認，問題不過夜。

### Skills 設計

#### review — 程式碼審查

CRITICAL → HIGH → MEDIUM → LOW 按嚴重程度排序。涵蓋安全、邏輯、效能、命名。

#### lint / format — 靜態分析與格式化

| 語言 | Linter | Formatter |
|------|--------|-----------|
| TypeScript/JavaScript | ESLint | Prettier |
| Python | Ruff | Ruff format |
| Go | golangci-lint | gofmt/goimports |
| CSS/SCSS | Stylelint | Prettier |

#### security — 安全掃描

OWASP Top 10：注入、認證、資料曝露、設定、依賴 CVE。

#### tdd — TDD 工作流

RED（寫失敗的測試 → 必須 FAIL）→ GREEN（最小實作 → 必須 PASS）→ REFACTOR（改善 → 仍 PASS）。

#### e2e — E2E 測試

工具：[agent-browser](https://github.com/vercel-labs/agent-browser)（Playwright 上的 AI 友善 CLI）。
工作流：`open` → `snapshot -i` → 操作（ref） → `snapshot` 驗證 → `close`。

#### qa — 行為測試

啟動 app → 健康檢查 → API/CLI 操作 → 驗證結果。不寫測試碼，不做瀏覽器 UI 測試。

#### coverage — 覆蓋率分析

整體 80%、關鍵路徑 100%、工具函式 90%、UI 元件 60%。

#### verify — 綜合驗證

Build → Types → Lint → Tests → console.log → Git。任一步驟失敗即停止。

### Agents 設計

**code-reviewer**（opus, plan, blue）— 全面品質審查，產出 CRITICAL→LOW 結構化報告。

**security-reviewer**（opus, plan, red）— OWASP Top 10 檢測 + 資料流追蹤 + 攻擊場景 + 修復建議。

**tester**（sonnet, acceptEdits, pink）— 獨立測試視角。不看 developer 的測試理由，從規格和行為獨立推斷。

**build-error-resolver**（haiku, acceptEdits, orange）— 最小修復，不重構不優化。maxTurns 15，最多 3 輪。

**e2e-runner**（sonnet, acceptEdits, green）— UI 模式（agent-browser）/ API 模式（curl）。自動根據專案類型選擇。frontmatter `skills: [agent-browser]`。

**qa**（sonnet, acceptEdits, yellow）— 啟動應用 → API/CLI 操作 → 驗證行為。不寫測試碼，不做瀏覽器 UI。

### PIPELINE_VERDICT 協議

品質 agents 在報告末尾必須輸出結論標記：

```
<!-- PIPELINE_VERDICT: PASS|FAIL:CRITICAL|FAIL:HIGH|FAIL:MEDIUM|FAIL:LOW -->
```

| Agent | PASS 條件 | FAIL 標記 |
|-------|----------|-----------|
| code-reviewer | 無 CRITICAL/HIGH | FAIL:CRITICAL 或 FAIL:HIGH |
| tester | 全部測試通過 | FAIL:HIGH |
| qa | 全部場景通過 | FAIL:HIGH |
| e2e-runner | 全部流程通過 | FAIL:HIGH |

FAIL:MEDIUM/LOW 不觸發回退，僅供參考。

### 品質 Agents 分工

| Agent | 負責層 | 做什麼 | 不做什麼 |
|-------|--------|--------|---------|
| tester | 測試碼 | 撰寫 unit/integration 測試 | 不啟動 app |
| e2e-runner | 跨步驟 | 複合流程、資料一致性 | 不重複 QA |
| qa | API/CLI | 啟動 app、呼叫 API | 不寫測試碼 |

### Hooks 設計

#### auto-lint（PostToolUse:Write|Edit）

偵測語言 → 選擇 linter → 執行 --fix → 結果透過 systemMessage 注入。強建議。

#### auto-format（PostToolUse:Write|Edit）

直接套用格式化，無需 Claude 決策。靜默執行。

#### test-check（PostToolUse:Write|Edit）

prompt hook（haiku），修改商業邏輯後提醒跑測試。軟建議。

#### danger-guard（PreToolUse:Bash）

regex 匹配 8 個危險模式（rm -rf /、DROP TABLE 等），exit 2 硬阻擋。

#### check-console-log（Stop）

git diff 偵測殘留 console.log/debugger，透過 systemMessage 提醒。
必須有 `stop_hook_active` 防無限迴圈。排除 `scripts/hooks/` 路徑和 `hook-logger.js`（v1.0.4 修正：hook 通訊機制的 console.log 不是 debug 殘留）。

---

## 5. Patterns 模組 — 知識庫

### 核心理念

Claude 知道的越多，寫出的程式碼越好。純知識庫，無 hooks/agents/scripts。

### 8 個 Pattern Skills

每個 skill 遵循統一格式：

```markdown
---
name: {skill-name}
description: {一句話}
---
## Quick Reference（速查表格）
## Patterns（❌ BAD / ✅ GOOD 對比）
## Checklist（審查清單）
## 常見陷阱
```

| Skill | 涵蓋範圍 |
|-------|---------|
| coding-standards | 命名規範、檔案組織、錯誤處理、不可變性 |
| frontend-patterns | React Hooks、Next.js App Router、Vue Composition API、狀態管理 |
| backend-patterns | RESTful API、Middleware、JWT/OAuth、ORM、快取 |
| db-patterns | PostgreSQL 最佳化、索引策略、Migration、Redis、N+1 |
| typescript-patterns | Utility types、Generics、Type guards、Strict mode、Zod |
| python-patterns | typing、async/await、dataclass、FastAPI/Django |
| go-patterns | Error handling、Concurrency、Interface、Table-driven tests |
| testing-patterns | 測試金字塔（70/20/10）、Mocking、Fixtures、覆蓋率目標 |

---

## 6. Evolve 模組 — 知識進化

### 核心理念

觀察由 claude-mem 處理，進化由 evolve 處理。文件是程式碼的影子。

### 與 claude-mem 的關係

```
claude-mem（底層）             evolve（上層）
┌────────────────────┐      ┌────────────────────┐
│ PostToolUse: 觀察捕獲 │      │ evolve: 聚類 → skill │
│ Stop: session 摘要   │ ←讀─ │ doc-sync: 文件同步   │
│ SessionStart: 注入   │      │ doc-updater: 自動更新│
└────────────────────┘      └────────────────────┘
```

**解耦**：evolve 不 import mem，無 mem 時從對話提取或手動輸入。

### Instinct 進化路徑

```
Observation → Instinct(0.3) → Cluster(≥3, avg≥0.7) → Skill/Agent
```

| 分數 | 狀態 | 進化目標條件 |
|:----:|------|-------------|
| 0.3 | 初始 | — |
| 0.7 | 成熟 | Skill：≥5 instincts, avg ≥ 0.7 |
| 0.9 | 可進化 | Agent：≥8 instincts, avg ≥ 0.8 |

### doc-sync 偵測範圍

| 文件類型 | 觸發條件 |
|---------|---------|
| README / API docs | 函式簽名、export、路由變更 |
| 設計文件（spec） | 架構決策、目錄結構變更 |
| CLAUDE.md / 規則 | 開發規範或慣例變更 |
| plugin 設計文件 | 組件數量、hook 事件、skill 清單變更 |

### doc-updater Agent

haiku, acceptEdits, purple。分析 git diff → 機械性變更自動套用 → 語意性變更產出建議。

---

## 7. Dashboard 模組 — 即時監控

### 架構

Bun HTTP + WebSocket server，監聽 `~/.claude/pipeline-state-*.json` 變化即時推播。

| 元件 | 說明 |
|------|------|
| server.js | HTTP + WebSocket server |
| web/index.html | 前端（自包含 HTML） |
| server-manager.js | 共用 lib — start/stop/isRunning/getState |

### 生命週期

- **PID**：`~/.claude/dashboard-server.pid`（全域，跨 session 共享）
- **Port 偵測**：`net.createConnection`（非 lsof）
- **自動啟動**：SessionStart hook → dashboard-autostart.js → port 偵測 → spawn + detached
- **自動開瀏覽器**：偵測 `TERM_PROGRAM=vscode` → VSCode Simple Browser；否則 macOS `open`
- **手動控管**：`/vibe:dashboard start|stop|status|open|restart`
- **優雅關閉**：SIGTERM → 關閉 WebSocket → 清理 PID → exit 0

---

## 8. Remote 模組 — Telegram 遠端控制

### 核心概念

遊戲外掛模式 — 讀取狀態（pipeline state files）+ 注入輸入（tmux send-keys）。Claude Code 不知道有外掛存在。

### 架構

```
Claude Code (tmux)
    ↓ SubagentStop
remote-sender.js → 讀 state → Telegram ──→ 手機
                                             ↓ /status /say
bot.js daemon ← Telegram Bot API ←────── 手機
    ├── 查詢 → 讀 state files → 回覆
    └── 控制 → tmux send-keys → Claude Code
```

### 五大功能軸

| 功能 | Hook/機制 | 說明 |
|------|----------|------|
| 推播通知 | SubagentStop: remote-sender | Stage 完成 → Telegram |
| 對話同步 | UserPromptSubmit: remote-prompt-forward | 使用者輸入轉發 |
| 回合摘要 | Stop: remote-receipt | 文字回應 + 工具統計 |
| 互動選單 | PreToolUse: remote-ask-intercept | AskUserQuestion → inline keyboard |
| 遠端控制 | bot.js daemon | /say → tmux send-keys |

### 通知格式

**Stage 完成**：
```
🔍 REVIEW ✅ 5m (feature)
  → 程式碼品質良好，無重大問題
📋✅ 🏗️✅ 💻✅ 🔍✅ 🧪⬜ ✅⬜ 🌐⬜ 📝⬜
```

**Pipeline 完成**：
```
🎉 Pipeline 完成 ✅ (feature) 26m
📋✅ 🏗️✅ 💻✅ 🔍✅ 🧪✅ ✅✅ 🌐✅ 📝✅
```

### AskUserQuestion 互動

| 模式 | Inline 按鈕 | 數字回覆 |
|------|------------|---------|
| 單選 | 按 = 選 + 確認 | `2` → 選第 2 項 |
| 多選 | toggle ☑/☐ → 確認 | `1 3` toggle → `ok` |

tmux 鍵盤操作：單選 `Down`×N + `Enter`；多選數字鍵 toggle + `Tab` + `Enter` × 2。

### Daemon 生命週期

| 面向 | 設計 |
|------|------|
| PID | `~/.claude/remote-bot.pid`（全域） |
| 存活偵測 | `process.kill(pid, 0)` |
| 啟動 | spawn detached + stdio ignore |
| 自動啟動 | SessionStart hook |
| 安全 | 只回應指定 chatId |
| 錯誤恢復 | polling 失敗 → 5s 重試 |

### 認證

環境變數（`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）優先 → `~/.claude/remote.env` fallback。
缺失時 exit 0 靜默降級。

---

## 9. 共用基礎設施

### registry.js — Single Source of Truth

```javascript
const STAGES = {
  PLAN:   { agent: 'planner',        emoji: '📋', label: '規劃',       color: 'purple' },
  ARCH:   { agent: 'architect',      emoji: '🏗️', label: '架構',       color: 'cyan' },
  DEV:    { agent: 'developer',      emoji: '💻', label: '開發',       color: 'yellow' },
  REVIEW: { agent: 'code-reviewer',  emoji: '🔍', label: '審查',       color: 'blue' },
  TEST:   { agent: 'tester',         emoji: '🧪', label: '測試',       color: 'pink' },
  QA:     { agent: 'qa',             emoji: '✅', label: '行為驗證',   color: 'yellow' },
  E2E:    { agent: 'e2e-runner',     emoji: '🌐', label: '端對端測試', color: 'green' },
  DOCS:   { agent: 'doc-updater',    emoji: '📝', label: '文件整理',   color: 'purple' },
};
```

匯出：`STAGES`、`STAGE_ORDER`、`AGENT_TO_STAGE`、`NAMESPACED_AGENT_TO_STAGE`、`TOOL_EMOJI`。

### State Files

| 檔案 | 用途 |
|------|------|
| `~/.claude/pipeline-state-{sessionId}.json` | Pipeline 階段進度 |
| `~/.claude/task-guard-state-{sessionId}.json` | task-guard 阻擋狀態 |
| `~/.claude/counter-{sessionId}.json` | tool call 計數器 |
| `~/.claude/dashboard-server.pid` | Dashboard server PID（全域） |
| `~/.claude/remote-bot.pid` | Bot daemon PID（全域） |
| `~/.claude/remote-say-pending.json` | /say 已讀回條狀態 |
| `~/.claude/remote-ask-pending.json` | AskUserQuestion 互動狀態 |
| `~/.claude/hook-errors.log` | Hook 錯誤日誌（自動截斷 500 行） |

### pipeline.json

```json
{
  "stages": ["PLAN", "ARCH", "DEV", "REVIEW", "TEST", "QA", "E2E", "DOCS"],
  "stageLabels": { ... },
  "provides": {
    "PLAN":   { "agent": "planner",        "skill": "/vibe:plan" },
    "ARCH":   { "agent": "architect",      "skill": "/vibe:architect" },
    "DEV":    { "agent": "developer",      "skill": null },
    "REVIEW": { "agent": "code-reviewer",  "skill": "/vibe:review" },
    "TEST":   { "agent": "tester",         "skill": "/vibe:tdd" },
    "QA":     { "agent": "qa",             "skill": "/vibe:qa" },
    "E2E":    { "agent": "e2e-runner",     "skill": "/vibe:e2e" },
    "DOCS":   { "agent": "doc-updater",    "skill": "/vibe:doc-sync" }
  }
}
```

---

## 10. 目錄結構

```
plugins/vibe/
├── .claude-plugin/
│   ├── plugin.json               # name: "vibe", 29 skills, 10 agents
│   └── hooks.json                # 統一 20 hooks
├── pipeline.json                 # Stage 順序 + provides
├── skills/                       # 29 個 skill 目錄
│   ├── plan/                     # Flow
│   ├── architect/                # Flow
│   ├── checkpoint/               # Flow
│   ├── context-status/           # Flow
│   ├── env-detect/               # Flow
│   ├── cancel/                   # Flow
│   ├── review/                   # Sentinel
│   ├── lint/                     # Sentinel
│   ├── format/                   # Sentinel
│   ├── security/                 # Sentinel
│   ├── tdd/                      # Sentinel
│   ├── e2e/                      # Sentinel
│   ├── qa/                       # Sentinel
│   ├── coverage/                 # Sentinel
│   ├── verify/                   # Sentinel
│   ├── coding-standards/         # Patterns
│   ├── frontend-patterns/        # Patterns
│   ├── backend-patterns/         # Patterns
│   ├── db-patterns/              # Patterns
│   ├── typescript-patterns/      # Patterns
│   ├── python-patterns/          # Patterns
│   ├── go-patterns/              # Patterns
│   ├── testing-patterns/         # Patterns
│   ├── evolve/                   # Evolve
│   ├── doc-sync/                 # Evolve
│   ├── dashboard/                # Dashboard
│   ├── remote/                   # Remote
│   ├── remote-config/            # Remote
│   └── hook-diag/                # 診斷
├── agents/                       # 10 個 agent 定義
│   ├── planner.md
│   ├── architect.md
│   ├── developer.md
│   ├── code-reviewer.md
│   ├── security-reviewer.md
│   ├── tester.md
│   ├── build-error-resolver.md
│   ├── e2e-runner.md
│   ├── qa.md
│   └── doc-updater.md
├── scripts/
│   ├── hooks/                    # 19 個 hook 腳本
│   └── lib/                      # 共用函式庫
│       ├── registry.js           # 全域 metadata
│       ├── hook-logger.js       # Hook 錯誤日誌
│       ├── flow/                 # env-detector, counter, pipeline-discovery
│       ├── sentinel/             # lang-map, tool-detector
│       ├── dashboard/            # server-manager
│       └── remote/               # telegram, transcript, bot-manager
├── server.js                     # Dashboard HTTP+WS server
├── web/
│   └── index.html                # Dashboard 前端
└── bot.js                        # Telegram daemon
```

---

## 11. plugin.json

```json
{
  "name": "vibe",
  "version": "1.0.4",
  "description": "全方位開發工作流 — 規劃、品質守衛、知識庫、即時監控、遠端控制",
  "skills": ["./skills/"],
  "agents": [
    "./agents/planner.md",
    "./agents/architect.md",
    "./agents/developer.md",
    "./agents/code-reviewer.md",
    "./agents/security-reviewer.md",
    "./agents/tester.md",
    "./agents/build-error-resolver.md",
    "./agents/e2e-runner.md",
    "./agents/qa.md",
    "./agents/doc-updater.md"
  ]
}
```
