#!/usr/bin/env node
/**
 * suggest-compact.js — PreToolUse hook
 *
 * 追蹤 tool calls 數量，達閾值後建議 compact。
 * 不阻擋任何工具執行。
 */
'use strict';
const path = require('path');
const { increment } = require(path.join(__dirname, '..', 'lib', 'counter.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    const result = increment(sessionId);

    if (result.shouldRemind && result.message) {
      // 透過 stderr 輸出提醒（不阻擋工具執行）
      process.stderr.write(result.message + '\n');
    }
  } catch (_) {
    // 靜默失敗
  }
  // 不輸出 JSON → 不干涉工具執行
});
