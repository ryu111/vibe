#!/usr/bin/env node
/**
 * lang-map.js — 語言映射共用函式庫
 *
 * 副檔名 → 語言 → linter/formatter 映射。
 * 被 auto-lint.js 和 auto-format.js 共用。
 */
'use strict';
const path = require('path');

const LANG_MAP = {
  '.ts':   { lang: 'typescript',  linter: 'eslint',           formatter: 'prettier' },
  '.tsx':  { lang: 'typescript',  linter: 'eslint',           formatter: 'prettier' },
  '.js':   { lang: 'javascript',  linter: 'eslint',           formatter: 'prettier' },
  '.jsx':  { lang: 'javascript',  linter: 'eslint',           formatter: 'prettier' },
  '.mjs':  { lang: 'javascript',  linter: 'eslint',           formatter: 'prettier' },
  '.cjs':  { lang: 'javascript',  linter: 'eslint',           formatter: 'prettier' },
  '.py':   { lang: 'python',      linter: 'ruff check',       formatter: 'ruff format' },
  '.go':   { lang: 'go',          linter: 'golangci-lint run', formatter: 'gofmt -w' },
  '.css':  { lang: 'css',         linter: 'stylelint',        formatter: 'prettier' },
  '.scss': { lang: 'scss',        linter: 'stylelint',        formatter: 'prettier' },
  '.json': { lang: 'json',        linter: null,               formatter: 'prettier' },
  '.md':   { lang: 'markdown',    linter: null,               formatter: 'prettier' },
  '.html': { lang: 'html',        linter: null,               formatter: 'prettier' },
  '.vue':  { lang: 'vue',         linter: 'eslint',           formatter: 'prettier' },
  '.svelte': { lang: 'svelte',    linter: 'eslint',           formatter: 'prettier' },
};

/**
 * 查詢檔案對應的語言資訊
 * @param {string} filePath - 檔案路徑
 * @returns {{ lang: string, linter: string|null, formatter: string|null } | null}
 */
function lookup(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] || null;
}

module.exports = { LANG_MAP, lookup };
