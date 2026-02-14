#!/usr/bin/env node
/**
 * remote-receipt.js — Stop hook 已讀回條 + 回合摘要
 *
 * 功能 A：/say 已讀回條 — 有 say-pending → editMessageText ✅ 完成
 * 功能 B：回合摘要通知 — 無 say-pending → 解析 transcript → 發送動作摘要
 *   - 🤖 Claude 的文字回應（有文字時才發）
 *   - 📋 回合動作：工具統計一行摘要（有工具時才發）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PENDING_FILE = path.join(CLAUDE_DIR, 'remote-say-pending.json');
const THROTTLE_FILE = path.join(CLAUDE_DIR, 'remote-receipt-last.json');
const MAX_AGE = 10 * 60 * 1000; // 10 分鐘過期
const THROTTLE_MS = 10 * 1000;  // 回合摘要最短間隔 10 秒

async function main() {
  // 讀取 stdin（Stop hook 資料）
  let input = '';
  try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (_) {}
  let data = {};
  try { data = JSON.parse(input); } catch (_) {}

  // 防止 stop hook 迴圈
  if (data.stop_hook_active) process.exit(0);

  // 載入 telegram.js
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
  const { getCredentials, sendMessage, editMessageText } = require(
    path.join(pluginRoot, 'scripts', 'lib', 'remote', 'telegram.js')
  );

  const creds = getCredentials();
  if (!creds) process.exit(0);

  // ─── 功能 A：/say 已讀回條 ───
  if (fs.existsSync(PENDING_FILE)) {
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

    try {
      await editMessageText(creds.token, pending.chatId, pending.messageId, '\u2705 \u5B8C\u6210');
    } catch (_) {}
    return;
  }

  // ─── 功能 B：回合摘要通知 ───

  // 節流：避免連續回合轟炸手機
  try {
    const last = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    if (Date.now() - last.t < THROTTLE_MS) process.exit(0);
  } catch (_) {}

  // 解析 transcript 取得最近一個回合的文字 + 工具統計
  const transcriptPath = data.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const { parseLastAssistantTurn } = require(
    path.join(pluginRoot, 'scripts', 'lib', 'remote', 'transcript.js')
  );
  const turn = parseLastAssistantTurn(transcriptPath, { toolStats: true });

  // 至少要有文字或工具才發送
  if (!turn.text && !turn.tools) process.exit(0);

  // Emit turn.summary event
  const sessionId = data.session_id || 'unknown';
  const toolCount = turn.tools
    ? Object.values(turn.tools).reduce((sum, n) => sum + n, 0)
    : 0;
  emit(EVENT_TYPES.TURN_SUMMARY, sessionId, {
    toolCount,
  });

  // 合併為一行：📋 回合：🤖回應 📝×2 ✏️×3 ⚡×1
  const parts = [];
  if (turn.text) parts.push('\u{1F916}\u56DE\u61C9');
  if (turn.tools) {
    const line = formatToolLine(turn.tools);
    if (line) parts.push(line);
  }
  if (parts.length === 0) process.exit(0);

  try {
    await sendMessage(creds.token, creds.chatId, `\u{1F4CB} \u56DE\u5408\uFF1A${parts.join(' ')}`, null);
  } catch (_) {}

  // 更新節流時間戳
  try {
    fs.writeFileSync(THROTTLE_FILE, JSON.stringify({ t: Date.now() }));
  } catch (_) {}
}

/**
 * 工具統計壓縮為一行：📝×2 ✏️×3 ⚡×1 🤖×2 🔍×5 📖×3
 */
function formatToolLine(tools) {
  const { TOOL_EMOJI } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
  const map = TOOL_EMOJI;
  const parts = [];
  for (const [key, emoji] of map) {
    if (tools[key] > 0) parts.push(`${emoji}\u00D7${tools[key]}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// 測試用 exports（不影響 hook 執行）
if (typeof module !== 'undefined') {
  module.exports = { formatToolLine };
}

// Hook 模式：直接執行時才啟動（require 時跳過）
if (require.main === module) {
  main().catch(() => process.exit(0));
}
