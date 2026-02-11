#!/usr/bin/env node
/**
 * dashboard-autostart.js — SessionStart hook
 *
 * 自動偵測 dashboard server 是否執行中，未啟動則背景啟動。
 * 輸出 additionalContext 告知使用者 Dashboard URL。
 */
'use strict';
const path = require('path');
const { isRunning, start, getState, getLanIP, PORT } = require(path.join(__dirname, '..', 'lib', 'server-manager.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', async () => {
  try {
    const running = await isRunning();

    if (!running) {
      // 背景啟動 server
      const result = start();
      // 等待 server 就緒（最多 2s）
      let ready = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (await isRunning()) { ready = true; break; }
      }

      const lanIP = getLanIP();
      const urls = [`http://localhost:${PORT}`];
      if (lanIP) urls.push(`http://${lanIP}:${PORT}`);

      console.log(JSON.stringify({
        additionalContext: ready
          ? `Dashboard 已自動啟動（PID: ${result.pid}）：${urls.join(' / ')}。使用 /dashboard 管理。`
          : `Dashboard 啟動中（PID: ${result.pid}），可能需要幾秒才能存取 ${urls[0]}。使用 /dashboard status 檢查。`,
      }));
    } else {
      // 已在執行中
      const state = getState();
      const lanIP = getLanIP();
      const urls = [`http://localhost:${state?.port || PORT}`];
      if (lanIP) urls.push(`http://${lanIP}:${state?.port || PORT}`);

      console.log(JSON.stringify({
        additionalContext: `Dashboard 執行中（PID: ${state?.pid || '?'}）：${urls.join(' / ')}。使用 /dashboard 管理。`,
      }));
    }
  } catch (err) {
    // 靜默失敗，不阻擋 session 啟動
    process.stderr.write(`dashboard-autostart: ${err.message}\n`);
  }
});
