#!/usr/bin/env node
/**
 * server-manager.js — Dashboard 伺服器生命週期管理
 *
 * 共用模組：供 hook（autostart）和 skill（/dashboard）引用。
 * PID_FILE 為全域（非 session 隔離），因為 server 跨 session 共享。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.VIBE_DASHBOARD_PORT) || 3800;
const PID_FILE = path.join(os.homedir(), '.claude', 'dashboard-server.pid');
const SERVER_PATH = path.join(__dirname, '..', '..', '..', 'server.js');

/**
 * 檢查指定 port 是否有服務在監聽
 * @param {number} [port]
 * @returns {Promise<boolean>}
 */
function isRunning(port) {
  port = port || PORT;
  return new Promise((resolve) => {
    const conn = net.createConnection({ port, host: '127.0.0.1' }, () => {
      conn.end();
      resolve(true);
    });
    conn.on('error', () => resolve(false));
    conn.setTimeout(1000, () => {
      conn.destroy();
      resolve(false);
    });
  });
}

/**
 * 背景啟動 dashboard server
 * @param {string} [serverPath] — server.js 路徑
 * @param {number} [port]
 * @returns {{ pid: number }}
 */
function start(serverPath, port) {
  serverPath = serverPath || SERVER_PATH;
  port = port || PORT;

  const child = spawn('bun', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VIBE_DASHBOARD_PORT: String(port) },
  });
  child.unref();

  // 寫 PID
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }));

  return { pid: child.pid };
}

/**
 * 停止 dashboard server
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
 * 取得目前 server 狀態
 * @returns {{ pid: number, port: number, startedAt: string }|null}
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

/**
 * 取得區網 IP
 * @returns {string|null}
 */
function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const devName of Object.keys(ifaces)) {
    for (const iface of ifaces[devName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

module.exports = { PORT, PID_FILE, SERVER_PATH, isRunning, start, stop, getState, getLanIP };
