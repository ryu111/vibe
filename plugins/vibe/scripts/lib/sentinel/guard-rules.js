#!/usr/bin/env node
/**
 * guard-rules.js — Pipeline Guard 規則模組（純函式）
 *
 * v1.0.43 重構：
 * - PLAN 階段允許 AskUserQuestion（供 planner 詢問需求澄清）
 * - 合併 delegationActive/cancelled 檢查到 evaluate()
 * - 移除無人消費的 ORCHESTRATOR_TOOLS
 *
 * @module sentinel/guard-rules
 */
'use strict';

const path = require('path');

// 非程式碼檔案副檔名（允許直接編輯）
const NON_CODE_EXTS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.cfg', '.ini', '.env', '.gitignore', '.dockerignore',
  '.csv', '.xml', '.html', '.css', '.svg',
]);

/**
 * 判斷檔案是否為非程式碼檔案
 * @param {string} filePath
 * @returns {boolean}
 */
function isNonCodeFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return NON_CODE_EXTS.has(ext);
}

/**
 * 評估工具使用是否允許
 *
 * 放行優先順序（短路）：
 * 1. pipeline 未初始化/未分類/非強制 → allow
 * 2. 委派已啟動（sub-agent 操作） → allow
 * 3. pipeline 已取消 → allow
 * 4. 工具特定規則
 *
 * @param {string} toolName - Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode
 * @param {object} toolInput - 工具輸入參數
 * @param {object} state - Pipeline state
 * @returns {{ decision: 'allow'|'block', reason?: string, message?: string }}
 */
function evaluate(toolName, toolInput, state) {
  // ── 前置放行條件（原本散在 pipeline-guard.js 的 4 個 if） ──
  if (!state) return { decision: 'allow' };
  if (!state.initialized) return { decision: 'allow' };
  if (!state.taskType) return { decision: 'allow' };
  if (!state.pipelineEnforced) return { decision: 'allow' };
  if (state.delegationActive) return { decision: 'allow' };
  if (state.cancelled) return { decision: 'allow' };

  // ── Write / Edit / NotebookEdit ──
  if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
    const filePath = toolInput?.file_path || '';
    if (isNonCodeFile(filePath)) return { decision: 'allow' };

    return {
      decision: 'block',
      reason: 'pipeline-enforced',
      message:
        `⛔ Pipeline 模式下禁止直接使用 ${toolName} 寫程式碼。\n` +
        `你是管理者（Orchestrator），不是執行者。\n` +
        `請使用 Task 工具委派給對應的 sub-agent：\n` +
        `  Task({ subagent_type: "vibe:developer", prompt: "..." })\n`,
    };
  }

  // ── AskUserQuestion ──
  if (toolName === 'AskUserQuestion') {
    // PLAN 階段允許 AskUserQuestion（planner 需要詢問需求澄清）
    const currentStage = state.currentStage || '';
    if (currentStage === 'PLAN') return { decision: 'allow' };

    return {
      decision: 'block',
      reason: 'pipeline-auto-mode',
      message:
        '⛔ Pipeline 自動模式：禁止使用 AskUserQuestion。\n' +
        'Pipeline 是全自動閉環流程，stage-transition 會指示下一步。\n' +
        '請直接按照 pipeline 指示執行下一階段。\n' +
        '如需退出 pipeline 自動模式，使用 /vibe:cancel。\n',
    };
  }

  // ── EnterPlanMode ──
  if (toolName === 'EnterPlanMode') {
    return {
      decision: 'block',
      reason: 'pipeline-active',
      message:
        `⛔ Pipeline 模式下禁止使用 EnterPlanMode。\n` +
        `Pipeline 有自己的 PLAN 階段，請改用：\n` +
        `  Task({ subagent_type: "vibe:planner", prompt: "..." })\n` +
        `或觸發 /vibe:scope skill。\n` +
        `\n` +
        `如需手動進入 Plan Mode，請先使用 /cancel 退出 pipeline 模式。\n`,
    };
  }

  // 未知工具
  return { decision: 'allow' };
}

module.exports = {
  evaluate,
  isNonCodeFile,
  NON_CODE_EXTS,
};
