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
      const skillCmd = nextInfo && nextInfo.skill ? nextInfo.skill : null;
      const agentName = nextInfo && nextInfo.agent ? nextInfo.agent : null;

      const method = skillCmd
        ? `➡️ 執行方法：使用 Skill 工具呼叫 ${skillCmd}`
        : `➡️ 執行方法：使用 Task 工具委派給 ${agentName} agent（subagent_type: "${agentName}"）`;

      message = `⚠️ [Pipeline 指令] ${agentType} 已完成（${currentLabel}階段）。
你**必須立即**執行下一階段：${nextStage}（${nextLabel}）。
${method}
這是 Pipeline 流程的必要步驟，不可跳過。
⛔ Pipeline 自動模式：不要使用 AskUserQuestion，完成後直接進入下一階段。
已完成：${completedStr}`;
    } else {
      message = `✅ [Pipeline 完成] ${agentType} 已完成（${currentLabel}階段）。\n所有階段已完成：${completedStr}\n向使用者報告成果。`;
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
