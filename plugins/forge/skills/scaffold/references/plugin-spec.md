# Plugin 組件規格書

## 一、概述

Plugin 是 Claude Code 的模組化功能擴展單元。每個 plugin 可包含以下組件：

- **Skills** — 可被呼叫的技能指令
- **Agents** — 自主代理
- **Hooks** — 生命週期事件鉤子
- **MCP Servers** — Model Context Protocol 伺服器
- **LSP Servers** — Language Server Protocol 伺服器
- **Output Styles** — 輸出樣式自訂
- **Commands** — 額外命令（與 Skills 相同運作方式，向後相容）

### 獨立配置 vs Plugin

| 方法 | Skill 名稱 | 最適合 |
|------|-----------|--------|
| **獨立**（`.claude/` 目錄） | `/hello` | 個人工作流、專案特定自訂、快速實驗 |
| **Plugin**（含 `.claude-plugin/plugin.json`） | `/plugin-name:hello` | 團隊共享、社群分發、版本化發布、跨專案重用 |

**使用獨立配置**：單一專案自訂、個人配置、實驗中的 skills/hooks
**使用 Plugin**：團隊/社群共享、多專案重用、版本控制、marketplace 分發

> 建議先在 `.claude/` 中快速迭代，準備好共享時再轉換為 plugin。

---

## 二、plugin.json Manifest

### Manifest 是可選的

如果省略 `plugin.json`，Claude Code 會自動探索預設目錄中的組件，並從目錄名稱衍生 plugin name。

### 必要欄位

`name` 和 `version` 為必要欄位。雖然 schema 定義中僅 `name` 標記必填，但 **validator 實際上要求 `version` 存在**，否則會拒絕。

### 完整欄位定義

| 欄位 | 類型 | 必要 | 說明 |
|------|------|------|------|
| `name` | `string` | 是 | kebab-case，不含空格。用於組件命名空間 |
| `version` | `string` | 是（實務必填） | 語義版本號。`plugin.json` 優先於 marketplace entry |
| `description` | `string` | 否 | 插件用途簡述 |
| `author` | `object` | 否 | `{name(必要), email(選填), url(選填)}` |
| `homepage` | `string` | 否 | 文檔 URL |
| `repository` | `string` | 否 | 原始碼 URL |
| `license` | `string` | 否 | MIT、Apache-2.0 等 |
| `keywords` | `array` | 否 | 探索標籤 |
| `commands` | `array` | 否 | 額外命令路徑（目錄路徑或檔案路徑） |
| `agents` | `array` | 否 | 額外 agent 路徑。**必須為明確的 `.md` 檔案路徑**，不接受目錄路徑 |
| `skills` | `array` | 否 | 額外 skill 路徑（目錄路徑） |
| `hooks` | — | — | **不要宣告**。見下方「Hooks 自動載入」 |
| `mcpServers` | `array \| object` | 否 | MCP 設定路徑或行內定義 |
| `outputStyles` | `array` | 否 | 輸出樣式路徑 |
| `lspServers` | `array \| object` | 否 | LSP 設定路徑或行內定義 |

### Validator 實務限制（重要）

以下限制來自實戰經驗，schema 定義中未明確記載但 validator 會嚴格執行：

1. **`version` 必填**：沒有 version 的 plugin.json 會被 validator 拒絕
2. **`agents` 必須用明確檔案路徑**：不接受目錄路徑（如 `"./agents/"`），必須列舉每個 `.md` 檔案
3. **組件欄位必須是 array**：`agents`、`commands`、`skills` 等組件欄位，即使只有一個 entry 也必須用 array 格式
4. **不要在 plugin.json 中宣告 `hooks`**：見下方說明
5. **不允許自定義欄位**：plugin.json schema 嚴格驗證，任何未在上方欄位定義中列出的 key 都會導致 `Unrecognized key` 錯誤。自定義資料應放在獨立檔案（如 `pipeline.json`）中

### Hooks 自動載入

Claude Code v2.1+ 會**自動載入** `hooks/hooks.json`，不需要在 plugin.json 中宣告。若同時在 manifest 中宣告 `hooks` 欄位，會造成 **Duplicate hooks** 錯誤。

**正確做法**：將 hooks 設定放在 `hooks/hooks.json`，不在 plugin.json 中引用。

### 路徑規則

- 自訂路徑是「補充」預設目錄，**不是**「取代」。
- 所有路徑必須相對於 plugin 根目錄，以 `./` 開頭。

### 範例

```json
{
  "name": "my-awesome-plugin",
  "version": "1.2.0",
  "description": "提供程式碼分析與格式化功能",
  "author": {
    "name": "Dev Team",
    "email": "dev@example.com",
    "url": "https://example.com"
  },
  "license": "MIT",
  "keywords": ["analysis", "formatting"],
  "skills": ["./extra-skills/"],
  "agents": [
    "./agents/reviewer.md",
    "./agents/formatter.md"
  ]
}
```

---

## 三、目錄結構

### 標準結構

```
plugin/
├── .claude-plugin/
│   └── plugin.json          # 僅放 manifest
├── commands/                 # 預設命令位置
├── agents/                   # 預設 agent 位置
├── skills/                   # Agent Skills
├── hooks/
│   └── hooks.json            # Hook 設定
├── .mcp.json                 # MCP 定義
├── .lsp.json                 # LSP 定義
├── scripts/                  # 腳本
├── LICENSE
└── CHANGELOG.md
```

### `.claude-plugin/` 規則

- **僅**包含 `plugin.json`。
- **不要**把 `commands/`、`agents/`、`skills/`、`hooks/` 放在 `.claude-plugin/` 裡面。

---

## 四、安裝與管理

### 安裝方式

1. **CLI**：`claude plugin install <name> [options]`
2. **互動式**：`/plugin install name`
3. **本地測試**：`claude --plugin-dir ./my-plugin`（可指定多個）
4. **Marketplace**：支援 GitHub repos、Git URLs、本地路徑、遠端 URLs
   - 支援分支/標籤：`url#v1.0.0`

### 安裝範圍

| 範圍 | 設定檔位置 | 說明 |
|------|-----------|------|
| `user` | `~/.claude/settings.json` | 個人，跨專案（預設） |
| `project` | `.claude/settings.json` | 團隊，版本控制 |
| `local` | `.claude/settings.local.json` | gitignored |
| `managed` | `managed-settings.json` | 唯讀，僅更新 |

### 快取機制

- 安裝時複製到快取目錄，**非原地使用**。
- 支援的 source 類型：
  - `relative path`
  - `npm`
  - `pip`
  - `url`（`.git`）
  - `github`（`owner/repo`）

### 啟用 / 停用

```bash
# 停用 / 啟用
claude plugin disable name@marketplace
claude plugin enable name@marketplace
/plugin disable name@marketplace
/plugin enable name@marketplace

# 解除安裝
claude plugin uninstall name@marketplace
claude plugin remove name@marketplace
claude plugin rm name@marketplace
```

### 版本管理

- 語義版本控制（Semantic Versioning）。
- 支援預發布版本，例如 `2.0.0-beta.1`。
- 更新指令：`claude plugin update <plugin>`。

### 自動更新

- 官方 Anthropic marketplace **預設啟用**。
- 第三方 marketplace **預設停用**。
- 環境變數 `DISABLE_AUTOUPDATER`：停用所有自動更新。
- 環境變數 `FORCE_AUTOUPDATE_PLUGINS=true`：僅保留插件自動更新。

---

## 五、命名空間

### 格式

```
plugin-name:component-name
```

- Skills：`/my-plugin:hello`
- Agents：顯示為 `plugin-dev:agent-creator`

### 衝突解決（優先順序由高至低）

| 來源 | 優先順序 |
|------|---------|
| `--agents` CLI 參數 | 最高 |
| `.claude/agents/` | 2 |
| `~/.claude/agents/` | 3 |
| plugin `agents/` | 最低 |

### 設定範例

```json
{
  "enabledPlugins": {
    "formatter@acme-tools": true,
    "analyzer@security-plugins": false
  }
}
```

---

## 六、環境變數

| 變數 | 說明 | 備註 |
|------|------|------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin 目錄的絕對路徑 | hooks / MCP / 腳本中**必須**使用 |
| `FORCE_AUTOUPDATE_PLUGINS` | 強制插件自動更新 | 設為 `true` 啟用 |
| `DISABLE_AUTOUPDATER` | 停用所有自動更新 | — |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub 私有倉庫認證 | — |
| `GITLAB_TOKEN` / `GL_TOKEN` | GitLab 認證 | — |
| `BITBUCKET_TOKEN` | Bitbucket 認證 | — |

---

## 七、Output Styles

### 內建樣式

| 名稱 | 說明 |
|------|------|
| `default` | 預設系統提示，專為軟體工程任務最佳化 |
| `explanatory` | 在完成任務時提供教育性的「Insights」，幫助理解實作選擇和程式碼庫模式 |
| `learning` | 協作式邊做邊學模式，Claude 會添加 `TODO(human)` 標記讓使用者自行實作 |

### 格式

Output Styles 是 Markdown 檔案，搭配 frontmatter 定義。

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `name` | 樣式名稱 | 繼承檔名 |
| `description` | 樣式描述，在 `/output-style` UI 中顯示 | 無 |
| `keep-coding-instructions` | 是否保留系統提示中與編碼相關的部分 | `false` |

### 行為

- 直接修改系統提示（system prompt）。
- **所有**輸出樣式都排除高效輸出的指令（如簡潔回應）。
- 自訂樣式**不含**編碼說明，除非 `keep-coding-instructions: true`。
- 所有輸出樣式會在對話期間觸發提醒，讓 Claude 遵守樣式指令。

### 存放位置

| 範圍 | 路徑 |
|------|------|
| 使用者級別 | `~/.claude/output-styles/` |
| 專案級別 | `.claude/output-styles/` |
| Plugin | `plugin/output-styles/`（透過 `outputStyles` 欄位引用） |

### 切換方式

- `/output-style` — 開啟選單選擇
- `/output-style [style]` — 直接切換（如 `/output-style explanatory`）
- 設定保存在 `.claude/settings.local.json` 的 `outputStyle` 欄位

### 範例

```markdown
---
name: concise-output
description: 精簡輸出風格
keep-coding-instructions: true
---

回覆時保持精簡，避免冗長說明。
使用清單格式呈現重點資訊。
```

---

## 八、LSP Servers

### `.lsp.json` 格式

| 欄位 | 必要性 | 說明 |
|------|--------|------|
| `command` | 必要 | LSP 二進位檔路徑 |
| `extensionToLanguage` | 必要 | 副檔名 → 語言映射 |
| `args` | 選填 | 命令列參數 |
| `transport` | 選填 | `stdio`（預設）/ `socket` |
| `env` | 選填 | 環境變數 |
| `initializationOptions` | 選填 | 初始化選項 |
| `settings` | 選填 | Workspace 設定 |
| `workspaceFolder` | 選填 | 工作區路徑 |
| `startupTimeout` | 選填 | 啟動超時（毫秒） |
| `shutdownTimeout` | 選填 | 關閉超時（毫秒） |
| `restartOnCrash` | 選填 | 是否崩潰重啟 |
| `maxRestarts` | 選填 | 最大重啟次數 |

### 範例

```json
{
  "command": "pyright-langserver",
  "args": ["--stdio"],
  "transport": "stdio",
  "extensionToLanguage": {
    ".py": "python"
  },
  "startupTimeout": 10000,
  "restartOnCrash": true,
  "maxRestarts": 3
}
```

### 官方 LSP 插件

| 插件名稱 | 語言 | 所需二進位檔 |
|----------|------|------------|
| `clangd-lsp` | C/C++ | `clangd` |
| `csharp-lsp` | C# | `csharp-ls` |
| `gopls-lsp` | Go | `gopls` |
| `jdtls-lsp` | Java | `jdtls` |
| `lua-lsp` | Lua | `lua-language-server` |
| `php-lsp` | PHP | `intelephense` |
| `pyright-lsp` | Python | `pyright-langserver` |
| `rust-analyzer-lsp` | Rust | `rust-analyzer` |
| `swift-lsp` | Swift | `sourcekit-lsp` |
| `typescript-lsp` | TypeScript / JavaScript | `typescript-language-server` |

> 使用者必須自行安裝對應的語言伺服器二進位檔。若安裝插件後在 `/plugin` 錯誤頁面看到 `Executable not found in $PATH`，需安裝上表中的二進位檔。

---

## 九、MCP Servers（在 plugin 中）

### `.mcp.json` 格式

- 使用 `${CLAUDE_PLUGIN_ROOT}` 引用 plugin 目錄路徑。
- 插件啟用時自動啟動。
- 獨立於使用者的 MCP 設定。
- 在背景 subagent 中**不可用**。

### 範例

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.js"],
      "env": {
        "DATA_DIR": "${CLAUDE_PLUGIN_ROOT}/data"
      }
    }
  }
}
```

---

## 十、Hooks（在 plugin 中）

### 設定檔

`hooks/hooks.json`

### 支援事件

支援全部 **14 個**生命週期事件。

### Hook 類型

支援 **3 種** hook 類型。

### 路徑引用

使用 `${CLAUDE_PLUGIN_ROOT}` 引用 plugin 目錄中的腳本。

### 範例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pre-check.sh"
      }
    ]
  }
}
```

---

## 十一、限制

1. **路徑穿越限制**：不能引用複製目錄外的檔案。
2. **快取複製**：安裝後原始目錄的修改不會反映到已安裝的 plugin。
3. **Symlink**：複製時會被跟隨（followed），可作為引用外部檔案的解法。
4. **URL 型 marketplace**：只下載 `marketplace.json`。
5. **背景 subagent 無 MCP**：MCP servers 在背景 subagent 中不可用。
6. **Subagent 不能巢狀**：不支援 subagent 內部再啟動 subagent。
7. **Session 啟動時載入**：Plugin 在 session 啟動時載入，中途安裝需重啟。
8. **Marketplace 保留名稱**：某些名稱被 marketplace 保留，不可使用。

---

## 十二、偵錯

### 偵錯工具

1. **`claude --debug`**：啟用偵錯模式，支援分類過濾（例如 `"api,hooks"`）。
2. **`/plugin validate .`**：驗證當前目錄的 plugin 結構。
3. **`/plugin` 互動介面**：提供 Discover / Installed / Marketplaces / Errors 頁面。
4. **快取清除**：`rm -rf ~/.claude/plugins/cache`。

### 常見問題表

| 問題 | 可能原因 | 解決方式 |
|------|---------|---------|
| 插件未載入 | 無效的 `plugin.json` | 使用 `/plugin validate` 驗證 |
| 命令未出現 | 目錄結構錯誤 | 確保組件在 plugin 根目錄下 |
| Hooks 未觸發 | 腳本不可執行 | `chmod +x` 賦予執行權限 |
| Duplicate hooks | 在 plugin.json 中宣告了 hooks | 移除 plugin.json 的 hooks 欄位，依賴自動載入 |
| agents 載入失敗 | 使用了目錄路徑 | 改為明確列舉 `.md` 檔案路徑 |
| MCP 失敗 | 缺少 `CLAUDE_PLUGIN_ROOT` | 使用 `${CLAUDE_PLUGIN_ROOT}` 變數 |
| 路徑錯誤 | 使用了絕對路徑 | 改為相對路徑並以 `./` 開頭 |
| Unrecognized key | plugin.json 中有自定義欄位 | 移除非標準欄位，自定義資料放獨立檔案 |

---

## 十三、Marketplace 架構

### `marketplace.json`

- **位置**：`.claude-plugin/marketplace.json`
- **必要欄位**：
  - `name`：Marketplace 名稱
  - `owner`：`{name(必要), email(選填)}`
  - `plugins`：Plugin 陣列
- **選填欄位**：
  - `metadata.description`：描述
  - `metadata.version`：版本
  - `metadata.pluginRoot`：Plugin 根目錄

### 官方插件分類

| 分類 | 說明 | 範例 |
|------|------|------|
| Code Intelligence | LSP 插件，提供定義跳轉、引用查找、型別錯誤 | pyright-lsp, typescript-lsp |
| External Integrations | 預配置 MCP 伺服器，連接外部服務 | github, slack, sentry, linear |
| Development Workflow | 開發任務的命令和代理 | commit-commands, pr-review-toolkit |
| Output Styles | 自訂 Claude 回應方式 | explanatory-output-style |

### Plugin Entry 欄位（plugins 陣列中每個元素）

| 欄位 | 必要 | 說明 |
|------|------|------|
| `name` | 是 | Plugin 名稱 |
| `source` | 是 | 來源路徑或類型 |
| `description` | 否 | Plugin 描述 |
| `author` | 否 | 作者物件 |
| `homepage` | 否 | 文檔 URL |
| `repository` | 否 | 原始碼 URL |
| `license` | 否 | 授權 |
| `keywords` | 否 | 搜尋關鍵字 |
| `category` | 否 | 分類（如 `"workflow"`、`"testing"`） |
| `tags` | 否 | 標籤陣列 |

### `strict` 欄位

| 值 | 行為 |
|----|------|
| `true`（預設） | Marketplace 與 `plugin.json` 合併 |
| `false` | Marketplace 完整定義，`plugin.json` 不得再宣告組件 |

### Source 類型

1. **Relative paths**：本地相對路徑
2. **GitHub**：`{source: "github", repo, ref, sha}`
3. **Git URLs**：`{source: "url", url, ref}`
4. **npm**：（未完全實作）
5. **pip**：（未完全實作）

### 範例

```json
{
  "name": "acme-tools",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.com"
  },
  "plugins": [
    {
      "name": "formatter",
      "source": "github",
      "repo": "acme/formatter-plugin",
      "ref": "v1.0.0"
    },
    {
      "name": "linter",
      "source": "./plugins/linter"
    }
  ]
}
```

### 團隊設定

在 `.claude/settings.json` 中使用 `extraKnownMarketplaces` 與 `enabledPlugins`：

```json
{
  "extraKnownMarketplaces": [
    "https://example.com/marketplace.json",
    "github:acme/plugins"
  ],
  "enabledPlugins": {
    "formatter@acme-tools": true
  }
}
```

### Managed 限制（`strictKnownMarketplaces`）

- **僅限** `managed-settings.json` 設定。
- `undefined`：無限制。
- `[]`（空陣列）：完全鎖定，不允許任何 marketplace。
- 支援的格式：
  - `github`
  - `git`
  - `url`
  - `npm`
  - `file`
  - `directory`
  - `hostPattern`（regex 模式匹配）

---

## 十四、驗證規則

為所有組件定義驗證規則，確保 plugin 結構的正確性：

- **`plugin.json`**：驗證 `name` 為 kebab-case 格式、`version` 符合語義版本規範、`author` 物件包含必要的 `name` 欄位。
- **目錄結構**：確認 `.claude-plugin/` 僅包含 `plugin.json`，組件目錄位於 plugin 根目錄下。
- **路徑**：所有自訂路徑必須以 `./` 開頭且為相對路徑，不允許路徑穿越（`../`）。
- **Hooks**：驗證 `hooks.json` 的事件名稱為支援的 14 個事件之一，腳本檔案存在且具有執行權限。
- **MCP Servers**：驗證 `.mcp.json` 格式正確，`command` 欄位存在，路徑使用 `${CLAUDE_PLUGIN_ROOT}`。
- **LSP Servers**：驗證 `.lsp.json` 包含必要的 `command` 與 `extensionToLanguage` 欄位。
- **Output Styles**：驗證 frontmatter 格式正確，`keep-coding-instructions` 為布林值。
- **Marketplace**：驗證 `marketplace.json` 包含 `name`、`owner`、`plugins` 必要欄位，`strict` 為布林值。

使用 `/plugin validate .` 可一次性執行所有驗證規則。

---

## 十五、進階模式：Registry（Single Source of Truth）

當 plugin 有多個 hook/script/daemon 需要共享 metadata（如 stage 名稱、agent 映射、emoji）時，**集中在一個 registry 模組管理**，避免跨檔案重複定義。

### 問題

```
hooks/task-classifier.js  →  const STAGES = { PLAN: {...}, ... }  // 重複定義
hooks/stage-transition.js →  const STAGES = { PLAN: {...}, ... }  // 又複製一份
bot.js                    →  const STAGES = { PLAN: {...}, ... }  // 再來一份
```

新增一個 stage 需要改 3+ 個檔案，容易遺漏。

### 解法：registry.js

```
scripts/lib/
└── registry.js    ← Single Source of Truth
```

```js
// registry.js
'use strict';

const STAGES = {
  PLAN:   { emoji: '\ud83d\udccb', color: 'purple', agent: 'planner' },
  ARCH:   { emoji: '\ud83c\udfd7\ufe0f',  color: 'cyan',   agent: 'architect' },
  DEV:    { emoji: '\ud83d\udcbb', color: 'yellow', agent: 'developer' },
  REVIEW: { emoji: '\ud83d\udd0d', color: 'blue',   agent: 'code-reviewer' },
  // ...
};

const STAGE_ORDER = Object.keys(STAGES);

// 反向映射：agent 名稱 → stage 名稱
const AGENT_TO_STAGE = {};
for (const [stage, meta] of Object.entries(STAGES)) {
  AGENT_TO_STAGE[meta.agent] = stage;
}

module.exports = { STAGES, STAGE_ORDER, AGENT_TO_STAGE };
```

### 使用方式

所有需要 metadata 的檔案統一 require：

```js
// 任何 hook 或 script
const { STAGES, STAGE_ORDER, AGENT_TO_STAGE } = require('../lib/registry.js');
```

### 優點

| 面向 | 效果 |
|------|------|
| **新增 stage** | 只改 `registry.js` 一處 |
| **一致性** | 所有消費者讀同一份資料 |
| **可測試** | require 後直接 assert |
| **可發現** | 一個檔案看到所有 metadata |

### 何時採用

- 同一份 metadata 被 2+ 個檔案使用
- Plugin 有 pipeline/workflow 概念（多階段、多 agent）
- 需要反向映射（agent → stage、stage → emoji）
