#!/usr/bin/env node
/**
 * bot.js — Telegram Bot Daemon
 *
 * 背景執行的 long polling daemon：
 * - 查詢類：/status /stages /ping /help（讀 state files）
 * - 控制類：/say（tmux send-keys 注入 Claude Code session）
 * Phase 4：整合 Timeline consumer 訂閱事件流
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
  sendMessageWithKeyboard, answerCallbackQuery, editMessageReplyMarkup,
  getUpdates,
} = require(path.join(__dirname, 'scripts', 'lib', 'remote', 'telegram.js'));
const { STAGES, STAGE_ORDER, AGENT_TO_STAGE } = require(path.join(__dirname, 'scripts', 'lib', 'registry.js'));
const { createConsumer } = require(path.join(__dirname, 'scripts', 'lib', 'timeline', 'consumer.js'));
const { query: queryTimeline } = require(path.join(__dirname, 'scripts', 'lib', 'timeline', 'timeline.js'));
const { formatTimeline, formatEventText, EMOJI_MAP } = require(path.join(__dirname, 'scripts', 'lib', 'timeline', 'formatter.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PID_FILE = path.join(CLAUDE_DIR, 'remote-bot.pid');
const LOG_FILE = path.join(CLAUDE_DIR, 'remote-bot.log');
const RETRY_DELAY = 5000;
const START_TIME = Date.now();

// Timeline consumer 管理
const timelineConsumers = new Map(); // sessionId → consumer

// 已讀回條 state file（Stop hook 讀取後 editMessageText）
const SAY_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-say-pending.json');

// AskUserQuestion 互動式選單 state files（hook 寫 pending，daemon 寫 response）
const ASK_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');
const ASK_RESPONSE_FILE = path.join(CLAUDE_DIR, 'remote-ask-response.json');

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

// ─── TUI 操作 ─────────────────────────────────

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
 * 送出 tmux 按鍵，分步送出避免 TUI 掉鍵
 */
function sendKey(pane, key) {
  execSync(`tmux send-keys -t ${pane} ${key}`, { timeout: 2000 });
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

/**
 * 透過 tmux 鍵盤操作導航單選 AskUserQuestion
 * TUI 用上下鍵導航 — 不自動 Enter（由 ok 確認觸發）
 */
function sendAskNavigate(pane, optionIndex) {
  for (let i = 0; i < optionIndex; i++) {
    sendKey(pane, 'Down');
    sleep(50);
  }
}

/** 單選確認：Enter */
function sendAskConfirmSingle(pane) {
  sendKey(pane, 'Enter');
}

/**
 * 透過 tmux 鍵盤操作 toggle 多選 AskUserQuestion
 * TUI 支援數字鍵直接 toggle 對應選項（1→選項1, 2→選項2...）
 */
function sendAskToggle(pane, sortedIndices) {
  for (const idx of sortedIndices) {
    sendKey(pane, String(idx + 1));
    sleep(100);
  }
}

/** 多選確認：Tab 跳 Submit → Enter × 2（double submit） */
function sendAskConfirmMulti(pane) {
  sleep(100);
  sendKey(pane, 'Tab');
  sleep(100);
  sendKey(pane, 'Enter');
  sleep(300);
  sendKey(pane, 'Enter');
}

// ─── 共用 helpers ─────────────────────────────

/**
 * 取得 tmux pane，失敗時送 Telegram 錯誤訊息
 * @returns {string|null}
 */
async function getPane(token, chatId) {
  const pane = cachedPane || detectPane();
  if (!pane) {
    await sendMessage(token, chatId, '\u274C tmux \u672A\u9023\u7DDA', null);
    return null;
  }
  cachedPane = pane;
  return pane;
}

/**
 * 清除指定訊息的 inline keyboard
 */
async function clearKeyboard(token, chatId, messageId) {
  if (!messageId) return;
  try { await editMessageReplyMarkup(token, chatId, messageId, []); } catch (_) {}
}

/**
 * 完成當前題目：推進到下一題或清理 pending
 * @returns {boolean} true = 最後一題
 */
async function finishQuestion(token, chatId, pending, qIdx, label) {
  const total = pending.totalQuestions || 1;
  const isLast = qIdx >= total - 1;
  if (isLast) {
    try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
  } else {
    await advanceToNextQuestion(token, chatId, pending, qIdx, label);
  }
  return isLast;
}

// ─── Log ──────────────────────────────────────

function appendLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ─── 指令處理 ─────────────────────────────────

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

  // 過濾：只顯示有 DAG（v3 結構）的 session
  const activeSessions = sessions.filter(s =>
    s.dag && Object.keys(s.dag).length > 0
  );

  if (activeSessions.length === 0) {
    return sendMessage(token, chatId, '\u{1F4AD} \u7121\u6D3B\u8E8D\u7684 Pipeline session');
  }

  const lines = activeSessions.map(s => {
    const sid = s.id.slice(0, 8);
    // v3: 從 stages 推導已完成的 stage 列表
    const stagesMap = s.stages || {};
    const doneStages = Object.keys(stagesMap).filter(id =>
      stagesMap[id]?.status === 'completed' || stagesMap[id]?.status === 'skipped');
    const expected = Object.keys(s.dag || {});
    const progress = expected.length > 0
      ? Math.round((doneStages.length / expected.length) * 100)
      : 0;
    // v3: taskType 在 classification 巢狀結構
    const taskType = s.classification?.taskType || 'unknown';
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
  // v3: 從 stages 推導已完成的 stage ID 列表
  const stagesMap = target.stages || {};
  const completedStages = Object.keys(stagesMap).filter(id => stagesMap[id]?.status === 'completed');
  // v3: 從 stages 展平 verdict（物件 → 字串）
  const results = {};
  for (const [id, info] of Object.entries(stagesMap)) {
    if (info?.verdict) {
      const rawVerdict = info.verdict;
      const verdictStr = (typeof rawVerdict === 'object' && rawVerdict !== null)
        ? (rawVerdict.verdict || null)
        : rawVerdict;
      if (verdictStr) {
        const sev = (typeof rawVerdict === 'object') ? rawVerdict.severity : undefined;
        results[id] = { verdict: verdictStr, severity: sev };
      }
    }
  }
  // v3: dagStages 從 dag 取得所有已宣告的 stage
  const dagStages = Object.keys(target.dag || {});

  const stageLines = (dagStages.length > 0 ? dagStages : STAGE_ORDER).map(stage => {
    const emoji = (STAGES[stage] && STAGES[stage].emoji) || '\u2B1C';
    if (completedStages.includes(stage)) {
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
/timeline [sid] \u2014 \u67E5\u8A62\u6700\u8FD1 10 \u7B46\u4E8B\u4EF6
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

  const pane = await getPane(token, chatId);
  if (!pane) return;

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

async function handleTimeline(token, chatId, args) {
  const sessions = scanSessions();
  // 支援 /timeline [sid] [mode] 或 /timeline [mode]
  const parts = (args || '').split(/\s+/).filter(Boolean);
  const modes = ['full', 'compact', 'summary', 'stats'];
  let targetArg = null;
  let mode = 'compact';

  for (const p of parts) {
    if (modes.includes(p.toLowerCase())) {
      mode = p.toLowerCase();
    } else {
      targetArg = p;
    }
  }

  const target = targetArg
    ? sessions.find(s => s.id.startsWith(targetArg))
    : sessions[0];

  if (!target) {
    return sendMessage(token, chatId, targetArg
      ? `\u274C \u627E\u4E0D\u5230 session \`${targetArg}\``
      : '\u{1F4AD} \u7121\u6D3B\u8E8D\u7684 Pipeline session');
  }

  const sid = target.id.slice(0, 8);
  const allEvents = queryTimeline(target.id);

  if (allEvents.length === 0) {
    return sendMessage(token, chatId, `\u{1F4AD} Session \`${sid}\` \u7121 Timeline \u8A18\u9304`);
  }

  // 使用 formatter 模組格式化
  const showStats = mode === 'stats';
  const fmtMode = showStats ? 'compact' : mode;
  const lines = formatTimeline(allEvents, { mode: fmtMode, stats: showStats });

  // Telegram 訊息長度限制 4096，超長時截斷
  const header = `\u{1F4CB} *Timeline — \`${sid}\`*\n\u{1F4CA} ${allEvents.length} \u7B46\u4E8B\u4EF6\uFF08${fmtMode}\uFF09\n\n`;
  let body = lines.join('\n');
  if (header.length + body.length > 4000) {
    body = body.slice(0, 4000 - header.length) + '\n\u2026\uFF08\u622A\u65B7\uFF09';
  }
  return sendMessage(token, chatId, header + body);
}

// ─── Ask 解析與 UI ────────────────────────────

/**
 * 檢查是否有 pending AskUserQuestion，解析數字選擇或自由對話
 * 支援單數字 "2" 和多數字 "1 3" / "1,3" / "1、3"
 * @returns {{ pending, indices?, confirm?, adjustToggle?, freeText?, text? } | null}
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

  const trimmed = text.trim().toLowerCase();

  // 等待確認狀態 → 偵測 ok/確認
  if (pending.waitingConfirm) {
    if (/^(ok|確認|submit|yes|y)$/i.test(trimmed)) {
      return { pending, confirm: true };
    }
    // 多選等待確認期間，數字仍可調整選擇
    if (pending.multiSelect) {
      const nums = text.split(/[\s,、]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
      if (nums.length > 0) {
        const max = pending.optionCount || 0;
        const indices = [...new Set(nums)].filter(n => n >= 1 && n <= max).map(n => n - 1).sort((a, b) => a - b);
        if (indices.length > 0) return { pending, indices, adjustToggle: true };
      }
    }
    return { pending, freeText: true, text: trimmed };
  }

  // 正常狀態 → 解析數字（支援 "2"、"1 3"、"1,3"、"1、3"）
  const nums = text.split(/[\s,、]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  if (nums.length === 0) return { pending, freeText: true, text: trimmed };
  const max = pending.optionCount || 0;
  const indices = [...new Set(nums)].filter(n => n >= 1 && n <= max).map(n => n - 1).sort((a, b) => a - b);
  if (indices.length === 0) return { pending, freeText: true, text: trimmed };
  return { pending, indices };
}

/**
 * 組裝題目通知文字（用於多題推進時發送下一題）
 */
function buildQuestionText(questions, idx) {
  const q = questions[idx];
  if (!q || !q.options) return null;
  let text = `\u{1F4CB} ${q.question || q.header || '\u8ACB\u9078\u64C7'}`;
  text += '\n';
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i];
    text += `\n${i + 1}. ${opt.label}`;
    if (opt.description) text += ` \u2014 ${opt.description}`;
  }
  if (q.multiSelect) {
    text += '\n\n\u{1F449} \u56DE\u8986\u6578\u5B57\u52FE\u9078\uFF0C\u8F38\u5165 ok \u78BA\u8A8D';
  } else {
    text += '\n\n\u{1F449} \u56DE\u8986\u6578\u5B57\u9078\u64C7\uFF0C\u8F38\u5165 ok \u78BA\u8A8D';
  }
  return text;
}

/**
 * 建構 inline keyboard（多題推進時用）
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

/**
 * 推進到下一題 — 更新 pending + 發新通知（帶 keyboard）
 */
async function advanceToNextQuestion(token, chatId, pending, qIdx, answeredLabel) {
  const nextIdx = qIdx + 1;
  const nextQ = (pending.questions || [])[nextIdx];
  const nextMulti = nextQ ? nextQ.multiSelect === true : false;
  const nextCount = nextQ && nextQ.options ? nextQ.options.length : 0;

  await clearKeyboard(token, chatId, pending.messageId);
  await sendMessage(token, chatId, `\u2705 Q${qIdx + 1}: ${answeredLabel}`, null);

  // 發送下一題通知（帶 keyboard）
  const nextText = buildQuestionText(pending.questions, nextIdx);
  let newMessageId = null;
  if (nextText && nextQ) {
    try {
      const keyboard = buildKeyboard(nextQ);
      const result = await sendMessageWithKeyboard(token, chatId, nextText, keyboard, null);
      newMessageId = result && result.message_id;
    } catch (_) {
      await sendMessage(token, chatId, nextText, null);
    }
  }

  const updated = {
    ...pending,
    questionIndex: nextIdx,
    multiSelect: nextMulti,
    optionCount: nextCount,
    selections: nextMulti ? new Array(nextCount).fill(false) : undefined,
    selectedIndex: undefined,
    messageId: newMessageId || null,
    waitingConfirm: false,
  };
  fs.writeFileSync(ASK_PENDING_FILE, JSON.stringify(updated));
}

// ─── Ask 處理 ─────────────────────────────────

/**
 * 處理選擇動作（button click 或 text 數字）— 統一入口
 * 單選：navigate + Enter → finishQuestion
 * 多選：toggle → waitingConfirm
 * @param {Object} opts - { updateKeyboard: true } 表示 button 模式（更新 inline keyboard）
 */
async function handleAskSelect(token, chatId, pending, indices, opts = {}) {
  const pane = await getPane(token, chatId);
  if (!pane) return;

  const qIdx = pending.questionIndex || 0;
  const q = (pending.questions || [])[qIdx];
  const labels = indices.map(i =>
    q && q.options && q.options[i] ? q.options[i].label : `\u9078\u9805 ${i + 1}`
  );

  try {
    if (pending.multiSelect) {
      // 多選：toggle + 更新 state
      sendAskToggle(pane, indices);
      pending.selections = pending.selections || new Array(q.options.length).fill(false);
      for (const idx of indices) pending.selections[idx] = !pending.selections[idx];
      pending.waitingConfirm = true;
      fs.writeFileSync(ASK_PENDING_FILE, JSON.stringify(pending));
      appendLog(`ask-toggle: Q${qIdx + 1} [${indices}] ${labels.join(', ')}`);

      if (opts.updateKeyboard && pending.messageId) {
        // Button 模式：就地更新 keyboard checkbox 狀態
        const keyboard = q.options.map((opt, i) => [{
          text: `${pending.selections[i] ? '\u2611' : '\u2610'} ${opt.label}`,
          callback_data: `ask|${i}`,
        }]);
        keyboard.push([{ text: '\u2714 \u78BA\u8A8D', callback_data: 'ask|confirm' }]);
        try { await editMessageReplyMarkup(token, chatId, pending.messageId, keyboard); } catch (_) {}
      } else {
        // Text 模式：回覆確認提示
        await sendMessage(token, chatId,
          `\u2705 \u5DF2\u52FE\u9078\uFF1A${labels.join(', ')}\n\n\u{1F449} \u8F38\u5165 ok \u78BA\u8A8D\uFF0C\u6216\u5728\u7D42\u7AEF\u64CD\u4F5C`,
          null);
      }
    } else {
      // 單選：一步完成
      sendAskNavigate(pane, indices[0]);
      sendAskConfirmSingle(pane);
      appendLog(`ask-answer: Q${qIdx + 1} [${indices[0]}] ${labels[0]}`);

      // Button 模式：更新 Telegram 訊息（顯示結果）
      if (opts.updateKeyboard && pending.messageId) {
        const header = q && (q.question || q.header) || '';
        try {
          await editMessageText(token, chatId, pending.messageId,
            `\u{1F4CB} ${header}\n\n\u2705 \u5DF2\u9078\u64C7\uFF1A${labels[0]}`, null);
        } catch (_) {
          await clearKeyboard(token, chatId, pending.messageId);
        }
      }

      const isLast = await finishQuestion(token, chatId, pending, qIdx, labels[0]);
      // Text 模式 + 最後一題 → 送文字確認
      if (isLast && !opts.updateKeyboard) {
        await sendMessage(token, chatId, `\u2705 \u5DF2\u9078\u64C7\uFF1A${labels[0]}`, null);
      }
    }
  } catch (err) {
    cachedPane = null;
    return sendMessage(token, chatId, `\u274C \u64CD\u4F5C\u5931\u6557\uFF1A${err.message}`, null);
  }
}

/**
 * ok 確認 → 提交當前題目
 */
async function handleAskConfirm(token, chatId, pending) {
  const pane = await getPane(token, chatId);
  if (!pane) return;

  const qIdx = pending.questionIndex || 0;

  try {
    if (pending.multiSelect) {
      sendAskConfirmMulti(pane);
    } else {
      sendAskConfirmSingle(pane);
    }
    appendLog(`ask-confirm: Q${qIdx + 1}/${pending.totalQuestions || 1}`);

    await clearKeyboard(token, chatId, pending.messageId);
    const isLast = await finishQuestion(token, chatId, pending, qIdx, '\u78BA\u8A8D');
    if (isLast) {
      await sendMessage(token, chatId, '\u2705 \u5DF2\u78BA\u8A8D\u63D0\u4EA4', null);
    }
  } catch (err) {
    cachedPane = null;
    return sendMessage(token, chatId, `\u274C \u78BA\u8A8D\u5931\u6557\uFF1A${err.message}`, null);
  }
}

/**
 * 自由對話：Esc 退出 AskUserQuestion → 送出文字
 */
async function handleAskFreeText(token, chatId, pending, text) {
  const pane = await getPane(token, chatId);
  if (!pane) return;

  sendKey(pane, 'Escape');
  sleep(200);
  sendKeys(pane, text);
  appendLog(`ask-freetext: "${text}"`);

  if (pending.messageId) {
    const qIdx = pending.questionIndex || 0;
    const q = (pending.questions || [])[qIdx];
    const header = q && (q.question || q.header) || '';
    try {
      await editMessageText(token, chatId, pending.messageId,
        `\u{1F4CB} ${header}\n\n\u{1F4AC} ${text}`, null);
    } catch (_) {}
  }
  try { fs.unlinkSync(ASK_PENDING_FILE); } catch (_) {}
  await sendMessage(token, chatId, '\u2705 \u5DF2\u50B3\u9001', null);
}

/**
 * 多選等待確認期間調整選擇
 */
async function handleAskAdjust(token, chatId, pending, indices) {
  const pane = await getPane(token, chatId);
  if (!pane) return;

  sendAskToggle(pane, indices);
  const qIdx = pending.questionIndex || 0;
  const q = (pending.questions || [])[qIdx];
  const labels = indices.map(i =>
    q && q.options && q.options[i] ? q.options[i].label : `\u9078\u9805 ${i + 1}`
  );
  appendLog(`ask-adjust: Q${qIdx + 1} [${indices}] ${labels.join(', ')}`);
  await sendMessage(token, chatId,
    `\u{1F504} \u5DF2\u5207\u63DB\uFF1A${labels.join(', ')}\n\n\u{1F449} \u8F38\u5165 ok \u78BA\u8A8D`,
    null);
}

/**
 * 分派 AskUserQuestion 相關的文字訊息
 * @returns {boolean} true = 已處理，false = 無 pending
 */
async function dispatchAskMessage(token, chatId, text) {
  const match = checkAskPending(text);
  if (!match) return false;

  if (match.freeText) {
    await handleAskFreeText(token, chatId, match.pending, match.text);
  } else if (match.confirm) {
    await handleAskConfirm(token, chatId, match.pending);
  } else if (match.adjustToggle) {
    await handleAskAdjust(token, chatId, match.pending, match.indices);
  } else {
    await handleAskSelect(token, chatId, match.pending, match.indices);
  }
  return true;
}

// ─── Callback 處理 ────────────────────────────

/**
 * 處理 Telegram inline keyboard 的 callback_query
 */
async function handleCallbackQuery(token, chatId, callbackQuery) {
  const cbId = callbackQuery.id;
  const data = callbackQuery.data || '';

  if (!data.startsWith('ask|')) {
    try { await answerCallbackQuery(token, cbId); } catch (_) {}
    return;
  }

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(ASK_PENDING_FILE, 'utf8'));
  } catch (_) {
    try { await answerCallbackQuery(token, cbId, '\u274C \u5DF2\u904E\u671F'); } catch (_) {}
    return;
  }

  const qIdx = pending.questionIndex || 0;
  const q = (pending.questions || [])[qIdx];
  if (!q || !q.options) {
    try { await answerCallbackQuery(token, cbId); } catch (_) {}
    return;
  }

  const action = data.slice(4);

  // 確認按鈕
  if (action === 'confirm') {
    if (!pending.waitingConfirm) {
      try { await answerCallbackQuery(token, cbId, '\u8ACB\u5148\u9078\u64C7\u9078\u9805'); } catch (_) {}
      return;
    }
    await handleAskConfirm(token, chatId, pending);
    try { await answerCallbackQuery(token, cbId, '\u2705'); } catch (_) {}
    return;
  }

  // 選項按鈕 → 委派給統一的 handleAskSelect
  const idx = parseInt(action, 10);
  if (isNaN(idx) || idx < 0 || idx >= q.options.length) {
    try { await answerCallbackQuery(token, cbId); } catch (_) {}
    return;
  }

  await handleAskSelect(token, chatId, pending, [idx], { updateKeyboard: true });
  const label = q.options[idx].label;
  try {
    await answerCallbackQuery(token, cbId, pending.multiSelect ? '' : `\u2705 ${label}`);
  } catch (_) {}
}

// ─── 主迴圈 ──────────────────────────────────

/**
 * 清理可能殘留的孤兒 bot 進程（避免 getUpdates 衝突）
 */
function cleanupOrphanProcesses() {
  try {
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

/**
 * 統一格式化 timeline 事件（推播用）
 * 使用 formatter.js 的 formatEventText 統一文字描述
 * @param {object} event - timeline event
 * @param {object} [opts] - { pushMode: true } 推播模式（只顯示重要事件）
 * @returns {string|null}
 */
function formatTimelineEvent(event, opts = {}) {
  const t = new Date(event.timestamp).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const emoji = EMOJI_MAP[event.type] || '\u{1F4CB}';

  // 推播模式：只推送重要事件（pipeline + stage + 阻擋）
  if (opts.pushMode) {
    const important = ['stage.complete', 'stage.retry', 'pipeline.complete',
                       'pipeline.incomplete', 'tool.blocked', 'ask.question'];
    if (!important.includes(event.type)) return null;
  }

  return `${emoji} ${t} ${formatEventText(event)}`;
}

/**
 * 啟動指定 session 的 Timeline consumer（推播到 Telegram）
 */
function startTimelineConsumer(token, chatId, sessionId) {
  if (timelineConsumers.has(sessionId)) return;

  const consumer = createConsumer({
    name: `remote-${sessionId.slice(0, 8)}`,
    types: ['pipeline', 'remote'],
    handlers: {
      '*': async (event) => {
        const msg = formatTimelineEvent(event, { pushMode: true });
        if (msg) {
          try { await sendMessage(token, chatId, msg); } catch (_) {}
        }
      },
    },
    onError: (name, err) => {
      appendLog(`[Timeline Consumer ${name}] Error: ${err.message}`);
    },
  });

  // 不 replay（避免重複推播歷史事件）
  consumer.start(sessionId, { replay: false });
  timelineConsumers.set(sessionId, consumer);
}

/**
 * 停止指定 session 的 Timeline consumer
 */
function stopTimelineConsumer(sessionId) {
  const consumer = timelineConsumers.get(sessionId);
  if (consumer) {
    consumer.stop();
    timelineConsumers.delete(sessionId);
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

  // 啟動已存在 session 的 Timeline consumer
  const sessions = scanSessions();
  for (const s of sessions) {
    if (s.dag && Object.keys(s.dag).length > 0) {
      startTimelineConsumer(creds.token, creds.chatId, s.id);
    }
  }

  let offset = 0;

  // 優雅關閉
  const cleanup = () => {
    // 停止所有 Timeline consumer
    for (const [sid, consumer] of timelineConsumers.entries()) {
      consumer.stop();
    }
    timelineConsumers.clear();

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
          case '/timeline':
            await handleTimeline(creds.token, creds.chatId, args || null);
            break;
          default:
            if (!text.startsWith('/')) {
              const handled = await dispatchAskMessage(creds.token, creds.chatId, text);
              if (!handled) await handleSay(creds.token, creds.chatId, text);
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
