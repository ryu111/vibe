/**
 * guard-rules.js — Pipeline Guard 規則模組（純函式）
 *
 * 統一管理 Pipeline 模式下對 Main Agent 的工具使用限制。
 * 不讀取 state file，僅提供決策邏輯。
 *
 * 匯出函式：
 * - evaluate(toolName, toolInput, state) → { decision, reason?, message? }
 * - isNonCodeFile(filePath) → boolean
 *
 * 匯出常數：
 * - ORCHESTRATOR_TOOLS（允許 Main Agent 使用的白名單工具）
 * - NON_CODE_EXTS（非程式碼檔案副檔名）
 */
'use strict';

const path = require('path');

// 白名單：Main Agent 允許使用的 orchestrator 工具
const ORCHESTRATOR_TOOLS = new Set([
  'Task', 'Skill', 'Read', 'Grep', 'Glob',
  'WebFetch', 'WebSearch',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'TodoRead', 'TodoWrite',
]);

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
 * @param {string} toolName - 工具名稱（Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode）
 * @param {object} toolInput - 工具輸入參數
 * @param {object} state - Pipeline state（由 hook 傳入）
 * @returns {{ decision: 'allow'|'block', reason?: string, message?: string }}
 */
function evaluate(toolName, toolInput, state) {
  // Write / Edit / NotebookEdit
  if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
    // 檢查檔案路徑 — 非程式碼檔案放行
    const filePath = toolInput?.file_path || '';
    if (isNonCodeFile(filePath)) {
      return { decision: 'allow' };
    }

    // 程式碼檔案需委派給 developer agent
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

  // AskUserQuestion
  if (toolName === 'AskUserQuestion') {
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

  // EnterPlanMode
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

  // 未知工具（不應發生）
  return { decision: 'allow' };
}

module.exports = {
  evaluate,
  isNonCodeFile,
  ORCHESTRATOR_TOOLS,
  NON_CODE_EXTS,
};
