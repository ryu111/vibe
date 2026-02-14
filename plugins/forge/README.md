# Forge — Claude Code Plugin Builder

造工具的工具。幫你建立、驗證、管理 Claude Code plugin 的所有組件。

## Quick Start

```
/forge:scaffold    # 建立 plugin 結構（plugin.json + 目錄骨架）
/forge:skill       # 建立 Skill（SKILL.md + references/ + scripts/）
/forge:agent       # 建立 Agent（.md frontmatter + 系統提示）
/forge:hook        # 建立 Hook + Script（hooks.json 條目 + 腳本）
```

每個 skill 都遵循 **推斷 → 展示 → 確認 → 執行** 流程：
1. 從自然語言推斷你要什麼
2. 展示預覽和風險
3. 一個選擇題確認
4. 執行並自動驗證

## 組件與驗證

| Skill | 組件類型 | 驗證規則 | 規格書 |
|-------|---------|:-------:|--------|
| `/forge:scaffold` | Plugin 結構 | P-01 ~ P-15 (15) | `skills/scaffold/references/plugin-spec.md` |
| `/forge:skill` | Skill | V-SK-01 ~ V-SK-18 (18) | `skills/skill/references/skill-spec.md` |
| `/forge:agent` | Agent | V-AG-01 ~ V-AG-19 (19) | `skills/agent/references/agent-spec.md` |
| `/forge:hook` | Hook + Script | V-HK-01~19 + V-SC-01~10 (29) | `skills/hook/references/hook-spec.md` + `script-spec.md` |

**總計 81 條驗證規則**，涵蓋 5 種組件類型。

## 驗證規則索引

### Plugin (P-01 ~ P-15)

| 規則 | 說明 |
|------|------|
| P-01 | `.claude-plugin/plugin.json` 存在 |
| P-02 | `name` 為 kebab-case |
| P-03 | `version` 為合法 semver |
| P-04 | 必要欄位齊全（name, version, description） |
| P-04b | 無未知欄位 |
| P-05 | 目錄結構正確 |
| P-10 | `pipeline.json` 存在（選填） |
| P-11 | `stages` 為非空陣列 |
| P-12 | 每個 stage 有 `name`、`agent`、`skill` |
| P-13 | `provides` 為非空陣列 |
| P-14 | Agent 檔案存在 |
| P-15 | Skill 目錄存在 |

### Skill (V-SK-01 ~ V-SK-18)

| 規則 | 說明 |
|------|------|
| V-SK-01 | SKILL.md 存在 |
| V-SK-02 | Frontmatter 格式正確 |
| V-SK-03 | `description` 欄位存在 |
| V-SK-04~18 | 內容、引用、腳本、命名等完整驗證 |

### Agent (V-AG-01 ~ V-AG-19)

| 規則 | 說明 |
|------|------|
| V-AG-01 | `.md` 檔案存在 |
| V-AG-02 | Frontmatter 格式正確 |
| V-AG-03~18 | model、tools、permissionMode 等驗證 |
| V-AG-19 | 色彩為 8 合法值之一 |

### Hook (V-HK-01 ~ V-HK-19)

| 規則 | 說明 |
|------|------|
| V-HK-01 | `hooks.json` 存在 |
| V-HK-02~17 | 事件、腳本路徑、matcher 格式驗證 |
| V-HK-18 | matcher 為字串型別（非 null） |
| V-HK-19 | flat vs grouped 格式相容性 |

### Script (V-SC-01 ~ V-SC-10)

| 規則 | 說明 |
|------|------|
| V-SC-01 | 腳本檔案存在 |
| V-SC-02 | Shebang 正確 |
| V-SC-03 | 執行權限 (755) |
| V-SC-04~08 | 安全性、JSON I/O、exit code 等 |
| V-SC-09 | require/source 引用存在 |
| V-SC-10 | 語法檢查通過 |

## UX 原則

- **推斷 → 展示 → 確認 → 執行**（非「收集參數 → 執行」）
- **先做再改 > 先問再做** — 使用者負責意圖，Claude 負責細節
- **AskUserQuestion** 用於可視化預覽 + 風險揭露 + 一個選擇題
- **PostToolUse 自動驗證** — 寫完組件自動跑驗證腳本

## 進階模式

規格書中記錄了從 vibe plugin 實踐中提煉的進階開發模式：

- **Registry 模式** — 集中管理 metadata，消除跨模組重複（見 `plugin-spec.md`）
- **純函式規則模組** — Hook I/O 與決策邏輯分離（見 `script-spec.md`）
