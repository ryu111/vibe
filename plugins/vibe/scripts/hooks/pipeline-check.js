#!/usr/bin/env node
/**
 * pipeline-check.js — Stop hook
 *
 * v1.0.43 重構：從軟提醒（systemMessage）升級為硬阻擋（decision: "block"）。
 * Pipeline 閉環保障 — 遺漏的階段會強制 Claude 繼續執行。
 *
 * 行為：
 * - pipelineEnforced=true 且有遺漏階段 → decision: "block"（強制繼續）
 * - 全部完成 → 清理 state file
 * - 非強制 pipeline → 不檢查
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { PIPELINES } = require(path.join(__dirname, '..', 'lib', 'registry.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) process.exit(0);

    const sessionId = data.session_id || 'unknown';
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    if (!fs.existsSync(statePath)) process.exit(0);

    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { process.exit(0); }

    if (!state.expectedStages || state.expectedStages.length === 0) process.exit(0);
    if (!state.pipelineEnforced) process.exit(0);

    // 動態發現 pipeline
    const pipeline = discoverPipeline();

    // 已完成的 stages
    const completedStages = [];
    for (const agent of (state.completed || [])) {
      const stage = pipeline.agentToStage[agent];
      if (stage && !completedStages.includes(stage)) completedStages.push(stage);
    }

    // 比較期望 vs 已完成（排除已跳過的階段）
    const skipped = state.skippedStages || [];
    const pipelineId = state.pipelineId || null;
    const pipelineStages = (pipelineId && PIPELINES[pipelineId])
      ? PIPELINES[pipelineId].stages : state.expectedStages;

    let missing = [];
    if (pipelineId && PIPELINES[pipelineId]) {
      const stageIndex = state.stageIndex;
      if (typeof stageIndex === 'number' && stageIndex >= 0) {
        if (stageIndex < pipelineStages.length - 1) {
          missing = pipelineStages.slice(stageIndex + 1).filter(s =>
            pipeline.stageMap[s] && !skipped.includes(s)
          );
        }
      } else {
        missing = pipelineStages.filter(s =>
          pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
        );
      }
    } else {
      missing = state.expectedStages.filter(s =>
        pipeline.stageMap[s] && !completedStages.includes(s) && !skipped.includes(s)
      );
    }

    // pendingRetry 優先：回退重驗的目標階段必須先完成
    if (state.pendingRetry && state.pendingRetry.stage) {
      const retryTarget = state.pendingRetry.stage;
      // 確保 retryTarget 在 missing 最前面
      if (!missing.includes(retryTarget)) {
        missing.unshift(retryTarget);
      } else {
        // 移到最前面（優先提示）
        missing = missing.filter(s => s !== retryTarget);
        missing.unshift(retryTarget);
      }
    }

    if (missing.length === 0) {
      // 全部完成 → 清理 state file
      try { fs.unlinkSync(statePath); } catch (_) {}
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

    // ★ 硬阻擋：decision: "block" 強制 Claude 繼續完成遺漏階段
    console.log(JSON.stringify({
      decision: 'block',
      reason: `🚫 [Pipeline 未完成] 缺：${missingLabels}\n${missingHints}\n已完成：${completedStr}\n\n請立即委派下一個遺漏的階段。Pipeline 是閉環流程，必須跑完所有階段才能結束。`,
    }));
  } catch (err) {
    hookLogger.error('pipeline-check', err);
  }
});
