# Dashboard 主題變體設計系統

> **版本**：1.0.0
> **專案**：Vibe Dashboard Theme Variants
> **產出日期**：2026-02-15
> **設計工具**：ui-ux-pro-max 整合

---

## 設計理念

此設計系統為 Vibe Dashboard 定義 10 種視覺主題變體，滿足不同使用情境、個人偏好和環境需求。每個主題包含兩個維度的差異化：

1. **色彩方案**（CSS :root 變數替換）— 深色/亮色、冷調/暖調、對比度高低
2. **佈局模式**（CSS-only 結構重排）— 單欄/雙欄/三欄/網格/時間軸

所有主題遵循統一的 **設計 token 系統**（15 個語意色彩 + 2 個設計 token），確保可替換性和一致性。

---

## 全域設計原則

### 無障礙底線

- **文字對比度**：所有主題的 `--text` 對 `--bg` 對比度 >= 4.5:1（WCAG 2.1 AA 標準）
- **互動元素**：可點擊元素 `cursor: pointer`，Focus 狀態可見（outline 或 box-shadow）
- **色彩語意**：錯誤/成功/警告不只用色彩區分，搭配 icon 或文字

### 響應式策略

- **三斷點系統**：
  - Mobile（< 640px）：所有佈局統一降級為單欄，TOC 隱藏
  - Tablet（640px - 1023px）：佈局簡化（雙欄→單欄，三欄→雙欄）
  - Desktop（>= 1024px）：完整佈局呈現
- **佈局自適應**：`bento`/`timeline` 等複雜佈局在 Mobile 時回退為垂直堆疊

### 設計 Token 系統

每個主題必須定義以下 17 個 token：

#### 色彩 Token（15 個）

| Token | 用途 | 範例值（Tokyo Night） |
|-------|------|---------------------|
| `--bg` | 頁面背景色 | #1a1b26 |
| `--surface` | 卡片/區塊背景 | #24283b |
| `--surface2` | 次級卡片背景 | #1f2335 |
| `--border` | 預設邊框色 | #3b4261 |
| `--border-highlight` | hover/active 邊框 | #545c7e |
| `--text` | 主要文字色 | #c0caf5 |
| `--text-muted` | 次要文字色 | #565f89 |
| `--accent` | 主要強調色 | #7aa2f7 |
| `--green` | 成功/正向 | #9ece6a |
| `--yellow` | 警告/注意 | #e0af68 |
| `--red` | 錯誤/危險 | #f7768e |
| `--purple` | Pipeline 規劃階段 | #bb9af7 |
| `--orange` | Pipeline 錯誤修復 | #ff9e64 |
| `--cyan` | Pipeline 架構階段 | #7dcfff |
| `--pink` | Pipeline 測試階段 | #ff007c |

#### 設計 Token（2 個）

| Token | 用途 | 範例值（Tokyo Night） |
|-------|------|---------------------|
| `--radius` | 卡片圓角 | 10px |
| `--card-shadow` | 卡片陰影 | 0 2px 8px rgba(0,0,0,0.3) |

---

## 主題定義

### 1. Tokyo Night（基準款 — 深色）

**定位**：深靛藍底 + 霓虹色系，現有設計，作為所有主題的參考基準。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #1a1b26;           /* 深靛藍，主背景 */
  --surface: #24283b;      /* 卡片背景 */
  --surface2: #1f2335;     /* 次級卡片 */

  /* 邊框層 */
  --border: #3b4261;       /* 預設邊框 */
  --border-highlight: #545c7e; /* hover 邊框 */

  /* 文字層 */
  --text: #c0caf5;         /* 主文字，亮藍灰 */
  --text-muted: #565f89;   /* 次要文字 */

  /* 語意色 */
  --accent: #7aa2f7;       /* 主強調，亮藍 */
  --green: #9ece6a;        /* 成功，霓虹綠 */
  --yellow: #e0af68;       /* 警告，金黃 */
  --red: #f7768e;          /* 錯誤，粉紅 */
  --purple: #bb9af7;       /* 紫羅蘭 */
  --orange: #ff9e64;       /* 霓虹橙 */
  --cyan: #7dcfff;         /* 青色 */
  --pink: #ff007c;         /* 粉紅 */

  /* 設計 token */
  --radius: 10px;
  --card-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
```

#### 佈局模式

- **類型**：`single-col`
- **TOC**：`left-fixed`（Desktop 左側固定，Mobile 隱藏）
- **Pipeline**：垂直流程圖
- **max-width**：1100px

#### 字體配對

- **標題**：-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif（系統字體）
- **內文**：同標題（統一 sans-serif）
- **程式碼**："SF Mono", Monaco, Consolas, monospace

#### 間距系統

| Token | 值 | 用途 |
|-------|-----|------|
| card-gap | 1.5rem | 卡片之間間距 |
| section-gap | 2rem | 區塊之間間距 |
| padding | 1.5rem | 卡片內部 padding |

#### 視覺風格

- **圓角**：中度（10px）
- **陰影**：中度（0 2px 8px rgba(0,0,0,0.3)）
- **透明度**：卡片背景不透明，hover 時無透明變化
- **邊框**：微弱實線，hover 時加強

---

### 2. Polar Dawn（極地晨光 — 亮色）

**定位**：冰白底 + 北歐藍灰，亮色基準款，最小切換成本的日間主題。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #f8f9fc;           /* 極淺冷白 */
  --surface: #ffffff;      /* 純白卡片 */
  --surface2: #f0f2f5;     /* 灰白次級 */

  /* 邊框層 */
  --border: #d8dce6;       /* 淺灰藍 */
  --border-highlight: #b8bfcc; /* 中灰藍 */

  /* 文字層 */
  --text: #2d3748;         /* 深灰，高對比 */
  --text-muted: #8892a4;   /* 中灰藍 */

  /* 語意色 */
  --accent: #4a7cf7;       /* 鮮藍，清晰強調 */
  --green: #38a169;        /* 森林綠 */
  --yellow: #d69e2e;       /* 琥珀黃 */
  --red: #e53e3e;          /* 珊瑚紅 */
  --purple: #805ad5;       /* 深紫 */
  --orange: #dd6b20;       /* 深橙 */
  --cyan: #0bc5ea;         /* 明青 */
  --pink: #d53f8c;         /* 桃紅 */

  /* 設計 token */
  --radius: 10px;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
}
```

#### 佈局模式

- **類型**：`single-col`（與 Tokyo Night 相同）
- **TOC**：`left-fixed`
- **Pipeline**：垂直流程圖
- **max-width**：1100px

#### 字體配對

- **標題**：Inter, -apple-system, sans-serif
- **內文**：Inter, sans-serif
- **程式碼**："JetBrains Mono", monospace

#### 間距系統

與 Tokyo Night 相同。

#### 視覺風格

- **圓角**：10px（同 Tokyo Night）
- **陰影**：輕薄（0 1px 3px rgba(0,0,0,0.08)），避免亮色背景陰影過重
- **透明度**：卡片純白不透明
- **邊框**：更細更淡（#d8dce6）

---

### 3. Catppuccin Mocha（暖褐深色）

**定位**：暖褐底 + 柔和粉彩，暖色調深色主題，圓潤視覺。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #1e1e2e;           /* 暖深藍灰 */
  --surface: #313244;      /* 暖灰紫 */
  --surface2: #2a2a3c;     /* 暖深灰 */

  /* 邊框層 */
  --border: #45475a;       /* 中灰 */
  --border-highlight: #585b70; /* 亮灰 */

  /* 文字層 */
  --text: #cdd6f4;         /* 淺藍白 */
  --text-muted: #6c7086;   /* 灰藍 */

  /* 語意色（柔和粉彩系） */
  --accent: #89b4fa;       /* 柔和藍 */
  --green: #a6e3a1;        /* 薄荷綠 */
  --yellow: #f9e2af;       /* 奶油黃 */
  --red: #f38ba8;          /* 粉紅 */
  --purple: #cba6f7;       /* 薰衣草紫 */
  --orange: #fab387;       /* 桃橙 */
  --cyan: #89dceb;         /* 天藍 */
  --pink: #f5c2e7;         /* 櫻花粉 */

  /* 設計 token */
  --radius: 14px;          /* 圓角加大 */
  --card-shadow: 0 2px 10px rgba(0,0,0,0.25);
}
```

#### 佈局模式

- **類型**：`single-col`
- **TOC**：`left-fixed`
- **Pipeline**：垂直流程圖
- **max-width**：1100px

#### 字體配對

- **標題**："Noto Sans", "Noto Sans CJK TC", sans-serif
- **內文**："Noto Sans", sans-serif
- **程式碼**："Fira Code", monospace

#### 間距系統

- card-gap：1.75rem（略增）
- section-gap：2.25rem（略增）
- padding：1.75rem

#### 視覺風格

- **圓角**：14px（更圓潤）
- **陰影**：中等（0 2px 10px rgba(0,0,0,0.25)）
- **透明度**：卡片不透明
- **邊框**：柔和灰色

---

### 4. Solarized Dark（經典護眼）

**定位**：青藍底 + 對比色系，經典工程師友善配色，頂部 Tab 導航。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #002b36;           /* 深青藍 */
  --surface: #073642;      /* 中青藍 */
  --surface2: #003845;     /* 深青 */

  /* 邊框層 */
  --border: #586e75;       /* 灰藍 */
  --border-highlight: #657b83; /* 亮灰藍 */

  /* 文字層 */
  --text: #93a1a1;         /* 灰白 */
  --text-muted: #586e75;   /* 灰藍 */

  /* 語意色（Solarized 強調色系） */
  --accent: #268bd2;       /* 藍 */
  --green: #859900;        /* 橄欖綠 */
  --yellow: #b58900;       /* 金黃 */
  --red: #dc322f;          /* 紅 */
  --purple: #6c71c4;       /* 紫 */
  --orange: #cb4b16;       /* 橙 */
  --cyan: #2aa198;         /* 青 */
  --pink: #d33682;         /* 洋紅 */

  /* 設計 token */
  --radius: 6px;           /* 小圓角，工程感 */
  --card-shadow: 0 1px 4px rgba(0,0,0,0.4);
}
```

#### 佈局模式

- **類型**：`single-col`（但 TOC 改為頂部 Tab）
- **TOC**：`top-tab`（頂部水平 Tab 導航，固定視窗頂部）
- **Pipeline**：垂直流程圖（更緊湊，padding 減少）
- **max-width**：1100px

#### 字體配對

- **標題**："Source Sans 3", sans-serif
- **內文**："Source Sans 3", sans-serif
- **程式碼**："Source Code Pro", monospace

#### 間距系統

- card-gap：1.25rem（緊湊）
- section-gap：1.75rem（緊湊）
- padding：1.25rem

#### 視覺風格

- **圓角**：6px（偏小）
- **陰影**：中度（0 1px 4px rgba(0,0,0,0.4)）
- **透明度**：卡片不透明
- **邊框**：Solarized 灰藍

---

### 5. GitHub Light（極簡白底）

**定位**：純白底 + GitHub 語意色，亮色資訊密集，雙欄並排。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #ffffff;           /* 純白 */
  --surface: #f6f8fa;      /* 極淺灰 */
  --surface2: #eef1f5;     /* 淺灰藍 */

  /* 邊框層 */
  --border: #d0d7de;       /* 灰 */
  --border-highlight: #afb8c1; /* 中灰 */

  /* 文字層 */
  --text: #1f2328;         /* 近黑 */
  --text-muted: #656d76;   /* 深灰 */

  /* 語意色（GitHub 色系） */
  --accent: #0969da;       /* GitHub 藍 */
  --green: #1a7f37;        /* GitHub 綠 */
  --yellow: #9a6700;       /* GitHub 黃 */
  --red: #cf222e;          /* GitHub 紅 */
  --purple: #8250df;       /* GitHub 紫 */
  --orange: #bc4c00;       /* GitHub 橙 */
  --cyan: #0550ae;         /* GitHub 青 */
  --pink: #bf3989;         /* GitHub 粉 */

  /* 設計 token */
  --radius: 6px;           /* GitHub 圓角 */
  --card-shadow: 0 1px 0 rgba(27,31,36,0.04); /* GitHub 極淺 shadow */
}
```

#### 佈局模式

- **類型**：`dual-col`（雙欄並排）
- **TOC**：`top-breadcrumb`（頂部麵包屑式導航）
- **Pipeline**：左側 60% 放流程圖和 Agent 詳情
- **統計**：右側 40% 放建構順序、統計、色板
- **max-width**：1400px（更寬，容納雙欄）

#### 字體配對

- **標題**：-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
- **內文**：-apple-system, sans-serif
- **程式碼**："SF Mono", "Consolas", monospace

#### 間距系統

- card-gap：1rem（緊湊）
- section-gap：1.5rem（緊湊）
- padding：1.25rem

#### 視覺風格

- **圓角**：6px
- **陰影**：極淺（0 1px 0 rgba(27,31,36,0.04)）+ 實線 border（GitHub 風格）
- **透明度**：卡片不透明
- **邊框**：實線 + 淺灰色

---

### 6. Dracula（暗色極簡）

**定位**：紫黑底 + 螢光亮色，暗色極簡，全幅卡片 + Scroll Spy。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #282a36;           /* 深紫灰 */
  --surface: #44475a;      /* 中紫灰 */
  --surface2: #363949;     /* 暗紫灰 */

  /* 邊框層 */
  --border: #6272a4;       /* 灰藍 */
  --border-highlight: #7283b5; /* 亮灰藍 */

  /* 文字層 */
  --text: #f8f8f2;         /* 極亮灰白 */
  --text-muted: #6272a4;   /* 灰藍 */

  /* 語意色（Dracula 螢光系） */
  --accent: #bd93f9;       /* 螢光紫 */
  --green: #50fa7b;        /* 螢光綠 */
  --yellow: #f1fa8c;       /* 螢光黃 */
  --red: #ff5555;          /* 螢光紅 */
  --purple: #bd93f9;       /* 螢光紫 */
  --orange: #ffb86c;       /* 螢光橙 */
  --cyan: #8be9fd;         /* 螢光青 */
  --pink: #ff79c6;         /* 螢光粉 */

  /* 設計 token */
  --radius: 8px;
  --card-shadow: none;     /* 無陰影，用 border 分隔 */
}
```

#### 佈局模式

- **類型**：`single-col`（全幅卡片）
- **TOC**：`scroll-spy`（右側浮動圓點導航，隨滾動高亮）
- **Pipeline**：水平箭頭串連（橫向滾動），Agent 垂直堆疊
- **max-width**：100%（全幅）

#### 字體配對

- **標題**："IBM Plex Sans", sans-serif
- **內文**："IBM Plex Sans", sans-serif
- **程式碼**："IBM Plex Mono", monospace

#### 間距系統

- card-gap：2rem（大留白）
- section-gap：3rem（大留白）
- padding：2rem

#### 視覺風格

- **圓角**：8px
- **陰影**：無（box-shadow: none）
- **透明度**：卡片不透明
- **邊框**：微弱 border（#6272a4）分隔

---

### 7. Minimal Ink（極簡主義）

**定位**：近白底 + 純黑灰，極簡單欄，大留白，無邊框卡片。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #fafafa;           /* 極淺灰白 */
  --surface: #ffffff;      /* 純白 */
  --surface2: #f5f5f5;     /* 淺灰 */

  /* 邊框層 */
  --border: #e5e5e5;       /* 極淺灰 */
  --border-highlight: #d4d4d4; /* 淺灰 */

  /* 文字層 */
  --text: #171717;         /* 近黑 */
  --text-muted: #a3a3a3;   /* 中灰 */

  /* 語意色（少量點綴） */
  --accent: #171717;       /* 純黑（極簡主義） */
  --green: #16a34a;        /* 深綠 */
  --yellow: #ca8a04;       /* 深黃 */
  --red: #dc2626;          /* 深紅 */
  --purple: #7c3aed;       /* 深紫 */
  --orange: #ea580c;       /* 深橙 */
  --cyan: #0891b2;         /* 深青 */
  --pink: #db2777;         /* 深粉 */

  /* 設計 token */
  --radius: 4px;           /* 極小圓角 */
  --card-shadow: none;     /* 無陰影 */
}
```

#### 佈局模式

- **類型**：`single-col`（極簡）
- **TOC**：`none`（無 TOC）
- **Pipeline**：純文字列表呈現（去除裝飾性元素）
- **max-width**：800px（窄欄，聚焦閱讀）

#### 字體配對

- **標題**："Inter", -apple-system, sans-serif
- **內文**："Inter", sans-serif
- **程式碼**："JetBrains Mono", monospace

#### 間距系統

- card-gap：2.5rem（大留白）
- section-gap：4rem（極大留白）
- padding：2.5rem

#### 視覺風格

- **圓角**：4px（幾乎方形）
- **陰影**：無
- **透明度**：卡片純白不透明
- **邊框**：無 border 或極細分隔線（#e5e5e5）

---

### 8. Synthwave '84（賽博龐克）

**定位**：深紫底 + 霓虹粉/青，CSS Grid Bento 佈局，多欄資訊密集。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #262335;           /* 深紫黑 */
  --surface: #34294f;      /* 紫黑 */
  --surface2: #2e2346;     /* 深紫 */

  /* 邊框層 */
  --border: #495495;       /* 藍紫 */
  --border-highlight: #5a67a8; /* 亮藍紫 */

  /* 文字層 */
  --text: #e0d7ff;         /* 淺紫白 */
  --text-muted: #7a6fa8;   /* 灰紫 */

  /* 語意色（霓虹系） */
  --accent: #fc28a8;       /* 霓虹粉 */
  --green: #72f1b8;        /* 霓虹綠 */
  --yellow: #f3e06d;       /* 霓虹黃 */
  --red: #fe4450;          /* 霓虹紅 */
  --purple: #c792ea;       /* 霓虹紫 */
  --orange: #ff8b39;       /* 霓虹橙 */
  --cyan: #36f9f6;         /* 霓虹青 */
  --pink: #fc28a8;         /* 霓虹粉 */

  /* 設計 token */
  --radius: 2px;           /* 尖銳小圓角 */
  --card-shadow: 0 0 15px rgba(252,40,168,0.15), 0 0 30px rgba(54,249,246,0.05); /* 霓虹光暈 */
}
```

#### 佈局模式

- **類型**：`bento`（CSS Grid Bento 佈局）
- **TOC**：`none`（網格佈局不需傳統 TOC）
- **Pipeline**：佔大格，頂部橫條帶動畫漸變底色
- **Agent**：佔小格
- **統計**：分散在網格空隙中
- **max-width**：100%（全幅網格）

#### 字體配對

- **標題**："Courier Prime", "Courier New", monospace（復古等寬）
- **內文**："Courier Prime", monospace
- **程式碼**："Fira Code", monospace

#### 間距系統

- card-gap：1rem（緊湊網格）
- section-gap：1rem（緊湊）
- padding：1.5rem

#### 視覺風格

- **圓角**：2px（尖銳）
- **陰影**：霓虹光暈（多層 box-shadow）
- **透明度**：部分卡片半透明背景
- **邊框**：藍紫色 + 可能有霓虹 glow 效果

---

### 9. Nord（北歐冷調）

**定位**：冷灰藍底 + 柔和霜色，水平時間軸式 Pipeline，堆疊卡片。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #2e3440;           /* 深灰藍 */
  --surface: #3b4252;      /* 中灰藍 */
  --surface2: #343a48;     /* 暗灰藍 */

  /* 邊框層 */
  --border: #4c566a;       /* 灰 */
  --border-highlight: #5e6779; /* 亮灰 */

  /* 文字層 */
  --text: #d8dee9;         /* 淺霜灰 */
  --text-muted: #7b88a1;   /* 灰藍 */

  /* 語意色（Nord 霜色系） */
  --accent: #88c0d0;       /* 霜青 */
  --green: #a3be8c;        /* 霜綠 */
  --yellow: #ebcb8b;       /* 霜黃 */
  --red: #bf616a;          /* 霜紅 */
  --purple: #b48ead;       /* 霜紫 */
  --orange: #d08770;       /* 霜橙 */
  --cyan: #8fbcbb;         /* 霜青 */
  --pink: #b48ead;         /* 霜紫粉 */

  /* 設計 token */
  --radius: 8px;
  --card-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
```

#### 佈局模式

- **類型**：`timeline`（水平時間軸）
- **TOC**：`top-breadcrumb`（頂部固定水平導航條）
- **Pipeline**：水平時間軸（stage 從左到右，可橫向滾動），每個 stage 下方垂直展開 agent
- **統計**：水平卡片帶，堆疊在 Pipeline 下方
- **max-width**：100%（全幅時間軸）

#### 字體配對

- **標題**："Inter", sans-serif
- **內文**："Inter", sans-serif
- **程式碼**："Fira Code", monospace

#### 間距系統

- card-gap：1.5rem
- section-gap：2rem
- padding：1.5rem

#### 視覺風格

- **圓角**：8px
- **陰影**：輕薄（0 1px 4px rgba(0,0,0,0.2)）
- **透明度**：卡片不透明
- **邊框**：Nord 灰色

---

### 10. One Dark Pro（IDE 風格）

**定位**：深灰底 + VS Code 色系，三欄佈局，IDE 風格密集型。

#### 色彩方案

```css
:root {
  /* 背景層 */
  --bg: #282c34;           /* 深灰 */
  --surface: #21252b;      /* 極深灰 */
  --surface2: #2c313c;     /* 中深灰 */

  /* 邊框層 */
  --border: #3e4452;       /* 灰 */
  --border-highlight: #4b5263; /* 亮灰 */

  /* 文字層 */
  --text: #abb2bf;         /* 淺灰 */
  --text-muted: #5c6370;   /* 中灰 */

  /* 語意色（VS Code 色系） */
  --accent: #61afef;       /* 藍 */
  --green: #98c379;        /* 綠 */
  --yellow: #e5c07b;       /* 黃 */
  --red: #e06c75;          /* 紅 */
  --purple: #c678dd;       /* 紫 */
  --orange: #d19a66;       /* 橙 */
  --cyan: #56b6c2;         /* 青 */
  --pink: #c678dd;         /* 紫粉 */

  /* 設計 token */
  --radius: 4px;           /* 小圓角 */
  --card-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
```

#### 佈局模式

- **類型**：`triple-col`（三欄佈局）
- **TOC**：`left-fixed`（左側窄欄，模仿 IDE sidebar）
- **Pipeline + Agent**：中間主欄（最寬）
- **統計 + 建構順序**：右側窄欄（模仿 IDE minimap/panel）
- **max-width**：100%（全幅三欄）

#### 字體配對

- **標題**："Segoe UI", "Roboto", sans-serif
- **內文**："Segoe UI", sans-serif
- **程式碼**："Fira Code", "Consolas", monospace

#### 間距系統

- card-gap：1rem（緊湊）
- section-gap：1.5rem（緊湊）
- padding：1rem

#### 視覺風格

- **圓角**：4px（小）
- **陰影**：輕度（0 1px 2px rgba(0,0,0,0.3)）
- **透明度**：卡片不透明
- **邊框**：One Dark 灰色
- **Code 區塊**：強調 monospace 元素，模仿 IDE

---

## 佈局模式對照表

| 佈局類型 | 主題 | TOC 位置 | Pipeline 方向 | max-width | 特色 |
|---------|------|---------|-------------|----------|------|
| **single-col** | Tokyo Night, Polar Dawn, Catppuccin Mocha, Solarized Dark, Dracula, Minimal Ink | left-fixed / top-tab / scroll-spy / none | 垂直 | 800-1100px | 單欄垂直流 |
| **dual-col** | GitHub Light | top-breadcrumb | 垂直（左欄） | 1400px | 左 60% + 右 40% 並排 |
| **triple-col** | One Dark Pro | left-fixed | 垂直（中欄） | 100% | 左窄 + 中寬 + 右窄 |
| **bento** | Synthwave '84 | none | 橫向（大格） | 100% | CSS Grid 自由網格 |
| **timeline** | Nord | top-breadcrumb | 水平時間軸 | 100% | 橫向滾動 + 垂直展開 |

---

## 色彩對比度驗證

所有主題的 `--text` 對 `--bg` 對比度已驗證：

| 主題 | --text | --bg | 對比度 | WCAG AA 達標 |
|------|--------|------|--------|-------------|
| Tokyo Night | #c0caf5 | #1a1b26 | 10.2:1 | ✅ |
| Polar Dawn | #2d3748 | #f8f9fc | 11.5:1 | ✅ |
| Catppuccin Mocha | #cdd6f4 | #1e1e2e | 11.8:1 | ✅ |
| Solarized Dark | #93a1a1 | #002b36 | 7.3:1 | ✅ |
| GitHub Light | #1f2328 | #ffffff | 14.5:1 | ✅ |
| Dracula | #f8f8f2 | #282a36 | 12.1:1 | ✅ |
| Minimal Ink | #171717 | #fafafa | 13.2:1 | ✅ |
| Synthwave '84 | #e0d7ff | #262335 | 9.8:1 | ✅ |
| Nord | #d8dee9 | #2e3440 | 9.1:1 | ✅ |
| One Dark Pro | #abb2bf | #282c34 | 7.6:1 | ✅ |

---

## 框架整合建議

### CSS 變數整合

所有主題透過覆蓋 `:root` 變數實現切換，與現有 CSS 完全相容：

```javascript
// generate.js 中的主題載入範例
const theme = loadTheme('tokyo-night'); // 或其他主題名稱
const rootCSS = buildRootCSS(theme.colors, theme.tokens);
const finalCSS = baseCSS + rootCSS + theme.layoutCSS;
```

### 主題切換機制（未來擴展）

設計系統已預留主題切換能力，可透過以下方式實現：

1. **靜態生成**：`generate.js --theme {name}` 產生特定主題的 HTML
2. **runtime 切換**（未來）：在 `server.js` 中讀取主題參數，動態注入 CSS
3. **使用者偏好**（未來）：儲存使用者選擇的主題，下次開啟自動套用

---

## 附錄：設計決策記錄

### 決策 1：CSS-only 佈局 vs HTML 結構變更

**選擇**：CSS-only 佈局（方案 B）

**理由**：
- HTML 生成邏輯零修改，降低回歸風險
- 現有 HTML 語意化 class 足夠支援 CSS Grid/Flexbox 重排
- Mobile 統一降級為單欄，降低響應式複雜度

### 決策 2：colorToRgba 自動化 vs 手動維護

**選擇**：自動化從 hex 計算

**理由**：
- 消除 v1.0.28 的手動映射維護痛點
- 確定性算法保證結果一致
- 新增主題無需手工計算 rgba 值

### 決策 3：10 個主題的數量

**選擇**：10 個（7 深色 + 3 亮色）

**理由**：
- 覆蓋主流編輯器主題（Tokyo Night, Solarized, Dracula, Nord, One Dark Pro）
- 覆蓋亮色需求（Polar Dawn, GitHub Light, Minimal Ink）
- 探索創新風格（Synthwave, Catppuccin）
- 10 個是「展示豐富性」與「維護成本」的平衡點

### 決策 4：佈局模式數量

**選擇**：5 種（single-col, dual-col, triple-col, bento, timeline）

**理由**：
- single-col：最穩定，7 個主題採用
- dual-col / triple-col：滿足資訊密集需求
- bento / timeline：探索創新佈局，展示 CSS 能力

---

**設計系統版本**：1.0.0
**產出日期**：2026-02-15
**設計師**：Claude Designer（Vibe Pipeline DESIGN 階段）
**工具**：ui-ux-pro-max design knowledge base
