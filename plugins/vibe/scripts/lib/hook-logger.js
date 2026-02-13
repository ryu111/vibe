#!/usr/bin/env node
/**
 * hook-logger.js — Hook 錯誤日誌共用庫
 *
 * 所有非關鍵 hook 的 catch 塊統一使用此庫記錄錯誤到檔案。
 * 不寫 stderr（避免 ECC "hook error" 顯示），不影響 hook 執行。
 *
 * 日誌位置：~/.claude/hook-errors.log
 * 自動截斷：超過 MAX_LINES 時保留最近一半
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.homedir(), '.claude', 'hook-errors.log');
const MAX_LINES = 500;

/**
 * 記錄 hook 錯誤到 log 檔案
 * @param {string} hookName - hook 名稱（如 'auto-lint'）
 * @param {Error|string} err - 錯誤物件或訊息
 */
function error(hookName, err) {
  try {
    const timestamp = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const line = `[${timestamp}] ${hookName}: ${message}\n`;

    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.appendFileSync(LOG_PATH, line);

    // 自動截斷
    truncateIfNeeded();
  } catch (_) {
    // 日誌本身不能失敗
  }
}

/**
 * 超過 MAX_LINES 時，保留後半部
 */
function truncateIfNeeded() {
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      const kept = lines.slice(-Math.floor(MAX_LINES / 2));
      fs.writeFileSync(LOG_PATH, kept.join('\n') + '\n');
    }
  } catch (_) {}
}

/**
 * 讀取 log 內容
 * @param {number} [limit=100] - 最多讀取幾行（從尾部）
 * @returns {string[]} 日誌行陣列
 */
function read(limit = 100) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-limit);
  } catch (_) {
    return [];
  }
}

/**
 * 清除 log 檔案
 * @returns {boolean} 是否成功
 */
function clear() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      fs.unlinkSync(LOG_PATH);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 取得 log 統計
 * @returns {{ total: number, byHook: Record<string, { count: number, lastError: string, lastTime: string }> }}
 */
function stats() {
  const lines = read(MAX_LINES);
  const byHook = {};

  for (const line of lines) {
    // 格式：[2026-02-14T...] hookName: error message
    const match = line.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.+)$/);
    if (!match) continue;

    const [, time, hook, msg] = match;
    if (!byHook[hook]) {
      byHook[hook] = { count: 0, lastError: '', lastTime: '' };
    }
    byHook[hook].count++;
    byHook[hook].lastError = msg;
    byHook[hook].lastTime = time;
  }

  return { total: lines.length, byHook };
}

module.exports = { error, read, clear, stats, LOG_PATH };
