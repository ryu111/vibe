#!/usr/bin/env node
/**
 * pipeline-guard.js — PreToolUse hook (matcher: *)
 *
 * v3.0.0 重構：精簡為 controller.canProceed() 代理。
 */
'use strict';
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ctrl = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-controller.js'));

safeRun('pipeline-guard', (data) => {
  const sessionId = data.session_id || 'unknown';
  const toolName = data.tool_name || 'Unknown';
  const toolInput = data.tool_input || {};

  const result = ctrl.canProceed(sessionId, toolName, toolInput);

  if (result.decision === 'allow') process.exit(0);

  // block → timeline + stderr + exit 2
  emit(EVENT_TYPES.TOOL_BLOCKED, sessionId, {
    tool: toolName,
    reason: result.reason || 'pipeline-guard',
    matchedPattern: result.matchedPattern,
  });

  process.stderr.write(result.message || '⛔ Pipeline 模式下禁止此操作。\n');
  process.exit(2);
});
