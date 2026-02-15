# 架構設計：Dashboard Tokyo Night 主題重設計

## 現有結構分析

### 目錄結構概覽

```
dashboard/
├── config.json              ← 視覺配置資料（flowPhases/taskRoutes/guards 等，不修改）
├── dashboard.html           ← 自動產出物（由 generate.js 生成）
├── style-showcase.html      ← 10 款主題色系定義（含 Tokyo Night 參考）
├── data/
│   ├── meta.json            ← 自動產出物（由 sync-data.js 生成）
│   └── progress.json        ← 自動產出物（由 scan-progress.js 生成）
└── scripts/
    ├── refresh.js            ← 全鏈觸發（sync → scan → generate → 瀏覽器刷新）
    ├── sync-data.js          ← 掃描 plugin 目錄，產出 meta.json
    ├── scan-progress.js      ← 掃描完成度，產出 progress.json
    ├── generate.js           ← 主要修改目標，產出 dashboard.html + index.md + vibe.md
    └── generate-vibe-doc.js  ← 產出 vibe.md（由 generate.js 引入）
```

### 關鍵模式與慣例

1. **CSS 以常量字串定義**：`const CSS = \`...\`` 佔 generate.js 前 244 行，所有樣式內聯在此
2. **HTML 由函式組合**：`generate()` 是主組合點（L894-L966），呼叫 `genStats()`、`genBuildOrder()`、`genFlowDiagram()`、`genAgentDetails()`、`genPluginCards()`
3. **零外部依賴**：純 Node.js fs/path，不引入任何 CSS 框架或前端函式庫
4. **config.json 驅動**：agent workflow、pipeline stages、guards 等結構化資料從 config.json 讀取
5. **colorToRgba 映射**：CSS 變數名 → rgba 半透明值的對應表（L405-L415），用於卡片背景
6. **自動同步鏈不變**：Stop hook → refresh.js → sync-data.js + scan-progress.js → generate.js → dashboard.html

### 介面邊界

- **輸入**：`plugin-specs.json`、`progress.json`、`config.json`、`meta.json`（全部 JSON）
- **輸出**：`dashboard.html`、`docs/ref/index.md`、`docs/ref/vibe.md`
- **約束**：config.json 不修改、sync-data.js/scan-progress.js/refresh.js 不修改

### 修改影響範圍

**唯一修改檔案**：`dashboard/scripts/generate.js`

修改影響三個面向：
1. CSS 常量（L29-L244）：色系、設計 token、新增樣式
2. HTML 結構（L894-L966 `generate()` 函式）：區塊排序、折疊面板、TOC、色板
3. colorToRgba 映射（L405-L415）：同步更新為 Tokyo Night 色值

**不受影響**：`generateIndex()`、`generateVibeDoc()` 等 markdown 生成函式

---

## 方案 A：漸進式替換（Incremental Swap）

### 設計理念
最小改動原則 — 只替換色值和 colorToRgba 映射，保持現有 CSS 類名和 HTML 結構完全不變。資訊架構和互動增強做為獨立疊加層，不重構現有函式。

### 目錄樹
```
dashboard/scripts/generate.js  ← 修改
  ├── CSS 常量：替換 :root 色值
  ├── colorToRgba：更新映射
  ├── 新增 CSS：details/summary、TOC、色板、media queries
  ├── 新增函式：genTOC()、genColorPalette()
  └── generate()：調整區塊順序 + 包裹 <details>
```

### 修改內容

#### 1. CSS :root 變數替換
```css
:root {
  --bg: #1a1b26; --surface: #24283b; --surface2: #1f2335;
  --border: #3b4261; --border-highlight: #545c7e;
  --text: #c0caf5; --text-muted: #565f89;
  --accent: #7aa2f7; --green: #9ece6a; --yellow: #e0af68;
  --red: #f7768e; --purple: #bb9af7; --orange: #ff9e64;
  --cyan: #7dcfff; --pink: #ff007c;
  --radius: 10px;
  --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
```

#### 2. colorToRgba 映射更新
```javascript
const colorToRgba = {
  'var(--yellow)': 'rgba(224,175,104,0.06)',
  'var(--cyan)': 'rgba(125,207,255,0.06)',
  'var(--green)': 'rgba(158,206,106,0.06)',
  'var(--accent)': 'rgba(122,162,247,0.06)',
  'var(--purple)': 'rgba(187,154,247,0.08)',
  'var(--red)': 'rgba(247,118,142,0.06)',
  'var(--orange)': 'rgba(255,158,100,0.06)',
  'var(--pink)': 'rgba(255,0,124,0.06)',
  'var(--text-muted)': 'rgba(192,202,245,0.03)',
};
```

#### 3. generate() 區塊重排
```
原始順序：進度條 → 統計 → 建構順序 → 流程圖 → Agent 詳細 → Plugin 詳情
新順序：  精簡進度 → 流程圖 → Agent 詳細(details) → 建構順序(details) → 統計(details) → Plugin 詳情(details) → 色板(details)
```

#### 4. 新增函式
- `genTOC(sections)` — 生成固定側邊導航 HTML
- `genColorPalette()` — 生成 Tokyo Night 色板預覽 HTML
- `genCompactProgress(pct)` — 生成一行式精簡進度指示

### 資料流
```
config.json + meta.json + progress.json + plugin-specs.json
  ↓ loadJSON()
generate()
  ├── genCompactProgress()  → 精簡進度（一行）
  ├── genFlowDiagram()      → Pipeline 流程圖（不修改）
  ├── genAgentDetails()     → Agent 詳細（外包 <details>）
  ├── genBuildOrder()       → 建構順序（外包 <details>）
  ├── genStats()            → 統計（外包 <details>）
  ├── genPluginCards()      → Plugin 詳情（外包 <details>）
  ├── genColorPalette()     → 色板預覽（外包 <details>）
  └── genTOC()              → 固定側邊導航
  ↓
dashboard.html（含 Tokyo Night CSS + 響應式 media queries）
```

### 優勢
- **破壞性最低**：現有函式簽名不變，只在外層包裹 `<details>` 和調整順序
- **易於回滾**：每個改動獨立，問題時可逐步 revert
- **一致性驗證簡單**：只需比對 :root 變數與 style-showcase.html

### 劣勢
- **CSS 常量膨脹**：原 244 行 CSS + 新增 details/TOC/responsive/色板約 100-150 行，接近 400 行字串
- **缺乏設計 token 抽象**：`--radius`/`--card-shadow` 只在 :root 定義但現有 CSS 類仍使用硬編碼的 `border-radius: 12px` 等值，需逐一替換
- **TOC 與內容耦合**：TOC 的 section ID 與 generate() 中的 `<h2>` 硬編碼，新增/刪除區塊需同步兩處

---

## 方案 B：結構化重構（Structured Refactor）

### 設計理念
將 CSS 從單一大字串拆分為邏輯區塊（TOKENS + LAYOUT + COMPONENTS + RESPONSIVE），同時將 `generate()` 的 HTML 片段拆分為 section 物件陣列，讓 TOC 和 ID 自動生成。

### 目錄樹
```
dashboard/scripts/generate.js  ← 修改
  ├── CSS_TOKENS：設計 token（色系 + radius + shadow）
  ├── CSS_LAYOUT：佈局（body + grid + flex）
  ├── CSS_COMPONENTS：組件（card + badge + tag + flow + pipe）
  ├── CSS_INTERACTIVE：互動（details + TOC + 色板）
  ├── CSS_RESPONSIVE：響應式 media queries
  ├── colorToRgba：更新映射
  ├── SECTIONS 物件陣列：[{ id, title, content, collapsible }]
  ├── 新增函式：genTOC()、genColorPalette()、genCompactProgress()
  └── generate()：遍歷 SECTIONS 自動生成 HTML
```

### 介面定義
```javascript
// Section 物件
const section = {
  id: 'pipeline-flow',          // 自動成為 <h2 id="...">
  title: '開發流程',             // <h2> 文字
  content: genFlowDiagram(...), // HTML 字串
  collapsible: false,           // true 時包裹 <details>
  summaryExtra: '',             // <summary> 額外描述
};
```

### 資料流
```
config.json + meta.json + progress.json + plugin-specs.json
  ↓ loadJSON()
generate()
  ├── 建構 SECTIONS 陣列
  │   ├── { id: 'progress', content: genCompactProgress(), collapsible: false }
  │   ├── { id: 'pipeline-flow', content: genFlowDiagram(), collapsible: false }
  │   ├── { id: 'agent-details', content: genAgentDetails(), collapsible: true }
  │   ├── { id: 'build-order', content: genBuildOrder(), collapsible: true }
  │   ├── { id: 'stats', content: genStats(), collapsible: true }
  │   ├── { id: 'plugins', content: genPluginCards(), collapsible: true }
  │   └── { id: 'color-palette', content: genColorPalette(), collapsible: true }
  ├── genTOC(sections) — 自動從 SECTIONS 生成導航
  └── sections.map(renderSection) — 統一渲染邏輯
  ↓
dashboard.html
```

### 優勢
- **CSS 可維護性高**：拆分為 5 個邏輯區塊，修改特定面向不需在 400 行中搜索
- **TOC 自動生成**：section ID 與 TOC 自動同步，新增/刪除區塊只需修改 SECTIONS 陣列
- **設計 token 統一**：所有 `border-radius` 和 `box-shadow` 引用 `var(--radius)`/`var(--card-shadow)`
- **響應式隔離**：所有 media queries 集中在 CSS_RESPONSIVE，易於調試

### 劣勢
- **改動幅度大**：需要重構 generate() 的整個渲染流程
- **CSS 拆分增加複雜度**：5 個常量拼接 vs 1 個大字串，心智負擔增加
- **測試難度**：重構後需要全面驗證所有區塊的 HTML 產出是否正確

---

## 方案 C：混合式（Hybrid — 推薦）

### 設計理念
結合方案 A 的低破壞性和方案 B 的 section 抽象。CSS 保持單一常量但加入設計 token 變數，generate() 引入 section 概念但不做完全物件化 — 只在最終組合時使用 `wrapSection()` 輔助函式。

### 目錄樹
```
dashboard/scripts/generate.js  ← 修改
  ├── CSS 常量：
  │   ├── :root → Tokyo Night 色系 + 設計 token
  │   ├── 現有組件樣式 → 替換硬編碼值為 var()
  │   ├── 新增 details/summary 樣式
  │   ├── 新增 TOC 樣式
  │   ├── 新增色板樣式
  │   └── 新增 @media 響應式
  ├── colorToRgba：更新映射
  ├── 輔助函式：wrapSection()、genTOC()、genColorPalette()、genCompactProgress()
  └── generate()：使用 wrapSection() 組合，保持現有子函式不變
```

### 介面定義

```javascript
/**
 * 包裹區塊為一致的 section 結構
 * @param {string} id - 區塊 ID（用於 TOC 錨點）
 * @param {string} title - 區塊標題
 * @param {string} content - HTML 內容
 * @param {object} opts - { collapsible: boolean, open: boolean, summary: string }
 * @returns {string} HTML 字串
 */
function wrapSection(id, title, content, opts = {}) {
  // collapsible=true → <details><summary>title</summary>content</details>
  // collapsible=false → <h2 id="...">title</h2>content
}

/**
 * 生成固定側邊導航
 * @param {{ id: string, title: string }[]} sections
 * @returns {string} HTML 字串
 */
function genTOC(sections) {}

/**
 * 生成一行式精簡進度
 * @param {number} pct - 完成百分比
 * @param {object} progress - progress.json 資料
 * @returns {string} HTML 字串
 */
function genCompactProgress(pct, progress) {}

/**
 * 生成 Tokyo Night 色板預覽
 * @returns {string} HTML 字串
 */
function genColorPalette() {}
```

### 資料流
```
config.json + meta.json + progress.json + plugin-specs.json
  ↓ loadJSON()
generate()
  ├── 定義 sections 陣列（僅 id + title 用於 TOC）
  ├── genTOC(sections)              → <nav> 側邊導航
  ├── genCompactProgress(pct)       → 精簡進度列
  ├── wrapSection('pipeline-flow', '開發流程', genFlowDiagram())
  ├── wrapSection('agent-details', 'Agent 詳細流程', genAgentDetails(), { collapsible: true })
  ├── wrapSection('build-order', '建構順序', genBuildOrder(), { collapsible: true })
  ├── wrapSection('stats', '組件統計', genStats(), { collapsible: true })
  ├── wrapSection('plugins', 'Plugin 詳情', genPluginCards(), { collapsible: true })
  └── wrapSection('color-palette', '色板', genColorPalette(), { collapsible: true })
  ↓
dashboard.html
```

### CSS 修改範圍

1. **:root 變數替換**（13 個色值 + 2 個設計 token）
2. **現有樣式更新**：
   - `border-radius: 12px` → `border-radius: var(--radius)` 等
   - `box-shadow` 相關 → `box-shadow: var(--card-shadow)`
   - 所有 `rgba()` 半透明值同步更新為 Tokyo Night 色基
3. **新增樣式**：
   - `details` / `summary` 折疊面板（約 20 行）
   - `.toc` 固定側邊導航（約 30 行）
   - `.color-palette` 色板預覽（約 15 行）
   - `.compact-progress` 精簡進度列（約 10 行）
   - `@media` 響應式斷點（約 40 行）

### 優勢
- **破壞性適中**：現有子函式（genFlowDiagram/genAgentDetails/genStats 等）完全不修改
- **TOC 與結構同步**：sections 陣列是 TOC 的唯一真實來源
- **wrapSection 統一**：折疊/非折疊的邏輯集中在一處，不散落在 generate() 各處
- **CSS 保持單一常量**：不引入多常量拼接的心智負擔，但內部加入明確的區域註解

### 劣勢
- **CSS 常量長度增加**：約從 244 行增加到 360 行
- **wrapSection 引入新抽象**：雖然簡單，但需要理解 collapsible 的行為

---

## 方案比較

| 面向 | 方案 A：漸進式替換 | 方案 B：結構化重構 | 方案 C：混合式 |
|------|-------------------|-------------------|---------------|
| 複雜度 | 低 | 高 | 中 |
| 可擴展性 | 低（新增區塊需同步多處） | 高（SECTIONS 陣列驅動） | 中高（sections + wrapSection） |
| 破壞性 | 最低 | 高（重構 generate）| 低（只改 generate 組合邏輯） |
| 實作成本 | 2-3 小時 | 5-6 小時 | 3-4 小時 |
| CSS 維護性 | 差（大字串搜索） | 好（分區管理） | 中（註解分區但單一字串）|
| TOC 同步 | 手動（易遺漏） | 自動 | 自動 |
| 子函式改動 | 無 | 全部重構 | 無 |
| 回滾難度 | 低 | 高 | 中 |

## 決策

選擇**方案 C：混合式**。

原因：
1. **現有子函式零改動**：`genFlowDiagram()`、`genAgentDetails()`、`genStats()`、`genBuildOrder()`、`genPluginCards()` 全部不動，降低回歸風險
2. **wrapSection 抽象恰到好處**：統一折疊邏輯而不過度工程化
3. **sections 陣列 = TOC 來源**：新增/刪除區塊時自動同步導航
4. **CSS 單一常量維持一致慣例**：專案其他腳本也用同樣模式

## 風險與取捨

| 風險 | 嚴重度 | 緩解措施 |
|------|:------:|---------|
| rgba 半透明值遺漏導致色差 | 中 | 列舉 CSS 中所有 rgba 用法清單，逐一替換；Phase 4 全面目視檢查 |
| `<details>` 包裹破壞現有 CSS 選擇器 | 中 | `<details>` 包在 `<h2>` 和內容外層，不改變現有 class 結構；`<summary>` 取代 `<h2>` 的視覺角色 |
| TOC fixed 定位與內容重疊 | 低 | Desktop 左側 fixed + body left padding；Tablet/Mobile 隱藏 TOC |
| 響應式斷點與 agent-card minmax 衝突 | 低 | 降級 `minmax(310px, 1fr)` → `minmax(280px, 1fr)` 並在 mobile 改為 `1fr` |
| CSS 常量從 244 行膨脹到 360 行 | 低 | 清晰的區域註解（`/* === TOKENS ===*/` 等），日後如需可拆分 |
| generate() 修改可能影響 index.md/vibe.md 生成 | 無 | dashboard HTML 和 md 生成是完全獨立的函式，共享的只有 `main()` 流程 |

## 遷移計畫

### Phase 1：CSS 色系替換 + 設計 Token（無功能變更）
1. 替換 `:root` 變數值（GitHub Dark → Tokyo Night）
2. 新增 `--surface2`、`--border-highlight`、`--radius`、`--card-shadow` 變數
3. 更新 `colorToRgba` 映射表
4. 將現有 CSS 中的硬編碼 `border-radius` 和 `rgba()` 替換為 `var()` 引用
5. 驗證：`node generate.js` 無錯、dashboard.html 視覺一致

### Phase 2：資訊架構重組 + 折疊面板
1. 新增 `wrapSection()` 輔助函式
2. 新增 `genCompactProgress()` 函式
3. 新增 `<details>/<summary>` CSS 樣式
4. 修改 `generate()`：重排區塊順序，首屏聚焦 Pipeline，次要資訊折疊
5. 驗證：首屏可見 Pipeline 流程圖，所有折疊面板可展開/收合

### Phase 3：TOC 導航 + 色板 + 響應式
1. 新增 `genTOC()` 函式 + CSS（fixed 定位）
2. 新增 `genColorPalette()` 函式 + CSS
3. 新增 `@media` 響應式斷點（640px / 1024px）
4. 在 `generate()` 中整合 TOC 和色板
5. 驗證：TOC 跳轉正確、色板 hex 正確、三斷點自適應

### Phase 4：視覺微調 + 驗證
1. 執行完整同步鏈：`node refresh.js`
2. 全面目視檢查（guard cards、return rail、fork connectors 特殊元素）
3. Mobile/Tablet/Desktop 三種寬度驗證
4. 確認 `index.md`/`vibe.md` 自動生成正常
5. 更新 `plugin.json` 版號（patch +1）
