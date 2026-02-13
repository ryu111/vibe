#!/usr/bin/env node
/**
 * remote-ask-intercept.js — PreToolUse hook 轉發 AskUserQuestion
 *
 * 非阻擋模式：
 * 1. 解析 tool_input.questions → 組裝純文字通知
 * 2. 發送到 Telegram（純文字，附選項編號）
 * 3. 寫 pending file（供 daemon 偵測 + tmux 鍵盤操作）
 * 4. 立即放行 TUI（continue: true）
 * 5. 使用者在終端回答 → 正常流程
 * 6. 使用者在 Telegram 回覆數字 → daemon 透過 tmux send-keys 注入鍵盤操作
 *
 * 靜默降級：credentials 缺失 → continue: true
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');

/**
 * 組裝通知文字（純文字，附選項編號）
 */
function buildNotifyText(questions, qIdx) {
  const q = questions[qIdx];
  if (!q || !q.options) return null;

  const multiSelect = q.multiSelect === true;
  const header = q.question || q.header || '請選擇';

  let text = `\u{1F4CB} ${header}`;
  text += '\n';
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    text += `\n${i + 1}. ${opt.label}`;
    if (opt.description) text += ` \u2014 ${opt.description}`;
  }

  if (multiSelect) {
    text += '\n\n\u{1F449} \u8ACB\u5728\u7D42\u7AEF\u78BA\u8A8D\uFF08\u591A\u9078\uFF09';
  } else {
    text += '\n\n\u{1F449} \u56DE\u8986\u6578\u5B57\u5373\u53EF\u9078\u64C7\uFF0C\u6216\u5728\u7D42\u7AEF\u64CD\u4F5C';
  }

  return { text, multiSelect, optionCount: q.options.length };
}

async function main() {
  let input = '';
  try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (_) {}
  let data = {};
  try { data = JSON.parse(input); } catch (_) {}

  if (data.tool_name !== 'AskUserQuestion') process.exit(0);

  const toolInput = data.tool_input || {};
  const questions = toolInput.questions;
  if (!questions || !questions.length) process.exit(0);

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
  let tg;
  try {
    tg = require(path.join(pluginRoot, 'scripts', 'lib', 'telegram.js'));
  } catch (_) {
    process.exit(0);
  }

  const creds = tg.getCredentials();
  if (!creds) process.exit(0);

  const notify = buildNotifyText(questions, 0);
  if (!notify) process.exit(0);

  // 發送純文字通知（不用 Markdown，避免特殊字元解析失敗）
  try {
    await tg.sendMessage(creds.token, creds.chatId, notify.text, null);
  } catch (_) {}

  // 寫 pending state — daemon 偵測後可用 tmux 鍵盤操作回答
  fs.writeFileSync(PENDING_FILE, JSON.stringify({
    chatId: creds.chatId,
    questions,
    questionIndex: 0,
    multiSelect: notify.multiSelect,
    optionCount: notify.optionCount,
    createdAt: Date.now(),
  }));

  // 立即放行 TUI — 不阻擋、不等待
}

main().catch(() => process.exit(0));
