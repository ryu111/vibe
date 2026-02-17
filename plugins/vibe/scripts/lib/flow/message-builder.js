#!/usr/bin/env node
/**
 * message-builder.js — Pipeline systemMessage 組裝（純函式）
 *
 * v3.0.0：大部分邏輯移至 pipeline-controller.js。
 * 此模組保留為向後相容用途和 buildDelegationMethod()。
 *
 * @module flow/message-builder
 */
'use strict';

const { STAGE_CONTEXT, POST_STAGE_HINTS, OPENSPEC_CONTEXT } = require('../registry.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 組裝 agent 委派指令
 */
function buildDelegationMethod(stageInfo) {
  if (!stageInfo) return '（無法解析執行方法）';
  const prefix = stageInfo.plugin ? `${stageInfo.plugin}:` : '';
  if (stageInfo.skill) {
    return `使用 Skill 工具呼叫 ${stageInfo.skill}`;
  }
  return `使用 Task 工具委派給 ${prefix}${stageInfo.agent} agent（subagent_type: "${prefix}${stageInfo.agent}"）`;
}

/**
 * 組裝階段專屬 context
 */
function buildStageContext(nextStage, currentStage, state, isApiOnly) {
  const parts = [];

  if (nextStage === 'QA') parts.push(STAGE_CONTEXT.QA);
  else if (nextStage === 'E2E') parts.push(isApiOnly ? STAGE_CONTEXT.E2E_API : STAGE_CONTEXT.E2E_UI);

  if (state.openspecEnabled && OPENSPEC_CONTEXT[nextStage]) {
    parts.push(OPENSPEC_CONTEXT[nextStage]);
  }

  if (!state.openspecEnabled && nextStage === 'DEV') {
    try {
      if (fs.existsSync(path.join(process.cwd(), 'design-system', 'MASTER.md'))) {
        parts.push('🎨 前端實作請參考 design-system/MASTER.md');
      }
    } catch (_) {}
  }

  const postHint = POST_STAGE_HINTS[currentStage];
  if (postHint) {
    const designSkipped = state.skippedStages?.includes?.('DESIGN');
    if (!(currentStage === 'ARCH' && designSkipped)) parts.push(postHint);
  }

  return parts.length > 0 ? '\n' + parts.join('\n') : '';
}

// v3 保留最小向後相容 API
function buildRetryMessage({ currentStage, verdict, retryCount, maxRetries, devMethod }) {
  return `🔄 ${currentStage} FAIL:${verdict?.severity}（${retryCount}/${maxRetries}）\n➡️ ${devMethod}`;
}

function buildNoDevRetryMessage({ currentStage, verdict }) {
  return `⚠️ ${currentStage} FAIL:${verdict?.severity}，無 DEV 可回退。強制繼續。`;
}

function buildRetryVerifyMessage({ retryTarget, retryRound, retryMethod }) {
  return `🔄 DEV 修復完成（第 ${retryRound} 輪）→ 重跑 ${retryTarget}\n➡️ ${retryMethod}`;
}

function buildAdvanceMessage({ nextStage, method, stageContext }) {
  return `✅ → ${nextStage}\n➡️ ${method}${stageContext || ''}`;
}

function buildCompleteMessage({ completedStr }) {
  return `✅ Pipeline 完成！已完成：${completedStr}\n📌 執行 /vibe:verify + AskUserQuestion`;
}

module.exports = {
  buildDelegationMethod,
  buildStageContext,
  buildRetryMessage,
  buildNoDevRetryMessage,
  buildRetryVerifyMessage,
  buildAdvanceMessage,
  buildCompleteMessage,
};
