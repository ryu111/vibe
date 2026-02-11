#!/usr/bin/env node
/**
 * dashboard-autostart.js — SessionStart hook
 *
 * 自動偵測 dashboard server 是否執行中，未啟動則背景啟動。
 * 首次啟動時自動開啟 VSCode Simple Browser（偵測 TERM_PROGRAM=vscode）。
 * 輸出 additionalContext 告知使用者 Dashboard URL。
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { isRunning, start, getState, getLanIP, PORT, hasActiveClients } = require(path.join(__dirname, '..', 'lib', 'server-manager.js'));

/**
 * 在 VSCode Simple Browser 開啟 Dashboard（背景執行，不阻塞 hook）
 */
function openInBrowser(port) {
  const url = `http://localhost:${port}`;
  const isVSCode = process.env.TERM_PROGRAM === 'vscode';

  if (isVSCode) {
    // VSCode Simple Browser — 透過 open -a 觸發 URI scheme
    const encodedUrl = encodeURIComponent(url);
    const child = spawn('open', ['-a', 'Visual Studio Code', `vscode://vscode.simple-browser/show?url=${encodedUrl}`], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } else {
    // macOS 預設瀏覽器
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

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

      // 首次啟動 → 自動開啟瀏覽器
      if (ready) {
        openInBrowser(PORT);
      }

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

      // 新 session：檢查是否已有瀏覽器連線中，沒有才開
      const hasClients = await hasActiveClients(state?.port || PORT);
      if (!hasClients) {
        openInBrowser(state?.port || PORT);
      }

      console.log(JSON.stringify({
        additionalContext: `Dashboard 執行中（PID: ${state?.pid || '?'}）：${urls.join(' / ')}。使用 /dashboard 管理。`,
      }));
    }
  } catch (err) {
    // 靜默失敗，不阻擋 session 啟動
    process.stderr.write(`dashboard-autostart: ${err.message}\n`);
  }
});
