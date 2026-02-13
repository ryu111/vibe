#!/usr/bin/env node
/**
 * log-compact.js — PreCompact hook
 *
 * 記錄 compact 事件，重設 tool call 計數器。
 */
'use strict';
const path = require('path');
const { reset } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    // 重設計數器
    reset(sessionId);
  } catch (err) {
    hookLogger.error('log-compact', err);
  }
});
