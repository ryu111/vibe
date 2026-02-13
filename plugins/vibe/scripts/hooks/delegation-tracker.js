#!/usr/bin/env node
/**
 * delegation-tracker.js — PreToolUse hook (matcher: Task)
 *
 * 當 Main Agent 呼叫 Task 工具時，標記 pipeline state 的 delegationActive = true。
 * 這允許 dev-gate 放行後續 sub-agent 的 Write/Edit 操作。
 *
 * 因為 plugin hooks 會同時攔截 sub-agent 的 tool calls，
 * 所以需要這個追蹤機制來區分 Main Agent 和 Sub-agent 的操作。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

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

    // 標記委派啟動
    state.delegationActive = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    process.exit(0); // 永遠放行 Task
  } catch (err) {
    process.exit(0);
  }
});
