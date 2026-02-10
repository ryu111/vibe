# Vibe — 專案規則

## 專案定位

Vibe 是 Claude Code marketplace（複數 plugins 容器），第一個 plugin 是 `forge`（造工具的工具）。

## 設計哲學

1. **自然語言優先**：`$ARGUMENTS` 模式 — 使用者說意圖，Claude 判讀語意 + 組合執行
2. **對外介面最小化**：只暴露必要的 skill，腳本/模板/驗證全部內部化
3. **語意自動化**：automation = 語意判讀 + 組合使用，不是死板的指令路由
4. **SKILL.md 定義能力邊界和規則**，Claude 自行決定執行步驟
5. **對話即文檔**：對話中確定的方向立即歸檔，不等最後整理

## 架構原則

- Plugins = 模組功能｜Subagents = AI 能力｜Skills = 能力載體
- Hooks = 事件驅動自動化｜Scripts = 內部實作（DRY）｜Templates = 標準化產出
- **單一職責**：驗證腳本歸屬各自 skill 的 `scripts/`，共用函式庫在 plugin 層級 `scripts/lib/`
- **Scripts 目錄規範**：
  - `scripts/lib/` — plugin 層級共用函式庫（被 ≥2 處使用才放這裡）
  - `scripts/hooks/` — hook 腳本（hooks.json 引用的 command scripts）
  - `skills/*/scripts/` — skill 專屬腳本（驗證等）
  - State files 使用 `~/.claude/{name}-{sessionId}.json`（避免多視窗衝突）
- **自動驗證閉環**：PostToolUse hook → 寫完就檢查，使用者無感
- **底層基礎必須正確**：所有組件都要有詳盡規格、驗證腳本
- **低耦合、獨立可裝**：每個 plugin 獨立運作，透過 ECC hooks 事件間接溝通，零 import。有更多 plugin → 更好體驗；缺任何一個 → 完全正常運作（graceful degradation）

## 架構決策

| 決策 | 結論 | 原因 |
|------|------|------|
| 單一 vs 複數 plugin | Marketplace（複數） | 可擴展，各 plugin 獨立 |
| Script/Template 定位 | 內部子功能，非獨立 skill | 不暴露給使用者 |
| 驗證腳本位置 | 各 skill 的 `scripts/` | 單一職責 |
| 共用函式庫位置 | `plugin/scripts/lib/` | 被 ≥2 skill 使用才共用 |
| SKILL.md 設計 | 能力邊界+規則，非指令路由 | 自然語言優先 |
| 腳本對外可見性 | 完全內部化 | 減少使用者認知負擔 |

## 參考文檔

- `docs/reference/` — 6 份組件規格書：plugin / skill / agent / hook / script / template
- `docs/ref/` — 各 plugin 設計文件 + `index.md`（自動生成）+ `pipeline.md`
- `docs/plugin-specs.json` — 組件數量 Single Source of Truth
- `docs/ECC研究報告.md` — ECC 黑客松冠軍分析

## 開發規範

- 所有回覆使用繁體中文
- 組件產出必須通過對應驗證腳本
- **功能需驗證測試**：所有功能在完成前必須經過實際驗證測試，reference specs 以實測為準
- 不確定時詢問，不猜測
