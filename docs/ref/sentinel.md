# sentinel — 品質全鏈

> **優先級**：高（第一個建構）
> **定位**：品質全鏈守衛 — lint、format、安全審查、code review、TDD、E2E、覆蓋率
> **合併自**：原 sentinel + 原 testkit
> **ECC 對應**：7 agents + PostToolUse hooks + /code-review /tdd /e2e /verify commands

---

## 1. 概述

sentinel 是 Vibe marketplace 的品質全鏈守衛。它涵蓋從**靜態分析到動態測試**的完整品質流程，在開發過程中自動執行，問題越早發現成本越低。

合併 testkit 的原因：lint/format（靜態）和 test（動態）是同一條品質鏈，使用者不會只要其中一半。

核心理念：**寫完就檢查，測完就確認，問題不過夜。**

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **自動化品質閉環** | PostToolUse hooks 在 Write/Edit 後自動 lint + format |
| 2 | **多層次守衛** | 靜態分析 → 格式化 → 測試 → 安全掃描 → 人工審查 |
| 3 | **TDD 強制流程** | RED → GREEN → REFACTOR 不跳步 |
| 4 | **危險操作攔截** | PreToolUse 攔截 rm -rf、DROP TABLE、force push |
| 5 | **語言感知** | 根據檔案類型自動選擇對應工具 |
| 6 | **最小干擾** | 能自動修的就修，只在需要人工時才提醒 |

---

## 3. 組件清單

### Skills（8 個）

| 名稱 | 說明 |
|------|------|
| `review` | 程式碼審查 — 觸發 agent 做深度分析，按嚴重程度排序 |
| `lint` | 靜態分析 — ESLint / Ruff / golangci-lint |
| `format` | 程式碼格式化 — Prettier / Ruff format / gofmt |
| `security` | 安全掃描 — OWASP Top 10 + secret 洩漏偵測 |
| `tdd` | TDD 工作流 — RED → GREEN → REFACTOR 強制流程 |
| `e2e` | E2E 測試 — Playwright Page Object Model |
| `coverage` | 覆蓋率分析 — 目標 80%，關鍵路徑 100% |
| `verify` | 綜合驗證 — Build → Types → Lint → Tests → Git |

### Agents（5 個）

| 名稱 | Model | 權限 | 說明 |
|------|:-----:|:----:|------|
| `code-reviewer` | opus | 唯讀 | 通用程式碼審查，按 CRITICAL→HIGH→MEDIUM→LOW 排序 |
| `security-reviewer` | opus | 唯讀 | OWASP Top 10 安全漏洞檢測 |
| `tester` | sonnet | 可寫 | 獨立測試視角 — 邊界案例、整合測試、覆蓋率 |
| `build-error-resolver` | haiku | 可寫 | Build 錯誤最小化修復（最多 3 輪） |
| `e2e-runner` | sonnet | 可寫 | Playwright 測試管理 — 建立 Page Objects、執行、除錯 |

### Hooks（5 個）

| 事件 | 名稱 | 類型 | 強度 | 說明 |
|------|------|:----:|:----:|------|
| PostToolUse | auto-lint | command | 強建議 | Write/Edit 後自動 lint，錯誤注入 systemMessage |
| PostToolUse | auto-format | command | — | Write/Edit 後自動套用格式化 |
| PostToolUse | test-check | prompt | 軟建議 | 修改商業邏輯後提醒跑測試 |
| Stop | console-log-check | command | 強建議 | 結束前檢查殘留 console.log，注入 systemMessage |
| PreToolUse | danger-guard | command | 硬阻擋 | 攔截高風險指令（exit 2） |

---

## 4. Skills 詳細設計

### 4.1 review — 程式碼審查

```yaml
name: review
description: 程式碼審查 — 觸發深度分析，依嚴重程度排序。支援通用和語言特化審查。
```

**審查清單**：

| 層級 | 檢查項 |
|------|--------|
| CRITICAL | 安全漏洞、資料遺失風險、生產環境影響 |
| HIGH | 邏輯錯誤、效能問題、錯誤處理缺失 |
| MEDIUM | 命名不清、過度複雜、缺少型別 |
| LOW | 風格不一致、缺少註解、冗餘程式碼 |

### 4.2 lint — 靜態分析

```yaml
name: lint
description: 靜態分析 — 根據語言自動選擇 linter，支援 --fix 自動修正。
```

| 語言 | Linter | 設定檔 | 自動修正 |
|------|--------|--------|:--------:|
| TypeScript/JavaScript | ESLint | `.eslintrc.*`, `eslint.config.*` | ✅ |
| Python | Ruff | `pyproject.toml`, `ruff.toml` | ✅ |
| Go | golangci-lint | `.golangci.yml` | 部分 |
| CSS/SCSS | Stylelint | `.stylelintrc.*` | ✅ |

### 4.3 format — 程式碼格式化

```yaml
name: format
description: 程式碼格式化 — 根據語言自動選擇 formatter。
```

| 語言 | Formatter | 設定檔 |
|------|-----------|--------|
| TypeScript/JavaScript/CSS/JSON/MD | Prettier | `.prettierrc.*` |
| Python | Ruff format | `pyproject.toml` |
| Go | gofmt / goimports | 內建 |

### 4.4 security — 安全掃描

```yaml
name: security
description: 安全掃描 — OWASP Top 10 + secret 洩漏 + 依賴漏洞。
```

| 類別 | 檢查項 |
|------|--------|
| 注入 | SQL injection, command injection, XSS, SSRF |
| 認證 | 硬編碼 credentials, JWT 問題, session fixation |
| 資料 | 敏感資料曝露, 日誌洩漏 |
| 設定 | 不安全預設值, CORS 過寬, 缺少安全標頭 |
| 依賴 | 已知 CVE, 過時套件, 未鎖定版本 |

### 4.5 tdd — TDD 工作流

```yaml
name: tdd
description: TDD 工作流 — RED → GREEN → REFACTOR 強制流程，支援 Vitest/Jest/Pytest/Go test。
```

**強制流程**：

```
RED    — 寫失敗的測試 → 執行 → 必須 FAIL
GREEN  — 寫最小實作 → 執行 → 必須 PASS（不多做）
REFACTOR — 改善結構 → 執行 → 仍然 PASS
```

**測試命名**：`should {預期行為} when {條件}`

### 4.6 e2e — E2E 測試

```yaml
name: e2e
description: E2E 測試 — Playwright Page Object Model，測試隔離，自動重試。
```

**Page Object 結構**：每頁一個 class，Locators + Actions + Assertions 分離。

### 4.7 coverage — 覆蓋率分析

```yaml
name: coverage
description: 覆蓋率分析 — 目標 80%，關鍵路徑 100%，產出差距報告和補測建議。
```

| 類型 | 目標 | 說明 |
|------|:----:|------|
| 整體 | 80% | 行覆蓋率 |
| 關鍵路徑 | 100% | 認證、支付、資料處理 |
| 工具函式 | 90% | 純函式 |
| UI 元件 | 60% | 可適度降低 |

### 4.8 verify — 綜合驗證

```yaml
name: verify
description: 綜合驗證 — Build → Types → Lint → Tests → console.log → Git 一鍵檢查。
```

任一步驟失敗 → 停止並報告 → 可選自動修復。

---

## 5. Agents 詳細設計

### 5.1 code-reviewer（唯讀）

```yaml
---
name: code-reviewer
description: >-
  全面審查程式碼品質，包含正確性、安全性、效能與可維護性。
  產出按嚴重程度排序的結構化報告（CRITICAL → HIGH → MEDIUM → LOW）。
tools: Read, Grep, Glob, Bash
model: opus
color: blue
maxTurns: 30
permissionMode: plan
memory: project
---
```

**工作流**：收集變更 → 理解上下文 → 逐項分析 → 按嚴重程度排序報告

### 5.2 security-reviewer（唯讀）

```yaml
---
name: security-reviewer
description: >-
  執行 OWASP Top 10 安全漏洞檢測，追蹤資料流，
  產出含攻擊場景與修復建議的安全報告。
tools: Read, Grep, Glob, Bash
model: opus
color: red
maxTurns: 30
permissionMode: plan
memory: project
---
```

**工作流**：識別攻擊面 → 追蹤資料流 → 檢測 OWASP Top 10 → 報告含攻擊場景和修復建議

### 5.3 tester（可寫）

```yaml
---
name: tester
description: >-
  獨立測試視角的測試撰寫者。分析程式碼的邊界案例，
  撰寫整合測試，驗證覆蓋率目標。不參考 developer 的
  測試邏輯 — 純粹從規格與程式碼行為推斷應測什麼。
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
color: lime
maxTurns: 30
permissionMode: acceptEdits
memory: project
---
```

**工作流**：分析公開介面 → 設計邊界案例 → 撰寫獨立測試 → 執行 + 覆蓋率檢查

**關鍵規則**：不看 developer 的測試理由，從規格和行為獨立推斷測試案例。

### 5.4 build-error-resolver（可寫）

```yaml
---
name: build-error-resolver
description: >-
  以最小、精準的修復解決 build 錯誤。
  只修錯誤 — 不重構不優化。最多 3 輪修復-驗證循環。
tools: Read, Write, Edit, Bash, Grep, Glob
model: haiku
color: orange
maxTurns: 15
permissionMode: acceptEdits
---
```

**關鍵規則**：只修錯誤，不重構不優化。最多 3 輪。

### 5.5 e2e-runner（可寫）

```yaml
---
name: e2e-runner
description: >-
  管理 Playwright E2E 測試 — 建立 Page Objects、
  撰寫測試、執行、除錯失敗。最多 3 輪除錯循環。
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
color: green
maxTurns: 30
permissionMode: acceptEdits
memory: project
---
```

**工作流**：分析頁面 → 建立 Page Objects → 撰寫測試 → 執行 → 除錯（最多 3 輪）

---

## 6. Hooks 詳細設計

### 6.1 PostToolUse: auto-lint

```json
{
  "matcher": "tool == \"Write\" || tool == \"Edit\"",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/auto-lint.js",
    "timeout": 15,
    "statusMessage": "正在檢查程式碼品質..."
  }]
}
```

**強度：強建議** — 偵測語言 → 選擇 linter → 執行 --fix → 結果透過 `systemMessage` 注入，Claude 幾乎不會忽略 lint 錯誤。

### 6.2 PostToolUse: auto-format

```json
{
  "matcher": "tool == \"Write\" || tool == \"Edit\"",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/auto-format.js",
    "timeout": 10,
    "statusMessage": "正在格式化..."
  }]
}
```

**強度：動作型** — 直接套用格式化，無需 Claude 決策。

### 6.3 PostToolUse: test-check

**強度：軟建議** — prompt hook 回應作為 `additionalContext`，Claude 可自行判斷是否跑測試。

```json
{
  "matcher": "tool == \"Write\" || tool == \"Edit\"",
  "hooks": [{
    "type": "prompt",
    "prompt": "The file $ARGUMENTS was just modified. If this file contains business logic that should have tests, briefly remind to run tests. If it's config/style/test file, say nothing. Under 20 words.",
    "model": "haiku",
    "timeout": 10
  }]
}
```

### 6.4 Stop: console-log-check

**強度：強建議** — 偵測殘留 console.log/debugger，透過 `systemMessage` 注入提醒。

> **注意**：此 hook 定義為 `Stop`，但若在 agent frontmatter 中使用，會自動轉換為 `SubagentStop` 事件。

必須有 `stop_hook_active` 防無限迴圈（當 `stop_hook_active === true` 時直接 exit 0）。

### 6.5 PreToolUse: danger-guard

**強度：硬阻擋** — `exit 2` + stderr 直接阻止工具執行，Claude 無法繞過。

攔截清單：`rm -rf /`、`DROP TABLE/DATABASE`、`git push --force main`、`chmod 777`

---

## 7. Scripts

| 腳本 | 位置 | 功能 |
|------|------|------|
| `auto-lint.js` | `scripts/hooks/` | 自動 lint |
| `auto-format.js` | `scripts/hooks/` | 自動 format |
| `check-console-log.js` | `scripts/hooks/` | 檢查殘留 debug |
| `danger-guard.js` | `scripts/hooks/` | 攔截危險指令 |
| `tool-detector.js` | `scripts/lib/` | 偵測已安裝工具 |
| `lang-map.js` | `scripts/lib/` | 副檔名→語言→工具映射 |

---

## 8. 目錄結構

```
plugins/sentinel/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── review/
│   │   └── SKILL.md
│   ├── lint/
│   │   └── SKILL.md
│   ├── format/
│   │   └── SKILL.md
│   ├── security/
│   │   └── SKILL.md
│   ├── tdd/
│   │   └── SKILL.md
│   ├── e2e/
│   │   └── SKILL.md
│   ├── coverage/
│   │   └── SKILL.md
│   └── verify/
│       └── SKILL.md
├── agents/
│   ├── code-reviewer.md
│   ├── security-reviewer.md
│   ├── tester.md
│   ├── build-error-resolver.md
│   └── e2e-runner.md
├── hooks/
│   └── hooks.json
└── scripts/
    ├── hooks/
    │   ├── auto-lint.js
    │   ├── auto-format.js
    │   ├── check-console-log.js
    │   └── danger-guard.js
    └── lib/
        ├── tool-detector.js
        └── lang-map.js
```

---

## 9. 驗收標準

| # | 條件 |
|:-:|------|
| S-01 | Plugin 可載入，8 個 skill 可呼叫 |
| S-02 | 5 個 agent 可觸發 |
| S-03 | auto-lint/auto-format hooks 在 Write/Edit 後觸發 |
| S-04 | danger-guard 攔截 `rm -rf /` |
| S-05 | console-log-check 在 Stop 時偵測殘留 |
| S-06 | TDD 流程完整（RED → GREEN → REFACTOR） |
| S-07 | verify 一鍵跑完 Build → Types → Lint → Tests |
| S-08 | forge:scaffold 驗證全 PASS |

---

## 10. plugin.json

```json
{
  "name": "sentinel",
  "version": "0.1.0",
  "description": "品質全鏈守衛 — lint、format、review、security、TDD、E2E、verify",
  "skills": ["./skills/"],
  "agents": [
    "./agents/code-reviewer.md",
    "./agents/security-reviewer.md",
    "./agents/tester.md",
    "./agents/build-error-resolver.md",
    "./agents/e2e-runner.md"
  ]
}
```
