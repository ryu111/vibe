# 架構設計：Dashboard 10 種主題變體

## 現有結構分析

### 目錄結構概覽

```
dashboard/
├── config.json                    # 視覺配置（flowPhases, agentWorkflows, guards 等）
├── data/
│   ├── meta.json                  # pipeline metadata（自動生成）
│   └── progress.json              # 組件進度（自動生成）
├── scripts/
│   ├── generate.js                # 主生成器 — CSS 硬編碼 + HTML 區塊生成
│   ├── generate-vibe-doc.js       # vibe.md 文檔生成（generate.js 引入）
│   ├── refresh.js                 # Stop hook 觸發全鏈（sync → scan → generate → open）
│   ├── sync-data.js               # 同步 meta.json
│   └── scan-progress.js           # 掃描 progress.json
├── tests/
│   └── generate-tokyo-night.test.js  # Tokyo Night 專屬測試
└── dashboard.html                 # 最終產出（gitignored）
```

### 關鍵模式與慣例

1. **CSS 硬編碼字串**：`generate.js` 第 29-297 行將完整 CSS 作為 `const CSS` 字串常量，包含 :root 變數、所有組件樣式、響應式斷點
2. **colorToRgba 映射**：第 458-470 行，將 CSS 變數名映射到 rgba 半透明值，用於動態背景色計算
3. **genColorPalette() 硬編碼**：第 1004-1025 行，Tokyo Night 11 個色值硬編碼在函式內
4. **wrapSection() 統一區塊**：折疊/非折疊兩種模式，id + title + content
5. **genTOC() 導航**：固定左側 TOC，Desktop fixed、Mobile 隱藏
6. **資料驅動**：config.json 定義視覺配置 → generate.js 讀取 → 合併 meta.json/progress.json → 產出 HTML
7. **自包含 HTML**：零外部依賴，CSS 內嵌 `<style>`，JS 內嵌 `<script>`
8. **refresh.js 橋接**：Stop hook → sync → scan → generate → 瀏覽器刷新

### 介面邊界

- **輸入**：`docs/plugin-specs.json` + `dashboard/data/progress.json` + `dashboard/config.json` + `dashboard/data/meta.json`
- **輸出**：`dashboard/dashboard.html`（自包含靜態 HTML）
- **觸發**：`refresh.js`（Stop hook）或手動 `node dashboard/scripts/generate.js`
- **消費者**：瀏覽器（file:// 協議直接開啟）

---

## 方案 A：Theme JSON + Layout 函式模組化

### 設計理念

將 `generate.js` 中的 CSS 和佈局邏輯提取為獨立的 theme JSON + layout 函式模組，每個主題一個 JSON 檔，每種佈局一個函式。

### 目錄樹

```
dashboard/
├── themes/
│   ├── schema.js                  # theme.json schema 驗證
│   ├── tokyo-night/theme.json     # 現有主題（提取為 JSON）
│   ├── polar-dawn/theme.json
│   ├── catppuccin-mocha/theme.json
│   ├── solarized-dark/theme.json
│   ├── github-light/theme.json
│   ├── dracula/theme.json
│   ├── minimal-ink/theme.json
│   ├── synthwave-84/theme.json
│   ├── nord/theme.json
│   ├── one-dark-pro/theme.json
│   ├── index.html                 # 主題選擇器
│   └── {name}/preview.html        # x10 mockup（由 generate.js --theme 產出）
├── scripts/
│   ├── generate.js                # 修改：新增 --theme 參數 + theme 載入
│   ├── layouts/                   # 新增：佈局函式模組
│   │   ├── single-col.js          # 現有佈局（提取）
│   │   ├── dual-col.js
│   │   ├── triple-col.js
│   │   ├── bento.js
│   │   └── timeline.js
│   └── ...（其餘不變）
└── ...（其餘不變）
```

### 介面定義

```javascript
// theme.json schema
{
  "name": "tokyo-night",
  "displayName": "Tokyo Night",
  "description": "深靛藍底 + 霓虹色系",
  "layout": "single-col",     // single-col | dual-col | triple-col | bento | timeline
  "colors": {
    "--bg": "#1a1b26",
    "--surface": "#24283b",
    "--surface2": "#1f2335",
    "--border": "#3b4261",
    "--border-highlight": "#545c7e",
    "--text": "#c0caf5",
    "--text-muted": "#565f89",
    "--accent": "#7aa2f7",
    "--green": "#9ece6a",
    "--yellow": "#e0af68",
    "--red": "#f7768e",
    "--purple": "#bb9af7",
    "--orange": "#ff9e64",
    "--cyan": "#7dcfff",
    "--pink": "#ff007c"
  },
  "tokens": {
    "--radius": "10px",
    "--card-shadow": "0 2px 8px rgba(0,0,0,0.3)"
  },
  "tweaks": {
    "toc": "left-fixed",       // left-fixed | top-tab | top-breadcrumb | scroll-spy | none
    "fontFamily": "-apple-system, BlinkMacSystemFont, ...",
    "pipelineDirection": "vertical",  // vertical | horizontal
    "cardStyle": "bordered"    // bordered | borderless | glow
  }
}

// layouts/{name}.js 介面
// 每個 layout 模組匯出一個函式，接收 sections 資料 → 回傳 HTML 結構
module.exports = {
  wrapPage(sections, theme, tocHtml, footerHtml) → string,
  getCSS(theme) → string,        // 佈局專屬 CSS（與 theme.colors 合併）
  getScript(theme) → string,     // 佈局專屬 JS（TOC 行為等）
};
```

### 資料流

```
theme.json → generate.js --theme {name}
               ↓
         loadTheme(name)
               ↓
         layouts/{layout}.js
               ↓
  ┌────────────┴────────────┐
  │    CSS 層               │    HTML 層
  │  base CSS               │  wrapPage() 決定結構
  │+ theme.colors           │  sections 資料不變
  │+ theme.tokens           │  佈局函式重排區塊
  │+ layout CSS             │
  └────────────┬────────────┘
               ↓
         dashboard.html / preview.html
```

### 優勢

- **分離徹底**：CSS 值 → JSON、佈局邏輯 → 獨立模組，職責清晰
- **新增主題零改 generate.js**：只需加一個 theme.json
- **佈局可獨立測試**：每個 layout 模組可單獨驗證

### 劣勢

- **重構幅度大**：需從 generate.js 提取 CSS 字串 + 所有 gen* 函式的佈局邏輯
- **5 個佈局模組 = 5 份 HTML 結構**：wrapSection/genTOC 等函式需適配每種佈局，維護成本高
- **佈局模組間重複**：大量 HTML 生成邏輯在各 layout 之間重複

---

## 方案 B：Theme JSON + CSS-only 差異化（推薦）

### 設計理念

保持 `generate.js` 的 HTML 生成邏輯不變（single-col 為基礎結構），透過 theme.json 只替換 CSS 層（:root 變數 + 佈局 CSS 覆蓋）。不同佈局用 CSS Grid/Flexbox 重排現有 HTML 結構，不改 HTML。

**核心洞察**：現有 HTML 結構已用語意化 class 標記（`.toc`、`.pipe-header`、`.agent-cards`、`.flow`），CSS 有能力在不改 HTML 的情況下完全改變佈局（Grid 重排、display:none 隱藏、position 調整）。

### 目錄樹

```
dashboard/
├── themes/
│   ├── _base.css.js               # 基礎 CSS（從 generate.js 提取，去除色彩值）
│   ├── _utils.js                  # 共用工具（hexToRgba、loadTheme、validateTheme）
│   ├── tokyo-night/theme.json
│   ├── polar-dawn/theme.json
│   ├── catppuccin-mocha/theme.json
│   ├── solarized-dark/theme.json
│   ├── github-light/theme.json
│   ├── dracula/theme.json
│   ├── minimal-ink/theme.json
│   ├── synthwave-84/theme.json
│   ├── nord/theme.json
│   ├── one-dark-pro/theme.json
│   ├── index.html                 # 主題選擇器（Grid 縮略圖）
│   └── {name}/preview.html        # x10 mockup
├── scripts/
│   ├── generate.js                # 修改：引入 theme 載入，CSS 改為動態組合
│   └── ...（其餘不變）
├── tests/
│   ├── generate-tokyo-night.test.js  # 保留（回歸）
│   └── generate-themes.test.js       # 新增：通用主題測試
└── ...（其餘不變）
```

### 介面定義

```javascript
// theme.json schema（與方案 A 相同的 colors/tokens）
{
  "name": "tokyo-night",
  "displayName": "Tokyo Night",
  "description": "深靛藍底 + 霓虹色系",
  "category": "dark",            // dark | light
  "layout": "single-col",        // 佈局標識
  "colors": { /* 15 個 CSS 變數 */ },
  "tokens": {
    "--radius": "10px",
    "--card-shadow": "0 2px 8px rgba(0,0,0,0.3)"
  },
  "tweaks": {
    "toc": "left-fixed",
    "fontFamily": null,           // null = 使用預設
    "pipelineDirection": "vertical",
    "cardStyle": "bordered"
  },
  "layoutCSS": "..."             // 佈局覆蓋 CSS（純字串，覆蓋基礎 CSS 的佈局規則）
}

// _utils.js
module.exports = {
  loadTheme(themeName) → themeObj,
  validateTheme(themeObj) → { valid: boolean, errors: string[] },
  hexToRgba(hex, alpha) → string,
  buildColorToRgba(colors) → object,  // 自動從 colors 生成 colorToRgba 映射
  buildRootCSS(colors, tokens) → string,  // 組合 :root CSS
};

// _base.css.js
module.exports = {
  getBaseCSS() → string,  // 去除色彩值的基礎 CSS（使用 var() 引用）
};
```

### 資料流

```
theme.json → generate.js --theme {name}
               ↓
         _utils.loadTheme(name)
               ↓
  ┌────────────┴────────────┐
  │    CSS 組合              │    HTML 不變
  │  _base.css.js            │  genFlowDiagram()
  │+ buildRootCSS(colors)    │  genAgentDetails()
  │+ theme.layoutCSS         │  genPluginCards()
  │+ genColorPalette(colors) │  wrapSection()
  └────────────┬────────────┘  genTOC()
               ↓                      │
         合併為最終 CSS ←─────────────┘
               ↓
         dashboard.html / preview.html
```

### 優勢

- **HTML 生成零修改**：所有 gen* 函式完全不動，佈局差異全靠 CSS
- **重構幅度小**：只提取 CSS 字串 + 新增 theme 載入邏輯
- **CSS 覆蓋式佈局**：`layoutCSS` 字串直接覆蓋基礎 CSS，無需理解 HTML 結構
- **colorToRgba 自動化**：`buildColorToRgba()` 從 hex 自動算出 rgba，消除手動維護
- **回歸風險低**：現有 Tokyo Night 測試可直接通過（HTML 結構不變）
- **新增主題成本最低**：一個 JSON 檔 + 一段佈局 CSS

### 劣勢

- **CSS-only 佈局限制**：某些極端佈局（如 Bento Grid）可能需要很長的 CSS 覆蓋
- **layoutCSS 可讀性**：大段 CSS 字串嵌在 JSON 中不夠優雅
- **偵錯困難**：CSS 覆蓋衝突時需理解優先級

### 劣勢緩解

- `layoutCSS` 可改為獨立 `.css` 檔案（如 `tokyo-night/layout.css`），JSON 中只記路徑
- 基礎 CSS 的選擇器已足夠細緻（`.pipe-header`、`.toc`、`.agent-cards`），覆蓋精準

---

## 方案 C：完整 CSS 檔案制（每主題一份完整 CSS）

### 設計理念

不做 CSS 變數替換，而是每個主題一份完整的 CSS 檔案。generate.js 根據 `--theme` 讀取對應 CSS 檔案注入。

### 目錄樹

```
dashboard/
├── themes/
│   ├── tokyo-night/
│   │   ├── theme.json          # 只有 metadata（name, description, category）
│   │   └── style.css           # 完整 CSS（從 generate.js 提取 + 修改）
│   ├── polar-dawn/
│   │   ├── theme.json
│   │   └── style.css
│   └── ...（x10）
├── scripts/
│   ├── generate.js             # 修改：讀取 style.css 替換 const CSS
│   └── ...
└── ...
```

### 優勢

- **最直覺**：每個主題的 CSS 完全獨立，所見即所得
- **設計自由度最高**：不受 CSS 變數 schema 限制

### 劣勢

- **維護地獄**：10 份完整 CSS（每份約 300 行），修改基礎樣式需同步 10 份
- **不可擴展**：新增第 11 個主題需複製 300 行 CSS
- **無法自動化驗證**：無 schema 約束，容易遺漏變數
- **違反 DRY**：90% 的 CSS 是重複的

---

## 方案比較

| 面向 | 方案 A（Layout 模組化） | 方案 B（CSS-only 差異化） | 方案 C（完整 CSS 檔案制） |
|------|----------------------|------------------------|------------------------|
| 複雜度 | 高（5 個佈局模組） | 中（theme 載入 + CSS 組合） | 低（直接替換 CSS） |
| 可擴展性 | 高（加 JSON + layout） | 高（加 JSON + layoutCSS） | 低（複製 300 行 CSS） |
| 破壞性 | 高（重構 gen* 函式） | 低（HTML 生成不動） | 中（CSS 提取） |
| 實作成本 | 高（5 佈局 x HTML 適配） | 中（10 theme.json + CSS 提取） | 中（10 完整 CSS） |
| 維護成本 | 中（佈局模組獨立） | 低（基礎 CSS 單一來源） | 高（10 份 CSS 同步） |
| 回歸風險 | 高（HTML 結構大改） | 低（HTML 零改） | 中（CSS 可能遺漏） |
| 佈局自由度 | 最高（HTML 可完全不同） | 中高（CSS 覆蓋可實現大部分） | 最高（完整 CSS 自由） |

---

## 決策

選擇 **方案 B：Theme JSON + CSS-only 差異化**，原因：

1. **最小破壞性**：HTML 生成邏輯完全不動，現有 Tokyo Night 測試直接通過
2. **最佳 ROI**：用最小的改動（CSS 提取 + theme 載入）實現 10 種視覺變體
3. **可擴展**：新增主題只需一個 JSON + 一段佈局 CSS
4. **colorToRgba 自動化**：消除最脆弱的手動映射（v1.0.28 的痛點）
5. **符合專案慣例**：config.json 已經是「資料驅動視覺」的模式，theme.json 是自然延伸

**佈局 CSS 獨立檔案**：為避免 JSON 中嵌入大段 CSS 字串的可讀性問題，每個主題的佈局覆蓋 CSS 放在獨立的 `layout.css` 檔案中：

```
dashboard/themes/tokyo-night/
├── theme.json        # 色彩 + tokens + tweaks metadata
└── layout.css        # 佈局覆蓋 CSS（可為空 = 使用基礎佈局）
```

**WARNING: 此功能需要視覺設計系統 -- DESIGN 階段將產出 design-system.md 和 HTML mockup。**

---

## 風險與取捨

### 風險 1：CSS-only 佈局能力邊界

**風險**：某些佈局（如 Synthwave Bento、One Dark Pro 三欄）可能需要 HTML 結構調整才能完美呈現

**緩解**：
- 現有 HTML 已使用語意化 class，CSS Grid `grid-template-areas` 可重排大部分結構
- `.toc` 用 `position`/`display` 控制可見性和位置
- 極端情況下，`tweaks` 欄位可觸發 `generate.js` 中的條件邏輯（小範圍 HTML 調整）
- **底線**：Mobile 統一降級 single-col，佈局差異只在 Desktop

### 風險 2：colorToRgba 自動化準確性

**風險**：hex → rgba 自動轉換可能與手工調校的值不完全一致

**緩解**：
- `buildColorToRgba()` 使用確定性算法（hex → RGB → rgba），結果可預測
- 現有 Tokyo Night 的 colorToRgba 值可作為回歸基準

### 風險 3：preview.html 維護成本

**風險**：10 個 preview.html 是否需要隨每次 generate.js 更新而重新生成

**緩解**：
- preview.html 是一次性產出的 mockup，不進入 refresh.js 自動同步鏈
- 正式主題透過 `--theme` 參數切換 `dashboard.html`，preview 只用於設計評審
- 可在 `refresh.js` 中加可選的 `--theme` 傳遞（不影響預設行為）

### 取捨

| 取捨 | 選擇 | 原因 |
|------|------|------|
| 佈局自由度 vs 實作成本 | 犧牲極端佈局，換取零 HTML 修改 | 80% 佈局差異可用 CSS 實現 |
| JSON 嵌入 CSS vs 獨立 CSS 檔 | 獨立 `layout.css` | 可讀性 + IDE 支援 |
| preview.html 自動同步 vs 一次性 | 一次性 mockup | 避免增加 refresh 複雜度 |
| 基礎 CSS 提取 vs 保留原位 | 提取到 `_base.css.js` | Single Source of Truth |

---

## 遷移計畫

### Step 1：基礎設施

1. 建立 `dashboard/themes/` 目錄結構
2. 建立 `_utils.js`（loadTheme, validateTheme, hexToRgba, buildColorToRgba, buildRootCSS）
3. 從 `generate.js` 提取基礎 CSS 到 `_base.css.js`（去除 :root 色彩值）
4. 建立 Tokyo Night `theme.json`（從現有 CSS 硬編碼值提取）
5. 建立 Tokyo Night `layout.css`（空檔案，代表使用基礎佈局）

### Step 2：generate.js 整合

1. 新增 `--theme` CLI 參數解析
2. 新增 `--output` CLI 參數（支援輸出到 themes/{name}/preview.html）
3. 引入 `_utils.js` 和 `_base.css.js`
4. CSS 組合邏輯：baseCSS + buildRootCSS(theme.colors, theme.tokens) + theme.layoutCSS
5. `genColorPalette()` 改為接收 `theme.colors` 參數（動態色板）
6. `colorToRgba` 改為呼叫 `buildColorToRgba(theme.colors)`
7. 預設行為不變（不指定 --theme 時使用 tokyo-night）

### Step 3：9 個新主題定義

1. 每個主題建立 `theme.json` + `layout.css`
2. 按佈局類型分批：
   - single-col 類（Polar Dawn, Catppuccin Mocha, Minimal Ink）：layout.css 只有微調
   - tab 導航類（Solarized Dark）：layout.css 覆蓋 `.toc` 為頂部 tab
   - 雙欄類（GitHub Light）：layout.css 用 CSS Grid 雙欄
   - 三欄類（One Dark Pro）：layout.css 用 CSS Grid 三欄
   - Bento 類（Synthwave '84）：layout.css 用 CSS Grid Bento
   - Timeline 類（Nord）：layout.css 覆蓋 Pipeline 為水平時間軸
   - 極簡類（Dracula）：layout.css 隱藏 TOC、全幅卡片

### Step 4：Preview HTML + 主題選擇器

1. 用 `node generate.js --theme {name} --output themes/{name}/preview.html` 生成 10 個 preview
2. 建立 `themes/index.html`：Grid 佈局，每格一個主題的 iframe 縮略或截圖

### Step 5：測試與文檔

1. 擴展測試覆蓋所有 10 個主題
2. 更新現有 Tokyo Night 測試確保回歸
3. 更新 CLAUDE.md Dashboard 相關段落
