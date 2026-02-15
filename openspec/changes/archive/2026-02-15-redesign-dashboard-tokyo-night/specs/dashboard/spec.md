# Dashboard 模組 Delta Spec

## ADDED Requirements

### Requirement: Tokyo Night 色系定義

Dashboard 產出的 HTML 必須使用 Tokyo Night 色系作為預設主題，取代原有的 GitHub Dark 色系。

#### Scenario: :root CSS 變數完整替換
WHEN generate.js 執行產出 dashboard.html
THEN `:root` 區塊包含以下變數值：
  - `--bg: #1a1b26`
  - `--surface: #24283b`
  - `--surface2: #1f2335`
  - `--border: #3b4261`
  - `--border-highlight: #545c7e`
  - `--text: #c0caf5`
  - `--text-muted: #565f89`
  - `--accent: #7aa2f7`
  - `--green: #9ece6a`
  - `--yellow: #e0af68`
  - `--red: #f7768e`
  - `--purple: #bb9af7`
  - `--orange: #ff9e64`
  - `--cyan: #7dcfff`
  - `--pink: #ff007c`

#### Scenario: 設計 Token 變數存在
WHEN generate.js 執行產出 dashboard.html
THEN `:root` 區塊包含設計 token：
  - `--radius: 10px`
  - `--card-shadow: 0 2px 8px rgba(0,0,0,0.3)`

#### Scenario: colorToRgba 映射與色系同步
WHEN generate.js 中的 colorToRgba 物件被用於計算卡片背景色
THEN 每個 rgba 值的 RGB 成分必須與對應的 Tokyo Night 色值一致（允許 alpha 值為 0.04-0.08）

#### Scenario: 硬編碼值替換為設計 Token
WHEN dashboard.html 中的 CSS 包含 border-radius 屬性
THEN 所有卡片級元素（`.plugin-card`、`.agent-card`、`.pipe-agent`、`.guard-card` 等）的 border-radius 應使用 `var(--radius)` 或基於 `var(--radius)` 的計算值

#### Scenario: 與 style-showcase.html 色系一致
WHEN 目視比較 dashboard.html 與 style-showcase.html 的 `[data-theme="tokyo-night"]` 主題
THEN 兩者的背景色、文字色、accent 色、語意色（green/yellow/red 等）在視覺上無色差

---

### Requirement: 精簡進度指示

首屏使用一行式精簡進度指示，取代原有的大型進度條區塊和統計面板。

#### Scenario: 精簡進度列渲染
WHEN generate.js 的 genCompactProgress() 被呼叫
THEN 產出包含以下元素的 HTML：
  - 整體完成百分比（文字）
  - 一行式進度條（高度不超過 8px）
  - 總組件數（actual/expected 格式）

#### Scenario: 首屏聚焦 Pipeline
WHEN 使用者在 Desktop（>1024px）瀏覽器打開 dashboard.html 且不捲動
THEN 精簡進度列和「開發流程」標題可見

---

### Requirement: 折疊面板

次要資訊區塊使用 `<details>/<summary>` 折疊，減少頁面長度。

#### Scenario: 次要區塊預設折疊
WHEN dashboard.html 載入完成
THEN 以下區塊預設為折疊狀態：
  - Agent 詳細流程
  - 建構順序
  - 組件統計
  - Plugin 詳情
  - 色板

#### Scenario: 折疊面板展開後內容完整
WHEN 使用者點擊任一折疊面板的 `<summary>` 元素
THEN 面板展開，內部內容與原版（重設計前）的排版一致

#### Scenario: summary 元素具備互動提示
WHEN 使用者將游標移到 `<summary>` 元素上
THEN 游標變為 `pointer`，且有視覺 hover 效果（邊框色變化或背景色變化）

---

### Requirement: wrapSection 統一區塊結構

所有內容區塊透過 `wrapSection()` 統一生成，確保 ID、標題、折疊行為的一致性。

#### Scenario: 非折疊區塊結構
WHEN wrapSection() 被呼叫且 opts.collapsible 為 false
THEN 產出 `<h2 id="{id}">{title}</h2>` + content 的 HTML

#### Scenario: 折疊區塊結構
WHEN wrapSection() 被呼叫且 opts.collapsible 為 true
THEN 產出 `<details><summary>{title}</summary>{content}</details>` 的 HTML
AND `<details>` 元素包含 `id="{id}"` 屬性

---

### Requirement: TOC 導航

固定位置的導航列表，提供快速跳轉到各區塊的能力。

#### Scenario: TOC 包含所有區塊連結
WHEN genTOC() 被呼叫並傳入 sections 陣列
THEN 產出的 HTML 包含與 sections 數量相同的 `<a>` 元素
AND 每個 `<a>` 的 `href` 指向對應的 `#id`

#### Scenario: TOC Desktop 定位
WHEN 瀏覽器寬度 > 1024px
THEN TOC 以 `position: fixed` 顯示在頁面左側

#### Scenario: TOC Mobile 隱藏
WHEN 瀏覽器寬度 < 640px
THEN TOC 不顯示（`display: none`）

---

### Requirement: 色板預覽

展示 Tokyo Night 完整色系，供開發者參考。

#### Scenario: 色板包含完整色系
WHEN genColorPalette() 被呼叫
THEN 產出的 HTML 包含以下色塊：
  - 8 個語意色：accent、green、yellow、red、purple、orange、cyan、pink
  - 3 個背景色：bg、surface、border

#### Scenario: 色塊顯示 hex 值
WHEN 色板區塊渲染完成
THEN 每個色塊下方顯示對應的 hex 色值文字

---

### Requirement: 響應式佈局

Dashboard 在三種斷點下自適應顯示。

#### Scenario: Mobile 斷點（< 640px）
WHEN 瀏覽器寬度 < 640px
THEN pipeline stages 改為垂直堆疊（`.pipe-header` 改為 `flex-direction: column`）
AND agent cards 改為單欄（`grid-template-columns: 1fr`）
AND TOC 隱藏
AND body padding 縮減

#### Scenario: Tablet 斷點（640-1024px）
WHEN 瀏覽器寬度介於 640-1024px
THEN agent cards grid 自動調整（`minmax(280px, 1fr)`）
AND pipeline stages 允許換行

#### Scenario: Desktop 斷點（> 1024px）
WHEN 瀏覽器寬度 > 1024px
THEN agent cards 可顯示雙欄
AND TOC 固定顯示在左側
AND body 左側 padding 為 TOC 留出空間

---

## MODIFIED Requirements

### Requirement: generate() 函式 HTML 輸出結構

`generate()` 函式的 HTML 輸出結構從平鋪式改為 section 式，首屏聚焦 Pipeline 流程圖。

原始結構：
```
<h1> → 進度條 → 統計 → <h2>建構順序 → <h2>開發流程 → <h2>Agent 詳細 → <h2>Plugin 詳情 → footer
```

修改後結構：
```
<nav>TOC</nav> → <h1> → 精簡進度 → <h2>開發流程 → <details>Agent 詳細 → <details>建構順序 → <details>統計 → <details>Plugin 詳情 → <details>色板 → footer
```

所有子函式（genFlowDiagram、genAgentDetails、genStats、genBuildOrder、genPluginCards）的輸入輸出介面不變。

### Requirement: CSS :root 色系

原始值（GitHub Dark）：
```css
--bg: #0d1117; --surface: #161b22; --surface2: #1c2129;
--border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
--accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
--red: #f85149; --purple: #bc8cff; --orange: #f0883e; --cyan: #39d2c0; --pink: #f778ba;
```

修改後值（Tokyo Night）：
```css
--bg: #1a1b26; --surface: #24283b; --surface2: #1f2335;
--border: #3b4261; --border-highlight: #545c7e;
--text: #c0caf5; --text-muted: #565f89;
--accent: #7aa2f7; --green: #9ece6a; --yellow: #e0af68;
--red: #f7768e; --purple: #bb9af7; --orange: #ff9e64; --cyan: #7dcfff; --pink: #ff007c;
--radius: 10px; --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
```

## REMOVED Requirements

（無移除項目）
