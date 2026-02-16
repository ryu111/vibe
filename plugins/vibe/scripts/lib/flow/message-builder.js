#!/usr/bin/env node
/**
 * message-builder.js — Pipeline systemMessage 組裝（純函式）
 *
 * 將 stage-transition 的三種訊息（前進/回退/重驗/完成）
 * 從邏輯中抽離，改為純資料組裝。
 *
 * @module flow/message-builder
 */
'use strict';

const { STAGE_CONTEXT, POST_STAGE_HINTS, OPENSPEC_CONTEXT } = require('../registry.js');
const fs = require('fs');
const path = require('path');

/**
 * 組裝 agent 委派指令
 * @param {Object} stageInfo - stageMap 中的階段資訊
 * @returns {string} 執行方法描述
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
 * 組裝階段專屬 context（QA/E2E 提示 + OpenSpec + 設計系統 + POST_STAGE_HINTS）
 */
function buildStageContext(nextStage, currentStage, state, isApiOnly) {
  const parts = [];

  // QA/E2E 專屬 context
  if (nextStage === 'QA') {
    parts.push(STAGE_CONTEXT.QA);
  } else if (nextStage === 'E2E') {
    parts.push(isApiOnly ? STAGE_CONTEXT.E2E_API : STAGE_CONTEXT.E2E_UI);
  }

  // OpenSpec 上下文
  if (state.openspecEnabled && OPENSPEC_CONTEXT[nextStage]) {
    parts.push(OPENSPEC_CONTEXT[nextStage]);
  }

  // 非 OpenSpec 模式下的設計系統 context（DEV 階段）
  if (!state.openspecEnabled && nextStage === 'DEV') {
    try {
      const cwd = process.cwd();
      if (fs.existsSync(path.join(cwd, 'design-system', 'MASTER.md'))) {
        parts.push('🎨 前端實作請參考 design-system/MASTER.md，確保色彩(hex)、字體(Google Fonts)、間距(spacing tokens) 與設計系統一致。');
      }
    } catch (_) {}
  }

  // 前一階段完成後的附加提示
  const postHint = POST_STAGE_HINTS[currentStage];
  if (postHint) {
    // ARCH 完成時，若 DESIGN 被跳過，不提示 DESIGN 階段
    const designSkipped = state.skippedStages && state.skippedStages.includes('DESIGN');
    if (!(currentStage === 'ARCH' && designSkipped)) {
      parts.push(postHint);
    }
  }

  return parts.length > 0 ? '\n' + parts.join('\n') : '';
}

/**
 * 組裝回退訊息
 */
function buildRetryMessage({ currentStage, verdict, retryCount, maxRetries, devMethod, completedStr }) {
  return `🔄 [Pipeline 回退] ${currentStage} FAIL:${verdict.severity}（${retryCount}/${maxRetries}）
回退原因：${verdict.severity} 等級問題需要修復
執行：${devMethod}
修復後 stage-transition 會指示重跑 ${currentStage}。禁止 AskUserQuestion。
已完成：${completedStr}`;
}

/**
 * 組裝無法回退訊息（pipeline 不含 DEV）
 */
function buildNoDevRetryMessage({ currentStage, verdict, completedStr }) {
  return `⛔ [Pipeline 無法回退] ${currentStage} FAIL:${verdict.severity}，但 pipeline 不含 DEV 階段，無法回退。強制繼續。
已完成：${completedStr}`;
}

/**
 * 組裝回退重驗訊息
 */
function buildRetryVerifyMessage({ retryTarget, retryRound, retryMethod, completedStr, retryLabel }) {
  return `🔄 [回退重驗] DEV 修復完成（第 ${retryRound} 輪）→ 重跑 ${retryTarget}（${retryLabel}）
執行：${retryMethod}
不可跳過，不可跳到其他階段。禁止 AskUserQuestion。
已完成：${completedStr}`;
}

/**
 * 組裝正常前進訊息
 */
function buildAdvanceMessage({ agentType, nextStage, nextLabel, method, stageContext, skipNote, forcedNote, completedStr }) {
  return `⛔ [Pipeline] ${agentType}✅ → ${nextStage}（${nextLabel}）${forcedNote}
➡️ 執行方法：${method}${stageContext}${skipNote}
禁止 AskUserQuestion。已完成：${completedStr}`;
}

/**
 * 組裝 pipeline 完成訊息
 */
function buildCompleteMessage({ agentType, currentLabel, completedStr, forcedNote, skipNote }) {
  return `✅ [Pipeline 完成] ${agentType} 已完成（${currentLabel}階段）。${forcedNote}${skipNote}
所有階段已完成：${completedStr}

📌 Pipeline 後續動作（依序執行）：
1️⃣ 執行 /vibe:verify 進行最終綜合驗證（Build → Types → Lint → Tests → Git 狀態）
2️⃣ 向使用者報告成果摘要
3️⃣ 使用 AskUserQuestion（multiSelect: true）提供後續選項，建議包含：
   - 提交並推送（commit + push）
   - 覆蓋率分析（/vibe:coverage）
   - 安全掃描（/vibe:security）
   - 知識進化（/vibe:evolve — 將此 session 產生的經驗進化為可重用組件）

⚠️ Pipeline 已解除自動模式，現在可以使用 AskUserQuestion。
💡 自動分類提示：每個選項的 description 中加入 [pipeline:xxx] 標籤可幫助自動分類。
   例如：description: "執行覆蓋率分析 [pipeline:none]"、description: "安全掃描 [pipeline:security]"`;
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
