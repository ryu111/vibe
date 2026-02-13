#!/usr/bin/env node
/**
 * bot.js — Telegram Bot Daemon
 *
 * 背景執行的 long polling daemon：
 * - 查詢類：/status /stages /ping /help（讀 state files）
 * - 控制類：/say（tmux send-keys 注入 Claude Code session）
 *
 * 生命週期：由 bot-manager.js 管理（start/stop）。
 * PID 檔：~/.claude/notify-bot.pid（全域）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { getCredentials, sendMessage, getUpdates } = require(path.join(__dirname, 'scripts', 'lib', 'telegram.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PID_FILE = path.join(CLAUDE_DIR, 'notify-bot.pid');
const LOG_FILE = path.join(CLAUDE_DIR, 'notify-bot.log');
const RETRY_DELAY = 5000;
const START_TIME = Date.now();

// Agent → Stage 映射（與 notify-sender.js 同步）
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
 * 優先順序：環境變數 → 進程掃描 → null
 */
function detectPane() {
  // 1. 環境變數（最可靠）
  if (process.env.CLAUDE_TMUX_PANE) {
    return process.env.CLAUDE_TMUX_PANE;
  }

  // 2. 掃描 tmux panes 找 claude 進程
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_id} #{pane_current_command}"', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    for (const line of output.split('\n')) {
      const [paneId, ...cmdParts] = line.split(' ');
      const cmd = cmdParts.join(' ').toLowerCase();
      if (cmd.includes('claude')) {
        return paneId;
      }
    }
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
  // 轉義雙引號和特殊字元
  const escaped = text.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  execSync(`tmux send-keys -t ${pane} "${escaped}" Enter`, {
    timeout: 5000,
  });
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
  return sendMessage(token, chatId, `\u{1F916} *Vibe Notify Bot*

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
    // 記錄到 log
    appendLog(`/say: ${text}`);
    return sendMessage(token, chatId, `\u2705 \u5DF2\u50B3\u9001\u5230 Claude Code\uFF08pane: ${pane}\uFF09`);
  } catch (err) {
    cachedPane = null; // 清除快取，下次重新偵測
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

// ─── Log ───────────────────────────────────────

function appendLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ─── 主迴圈 ────────────────────────────────────

async function main() {
  const creds = getCredentials();
  if (!creds) {
    process.stderr.write('notify-bot: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID \u672A\u8A2D\u5B9A\n');
    process.exit(1);
  }

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
            // 非指令訊息 → 視同 /say
            if (!text.startsWith('/')) {
              await handleSay(creds.token, creds.chatId, text);
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
