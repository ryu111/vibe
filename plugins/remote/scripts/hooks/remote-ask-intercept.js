#!/usr/bin/env node
/**
 * remote-ask-intercept.js — PreToolUse hook 攔截 AskUserQuestion
 *
 * 當 Claude 呼叫 AskUserQuestion 時：
 * 1. 解析 tool_input.questions → 建構 inline keyboard
 * 2. 直接發送 Telegram 訊息（避免 30s polling 延遲）
 * 3. 寫 remote-ask-pending.json → 輪詢 remote-ask-response.json
 * 4. 收到回覆 → { continue: false, systemMessage: "使用者選擇了：..." }
 * 5. 超時 55 秒 → { continue: false }（阻止 TUI，告知 Claude 等待）
 *    → daemon 收到 callback 後透過 tmux send-keys 注入答案
 *
 * 靜默降級：credentials 缺失 → continue: true
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');
const RESPONSE_FILE = path.join(CLAUDE_DIR, 'remote-ask-response.json');
const POLL_INTERVAL = 500;   // ms
const MAX_WAIT = 55 * 1000;  // 55 秒（hook timeout 60s，留 5s buffer）

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * 將 AskUserQuestion 的 questions 轉換為 Telegram inline keyboard
 * @param {Array} questions — AskUserQuestion 的 questions 陣列
 * @param {number} qIdx — 問題索引（目前只處理第一個）
 * @returns {{ text: string, keyboard: Array, multiSelect: boolean }}
 */
function buildKeyboard(questions, qIdx) {
  const q = questions[qIdx];
  if (!q || !q.options) return null;

  const multiSelect = q.multiSelect === true;
  const header = q.question || q.header || '請選擇';

  // 每個 option 一個按鈕（一行一個）
  // callback_data 格式：ask|{optionIndex}（最大 64 bytes）
  const keyboard = q.options.map((opt, i) => [{
    text: multiSelect ? `\u2610 ${opt.label}` : opt.label,
    callback_data: `ask|${i}`,
  }]);

  // 多選模式額外加「確認」按鈕
  if (multiSelect) {
    keyboard.push([{
      text: '\u2714 \u78BA\u8A8D',
      callback_data: 'ask|confirm',
    }]);
  }

  // 組裝訊息文字
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
  // 讀取 stdin（PreToolUse hook 資料）
  let input = '';
  try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (_) {}
  let data = {};
  try { data = JSON.parse(input); } catch (_) {}

  // 只處理 AskUserQuestion
  if (data.tool_name !== 'AskUserQuestion') {
    process.exit(0);
  }

  const toolInput = data.tool_input || {};
  const questions = toolInput.questions;
  if (!questions || !questions.length) {
    process.exit(0); // 無問題 → 放行
  }

  // 載入 telegram.js
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
  let tg;
  try {
    tg = require(path.join(pluginRoot, 'scripts', 'lib', 'telegram.js'));
  } catch (_) {
    process.exit(0); // 載入失敗 → 靜默放行
  }

  const creds = tg.getCredentials();
  if (!creds) process.exit(0); // 無 credentials → 靜默放行

  // 只處理第一個問題（AskUserQuestion 通常只有 1 題）
  const kb = buildKeyboard(questions, 0);
  if (!kb) process.exit(0);

  // 清理可能殘留的舊檔案
  try { fs.unlinkSync(RESPONSE_FILE); } catch (_) {}

  // 發送 Telegram 訊息（inline keyboard）
  let msg;
  try {
    msg = await tg.sendMessageWithKeyboard(creds.token, creds.chatId, kb.text, kb.keyboard);
  } catch (err) {
    // 發送失敗 → 回退到正常 TUI
    process.exit(0);
  }

  // 寫 pending state（供 bot.js 讀取）
  const pending = {
    messageId: msg.message_id,
    chatId: creds.chatId,
    questions,
    questionIndex: 0,
    multiSelect: kb.multiSelect,
    selections: kb.multiSelect ? questions[0].options.map(() => false) : [],
    hookTimedOut: false, // daemon 讀取此欄位判斷是否需要 tmux 注入
    createdAt: Date.now(),
  };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending));

  // 輪詢 response file
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    if (!fs.existsSync(RESPONSE_FILE)) continue;

    let response;
    try {
      response = JSON.parse(fs.readFileSync(RESPONSE_FILE, 'utf8'));
    } catch (_) {
      continue; // 讀取失敗（可能正在寫入）→ 下次重試
    }

    // 清理檔案
    try { fs.unlinkSync(RESPONSE_FILE); } catch (_) {}
    try { fs.unlinkSync(PENDING_FILE); } catch (_) {}

    // 組裝 systemMessage
    const labels = response.selectedLabels || [];
    const labelStr = labels.join(', ');
    output({
      continue: false,
      systemMessage: `\u4F7F\u7528\u8005\u900F\u904E Telegram \u9078\u64C7\u4E86\uFF1A${labelStr}\n\u8ACB\u6839\u64DA\u4F7F\u7528\u8005\u7684\u9078\u64C7\u7E7C\u7E8C\u57F7\u884C\u3002`,
    });
    return;
  }

  // 超時 → 保留 pending（設 hookTimedOut），阻止 TUI，daemon 後續 tmux 注入
  try {
    pending.hookTimedOut = true;
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending));
  } catch (_) {}
  output({
    continue: false,
    systemMessage: '\u{1F4F2} Telegram \u9078\u55AE\u5DF2\u767C\u9001\uFF0C\u4F7F\u7528\u8005\u5C1A\u672A\u56DE\u8986\u3002\u56DE\u8986\u5F8C\u7B54\u6848\u6703\u81EA\u52D5\u6CE8\u5165\uFF0C\u8ACB\u5148\u7E7C\u7E8C\u5176\u4ED6\u5DE5\u4F5C\u6216\u7B49\u5F85\u3002',
  });
}

main().catch(() => process.exit(0));
