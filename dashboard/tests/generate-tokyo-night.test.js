#!/usr/bin/env node
/**
 * generate-tokyo-night.test.js — 測試 Dashboard Tokyo Night 重設計
 *
 * 測試範圍：
 * 1. Tokyo Night 色系完整性（:root CSS + colorToRgba）
 * 2. HTML 結構（折疊面板、TOC、色板、精簡進度）
 * 3. wrapSection 函式邏輯（折疊 vs 非折疊）
 * 4. 響應式 CSS（三種斷點）
 * 5. 零依賴驗證（無外部 CDN）
 *
 * 執行：node dashboard/tests/generate-tokyo-night.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ─── 測試工具函式 ────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 3);
      lines.forEach(l => console.log(`     ${l.trim()}`));
    }
  }
}

// ─── 載入產出的 HTML ──────────────────────────────

const ROOT = path.join(__dirname, '..', '..');
const OUTPUT_PATH = path.join(ROOT, 'dashboard', 'dashboard.html');

// 檢查檔案是否存在
if (!fs.existsSync(OUTPUT_PATH)) {
  console.error(`\n❌ 錯誤：找不到 ${OUTPUT_PATH}`);
  console.error(`請先執行：node dashboard/scripts/generate.js\n`);
  process.exit(1);
}

const html = fs.readFileSync(OUTPUT_PATH, 'utf-8');

// ═══════════════════════════════════════════════
console.log('\n🎨 Tokyo Night 色系完整性測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// Spec Requirement: Tokyo Night 色系定義 → Scenario: :root CSS 變數完整替換

const TOKYO_NIGHT_COLORS = {
  '--bg': '#1a1b26',
  '--surface': '#24283b',
  '--surface2': '#1f2335',
  '--border': '#3b4261',
  '--border-highlight': '#545c7e',
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

const GITHUB_DARK_COLORS = [
  '#0d1117', // GitHub Dark --bg
  '#161b22', // GitHub Dark --surface
  '#1c2129', // GitHub Dark --surface2
  '#30363d', // GitHub Dark --border
];

test('CSS :root 包含所有 Tokyo Night 色值', () => {
  const rootMatch = html.match(/:root\s*\{([^}]+)\}/);
  assert(rootMatch, '找不到 :root 區塊');
  const rootContent = rootMatch[1];

  for (const [varName, hex] of Object.entries(TOKYO_NIGHT_COLORS)) {
    const regex = new RegExp(`${varName.replace('--', '\\-\\-')}:\\s*${hex}`);
    assert(regex.test(rootContent), `缺少或值錯誤：${varName}: ${hex}`);
  }
});

test('CSS :root 包含設計 token 變數', () => {
  const rootMatch = html.match(/:root\s*\{([^}]+)\}/);
  const rootContent = rootMatch[1];

  assert(/--radius:\s*10px/.test(rootContent), '缺少 --radius: 10px');
  assert(/--card-shadow:\s*0 2px 8px rgba\(0,0,0,0\.3\)/.test(rootContent), '缺少 --card-shadow');
});

test('無殘留 GitHub Dark 色值', () => {
  // 允許的例外：rgba(0,0,0,0.3) 用於 shadow
  const cleanHtml = html.replace(/rgba\(0,0,0,0\.3\)/g, '');

  for (const ghColor of GITHUB_DARK_COLORS) {
    assert(!cleanHtml.includes(ghColor), `仍存在 GitHub Dark 色值：${ghColor}`);
  }
});

// Spec Requirement: Tokyo Night 色系定義 → Scenario: colorToRgba 映射與色系同步

test('colorToRgba 已改為動態計算（檢查 _utils.js buildColorToRgba 存在）', () => {
  // colorToRgba 在 v1.0.30 改為動態從主題 colors 計算
  // 驗證 _utils.js 的 buildColorToRgba 函式存在
  const utilsPath = path.join(ROOT, 'dashboard', 'themes', '_utils.js');
  assert(fs.existsSync(utilsPath), '找不到 themes/_utils.js');

  const utilsContent = fs.readFileSync(utilsPath, 'utf-8');
  assert(/function buildColorToRgba\(/.test(utilsContent), '找不到 buildColorToRgba 函式');
  assert(/hexToRgba\(hex,\s*alpha\)/.test(utilsContent), 'buildColorToRgba 未使用 hexToRgba 函式');

  // 驗證 generate.js 使用動態初始化
  const generatePath = path.join(ROOT, 'dashboard', 'scripts', 'generate.js');
  const generateContent = fs.readFileSync(generatePath, 'utf-8');
  assert(/colorToRgba\s*=\s*buildColorToRgba\(theme\.colors\)/.test(generateContent), 'generate.js 未動態初始化 colorToRgba');
});

test('卡片級元素使用 var(--radius)', () => {
  // 檢查關鍵卡片元素的 border-radius
  const radiusPatterns = [
    /\.plugin-card\s*\{[^}]*border-radius:\s*var\(--radius\)/s,
    /\.agent-card\s*\{[^}]*border-radius:\s*var\(--radius\)/s,
    /\.pipe-agent\s*\{[^}]*border-radius:\s*var\(--radius\)/s,
    /\.guard-card\s*\{[^}]*border-radius:\s*var\(--radius\)/s,
    /details\s*\{[^}]*border-radius:\s*var\(--radius\)/s,
  ];

  for (const pattern of radiusPatterns) {
    assert(pattern.test(html), `某卡片元素未使用 var(--radius)：${pattern.source.slice(0, 50)}...`);
  }
});

// ═══════════════════════════════════════════════
console.log('\n📦 HTML 結構完整性測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// Spec Requirement: 折疊面板 → Scenario: 次要區塊預設折疊

test('HTML 包含至少 5 個 <details> 折疊面板', () => {
  const detailsCount = (html.match(/<details/g) || []).length;
  assert(detailsCount >= 5, `<details> 數量不足：期望 ≥5，實際 ${detailsCount}`);
});

test('折疊面板的 id 屬性正確設置', () => {
  // 依據 generate.js，預期的 id 列表
  const expectedIds = ['agent-details', 'build-order', 'stats', 'plugins', 'color-palette'];

  for (const id of expectedIds) {
    const regex = new RegExp(`<details[^>]*id="${id}"`);
    assert(regex.test(html), `折疊面板缺少 id="${id}"`);
  }
});

test('summary 元素包含正確的標題文字', () => {
  const expectedTitles = ['Agent 詳細流程', '建構順序', '組件統計', 'Plugin 詳情', '色板'];

  for (const title of expectedTitles) {
    const regex = new RegExp(`<summary[^>]*>${title}</summary>`);
    assert(regex.test(html), `折疊面板缺少標題：${title}`);
  }
});

test('summary 元素具備 cursor: pointer 樣式', () => {
  assert(/summary\s*\{[^}]*cursor:\s*pointer/s.test(html), 'summary 缺少 cursor: pointer');
});

test('summary 具備 hover 互動效果', () => {
  assert(/summary:hover\s*\{[^}]*background:/s.test(html), 'summary:hover 缺少背景色變化');
});

// Spec Requirement: 精簡進度指示 → Scenario: 精簡進度列渲染

test('存在精簡進度列 (.compact-progress)', () => {
  assert(html.includes('class="compact-progress"'), '缺少 .compact-progress 元素');
});

test('精簡進度列包含必要元素', () => {
  assert(html.includes('compact-progress-label'), '缺少進度標籤');
  assert(html.includes('compact-progress-bar'), '缺少進度條');
  assert(html.includes('compact-progress-pct'), '缺少百分比顯示');
  assert(html.includes('compact-progress-count'), '缺少總組件數顯示');
});

test('精簡進度條高度不超過 8px', () => {
  const barStyleMatch = html.match(/\.compact-progress-bar\s*\{[^}]*height:\s*(\d+)px/s);
  assert(barStyleMatch, '找不到 .compact-progress-bar 的 height 定義');

  const height = parseInt(barStyleMatch[1]);
  assert(height <= 8, `進度條高度過高：期望 ≤8px，實際 ${height}px`);
});

// Spec Requirement: TOC 導航 → Scenario: TOC 包含所有區塊連結

test('存在 TOC 導航 (.toc)', () => {
  assert(/<nav class="toc">/.test(html), '缺少 <nav class="toc"> 元素');
});

test('TOC 包含正確數量的錨點連結', () => {
  const tocMatch = html.match(/<nav class="toc">[\s\S]*?<\/nav>/);
  assert(tocMatch, '找不到完整的 TOC 區塊');

  const tocContent = tocMatch[0];
  const links = (tocContent.match(/<a href="#[^"]+"/g) || []);
  assert(links.length >= 5, `TOC 連結數量不足：期望 ≥5，實際 ${links.length}`);

  // 驗證關鍵錨點
  const expectedAnchors = ['#progress', '#pipeline-flow', '#agent-details', '#build-order', '#plugins', '#color-palette'];
  for (const anchor of expectedAnchors) {
    assert(tocContent.includes(`href="${anchor}"`), `TOC 缺少錨點：${anchor}`);
  }
});

// Spec Requirement: 色板預覽 → Scenario: 色板包含完整色系

test('存在色板區塊 (.color-palette)', () => {
  assert(html.includes('class="color-palette"'), '缺少 .color-palette 元素');
});

test('色板包含 11 個色塊', () => {
  // 找到 details id="color-palette" 整個區塊
  const paletteMatch = html.match(/<details[^>]*id="color-palette"[^>]*>[\s\S]*?<\/details>/);
  assert(paletteMatch, '找不到完整的色板區塊');

  const paletteContent = paletteMatch[0];
  const swatches = (paletteContent.match(/class="color-swatch"/g) || []);
  assert(swatches.length === 11, `色塊數量錯誤：期望 11，實際 ${swatches.length}`);
});

test('色板包含 8 個語意色', () => {
  const semanticColors = ['accent', 'green', 'yellow', 'red', 'purple', 'orange', 'cyan', 'pink'];
  const paletteMatch = html.match(/<details[^>]*id="color-palette"[^>]*>[\s\S]*?<\/details>/);
  assert(paletteMatch, '找不到完整的色板區塊');
  const paletteContent = paletteMatch[0];

  for (const color of semanticColors) {
    assert(paletteContent.includes(`>${color}<`), `色板缺少語意色：${color}`);
  }
});

test('色板包含 3 個背景色', () => {
  const bgColors = ['bg', 'surface', 'border'];
  const paletteMatch = html.match(/<details[^>]*id="color-palette"[^>]*>[\s\S]*?<\/details>/);
  assert(paletteMatch, '找不到完整的色板區塊');
  const paletteContent = paletteMatch[0];

  for (const color of bgColors) {
    assert(paletteContent.includes(`>${color}<`), `色板缺少背景色：${color}`);
  }
});

test('色塊顯示 hex 值', () => {
  const paletteMatch = html.match(/<details[^>]*id="color-palette"[^>]*>[\s\S]*?<\/details>/);
  assert(paletteMatch, '找不到完整的色板區塊');
  const paletteContent = paletteMatch[0];

  // 檢查是否存在 hex 格式的文字（#xxxxxx）
  const hexMatches = (paletteContent.match(/#[0-9a-f]{6}/gi) || []);
  assert(hexMatches.length >= 11, `色板 hex 值數量不足：期望 ≥11，實際 ${hexMatches.length}`);
});

// ═══════════════════════════════════════════════
console.log('\n🔧 wrapSection 函式邏輯測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// Spec Requirement: wrapSection 統一區塊結構

test('非折疊區塊使用 <h2> + content 結構', () => {
  // 檢查「開發流程」（id=pipeline-flow，非折疊）
  const pipelineMatch = html.match(/<h2 id="pipeline-flow">開發流程<\/h2>/);
  assert(pipelineMatch, '非折疊區塊（開發流程）結構錯誤：應為 <h2 id="...">');
});

test('折疊區塊使用 <details>/<summary> 結構', () => {
  // 檢查「Agent 詳細流程」（id=agent-details，折疊）
  const detailsMatch = html.match(/<details[^>]*id="agent-details"[^>]*>[\s\S]*?<summary>Agent 詳細流程<\/summary>/);
  assert(detailsMatch, '折疊區塊（Agent 詳細流程）結構錯誤：應為 <details id="..."><summary>');
});

test('折疊區塊的 id 屬性在 <details> 元素上', () => {
  const detailsIds = (html.match(/<details[^>]*id="([^"]+)"/g) || []);
  assert(detailsIds.length >= 5, '折疊區塊的 id 數量不足');

  // 驗證 id 不在 <summary> 上
  const summaryIds = (html.match(/<summary[^>]*id="/g) || []);
  assert(summaryIds.length === 0, '<summary> 不應包含 id 屬性（應在 <details> 上）');
});

// ═══════════════════════════════════════════════
console.log('\n📱 響應式佈局測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// Spec Requirement: 響應式佈局 → 三種斷點

test('存在 Mobile 斷點 CSS（< 640px）', () => {
  assert(/@media\s*\(max-width:\s*639px\)/.test(html), '缺少 Mobile 斷點（max-width: 639px）');
});

test('存在 Tablet 斷點 CSS（640-1024px）', () => {
  assert(/@media\s*\(min-width:\s*640px\)\s+and\s+\(max-width:\s*1023px\)/.test(html), '缺少 Tablet 斷點（640-1024px）');
});

test('存在 Desktop 斷點 CSS（>= 1024px）', () => {
  assert(/@media\s*\(min-width:\s*1024px\)/.test(html), '缺少 Desktop 斷點（min-width: 1024px）');
});

test('TOC 在 Mobile 時隱藏', () => {
  // Mobile CSS 規則在單一 @media 區塊內，包含多個選擇器（每個在同一行）
  const mobileMatch = html.match(/@media\s*\(max-width:\s*639px\)\s*\{([\s\S]*?)\n\s*\}/);
  assert(mobileMatch, '找不到 Mobile 斷點的 CSS 規則');

  const mobileCss = mobileMatch[1];
  // CSS 格式：.toc { display: none; }（單行壓縮）
  assert(/\.toc\s*\{\s*display:\s*none;\s*\}/.test(mobileCss), 'Mobile 時 TOC 未設置 display: none');
});

test('TOC 在 Desktop 時固定定位', () => {
  const tocStyleMatch = html.match(/\.toc\s*\{([^}]+)\}/s);
  assert(tocStyleMatch, '找不到 .toc 的 CSS 定義');

  const tocCss = tocStyleMatch[1];
  assert(/position:\s*fixed/.test(tocCss), 'TOC 缺少 position: fixed');
});

test('Pipeline stages 在 Mobile 時垂直堆疊', () => {
  const mobileMatch = html.match(/@media\s*\(max-width:\s*639px\)\s*\{([\s\S]*?)\n\s*\}/);
  assert(mobileMatch, '找不到 Mobile 斷點的 CSS 規則');
  const mobileCss = mobileMatch[1];

  // CSS 格式：.pipe-header { flex-direction: column; align-items: stretch; gap: 0.5rem; }
  assert(/\.pipe-header\s*\{\s*flex-direction:\s*column/.test(mobileCss), 'Mobile 時 .pipe-header 未設置 flex-direction: column');
});

test('Agent cards 在 Mobile 時改為單欄', () => {
  const mobileMatch = html.match(/@media\s*\(max-width:\s*639px\)\s*\{([\s\S]*?)\n\s*\}/);
  assert(mobileMatch, '找不到 Mobile 斷點的 CSS 規則');
  const mobileCss = mobileMatch[1];

  // CSS 格式：.agent-cards { grid-template-columns: 1fr; }
  assert(/\.agent-cards\s*\{\s*grid-template-columns:\s*1fr;\s*\}/.test(mobileCss), 'Mobile 時 .agent-cards 未設置單欄佈局');
});

test('Desktop body 左側留出 TOC 空間', () => {
  const desktopMatch = html.match(/@media\s*\(min-width:\s*1024px\)\s*\{([^}]+)\}/s);
  assert(desktopMatch, '找不到 Desktop 斷點的 CSS 規則');

  const desktopCss = desktopMatch[1];
  assert(/body\s*\{[^}]*padding-left:\s*280px/.test(desktopCss), 'Desktop 時 body 未設置左側 padding');
});

// ═══════════════════════════════════════════════
console.log('\n🔒 零依賴驗證測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('generate.js 只依賴 fs 和 path', () => {
  const generatePath = path.join(ROOT, 'dashboard', 'scripts', 'generate.js');
  const generateContent = fs.readFileSync(generatePath, 'utf-8');

  // 檢查 require 語句（排除註解）
  const requireMatches = generateContent
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
    .match(/require\(['"]([^'"]+)['"]\)/g) || [];

  const allowedModules = ['fs', 'path', './generate-vibe-doc'];
  for (const req of requireMatches) {
    const moduleName = req.match(/require\(['"]([^'"]+)['"]\)/)[1];
    assert(allowedModules.includes(moduleName), `generate.js 依賴非核心模組：${moduleName}`);
  }
});

test('產出的 HTML 無外部 CDN 引用', () => {
  const cdnPatterns = [
    /https?:\/\/cdn\./i,
    /https?:\/\/unpkg\.com/i,
    /https?:\/\/cdnjs\.cloudflare\.com/i,
    /https?:\/\/ajax\.googleapis\.com/i,
    /<script[^>]*src=["']https?:/i,
    /<link[^>]*href=["']https?:/i,
  ];

  for (const pattern of cdnPatterns) {
    assert(!pattern.test(html), `HTML 包含外部 CDN 引用：${pattern.source}`);
  }
});

test('CSS 內嵌在 <style> 標籤中', () => {
  assert(/<style>[\s\S]+<\/style>/.test(html), 'CSS 未內嵌在 <style> 標籤中');
});

test('無外部樣式表引用', () => {
  assert(!/<link[^>]*rel=["']stylesheet["']/.test(html), 'HTML 包含外部樣式表 <link rel="stylesheet">');
});

// ═══════════════════════════════════════════════
console.log('\n🎯 邊界案例測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('HTML 結構完整（有 DOCTYPE、html、head、body）', () => {
  assert(html.startsWith('<!DOCTYPE html>'), '缺少 <!DOCTYPE html>');
  assert(/<html[^>]*lang="zh-Hant"/.test(html), '缺少 <html lang="zh-Hant">');
  assert(/<head>/.test(html) && /<\/head>/.test(html), '缺少 <head> 標籤');
  assert(/<body>/.test(html) && /<\/body>/.test(html), '缺少 <body> 標籤');
});

test('HTML meta 標籤正確設置', () => {
  assert(/<meta charset="UTF-8">/.test(html), '缺少 charset 設置');
  assert(/<meta name="viewport"/.test(html), '缺少 viewport 設置');
  assert(/<title>Vibe Marketplace/.test(html), '缺少或錯誤的 <title>');
});

test('Footer 包含版號和組件統計', () => {
  assert(/<div class="footer">/.test(html), '缺少 footer 元素');
  assert(/Vibe Marketplace v\d+\.\d+\.\d+/.test(html), 'Footer 缺少版號');
  assert(/\d+\/\d+ 組件完成/.test(html), 'Footer 缺少組件統計');
});

test('HTML 不包含空白的依賴關係區塊', () => {
  // 依據 MEMORY.md v1.0.11 提及的「移除空白依賴關係區塊」
  // 這裡驗證不存在空的 <section> 或類似結構
  const emptyBlocks = html.match(/<section[^>]*>\s*<\/section>/g);
  assert(!emptyBlocks || emptyBlocks.length === 0, 'HTML 包含空白區塊');
});

test('精簡進度列使用正確的色系函式', () => {
  // 檢查 genCompactProgress 函式是否使用 progressColor 和 fillClass
  const generatePath = path.join(ROOT, 'dashboard', 'scripts', 'generate.js');
  const generateContent = fs.readFileSync(generatePath, 'utf-8');

  const compactProgressMatch = generateContent.match(/function genCompactProgress[\s\S]*?\n\}/);
  assert(compactProgressMatch, '找不到 genCompactProgress 函式定義');

  const functionBody = compactProgressMatch[0];
  assert(functionBody.includes('progressColor('), 'genCompactProgress 未使用 progressColor 函式');
  assert(functionBody.includes('fillClass('), 'genCompactProgress 未使用 fillClass 函式');
});

// ═══════════════════════════════════════════════
console.log('\n📊 測試總結');
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
