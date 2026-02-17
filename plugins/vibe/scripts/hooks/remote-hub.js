#!/usr/bin/env node
/**
 * remote-hub.js — 統一遠端控制 hook
 *
 * 合併 5 個 remote hook 腳本，透過 CLI 參數路由：
 *   autostart      SessionStart — 自動啟動 Telegram daemon
 *   prompt-forward  UserPromptSubmit — 轉發使用者輸入
 *   ask-intercept   PreToolUse(AskUserQuestion) — 轉發互動選單
 *   sender          SubagentStop — Pipeline 進度推播
 *   receipt         Stop — 回合摘要 + /say 已讀回條
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { getCredentials, sendMessage, sendMessageWithKeyboard, editMessageText } = require(
  path.join(__dirname, '..', 'lib', 'remote', 'telegram.js')
);
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { STAGES, STAGE_ORDER, AGENT_TO_STAGE, TOOL_EMOJI } = require(
  path.join(__dirname, '..', 'lib', 'registry.js')
);

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ─── 共用工具 ─────────────────────────────

function readStdin() {
  try { return JSON.parse(fs.readFileSync('/dev/stdin', 'utf8')); }
  catch (_) { return {}; }
}

// ─── autostart（SessionStart）─────────────

async function handleAutostart() {
  const creds = getCredentials();
  if (!creds) process.exit(0);

  const { isRunning, start, getState } = require(
    path.join(__dirname, '..', 'lib', 'remote', 'bot-manager.js')
  );

  if (isRunning()) {
    const state = getState();
    console.log(JSON.stringify({
      additionalContext: `Telegram bot \u57F7\u884C\u4E2D\uFF08PID: ${state?.pid || '?'}\uFF09\u3002\u4F7F\u7528 /remote \u7BA1\u7406\u3002`,
    }));
  } else {
    const result = start();
    let ready = false;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (isRunning()) { ready = true; break; }
    }
    console.log(JSON.stringify({
      additionalContext: ready
        ? `Telegram bot \u5DF2\u81EA\u52D5\u555F\u52D5\uFF08PID: ${result.pid}\uFF09\u3002\u4F7F\u7528 /remote \u7BA1\u7406\u3002`
        : `Telegram bot \u555F\u52D5\u4E2D\uFF08PID: ${result.pid}\uFF09\u3002\u4F7F\u7528 /remote status \u6AA2\u67E5\u3002`,
    }));
  }
}

// ─── prompt-forward（UserPromptSubmit）─────

async function handlePromptForward(data) {
  const prompt = data.prompt;
  if (!prompt || !prompt.trim()) process.exit(0);

  const creds = getCredentials();
  if (!creds) process.exit(0);

  const maxLen = 3900;
  let text = prompt.trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + '\n\u2026 (\u622A\u65B7)';
  }

  await sendMessage(creds.token, creds.chatId, `\u{1F464} ${text}`);
}

// ─── ask-intercept（PreToolUse AskUserQuestion）─────

const ASK_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-ask-pending.json');

function buildNotifyText(questions, qIdx) {
  const q = questions[qIdx];
  if (!q || !q.options) return null;

  const multiSelect = q.multiSelect === true;
  const header = q.question || q.header || '\u8ACB\u9078\u64C7';

  let text = `\u{1F4CB} ${header}\n`;
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

async function handleAskIntercept(data) {
  if (data.tool_name !== 'AskUserQuestion') process.exit(0);

  const sessionId = data.session_id || 'unknown';
  const toolInput = data.tool_input || {};
  const questions = toolInput.questions;
  if (!questions || !questions.length) process.exit(0);

  emit(EVENT_TYPES.ASK_QUESTION, sessionId, {
    questionCount: questions.length,
  });

  const creds = getCredentials();
  if (!creds) process.exit(0);

  const q = questions[0];
  const notify = buildNotifyText(questions, 0);
  if (!notify) process.exit(0);

  let messageId = null;
  try {
    const keyboard = buildKeyboard(q);
    const result = await sendMessageWithKeyboard(
      creds.token, creds.chatId, notify.text, keyboard, null
    );
    messageId = result && result.message_id;
  } catch (err) {
    hookLogger.error('remote-hub:ask-intercept', err);
  }

  fs.writeFileSync(ASK_PENDING_FILE, JSON.stringify({
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
}

// ─── sender（SubagentStop）─────────────

function buildProgressBar(completedStages, stageResults, expectedStages) {
  const stages = expectedStages || STAGE_ORDER;
  return stages.map(stage => {
    const cfg = STAGES[stage];
    if (!cfg) return stage;

    if (completedStages.includes(stage)) {
      const result = stageResults[stage];
      const icon = result && result.verdict === 'FAIL' ? '\u274C' : '\u2705';
      return `${cfg.emoji}${icon}`;
    }
    return `${cfg.emoji}\u2B1C`;
  }).join(' \u2192 ');
}

function formatDuration(ms) {
  if (!ms || ms < 0) return null;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * 從 v3 DAG state 提取已完成的 stage 名稱
 * v3 state.stages 是 { stageId: { status, agent, verdict, ... } } 映射
 */
function extractCompletedStages(state) {
  const stages = state.stages || {};
  return Object.keys(stages).filter(s => stages[s]?.status === 'completed');
}

async function handleSender(data) {
  if (data.stop_hook_active) process.exit(0);

  const creds = getCredentials();
  if (!creds) process.exit(0);

  const sessionId = data.session_id || 'unknown';
  const agentType = data.agent_type;
  if (!agentType) process.exit(0);

  const shortName = agentType.includes(':') ? agentType.split(':')[1] : agentType;
  const currentStage = AGENT_TO_STAGE[shortName];
  if (!currentStage) process.exit(0);

  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  if (!fs.existsSync(statePath)) process.exit(0);

  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (_) { process.exit(0); }

  // v3 DAG state 結構
  const meta = state.meta || {};
  const stagesMap = state.stages || {};
  const classification = state.classification || {};

  const completedStages = extractCompletedStages(state);

  // v3: stageResults 從 stages 映射推導（每個 stage 有 verdict 欄位）
  // verdict 可能是物件 { verdict: 'PASS'|'FAIL', severity: ... }（由 verdict.js parseVerdict 產出）
  // 展平為字串格式，確保 buildProgressBar 等地方的字串比較正確
  const stageResults = {};
  for (const [stageId, stageInfo] of Object.entries(stagesMap)) {
    if (stageInfo?.verdict) {
      const rawVerdict = stageInfo.verdict;
      const verdictStr = (typeof rawVerdict === 'object' && rawVerdict !== null)
        ? (rawVerdict.verdict || null)
        : rawVerdict;
      if (verdictStr) {
        stageResults[stageId] = { verdict: verdictStr };
      }
    }
  }

  // v3: expectedStages 從 dag 取得所有已宣告的 stage
  const expectedStages = Object.keys(state.dag || {});
  if (expectedStages.length === 0) {
    // 無 DAG 結構，可能是未分類 session — 靜默退出
    process.exit(0);
  }

  const taskType = classification.taskType || null;

  // 耗時計算（lastTransition 是 ISO 字串）
  const lastTransitionStr = meta.lastTransition || null;
  const lastTransitionMs = lastTransitionStr ? new Date(lastTransitionStr).getTime() : null;
  const stageDuration = lastTransitionMs ? formatDuration(Date.now() - lastTransitionMs) : null;

  const stageInfo = stagesMap[currentStage];
  // v3 verdict 可能是物件 { verdict: 'PASS'|'FAIL', severity: ... }，展平為字串
  const rawVerdict = stageInfo?.verdict;
  const verdictStr = (typeof rawVerdict === 'object' && rawVerdict !== null)
    ? (rawVerdict.verdict || null)
    : rawVerdict;
  const verdictIcon = verdictStr
    ? (verdictStr === 'PASS' ? '\u2705' : '\u274C')
    : '\u2753';

  // v3: retries 是 { stageId: count } 物件
  const retriesObj = state.retries || {};
  const retryCount = retriesObj[currentStage] || 0;
  const retryStr = (verdictStr && verdictStr !== 'PASS' && retryCount > 0)
    ? ` (retry ${retryCount}/3)`
    : '';

  // Agent 摘要
  let agentSummary = null;
  const transcriptPath = data.agent_transcript_path;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const { parseLastAssistantTurn } = require(
      path.join(__dirname, '..', 'lib', 'remote', 'transcript.js')
    );
    const turn = parseLastAssistantTurn(transcriptPath, { maxTextLen: 200 });
    agentSummary = turn.text;
  }

  const display = STAGES[currentStage];
  const progressBar = buildProgressBar(completedStages, stageResults, expectedStages);
  const allDone = expectedStages.length > 0 && expectedStages.every(s => completedStages.includes(s));

  let text;
  if (allDone) {
    const type = taskType || 'task';
    const allPass = expectedStages.every(s => {
      const r = stageResults[s];
      return !r || r.verdict !== 'FAIL';
    });
    // 總耗時：用 classifiedAt 作為 pipeline 起始（v3 存在 classification.classifiedAt）
    const startStr = classification.classifiedAt || null;
    const startMs = startStr ? new Date(startStr).getTime() : null;
    const totalDuration = startMs ? formatDuration(Date.now() - startMs) : null;
    const durationStr = totalDuration ? ` ${totalDuration}` : '';
    const resultIcon = allPass ? '\u2705' : '\u274C';

    text = `\u{1F389} Pipeline \u5B8C\u6210 ${resultIcon} (${type})${durationStr}\n${progressBar}`;
  } else {
    const durationStr = stageDuration ? ` ${stageDuration}` : '';
    const typeStr = taskType ? ` (${taskType})` : '';
    const summaryStr = agentSummary ? `\n  \u2192 ${agentSummary}` : '';

    text = `${display.emoji} ${currentStage} ${verdictIcon}${durationStr}${typeStr}${retryStr}${summaryStr}\n${progressBar}`;
  }

  await sendMessage(creds.token, creds.chatId, text);
}

// ─── receipt（Stop）─────────────

const SAY_PENDING_FILE = path.join(CLAUDE_DIR, 'remote-say-pending.json');
const THROTTLE_FILE = path.join(CLAUDE_DIR, 'remote-receipt-last.json');
const MAX_AGE = 10 * 60 * 1000;
const THROTTLE_MS = 10 * 1000;

function formatToolLine(tools) {
  const parts = [];
  for (const [key, emoji] of TOOL_EMOJI) {
    if (tools[key] > 0) parts.push(`${emoji}\u00D7${tools[key]}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

async function handleReceipt(data) {
  if (data.stop_hook_active) process.exit(0);

  const creds = getCredentials();
  if (!creds) process.exit(0);

  // 功能 A：/say 已讀回條
  if (fs.existsSync(SAY_PENDING_FILE)) {
    let pending;
    try {
      pending = JSON.parse(fs.readFileSync(SAY_PENDING_FILE, 'utf8'));
    } catch (_) {
      try { fs.unlinkSync(SAY_PENDING_FILE); } catch (_) {}
      process.exit(0);
    }

    if (Date.now() - pending.sentAt > MAX_AGE) {
      try { fs.unlinkSync(SAY_PENDING_FILE); } catch (_) {}
      process.exit(0);
    }

    try { fs.unlinkSync(SAY_PENDING_FILE); } catch (_) {}
    try {
      await editMessageText(creds.token, pending.chatId, pending.messageId, '\u2705 \u5B8C\u6210');
    } catch (_) {}
    return;
  }

  // 功能 B：回合摘要通知
  try {
    const last = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    if (Date.now() - last.t < THROTTLE_MS) process.exit(0);
  } catch (_) {}

  const transcriptPath = data.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const { parseLastAssistantTurn } = require(
    path.join(__dirname, '..', 'lib', 'remote', 'transcript.js')
  );
  const turn = parseLastAssistantTurn(transcriptPath, { toolStats: true });

  if (!turn.text && !turn.tools) process.exit(0);

  const sessionId = data.session_id || 'unknown';
  const toolCount = turn.tools
    ? Object.values(turn.tools).reduce((sum, n) => sum + n, 0)
    : 0;
  emit(EVENT_TYPES.TURN_SUMMARY, sessionId, { toolCount });

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

  try {
    fs.writeFileSync(THROTTLE_FILE, JSON.stringify({ t: Date.now() }));
  } catch (_) {}
}

// ─── 測試用 exports ─────────────

if (typeof module !== 'undefined') {
  module.exports = {
    buildProgressBar, formatDuration, formatToolLine,
    buildNotifyText, buildKeyboard, extractCompletedStages,
    STAGES, STAGE_ORDER, AGENT_TO_STAGE,
  };
}

// ─── Hook 模式：CLI 路由 ─────────────

if (require.main === module) {
  const subcommand = process.argv[2];
  if (!subcommand) process.exit(0);

  (async () => {
    try {
      const data = readStdin();
      switch (subcommand) {
        case 'autostart': await handleAutostart(); break;
        case 'prompt-forward': await handlePromptForward(data); break;
        case 'ask-intercept': await handleAskIntercept(data); break;
        case 'sender': await handleSender(data); break;
        case 'receipt': await handleReceipt(data); break;
        default: process.exit(0);
      }
    } catch (err) {
      hookLogger.error(`remote-hub:${subcommand}`, err);
    }
  })();
}
