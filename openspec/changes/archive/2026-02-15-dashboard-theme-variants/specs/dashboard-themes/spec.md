# Dashboard Theme System Delta Spec

## ADDED Requirements

### Requirement: Theme JSON Schema

主題配置系統使用 JSON 格式定義每個主題的色彩方案、設計 token 和佈局微調參數。

#### Scenario: theme.json 包含所有必要欄位

WHEN 讀取任意 `dashboard/themes/{name}/theme.json`
THEN 該 JSON 包含以下必要欄位：
  - `name`（string）：主題識別名稱，與目錄名稱一致
  - `displayName`（string）：顯示名稱
  - `description`（string）：一句話描述
  - `category`（"dark" | "light"）：深色或亮色分類
  - `layout`（string）：佈局標識
  - `colors`（object）：15 個 CSS 變數 key-value
  - `tokens`（object）：設計 token（--radius, --card-shadow）
  - `tweaks`（object）：微調參數

#### Scenario: colors 欄位完整性

WHEN 讀取 theme.json 的 `colors` 欄位
THEN 必須包含以下 15 個 CSS 變數：
  `--bg`, `--surface`, `--surface2`, `--border`, `--border-highlight`,
  `--text`, `--text-muted`, `--accent`, `--green`, `--yellow`,
  `--red`, `--purple`, `--orange`, `--cyan`, `--pink`
AND 每個值為合法的 CSS 色值（hex 格式 #xxxxxx）

#### Scenario: 色彩對比度底線

WHEN 計算 theme.json 中 `--text` 對 `--bg` 的色彩對比度
THEN 對比度 >= 4.5:1（WCAG 2.1 AA 標準）

#### Scenario: layout 欄位合法值

WHEN 讀取 theme.json 的 `layout` 欄位
THEN 值為以下之一：`single-col`, `dual-col`, `triple-col`, `bento`, `timeline`

#### Scenario: tweaks.toc 合法值

WHEN 讀取 theme.json 的 `tweaks.toc` 欄位
THEN 值為以下之一：`left-fixed`, `top-tab`, `top-breadcrumb`, `scroll-spy`, `none`

---

### Requirement: 基礎 CSS 提取

將 `generate.js` 中的 CSS 字串常量提取為獨立模組，去除色彩硬編碼，改用 CSS 變數引用。

#### Scenario: _base.css.js 不包含色彩硬編碼

WHEN 讀取 `dashboard/themes/_base.css.js` 的 `getBaseCSS()` 回傳值
THEN 不包含任何 hex 色值字串（#xxxxxx 格式）
AND 所有色彩引用都使用 `var(--name)` 格式

#### Scenario: 基礎 CSS 包含所有組件樣式

WHEN 呼叫 `getBaseCSS()`
THEN 回傳的 CSS 包含以下選擇器：
  `.toc`, `.pipe-header`, `.agent-cards`, `.plugin-card`,
  `.flow`, `.stats`, `.build-order`, `.color-palette`,
  `.compact-progress`, `details`, `summary`

#### Scenario: 基礎 CSS 包含三斷點響應式規則

WHEN 呼叫 `getBaseCSS()`
THEN 回傳的 CSS 包含三個 @media 查詢：
  - `max-width: 639px`（Mobile）
  - `min-width: 640px and max-width: 1023px`（Tablet）
  - `min-width: 1024px`（Desktop）

---

### Requirement: 主題工具函式

`_utils.js` 提供主題載入、驗證、色彩轉換的共用函式。

#### Scenario: loadTheme 載入指定主題

WHEN 呼叫 `loadTheme('tokyo-night')`
THEN 回傳 `dashboard/themes/tokyo-night/theme.json` 的完整物件
AND 物件包含額外的 `layoutCSS` 屬性（從 `layout.css` 讀取，檔案不存在時為空字串）

#### Scenario: loadTheme 找不到主題時報錯

WHEN 呼叫 `loadTheme('non-existent')`
THEN 拋出包含主題名稱的錯誤訊息

#### Scenario: validateTheme 檢查必要欄位

WHEN 呼叫 `validateTheme({ name: 'test' })`
THEN 回傳 `{ valid: false, errors: [...] }`
AND errors 包含所有缺失欄位的描述

#### Scenario: hexToRgba 色彩轉換

WHEN 呼叫 `hexToRgba('#7aa2f7', 0.06)`
THEN 回傳 `'rgba(122,162,247,0.06)'`

#### Scenario: buildColorToRgba 自動映射

WHEN 呼叫 `buildColorToRgba({ '--accent': '#7aa2f7', '--green': '#9ece6a' })`
THEN 回傳包含 `'var(--accent)': 'rgba(122,162,247,0.06)'` 和 `'var(--green)': 'rgba(158,206,106,0.06)'` 的物件
AND `'var(--text-muted)'` 映射使用 `--text` 的 RGB 值（非 `--text-muted`）以獲得較亮的半透明底色

#### Scenario: buildRootCSS 組合 :root

WHEN 呼叫 `buildRootCSS({ '--bg': '#1a1b26' }, { '--radius': '10px' })`
THEN 回傳 `:root { --bg: #1a1b26; --radius: 10px; }` 格式的 CSS 字串

---

### Requirement: generate.js 主題載入機制

`generate.js` 新增 `--theme` 和 `--output` CLI 參數，支援切換主題和輸出路徑。

#### Scenario: 預設行為不變

WHEN 執行 `node generate.js`（不帶任何參數）
THEN 產出的 `dashboard.html` 與修改前完全相同
AND 使用 Tokyo Night 主題

#### Scenario: --theme 參數切換主題

WHEN 執行 `node generate.js --theme polar-dawn`
THEN 產出的 `dashboard.html` 使用 Polar Dawn 色彩方案

#### Scenario: --output 參數自訂輸出路徑

WHEN 執行 `node generate.js --theme nord --output themes/nord/preview.html`
THEN 產出寫入 `dashboard/themes/nord/preview.html`

#### Scenario: --theme 搭配 --output 生成 preview

WHEN 執行 `node generate.js --theme synthwave-84 --output themes/synthwave-84/preview.html`
THEN 在指定路徑產出完整的自包含 HTML

#### Scenario: 無效 --theme 名稱

WHEN 執行 `node generate.js --theme non-existent`
THEN 程式輸出錯誤訊息並以非零 exit code 結束

---

### Requirement: genColorPalette 動態化

`genColorPalette()` 改為接收主題色彩參數，動態生成色板。

#### Scenario: 動態色板反映主題色系

WHEN 使用 Polar Dawn 主題生成 dashboard.html
THEN 色板區塊的色塊數量為 11（8 語意色 + 3 背景色）
AND 每個色塊的 hex 值對應 Polar Dawn theme.json 的色值

#### Scenario: Tokyo Night 回歸

WHEN 使用 Tokyo Night 主題生成 dashboard.html
THEN 色板內容與修改前完全一致

---

### Requirement: 10 個主題定義

每個主題包含 `theme.json`（色彩 + metadata）和 `layout.css`（佈局覆蓋 CSS）。

#### Scenario: 10 個主題目錄存在

WHEN 掃描 `dashboard/themes/` 目錄
THEN 存在以下 10 個子目錄，每個包含 `theme.json`：
  tokyo-night, polar-dawn, catppuccin-mocha, solarized-dark,
  github-light, dracula, minimal-ink, synthwave-84, nord, one-dark-pro

#### Scenario: 每個主題可成功生成 HTML

WHEN 對 10 個主題分別執行 `node generate.js --theme {name}`
THEN 每個都成功產出完整的 HTML
AND HTML 包含 `<!DOCTYPE html>` 開頭
AND HTML 的 `:root` 變數對應該主題的 colors

#### Scenario: 亮色主題使用深色文字

WHEN 讀取 category 為 "light" 的主題（polar-dawn, github-light, minimal-ink）
THEN `--text` 值的亮度 < 50%（深色文字）
AND `--bg` 值的亮度 > 70%（亮色背景）

#### Scenario: layout.css 在 Mobile 時降級為 single-col

WHEN 任何非 single-col 佈局的主題在 Mobile 斷點（< 640px）下渲染
THEN 佈局等效於 single-col（CSS 媒體查詢覆蓋）

---

### Requirement: 5 種佈局模式

透過 `layout.css` 覆蓋基礎 CSS 實現不同佈局。

#### Scenario: single-col 佈局（Tokyo Night, Polar Dawn, Catppuccin Mocha, Minimal Ink）

WHEN layout 為 `single-col`
THEN 內容以單欄垂直排列
AND `body` max-width 在 800px-1100px 之間

#### Scenario: dual-col 佈局（GitHub Light）

WHEN layout 為 `dual-col`
THEN Desktop 時內容分為左右兩欄
AND 左欄佔 ~60% 放 Pipeline + Agent 詳情
AND 右欄佔 ~40% 放統計 + 色板

#### Scenario: triple-col 佈局（One Dark Pro）

WHEN layout 為 `triple-col`
THEN Desktop 時內容分為三欄
AND 左欄為窄欄 TOC
AND 中欄為主內容
AND 右欄為窄欄統計

#### Scenario: bento 佈局（Synthwave '84）

WHEN layout 為 `bento`
THEN Desktop 時使用 CSS Grid 自由網格
AND 不同區塊佔據不同大小的格子

#### Scenario: timeline 佈局（Nord）

WHEN layout 為 `timeline`
THEN Pipeline 階段以水平時間軸呈現（可橫向滾動）
AND TOC 改為頂部水平導航條

---

### Requirement: 主題選擇器

`dashboard/themes/index.html` 提供所有主題的一覽預覽。

#### Scenario: 主題選擇器包含 10 個主題

WHEN 開啟 `dashboard/themes/index.html`
THEN 頁面以 Grid 佈局展示 10 個主題
AND 每個主題卡片包含：名稱、描述、色彩預覽
AND 點擊可跳轉到對應的 `preview.html`

#### Scenario: 主題選擇器自包含

WHEN 檢查 `dashboard/themes/index.html`
THEN 無外部 CDN 引用
AND CSS 內嵌
AND 可直接用 `file://` 協議開啟

---

### Requirement: Preview HTML 生成

每個主題有對應的 `preview.html` mockup。

#### Scenario: 10 個 preview.html 存在

WHEN 掃描 `dashboard/themes/{name}/`
THEN 每個主題目錄包含 `preview.html`

#### Scenario: preview.html 結構完整

WHEN 讀取任意 `preview.html`
THEN 包含 `<!DOCTYPE html>`、`<html lang="zh-Hant">`、`<head>`、`<body>`
AND CSS 內嵌在 `<style>` 中
AND 無外部依賴

---

## MODIFIED Requirements

### Requirement: generate.js CSS 組合機制

原有行為：`const CSS` 為固定的 Tokyo Night CSS 字串常量。

修改後：CSS 由三部分動態組合：
1. **基礎 CSS**（`_base.css.js`）：去除色彩值的通用樣式
2. **:root 變數**（`buildRootCSS()`）：從 theme.json 的 colors + tokens 生成
3. **佈局覆蓋**（`layout.css`）：主題專屬的佈局調整 CSS

組合順序決定優先級：基礎 < :root < 佈局覆蓋。

### Requirement: colorToRgba 自動化

原有行為：`const colorToRgba` 為手動維護的靜態映射物件。

修改後：由 `buildColorToRgba(theme.colors)` 自動從 hex 值計算生成。特殊規則：`var(--text-muted)` 的 rgba 使用 `--text` 的 RGB 值（非 `--text-muted`），以獲得較亮的半透明底色。

### Requirement: genColorPalette 參數化

原有行為：`genColorPalette()` 無參數，硬編碼 Tokyo Night 11 個色值。

修改後：`genColorPalette(colors)` 接收 colors 物件，動態生成色板。11 個色塊的組成不變（8 語意色 + bg + surface + border）。

---

## REMOVED Requirements

（無移除項目）
