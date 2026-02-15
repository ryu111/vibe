#!/usr/bin/env node
'use strict';
/**
 * theme-variants-coverage.test.js — 補充測試覆蓋缺口
 *
 * 測試範圍：
 * 1. _utils.js 邊界案例和錯誤處理
 * 2. 半透明 CSS 變數系統完整性
 * 3. generate.js CLI 參數處理
 * 4. 10 個主題 HTML 生成驗證
 * 5. 色彩對比度 WCAG AA 驗證
 * 6. tweaks 參數消費
 * 7. _base.css.js 使用的半透明變數完整性
 */

const { hexToRgba, buildColorToRgba, buildRootCSS, loadTheme, validateTheme } = require('../themes/_utils.js');
const { getBaseCSS } = require('../themes/_base.css.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function assertThrows(fn, expectedSubstring, message) {
  try {
    fn();
    failed++;
    console.error(`❌ ${message}（應該拋錯但沒有）`);
  } catch (err) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      failed++;
      console.error(`❌ ${message}（錯誤訊息不符：${err.message}）`);
    } else {
      passed++;
      console.log(`✅ ${message}`);
    }
  }
}

console.log('🧪 開始測試主題系統覆蓋缺口...\n');

// ═══════════════════════════════════════════════
console.log('【測試群組 1】hexToRgba 邊界案例與錯誤處理');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

assertThrows(
  () => hexToRgba(''),
  '無效的 hex 值',
  'hexToRgba() 空字串應該拋錯'
);

assertThrows(
  () => hexToRgba('#fff'),
  '無效的 hex 值',
  'hexToRgba() 短格式 #RGB 應該拋錯'
);

assertThrows(
  () => hexToRgba('#ffffffff'),
  '無效的 hex 值',
  'hexToRgba() 長格式 #RRGGBBAA 應該拋錯'
);

assertThrows(
  () => hexToRgba('notahex'),
  '無效的 hex 值',
  'hexToRgba() 非 hex 字串應該拋錯'
);

assert(hexToRgba('1a1b26') === 'rgba(26,27,38,0.15)', 'hexToRgba() 無 # 前綴也能正確轉換');
assert(hexToRgba('#000000', 0) === 'rgba(0,0,0,0)', 'hexToRgba() alpha=0 轉換正確');
assert(hexToRgba('#ffffff', 1) === 'rgba(255,255,255,1)', 'hexToRgba() alpha=1 轉換正確');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 2】buildColorToRgba 邊界案例');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const emptyMap = buildColorToRgba({});
assert(Object.keys(emptyMap).length === 0, 'buildColorToRgba() 空物件回傳空映射');

const partialColors = { '--accent': '#7aa2f7' };
const partialMap = buildColorToRgba(partialColors);
assert(partialMap['var(--accent)'] === 'rgba(122,162,247,0.06)', 'buildColorToRgba() 部分色彩正確映射');
assert(!partialMap['var(--text-muted)'], 'buildColorToRgba() 缺 --text 時不生成 --text-muted 覆蓋');

const fullColors = {
  '--bg': '#1a1b26',
  '--surface': '#24283b',
  '--text': '#c0caf5',
  '--text-muted': '#565f89',
  '--accent': '#7aa2f7',
  '--green': '#9ece6a',
  '--yellow': '#e0af68',
  '--red': '#f7768e',
  '--purple': '#bb9af7',
  '--orange': '#ff9e64',
  '--cyan': '#7dcfff',
  '--pink': '#ff007c',
};
const fullMap = buildColorToRgba(fullColors);
assert(fullMap['var(--text-muted)'] === hexToRgba(fullColors['--text'], 0.03),
  'buildColorToRgba() --text-muted 使用 --text 色系（特殊處理）');
assert(fullMap['var(--purple)'] === hexToRgba(fullColors['--purple'], 0.08),
  'buildColorToRgba() --purple 使用 alpha 0.08');
assert(fullMap['var(--bg)'] === hexToRgba(fullColors['--bg'], 0.05),
  'buildColorToRgba() --bg 使用預設 alpha 0.05');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 3】buildRootCSS 半透明變數完整性');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const tokens = { '--radius': '10px', '--card-shadow': '0 2px 8px rgba(0,0,0,0.3)' };
const rootCSS = buildRootCSS(fullColors, tokens);

// 驗證 20 個半透明變數格式（--color-NN 兩位數）
const expectedAlphaVars = [
  '--text-02', '--text-03', '--text-04', '--text-05', '--text-06',
  '--text-muted-12',
  '--green-06', '--green-15',
  '--accent-06', '--accent-10', '--accent-12', '--accent-15',
  '--yellow-06', '--yellow-10',
  '--red-06', '--red-12', '--red-15',
  '--purple-10',
  '--cyan-06', '--cyan-15',
];

for (const varName of expectedAlphaVars) {
  assert(rootCSS.includes(`${varName}:`), `buildRootCSS() 包含半透明變數：${varName}`);
}

// 驗證格式：--text-06: rgba(192,202,245,0.06);
assert(/--text-06:\s*rgba\(192,202,245,0\.06\)/.test(rootCSS),
  'buildRootCSS() --text-06 值正確計算');
assert(/--accent-10:\s*rgba\(122,162,247,0\.1\)/.test(rootCSS),
  'buildRootCSS() --accent-10 值正確計算（0.1 無尾零）');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 4】buildRootCSS tweaks 參數消費');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const tweaks = {
  fontFamily: "'Inter', sans-serif",
  codeFontFamily: "'Fira Code', monospace",
  maxWidth: '1200px',
  spacing: {
    cardGap: '1.5rem',
    sectionGap: '3rem',
    padding: '2.5rem',
  },
  toc: 'left-fixed',
};

const rootWithTweaks = buildRootCSS(fullColors, tokens, tweaks);

assert(rootWithTweaks.includes("--font-family: 'Inter', sans-serif;"),
  'buildRootCSS() tweaks.fontFamily 注入 :root');
assert(rootWithTweaks.includes("--code-font-family: 'Fira Code', monospace;"),
  'buildRootCSS() tweaks.codeFontFamily 注入 :root');
assert(rootWithTweaks.includes('--max-width: 1200px;'),
  'buildRootCSS() tweaks.maxWidth 注入 :root');
assert(rootWithTweaks.includes('--card-gap: 1.5rem;'),
  'buildRootCSS() tweaks.spacing.cardGap 注入 :root');
assert(rootWithTweaks.includes('--section-gap: 3rem;'),
  'buildRootCSS() tweaks.spacing.sectionGap 注入 :root');
assert(rootWithTweaks.includes('--spacing-padding: 2.5rem;'),
  'buildRootCSS() tweaks.spacing.padding 注入 :root');

const rootWithoutTweaks = buildRootCSS(fullColors, tokens);
assert(!rootWithoutTweaks.includes('--font-family:'),
  'buildRootCSS() 無 tweaks 時不注入額外變數');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 5】_base.css.js 半透明變數使用驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const baseCSS = getBaseCSS();

// 提取所有使用的半透明變數（var(--xxx-NN) 格式）
const usedAlphaVarsMatches = baseCSS.match(/var\(--[a-z-]+-\d{2}\)/g) || [];
const usedAlphaVars = [...new Set(usedAlphaVarsMatches)].map(v => v.replace(/var\(|\)/g, ''));

// 驗證所有使用的變數都在 expectedAlphaVars 中有定義（或在實作中生成）
const rootCSSForValidation = buildRootCSS(fullColors, tokens);
for (const varName of usedAlphaVars) {
  assert(rootCSSForValidation.includes(`${varName}:`),
    `_base.css.js 使用的 ${varName} 在 buildRootCSS() 中有定義`);
}

console.log(`  （_base.css.js 使用了 ${usedAlphaVars.length} 個半透明變數）`);
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 6】validateTheme 邊界案例');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const invalidCategory = {
  name: 'test',
  displayName: 'Test',
  description: 'Test theme',
  category: 'medium', // 無效值
  layout: 'single-col',
  colors: fullColors,
  tokens,
};
const categoryResult = validateTheme(invalidCategory);
assert(!categoryResult.valid, 'validateTheme() 拒絕無效 category');
assert(categoryResult.errors.some(e => e.includes('category')),
  'validateTheme() 回報 category 錯誤');

const invalidLayout = {
  name: 'test',
  displayName: 'Test',
  description: 'Test theme',
  category: 'dark',
  layout: 'quad-col', // 無效值
  colors: fullColors,
  tokens,
};
const layoutResult = validateTheme(invalidLayout);
assert(!layoutResult.valid, 'validateTheme() 拒絕無效 layout');
assert(layoutResult.errors.some(e => e.includes('layout')),
  'validateTheme() 回報 layout 錯誤');

const missingTokens = {
  name: 'test',
  displayName: 'Test',
  description: 'Test theme',
  category: 'dark',
  layout: 'single-col',
  colors: fullColors,
  tokens: { '--radius': '10px' }, // 缺 --card-shadow
};
const tokensResult = validateTheme(missingTokens);
assert(!tokensResult.valid, 'validateTheme() 拒絕缺少 tokens');
assert(tokensResult.errors.some(e => e.includes('--card-shadow')),
  'validateTheme() 回報缺少的 token');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 7】loadTheme 自訂 themesDir');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const customThemesDir = path.join(process.cwd(), 'dashboard', 'themes');
const theme1 = loadTheme('tokyo-night', customThemesDir);
assert(theme1.name === 'tokyo-night', 'loadTheme() 自訂 themesDir 載入成功');
assert(theme1.layoutCSS !== undefined, 'loadTheme() 包含 layoutCSS 屬性');

const theme2 = loadTheme('polar-dawn'); // 使用預設路徑
assert(theme2.name === 'polar-dawn', 'loadTheme() 預設路徑載入成功');
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 8】10 個主題 HTML 生成驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const themeNames = [
  'tokyo-night', 'polar-dawn', 'catppuccin-mocha', 'solarized-dark',
  'github-light', 'dracula', 'minimal-ink', 'synthwave-84', 'nord', 'one-dark-pro'
];

for (const themeName of themeNames) {
  try {
    const outputPath = `/tmp/dashboard-${themeName}.html`;
    execSync(`node dashboard/scripts/generate.js --theme ${themeName} --output ${outputPath}`, {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 10000,
    });

    assert(fs.existsSync(outputPath), `${themeName}: HTML 生成成功`);

    const html = fs.readFileSync(outputPath, 'utf-8');
    assert(html.startsWith('<!DOCTYPE html>'), `${themeName}: HTML 結構完整`);

    // 驗證 :root 包含該主題的色彩
    const theme = loadTheme(themeName);
    const rootMatch = html.match(/:root\s*\{([^}]+)\}/);
    assert(rootMatch !== null, `${themeName}: 包含 :root 區塊`);

    const rootContent = rootMatch[1];
    const firstColor = Object.values(theme.colors)[0];
    assert(rootContent.includes(firstColor),
      `${themeName}: :root 包含主題色彩值`);

    // 清理暫存檔
    fs.unlinkSync(outputPath);

  } catch (err) {
    failed++;
    console.error(`❌ ${themeName}: 生成失敗 - ${err.message}`);
  }
}
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 9】generate.js CLI 錯誤處理');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

try {
  execSync('node dashboard/scripts/generate.js --theme non-existent-theme', {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 5000,
  });
  failed++;
  console.error('❌ --theme 不存在的主題應該報錯（但沒有）');
} catch (err) {
  passed++;
  console.log('✅ --theme 不存在的主題正確拋錯');
}

try {
  const outputPath = '/tmp/dashboard-cli-output.html';
  execSync(`node dashboard/scripts/generate.js --theme polar-dawn --output ${outputPath}`, {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 10000,
  });
  assert(fs.existsSync(outputPath), '--output 參數正確生成到指定路徑');
  fs.unlinkSync(outputPath);
} catch (err) {
  failed++;
  console.error(`❌ --output 參數失敗：${err.message}`);
}
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 10】色彩對比度 WCAG AA 驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

/**
 * 計算相對亮度（WCAG 2.1 公式）
 * @param {string} hex - #RRGGBB 格式
 * @returns {number} 0-1 之間的亮度值
 */
function getLuminance(hex) {
  const h = hex.replace(/^#/, '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;

  const toLinear = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 計算對比度
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number} 對比度（1-21）
 */
function getContrastRatio(hex1, hex2) {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const themeName of themeNames) {
  const theme = loadTheme(themeName);
  const bgColor = theme.colors['--bg'];
  const textColor = theme.colors['--text'];
  const contrast = getContrastRatio(bgColor, textColor);

  // WCAG AA 標準：正文文字至少 4.5:1
  assert(contrast >= 4.5,
    `${themeName}: 文字對比度 ${contrast.toFixed(2)}:1 >= 4.5:1 (WCAG AA)`);
}

// 驗證亮色主題的特性
const lightThemes = ['polar-dawn', 'github-light', 'minimal-ink'];
for (const themeName of lightThemes) {
  const theme = loadTheme(themeName);
  const bgLuminance = getLuminance(theme.colors['--bg']);
  const textLuminance = getLuminance(theme.colors['--text']);

  assert(bgLuminance > 0.7,
    `${themeName}: 亮色主題背景亮度 ${(bgLuminance * 100).toFixed(1)}% > 70%`);
  assert(textLuminance < 0.5,
    `${themeName}: 亮色主題文字亮度 ${(textLuminance * 100).toFixed(1)}% < 50%（深色文字）`);
}
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 11】layout.css 覆蓋注入驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

for (const themeName of themeNames) {
  const theme = loadTheme(themeName);
  const outputPath = `/tmp/dashboard-layout-${themeName}.html`;

  try {
    execSync(`node dashboard/scripts/generate.js --theme ${themeName} --output ${outputPath}`, {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 10000,
    });

    const html = fs.readFileSync(outputPath, 'utf-8');

    // 如果主題有 layout.css 內容，驗證是否注入到 HTML
    if (theme.layoutCSS && theme.layoutCSS.trim().length > 0) {
      // 檢查 layout.css 的第一行（通常是註解或第一個選擇器）
      const firstLine = theme.layoutCSS.split('\n').find(l => l.trim().length > 0);
      assert(html.includes(firstLine.trim()),
        `${themeName}: layout.css 內容已注入 HTML`);
    }

    fs.unlinkSync(outputPath);

  } catch (err) {
    failed++;
    console.error(`❌ ${themeName}: layout.css 注入驗證失敗 - ${err.message}`);
  }
}
console.log('');

// ═══════════════════════════════════════════════
console.log('【測試群組 12】預設行為回歸測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const defaultOutputPath = '/tmp/dashboard-default.html';
const explicitTokyoPath = '/tmp/dashboard-tokyo-explicit.html';

try {
  // 生成預設（無參數）
  execSync('node dashboard/scripts/generate.js', {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 10000,
  });

  // 生成明確指定 tokyo-night
  execSync(`node dashboard/scripts/generate.js --theme tokyo-night --output ${explicitTokyoPath}`, {
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 10000,
  });

  const defaultHTML = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'dashboard.html'), 'utf-8');
  const explicitHTML = fs.readFileSync(explicitTokyoPath, 'utf-8');

  // 比對 :root 區塊（應完全相同）
  const defaultRoot = defaultHTML.match(/:root\s*\{([^}]+)\}/)[1];
  const explicitRoot = explicitHTML.match(/:root\s*\{([^}]+)\}/)[1];

  assert(defaultRoot === explicitRoot,
    '預設行為（無參數）與 --theme tokyo-night 產生相同的 :root CSS');

  fs.unlinkSync(explicitTokyoPath);

} catch (err) {
  failed++;
  console.error(`❌ 預設行為回歸測試失敗：${err.message}`);
}
console.log('');

// ═══════════════════════════════════════════════
console.log('📊 測試總結');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

console.log(`\n✅ 通過：${passed} 個測試`);
console.log(`❌ 失敗：${failed} 個測試\n`);

if (failed > 0) {
  console.log('<!-- PIPELINE_VERDICT: FAIL:HIGH -->');
  process.exit(1);
} else {
  console.log('<!-- PIPELINE_VERDICT: PASS -->');
  process.exit(0);
}
