#!/usr/bin/env node
/**
 * hook-utils.js — Hook 共用工具
 *
 * 提供 safeRun() 包裝：安全解析 JSON stdin，
 * 捕捉所有錯誤避免 hook 崩潰導致級聯失敗。
 *
 * @module hook-utils
 */
'use strict';

const hookLogger = require('./hook-logger.js');

/**
 * 安全執行 hook 主邏輯
 *
 * 用法：
 *   safeRun('hook-name', (data) => { ... })
 *   safeRun('hook-name', async (data) => { ... })
 *
 * @param {string} hookName - hook 名稱（用於錯誤日誌）
 * @param {Function} handler - (data: Object) => void | Promise<void>
 */
function safeRun(hookName, handler) {
  let input = '';
  process.stdin.on('data', d => input += d);
  process.stdin.on('end', async () => {
    let data;
    try {
      data = JSON.parse(input);
    } catch (err) {
      hookLogger.error(hookName, new Error(`JSON 解析失敗: ${err.message}`));
      process.exit(0); // 不阻擋
      return;
    }

    // null / undefined / 非 object → 視為無效輸入
    if (!data || typeof data !== 'object') {
      process.exit(0);
      return;
    }

    try {
      await handler(data);
    } catch (err) {
      hookLogger.error(hookName, err);
    }
  });
}

module.exports = { safeRun };
