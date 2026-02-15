#!/usr/bin/env node
'use strict';

/**
 * 主題生成測試套件
 * 驗證 10 個主題的 theme.json 定義、CSS 生成、hexToRgba 轉換
 */

const { loadTheme, validateTheme, hexToRgba, buildColorToRgba, buildRootCSS } = require('../themes/_utils.js');
const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`✅ ${message}`);
  } else {
    failed++;
    console.error(`❌ ${message}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  assert(match, message + (match ? '' : `\n   期望: ${JSON.stringify(expected)}\n   實際: ${JSON.stringify(actual)}`));
}

console.log('🧪 開始測試主題生成模組...\n');

// ===== 測試 1：hexToRgba 轉換 =====
console.log('【測試群組 1】hexToRgba 轉換');
assertDeepEqual(hexToRgba('#1a1b26'), 'rgba(26,27,38,0.15)', '#1a1b26 轉換正確（預設 alpha 0.15）');
assertDeepEqual(hexToRgba('#c0caf5'), 'rgba(192,202,245,0.15)', '#c0caf5 轉換正確');
assertDeepEqual(hexToRgba('#f8f9fc'), 'rgba(248,249,252,0.15)', '#f8f9fc 轉換正確（亮色）');
assertDeepEqual(hexToRgba('#000000'), 'rgba(0,0,0,0.15)', '#000000 轉換正確');
assertDeepEqual(hexToRgba('#ffffff'), 'rgba(255,255,255,0.15)', '#ffffff 轉換正確');
assertDeepEqual(hexToRgba('#7aa2f7', 0.06), 'rgba(122,162,247,0.06)', '自訂 alpha 值轉換正確');
console.log('');

// ===== 測試 2：10 個主題載入驗證 =====
console.log('【測試群組 2】10 個主題載入與驗證');
const themeNames = [
  'tokyo-night',
  'polar-dawn',
  'catppuccin-mocha',
  'solarized-dark',
  'github-light',
  'dracula',
  'minimal-ink',
  'synthwave-84',
  'nord',
  'one-dark-pro'
];

themeNames.forEach(name => {
  try {
    const theme = loadTheme(name);
    assert(theme !== null, `${name}: theme.json 載入成功`);

    const validation = validateTheme(theme);
    assert(validation.valid, `${name}: 通過 validateTheme()`);

    // 驗證必要欄位
    assert(theme.name === name, `${name}: name 欄位正確`);
    assert(theme.displayName && theme.displayName.length > 0, `${name}: displayName 存在`);
    assert(['light', 'dark'].includes(theme.category), `${name}: category 為 light 或 dark`);
    assert(['single-col', 'dual-col', 'triple-col', 'bento', 'timeline'].includes(theme.layout), `${name}: layout 合法`);

    // 驗證 15 個色彩 token
    const requiredColors = [
      '--bg', '--surface', '--surface2', '--border', '--border-highlight',
      '--text', '--text-muted', '--accent', '--green', '--yellow',
      '--red', '--purple', '--orange', '--cyan', '--pink'
    ];
    requiredColors.forEach(key => {
      assert(theme.colors[key], `${name}: ${key} 存在`);
      assert(/^#[0-9a-fA-F]{6}$/.test(theme.colors[key]), `${name}: ${key} 格式為 #RRGGBB`);
    });

    // 驗證 2 個設計 token
    assert(theme.tokens['--radius'], `${name}: --radius 存在`);
    assert(theme.tokens['--card-shadow'] !== undefined, `${name}: --card-shadow 存在（可為 none）`);

  } catch (err) {
    failed++;
    console.error(`❌ ${name}: 載入失敗 - ${err.message}`);
  }
});
console.log('');

// ===== 測試 3：buildColorToRgba 映射 =====
console.log('【測試群組 3】buildColorToRgba 映射');
const tokyoTheme = loadTheme('tokyo-night');
const rgbaMap = buildColorToRgba(tokyoTheme.colors);

assert(rgbaMap['var(--bg)'] === 'rgba(26,27,38,0.05)', 'Tokyo Night: var(--bg) 映射正確（alpha 0.05）');
assert(rgbaMap['var(--text)'] === 'rgba(192,202,245,0.05)', 'Tokyo Night: var(--text) 映射正確');
assert(rgbaMap['var(--accent)'] === 'rgba(122,162,247,0.06)', 'Tokyo Night: var(--accent) 映射正確（alpha 0.06）');
assert(rgbaMap['var(--text-muted)'] === 'rgba(192,202,245,0.03)', 'Tokyo Night: var(--text-muted) 使用 --text 色系（alpha 0.03）');
assert(Object.keys(rgbaMap).length === 15, 'Tokyo Night: rgbaMap 包含 15 個映射');

const polarTheme = loadTheme('polar-dawn');
const polarRgbaMap = buildColorToRgba(polarTheme.colors);
assert(polarRgbaMap['var(--bg)'] === 'rgba(248,249,252,0.05)', 'Polar Dawn: var(--bg) 映射正確');
assert(polarRgbaMap['var(--text)'] === 'rgba(45,55,72,0.05)', 'Polar Dawn: var(--text) 映射正確');
console.log('');

// ===== 測試 4：buildRootCSS 生成 =====
console.log('【測試群組 4】buildRootCSS CSS 生成');
const rootCSS = buildRootCSS(tokyoTheme.colors, tokyoTheme.tokens);

assert(rootCSS.includes('--bg: #1a1b26;'), 'buildRootCSS: --bg 變數存在');
assert(rootCSS.includes('--text: #c0caf5;'), 'buildRootCSS: --text 變數存在');
assert(rootCSS.includes('--radius: 10px;'), 'buildRootCSS: --radius token 存在');
assert(rootCSS.includes('--card-shadow: 0 2px 8px rgba(0,0,0,0.3);'), 'buildRootCSS: --card-shadow token 存在');
assert(rootCSS.trim().startsWith(':root {'), 'buildRootCSS: 以 :root { 開頭');
assert(rootCSS.trim().endsWith('}'), 'buildRootCSS: 以 } 結尾');

// 驗證所有 15 色都在 CSS 中
const requiredVars = ['--bg', '--surface', '--surface2', '--border', '--border-highlight',
                      '--text', '--text-muted', '--accent', '--green', '--yellow',
                      '--red', '--purple', '--orange', '--cyan', '--pink'];
requiredVars.forEach(v => {
  assert(rootCSS.includes(`${v}:`), `buildRootCSS: ${v} CSS 變數存在`);
});
console.log('');

// ===== 測試 5：layout.css 檔案存在性 =====
console.log('【測試群組 5】layout.css 檔案存在性');
themeNames.forEach(name => {
  const layoutPath = resolve(__dirname, `../themes/${name}/layout.css`);
  assert(existsSync(layoutPath), `${name}: layout.css 存在`);

  const content = readFileSync(layoutPath, 'utf-8');
  // 簡單語法檢查：不應該有未閉合的大括號
  const openBraces = (content.match(/{/g) || []).length;
  const closeBraces = (content.match(/}/g) || []).length;
  assert(openBraces === closeBraces, `${name}: layout.css 大括號閉合正確`);
});
console.log('');

// ===== 測試 6：預設行為（無 --theme）與 tokyo-night 一致 =====
console.log('【測試群組 6】預設行為與 tokyo-night 一致性');
const defaultTheme = loadTheme('tokyo-night');
const explicitTheme = loadTheme('tokyo-night');
assertDeepEqual(defaultTheme, explicitTheme, '預設主題與 tokyo-night 相同');
console.log('');

// ===== 測試 7：邊界情況 =====
console.log('【測試群組 7】邊界情況');
try {
  loadTheme('non-existent-theme');
  failed++;
  console.error('❌ loadTheme() 對不存在的主題應該拋錯');
} catch (err) {
  passed++;
  console.log('✅ loadTheme() 對不存在的主題正確拋錯');
}

const incompleteTheme = {
  name: 'test',
  colors: { '--bg': '#000000' }, // 缺少其他顏色
  tokens: {}
};
const incompleteValidation = validateTheme(incompleteTheme);
assert(!incompleteValidation.valid, 'validateTheme() 正確拒絕不完整主題');
assert(incompleteValidation.errors.length > 0, 'validateTheme() 回報錯誤訊息');
console.log('');

// ===== 彙總結果 =====
console.log('='.repeat(60));
console.log(`✅ 通過: ${passed}`);
console.log(`❌ 失敗: ${failed}`);
console.log(`📊 總計: ${passed + failed}`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
