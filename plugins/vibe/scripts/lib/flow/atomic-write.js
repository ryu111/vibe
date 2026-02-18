#!/usr/bin/env node
/**
 * atomic-write.js — 原子寫入工具函式
 *
 * 策略：先寫入 .tmp 暫存檔，完成後 rename 到目標路徑。
 * rename 是 POSIX 原子操作，確保觀察者不會看到部分寫入狀態。
 *
 * @module flow/atomic-write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// M-2 修正：module-level 遞增計數器，確保同 PID 且同毫秒內的多次寫入不衝突
let writeCounter = 0;

/**
 * 原子寫入檔案。
 *
 * - 若目錄不存在，自動建立（recursive）
 * - 支援字串和可 JSON 序列化的物件
 * - 先寫入同目錄的 .tmp 暫存檔，再 rename 到目標路徑
 *
 * @param {string} filePath - 目標檔案絕對路徑
 * @param {string|object} data - 要寫入的資料（物件會自動 JSON 序列化）
 */
function atomicWrite(filePath, data) {
  // 確保目錄存在
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // 序列化
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  // 同目錄的暫存檔（確保 rename 是 atomic：同一檔案系統）
  // M-2 修正：加入時間戳 + 遞增計數器，確保同 PID 且同毫秒內多次寫入不衝突
  const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now() + '.' + (++writeCounter);

  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // 清理暫存檔（失敗時記錄 warning，避免 .tmp 永久遺留）
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      // 清理也失敗 — session-cleanup 會在下次啟動時掃描 .tmp.* 殘留（v1.0.50 L-4）
      if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(`[atomic-write] tmp cleanup failed: ${tmpPath} — ${cleanupErr.code}\n`);
      }
    }
    throw err;
  }
}

module.exports = { atomicWrite };
