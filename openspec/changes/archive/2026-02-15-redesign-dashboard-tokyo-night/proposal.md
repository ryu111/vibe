# Dashboard Tokyo Night 主題重設計

## 為什麼（Why）

目前 `dashboard/dashboard.html` 使用 GitHub Dark 色系（`--bg: #0d1117`、`--surface: #161b22`），雖然功能完整，但存在以下限制：

1. **視覺一致性不足**：開發者日常使用 VS Code Tokyo Night 主題，dashboard 的 GitHub Dark 色系造成視覺切換感
2. **資訊架構扁平**：所有區塊等權重平鋪（整體進度 → 統計 → 建構順序 → 開發流程 → Agent 詳細流程 → Plugin 詳情），首屏被進度條和統計佔據，最重要的 Pipeline 流程圖和 Agent 工作流需要滾動才能看到
3. **互動性不足**：純靜態渲染，所有詳情全展開，頁面很長。hook 詳情、agent 詳細流程等次要資訊佔據大量版面
4. **無導航機制**：沒有 TOC 或錨點，長頁面內定位困難
5. **無響應式設計**：固定 `max-width: 1100px` 單欄佈局，行動裝置體驗差

`style-showcase.html` 已經定義了 Tokyo Night 色系變數並驗證了視覺效果（`[data-theme="tokyo-night"]`），但尚未應用到實際的 dashboard。

## 變更內容（What Changes）

### 1. CSS 色系全面替換
- `:root` 從 GitHub Dark 切換到 Tokyo Night（`--bg: #1a1b26`、`--surface: #24283b` 等）
- 所有 `rgba()` 半透明色值同步更新以匹配新底色
- 新增 `--surface2: #1f2335`、`--border-highlight: #545c7e` 等 showcase 已定義的進階變數
- 新增 `--radius: 10px`、`--card-shadow: 0 2px 8px rgba(0,0,0,0.3)` 等設計 token
- `colorToRgba` 映射表（generate.js 內）同步更新

### 2. 資訊架構重組
- **首屏**：精簡版進度指示（一行）+ Pipeline 流程圖 + Agent 工作流
- **次屏**：折疊式 hook 詳情（`<details>`）、折疊式 Agent 詳細流程（`<details>`）
- **底部**：組件統計 + Plugin 卡片（可折疊）
- 新增固定 TOC 側邊導航或頂部導航（純 CSS/JS，零依賴）

### 3. 互動增強
- `<details>/<summary>` 折疊面板：hook 詳情、agent 詳細節點流程、plugin 組件清單
- 內部錨點跳轉（每個 `<h2>` 區塊加 `id`，TOC 連結）
- 色板預覽區塊：展示 Tokyo Night 完整 10 色 + bg/surface/border

### 4. 響應式設計
- Mobile（< 640px）：單欄、pipeline stages 改垂直堆疊、agent cards 單欄
- Tablet（640-1024px）：自適應 grid、pipeline stages 可換行
- Desktop（> 1024px）：雙欄 agent cards、pipeline stages 橫排

### 5. generate.js 同步修改
- CSS 常量全面更新
- HTML 結構修改（加入 `<details>`、`id` 錨點、TOC、色板區塊）
- `colorToRgba` 映射表更新
- 新增 `genTOC()`、`genColorPalette()` 函式
- 響應式 CSS media queries

**非破壞性變更**：不改變 config.json 資料結構、不改變自動同步鏈架構、不新增外部依賴。

## 能力定義（Capabilities）

- [ ] Capability 1：Tokyo Night CSS 色系定義 — `:root` 變數完整替換，包含 bg/surface/surface2/border/border-highlight/text/text-muted + 8 色語意色 + radius/shadow token
- [ ] Capability 2：資訊架構重組 — 首屏聚焦 Pipeline + Agent 工作流，次要資訊折疊
- [ ] Capability 3：`<details>` 折疊面板 — hook 詳情、agent 詳細流程、plugin 組件清單可展開/收合
- [ ] Capability 4：TOC 導航 — 固定位置的區塊導航（內部錨點跳轉）
- [ ] Capability 5：色板預覽區塊 — 展示 Tokyo Night 10 色 + 背景/表面/邊框
- [ ] Capability 6：響應式佈局 — 3 斷點（mobile/tablet/desktop）自適應
- [ ] Capability 7：generate.js 完整同步 — CSS/HTML 生成邏輯與新設計對齊

## 影響分析（Impact）

- **受影響檔案**：
  - `dashboard/scripts/generate.js` — 主要修改目標（CSS + HTML 生成函式）
  - `dashboard/dashboard.html` — 自動產出物（由 generate.js 生成）
  - `docs/ref/index.md` — 自動產出物（dashboard.html 路徑引用不變）
  - `docs/ref/vibe.md` — 自動產出物（dashboard 相關描述可能需要更新）
- **受影響模組**：dashboard
- **registry.js 變更**：否
- **hook 變更**：無
- **config.json 變更**：否（資料結構不變）
- **自動同步鏈**：不受影響（Stop hook → refresh.js → sync-data.js + scan-progress.js → generate.js → dashboard.html 鏈路不變）

## 階段分解

### Phase 1：CSS 色系替換 + 設計 Token

- **產出**：generate.js 中 CSS 常量完全切換到 Tokyo Night 色系
- **修改檔案**：
  - `/Users/sbu/projects/vibe/dashboard/scripts/generate.js` — CSS 常量（約 L29-L243）
- **具體工作**：
  1. 替換 `:root` 變數值（從 GitHub Dark → Tokyo Night）
  2. 新增 `--surface2`、`--border-highlight`、`--radius`、`--card-shadow` 變數
  3. 更新所有 `rgba()` 半透明背景色以匹配新底色
  4. 更新 `colorToRgba` 映射表（約 L405-L415）
  5. 調整卡片、進度條等組件的 border-radius 和 shadow
- **依賴**：無
- **風險**：rgba 色值可能遺漏某些元素，需要視覺檢查
- **驗收條件**：
  - 執行 `node dashboard/scripts/generate.js` 無報錯
  - 開啟 dashboard.html 確認色系一致
  - 與 `style-showcase.html` Tokyo Night 色板目視對比無色差

### Phase 2：資訊架構重組 + 折疊面板

- **產出**：HTML 結構重組（首屏聚焦 + 折疊次要資訊）
- **修改檔案**：
  - `/Users/sbu/projects/vibe/dashboard/scripts/generate.js` — `generate()` 函式（約 L894-L966）、`genAgentDetails()` 函式
- **具體工作**：
  1. 重排 `generate()` 中各區塊的順序：
     - 精簡版進度（一行式，移除大型進度條區塊）
     - 開發流程（Pipeline 流程圖，保持現有 `genFlowDiagram()`）
     - Agent 詳細流程（`genAgentDetails()`，外包 `<details>`）
     - 統計 + 建構順序（外包 `<details>`）
     - Plugin 詳情（外包 `<details>`）
  2. 為每個 `<h2>` 區塊加入 `id` 屬性
  3. 新增 `<details>/<summary>` 包裹次要區塊
  4. 更新 `<details>` 的 CSS 樣式（summary 游標、展開動畫、箭頭指示）
- **依賴**：Phase 1
- **風險**：折疊面板可能影響已有的 CSS 選擇器定位
- **驗收條件**：
  - 首屏（不滾動）可見 Pipeline 流程圖
  - 所有 `<details>` 面板可正常展開/收合
  - 展開後內容排版與原版一致

### Phase 3：TOC 導航 + 色板 + 響應式

- **產出**：TOC 導航、色板預覽、響應式 CSS
- **修改檔案**：
  - `/Users/sbu/projects/vibe/dashboard/scripts/generate.js` — CSS（新增 media queries）、新增 `genTOC()` 和 `genColorPalette()` 函式、`generate()` 整合
- **具體工作**：
  1. **TOC 導航**：
     - 新增 `genTOC()` 函式，生成固定位置的導航列表
     - CSS：fixed/sticky 定位、hover 效果、active 高亮
     - JS：scroll 監聽（可選，用 `IntersectionObserver` 標記 active）
  2. **色板預覽**：
     - 新增 `genColorPalette()` 函式，渲染 10 色 + bg/surface/border 色塊
     - 每個色塊顯示色名 + hex 值
  3. **響應式 CSS**：
     - `@media (max-width: 640px)`：pipeline stages 垂直、agent cards 單欄、TOC 隱藏或改漢堡選單
     - `@media (max-width: 1024px)`：grid 自適應
     - `@media (min-width: 1024px)`：agent cards 雙欄
  4. 將色板區塊放入 `<details>` 可折疊（次要資訊）
- **依賴**：Phase 2
- **風險**：
  - fixed TOC 可能與頁面內容重疊（需測試不同視窗寬度）
  - 響應式斷點可能需要調整以配合現有 agent card 最小寬度
- **驗收條件**：
  - TOC 連結可跳轉到對應區塊
  - 色板顯示 10 色 + 背景色，hex 值正確
  - 瀏覽器縮小到 < 640px 時 pipeline stages 改為垂直排列
  - 瀏覽器在 640-1024px 時 grid 自動調整
  - Desktop 寬度時 agent cards 雙欄

### Phase 4：視覺微調 + 驗證

- **產出**：最終品質確認，修復視覺瑕疵
- **修改檔案**：
  - `/Users/sbu/projects/vibe/dashboard/scripts/generate.js` — 微調
- **具體工作**：
  1. 執行完整同步鏈驗證：`node dashboard/scripts/refresh.js`
  2. 目視檢查所有區塊的色彩一致性
  3. 檢查 guard cards、return rail、fork connectors 等特殊元素的色彩是否正確
  4. 確認 footer 版號動態化仍正常
  5. 確認 `docs/ref/index.md` 和 `docs/ref/vibe.md` 自動生成正常
  6. Mobile/Tablet/Desktop 三種寬度截圖驗證
  7. 更新 `plugin.json` 版號（patch +1）
- **依賴**：Phase 3
- **風險**：低
- **驗收條件**：
  - `node dashboard/scripts/refresh.js` 零錯誤
  - `node dashboard/scripts/generate.js` 零錯誤
  - 三種斷點下視覺效果一致、無破版
  - 所有互動元素（折疊、導航、跳轉）正常運作

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| rgba 半透明色值遺漏 | 中 | Phase 1 逐一比對 CSS 中所有 rgba 用法，Phase 4 目視全面檢查 |
| 折疊面板破壞現有 CSS 選擇器 | 中 | `<details>` 包裹時保持原有 class 結構不變，只在外層新增容器 |
| TOC fixed 定位與內容重疊 | 低 | 使用 `left` 定位並設 `max-width`，小螢幕隱藏 TOC |
| 響應式斷點與 agent card min-width 衝突 | 低 | 調整 `minmax(310px, 1fr)` → 響應式降級為 `minmax(280px, 1fr)` |
| generate.js 修改影響 index.md/vibe.md 生成 | 低 | generate.js 中 dashboard HTML 生成和 md 生成是獨立函式，互不干擾 |

## 回滾計畫

1. **Phase 1-3 任何階段失敗**：`git checkout -- dashboard/scripts/generate.js` 恢復原始生成腳本，重新執行 `node dashboard/scripts/generate.js` 即可恢復原版 dashboard
2. **自動同步鏈**：回滾 generate.js 後，下次 Stop hook 觸發 refresh.js 會自動重新生成正確的 dashboard.html
3. **版號**：若已更新 plugin.json，一併 revert
