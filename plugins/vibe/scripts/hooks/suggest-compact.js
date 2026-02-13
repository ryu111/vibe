#!/usr/bin/env node
/**
 * suggest-compact.js — PreToolUse hook
 *
 * 追蹤 tool calls 數量，達閾值後建議 compact。
 * 不阻擋任何工具執行。
 */
'use strict';
const path = require('path');
const { increment } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    const result = increment(sessionId);

    if (result.shouldRemind && result.message) {
      // systemMessage 注入建議（不阻擋工具執行）
      console.log(JSON.stringify({ systemMessage: result.message }));
    }
  } catch (err) {
    hookLogger.error('suggest-compact', err);
  }
  // 不輸出 JSON → 不干涉工具執行
});
