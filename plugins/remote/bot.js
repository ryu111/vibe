#!/usr/bin/env node
/**
 * bot.js — Telegram Bot Daemon
 *
 * 背景執行的 long polling daemon：
 * - 查詢類：/status /stages /ping /help（讀 state files）
 * - 控制類：/say（tmux send-keys 注入 Claude Code session）
 *
 * 生命週期：由 bot-manager.js 管理（start/stop）。
 * PID 檔：~/.claude/remote-bot.pid（全域）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  getCredentials, sendMessage, editMessageText,
  answerCallbackQuery, editMessageReplyMarkup,
  getUpdates,
} = require(path.join(__dirname, 'scripts', 'lib', 'telegram.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PID_FILE = path.join(CLAUDE_DIR, 'remote-bot.pid');
const LOG_FILE = path.join(CLAUDE_DIR, 'remote-bot.log');
const RETRY_DELAY = 5000;
const START_TIME = Date.now();

// 已讀回條 state file（Stop hook 讀取後 editMessageText）
const SAY_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-say-pending.json');

// AskUserQuestion 互動式選單 state files（hook 寫 pending，daemon 寫 response）
const ASK_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');
const ASK_RESPONSE_FILE = path.join(CLAUDE_DIR, 'remote-ask-response.json');

// Agent → Stage 映射（與 remote-sender.js 同步）
const AGENT_STAGE = {
  planner: 'PLAN',
  architect: 'ARCH',
  developer: 'DEV',
  'code-reviewer': 'REVIEW',
  tester: 'TEST',
  qa: 'QA',
  'e2e-runner': 'E2E',
  'doc-updater': 'DOCS',
};

const STAGE_EMOJI = {
  PLAN: '\u{1F4CB}',
  ARCH: '\u{1F3D7}\uFE0F',
  DEV: '\u{1F4BB}',
  REVIEW: '\u{1F50D}',
  TEST: '\u{1F9EA}',
  QA: '\u2705',
  E2E: '\u{1F310}',
  DOCS: '\u{1F4DD}',
};

// ─── tmux 偵測 ────────────────────────────────

let cachedPane = null;

/**
 * 偵測 tmux pane（Claude Code 運行的終端）
 * 優先順序：環境變數 → pane_current_command → pgrep 進程樹 → TMUX_PANE → null
 */
function detectPane() {
  // 1. 環境變數（最可靠）
  if (process.env.CLAUDE_TMUX_PANE) {
    return process.env.CLAUDE_TMUX_PANE;
  }

  try {
    // 2a. 掃描 tmux panes 的 current_command 找 claude
    const output = execSync('tmux list-panes -a -F "#{pane_id} #{pane_pid} #{pane_current_command}"', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    const panes = []; // [{id, pid}]
    for (const line of output.split('\n')) {
      const [paneId, panePid, ...cmdParts] = line.split(' ');
      const cmd = cmdParts.join(' ').toLowerCase();
      if (cmd.includes('claude')) {
        return paneId;
      }
      panes.push({ id: paneId, pid: panePid });
    }

    // 2b. pgrep claude → 追溯 parent 到 tmux pane（解決 zsh→claude 的進程樹問題）
    try {
      const claudePids = execSync('pgrep -x claude', {
        encoding: 'utf8',
        timeout: 3000,
      }).trim().split('\n').filter(Boolean);

      const paneByPid = {};
      for (const p of panes) paneByPid[p.pid] = p.id;

      for (const cPid of claudePids) {
        const ppid = execSync(`ps -o ppid= -p ${cPid}`, {
          encoding: 'utf8',
          timeout: 3000,
        }).trim();
        if (paneByPid[ppid]) return paneByPid[ppid];
      }
    } catch (_) {}
  } catch (_) {
    // tmux 未安裝或未執行
  }

  // 3. 回退
  if (process.env.TMUX_PANE) {
    return process.env.TMUX_PANE;
  }

  return null;
}

/**
 * 透過 tmux send-keys 注入文字到 Claude Code session
 * @param {string} pane — tmux pane ID
 * @param {string} text — 要注入的文字
 */
function sendKeys(pane, text) {
  // 先送文字（-l = literal mode，避免特殊字元被解析為 key name）
  const escaped = text.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  execSync(`tmux send-keys -t ${pane} -l "${escaped}"`, { timeout: 5000 });
  // 再單獨送 Enter
  execSync(`tmux send-keys -t ${pane} Enter`, { timeout: 5000 });
}

/**
 * 透過 tmux 鍵盤操作回答 AskUserQuestion
 * TUI 用上下鍵導航、Enter 確認 — 用 key name 而非 literal text
 * @param {string} pane — tmux pane ID
 * @param {number} optionIndex — 0-based 選項索引
 */
function sendAskAnswer(pane, optionIndex) {
  for (let i = 0; i < optionIndex; i++) {
    execSync(`tmux send-keys -t ${pane} Down`, { timeout: 2000 });
  }
  execSync(`tmux send-keys -t ${pane} Enter`, { timeout: 2000 });
}

// ─── 指令處理 ──────────────────────────────────

/**
 * 掃描所有活躍 pipeline session
 */
function scanSessions() {
  const sessions = [];
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    for (const file of files) {
      const match = file.match(/^pipeline-state-(.+)\.json$/);
      if (!match) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, file), 'utf8'));
        sessions.push({ id: match[1], ...data });
      } catch (_) {}
    }
  } catch (_) {}
  return sessions;
}

async function handleStatus(token, chatId) {
  const sessions = scanSessions();

  // 過濾：只顯示有 pipeline（expectedStages > 0）的 session
  const activeSessions = sessions.filter(s =>
    s.expectedStages && s.expectedStages.length > 0
  );

  if (activeSessions.length === 0) {
    return sendMessage(token, chatId, '\u{1F4AD} \u7121\u6D3B\u8E8D\u7684 Pipeline session');
  }

  const lines = activeSessions.map(s => {
    const sid = s.id.slice(0, 8);
    const completed = (s.completed || []).map(a => {
      const short = a.includes(':') ? a.split(':')[1] : a;
      return AGENT_STAGE[short];
    }).filter(Boolean);
    const expected = s.expectedStages;
    const progress = expected.length > 0
      ? Math.round((completed.length / expected.length) * 100)
      : 0;
    const taskType = s.taskType || 'unknown';
    return `\`${sid}\` ${taskType} ${progress}%`;
  });

  return sendMessage(token, chatId, `\u{1F4CA} *\u6D3B\u8E8D Session*\n${lines.join('\n')}`);
}

async function handleStages(token, chatId, args) {
  const sessions = scanSessions();
  const target = args
    ? sessions.find(s => s.id.startsWith(args))
    : sessions[0];

  if (!target) {
    return sendMessage(token, chatId, args
      ? `\u274C \u627E\u4E0D\u5230 session \`${args}\``
      : '\u{1F4AD} \u7121\u6D3B\u8E8D\u7684 Pipeline session');
  }

  const sid = target.id.slice(0, 8);
  const completed = (target.completed || []).map(a => {
    const short = a.includes(':') ? a.split(':')[1] : a;
    return AGENT_STAGE[short];
  }).filter(Boolean);
  const results = target.stageResults || {};

  const stageLines = (target.expectedStages || Object.keys(STAGE_EMOJI)).map(stage => {
    const emoji = STAGE_EMOJI[stage] || '\u2B1C';
    if (completed.includes(stage)) {
      const r = results[stage];
      const verdict = r ? (r.verdict === 'PASS' ? '\u2705' : `\u274C${r.severity ? ':' + r.severity : ''}`) : '\u2753';
      return `${emoji} ${stage} ${verdict}`;
    }
    return `${emoji} ${stage} \u2B1C`;
  });

  return sendMessage(token, chatId, `\u{1F4CB} *Session \`${sid}\`*\n${stageLines.join('\n')}`);
}

async function handlePing(token, chatId) {
  const uptime = Math.round((Date.now() - START_TIME) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const uptimeStr = h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
  return sendMessage(token, chatId, `\u{1F3D3} pong\nUptime: ${uptimeStr}`);
}

async function handleHelp(token, chatId) {
  return sendMessage(token, chatId, `\u{1F916} *Vibe Remote Bot*

\u{1F50D} *\u67E5\u8A62\u6307\u4EE4*
/status \u2014 \u5217\u51FA\u6D3B\u8E8D session \u9032\u5EA6
/stages [sid] \u2014 \u6307\u5B9A session \u7684 stage \u8A73\u60C5
/ping \u2014 \u6E2C\u8A66 bot \u5B58\u6D3B
/help \u2014 \u986F\u793A\u6B64\u8AAA\u660E

\u{1F3AE} *\u63A7\u5236\u6307\u4EE4*
/say <\u8A0A\u606F> \u2014 \u50B3\u9001\u8A0A\u606F\u5230 Claude Code
/tmux \u2014 \u986F\u793A tmux \u9023\u7DDA\u72C0\u614B`);
}

async function handleSay(token, chatId, text) {
  if (!text) {
    return sendMessage(token, chatId, '\u26A0\uFE0F \u7528\u6CD5\uFF1A`/say <\u8A0A\u606F>`');
  }

  // 偵測或使用快取的 tmux pane
  const pane = cachedPane || detectPane();
  if (!pane) {
    return sendMessage(token, chatId, '\u274C tmux \u672A\u9023\u7DDA\u3002\u8ACB\u78BA\u8A8D Claude Code \u5728 tmux session \u5167\u57F7\u884C\u3002');
  }
  cachedPane = pane;

  try {
    sendKeys(pane, text);
    appendLog(`/say: ${text}`);
    // 送出「✓ 已傳送」並寫 state file，Stop hook 會 editMessageText 為 ✅ 完成
    const msg = await sendMessage(token, chatId, '\u2713 \u5DF2\u50B3\u9001');
    try {
      fs.writeFileSync(SAY_PENDING_FILE, JSON.stringify({
        messageId: msg.message_id,
        chatId,
        sentAt: Date.now(),
      }));
    } catch (_) {}
  } catch (err) {
    cachedPane = null;
    return sendMessage(token, chatId, `\u274C tmux \u50B3\u9001\u5931\u6557\uFF1A${err.message}`);
  }
}

async function handleTmux(token, chatId) {
  cachedPane = null; // 強制重新偵測
  const pane = detectPane();
  if (pane) {
    cachedPane = pane;
    return sendMessage(token, chatId, `\u2705 tmux \u5DF2\u9023\u7DDA\nPane: \`${pane}\``);
  }
  return sendMessage(token, chatId, '\u274C tmux \u672A\u9023\u7DDA\n\u8ACB\u5728 tmux \u5167\u555F\u52D5 Claude Code');
}

/**
 * 檢查是否有 pending AskUserQuestion
 * @returns {{ pending: object, optionIndex: number } | null}
 */
function checkAskPending(text) {
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(ASK_PENDING_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
  // 檢查是否過期（5 分鐘）
  if (Date.now() - (pending.createdAt || 0) > 5 * 60 * 1000) {
    try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
    return null;
  }
  // 解析數字選擇（1-based → 0-based）
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 1 || num > (pending.optionCount || 0)) return null;
  return { pending, optionIndex: num - 1 };
}

/**
 * 處理 AskUserQuestion 的 Telegram 回覆 — 透過 tmux 鍵盤操作選擇選項
 */
async function handleAskAnswer(token, chatId, optionIndex, pending) {
  const pane = cachedPane || detectPane();
  if (!pane) {
    return sendMessage(token, chatId, '\u274C tmux \u672A\u9023\u7DDA', null);
  }
  cachedPane = pane;

  const q = (pending.questions || [])[pending.questionIndex || 0];
  const label = q && q.options && q.options[optionIndex]
    ? q.options[optionIndex].label
    : `\u9078\u9805 ${optionIndex + 1}`;

  try {
    sendAskAnswer(pane, optionIndex);
    appendLog(`ask-answer: ${optionIndex} (${label})`);
    // 清理 pending
    try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
    await sendMessage(token, chatId, `\u2705 \u5DF2\u9078\u64C7\uFF1A${label}`, null);
  } catch (err) {
    cachedPane = null;
    return sendMessage(token, chatId, `\u274C \u64CD\u4F5C\u5931\u6557\uFF1A${err.message}`, null);
  }
}

// ─── AskUserQuestion callback 處理 ──────────────

/**
 * 當 hook 已超時（hookTimedOut=true），透過 tmux send-keys 注入答案
 * @param {string[]} labels — 選擇的 label 列表
 */
function injectAnswerViaTmux(labels) {
  const pane = cachedPane || detectPane();
  if (!pane) return;
  cachedPane = pane;

  const labelStr = labels.join(', ');
  const answer = `\u4F7F\u7528\u8005\u900F\u904E Telegram \u9078\u64C7\u4E86\uFF1A${labelStr}`;
  try {
    sendKeys(pane, answer);
    appendLog(`tmux inject: ${answer}`);
  } catch (_) {}
}

/**
 * 處理 Telegram inline keyboard 的 callback_query
 * 與 remote-ask-intercept.js hook 協調：
 * - hook 寫 pending file + 發送 inline keyboard
 * - daemon 收到 callback → 更新 pending / 寫 response file
 * - 若 hook 已超時（hookTimedOut）→ 額外透過 tmux send-keys 注入答案
 */
async function handleCallbackQuery(token, chatId, callbackQuery) {
  const cbId = callbackQuery.id;
  const data = callbackQuery.data || '';
  const cbMsg = callbackQuery.message;

  // 只處理 ask| 前綴的 callback
  if (!data.startsWith('ask|')) {
    try { await answerCallbackQuery(token, cbId); } catch (_) {}
    return;
  }

  // 讀取 pending state
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(ASK_PENDING_FILE, 'utf8'));
  } catch (_) {
    try { await answerCallbackQuery(token, cbId, '\u274C \u5DF2\u904E\u671F'); } catch (_) {}
    return;
  }

  // 驗證 messageId
  if (cbMsg && cbMsg.message_id !== pending.messageId) {
    try { await answerCallbackQuery(token, cbId, '\u274C \u8A0A\u606F\u4E0D\u5339\u914D'); } catch (_) {}
    return;
  }

  const action = data.slice(4); // 去掉 "ask|" 前綴
  const questions = pending.questions || [];
  const qIdx = pending.questionIndex || 0;
  const q = questions[qIdx];
  if (!q || !q.options) {
    try { await answerCallbackQuery(token, cbId); } catch (_) {}
    return;
  }

  if (pending.multiSelect) {
    // ─── 多選模式 ───
    if (action === 'confirm') {
      // 確認選擇 → 寫 response file
      const selectedLabels = q.options
        .filter((_, i) => pending.selections[i])
        .map(o => o.label);

      if (selectedLabels.length === 0) {
        try { await answerCallbackQuery(token, cbId, '\u8ACB\u81F3\u5C11\u9078\u64C7\u4E00\u9805'); } catch (_) {}
        return;
      }

      // 更新 Telegram 訊息：顯示選擇結果（純文字避免 Markdown 解析錯誤）
      const header = q.question || q.header || '請選擇';
      let confirmText = `\u2705 ${header}\n`;
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const mark = pending.selections[i] ? '\u2705' : '\u00B7';
        confirmText += `\n${mark} ${opt.label}`;
      }
      confirmText += '\n\n\u{1F449} \u8ACB\u5728\u7D42\u7AEF\u78BA\u8A8D';
      try {
        await editMessageText(token, chatId, pending.messageId, confirmText, null);
      } catch (_) {}

      // 清理 pending
      try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
      try { await answerCallbackQuery(token, cbId, '\u2705 \u5DF2\u78BA\u8A8D'); } catch (_) {}
    } else {
      // toggle 選項
      const idx = parseInt(action, 10);
      if (isNaN(idx) || idx < 0 || idx >= q.options.length) {
        try { await answerCallbackQuery(token, cbId); } catch (_) {}
        return;
      }

      pending.selections[idx] = !pending.selections[idx];

      // 更新 pending file
      fs.writeFileSync(ASK_PENDING_FILE, JSON.stringify(pending));

      // 更新 keyboard 顯示 ☑/☐
      const keyboard = q.options.map((opt, i) => [{
        text: `${pending.selections[i] ? '\u2611' : '\u2610'} ${opt.label}`,
        callback_data: `ask|${i}`,
      }]);
      keyboard.push([{ text: '\u2714 \u78BA\u8A8D', callback_data: 'ask|confirm' }]);

      try {
        await editMessageReplyMarkup(token, chatId, pending.messageId, keyboard);
      } catch (_) {}
      try { await answerCallbackQuery(token, cbId); } catch (_) {}
    }
  } else {
    // ─── 單選模式 ───
    const idx = parseInt(action, 10);
    if (isNaN(idx) || idx < 0 || idx >= q.options.length) {
      try { await answerCallbackQuery(token, cbId); } catch (_) {}
      return;
    }

    const selected = q.options[idx];

    // 更新 Telegram 訊息：顯示選擇結果（純文字避免 Markdown 解析錯誤）
    const header = q.question || q.header || '請選擇';
    let confirmText = `\u2705 ${header}\n`;
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      const mark = i === idx ? '\u2705' : '\u00B7';
      confirmText += `\n${mark} ${opt.label}`;
    }
    confirmText += '\n\n\u{1F449} \u8ACB\u5728\u7D42\u7AEF\u78BA\u8A8D';
    try {
      await editMessageText(token, chatId, pending.messageId, confirmText, null);
    } catch (_) {}

    // 清理 pending
    try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
    try { await answerCallbackQuery(token, cbId, `\u2705 ${selected.label}`); } catch (_) {}
  }
}

// ─── Log ───────────────────────────────────────

function appendLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ─── 主迴圈 ────────────────────────────────────

/**
 * 清理可能殘留的孤兒 bot 進程（避免 getUpdates 衝突）
 */
function cleanupOrphanProcesses() {
  try {
    const { execSync } = require('child_process');
    const pids = execSync('pgrep -f "bot\\.js"', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim().split('\n').filter(Boolean);

    const myPid = process.pid;
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (pid !== myPid && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
          appendLog(`\u6E05\u7406\u5B64\u5152\u9032\u7A0B: ${pid}`);
        } catch (_) {}
      }
    }
  } catch (_) {
    // pgrep 找不到 → 無孤兒進程
  }
}

async function main() {
  const creds = getCredentials();
  if (!creds) {
    process.stderr.write('remote-bot: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID \u672A\u8A2D\u5B9A\n');
    process.exit(1);
  }

  // 啟動時清理孤兒進程
  cleanupOrphanProcesses();
  appendLog('Bot daemon \u555F\u52D5');

  // 初始偵測 tmux pane
  cachedPane = detectPane();
  if (cachedPane) {
    appendLog(`tmux pane \u5075\u6E2C\u5230: ${cachedPane}`);
  }

  let offset = 0;

  // 優雅關閉
  const cleanup = () => {
    appendLog('Bot daemon \u95DC\u9589');
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Long polling 主迴圈
  while (true) {
    try {
      const updates = await getUpdates(creds.token, offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        // 處理 inline keyboard callback（AskUserQuestion 互動式選單）
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbChatId = cb.message && cb.message.chat && String(cb.message.chat.id);
          appendLog(`callback: ${cb.data}`);
          if (cbChatId === String(creds.chatId)) {
            await handleCallbackQuery(creds.token, creds.chatId, cb);
          } else {
            try { await answerCallbackQuery(creds.token, cb.id); } catch (_) {}
          }
          continue;
        }

        const msg = update.message;
        if (!msg || !msg.text) continue;

        // 安全檢查：只回應指定 chatId
        if (String(msg.chat.id) !== String(creds.chatId)) continue;

        const text = msg.text.trim();
        const [cmd, ...argParts] = text.split(' ');
        const args = argParts.join(' ').trim();

        switch (cmd.toLowerCase()) {
          case '/status':
            await handleStatus(creds.token, creds.chatId);
            break;
          case '/stages':
            await handleStages(creds.token, creds.chatId, args || null);
            break;
          case '/ping':
            await handlePing(creds.token, creds.chatId);
            break;
          case '/help':
          case '/start':
            await handleHelp(creds.token, creds.chatId);
            break;
          case '/say':
            await handleSay(creds.token, creds.chatId, args);
            break;
          case '/tmux':
            await handleTmux(creds.token, creds.chatId);
            break;
          default:
            // 非指令訊息
            if (!text.startsWith('/')) {
              // 先檢查是否有 pending AskUserQuestion → 數字回覆觸發鍵盤操作
              const askMatch = checkAskPending(text);
              if (askMatch) {
                await handleAskAnswer(creds.token, creds.chatId, askMatch.optionIndex, askMatch.pending);
              } else {
                await handleSay(creds.token, creds.chatId, text);
              }
            }
            break;
        }
      }
    } catch (err) {
      appendLog(`polling \u932F\u8AA4: ${err.message}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

main();
