#!/usr/bin/env node
/**
 * pipeline-check.js — Stop hook
 *
 * 結束前檢查是否有遺漏的 pipeline 階段。
 * 強度：強建議（systemMessage）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) {
      process.exit(0);
    }

    const sessionId = data.session_id || 'unknown';
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    // 沒有 state file → 沒有進行中的 pipeline
    if (!fs.existsSync(statePath)) {
      process.exit(0);
    }

    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (_) {
      process.exit(0);
    }

    if (!state.expectedStages || state.expectedStages.length === 0) {
      process.exit(0);
    }

    // 非強制 pipeline 任務不檢查（flag 由 task-classifier 設定）
    if (!state.pipelineEnforced) {
      process.exit(0);
    }

    // 動態發現 pipeline
    const pipeline = discoverPipeline();

    // 已完成的 stages
    const completedStages = [];
    for (const agent of (state.completed || [])) {
      const stage = pipeline.agentToStage[agent];
      if (stage && !completedStages.includes(stage)) {
        completedStages.push(stage);
      }
    }

    // 比較期望 vs 已完成
    const missing = state.expectedStages.filter(s =>
      pipeline.stageMap[s] && !completedStages.includes(s)
    );

    if (missing.length === 0) {
      // 全部完成或無遺漏 → 清理 state file
      try { fs.unlinkSync(statePath); } catch (_) {}
      process.exit(0);
    }

    // 有遺漏 → systemMessage 提醒
    const missingLabels = missing.map(s =>
      `${s}（${pipeline.stageLabels[s] || s}）`
    ).join(', ');
    const completedStr = completedStages.length > 0
      ? completedStages.join(' → ')
      : '（無）';

    // 建立遺漏階段的執行指引
    const missingHints = missing.map(s => {
      const info = pipeline.stageMap[s];
      const label = pipeline.stageLabels[s] || s;
      const prefix = info && info.plugin ? `${info.plugin}:` : '';
      if (info && info.skill) return `- ${label}：執行 ${info.skill}`;
      if (info && info.agent) return `- ${label}：委派給 ${prefix}${info.agent}（subagent_type: "${prefix}${info.agent}"）`;
      return `- ${label}`;
    }).join('\n');

    console.log(JSON.stringify({
      continue: true,
      systemMessage: `🚫 [Pipeline 未完成] 以下階段尚未執行：${missingLabels}\n已完成：${completedStr}\n\n你必須先完成這些階段：\n${missingHints}\n\n如果使用者明確要求跳過，請告知使用者跳過了哪些階段及其風險。`,
    }));
  } catch (err) {
    hookLogger.error('pipeline-check', err);
  }
});
