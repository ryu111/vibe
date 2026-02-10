#!/usr/bin/env node
/**
 * counter.js — Tool Call 計數器
 *
 * 追蹤 session 中的 tool call 數量，支援閾值判斷。
 * State file: ~/.claude/flow-counter-{sessionId}.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const THRESHOLD = 50;
const REMIND_INTERVAL = 25;

/**
 * 取得 counter state file 路徑
 * @param {string} sessionId
 * @returns {string}
 */
function getStatePath(sessionId) {
  return path.join(CLAUDE_DIR, `flow-counter-${sessionId}.json`);
}

/**
 * 讀取當前計數
 * @param {string} sessionId
 * @returns {{ count: number, lastRemind: number }}
 */
function read(sessionId) {
  const filePath = getStatePath(sessionId);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return { count: 0, lastRemind: 0 };
  }
}

/**
 * 遞增計數並寫入
 * @param {string} sessionId
 * @returns {{ count: number, shouldRemind: boolean, message: string|null }}
 */
function increment(sessionId) {
  const state = read(sessionId);
  state.count++;

  let shouldRemind = false;
  let message = null;

  if (state.count >= THRESHOLD) {
    // 超過閾值後，每 REMIND_INTERVAL 次提醒
    if (state.count - state.lastRemind >= REMIND_INTERVAL) {
      shouldRemind = true;
      state.lastRemind = state.count;
      message = `Context 使用量偏高（${state.count} tool calls）。建議在適當的邏輯邊界使用 /flow:compact 或 /compact 壓縮 context。`;
    }
  }

  // 確保目錄存在
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  fs.writeFileSync(getStatePath(sessionId), JSON.stringify(state));

  return { count: state.count, shouldRemind, message };
}

/**
 * 重設計數器
 * @param {string} sessionId
 */
function reset(sessionId) {
  const filePath = getStatePath(sessionId);
  const state = { count: 0, lastRemind: 0 };
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state));
}

module.exports = { read, increment, reset, THRESHOLD, REMIND_INTERVAL };
