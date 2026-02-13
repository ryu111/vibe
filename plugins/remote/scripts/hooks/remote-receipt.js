#!/usr/bin/env node
/**
 * remote-receipt.js — Stop hook 已讀回條 + 回合摘要
 *
 * 功能 A：/say 已讀回條 — 有 say-pending → editMessageText ✅ 完成
 * 功能 B：回合摘要通知 — 無 say-pending → 解析 transcript → 發送動作摘要
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    path.join(pluginRoot, 'scripts', 'lib', 'telegram.js')
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

  // 解析 transcript 取得最近一個回合的工具呼叫
  const transcriptPath = data.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const summary = parseTurnSummary(transcriptPath);
  if (!summary) process.exit(0);

  // 發送摘要
  try {
    await sendMessage(creds.token, creds.chatId, summary);
  } catch (_) {}

  // 更新節流時間戳
  try {
    fs.writeFileSync(THROTTLE_FILE, JSON.stringify({ t: Date.now() }));
  } catch (_) {}
}

/**
 * 從 transcript JSONL 解析最近回合的工具呼叫，產出摘要文字
 */
function parseTurnSummary(transcriptPath) {
  let lines;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    lines = content.trim().split('\n');
  } catch (_) {
    return null;
  }

  // 從尾部往回讀，找最近一個 assistant turn 的工具呼叫
  const files = { edited: new Set(), created: new Set() };
  let bashCount = 0;
  let bashCmds = [];
  let taskCount = 0;
  let searchCount = 0;
  let readCount = 0;
  let foundAssistant = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

    // 遇到 user/human turn → 停止（只看最後一個 assistant 回合）
    if (entry.type === 'human' || entry.role === 'user') {
      if (foundAssistant) break;
      continue;
    }

    // assistant turn 的 content
    if (entry.type === 'assistant' || entry.role === 'assistant') {
      foundAssistant = true;
      const content = entry.message?.content || entry.content || [];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const name = block.name;
        const input = block.input || {};

        if (name === 'Write') {
          files.created.add(shortenPath(input.file_path));
        } else if (name === 'Edit') {
          files.edited.add(shortenPath(input.file_path));
        } else if (name === 'Bash') {
          bashCount++;
          const cmd = (input.command || '').split(/\s*&&\s*/)[0].trim();
          if (cmd) bashCmds.push(cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd);
        } else if (name === 'Task') {
          taskCount++;
        } else if (name === 'Grep' || name === 'Glob') {
          searchCount++;
        } else if (name === 'Read') {
          readCount++;
        }
      }
    }
  }

  // 組裝摘要
  const parts = [];

  const editedFiles = [...files.edited].filter(f => !files.created.has(f));
  if (files.created.size > 0) {
    parts.push(`\u{1F4DD} \u5EFA\u7ACB ${files.created.size} \u500B\u6A94\u6848`);
    for (const f of files.created) parts.push(`  \u00B7 ${f}`);
  }
  if (editedFiles.length > 0) {
    parts.push(`\u270F\uFE0F \u7DE8\u8F2F ${editedFiles.length} \u500B\u6A94\u6848`);
    for (const f of editedFiles) parts.push(`  \u00B7 ${f}`);
  }
  if (bashCount > 0) {
    parts.push(`\u26A1 \u57F7\u884C ${bashCount} \u500B\u547D\u4EE4`);
    for (const c of bashCmds.slice(0, 3)) parts.push(`  \u00B7 \`${c}\``);
  }
  if (taskCount > 0) {
    parts.push(`\u{1F916} \u59D4\u6D3E ${taskCount} \u500B sub-agent`);
  }
  if (searchCount > 0) {
    parts.push(`\u{1F50D} \u641C\u5C0B ${searchCount} \u6B21`);
  }
  if (readCount > 0) {
    parts.push(`\u{1F4D6} \u8B80\u53D6 ${readCount} \u500B\u6A94\u6848`);
  }

  // 沒有任何動作（純文字回覆）
  if (parts.length === 0) {
    parts.push('\u{1F4AC} \u6587\u5B57\u56DE\u8986');
  }

  return `\u{1F4CB} \u56DE\u5408\u5B8C\u6210\n\n${parts.join('\n')}`;
}

/**
 * 縮短路徑：去掉常見前綴，只保留有意義的部分
 */
function shortenPath(filePath) {
  if (!filePath) return '(unknown)';
  // 去掉 home 目錄前綴
  const home = os.homedir();
  let p = filePath;
  if (p.startsWith(home)) p = '~' + p.slice(home.length);
  // 去掉常見工作目錄前綴，只保留最後 2-3 層
  const segments = p.split('/').filter(Boolean);
  if (segments.length > 3) {
    return segments.slice(-3).join('/');
  }
  return p;
}

main().catch(() => process.exit(0));
