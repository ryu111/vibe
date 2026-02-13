# Vibe — 專案規則

## 專案定位

Vibe 是 Claude Code marketplace，為全端開發者提供從規劃到部署的完整工作流。由 2 個 plugin 組成：`forge`（meta plugin builder）和 `vibe`（統一開發工作流）。

## Plugin 架構

| Plugin | 版號 | 定位 | Skills | Agents | Hooks | Scripts |
|--------|------|------|:------:|:------:|:-----:|:-------:|
| **forge** | 0.1.3 | 造工具的工具（meta plugin builder） | 4 | 0 | 0 | 7 |
| **vibe** | 1.0.2 | 全方位開發工作流 | 28 | 10 | 20 | 29+daemon |

### vibe plugin 功能模組

| 模組 | 功能 | Skills | Agents |
|------|------|:------:|:------:|
| 規劃 | Pipeline 工作流管理、規劃、架構設計 | 6 | 3 (planner/architect/developer) |
| 品質 | lint、format、review、security、TDD、E2E、QA | 9 | 6 (code-reviewer/security-reviewer/tester/build-error-resolver/e2e-runner/qa) |
| 知識 | 語言/框架模式庫（純知識） | 8 | 0 |
| 進化 | 知識進化、文件同步 | 2 | 1 (doc-updater) |
| 監控 | Pipeline 即時儀表板（WebSocket） | 1 | 0 |
| 遠端 | Telegram 遠端控制 + tmux 操作 | 2 | 0 |

### 共用 registry.js（Single Source of Truth）

`plugins/vibe/scripts/lib/registry.js` 統一定義所有 agent/stage/emoji/color 映射，消除跨模組重複。所有 hook 腳本和 bot.js 統一從此處 import。

## 設計哲學

1. **自然語言優先**：`$ARGUMENTS` 模式 — 使用者說意圖，Claude 判讀語意 + 組合執行
2. **對外介面最小化**：只暴露必要的 skill，腳本/模板/驗證全部內部化
3. **語意自動化**：automation = 語意判讀 + 組合使用，不是死板的指令路由
4. **SKILL.md 定義能力邊界和規則**，Claude 自行決定執行步驟
5. **對話即文檔**：對話中確定的方向立即歸檔，不等最後整理

## 架構原則

- **組件職責**：Plugins = 模組功能｜Agents = AI 能力｜Skills = 能力載體｜Hooks = 事件自動化｜Scripts = 內部實作
- **統一 plugin 內部模組化**：所有功能統一在 vibe plugin 內，透過 `registry.js` 共享 metadata
- **自動驗證閉環**：PostToolUse hook → 寫完就檢查，使用者無感
- **底層基礎必須正確**：所有組件都要有詳盡規格、驗證腳本

### 目錄結構

```
plugins/vibe/
├── .claude-plugin/
│   └── plugin.json          # manifest（name, version, skills, agents）
├── hooks/
│   └── hooks.json           # 統一 20 hooks（7 事件，順序明確）
├── pipeline.json            # Pipeline 階段宣告 + provides
├── scripts/
│   ├── hooks/               # 19 個 hook 腳本
│   └── lib/                 # 共用函式庫
│       ├── registry.js      # ★ 全局 metadata（STAGES/AGENTS/EMOJI）
│       ├── flow/            # pipeline-discovery, env-detector, counter
│       ├── sentinel/        # lang-map, tool-detector
│       ├── dashboard/       # server-manager
│       └── remote/          # telegram, transcript, bot-manager
├── skills/                  # 28 個 skill 目錄
├── agents/                  # 10 個 agent 定義
├── server.js                # Dashboard HTTP+WebSocket server
├── bot.js                   # Telegram daemon
├── web/index.html           # Dashboard 前端
└── tests/                   # E2E 測試
```

## Pipeline 委派架構

8 階段工作流，由 hooks 驅動（無 orchestrator agent）：

```
PLAN → ARCH → DEV → REVIEW → TEST → QA → E2E → DOCS
```

| 階段 | Agent | Model/Color | Skill |
|------|-------|-------------|-------|
| PLAN | planner | opus/purple | `/vibe:plan` |
| ARCH | architect | opus/cyan | `/vibe:architect` |
| DEV | developer | sonnet/yellow | — |
| REVIEW | code-reviewer | opus/blue | `/vibe:review` |
| TEST | tester | sonnet/pink | `/vibe:tdd` |
| QA | qa | sonnet/yellow | `/vibe:qa` |
| E2E | e2e-runner | sonnet/green | `/vibe:e2e` |
| DOCS | doc-updater | opus/purple | `/vibe:doc-sync` |

**防禦機制**：
- `task-classifier`（UserPromptSubmit）— 分類任務 + 按需注入委派規則
- `dev-gate`（PreToolUse Write|Edit）— **exit 2 硬阻擋** Main Agent 直接寫碼
- `delegation-tracker`（PreToolUse Task）— 設 `delegationActive=true` 讓 sub-agent 通過
- `stage-transition`（SubagentStop）— 指示下一階段 + 清除 delegation

## Hooks 事件全景

統一 hooks.json，20 hooks 按事件分組（順序明確）：

| 事件 | Hooks（執行順序） |
|------|------------------|
| **SessionStart** | pipeline-init → dashboard-autostart → remote-autostart |
| **UserPromptSubmit** | task-classifier → remote-prompt-forward |
| **PreToolUse(Task)** | delegation-tracker |
| **PreToolUse(Write\|Edit)** | dev-gate |
| **PreToolUse(*)** | suggest-compact |
| **PreToolUse(Bash)** | danger-guard |
| **PreToolUse(AskUserQuestion)** | remote-ask-intercept |
| **PostToolUse(Write\|Edit)** | auto-lint → auto-format → test-check(prompt/haiku) |
| **PreCompact** | log-compact |
| **SubagentStop** | stage-transition → remote-sender |
| **Stop** | pipeline-check → task-guard → check-console-log → remote-receipt |

### Hook 輸出管道

| 管道 | 可見對象 | 強度 | 用途 |
|------|---------|------|------|
| `additionalContext` | Claude | 軟建議 | 背景知識、上下文注入 |
| `systemMessage` | Claude | 強指令 | 系統級規則（顯示為 "hook error"） |
| `stderr` + exit 0 | 使用者 | 警告 | 終端提示 |
| `stderr` + exit 2 | 使用者 | **硬阻擋** | 阻止工具執行 |

## State 與命名慣例

- **Session 隔離 state**：`~/.claude/{name}-{sessionId}.json`（避免多視窗衝突）
  - 例：`pipeline-state-{sessionId}.json`、`compact-counter-{sessionId}.json`
- **全域共享 daemon**：`~/.claude/dashboard-server.pid`、`~/.claude/remote-bot.pid`
- **認證檔案**：`~/.claude/remote.env`（`KEY=VALUE` 格式，環境變數優先）
- **hooks.json 格式**：只支援 grouped `{ matcher, hooks: [...] }`，不支援 flat
- **Hook 腳本路徑**：一律使用 `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/xxx.js`

## Agent 配置規範

| 色彩 | Agent | Model |
|:----:|-------|:-----:|
| purple | planner · doc-updater | opus |
| cyan | architect | opus |
| yellow | developer · qa | sonnet |
| blue | code-reviewer | opus |
| red | security-reviewer | opus |
| pink | tester | sonnet |
| orange | build-error-resolver | haiku |
| green | e2e-runner | sonnet |

合法色彩值：`red` / `blue` / `green` / `yellow` / `purple` / `orange` / `pink` / `cyan`

## ECC 平台約束

- **hooks.json 自動載入**：不需在 plugin.json 宣告
- **`once` 僅限 Skill/Slash Command frontmatter**：plugin hooks.json 不支援，需用 state file 防重複
- **Skill 字元預算 15,000**（可覆寫）｜建議 500 行以下
- **plugin.json 不允許自定義欄位**：自定義資料放 `pipeline.json` 等獨立檔案
- **rules 無法透過 plugin 分發**（上游限制）
- **Sub-agent 不能生 sub-agent**：hooks-only pipeline，無 orchestrator
- **Frontmatter hooks 僅 3 事件**：PreToolUse / PostToolUse / Stop
- **SubagentStop 必須檢查 `stop_hook_active`**：`true` 時 `exit 0` 避免遞迴
- **Hook 腳本需要 `chmod +x`**：Write 工具建立 644，ECC 靠 shebang 直接執行需 755
- **Plugin cache 路徑**：ECC 載入 `~/.claude/plugins/cache/{mkt}/{plugin}/{ver}/`

## 架構決策

| 決策 | 結論 | 原因 |
|------|------|------|
| Plugin 策略 | forge 獨立 + vibe 統一 | 消除跨模組重複，registry 統一 metadata |
| Metadata 管理 | registry.js（Single Source of Truth） | 新增 stage 只改一處 |
| Script/Template 定位 | 內部子功能，非獨立 skill | 不暴露給使用者 |
| Hook/Script 語言 | JS（與 ECC 一致） | 零編譯、hook 原生支援 |
| 目標平台 | macOS only | 不需跨平台 |
| Pipeline 機制 | hooks-only（無 orchestrator） | sub-agent 不能生 sub-agent |

## 文檔體系

| 路徑 | 內容 | 維護方式 |
|------|------|---------|
| `docs/reference/` | 6 份組件規格書（plugin/skill/agent/hook/script/template） | 手動 |
| `docs/ref/` | plugin 設計文件 + `index.md` + `pipeline.md` | index.md 自動生成 |
| `docs/plugin-specs.json` | 組件數量 Single Source of Truth | 手動 |
| `docs/ECC研究報告.md` | ECC 平台深度分析 | 手動 |
| `dashboard/` | Build-time 靜態生成系統（HTML + index.md） | Stop hook 自動觸發 |
| `dashboard/config.json` | 儀表板視覺配置 | 手動 |

**自動同步鏈**：Stop hook → `refresh.js` → `sync-data.js` + `scan-progress.js` → `generate.js` → `dashboard.html` + `index.md`

## 開發規範

### 基本規則
- 所有回覆使用**繁體中文**
- 組件產出必須通過對應驗證腳本
- **功能需驗證測試**：所有功能在完成前必須經過實際驗證測試
- 不確定時詢問，不猜測

### 版號更新
commit 涉及 plugin 變更時，必須同步更新該 plugin 的 `plugin.json` version：
- **patch +1**：修正、文件更新
- **minor +1**：新功能、新組件
- **major +1**：破壞性變更

### 新增組件 Checklist
1. 按 `docs/reference/` 規格書建立組件
2. 更新 `docs/plugin-specs.json` 的 `expected` 數量
3. 如涉及 pipeline → 更新 `pipeline.json` 的 `provides`
4. 如涉及新 stage → 更新 `registry.js`
5. 驗證腳本通過（`forge` 提供驗證工具）
6. 更新 `plugin.json` 版號

### Plugin 發布流程
1. 更新 `plugin.json`（version + description）
2. 確認 `.claude-plugin/marketplace.json` 已註冊
3. `git push`
4. 使用者端 `claude plugin install`

### 關鍵注意事項
- **Hook 腳本 `chmod +x`**：Write 工具建立的檔案是 644，hook 需要 755
- **Plugin cache 同步**：修改原始碼後，需同步到 `~/.claude/plugins/cache/` 才能即時生效
- **設計文件必須與實作同步**：改了程式碼就檢查 `docs/ref/` 對應設計文件
