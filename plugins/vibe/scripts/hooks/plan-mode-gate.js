#!/usr/bin/env node
/**
 * plan-mode-gate.js — PreToolUse hook (matcher: EnterPlanMode)
 *
 * Pipeline 模式下，阻擋 Main Agent 使用 Claude 內建的 EnterPlanMode。
 * Pipeline 有自己的 PLAN 階段（vibe:planner / /vibe:scope），
 * 內建 Plan Mode 會繞過整個 pipeline 委派機制。
 *
 * 放行條件：
 * - 無 pipeline state → 放行
 * - pipelineEnforced = false → 放行
 *
 * 阻擋條件：
 * - pipelineEnforced = true → exit 2
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (!fs.existsSync(statePath)) {
      process.exit(0);
    }

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    if (!state.initialized || !state.pipelineEnforced) {
      process.exit(0);
    }

    // ⛔ 阻擋：Pipeline 模式下禁止使用內建 Plan Mode
    process.stderr.write(
      `⛔ Pipeline 模式下禁止使用 EnterPlanMode。\n` +
      `Pipeline 有自己的 PLAN 階段，請改用：\n` +
      `  Task({ subagent_type: "vibe:planner", prompt: "..." })\n` +
      `或觸發 /vibe:scope skill。\n` +
      `\n` +
      `如需手動進入 Plan Mode，請先使用 /cancel 退出 pipeline 模式。\n`
    );
    process.exit(2);
  } catch (err) {
    hookLogger.error('plan-mode-gate', err);
  }
});
