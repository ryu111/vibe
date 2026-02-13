#!/usr/bin/env node
/**
 * bot-manager.js — Telegram Bot Daemon 生命週期管理
 *
 * 共用模組：供 hook（autostart）和 skill（/remote）引用。
 * PID_FILE 為全域（非 session 隔離），因為 daemon 跨 session 共享。
 * 與 dashboard server-manager.js 模式相同，差異在用 process.kill(pid,0) 偵測存活（無 port）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PID_FILE = path.join(os.homedir(), '.claude', 'remote-bot.pid');
const BOT_PATH = path.join(__dirname, '..', '..', 'bot.js');

/**
 * 檢查 daemon 是否執行中
 * @returns {boolean}
 */
function isRunning() {
  const state = getState();
  return state !== null;
}

/**
 * 背景啟動 bot daemon
 * @param {string} [botPath] — bot.js 路徑
 * @returns {{ pid: number }}
 */
function start(botPath) {
  botPath = botPath || BOT_PATH;

  const child = spawn('node', [botPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // 寫 PID
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
  }));

  return { pid: child.pid };
}

/**
 * 停止 bot daemon
 * @returns {{ stopped: boolean, pid: number|null }}
 */
function stop() {
  const state = getState();
  if (!state) return { stopped: false, pid: null };

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (_) {
    // 程序可能已不存在
  }

  // 清理 PID 檔案
  try { fs.unlinkSync(PID_FILE); } catch (_) {}

  return { stopped: true, pid: state.pid };
}

/**
 * 取得目前 daemon 狀態
 * @returns {{ pid: number, startedAt: string }|null}
 */
function getState() {
  try {
    const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    // 驗證程序是否存活
    process.kill(data.pid, 0);
    return data;
  } catch (_) {
    // PID 檔不存在或程序已死 → 清理殘留
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    return null;
  }
}

module.exports = { PID_FILE, BOT_PATH, isRunning, start, stop, getState };
