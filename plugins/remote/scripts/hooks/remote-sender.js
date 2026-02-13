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
const { parseLastAssistantTurn } = require(path.join(__dirname, '..', 'lib', 'transcript.js'));

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
  PLAN: { emoji: '\u{1F4CB}' },
  ARCH: { emoji: '\u{1F3D7}\uFE0F' },
  DEV: { emoji: '\u{1F4BB}' },
  REVIEW: { emoji: '\u{1F50D}' },
  TEST: { emoji: '\u{1F9EA}' },
  QA: { emoji: '\u2705' },
  E2E: { emoji: '\u{1F310}' },
  DOCS: { emoji: '\u{1F4DD}' },
};

const STAGE_ORDER = ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];

/**
 * 建立壓縮進度條：📋✅ 🏗️✅ 💻✅ 🔍❌ 🧪⬜ ✅⬜ 🌐⬜ 📝⬜
 */
function buildProgressBar(completedStages, stageResults, expectedStages) {
  const stages = expectedStages || STAGE_ORDER;
  return stages.map(stage => {
    const display = STAGE_DISPLAY[stage];
    if (!display) return stage;

    if (completedStages.includes(stage)) {
      const result = stageResults[stage];
      const icon = result && result.verdict === 'FAIL' ? '\u274C' : '\u2705';
      return `${display.emoji}${icon}`;
    }
    return `${display.emoji}\u2B1C`;
  }).join(' ');
}

/**
 * 格式化耗時：秒數 → "Nm" 或 "Nh Nm"
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return null;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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

    // 建立已完成 stage 列表
    const completedStages = [];
    for (const agent of (state.completed || [])) {
      const sn = agent.includes(':') ? agent.split(':')[1] : agent;
      const stage = AGENT_STAGE[sn];
      if (stage && !completedStages.includes(stage)) {
        completedStages.push(stage);
      }
    }

    const stageResults = state.stageResults || {};
    const result = stageResults[currentStage];
    const expectedStages = state.expectedStages || STAGE_ORDER;
    const taskType = state.taskType || null;

    // 計算 stage 耗時（上次轉換到現在）
    const lastTransition = state.lastTransition;
    const stageDuration = lastTransition ? formatDuration(Date.now() - lastTransition) : null;

    // Verdict 顯示
    const verdictIcon = result
      ? (result.verdict === 'PASS' ? '\u2705' : '\u274C')
      : '\u2753';

    // Retry 次數
    const retries = state.retries || 0;
    const retryStr = (result && result.verdict === 'FAIL' && retries > 0)
      ? ` (retry ${retries}/3)`
      : '';

    // Agent 摘要（從 transcript 提取）
    let agentSummary = null;
    const transcriptPath = data.agent_transcript_path;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const turn = parseLastAssistantTurn(transcriptPath, { maxTextLen: 200 });
      agentSummary = turn.text;
    }

    const display = STAGE_DISPLAY[currentStage];
    const progressBar = buildProgressBar(completedStages, stageResults, expectedStages);

    // 判斷是否全部完成
    const allDone = expectedStages.every(s => completedStages.includes(s));

    let text;
    if (allDone) {
      // Pipeline 全部完成
      const type = taskType || 'task';
      const allPass = expectedStages.every(s => {
        const r = stageResults[s];
        return !r || r.verdict !== 'FAIL';
      });
      // 總耗時（從 initialized 到現在）
      const initialized = state.initialized;
      const totalDuration = initialized ? formatDuration(Date.now() - initialized) : null;
      const durationStr = totalDuration ? ` ${totalDuration}` : '';
      const resultIcon = allPass ? '\u2705' : '\u274C';

      text = `\u{1F389} Pipeline \u5B8C\u6210 ${resultIcon} (${type})${durationStr}\n${progressBar}`;
    } else {
      // 單一 stage 完成
      const durationStr = stageDuration ? ` ${stageDuration}` : '';
      const typeStr = taskType ? ` (${taskType})` : '';
      const summaryStr = agentSummary ? `\n  \u2192 ${agentSummary}` : '';

      text = `${display.emoji} ${currentStage} ${verdictIcon}${durationStr}${typeStr}${retryStr}${summaryStr}\n${progressBar}`;
    }

    await sendMessage(creds.token, creds.chatId, text);
  } catch (err) {
    // 靜默退出，不影響主流程
    process.stderr.write(`remote-sender: ${err.message}\n`);
  }
});
