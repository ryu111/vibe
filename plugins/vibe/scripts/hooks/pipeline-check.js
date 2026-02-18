#!/usr/bin/env node
/**
 * pipeline-check.js — Stop hook
 *
 * v3.0.0 重構：精簡為 controller.onSessionStop() 代理。
 */
'use strict';
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ctrl = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-controller.js'));

safeRun('pipeline-check', (data) => {
  // 防迴圈：允許最多 3 次重試（multi-stage pipeline 在 -p 模式需要多次 re-prompt）
  // stop_hook_active 表示已有 Stop hook 阻擋過一次，但我們用 blockCount 控制上限
  const sessionId = data.session_id || 'unknown';

  const result = ctrl.onSessionStop(sessionId);

  if (!result) process.exit(0);

  // Emit incomplete event
  emit(EVENT_TYPES.PIPELINE_INCOMPLETE, sessionId, {
    stopReason: result.stopReason,
  });

  console.log(JSON.stringify({
    continue: result.continue,
    stopReason: result.stopReason,
    systemMessage: result.systemMessage,
  }));
});
