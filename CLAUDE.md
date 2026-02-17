# Vibe — 專案規則

## 專案定位

Vibe 是 Claude Code marketplace，為全端開發者提供從規劃到部署的完整工作流。由 2 個 plugin 組成：`forge`（meta plugin builder）和 `vibe`（統一開發工作流）。

## Plugin 架構

| Plugin | 版號 | 定位 | Skills | Agents | Hooks | Scripts |
|--------|------|------|:------:|:------:|:-----:|:-------:|
| **forge** | 0.1.5 | 造工具的工具（meta plugin builder） | 4 | 0 | 0 | 7 |
| **vibe** | 1.0.58 | 全方位開發工作流 | 34 | 12 | 19 | 44 |

### vibe plugin 功能模組

| 模組 | 功能 | Skills | Agents |
|------|------|:------:|:------:|
| 規劃 | Pipeline 工作流管理、規劃、架構設計、開發實作 | 8 | 4 (planner/architect/developer/pipeline-architect) |
| 設計 | UI/UX 設計系統生成（ui-ux-pro-max 整合） | 1 | 1 (designer) |
| 品質 | lint、format、review、security、TDD、E2E、QA | 9 | 6 (code-reviewer/security-reviewer/tester/build-error-resolver/e2e-runner/qa) |
| 知識 | 語言/框架模式庫（純知識） | 8 | 0 |
| 進化 | 知識進化、文件同步 | 2 | 1 (doc-updater) |
| 監控 | Pipeline 即時儀表板（WebSocket）+ Timeline 查詢 | 2 | 0 |
| 遠端 | Telegram 遠端控制 + tmux 操作 | 2 | 0 |
| 維護 | RAM 健康檢查、孤兒進程清理 | 1 | 0 |
| 診斷 | Hook 錯誤診斷 | 1 | 0 |

### 共用 registry.js（Single Source of Truth）

`plugins/vibe/scripts/lib/registry.js` 統一定義所有 agent/stage/emoji/color 映射，消除跨模組重複。所有 hook 腳本和 bot.js 統一從此處 import。

### OpenSpec 規格管理

借鑑 [Fission-AI/OpenSpec](https://github.com/Fission-AI/openspec) 的目錄慣例，原生整合到 pipeline 中：

```
openspec/
├── config.yaml              # 專案配置（schema + context + rules）
├── schemas/vibe-pipeline/   # 自訂 artifact 依賴圖
├── specs/                   # 規格 Source of Truth（歸檔後累積）
└── changes/                 # 進行中的 feature
    ├── {change-name}/       # 每個 feature 一個目錄
    │   ├── .openspec.yaml   # metadata（schema + date）
    │   ├── proposal.md      # PLAN 階段 planner 產出（WHY + WHAT）
    │   ├── design.md        # ARCH 階段 architect 產出（HOW）
    │   ├── design-system.md # DESIGN 階段 designer 產出（UI/UX 設計系統）
    │   ├── design-mockup.html # DESIGN 階段 designer 產出（視覺化 mockup）
    │   ├── specs/           # ARCH 階段 architect 產出（Delta specs）
    │   └── tasks.md         # ARCH 階段 architect 產出（checkbox 任務清單）
    └── archive/             # 已完成的 changes（DOCS 階段歸檔）
```

**Pipeline 對接**：PLAN→proposal.md | ARCH→design+specs+tasks | DESIGN→design-system+mockup | DEV→tasks.md打勾 | REVIEW→specs對照審查 | TEST→specs→測試案例 | DOCS→archive歸檔
**Agent 覆蓋**：9/12 agents 整合 OpenSpec（planner/architect/designer/developer/code-reviewer/tester/qa/doc-updater/security-reviewer），build-error-resolver、e2e-runner 和 pipeline-architect 不需要

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
│   └── hooks.json           # 統一 19 hooks（7 事件，順序明確）
├── pipeline.json            # Pipeline 階段宣告 + provides
├── scripts/
│   ├── hooks/               # 15 個 hook 腳本
│   └── lib/                 # 共用函式庫
│       ├── registry.js      # ★ 全局 metadata（STAGES/AGENTS/EMOJI）
│       ├── hook-logger.js   # Hook 錯誤日誌（~/.claude/hook-errors.log）
│       ├── hook-utils.js    # safeRun() JSON stdin 安全解析
│       ├── flow/            # ★ dag-state, dag-utils, pipeline-controller, skip-predicates, state-migrator, classifier, verdict, retry-policy, pipeline-resume, env-detector, counter, uiux-resolver, pipeline-discovery
│       ├── sentinel/        # lang-map, tool-detector, guard-rules
│       ├── dashboard/       # server-manager
│       ├── remote/          # telegram, transcript, bot-manager
│       └── timeline/        # schema, timeline, consumer, formatter, index
├── skills/                  # 34 個 skill 目錄
├── agents/                  # 12 個 agent 定義
├── server.js                # Dashboard HTTP+WebSocket server
├── bot.js                   # Telegram daemon
├── web/index.html           # Dashboard 前端
└── tests/                   # E2E 測試
```

## Pipeline 委派架構

### Pipeline v3 — 動態 DAG 架構

v3 核心改變：靜態 FSM → 宣告式 DAG 狀態 + pipeline-controller 統一 API。所有 hook 精簡為 controller 薄代理。

**三個角色分工**：
- **Pipeline Agent**（pipeline-architect, haiku/plan）：分析 prompt + 環境 → 產出 DAG + 執行藍圖
- **Pipeline Skill**（`/vibe:pipeline`）：提供 stage 定義、DAG 結構規範、範例模板
- **Hook Stack**（5 核心）：防護 + 追蹤 + 引導 + 閉環

**v3 State Schema**：`dag`（DAG 結構）+ `stages`（各 stage 狀態）+ `classification`（分類結果）+ `pendingRetry`/`retries`。Phase 由 `derivePhase(state)` 即時推導，不儲存。

### Pipeline Catalog（10 種參考模板）

`registry.js` 的 `PIPELINES` 定義 10 種參考模板。`[pipeline:xxx]` 顯式指定時直接建立線性 DAG；非顯式則由 pipeline-architect 動態生成：

| Pipeline ID | 階段 | 描述 | 強制性 |
|------------|------|------|:-----:|
| **full** | PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS | 新功能（含 UI） | ✅ |
| **standard** | PLAN → ARCH → DEV → REVIEW → TEST → DOCS | 新功能（無 UI）、大重構 | ✅ |
| **quick-dev** | DEV → REVIEW → TEST | bugfix + 補測試、小改動 | ✅ |
| **fix** | DEV | hotfix、config、一行修改 | ✅ |
| **test-first** | TEST → DEV → TEST | TDD 工作流（雙 TEST 循環） | ✅ |
| **ui-only** | DESIGN → DEV → QA | 純 UI/樣式調整 | ✅ |
| **review-only** | REVIEW | 程式碼審查 | ✅ |
| **docs-only** | DOCS | 純文件更新 | ✅ |
| **security** | DEV → REVIEW → TEST | 安全修復（REVIEW 含安全審查） | ✅ |
| **none** | （空） | 問答、研究、trivial | ❌ |

**使用方式**：
- **自動分類**：task-classifier 根據關鍵字和語意判斷，自動選擇 pipeline
- **顯式指定**：在 prompt 中使用 `[pipeline:xxx]` 語法（如 `[pipeline:tdd] 實作 XXX 功能`）

**強制性**（enforced）：
- ✅ 強制：pipeline-guard 硬阻擋 Main Agent 直接操作，必須透過 delegation（所有有階段的 pipeline）
- ❌ 非強制：僅 `none` pipeline（問答/研究），Main Agent 可直接操作

### 9 階段工作流

完整 pipeline 由 hooks 驅動（無 orchestrator agent）：

```
PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS
```

| 階段 | Agent | Model/Color | Skill |
|------|-------|-------------|-------|
| PLAN | planner | opus/purple | `/vibe:scope` |
| ARCH | architect | opus/cyan | `/vibe:architect` |
| DESIGN | designer | sonnet/cyan | `/vibe:design` |
| DEV | developer | sonnet/yellow | `/vibe:dev` |
| REVIEW | code-reviewer | opus/blue | `/vibe:review` |
| TEST | tester | sonnet/pink | `/vibe:tdd` |
| QA | qa | sonnet/yellow | `/vibe:qa` |
| E2E | e2e-runner | sonnet/green | `/vibe:e2e` |
| DOCS | doc-updater | haiku/purple | `/vibe:doc-sync` |

**防禦機制**（v3：所有 hook 為 pipeline-controller 薄代理）：
- `task-classifier`（UserPromptSubmit）→ `ctrl.classify()` — 快篩 + 分類 + 顯式路徑建 DAG
- `pipeline-guard`（PreToolUse *）→ `ctrl.canProceed()` — derivePhase 決策 + 唯讀白名單
- `delegation-tracker`（PreToolUse Task）→ `ctrl.onDelegate()` — stage active 標記
- `stage-transition`（SubagentStop）→ `ctrl.onStageComplete()` — DAG 排程 + 回退/前進/完成
- `pipeline-check`（Stop）→ `ctrl.onSessionStop()` — 遺漏偵測 + 閉環阻擋

## Hooks 事件全景

統一 hooks.json，19 hooks 按事件分組（順序明確）：

| 事件 | Hooks（執行順序） |
|------|------------------|
| **SessionStart** | session-cleanup → pipeline-init → dashboard-autostart → remote-hub:autostart |
| **UserPromptSubmit** | task-classifier → remote-hub:prompt-forward |
| **PreToolUse(Task)** | delegation-tracker |
| **PreToolUse(Write\|Edit\|NotebookEdit\|AskUserQuestion\|EnterPlanMode\|Bash)** | pipeline-guard |
| **PreToolUse(*)** | suggest-compact |
| **PreToolUse(AskUserQuestion)** | remote-hub:ask-intercept |
| **PostToolUse(Write\|Edit)** | post-edit（lint → format → test-check） |
| **PreCompact** | log-compact |
| **SubagentStop** | stage-transition → remote-hub:sender |
| **Stop** | pipeline-check → task-guard → check-console-log → dashboard-refresh → remote-hub:receipt |

### Hook 輸出管道

| 管道 | 可見對象 | 強度 | 用途 |
|------|---------|------|------|
| `additionalContext` | Claude | 軟建議 | 背景知識、上下文注入 |
| `systemMessage` | Claude | 強指令 | 系統級規則（模型不可忽略） |
| `stderr` + exit 2 | 使用者 | **硬阻擋** | 阻止工具執行（pipeline-guard / Bash 危險指令） |
| `hookLogger.error()` | log 檔案 | 無 | 記錄到 `~/.claude/hook-errors.log`（`/hook-diag` 查看） |

## State 與命名慣例

- **Session 隔離 state**：`~/.claude/{name}-{sessionId}.json`（避免多視窗衝突）
  - 例：`pipeline-state-{sessionId}.json`、`compact-counter-{sessionId}.json`
- **全域共享 daemon**：`~/.claude/dashboard-server.pid`、`~/.claude/remote-bot.pid`
- **Hook 錯誤日誌**：`~/.claude/hook-errors.log`（自動截斷 500 行，`/hook-diag` 查看）
- **認證檔案**：`~/.claude/remote.env`（`KEY=VALUE` 格式，環境變數優先）
- **hooks.json 格式**：只支援 grouped `{ matcher, hooks: [...] }`，不支援 flat
- **Hook 腳本路徑**：一律使用 `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/xxx.js`

## Agent 配置規範

| 色彩 | Agent | Model |
|:----:|-------|:-----:|
| purple | planner | opus |
| purple | doc-updater | haiku |
| cyan | architect | opus |
| cyan | designer | sonnet |
| yellow | developer · qa | sonnet |
| blue | code-reviewer | opus |
| red | security-reviewer | opus |
| pink | tester | sonnet |
| orange | build-error-resolver | haiku |
| green | e2e-runner | sonnet |
| purple | pipeline-architect | haiku |

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
| Main Agent 模型 | Sonnet 路由器（推薦） | pipeline-guard 保障品質，Main Agent 只負責委派 |
| 規格管理 | OpenSpec 目錄慣例（原生實作） | 結構化 proposal/design/specs/tasks，累積知識庫 |

### Main Agent 路由器模式

推薦 Main Agent 使用 Sonnet（`claude --model sonnet`），所有實際工作由特化 sub-agents 完成。

- **安全保障**：pipeline-guard 硬阻擋 Main Agent 寫碼 | sub-agents 使用各自指定模型
- **環境變數**：`VIBE_CLASSIFIER_MODEL`（Layer 3 LLM 模型，預設 Sonnet）| `VIBE_CLASSIFIER_THRESHOLD`（Layer 2→3 閾值，設 `0` 停用 LLM）

## 文檔體系

| 路徑 | 內容 | 維護方式 |
|------|------|---------|
| `docs/ref/` | plugin 設計文件 + `index.md` + `vibe.md` + `pipeline.md` + `collab.md` | index.md + vibe.md 自動生成 |
| `docs/plugin-specs.json` | 組件數量 Single Source of Truth | 手動 |
| `docs/ECC研究報告.md` | ECC 平台深度分析 | 手動 |
| `dashboard/` | Build-time 靜態生成系統（HTML + index.md） | Stop hook 自動觸發 |
| `dashboard/config.json` | 儀表板視覺配置 | 手動 |

**自動同步鏈**：Stop hook → `refresh.js` → `sync-data.js` + `scan-progress.js` → `generate.js` → `dashboard.html` + `index.md` + `vibe.md`

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
1. 按 forge 驗證規則建立組件（`/forge:scaffold`、`/forge:skill`、`/forge:agent`、`/forge:hook`）
2. 更新 `docs/plugin-specs.json` 的 `expected` 數量
3. 如涉及 pipeline → 更新 `pipeline.json` 的 `provides`
4. 如涉及新 stage → 更新 `registry.js`
5. 驗證腳本通過（`forge` 提供驗證工具）
6. 更新 `plugin.json` 版號
7. **同步 CLAUDE.md 所有數字**：Plugin 架構表、目錄結構註解、Hooks 事件全景（Stop hook `claude-md-check` 會自動驗證）

### Plugin 發布流程
1. 更新 `plugin.json`（version + description）
2. 確認 `.claude-plugin/marketplace.json` 已註冊
3. `git push`
4. 使用者端 `claude plugin install`

### 關鍵注意事項
- **Hook 腳本 `chmod +x`**：Write 工具建立的檔案是 644，hook 需要 755
- **Plugin cache 同步**：修改原始碼後，需同步到 `~/.claude/plugins/cache/` 才能即時生效
- **設計文件必須與實作同步**：改了程式碼就檢查 `docs/ref/` 對應設計文件
