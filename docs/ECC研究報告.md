# ECC（Everything Claude Code）深度研究報告

> 來源：https://github.com/affaan-m/everything-claude-code
> 版本：v1.4.0（42K+ stars）
> 定位：Anthropic x Forum Ventures 黑客松冠軍，經 10+ 個月實戰驗證

---

## 1. 架構總覽

### 1.1 目錄結構

```
everything-claude-code/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest
│   └── marketplace.json     # Marketplace manifest
├── agents/                  # 13 個專用 agent
├── skills/                  # 28+ 個 skill（知識庫型）
├── commands/                # 30+ 個 slash command
├── hooks/
│   └── hooks.json           # 事件驅動 hooks（自動載入）
├── scripts/
│   ├── hooks/               # Hook 腳本（Node.js）
│   └── lib/                 # 共用函式庫
├── rules/
│   ├── common/              # 通用規則（8 份）
│   ├── typescript/          # TS 專用規則
│   ├── python/              # Python 專用規則
│   └── golang/              # Go 專用規則
├── contexts/                # 3 種情境模式
├── examples/                # CLAUDE.md 範例
├── docs/                    # 中文翻譯
└── .opencode/               # OpenCode 整合
```

### 1.2 Manifest 設計

**plugin.json 關鍵欄位**：
- `skills`: `["./skills/", "./commands/"]` — 用目錄路徑自動掃描
- `agents`: 明確列出 13 個 .md 檔案路徑
- 無 `hooks` 欄位（hooks.json 由 Claude Code 自動載入）
- 額外欄位：`author`、`homepage`、`repository`、`license`、`keywords`

**marketplace.json 特點**：
- `plugins[].category`: `"workflow"`
- `plugins[].tags`: 陣列，用於分類搜尋
- `plugins[].source`: `"./"` 指向自身

### 1.3 重要限制發現

| 限制 | 說明 |
|------|------|
| hooks 不可寫入 plugin.json | 自動載入 `hooks/hooks.json`，重複宣告會報錯 |
| rules 無法透過 plugin 分發 | 上游限制，必須手動複製到使用者目錄 |
| MCP 會吃 context window | 太多 MCP 工具啟用時，200k → 70k 可用 context |
| skills 用目錄路徑 | `["./skills/"]` 自動掃描，不需逐一列出 |

---

## 2. Agents 分析（13 個）

### 2.1 Agent 清單與定位

| Agent | 定位 | Model | Tools |
|-------|------|:-----:|-------|
| **planner** | 功能規劃 | opus | Read, Grep, Glob |
| **architect** | 架構設計 | opus | Read, Grep, Glob |
| **tdd-guide** | TDD 驅動開發 | opus | Read, Write, Edit, Bash, Grep |
| **code-reviewer** | 通用程式碼審查 | opus | Read, Grep, Glob, Bash |
| **security-reviewer** | 安全漏洞檢測 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **build-error-resolver** | TS/Build 錯誤修復 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **e2e-runner** | E2E 測試管理 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **refactor-cleaner** | 死程式碼清理 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **doc-updater** | 文件生成/更新 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **go-reviewer** | Go 程式碼審查 | opus | Read, Grep, Glob, Bash |
| **go-build-resolver** | Go Build 修復 | opus | Read, Write, Edit, Bash, Grep, Glob |
| **python-reviewer** | Python 程式碼審查 | opus | Read, Grep, Glob, Bash |
| **database-reviewer** | PostgreSQL 審查 | opus | Read, Write, Edit, Bash, Grep, Glob |

### 2.2 Agent 設計共通模式

**System Prompt 結構**：
1. Your Role（角色定義 + 使用時機）
2. Workflow（4-6 步執行流程）
3. Patterns & Examples（常見模式 + BAD vs GOOD 對比）
4. Checklist（審查清單）
5. Output Format（產出格式範本）
6. Best Practices（最佳實踐）

**核心設計原則**：
- 全部使用 `model: opus`（高品質推理）
- 唯讀 agent（planner、architect、reviewers）只給 Read/Grep/Glob
- 可寫 agent 給完整 tools 權限
- 每個 agent 都有明確的「PROACTIVELY use when...」觸發條件
- 優先級分層：CRITICAL → HIGH → MEDIUM → LOW

### 2.3 開發閉環

```
規劃（planner, architect）
  → 開發（tdd-guide）
    → 審查（code-reviewer, security-reviewer, *-reviewer）
      → 修復（build-error-resolver, go-build-resolver）
        → 測試（e2e-runner）
          → 清理（refactor-cleaner）
            → 文件（doc-updater）
```

---

## 3. Skills 分析（28+ 個）

### 3.1 分類

| 分類 | Skills | 數量 |
|------|--------|:----:|
| **學習與進化** | continuous-learning, continuous-learning-v2 | 2 |
| **工作流程控制** | strategic-compact, verification-loop, eval-harness, iterative-retrieval | 4 |
| **測試與品質** | tdd-workflow, security-review, golang-testing, python-testing, springboot-tdd, django-tdd | 6 |
| **語言/框架模式** | coding-standards, backend-patterns, frontend-patterns, golang-patterns, python-patterns, java-coding-standards, springboot-patterns, django-patterns | 8 |
| **資料庫** | clickhouse-io, postgres-patterns, jpa-patterns | 3 |
| **安裝配置** | configure-ecc | 1 |

### 3.2 Frontmatter 使用模式

| 欄位 | 使用率 | 說明 |
|------|:------:|------|
| `name` | 高 | 幾乎所有 skill 都有 |
| `description` | 高 | 幾乎所有 skill 都有 |
| `version` | 極低 | 只有 continuous-learning-v2 使用 |
| `tools` | 極低 | 只有 eval-harness 使用 |

**觀察**：ECC 的 skill 極簡使用 frontmatter，只用 `name` + `description`。未使用 `triggers`、`commands`、`context`、`agentOptions` 等進階欄位。

### 3.3 Skill 內容結構模式

| 模式 | 代表 | 特徵 |
|------|------|------|
| **Workflow 導向** | tdd-workflow, verification-loop, eval-harness | 明確步驟（Step 1/2/3）、Checklist |
| **Reference 導向** | coding-standards, backend-patterns, frontend-patterns | 大量 GOOD/BAD 對比、Quick reference 表格 |
| **Pattern Catalog** | postgres-patterns, clickhouse-io | Cheat sheets、常用模式範例 |
| **System 導向** | continuous-learning-v2, iterative-retrieval | 系統架構圖、階段循環、檔案結構 |

### 3.4 亮點 Skills

**continuous-learning-v2**（自動學習系統）：
- 使用 PreToolUse/PostToolUse hooks 觀察 session 行為
- 建立 atomic "instincts"（碎片化知識 + 0.3-0.9 信心分數）
- 背景 agent（Haiku）分析 observations.jsonl
- 進化路徑：instincts → cluster → skill/command/agent

**strategic-compact**（策略性壓縮）：
- 追蹤 tool calls 數量（閾值 50 calls）
- 在邏輯邊界建議手動 compact，避免任務中斷
- 每 25 calls 提醒一次

**iterative-retrieval**（漸進式檢索）：
- 4 階段循環：DISPATCH → EVALUATE → REFINE → LOOP
- 解決 subagent 不知道需要哪些 context 的問題
- 相關性分數 0-1，0.7+ 為高相關，找到 3 個即停止

---

## 4. Commands 分析（30+ 個）

### 4.1 核心 Commands

| Command | 用途 | 核心機制 |
|---------|------|---------|
| `/plan` | 功能規劃 | planner agent → 分階段計畫 → 等使用者確認 |
| `/tdd` | 測試驅動開發 | tdd-guide agent → RED-GREEN-REFACTOR 強制流程 |
| `/code-review` | 程式碼審查 | 安全（CRITICAL）→ 品質（HIGH）→ 最佳實踐（MEDIUM）|
| `/build-fix` | 修復 build 錯誤 | 逐一修復 → 重新驗證 → 3 次失敗停止 |
| `/e2e` | E2E 測試 | Playwright + Page Object Model |
| `/verify` | 綜合驗證 | Build → Types → Lint → Tests → console.log → Git |
| `/learn` | 提取學習模式 | 從 session 提取 Problem + Solution + When to Use |
| `/checkpoint` | 工作檢查點 | create/verify/list → git stash/commit |

### 4.2 進階 Commands

| Command | 用途 | 設計亮點 |
|---------|------|---------|
| `/evolve` | instinct 聚類 | 碎片知識 → commands/skills/agents |
| `/skill-create` | 從 git 生成 SKILL.md | 分析 commit conventions、檔案共變模式 |
| `/multi-plan` | 多模型協作規劃 | Codex（後端）+ Gemini（前端）並行分析 |
| `/multi-execute` | 多模型協作執行 | Claude 擁有程式碼主權，Codex/Gemini 做 audit |
| `/sessions` | 會話管理 | list/load/alias/info + alias 系統 |
| `/setup-pm` | 套件管理器偵測 | env → config → package.json → lock file |

### 4.3 Command vs Skill 設計區別

| 維度 | Command | Skill |
|------|---------|-------|
| 觸發方式 | 使用者主動 `/command` | 自動觸發（hooks、pattern matching） |
| 表現形式 | 執行邏輯（調用 agent / script） | 行為規則（知識 + 觸發條件） |
| 設計模式 | 語意路由 + Agent 編排 | 模式匹配 + 自動觸發 |
| 驗證需求 | 不需（使用者明確調用） | 需驗證腳本確保正確觸發 |

---

## 5. Hooks 分析

### 5.1 事件覆蓋

| 事件 | Hook 數量 | 用途 |
|------|:---------:|------|
| **PreToolUse** | 5 | 阻擋危險操作、提醒 tmux、建議 compact |
| **PostToolUse** | 5 | PR URL 記錄、Prettier 格式化、TS 檢查、console.log 警告 |
| **SessionStart** | 1 | 載入前次 context、偵測 package manager |
| **SessionEnd** | 2 | 儲存 session 狀態、評估可提取模式 |
| **PreCompact** | 1 | 記錄 compaction 事件 |
| **Stop** | 1 | 檢查 console.log |

### 5.2 Hook 設計模式

**語言選擇**：全部使用 Node.js（非 bash），確保 Windows/macOS/Linux 跨平台相容。

**inline vs 外部腳本**：
- 簡單邏輯用 inline `node -e "..."`
- 複雜邏輯用外部 `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/*.js`

**matcher 語法**：
```
// 精確匹配工具
tool == "Bash"

// 組合條件
tool == "Bash" && tool_input.command matches "(pattern)"

// 檔案類型匹配
tool == "Edit" && tool_input.file_path matches "\\.(ts|tsx)$"

// 全部匹配
*
```

**stdin JSON 處理模式**（PostToolUse）：
```javascript
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  const i = JSON.parse(d);
  const p = i.tool_input?.file_path;
  // ... 處理邏輯
  console.log(d); // hookSpecificOutput
});
```

### 5.3 亮點 Hooks

**阻擋 dev server 在 tmux 外啟動**：
- matcher: `tool == "Bash" && tool_input.command matches "(npm run dev|pnpm dev|...)"`
- 行為：exit(1) 阻擋 + 輸出替代指令

**阻擋建立隨意 .md 檔案**：
- matcher: `tool == "Write" && tool_input.file_path matches "\\.(md|txt)$"`
- 排除白名單：README.md、CLAUDE.md、AGENTS.md、CONTRIBUTING.md

**Async build 分析**（PostToolUse）：
- `async: true, timeout: 30` — 背景執行不阻塞

**Auto-format + TypeScript check**（PostToolUse）：
- 編輯 .ts/.tsx 後自動執行 `npx prettier --write` + `npx tsc --noEmit`

---

## 6. Scripts 架構

### 6.1 Hook 腳本

| 腳本 | 觸發事件 | 功能 |
|------|---------|------|
| `session-start.js` | SessionStart | 載入最近 session、偵測 PM、檢查 learned skills |
| `session-end.js` | SessionEnd | 建立/更新 session 檔案 |
| `pre-compact.js` | PreCompact | 記錄 compaction 事件到 log |
| `suggest-compact.js` | PreToolUse | 計數 tool calls → 達閾值建議 compact |
| `evaluate-session.js` | SessionEnd | ≥10 訊息時提示提取可重用模式 |
| `check-console-log.js` | Stop | 檢查 git 修改檔是否含 console.log |

### 6.2 共用函式庫

**`scripts/lib/utils.js`**（核心工具）：
- 平台偵測：isWindows/isMacOS/isLinux
- 目錄管理：getClaudeDir/getSessionsDir/getLearnedSkillsDir
- 檔案操作：findFiles/readFile/writeFile（替代 shell 指令）
- Git：getGitRepoName/getGitModifiedFiles/isGitRepo
- Hook I/O：readStdinJson（stdin 讀取）、log（stderr）、output（stdout）
- 安全：commandExists（regex 驗證指令名，防 injection）

**`scripts/lib/package-manager.js`**（PM 偵測）：
- 優先級：env var → project config → package.json → lock file → global config → fallback
- 支援：npm/pnpm/yarn/bun
- API：getPackageManager/getRunCommand/getCommandPattern

**`scripts/lib/session-manager.js`**（Session CRUD）：
- 解析：parseSessionFilename/parseSessionMetadata
- 查詢：getAllSessions/getSessionById（支援 short ID + alias）
- 操作：writeSessionContent/appendSessionContent/deleteSession

### 6.3 設計原則

- 全 Node.js（跨平台）
- DRY（共用 utils.js 避免重複）
- 安全（spawnSync 替代 shell 指令，regex 驗證輸入）
- stdin/stdout/stderr 分離（符合 hook I/O 規範）

---

## 7. Rules 與 Contexts

### 7.1 Rules 體系

| Rule 檔案 | 核心內容 |
|-----------|---------|
| `agents.md` | 可用 agents 列表 + 何時使用 + 並行執行規則 |
| `coding-style.md` | 不可變性（CRITICAL）+ 檔案組織（200-400行/800上限）+ 錯誤處理 |
| `git-workflow.md` | Conventional commits + PR 流程 + Plan → TDD → Review → Commit |
| `hooks.md` | Hook 類型 + Auto-Accept + TodoWrite 最佳實踐 |
| `patterns.md` | Skeleton Projects + Repository Pattern + API Response 格式 |
| `performance.md` | Model 選擇（Haiku/Sonnet/Opus）+ Context 管理 + Extended Thinking |
| `security.md` | Commit 前檢查清單 + Secret 管理 + Security Response Protocol |
| `testing.md` | TDD 強制流程 + 80% 覆蓋率 + 測試類型 |

**Rules 限制**：無法透過 plugin 分發（上游限制），需手動複製到 `~/.claude/rules/`。

### 7.2 Contexts（情境模式）

| Context | 行為 | 工具偏好 |
|---------|------|---------|
| `dev.md` | 先寫後解釋、優先可行解 | Edit/Write, Bash, Grep/Glob |
| `research.md` | 理解後再行動、不急於寫碼 | Read, Grep/Glob, WebSearch, Task+Explore |
| `review.md` | 徹底閱讀、依嚴重程度排序 | Grep, Read, security-reviewer agent |

---

## 8. 設計模式總結

### 8.1 Skill 定位差異

| 面向 | ECC Skills | Vibe/Forge 設計 |
|------|-----------|----------------|
| 目標使用者 | Claude Code 使用者 | Marketplace 開發者 |
| Skill 定位 | 知識載體（patterns、checklists） | 能力載體（$ARGUMENTS 語意執行） |
| SKILL.md 內容 | 純 knowledge/reference | 能力邊界 + 規則 + 語意描述 |
| Frontmatter | 極簡（只 name + description） | 完整（triggers、commands、context） |
| 自動化 | 需 Claude 判讀後執行 | Hooks + Scripts 自動驗證閉環 |
| 腳本可見性 | 部分可見 | 完全內部化 |

### 8.2 跨元件設計模式

| 模式 | 使用處 | 說明 |
|------|-------|------|
| BAD vs GOOD 對比 | Agents、Skills | 所有範例用 ❌/✅ 對比格式 |
| 優先級分層 | Agents | CRITICAL → HIGH → MEDIUM → LOW |
| 診斷優先 | Agents | 先執行診斷指令（git diff, tsc, go vet），再基於實際輸出審查 |
| 最小化變更 | build-error-resolver | 只修錯誤，不重構/不改架構/不優化 |
| 進化路徑 | continuous-learning-v2 | instincts → cluster → skill/command/agent |
| Session 持久化 | hooks + scripts | SessionStart 載入 → SessionEnd 儲存 |

---

## 9. 對 Vibe/Forge 的啟發

### 9.1 可直接借鑑

| 項目 | ECC 做法 | 建議應用 |
|------|---------|---------|
| Hook 語言 | 全 Node.js | forge 驗證腳本也應改用 Node.js（當前用 bash）|
| skills 目錄掃描 | `["./skills/"]` 自動掃描 | forge plugin.json 可採用 |
| Session 管理 | session-start/end hooks | forge 未來可加入 |
| strategic-compact | 50 calls 建議 compact | 可直接移植 |
| .md 檔案阻擋 | PreToolUse hook | 防止產生不必要的文件 |
| Prettier auto-format | PostToolUse hook | PostToolUse 自動格式化 |

### 9.2 Vibe 差異化方向

| 維度 | ECC | Vibe/Forge |
|------|-----|-----------|
| 定位 | 個人開發效率套件 | 造工具的工具（meta-tool） |
| Skill 設計 | 靜態知識庫 | 動態語意執行 + 自動驗證 |
| 使用者介面 | 30+ commands（學習曲線高） | 4 個 forge skills（極簡對外） |
| 驗證機制 | 無 | 完整驗證腳本體系（V-SK/AG/HK/SC） |
| Template 體系 | 無 | 標準化組件模板 |
| 腳本安全 | utils.js 有基本防護 | validate-common.sh 完整驗證框架 |

### 9.3 需要注意的風險

1. **Context Window 壓力**：ECC 有 28+ skills + 30+ commands，全部啟用會嚴重壓縮可用 context
2. **Rules 分發限制**：plugin 無法分發 rules，需要其他機制
3. **Hook 衝突**：多 plugin 同時註冊同一事件的 hooks 可能產生衝突
4. **跨平台測試**：bash 腳本在 Windows 上無法運行，ECC 已用 Node.js 解決
