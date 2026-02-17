#!/usr/bin/env node
/**
 * delegation-tracker.js — PreToolUse hook (matcher: Task)
 *
 * v3.0.0 重構：精簡為 controller.onDelegate() 代理。
 */
'use strict';
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ctrl = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-controller.js'));

safeRun('delegation-tracker', (data) => {
  const sessionId = data.session_id || 'unknown';
  const toolInput = data.tool_input || {};
  const agentType = toolInput.subagent_type || '';

  const result = ctrl.onDelegate(sessionId, agentType, toolInput);

  // Emit events
  const shortAgent = result.shortAgent || (agentType.includes(':') ? agentType.split(':')[1] : agentType);
  const stage = result.stage || '';

  if (stage) {
    emit(EVENT_TYPES.STAGE_START, sessionId, { stage, agentType: shortAgent });
  }
  emit(EVENT_TYPES.DELEGATION_START, sessionId, {
    agentType: shortAgent,
    stage,
    description: (toolInput.description || '').slice(0, 60),
    promptPreview: (toolInput.prompt || '').slice(0, 120),
  });

  if (!result.allow) {
    process.stderr.write(result.message || '⛔ 委派被阻擋。\n');
    process.exit(2);
  }

  process.exit(0); // 永遠放行（除非被 pendingRetry 阻擋）
});
