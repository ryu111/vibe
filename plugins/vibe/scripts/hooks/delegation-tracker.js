#!/usr/bin/env node
/**
 * delegation-tracker.js — PreToolUse hook (matcher: Task)
 *
 * v2.0.0 FSM 重構：
 * 使用 transition(DELEGATE) 取代 state.delegationActive = true。
 * phase 從 CLASSIFIED/RETRYING/IDLE → DELEGATING。
 */
'use strict';
const path = require('path');

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { AGENT_TO_STAGE } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const {
  transition, readState, writeState, getPhase, PHASES,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    const state = readState(sessionId);
    if (!state) process.exit(0);

    // Extract agent info from Task tool input
    const toolInput = data.tool_input || {};
    const agentType = toolInput.subagent_type || '';
    const shortAgent = agentType.includes(':') ? agentType.split(':')[1] : agentType;
    const stage = AGENT_TO_STAGE[shortAgent] || '';

    // Transition: CLASSIFIED/RETRYING/IDLE → DELEGATING
    const phase = getPhase(state);
    if (phase === PHASES.CLASSIFIED || phase === PHASES.RETRYING || phase === PHASES.IDLE) {
      try {
        const newState = transition(state, { type: 'DELEGATE', stage, agentType: shortAgent });
        writeState(sessionId, newState);
      } catch (err) {
        // 不合法轉換不阻擋 Task 工具，只記錄
        hookLogger.error('delegation-tracker', err);
      }
    }

    // Emit stage start + delegation event
    if (stage) {
      emit(EVENT_TYPES.STAGE_START, sessionId, {
        stage,
        agentType: shortAgent,
      });
    }
    emit(EVENT_TYPES.DELEGATION_START, sessionId, {
      agentType: shortAgent,
      stage,
      description: (toolInput.description || '').slice(0, 60),
      promptPreview: (toolInput.prompt || '').slice(0, 120),
    });

    process.exit(0); // 永遠放行 Task
  } catch (err) {
    hookLogger.error('delegation-tracker', err);
  }
});
