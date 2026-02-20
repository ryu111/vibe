#!/usr/bin/env node
/**
 * stage-transition.js — SubagentStop hook
 *
 * v3.0.0 重構：精簡為 controller.onStageComplete() 代理。
 * 核心邏輯（DAG 解析、並行排程、回退）移至 pipeline-controller.js。
 */
'use strict';
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ctrl = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-controller.js'));
const { AGENT_TO_STAGE } = require(path.join(__dirname, '..', 'lib', 'registry.js'));

safeRun('stage-transition', (data) => {
  // 防迴圈
  if (data.stop_hook_active) process.exit(0);

  const sessionId = data.session_id || 'unknown';
  const agentType = data.agent_type;
  const transcriptPath = data.agent_transcript_path;

  if (!agentType) process.exit(0);

  const lastMessage = data.last_assistant_message || '';
  const result = ctrl.onStageComplete(sessionId, agentType, transcriptPath, lastMessage);

  if (!result.systemMessage) process.exit(0);

  // pipeline-architect 完成不是 stage 完成，跳過 stage.complete 事件
  const shortAgent = agentType.replace(/^vibe:/, '');
  if (shortAgent !== 'pipeline-architect') {
    const stage = AGENT_TO_STAGE[shortAgent] || shortAgent;
    emit(EVENT_TYPES.STAGE_COMPLETE, sessionId, {
      agentType,
      stage,
      message: result.systemMessage.slice(0, 200),
    });
  }

  console.log(JSON.stringify({
    continue: true,
    systemMessage: result.systemMessage,
  }));
});
