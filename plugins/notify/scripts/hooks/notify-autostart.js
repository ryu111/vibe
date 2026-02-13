#!/usr/bin/env node
/**
 * notify-autostart.js — SessionStart hook
 *
 * 自動偵測 Telegram bot daemon 是否執行中，未啟動則背景啟動。
 * 無 credentials 時靜默跳過，不打擾使用者。
 */
'use strict';
const path = require('path');
const { getCredentials } = require(path.join(__dirname, '..', 'lib', 'telegram.js'));
const { isRunning, start, getState } = require(path.join(__dirname, '..', 'lib', 'bot-manager.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', async () => {
  try {
    // 檢查 credentials — 缺則靜默跳過
    const creds = getCredentials();
    if (!creds) {
      process.exit(0);
    }

    if (isRunning()) {
      const state = getState();
      console.log(JSON.stringify({
        additionalContext: `Telegram bot \u57F7\u884C\u4E2D\uFF08PID: ${state?.pid || '?'}\uFF09\u3002\u4F7F\u7528 /notify \u7BA1\u7406\u3002`,
      }));
    } else {
      const result = start();

      // 等待 daemon 就緒（最多 1s）
      let ready = false;
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (isRunning()) { ready = true; break; }
      }

      console.log(JSON.stringify({
        additionalContext: ready
          ? `Telegram bot \u5DF2\u81EA\u52D5\u555F\u52D5\uFF08PID: ${result.pid}\uFF09\u3002\u4F7F\u7528 /notify \u7BA1\u7406\u3002`
          : `Telegram bot \u555F\u52D5\u4E2D\uFF08PID: ${result.pid}\uFF09\u3002\u4F7F\u7528 /notify status \u6AA2\u67E5\u3002`,
      }));
    }
  } catch (err) {
    process.stderr.write(`notify-autostart: ${err.message}\n`);
  }
});
