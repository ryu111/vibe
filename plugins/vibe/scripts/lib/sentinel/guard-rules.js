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
  getTaskType, getCurrentStage, getPipelineId, PHASES, getReadyStages,
} = require(path.join(__dirname, '..', 'flow', 'dag-state.js'));
const { STAGES } = require(path.join(__dirname, '..', 'registry.js'));

// 唯讀工具白名單（CLASSIFIED/RETRYING 階段允許，不阻擋讀取）
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskList', 'TaskGet',
]);

// Cancel 逃生口：允許寫入的 state 檔案（pipeline-state / task-guard-state）
const CANCEL_STATE_FILE_RE = /^(pipeline-state|task-guard-state)-[a-f0-9-]+\.json$/;

// 非程式碼檔案副檔名（允許直接編輯）
const NON_CODE_EXTS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.cfg', '.ini', '.csv', '.xml', '.html', '.css', '.svg',
  '.conf', '.lock',
]);

// Pipeline.json 中的 stageMap（stage → skill 對應）
// 注意：pipeline-discovery.js 需要 CLAUDE_PLUGIN_ROOT，guard-rules 盡量保持純函式
// 改用 STAGES（registry.js）查找 skill — 以 buildDelegationHint 模式為主
// 實際 skill 在 pipeline.json stageMap，但 guard-rules 不應依賴 pipeline-discovery
// 折衷：直接在此維護 STAGE_SKILL_MAP（與 pipeline.json 保持同步）
const STAGE_SKILL_MAP = {
  PLAN:   '/vibe:scope',
  ARCH:   '/vibe:architect',
  DESIGN: '/vibe:design',
  DEV:    '/vibe:dev',
  REVIEW: '/vibe:review',
  TEST:   '/vibe:tdd',
  QA:     '/vibe:qa',
  E2E:    '/vibe:e2e',
  DOCS:   '/vibe:doc-sync',
};

/**
 * 從 state 取得下一步委派提示
 *
 * @param {Object|null} state - pipeline state（v3）
 * @returns {string} 委派提示文字
 */
function buildDelegateHint(state) {
  if (!state) return '（DAG 尚未建立）';
  const ready = getReadyStages(state);
  if (!ready || ready.length === 0) return '（DAG 尚未建立）';
  const hints = ready.map(stage => {
    const skill = STAGE_SKILL_MAP[stage];
    const label = (STAGES[stage] && STAGES[stage].label) || stage;
    if (skill) return `呼叫 ${skill} 委派 ${label} (${stage}) 階段`;
    return `委派 ${label} (${stage}) 階段`;
  });
  return hints.join(' 或 ');
}

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
 * 7. CLASSIFIED/RETRYING → 允許 Task/Skill/唯讀 + cancel state 檔案寫入
 * 8. Bash 寫檔繞過 → 阻擋（僅 pipeline enforced）
 * 9. 工具特定規則（Write/Edit/AskUserQuestion）
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
  // v3: isEnforced() 涵蓋 taskType 缺失場景，不需要 getTaskType 早期返回
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
    // Cancel 逃生口：允許 Write/Edit 修改 pipeline/task-guard state 檔案
    if (['Write', 'Edit'].includes(toolName)) {
      const filePath = toolInput?.file_path;
      if (typeof filePath === 'string' && CANCEL_STATE_FILE_RE.test(path.basename(filePath))) {
        return { decision: 'allow' };
      }
    }
    // RETRYING 特殊提示：品質階段失敗 → 必須經 DEV 修復
    if (phase === PHASES.RETRYING) {
      return {
        decision: 'block',
        reason: 'must-delegate-retry',
        message:
          `⛔ 品質階段失敗，等待 DEV 修復 — 禁止 ${toolName}。\n` +
          `你是路由器（Router），不是執行者。所有程式碼修復必須透過 /vibe:dev 委派 developer agent。\n` +
          `➡️ 下一步：${buildDelegateHint(state)}\n`,
      };
    }
    return {
      decision: 'block',
      reason: 'must-delegate',
      message:
        `⛔ Pipeline [${getPipelineId(state)}] 等待委派 — 禁止 ${toolName}。\n` +
        `你是路由器（Router），不是執行者。請使用 Skill 或 Task 工具委派 sub-agent 執行此任務。\n` +
        `➡️ 下一步：${buildDelegateHint(state)}\n`,
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
        `你是路由器（Router），不是執行者。所有程式碼變更必須透過 sub-agent 完成。\n` +
        `如需修復問題 → /vibe:dev 委派 developer agent。\n` +
        `➡️ 下一步：${buildDelegateHint(state)}\n`,
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
  buildDelegateHint,
  NON_CODE_EXTS,
  NON_CODE_DOTFILES,
  DANGER_PATTERNS,
  WRITE_PATTERNS,
  CANCEL_STATE_FILE_RE,
  STAGE_SKILL_MAP,
};
