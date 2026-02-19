#!/usr/bin/env node
/**
 * tool-detector.js — 工具偵測共用函式庫
 *
 * 偵測系統上已安裝的品質工具。
 * 被 auto-lint.js 和 auto-format.js 共用。
 */
'use strict';
const { execFileSync } = require("child_process");

// 快取已偵測的結果（同一 process 內）
// 生命週期：hook 是獨立 process，快取僅在單次 hook 執行中有效
const _cache = {};

/**
 * 檢查指令是否已安裝
 * @param {string} cmd - 指令名稱（取第一個 token）
 * @returns {boolean}
 */
function isInstalled(cmd) {
  const bin = cmd.split(" ")[0];
  if (_cache[bin] !== undefined) return _cache[bin];
  try {
    execFileSync('which', [bin], { stdio: "pipe" });
    _cache[bin] = true;
  } catch {
    _cache[bin] = false;
  }
  return _cache[bin];
}

/**
 * 偵測可用的 linter 和 formatter
 * @param {{ linter: string|null, formatter: string|null }} langInfo - 來自 lang-map.lookup()
 * @returns {{ linter: string|null, formatter: string|null }}
 */
function detectTools(langInfo) {
  if (!langInfo) return { linter: null, formatter: null };
  return {
    linter:
      langInfo.linter && isInstalled(langInfo.linter) ? langInfo.linter : null,
    formatter:
      langInfo.formatter && isInstalled(langInfo.formatter)
        ? langInfo.formatter
        : null,
  };
}

module.exports = { isInstalled, detectTools };
