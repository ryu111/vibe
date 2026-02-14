#!/usr/bin/env node
/**
 * test-check.js — PostToolUse hook (matcher: Write|Edit)
 *
 * 檔案被修改後，判斷是否為業務邏輯檔案。
 * - 非業務邏輯（測試、設定、樣式、文件、hook 腳本）→ 靜默退出
 * - 業務邏輯 → systemMessage 提醒執行測試
 *
 * 取代原 prompt hook（haiku），避免 LLM 回應注入 context 干擾工作流。
 */
'use strict';
const path = require('path');
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

// 不需要提醒測試的副檔名
const SKIP_EXTENSIONS = new Set([
  // 測試
  '.test.js', '.test.ts', '.test.jsx', '.test.tsx',
  '.spec.js', '.spec.ts', '.spec.jsx', '.spec.tsx',
  // 設定
  '.json', '.yaml', '.yml', '.toml', '.env', '.lock',
  // 樣式
  '.css', '.scss', '.less', '.sass',
  // 文件
  '.md', '.mdx', '.txt', '.rst',
  // 標記語言
  '.html', '.htm', '.xml', '.svg',
  // 圖片 / 靜態資源
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
]);

// 不需要提醒測試的路徑片段
const SKIP_PATH_PATTERNS = [
  '/tests/',
  '/test/',
  '/__tests__/',
  '/scripts/hooks/',
  '/scripts/lib/',
  '/.claude-plugin/',
  '/fixtures/',
  '/mocks/',
];

// 設定檔名（不含路徑）
const SKIP_FILENAMES = new Set([
  '.gitignore', '.eslintrc', '.prettierrc', '.editorconfig',
  'tsconfig.json', 'package.json', 'package-lock.json',
  'bun.lockb', 'Makefile', 'Dockerfile', '.dockerignore',
]);

function shouldSkip(filePath) {
  if (!filePath) return true;

  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // 精確檔名匹配
  if (SKIP_FILENAMES.has(basename)) return true;

  // 複合副檔名（.test.js, .spec.ts）
  const doubleExt = basename.includes('.')
    ? '.' + basename.split('.').slice(-2).join('.')
    : '';
  if (doubleExt && SKIP_EXTENSIONS.has(doubleExt.toLowerCase())) return true;

  // 單一副檔名
  if (SKIP_EXTENSIONS.has(ext)) return true;

  // 設定檔模式（*.config.js, *.config.ts）
  if (basename.match(/\.config\.[jt]sx?$/)) return true;

  // 路徑片段
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of SKIP_PATH_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }

  return false;
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    const filePath =
      data.tool_input?.file_path ||
      data.tool_input?.path ||
      data.input?.file_path ||
      null;

    if (shouldSkip(filePath)) {
      process.exit(0);
    }

    // Emit quality.test-needed event
    emit(EVENT_TYPES.QUALITY_TEST_NEEDED, sessionId, {
      filePath,
    });

    // 業務邏輯檔案 → 提醒測試
    const basename = path.basename(filePath);
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `提醒：${basename} 已修改，記得執行相關測試確認無迴歸。`,
    }));
  } catch (err) {
    hookLogger.error('test-check', err);
  }
});
