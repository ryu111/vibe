#!/usr/bin/env node
/**
 * pipeline-check.js — Stop hook
 *
 * v2.0.0 FSM 重構：
 * - 使用 state-machine 衍生查詢判斷完成狀態
 * - COMPLETE phase → 清理 state file
 * - enforced phase + 有遺漏 → decision: "block" 硬阻擋
 */
'use strict';
const path = require('path');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { PIPELINES } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const {
  readState,
  getPhase, isEnforced, isComplete,
  getPipelineId, getExpectedStages,
  getCompletedAgents, getSkippedStages,
  getStageIndex, getPendingRetry,
  PHASES,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) process.exit(0);

    const sessionId = data.session_id || 'unknown';
    const state = readState(sessionId);
    if (!state) process.exit(0);

    // 無 pipeline 或未強制 → 不檢查
    const expectedStages = getExpectedStages(state);
    if (expectedStages.length === 0) process.exit(0);
    if (!isEnforced(state) && !isComplete(state)) process.exit(0);

    // COMPLETE → state 保留（供 Dashboard/驗證/事後分析），由 session-cleanup 3 天後過期清理
    if (isComplete(state)) {
      process.exit(0);
    }

    // 動態發現 pipeline
    const pipeline = discoverPipeline();

    // 已完成的 stages
    const completedAgents = getCompletedAgents(state);
    const completedStages = [];
    for (const agent of completedAgents) {
      const stage = pipeline.agentToStage[agent];
      if (stage && !completedStages.includes(stage)) completedStages.push(stage);
    }

    // 比較期望 vs 已完成（排除已跳過的階段）
    const skipped = getSkippedStages(state);
    const pipelineId = getPipelineId(state);
    const pipelineStages = (pipelineId && PIPELINES[pipelineId])
      ? PIPELINES[pipelineId].stages : expectedStages;

    let missing = [];
    if (pipelineId && PIPELINES[pipelineId]) {
      const stageIndex = getStageIndex(state);
      if (typeof stageIndex === 'number' && stageIndex >= 0) {
        // stageIndex=0 + completedAgents=[] → 尚未開始，所有階段都 missing
        // stageIndex=N + completedAgents=[...] → 從 N+1 開始算 missing
        const hasProgress = completedAgents.length > 0;
        const startFrom = hasProgress ? stageIndex + 1 : stageIndex;
        if (startFrom < pipelineStages.length) {
          missing = pipelineStages.slice(startFrom).filter(s =>
            pipeline.stageMap[s] && !skipped.includes(s)
          );
        }
      } else {
        missing = pipelineStages.filter(s =>
          pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
        );
      }
    } else {
      missing = expectedStages.filter(s =>
        pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
      );
    }

    // pendingRetry 優先
    const pendingRetry = getPendingRetry(state);
    if (pendingRetry && pendingRetry.stage) {
      const retryTarget = pendingRetry.stage;
      if (!missing.includes(retryTarget)) {
        missing.unshift(retryTarget);
      } else {
        missing = missing.filter(s => s !== retryTarget);
        missing.unshift(retryTarget);
      }
    }

    if (missing.length === 0) {
      process.exit(0);
    }

    // Emit pipeline incomplete
    emit(EVENT_TYPES.PIPELINE_INCOMPLETE, sessionId, { missingStages: missing, completedStages });

    // 建立遺漏階段的執行指引
    const missingLabels = missing.map(s => `${s}（${pipeline.stageLabels[s] || s}）`).join(', ');
    const completedStr = completedStages.length > 0 ? completedStages.join(' → ') : '（無）';
    const missingHints = missing.map(s => {
      const info = pipeline.stageMap[s];
      const label = pipeline.stageLabels[s] || s;
      const prefix = info && info.plugin ? `${info.plugin}:` : '';
      if (info && info.skill) return `- ${label}：執行 ${info.skill}`;
      if (info && info.agent) return `- ${label}：委派給 ${prefix}${info.agent}（subagent_type: "${prefix}${info.agent}"）`;
      return `- ${label}`;
    }).join('\n');

    console.log(JSON.stringify({
      decision: 'block',
      reason: `🚫 [Pipeline 未完成] 缺：${missingLabels}\n${missingHints}\n已完成：${completedStr}\n\n請立即委派下一個遺漏的階段。Pipeline 是閉環流程，必須跑完所有階段才能結束。`,
    }));
  } catch (err) {
    hookLogger.error('pipeline-check', err);
  }
});
