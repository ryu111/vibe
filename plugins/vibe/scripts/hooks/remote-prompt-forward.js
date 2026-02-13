#!/usr/bin/env node
/**
 * remote-prompt-forward.js — UserPromptSubmit hook
 *
 * 將使用者輸入轉發到 Telegram，實現手機端同步監看對話流。
 * 不阻擋、不修改 prompt，純旁路轉發。
 */
'use strict';
const fs = require('fs');
const path = require('path');

async function main() {
  let input = '';
  try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (_) {}
  let data = {};
  try { data = JSON.parse(input); } catch (_) {}

  const prompt = data.prompt;
  if (!prompt || !prompt.trim()) process.exit(0);

  // 載入 telegram.js
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
  const { getCredentials, sendMessage } = require(
    path.join(pluginRoot, 'scripts', 'lib', 'remote', 'telegram.js')
  );

  const creds = getCredentials();
  if (!creds) process.exit(0);

  // 截斷過長的 prompt（Telegram 訊息上限 4096）
  const maxLen = 3900;
  let text = prompt.trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + '\n\u2026 (\u622A\u65B7)';
  }

  try {
    await sendMessage(creds.token, creds.chatId, `\u{1F464} ${text}`);
  } catch (_) {}
}

main().catch(() => process.exit(0));
