# 實作任務

## 1. CSS 色系替換 + 設計 Token
- [x] 1.1 替換 `:root` 變數值：GitHub Dark → Tokyo Night（15 個色值 + 2 個設計 token）| files: `dashboard/scripts/generate.js`
- [x] 1.2 更新 `colorToRgba` 映射表：8 個 CSS 變數 → Tokyo Night 對應 rgba 值 | files: `dashboard/scripts/generate.js`
- [x] 1.3 替換 CSS 中所有硬編碼的 `border-radius` 為 `var(--radius)` 引用 | files: `dashboard/scripts/generate.js`
- [x] 1.4 替換 CSS 中所有硬編碼的 `rgba()` 半透明值為 Tokyo Night 色基 | files: `dashboard/scripts/generate.js`
- [x] 1.5 新增 `--border-highlight` 使用處（`.plugin-card:hover` 等 hover 效果）| files: `dashboard/scripts/generate.js`

## 2. 資訊架構重組 + 折疊面板
- [x] 2.1 新增 `wrapSection(id, title, content, opts)` 輔助函式 | files: `dashboard/scripts/generate.js` | depends: 1.1
- [x] 2.2 新增 `genCompactProgress(pct, progress)` 函式 | files: `dashboard/scripts/generate.js` | depends: 1.1
- [x] 2.3 新增 `<details>/<summary>` CSS 樣式（cursor、hover、展開動畫、箭頭指示）| files: `dashboard/scripts/generate.js` | depends: 1.1
- [x] 2.4 修改 `generate()` 函式：重排區塊順序（精簡進度 → 流程圖 → 折疊區塊）| files: `dashboard/scripts/generate.js` | depends: 2.1, 2.2, 2.3
- [x] 2.5 為每個區塊加入 `id` 屬性（供 TOC 錨點使用）| files: `dashboard/scripts/generate.js` | depends: 2.4

## 3. TOC 導航 + 色板 + 響應式
- [x] 3.1 新增 `genTOC(sections)` 函式：生成固定側邊導航列表 | files: `dashboard/scripts/generate.js` | depends: 2.5
- [x] 3.2 新增 TOC CSS 樣式：fixed 定位、hover 效果、active 高亮 | files: `dashboard/scripts/generate.js` | depends: 3.1
- [x] 3.3 新增 `genColorPalette()` 函式：渲染 11 色（8 語意色 + bg + surface + border）| files: `dashboard/scripts/generate.js` | depends: 1.1
- [x] 3.4 新增色板 CSS 樣式 | files: `dashboard/scripts/generate.js` | depends: 3.3
- [x] 3.5 新增精簡進度列 CSS 樣式 | files: `dashboard/scripts/generate.js` | depends: 2.2
- [x] 3.6 新增響應式 `@media` 斷點 CSS（< 640px / 640-1024px / > 1024px）| files: `dashboard/scripts/generate.js` | depends: 3.2
- [x] 3.7 在 `generate()` 中整合 TOC 和色板區塊 | files: `dashboard/scripts/generate.js` | depends: 3.1, 3.3, 2.4

## 4. 驗證
- [x] 4.1 執行 `node dashboard/scripts/generate.js` 確認零錯誤
- [x] 4.2 執行完整同步鏈 `node dashboard/scripts/refresh.js` 確認全鏈正常
- [x] 4.3 目視檢查 dashboard.html 色系一致性（與 style-showcase.html Tokyo Night 比對）
- [x] 4.4 確認所有 `<details>` 面板可正常展開/收合
- [x] 4.5 確認 TOC 連結跳轉到對應區塊
- [x] 4.6 確認色板顯示正確的 hex 值
- [x] 4.7 確認 guard cards、return rail、fork connectors 等特殊元素色彩正確
- [x] 4.8 確認 Mobile（< 640px）pipeline stages 垂直堆疊
- [x] 4.9 確認 Desktop（> 1024px）TOC 固定顯示、agent cards 雙欄
- [x] 4.10 確認 `docs/ref/index.md` 和 `docs/ref/vibe.md` 自動生成正常（不受影響）
- [x] 4.11 確認 footer 版號動態化仍正常
- [x] 4.12 確認 lint/format 通過
- [x] 4.13 更新 `plugins/vibe/.claude-plugin/plugin.json` 版號（patch +1）
