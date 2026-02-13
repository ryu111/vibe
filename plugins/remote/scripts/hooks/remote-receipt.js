#!/usr/bin/env node
/**
 * remote-receipt.js — Stop hook 已讀回條
 *
 * 當 Claude Code 完成回合時（Stop 事件），檢查是否有待處理的 /say 訊息。
 * 如果有 → editMessageText 將 ✓ 已傳送 更新為 ✅ 完成。
 * 無 pending → 靜默退出（exit 0）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_FILE = path.join(os.homedir(), '.claude', 'remote-say-pending.json');
const MAX_AGE = 10 * 60 * 1000; // 10 分鐘過期

async function main() {
  // 讀取 stdin（Stop hook 資料）
  let input = '';
  try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (_) {}
  let data = {};
  try { data = JSON.parse(input); } catch (_) {}

  // 防止 stop hook 迴圈
  if (data.stop_hook_active) process.exit(0);

  // 無 pending state → 靜默退出
  if (!fs.existsSync(PENDING_FILE)) process.exit(0);

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch (_) {
    try { fs.unlinkSync(PENDING_FILE); } catch (_) {}
    process.exit(0);
  }

  // 過期檢查
  if (Date.now() - pending.sentAt > MAX_AGE) {
    try { fs.unlinkSync(PENDING_FILE); } catch (_) {}
    process.exit(0);
  }

  // 消費 pending（先刪除防重複觸發）
  try { fs.unlinkSync(PENDING_FILE); } catch (_) {}

  // 載入 telegram.js
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
  const { getCredentials, editMessageText } = require(
    path.join(pluginRoot, 'scripts', 'lib', 'telegram.js')
  );

  const creds = getCredentials();
  if (!creds) process.exit(0);

  try {
    await editMessageText(creds.token, pending.chatId, pending.messageId, '\u2705 \u5B8C\u6210');
  } catch (_) {
    // editMessage 失敗（訊息已刪除等）→ 忽略
  }
}

main().catch(() => process.exit(0));
