#!/usr/bin/env node
/**
 * remote-ask-intercept.js — PreToolUse hook 轉發 AskUserQuestion
 *
 * 非阻擋模式：
 * 1. 解析 tool_input.questions → 建構 inline keyboard
 * 2. 發送到 Telegram（inline keyboard）
 * 3. 寫 pending file → 立即放行 TUI（continue: true）
 * 4. 使用者在終端回答 → 正常流程
 * 5. 使用者在 Telegram 回答 → daemon 透過 tmux send-keys 注入
 *
 * 誰先回答用誰的。Telegram 回答只在使用者不在終端前時有用。
 * 靜默降級：credentials 缺失 → continue: true
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');
const RESPONSE_FILE = path.join(CLAUDE_DIR, 'remote-ask-response.json');

/**
 * 將 AskUserQuestion 的 questions 轉換為 Telegram inline keyboard
 */
function buildKeyboard(questions, qIdx) {
  const q = questions[qIdx];
  if (!q || !q.options) return null;

  const multiSelect = q.multiSelect === true;
  const header = q.question || q.header || '請選擇';

  const keyboard = q.options.map((opt, i) => [{
    text: multiSelect ? `\u2610 ${opt.label}` : opt.label,
    callback_data: `ask|${i}`,
  }]);

  if (multiSelect) {
    keyboard.push([{
      text: '\u2714 \u78BA\u8A8D',
      callback_data: 'ask|confirm',
    }]);
  }

  let text = `\u{1F4CB} *${header}*`;
  const hasDesc = q.options.some(o => o.description);
  if (hasDesc) {
    text += '\n';
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      text += `\n${i + 1}. *${opt.label}*`;
      if (opt.description) text += ` \u2014 ${opt.description}`;
    }
  }
  if (multiSelect) {
    text += '\n\n\u{1F449} \u53EF\u9EDE\u591A\u500B\u518D\u6309\u300C\u78BA\u8A8D\u300D';
  }

  return { text, keyboard, multiSelect };
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

  const kb = buildKeyboard(questions, 0);
  if (!kb) process.exit(0);

  // 清理殘留
  try { fs.unlinkSync(RESPONSE_FILE); } catch (_) {}

  if (kb.multiSelect) {
    // 多選：純文字通知（不給按鈕，避免混亂）
    const notifyText = kb.text + '\n\n\u{1F449} \u8ACB\u5728\u7D42\u7AEF\u78BA\u8A8D';
    try {
      await tg.sendMessage(creds.token, creds.chatId, notifyText);
    } catch (_) {}
  } else {
    // 單選：inline keyboard（可點選標記偏好）
    let msg;
    try {
      msg = await tg.sendMessageWithKeyboard(creds.token, creds.chatId, kb.text, kb.keyboard);
    } catch (_) {
      process.exit(0);
    }

    // 寫 pending state（daemon 讀取用，單選才需要）
    fs.writeFileSync(PENDING_FILE, JSON.stringify({
      messageId: msg.message_id,
      chatId: creds.chatId,
      questions,
      questionIndex: 0,
      multiSelect: false,
      selections: [],
      hookTimedOut: true,
      createdAt: Date.now(),
    }));
  }

  // 立即放行 TUI — 不阻擋、不等待
}

main().catch(() => process.exit(0));
