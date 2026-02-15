# Dashboard Theme System 測試套件

## 測試檔案總覽

| 檔案 | 測試數 | 目的 |
|------|:------:|------|
| `generate-themes.test.js` | 438 | 10 個主題定義驗證、theme.json schema、_utils.js 函式 |
| `generate-tokyo-night.test.js` | 40 | Tokyo Night 重設計回歸測試、HTML 結構、響應式佈局 |
| `theme-variants-coverage.test.js` | 139 | 補充覆蓋缺口：邊界案例、CLI、WCAG、半透明變數系統 |
| **總計** | **617** | **完整測試覆蓋** |

## 快速開始

### 執行所有測試

```bash
# 方式 1：逐一執行（適合 debug）
node dashboard/tests/generate-themes.test.js
node dashboard/tests/generate-tokyo-night.test.js
node dashboard/tests/theme-variants-coverage.test.js

# 方式 2：一次執行全部
bun test dashboard/tests/
```

### 執行單一測試檔案

```bash
node dashboard/tests/theme-variants-coverage.test.js
```

## 測試覆蓋範圍

### 1. 主題系統核心（438 tests）

#### hexToRgba 轉換（6 tests）
- ✅ 基本轉換（#RRGGBB → rgba）
- ✅ 邊界值（#000000、#ffffff）
- ✅ 自訂 alpha 值
- ✅ 錯誤處理（空字串、非法格式）

#### 10 個主題載入與驗證（360 tests）
- ✅ theme.json 載入成功
- ✅ validateTheme() schema 驗證
- ✅ 15 個色彩變數完整性（#RRGGBB 格式）
- ✅ 2 個設計 token（--radius、--card-shadow）
- ✅ category 合法值（dark/light）
- ✅ layout 合法值（5 種佈局）

#### buildColorToRgba 映射（7 tests）
- ✅ 自動從 hex 計算 rgba
- ✅ --text-muted 特殊處理（使用 --text 色系）
- ✅ 不同 alpha 值（0.03~0.15）

#### buildRootCSS 生成（21 tests）
- ✅ :root 變數完整性
- ✅ 色彩變數注入
- ✅ 設計 token 注入

#### layout.css 存在性（20 tests）
- ✅ 每個主題都有 layout.css
- ✅ CSS 語法正確（大括號閉合）

#### 邊界情況（4 tests）
- ✅ 不存在的主題拋錯
- ✅ 不完整主題驗證失敗

### 2. Tokyo Night 回歸測試（40 tests）

#### 色系完整性（5 tests）
- ✅ :root 包含所有 Tokyo Night 色值
- ✅ 無殘留 GitHub Dark 色值
- ✅ colorToRgba 動態計算
- ✅ 設計 token 變數

#### HTML 結構（15 tests）
- ✅ 折疊面板（<details>/<summary>）
- ✅ TOC 導航
- ✅ 色板預覽（11 色塊）
- ✅ 精簡進度列

#### 響應式佈局（7 tests）
- ✅ 三斷點（Mobile/Tablet/Desktop）
- ✅ TOC 固定定位
- ✅ 自適應卡片佈局

#### 零依賴驗證（4 tests）
- ✅ 無外部 CDN 引用
- ✅ CSS 內嵌

#### 邊界案例（9 tests）
- ✅ HTML 結構完整（DOCTYPE、meta）
- ✅ Footer 版號和統計
- ✅ wrapSection 函式邏輯

### 3. 覆蓋缺口補充（139 tests）

#### _utils.js 邊界案例（20 tests）
- ✅ hexToRgba 非法輸入錯誤處理
- ✅ buildColorToRgba 空物件、部分色彩
- ✅ buildRootCSS tweaks 參數消費（6 項）
- ✅ loadTheme 自訂 themesDir

#### 半透明 CSS 變數系統（41 tests）
- ✅ 20 個半透明變數格式（--color-NN）
- ✅ _base.css.js 使用的 19 個變數都有定義
- ✅ 變數值正確計算（基於主題色彩）

#### validateTheme 邊界案例（6 tests）
- ✅ 無效 category 拒絕
- ✅ 無效 layout 拒絕
- ✅ 缺少 tokens 拒絕

#### 10 個主題 HTML 生成（40 tests）
- ✅ 每個主題成功生成 HTML
- ✅ HTML 結構完整（DOCTYPE、:root）
- ✅ :root 包含主題色彩值

#### generate.js CLI（2 tests）
- ✅ --theme 不存在的主題報錯
- ✅ --output 參數正確生成到指定路徑

#### 色彩對比度 WCAG AA（16 tests）
- ✅ 10 個主題文字對比度 >= 4.5:1
- ✅ 3 個亮色主題特性驗證（背景亮度 > 70%、文字亮度 < 50%）

#### layout.css 覆蓋注入（10 tests）
- ✅ 每個主題的 layout.css 內容正確注入 HTML

#### 預設行為回歸（1 test）
- ✅ 無參數與 --theme tokyo-night 產生相同結果

## 規格對照

所有測試案例均從規格推導：

- **ADDED Requirements**（7 項）：
  - Theme JSON Schema → 10 主題驗證（360 tests）
  - 基礎 CSS 提取 → _base.css.js 驗證（41 tests）
  - 主題工具函式 → _utils.js 驗證（33 tests）
  - generate.js CLI → CLI 測試（2 tests）
  - genColorPalette 動態化 → 色板測試（包含在 Tokyo Night 測試中）
  - 10 個主題定義 → HTML 生成驗證（40 tests）
  - 5 種佈局模式 → layout.css 測試（20 tests）

- **MODIFIED Requirements**（3 項）：
  - generate.js CSS 組合機制 → buildFinalCSS 驗證（間接測試）
  - colorToRgba 自動化 → buildColorToRgba 測試（7 tests）
  - genColorPalette 參數化 → 色板動態化測試（包含在 Tokyo Night 測試中）

## 邊界案例與錯誤處理

- ❌ 空值 / null / undefined → hexToRgba 拋錯
- ❌ 非法格式（#RGB、#RRGGBBAA） → hexToRgba 拋錯
- ❌ 不存在的主題 → loadTheme 拋錯、CLI 報錯
- ❌ 無效 category/layout → validateTheme 拒絕
- ❌ 缺少必要欄位 → validateTheme 回報錯誤
- ✅ 無 # 前綴 → hexToRgba 正確處理
- ✅ alpha = 0 或 1 → 正確轉換
- ✅ 空物件 → buildColorToRgba 回傳空映射

## 覆蓋率目標

- **整體覆蓋率**：80%+ ✅
- **關鍵路徑**：100% ✅
  - theme.json schema 驗證
  - _utils.js 所有函式
  - generate.js CLI 參數處理
  - 10 個主題 HTML 生成
  - 色彩對比度 WCAG AA
  - 半透明變數系統

## 執行環境

- **Runtime**: Node.js 或 Bun
- **測試框架**: 自訂 assert（無外部依賴）
- **驗證標準**: OpenSpec Scenarios（WHEN/THEN 條件）

## Pipeline 結論標記

每個測試檔案最後一行輸出 Pipeline 結論標記（用於自動回退判斷）：

- 全部通過：`<!-- PIPELINE_VERDICT: PASS -->`
- 有失敗：`<!-- PIPELINE_VERDICT: FAIL:HIGH -->`

## 維護指南

### 新增主題

1. 建立 `dashboard/themes/{name}/theme.json`
2. 建立 `dashboard/themes/{name}/layout.css`
3. 測試自動涵蓋（10 主題迴圈）

### 新增測試

1. 在對應的測試檔案中新增 `test()` 區塊
2. 遵循 Scenario WHEN/THEN 格式
3. 更新此 README 的測試數量

### 修改規格

1. 同步更新 `openspec/changes/dashboard-theme-variants/specs/`
2. 根據 WHEN/THEN 條件更新測試
3. 確保所有測試通過後再提交
