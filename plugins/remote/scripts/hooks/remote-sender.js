#!/usr/bin/env node
/**
 * remote-sender.js — SubagentStop hook
 *
 * Pipeline stage 完成時推播 Telegram 通知。
 * 讀取 pipeline-state file → 格式化進度條 → sendMessage。
 * 靜默退出：credentials 缺、state 缺、錯誤全部 exit 0。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getCredentials, sendMessage } = require(path.join(__dirname, '..', 'lib', 'telegram.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Agent → Stage 硬編碼映射（零依賴，不 import flow 的 lib）
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

// Stage 顯示配置
const STAGE_DISPLAY = {
  PLAN: { emoji: '\u{1F4CB}', label: '\u898F\u5283' },
  ARCH: { emoji: '\u{1F3D7}\uFE0F', label: '\u67B6\u69CB' },
  DEV: { emoji: '\u{1F4BB}', label: '\u958B\u767C' },
  REVIEW: { emoji: '\u{1F50D}', label: '\u5BE9\u67E5' },
  TEST: { emoji: '\u{1F9EA}', label: '\u6E2C\u8A66' },
  QA: { emoji: '\u2705', label: 'QA' },
  E2E: { emoji: '\u{1F310}', label: 'E2E' },
  DOCS: { emoji: '\u{1F4DD}', label: '\u6587\u4EF6' },
};

const STAGE_ORDER = ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];

/**
 * 建立進度條字串
 * @param {string} currentStage
 * @param {Array} completedStages
 * @param {object} stageResults
 * @returns {string}
 */
function buildProgressBar(currentStage, completedStages, stageResults) {
  return STAGE_ORDER.map(stage => {
    const display = STAGE_DISPLAY[stage];
    if (!display) return stage;

    if (completedStages.includes(stage)) {
      const result = stageResults[stage];
      const icon = result && result.verdict === 'FAIL' ? '\u274C' : '\u2705';
      return `${display.emoji} ${icon}`;
    }
    if (stage === currentStage) {
      return `${display.emoji} \u23F3`;
    }
    return `${display.emoji} \u2B1C`;
  }).join(' \u2192 ');
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈：必須第一步檢查
    if (data.stop_hook_active) {
      process.exit(0);
    }

    // 檢查 credentials
    const creds = getCredentials();
    if (!creds) process.exit(0);

    const sessionId = data.session_id || 'unknown';
    const agentType = data.agent_type;

    if (!agentType) process.exit(0);

    // 只處理 pipeline agent（agentType 可能是 "flow:architect" 或 "architect"）
    const shortName = agentType.includes(':') ? agentType.split(':')[1] : agentType;
    const currentStage = AGENT_STAGE[shortName];
    if (!currentStage) process.exit(0);

    // 讀取 pipeline-state file
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (!fs.existsSync(statePath)) process.exit(0);

    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (_) {
      process.exit(0);
    }

    // 建立已完成 stage 列表（agent 名稱可能是 "flow:planner" 或 "planner"）
    const completedStages = [];
    for (const agent of (state.completed || [])) {
      const shortName = agent.includes(':') ? agent.split(':')[1] : agent;
      const stage = AGENT_STAGE[shortName];
      if (stage && !completedStages.includes(stage)) {
        completedStages.push(stage);
      }
    }

    const stageResults = state.stageResults || {};
    const result = stageResults[currentStage];
    const verdictStr = result
      ? (result.verdict === 'PASS' ? '\u2705 PASS' : `\u274C FAIL${result.severity ? ':' + result.severity : ''}`)
      : '\u2753';

    const display = STAGE_DISPLAY[currentStage];
    const progressBar = buildProgressBar(currentStage, completedStages, stageResults);
    const shortSession = sessionId.slice(0, 8);

    // 判斷是否全部完成
    const expectedStages = state.expectedStages || STAGE_ORDER;
    const allDone = expectedStages.every(s => completedStages.includes(s));

    let text;
    if (allDone) {
      // Pipeline 全部完成
      const taskType = state.taskType || 'task';
      const allPass = expectedStages.every(s => {
        const r = stageResults[s];
        return !r || r.verdict !== 'FAIL';
      });
      text = `\u{1F389} *Pipeline \u5B8C\u6210*
\u4EFB\u52D9\uFF1A${taskType} | \u7D50\u679C\uFF1A${allPass ? '\u2705 PASS' : '\u274C \u6709\u554F\u984C'}
${progressBar}
Session: \`${shortSession}\``;
    } else {
      // 單一 stage 完成
      text = `${display.emoji} *${agentType}* \u5B8C\u6210\uFF08${currentStage}\uFF09
\u7D50\u679C\uFF1A${verdictStr}
\u9032\u5EA6\uFF1A${progressBar}
Session: \`${shortSession}\``;
    }

    await sendMessage(creds.token, creds.chatId, text);
  } catch (err) {
    // 靜默退出，不影響主流程
    process.stderr.write(`remote-sender: ${err.message}\n`);
  }
});
