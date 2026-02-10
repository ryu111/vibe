#!/usr/bin/env node
/**
 * stage-transition.js — SubagentStop hook
 *
 * Agent 完成後建議下一個 pipeline 階段。
 * 強度：強建議（systemMessage）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline, findNextStage } = require(path.join(__dirname, '..', 'lib', 'pipeline-discovery.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈：必須第一步檢查
    if (data.stop_hook_active) {
      process.exit(0);
    }

    const sessionId = data.session_id || 'unknown';
    const agentType = data.agent_type;

    if (!agentType) {
      process.exit(0);
    }

    // 動態發現 pipeline
    const pipeline = discoverPipeline();
    const currentStage = pipeline.agentToStage[agentType];

    // 不認識的 agent → 不處理
    if (!currentStage) {
      process.exit(0);
    }

    // 讀取 state file
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    let state = { completed: [], expectedStages: [] };
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 記錄完成的 agent
    if (!state.completed) state.completed = [];
    if (!state.completed.includes(agentType)) {
      state.completed.push(agentType);
    }
    state.lastTransition = new Date().toISOString();

    // 查找下一步
    const nextStage = findNextStage(pipeline.stageOrder, pipeline.stageMap, currentStage);
    const currentLabel = pipeline.stageLabels[currentStage] || currentStage;

    // 已完成階段列表
    const completedStages = [];
    for (const agent of state.completed) {
      const stage = pipeline.agentToStage[agent];
      if (stage && !completedStages.includes(stage)) {
        completedStages.push(stage);
      }
    }
    const completedStr = completedStages.join(' → ');

    let message;
    if (nextStage) {
      const nextLabel = pipeline.stageLabels[nextStage] || nextStage;
      const nextInfo = pipeline.stageMap[nextStage];
      const skillHint = nextInfo && nextInfo.skill ? `\n可使用 ${nextInfo.skill} 觸發。` : '';
      message = `[Pipeline] ${agentType} 已完成（${currentLabel}階段）。\n建議下一步：${nextStage}（${nextLabel}）${skillHint}\n已完成階段：${completedStr}`;
    } else {
      message = `[Pipeline] ${agentType} 已完成（${currentLabel}階段）。\n所有建議階段已完成：${completedStr}\n可以向使用者報告成果。`;
    }

    // 寫入 state file
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 輸出
    console.log(JSON.stringify({
      continue: true,
      systemMessage: message,
    }));
  } catch (err) {
    process.stderr.write(`stage-transition: ${err.message}\n`);
  }
});
