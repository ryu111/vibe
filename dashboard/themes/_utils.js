/**
 * _utils.js — 主題系統工具函式
 *
 * 功能：
 * - loadTheme(name): 從 themes/{name}/theme.json 載入主題定義
 * - validateTheme(themeObj): 驗證主題 JSON schema
 * - hexToRgba(hex, alpha): 將 hex 色碼轉為 rgba 字串
 * - buildColorToRgba(colors): 從 theme.colors 自動生成 colorToRgba 映射
 * - buildRootCSS(colors, tokens): 生成 :root CSS 變數字串
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 從 hex 色碼轉為 rgba 字串
 * @param {string} hex - hex 色碼（#xxxxxx 或 xxxxxx）
 * @param {number} alpha - 透明度（0-1）
 * @returns {string} rgba(...) 字串
 */
function hexToRgba(hex, alpha = 0.15) {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) throw new Error(`無效的 hex 值：${hex}`);
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 從 theme.colors 自動生成 colorToRgba 映射物件
 * @param {object} colors - theme.json 的 colors 物件
 * @returns {object} CSS var → rgba 的映射
 */
function buildColorToRgba(colors) {
  const map = {};
  const alphaMap = {
    '--yellow': 0.06,
    '--cyan': 0.06,
    '--green': 0.06,
    '--accent': 0.06,
    '--purple': 0.08,
    '--red': 0.06,
    '--orange': 0.06,
    '--pink': 0.06,
    '--text-muted': 0.03,
  };
  for (const [varName, hex] of Object.entries(colors)) {
    const alpha = alphaMap[varName] || 0.05;
    map[`var(${varName})`] = hexToRgba(hex, alpha);
  }
  // 特別處理：text-muted 的 rgba 故意使用 --text 色系（#c0caf5 = 192,202,245）
  // 以獲得較亮的半透明底色
  if (colors['--text']) {
    map['var(--text-muted)'] = hexToRgba(colors['--text'], 0.03);
  }
  return map;
}

/**
 * 生成 :root CSS 變數字串
 * @param {object} colors - theme.json 的 colors 物件
 * @param {object} tokens - theme.json 的 tokens 物件
 * @param {object} tweaks - theme.json 的 tweaks 物件（可選）
 * @returns {string} :root { ... } CSS 字串
 */
function buildRootCSS(colors, tokens, tweaks = {}) {
  const colorVars = Object.entries(colors)
    .map(([varName, hex]) => `    ${varName}: ${hex};`)
    .join('\n');
  const tokenVars = Object.entries(tokens)
    .map(([varName, value]) => `    ${varName}: ${value};`)
    .join('\n');

  // tweaks 消費：fontFamily / codeFontFamily / maxWidth / spacing
  const tweaksVars = [];
  if (tweaks.fontFamily) {
    tweaksVars.push(`    --font-family: ${tweaks.fontFamily};`);
  }
  if (tweaks.codeFontFamily) {
    tweaksVars.push(`    --code-font-family: ${tweaks.codeFontFamily};`);
  }
  if (tweaks.maxWidth) {
    tweaksVars.push(`    --max-width: ${tweaks.maxWidth};`);
  }
  if (tweaks.spacing) {
    const { cardGap, sectionGap, padding } = tweaks.spacing;
    if (cardGap) tweaksVars.push(`    --card-gap: ${cardGap};`);
    if (sectionGap) tweaksVars.push(`    --section-gap: ${sectionGap};`);
    if (padding) tweaksVars.push(`    --spacing-padding: ${padding};`);
  }
  const tweaksCSS = tweaksVars.length > 0 ? `\n${tweaksVars.join('\n')}` : '';

  // 半透明色彩變數（用於背景、邊框等）
  const alphaVars = [];
  const alphaMap = [
    ['text', [0.02, 0.03, 0.04, 0.05, 0.06]],
    ['text-muted', [0.12]],
    ['green', [0.06, 0.15]],
    ['accent', [0.06, 0.10, 0.12, 0.15]],
    ['yellow', [0.06, 0.10]],
    ['red', [0.06, 0.12, 0.15]],
    ['purple', [0.10]],
    ['orange', []],
    ['cyan', [0.06, 0.15]],
    ['pink', []],
  ];
  for (const [colorName, alphas] of alphaMap) {
    const hex = colors[`--${colorName}`];
    if (!hex) continue;
    for (const alpha of alphas) {
      // 將 alpha 轉為兩位數百分比格式（0.06 → "06", 0.10 → "10", 0.15 → "15"）
      const varName = `--${colorName}-${String(Math.round(alpha * 100)).padStart(2, '0')}`;
      alphaVars.push(`    ${varName}: ${hexToRgba(hex, alpha)};`);
    }
  }

  return `  :root {
${colorVars}
${tokenVars}${tweaksCSS}
${alphaVars.join('\n')}
  }`;
}

/**
 * 載入主題 JSON 檔案
 * @param {string} themeName - 主題名稱（對應 themes/{themeName}/theme.json）
 * @param {string} themesDir - themes 目錄路徑（預設為 dashboard/themes）
 * @returns {object} 主題物件（包含 colors, tokens, layout, layoutCSS 等）
 */
function loadTheme(themeName, themesDir = path.join(process.cwd(), 'dashboard', 'themes')) {
  const themeJsonPath = path.join(themesDir, themeName, 'theme.json');
  const layoutCssPath = path.join(themesDir, themeName, 'layout.css');

  if (!fs.existsSync(themeJsonPath)) {
    throw new Error(`找不到主題定義：${themeJsonPath}`);
  }

  const themeObj = JSON.parse(fs.readFileSync(themeJsonPath, 'utf-8'));

  // 載入 layout.css（若存在）
  if (fs.existsSync(layoutCssPath)) {
    themeObj.layoutCSS = fs.readFileSync(layoutCssPath, 'utf-8');
  } else {
    themeObj.layoutCSS = '';
  }

  return themeObj;
}

/**
 * 驗證主題 JSON schema
 * @param {object} themeObj - 主題物件
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTheme(themeObj) {
  const errors = [];

  // 必要欄位
  const requiredFields = ['name', 'displayName', 'description', 'category', 'layout', 'colors', 'tokens'];
  for (const field of requiredFields) {
    if (!(field in themeObj)) errors.push(`缺少必要欄位：${field}`);
  }

  // 檢查 colors 必須包含 15 個色彩變數
  const requiredColors = [
    '--bg', '--surface', '--surface2',
    '--border', '--border-highlight',
    '--text', '--text-muted',
    '--accent', '--green', '--yellow', '--red', '--purple', '--orange', '--cyan', '--pink',
  ];
  if (themeObj.colors) {
    for (const color of requiredColors) {
      if (!(color in themeObj.colors)) errors.push(`colors 缺少變數：${color}`);
    }
  }

  // 檢查 tokens 必須包含 2 個設計 token
  const requiredTokens = ['--radius', '--card-shadow'];
  if (themeObj.tokens) {
    for (const token of requiredTokens) {
      if (!(token in themeObj.tokens)) errors.push(`tokens 缺少變數：${token}`);
    }
  }

  // 檢查 category 必須是 dark 或 light
  if (themeObj.category && !['dark', 'light'].includes(themeObj.category)) {
    errors.push(`category 必須是 'dark' 或 'light'，目前為：${themeObj.category}`);
  }

  // 檢查 layout 必須是 5 種合法值之一
  const validLayouts = ['single-col', 'dual-col', 'triple-col', 'bento', 'timeline'];
  if (themeObj.layout && !validLayouts.includes(themeObj.layout)) {
    errors.push(`layout 必須是以下之一：${validLayouts.join(', ')}，目前為：${themeObj.layout}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  hexToRgba,
  buildColorToRgba,
  buildRootCSS,
  loadTheme,
  validateTheme,
};
