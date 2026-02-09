# Plugin 組件規格書

## 一、概述

Plugin 是 Claude Code 的模組化功能擴展單元。每個 plugin 可包含以下組件：

- **Skills** — 可被呼叫的技能指令
- **Agents** — 自主代理
- **Hooks** — 生命週期事件鉤子
- **MCP Servers** — Model Context Protocol 伺服器
- **LSP Servers** — Language Server Protocol 伺服器
- **Output Styles** — 輸出樣式自訂
- **Commands** — 額外命令

---

## 二、plugin.json Manifest

### Manifest 是可選的

如果省略 `plugin.json`，Claude Code 會自動探索預設目錄中的組件，並從目錄名稱衍生 plugin name。

### `name` 是唯一必要欄位

只要提供 `name`，其餘欄位皆為選填。

### 完整欄位定義

| 欄位 | 類型 | 必要 | 說明 |
|------|------|------|------|
| `name` | `string` | 是（唯一必要） | kebab-case，不含空格。用於組件命名空間 |
| `version` | `string` | 否 | 語義版本號。`plugin.json` 優先於 marketplace entry |
| `description` | `string` | 否 | 插件用途簡述 |
| `author` | `object` | 否 | `{name(必要), email(選填), url(選填)}` |
| `homepage` | `string` | 否 | 文檔 URL |
| `repository` | `string` | 否 | 原始碼 URL |
| `license` | `string` | 否 | MIT、Apache-2.0 等 |
| `keywords` | `array` | 否 | 探索標籤 |
| `commands` | `string \| array` | 否 | 額外命令路徑 |
| `agents` | `string \| array` | 否 | 額外 agent 路徑 |
| `skills` | `string \| array` | 否 | 額外 skill 路徑 |
| `hooks` | `string \| array \| object` | 否 | Hook 設定路徑或行內定義 |
| `mcpServers` | `string \| array \| object` | 否 | MCP 設定路徑或行內定義 |
| `outputStyles` | `string \| array` | 否 | 輸出樣式路徑 |
| `lspServers` | `string \| array \| object` | 否 | LSP 設定路徑或行內定義 |

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
  "skills": "./extra-skills",
  "hooks": "./config/hooks.json",
  "mcpServers": "./config/mcp.json"
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

### 格式

Output Styles 是 Markdown 檔案，搭配 frontmatter 定義。

| 欄位 | 說明 | 預設值 |
|------|------|--------|
| `name` | 樣式名稱 | 繼承檔名 |
| `description` | 樣式描述 | 無 |
| `keep-coding-instructions` | 是否保留編碼指令 | `false` |

### 行為

- 直接修改系統提示（system prompt）。
- **不包含**高效輸出說明。
- 自訂樣式**不含**編碼說明，除非 `keep-coding-instructions: true`。

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

| 插件名稱 | 語言 |
|----------|------|
| `pyright-lsp` | Python |
| `typescript-lsp` | TypeScript / JavaScript |
| `rust-lsp` | Rust |

> 使用者必須自行安裝對應的語言伺服器。

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
| MCP 失敗 | 缺少 `CLAUDE_PLUGIN_ROOT` | 使用 `${CLAUDE_PLUGIN_ROOT}` 變數 |
| 路徑錯誤 | 使用了絕對路徑 | 改為相對路徑並以 `./` 開頭 |

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
