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

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { NAMESPACED_AGENT_TO_STAGE } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
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

    // Extract agent info from Task tool input
    const toolInput = data.tool_input || {};
    const agentType = toolInput.subagent_type || '';
    const shortAgent = agentType.includes(':') ? agentType.split(':')[1] : agentType;
    const stage = NAMESPACED_AGENT_TO_STAGE[shortAgent] || '';

    // Emit delegation event
    emit(EVENT_TYPES.DELEGATION_START, sessionId, {
      agentType: shortAgent,
      stage,
    });

    process.exit(0); // 永遠放行 Task
  } catch (err) {
    hookLogger.error('delegation-tracker', err);
  }
});
