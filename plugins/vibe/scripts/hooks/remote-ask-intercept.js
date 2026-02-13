#!/usr/bin/env node
/**
 * remote-ask-intercept.js — PreToolUse hook 轉發 AskUserQuestion
 *
 * 非阻擋模式：
 * 1. 解析 tool_input.questions → 組裝通知文字 + inline keyboard
 * 2. 發送到 Telegram（純文字 + 按鈕）
 * 3. 寫 pending file（供 daemon 偵測 + tmux 鍵盤操作）
 * 4. 立即放行 TUI（continue: true）
 * 5. 使用者在 Telegram 點按鈕或回覆數字 → daemon 透過 tmux send-keys 操作
 * 6. 使用者在 Telegram 回覆 ok → daemon 確認提交
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
  const header = q.question || q.header || '\u8ACB\u9078\u64C7';

  let text = `\u{1F4CB} ${header}`;
  text += '\n';
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    text += `\n${i + 1}. ${opt.label}`;
    if (opt.description) text += ` \u2014 ${opt.description}`;
  }

  if (multiSelect) {
    text += '\n\n\u{1F449} \u9EDE\u6309\u9215\u6216\u6578\u5B57\u52FE\u9078\uFF0C\u8F38\u5165 ok \u78BA\u8A8D';
  } else {
    text += '\n\n\u{1F449} \u9EDE\u6309\u9215\u6216\u56DE\u8986\u6578\u5B57\u5373\u53EF\u9078\u64C7';
  }

  return { text, multiSelect, optionCount: q.options.length };
}

/**
 * 建構 inline keyboard
 */
function buildKeyboard(q) {
  if (q.multiSelect) {
    const keyboard = q.options.map((opt, i) => [{
      text: `\u2610 ${opt.label}`,
      callback_data: `ask|${i}`,
    }]);
    keyboard.push([{ text: '\u2714 \u78BA\u8A8D', callback_data: 'ask|confirm' }]);
    return keyboard;
  } else {
    return q.options.map((opt, i) => [{
      text: opt.label,
      callback_data: `ask|${i}`,
    }]);
  }
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

  const q = questions[0];
  const notify = buildNotifyText(questions, 0);
  if (!notify) process.exit(0);

  // 發送帶 inline keyboard 的通知（parseMode=null 避免特殊字元）
  let messageId = null;
  try {
    const keyboard = buildKeyboard(q);
    const result = await tg.sendMessageWithKeyboard(
      creds.token, creds.chatId, notify.text, keyboard, null
    );
    messageId = result && result.message_id;
  } catch (_) {}

  // 寫 pending state — daemon 偵測後可用按鈕或數字回覆
  fs.writeFileSync(PENDING_FILE, JSON.stringify({
    chatId: creds.chatId,
    questions,
    questionIndex: 0,
    totalQuestions: questions.length,
    multiSelect: notify.multiSelect,
    optionCount: notify.optionCount,
    selections: notify.multiSelect ? new Array(notify.optionCount).fill(false) : undefined,
    messageId,
    waitingConfirm: false,
    createdAt: Date.now(),
  }));

  // 立即放行 TUI — 不阻擋、不等待
}

main().catch(() => process.exit(0));
