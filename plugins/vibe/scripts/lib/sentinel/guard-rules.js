#!/usr/bin/env node
/**
 * guard-rules.js — Pipeline Guard 規則模組（純函式）
 *
 * v3.0.0：改用 dag-state.js 衍生查詢（取代 state-machine.js）。
 * isDelegating() / isEnforced() / isCancelled() 等 API 不變。
 *
 * @module sentinel/guard-rules
 */
'use strict';

const path = require('path');
const {
  getPhase, isDelegating, isEnforced, isCancelled, isInitialized,
  getTaskType, getCurrentStage, getPipelineId, PHASES,
} = require(path.join(__dirname, '..', 'flow', 'dag-state.js'));

// 唯讀工具白名單（CLASSIFIED/RETRYING 階段允許，不阻擋讀取）
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskList', 'TaskGet',
]);

// 非程式碼檔案副檔名（允許直接編輯）
const NON_CODE_EXTS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.cfg', '.ini', '.csv', '.xml', '.html', '.css', '.svg',
  '.conf', '.lock',
]);

// dotfiles
const NON_CODE_DOTFILES = new Set([
  '.env', '.env.local', '.env.example', '.env.development', '.env.production',
  '.gitignore', '.dockerignore', '.editorconfig',
  '.eslintrc', '.prettierrc', '.browserslistrc',
]);

/**
 * 判斷檔案是否為非程式碼檔案
 */
function isNonCodeFile(filePath) {
  if (!filePath) return false;
  const baseName = path.basename(filePath);
  if (NON_CODE_DOTFILES.has(baseName)) return true;
  const ext = path.extname(filePath).toLowerCase();
  return NON_CODE_EXTS.has(ext);
}

// ────────────────── 毀滅性指令防護 ──────────────────

// 毀滅性指令模式（從 danger-guard.js 遷移，無條件攔截）
const DANGER_PATTERNS = [
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$)/, desc: 'rm -rf /' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, desc: 'DROP TABLE/DATABASE' },
  { pattern: /\bgit\s+push\s+--force\s+(main|master)\b/, desc: 'git push --force main/master' },
  { pattern: /\bgit\s+push\s+-f\s+(main|master)\b/, desc: 'git push -f main/master' },
  { pattern: /\bchmod\s+777\b/, desc: 'chmod 777' },
  { pattern: />\s*\/dev\/sd[a-z]/, desc: '寫入裝置檔案' },
  { pattern: /\bmkfs\b/, desc: 'mkfs 格式化磁碟' },
  { pattern: /\bdd\s+.*of=\/dev\//, desc: 'dd 寫入裝置' },
];

/**
 * 評估 Bash 指令是否為毀滅性操作（無條件阻擋）
 */
function evaluateBashDanger(command) {
  for (const { pattern, desc } of DANGER_PATTERNS) {
    if (pattern.test(command)) {
      return {
        decision: 'block',
        reason: 'danger-pattern',
        matchedPattern: desc,
        message: `⛔ 攔截危險指令 — ${desc}\n指令：${command.slice(0, 200)}\n`,
      };
    }
  }
  return null;
}

// ────────────────── Bash 寫檔偵測 ──────────────────

// 寫入指令模式（精確匹配特定指令，避免誤擋 npm run build > output.log）
const WRITE_PATTERNS = [
  /\b(?:echo|cat|printf)\b.*?>{1,2}\s*(\S+)/,
  /\|\s*tee\s+(?:-a\s+)?(\S+)/,
  /\bsed\s+(?:-[^i]*)?-i['"=]?\s*(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)/,
];

/**
 * 偵測 Bash 指令是否寫入程式碼檔案
 */
function detectBashWriteTarget(command) {
  for (const pattern of WRITE_PATTERNS) {
    const match = command.match(pattern);
    if (match && match[1]) {
      const targetFile = match[1].replace(/["']/g, '');
      if (!isNonCodeFile(targetFile)) {
        return {
          decision: 'block',
          reason: 'bash-write-bypass',
          message:
            `⛔ Pipeline 模式下禁止使用 Bash 寫入程式碼檔案。\n` +
            `偵測到寫入目標：${targetFile}\n` +
            `請使用 Task 工具委派給對應的 sub-agent。\n`,
        };
      }
    }
  }
  return null;
}

/**
 * 評估工具使用是否允許
 *
 * 評估邏輯（短路）：
 * 1. EnterPlanMode → 無條件阻擋
 * 2. Bash DANGER_PATTERNS → 無條件阻擋（不受 FSM 影響）
 * 3. 無 state / 未初始化 / 未分類 → allow
 * 4. phase === DELEGATING → allow
 * 5. 未 enforced → allow
 * 6. 已取消 → allow
 * 7. Bash 寫檔繞過 → 阻擋（僅 pipeline enforced）
 * 8. 工具特定規則（Write/Edit/AskUserQuestion）
 */
function evaluate(toolName, toolInput, state) {
  // ── EnterPlanMode — 無條件阻擋 ──
  if (toolName === 'EnterPlanMode') {
    return {
      decision: 'block',
      reason: 'plan-mode-disabled',
      message:
        `⛔ 禁止使用 EnterPlanMode。\n` +
        `如需規劃，請使用 /vibe:scope 委派給 planner agent。\n`,
    };
  }

  // ── Bash DANGER_PATTERNS — 無條件阻擋（不受 FSM 影響） ──
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    const dangerResult = evaluateBashDanger(command);
    if (dangerResult) return dangerResult;
  }

  // ── FSM 衍生查詢放行條件 ──
  if (!state) return { decision: 'allow' };
  if (!isInitialized(state)) return { decision: 'allow' };
  if (!getTaskType(state)) return { decision: 'allow' };
  if (!isEnforced(state)) return { decision: 'allow' };
  if (isDelegating(state)) return { decision: 'allow' };
  if (isCancelled(state)) return { decision: 'allow' };

  // ── CLASSIFIED / RETRYING — 強制委派（允許 Task/Skill + 唯讀工具） ──
  // Pipeline 已分類但尚未委派：Main Agent 可讀取但不可寫入，必須委派 sub-agent
  const phase = getPhase(state);
  if (phase === PHASES.CLASSIFIED || phase === PHASES.RETRYING) {
    if (toolName === 'Task' || toolName === 'Skill' || READ_ONLY_TOOLS.has(toolName)) {
      return { decision: 'allow' };
    }
    return {
      decision: 'block',
      reason: 'must-delegate',
      message:
        `⛔ Pipeline [${getPipelineId(state)}] 等待委派 — 禁止 ${toolName}。\n` +
        `請使用 Skill 或 Task 工具委派 sub-agent 執行此任務。\n`,
    };
  }

  // ── Bash 寫檔繞過阻擋（僅 pipeline enforced 時） ──
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    const writeResult = detectBashWriteTarget(command);
    if (writeResult) return writeResult;
    return { decision: 'allow' };
  }

  // ── Write / Edit / NotebookEdit ──
  // Pipeline enforced 模式下，主 Agent 一律不可寫入（不區分檔案類型）
  // 子 Agent 在 delegating 階段已由上方 isDelegating() 放行
  if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
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
    const currentStage = getCurrentStage(state);
    if (currentStage === 'PLAN') return { decision: 'allow' };

    return {
      decision: 'block',
      reason: 'pipeline-auto-mode',
      message:
        '⛔ Pipeline 自動模式：禁止使用 AskUserQuestion。\n' +
        'Pipeline 是全自動閉環流程，stage-transition 會指示下一步。\n' +
        '請直接按照 pipeline 指示執行下一階段。\n',
    };
  }

  return { decision: 'allow' };
}

module.exports = {
  evaluate,
  isNonCodeFile,
  evaluateBashDanger,
  detectBashWriteTarget,
  NON_CODE_EXTS,
  NON_CODE_DOTFILES,
  DANGER_PATTERNS,
  WRITE_PATTERNS,
};
