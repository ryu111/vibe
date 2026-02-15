# Dashboard 10 種主題變體

## 為什麼（Why）

目前 dashboard.html 只有一種視覺風格（Tokyo Night 深色主題）。雖然 Tokyo Night 品質優良，但使用者在不同情境下可能偏好不同的視覺呈現：

- **環境適應**：明亮環境下深色主題反射刺眼，需要亮色方案
- **資訊密度偏好**：有人偏好一目了然的密集佈局，有人偏好寬鬆留白
- **個人化需求**：Dashboard 是使用者每天開啟的工具，視覺舒適度影響體驗
- **展示場景**：Demo 或文件截圖時可能需要特定風格

現有基礎設施（CSS custom properties、wrapSection、genTOC、genColorPalette、響應式三斷點）已為主題切換打下基礎，只需擴展 CSS 變數 + 局部 HTML 結構調整即可實現。

## 變更內容（What Changes）

### 核心：10 個主題變體設計

每個變體包含兩個維度的差異：**色彩方案**（CSS :root 變數替換）+ **排版佈局**（HTML 結構/CSS layout 調整）。

#### 變體一覽表

| # | 名稱 | 色調 | 排版特色 | 定位 |
|:-:|------|------|---------|------|
| 1 | **Tokyo Night**（現有） | 深靛藍底 + 霓虹色系 | 單欄垂直流、左側 TOC | 基準款（不動） |
| 2 | **Polar Dawn** | 冰白底 + 北歐藍灰 | 單欄垂直流、左側 TOC | 亮色基準款 |
| 3 | **Catppuccin Mocha** | 暖褐底 + 柔和粉彩 | 單欄垂直流、圓角加大 | 暖色深色 |
| 4 | **Solarized Dark** | 青藍底 + 對比色系 | 頂部 Tab 導航取代側邊 TOC | 經典護眼暗色 |
| 5 | **GitHub Light** | 純白底 + GitHub 語意色 | 雙欄並排（流程 + 統計） | 亮色資訊密集 |
| 6 | **Dracula** | 紫黑底 + 螢光亮色 | 全幅卡片、無 TOC（Scroll Spy 高亮） | 暗色極簡 |
| 7 | **Minimal Ink** | 近白底 + 純黑灰 | 極簡單欄、大留白、無邊框卡片 | 極簡主義 |
| 8 | **Synthwave '84** | 深紫底 + 霓虹粉/青 | CSS Grid 儀表板式、多欄 Bento 佈局 | 賽博龐克資訊密集 |
| 9 | **Nord** | 冷灰藍底 + 柔和霜色 | 水平時間軸式 Pipeline、堆疊卡片 | 北歐冷調 |
| 10 | **One Dark Pro** | 深灰底 + VS Code 色系 | 三欄佈局（TOC + 主體 + 側邊統計） | IDE 風格密集型 |

---

### 各變體詳細設計

#### 變體 2: Polar Dawn（亮色基準）

**色彩方案**：
```css
:root {
  --bg: #f8f9fc; --surface: #ffffff; --surface2: #f0f2f5;
  --border: #d8dce6; --border-highlight: #b8bfcc;
  --text: #2d3748; --text-muted: #8892a4;
  --accent: #4a7cf7; --green: #38a169; --yellow: #d69e2e;
  --red: #e53e3e; --purple: #805ad5; --orange: #dd6b20;
  --cyan: #0bc5ea; --pink: #d53f8c;
  --radius: 10px;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
}
```
**排版**：與 Tokyo Night 相同的單欄佈局，但 card-shadow 更輕薄、border 更細淡。代表「最小切換成本」的亮色方案。

#### 變體 3: Catppuccin Mocha（暖色深色）

**色彩方案**：
```css
:root {
  --bg: #1e1e2e; --surface: #313244; --surface2: #2a2a3c;
  --border: #45475a; --border-highlight: #585b70;
  --text: #cdd6f4; --text-muted: #6c7086;
  --accent: #89b4fa; --green: #a6e3a1; --yellow: #f9e2af;
  --red: #f38ba8; --purple: #cba6f7; --orange: #fab387;
  --cyan: #89dceb; --pink: #f5c2e7;
  --radius: 14px;
  --card-shadow: 0 2px 10px rgba(0,0,0,0.25);
}
```
**排版**：單欄流但圓角加大（14px），卡片間距略增，整體更柔和圓潤。font-family 偏好 Noto Sans 系列。

#### 變體 4: Solarized Dark（經典護眼）

**色彩方案**：
```css
:root {
  --bg: #002b36; --surface: #073642; --surface2: #003845;
  --border: #586e75; --border-highlight: #657b83;
  --text: #93a1a1; --text-muted: #586e75;
  --accent: #268bd2; --green: #859900; --yellow: #b58900;
  --red: #dc322f; --purple: #6c71c4; --orange: #cb4b16;
  --cyan: #2aa198; --pink: #d33682;
  --radius: 6px;
  --card-shadow: 0 1px 4px rgba(0,0,0,0.4);
}
```
**排版**：頂部水平 Tab 導航取代左側固定 TOC。Tab 條固定在視窗頂部，點擊切換可見區塊。Pipeline 流程圖保持垂直但更緊湊（padding 減少）。圓角偏小（6px），工程感。

#### 變體 5: GitHub Light（亮色密集）

**色彩方案**：
```css
:root {
  --bg: #ffffff; --surface: #f6f8fa; --surface2: #eef1f5;
  --border: #d0d7de; --border-highlight: #afb8c1;
  --text: #1f2328; --text-muted: #656d76;
  --accent: #0969da; --green: #1a7f37; --yellow: #9a6700;
  --red: #cf222e; --purple: #8250df; --orange: #bc4c00;
  --cyan: #0550ae; --pink: #bf3989;
  --radius: 6px;
  --card-shadow: 0 1px 0 rgba(27,31,36,0.04);
}
```
**排版**：雙欄並排 — 左側 60% 放 Pipeline 流程圖和 Agent 詳情，右側 40% 放建構順序、統計和色板。TOC 改為頂部麵包屑式導航。卡片使用極淺 shadow + 實線 border（GitHub 風格）。整體更密集，資訊一屏盡覽。

#### 變體 6: Dracula（暗色極簡）

**色彩方案**：
```css
:root {
  --bg: #282a36; --surface: #44475a; --surface2: #363949;
  --border: #6272a4; --border-highlight: #7283b5;
  --text: #f8f8f2; --text-muted: #6272a4;
  --accent: #bd93f9; --green: #50fa7b; --yellow: #f1fa8c;
  --red: #ff5555; --purple: #bd93f9; --orange: #ffb86c;
  --cyan: #8be9fd; --pink: #ff79c6;
  --radius: 8px;
  --card-shadow: none;
}
```
**排版**：去掉左側 TOC，改用 Scroll Spy 浮動指示器（右側圓點導航）。卡片全幅寬度，去除 box-shadow，用微弱 border 分隔。Pipeline 流程圖水平箭頭串連（橫向滾動），Agent 詳情垂直堆疊。大量留白，高螢光對比色。

#### 變體 7: Minimal Ink（極簡主義）

**色彩方案**：
```css
:root {
  --bg: #fafafa; --surface: #ffffff; --surface2: #f5f5f5;
  --border: #e5e5e5; --border-highlight: #d4d4d4;
  --text: #171717; --text-muted: #a3a3a3;
  --accent: #171717; --green: #16a34a; --yellow: #ca8a04;
  --red: #dc2626; --purple: #7c3aed; --orange: #ea580c;
  --cyan: #0891b2; --pink: #db2777;
  --radius: 4px;
  --card-shadow: none;
}
```
**排版**：極簡單欄，max-width 縮至 800px。無 TOC、無 card shadow、無 border（只有極細的分隔線）。大量垂直留白（section 間距 4rem+）。標題用純黑粗體。Pipeline 流程用純文字列表呈現（去除裝飾性元素）。統計數字放大成 hero metric 風格。色彩幾乎只用黑白灰 + 少量 accent。

#### 變體 8: Synthwave '84（賽博龐克）

**色彩方案**：
```css
:root {
  --bg: #262335; --surface: #34294f; --surface2: #2e2346;
  --border: #495495; --border-highlight: #5a67a8;
  --text: #e0d7ff; --text-muted: #7a6fa8;
  --accent: #fc28a8; --green: #72f1b8; --yellow: #f3e06d;
  --red: #fe4450; --purple: #c792ea; --orange: #ff8b39;
  --cyan: #36f9f6; --pink: #fc28a8;
  --radius: 2px;
  --card-shadow: 0 0 15px rgba(252,40,168,0.15), 0 0 30px rgba(54,249,246,0.05);
}
```
**排版**：CSS Grid Bento 佈局 — Pipeline 概覽佔大格、Agent 卡片佔小格、統計數字分散在網格空隙中。尖銳小圓角（2px）。card-shadow 帶霓虹光暈效果。Pipeline 頂部橫條帶動畫漸變底色。字體偏好等寬字體（monospace）。整體像遊戲 HUD 或科幻控制台。

#### 變體 9: Nord（北歐冷調）

**色彩方案**：
```css
:root {
  --bg: #2e3440; --surface: #3b4252; --surface2: #343a48;
  --border: #4c566a; --border-highlight: #5e6779;
  --text: #d8dee9; --text-muted: #7b88a1;
  --accent: #88c0d0; --green: #a3be8c; --yellow: #ebcb8b;
  --red: #bf616a; --purple: #b48ead; --orange: #d08770;
  --cyan: #8fbcbb; --pink: #b48ead;
  --radius: 8px;
  --card-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
```
**排版**：Pipeline 以水平時間軸呈現（stage 從左到右、可橫向滾動），每個 stage 下方垂直展開 agent 詳情。統計面板堆疊在 Pipeline 下方呈水平卡片帶。TOC 改為頂部固定的水平導航條。整體溫度偏冷但不刺眼。

#### 變體 10: One Dark Pro（IDE 風格）

**色彩方案**：
```css
:root {
  --bg: #282c34; --surface: #21252b; --surface2: #2c313c;
  --border: #3e4452; --border-highlight: #4b5263;
  --text: #abb2bf; --text-muted: #5c6370;
  --accent: #61afef; --green: #98c379; --yellow: #e5c07b;
  --red: #e06c75; --purple: #c678dd; --orange: #d19a66;
  --cyan: #56b6c2; --pink: #c678dd;
  --radius: 4px;
  --card-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
```
**排版**：三欄佈局 — 左側窄欄放 TOC（模仿 IDE sidebar），中間主欄放 Pipeline 和 Agent 詳情，右側窄欄放建構順序和統計（模仿 IDE minimap/panel）。小圓角（4px）、緊湊間距。Code 區塊和 monospace 元素強調。整體模仿 VS Code 編輯器的視覺語言。

---

### 實作方式：主題配置系統

不是寫 10 個完整的 generate.js，而是：

1. **新增 `dashboard/themes/` 目錄** — 每個主題一個 JSON 檔案
2. **主題 JSON 定義三層**：
   - `colors`：CSS :root 變數覆蓋
   - `layout`：佈局模式標識（`single-col` / `dual-col` / `triple-col` / `bento` / `timeline`）
   - `tweaks`：微調參數（TOC 位置、卡片風格、字體偏好等）
3. **generate.js 擴展**：讀取主題 JSON，根據 layout 模式選擇不同的 HTML 結構模板
4. **產出 10 個 HTML mockup**：`dashboard/themes/{name}/preview.html`

### 產出物

- 10 個 `dashboard/themes/{name}/theme.json` — 主題定義檔
- 10 個 `dashboard/themes/{name}/preview.html` — 可直接在瀏覽器預覽的 mockup
- 1 個 `dashboard/themes/index.html` — 主題選擇器（Grid 預覽所有主題縮略圖）
- generate.js 新增 `--theme` 參數支援

## 能力定義（Capabilities）

- [ ] Capability 1：主題配置系統 — `dashboard/themes/` 目錄結構 + theme.json schema 定義
- [ ] Capability 2：佈局引擎擴展 — generate.js 支援 5 種佈局模式（single-col / dual-col / triple-col / bento / timeline）
- [ ] Capability 3：10 個主題完整定義 — 色彩 + 佈局 + 微調參數
- [ ] Capability 4：HTML mockup 生成 — 每個主題獨立的 preview.html
- [ ] Capability 5：主題選擇器 — index.html 一覽所有主題的預覽頁面

## 影響分析（Impact）

- **受影響檔案**：
  - `dashboard/scripts/generate.js` — 新增主題載入 + 佈局模式分支
  - `dashboard/config.json` — 無需修改（資料結構不變）
  - `dashboard/data/meta.json` — 無需修改（讀取不變）
  - `dashboard/data/progress.json` — 無需修改（讀取不變）
  - `dashboard/tests/generate-tokyo-night.test.js` — 需擴展為通用主題測試
- **新增檔案**：
  - `dashboard/themes/` 目錄（10 個子目錄 + index.html）
- **受影響模組**：dashboard
- **registry.js 變更**：否
- **hook 變更**：無

### 無需修改的檔案及原因

| 檔案 | 原因 |
|------|------|
| `config.json` | 資料結構不變，只是 CSS/HTML 呈現方式不同 |
| `meta.json` / `progress.json` | 純資料來源，主題只消費不修改 |
| `sync-data.js` / `scan-progress.js` | 資料收集邏輯與 UI 無關 |
| `refresh.js` | 呼叫 generate.js 的橋接腳本，可保持不變（或可選傳遞 --theme） |
| `generate-vibe-doc.js` | 生成 vibe.md 文檔，與 dashboard HTML 無關 |
| `registry.js` | Dashboard UI 不影響 pipeline/hook 元資料 |
| 所有 hook 腳本 | UI 層面變更不觸及 hook 邏輯 |

## 階段分解

### Phase 1：主題配置系統基礎

- **產出**：
  - `dashboard/themes/` 目錄結構
  - theme.json schema 定義文件
  - Tokyo Night 作為首個 theme.json 參考實作
- **修改檔案**：
  - 新增 `dashboard/themes/tokyo-night/theme.json`
- **依賴**：無
- **風險**：schema 定義不夠靈活，無法涵蓋所有佈局差異
  - 緩解：先用 Tokyo Night 回歸測試，確保現有功能不受影響
- **驗收條件**：
  - theme.json 能完整描述現有 Tokyo Night 的所有 CSS 變數
  - 現有測試全部通過

### Phase 2：generate.js 主題載入機制

- **產出**：
  - generate.js 支援 `--theme <name>` 參數
  - 從 theme.json 讀取色彩方案，注入 CSS :root
  - 預設行為不變（不指定 theme 時使用 Tokyo Night）
- **修改檔案**：
  - `dashboard/scripts/generate.js` — 新增 theme 載入邏輯
- **依賴**：Phase 1
- **風險**：CSS 變數名稱不一致導致樣式破壞
  - 緩解：用現有 tokyo-night.test.js 作為回歸測試
- **驗收條件**：
  - `node generate.js` 產出與目前完全相同的 dashboard.html
  - `node generate.js --theme tokyo-night` 產出相同結果

### Phase 3：5 種佈局模式實作

- **產出**：
  - generate.js 中 5 種佈局模式的 HTML 結構模板
    - `single-col`：現有佈局（Tokyo Night / Polar Dawn / Catppuccin / Minimal Ink）
    - `dual-col`：雙欄並排（GitHub Light）
    - `triple-col`：三欄（One Dark Pro）
    - `bento`：CSS Grid 自由網格（Synthwave '84）
    - `timeline`：水平時間軸（Nord）
  - 每個佈局模式的 CSS 差異部分
- **修改檔案**：
  - `dashboard/scripts/generate.js` — 新增佈局分支
- **依賴**：Phase 2
- **風險**：多佈局模式增加 generate.js 複雜度；響應式斷點在不同佈局下表現不同
  - 緩解：每個佈局模式獨立函式，不影響現有 single-col 邏輯；佈局模式在 mobile 時統一降級為 single-col
- **驗收條件**：
  - 5 種佈局模式各自能產出完整 HTML
  - 所有佈局在 mobile 斷點時降級為單欄
  - 資料完整性不因佈局差異而丟失

### Phase 4：10 個主題定義 + Preview HTML 生成

- **產出**：
  - 9 個新主題的 theme.json（Tokyo Night 在 Phase 1 已完成）
  - 10 個 `preview.html` mockup
  - 1 個 `dashboard/themes/index.html` 主題選擇器
- **修改檔案**：
  - 新增 `dashboard/themes/{name}/theme.json` x 9
  - 新增 `dashboard/themes/{name}/preview.html` x 10
  - 新增 `dashboard/themes/index.html`
- **依賴**：Phase 3
- **風險**：某些色彩組合在特定佈局下可讀性不佳
  - 緩解：每個 preview.html 人工目視檢查；WCAG 2.1 AA 對比度作為底線
- **驗收條件**：
  - 10 個 preview.html 都能在瀏覽器正確開啟
  - 所有主題的文字/背景對比度 >= 4.5:1
  - index.html 能正確顯示 10 個主題的預覽並可點擊跳轉

### Phase 5：測試與文檔

- **產出**：
  - 擴展的測試檔案，覆蓋所有 10 個主題
  - generate.js 新增參數的文檔說明
- **修改檔案**：
  - `dashboard/tests/generate-tokyo-night.test.js` — 擴展為通用主題測試
- **依賴**：Phase 4
- **風險**：測試覆蓋不完整
  - 緩解：每個主題至少驗證 CSS :root 完整性 + HTML 結構完整性 + 無外部依賴
- **驗收條件**：
  - 所有主題的 preview.html 通過結構完整性測試
  - 現有 Tokyo Night 測試全數通過（回歸）
  - `--theme` 參數正確識別所有 10 個主題名稱

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| generate.js 複雜度爆增 | 高 | 佈局模式獨立為函式模組，每個佈局最多 100 行差異 |
| 色彩對比度不達標 | 中 | WCAG 2.1 AA 底線 + 目視檢查每個 preview |
| 多佈局響應式碎片化 | 中 | Mobile 統一降級 single-col，只在 Desktop 才展現佈局差異 |
| 主題 JSON schema 不夠靈活 | 低 | Phase 1 先用現有主題驗證，有問題在 Phase 2 前調整 |
| 產出物過多維護成本高 | 低 | preview.html 是一次性 mockup，最終只選 1-3 個主題進入正式支援 |

## 回滾計畫

1. **Phase 1-2 出問題**：刪除 `dashboard/themes/` 目錄，generate.js 回退 git stash/revert
2. **Phase 3 出問題**：generate.js 的佈局分支用 feature flag 控制（`--theme` 不指定時完全不觸及新邏輯），回滾只需不傳參數
3. **Phase 4-5 出問題**：preview.html 和 index.html 是獨立產出物，刪除即可，不影響現有 dashboard.html
4. **全面回滾**：`git revert` 整個 change 的 commit range，dashboard.html 恢復為純 Tokyo Night
