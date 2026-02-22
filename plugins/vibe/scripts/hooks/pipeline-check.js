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
const { SYSTEM_MARKER } = require(path.join(__dirname, '..', 'lib', 'flow', 'classifier.js'));

safeRun('pipeline-check', (data) => {
  // 防迴圈：允許最多 3 次重試（multi-stage pipeline 在 -p 模式需要多次 re-prompt）
  // stop_hook_active 表示已有 Stop hook 阻擋過一次，但我們用 blockCount 控制上限
  const sessionId = data.session_id || 'unknown';

  // Main Agent turn 結束（Dashboard agent-level 活躍信號）
  ctrl.setMainAgentIdle(sessionId);

  const result = ctrl.onSessionStop(sessionId);

  if (!result) process.exit(0);

  // Emit incomplete event
  emit(EVENT_TYPES.PIPELINE_INCOMPLETE, sessionId, {
    stopReason: result.stopReason,
  });

  // ECC Stop hook 標準格式：decision:"block" + reason
  // continue:false 在 -p 模式可能不被 honor，decision:"block" 更可靠
  // reason 作為下一個 prompt 送回 Claude，確保模型繼續委派
  // reason 前綴加入 SYSTEM_MARKER：ECC 把 reason 作為新 prompt 送回 Claude，
  // classifier 的 system-feedback heuristic 偵測到標記後直接 route 到 none，避免誤觸發 pipeline
  console.log(JSON.stringify({
    decision: 'block',
    reason: `${SYSTEM_MARKER}${result.systemMessage}`,
  }));
});
