# 實作任務

## 1. 基礎設施：主題目錄與工具函式

- [x] 1.1 建立 `dashboard/themes/` 目錄結構 | files: `dashboard/themes/`
- [x] 1.2 建立 `dashboard/themes/_utils.js`：loadTheme, validateTheme, hexToRgba, buildColorToRgba, buildRootCSS | files: `dashboard/themes/_utils.js`
- [x] 1.3 從 `generate.js` 提取基礎 CSS 到 `dashboard/themes/_base.css.js`，去除 :root 色彩值 | files: `dashboard/themes/_base.css.js`, `dashboard/scripts/generate.js`
- [x] 1.4 建立 Tokyo Night `theme.json`（從 generate.js CSS 硬編碼值提取） | files: `dashboard/themes/tokyo-night/theme.json`
- [x] 1.5 建立 Tokyo Night `layout.css`（空檔案 = 使用基礎佈局） | files: `dashboard/themes/tokyo-night/layout.css`

## 2. generate.js 主題整合

- [x] 2.1 新增 --theme 和 --output CLI 參數解析 | files: `dashboard/scripts/generate.js` | depends: 1.2, 1.3
- [x] 2.2 CSS 組合邏輯：baseCSS + buildRootCSS() + layoutCSS | files: `dashboard/scripts/generate.js` | depends: 1.2, 1.3
- [x] 2.3 colorToRgba 改為呼叫 buildColorToRgba(theme.colors) | files: `dashboard/scripts/generate.js` | depends: 1.2
- [x] 2.4 genColorPalette() 改為接收 colors 參數（動態色板） | files: `dashboard/scripts/generate.js` | depends: 1.2
- [x] 2.5 預設行為驗證：不帶參數時產出與修改前相同的 HTML | files: `dashboard/scripts/generate.js` | depends: 2.1, 2.2, 2.3, 2.4

## 3. 9 個新主題定義

- [x] 3.1 Polar Dawn（single-col, light）：theme.json + layout.css | files: `dashboard/themes/polar-dawn/`
- [x] 3.2 Catppuccin Mocha（single-col, dark）：theme.json + layout.css | files: `dashboard/themes/catppuccin-mocha/`
- [x] 3.3 Solarized Dark（single-col + top-tab, dark）：theme.json + layout.css | files: `dashboard/themes/solarized-dark/`
- [x] 3.4 GitHub Light（dual-col, light）：theme.json + layout.css | files: `dashboard/themes/github-light/`
- [x] 3.5 Dracula（single-col + scroll-spy, dark）：theme.json + layout.css | files: `dashboard/themes/dracula/`
- [x] 3.6 Minimal Ink（single-col + none, light）：theme.json + layout.css | files: `dashboard/themes/minimal-ink/`
- [x] 3.7 Synthwave '84（bento, dark）：theme.json + layout.css | files: `dashboard/themes/synthwave-84/`
- [x] 3.8 Nord（timeline, dark）：theme.json + layout.css | files: `dashboard/themes/nord/`
- [x] 3.9 One Dark Pro（triple-col, dark）：theme.json + layout.css | files: `dashboard/themes/one-dark-pro/`

## 4. Preview HTML + 主題選擇器

- [x] 4.1 用 generate.js --theme --output 生成 10 個 preview.html | files: `dashboard/themes/*/preview.html` | depends: 2.5, 3.1-3.9
- [x] 4.2 建立 `dashboard/themes/index.html` 主題選擇器（Grid 一覽） | files: `dashboard/themes/index.html` | depends: 4.1

## 5. 測試與驗證

- [x] 5.1 建立 `dashboard/tests/generate-themes.test.js` 通用主題測試 | files: `dashboard/tests/generate-themes.test.js` | depends: 2.5
- [x] 5.2 確認現有 Tokyo Night 測試全數通過（回歸） | files: `dashboard/tests/generate-tokyo-night.test.js` | depends: 2.5
- [x] 5.3 執行所有測試確認功能正確 | depends: 5.1, 5.2
- [x] 5.4 確認 lint/format 通過 | depends: 5.3
- [x] 5.5 目視檢查 10 個 preview.html 在瀏覽器中的呈現 | depends: 4.1

## 6. DEV 修復（REVIEW 發現）

- [x] 6.1 [C-1] 修復 buildRootCSS 半透明 CSS 變數命名邏輯錯誤（0.06→"006" 應為 "06"） | files: `dashboard/themes/_utils.js` | depends: 5.5
- [x] 6.2 [H-2] 移除 generate.js 中 7 處硬編碼 rgba 值，改用 CSS 變數 | files: `dashboard/scripts/generate.js` | depends: 6.1
- [x] 6.3 [H-1] 為 6 個非 left-fixed TOC 主題新增 body padding-left 覆蓋 | files: `dashboard/themes/{solarized-dark,github-light,dracula,synthwave-84,nord,minimal-ink}/layout.css` | depends: 5.5
- [x] 6.4 [M-1] 實作 tweaks 消費邏輯（fontFamily/maxWidth/spacing → CSS 變數） | files: `dashboard/themes/_utils.js`, `dashboard/scripts/generate.js` | depends: 6.1
- [x] 6.5 [M-2] 改善 validateTheme 頂層欄位檢查（`!obj[field]` → `!(field in obj)`） | files: `dashboard/themes/_utils.js` | depends: 6.1
- [x] 6.6 整合測試：多主題生成驗證（tokyo-night/dracula/github-light/minimal-ink） | depends: 6.1, 6.2, 6.3, 6.4, 6.5
