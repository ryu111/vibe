#!/usr/bin/env node
/**
 * guard-rules.js — Pipeline Guard 規則模組（純函式）
 *
 * v4：Guard 使用 pipelineActive 布林值（取代複雜的 5 phase 推導）。
 *
 * 核心邏輯（短路）：
 * 1. EnterPlanMode → 無條件 block
 * 2. Bash DANGER_PATTERNS → 無條件 block
 * 2.5. Bash 寫檔偵測 → pipelineActive 時攔截寫入程式碼檔案
 * 3. !state?.pipelineActive → allow（v4 核心：不活躍即放行）
 * 4. activeStages.length > 0 → allow（sub-agent 委派中，放行）
 * 5. Task / Skill → allow（委派工具始終放行）
 * 6. READ_ONLY_TOOLS → allow（唯讀白名單）
 * 6.5. 特定 state file 寫入 → allow（cancel skill 逃生門：pipeline-state/task-guard-state/classifier-corpus）
 * 7. 其他 → block（Relay 模式阻擋）
 *
 * @module sentinel/guard-rules
 */
'use strict';

const path = require('path');
const {
  isActive, getReadyStages, getCurrentStage,
} = require(path.join(__dirname, '..', 'flow', 'dag-state.js'));
const { STAGES } = require(path.join(__dirname, '..', 'registry.js'));

// 唯讀工具 + 互動查詢白名單（pipelineActive 但尚未委派時允許）
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskList', 'TaskGet',
  'AskUserQuestion',  // S1: Main Agent 不確定 pipeline 時可詢問使用者
]);

// 非程式碼檔案副檔名（允許直接編輯）
const NON_CODE_EXTS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.cfg', '.ini', '.csv', '.xml', '.html', '.css', '.svg',
  '.conf', '.lock',
]);

// Pipeline.json 中的 stageMap（stage → skill 對應）
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
 * @param {Object|null} state - pipeline state（v3/v4）
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

// dotfiles（.env 系列用前綴匹配覆蓋所有變體，其餘精確匹配）
const NON_CODE_DOTFILES = new Set([
  '.gitignore', '.dockerignore', '.editorconfig',
  '.eslintrc', '.prettierrc', '.browserslistrc',
]);

/**
 * 判斷檔案是否為非程式碼檔案
 */
function isNonCodeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const baseName = path.basename(filePath);
  if (baseName.startsWith('.env')) return true;  // 涵蓋所有 .env 變體
  if (NON_CODE_DOTFILES.has(baseName)) return true;
  const ext = path.extname(filePath).toLowerCase();
  return NON_CODE_EXTS.has(ext);
}

// ────────────────── 毀滅性指令防護 ──────────────────

// 毀滅性指令模式（無條件攔截）
const DANGER_PATTERNS = [
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$)/, desc: 'rm -rf /' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, desc: 'DROP TABLE/DATABASE' },
  { pattern: /\bgit\s+push\s+--force\s+(main|master)\b/, desc: 'git push --force main/master' },
  { pattern: /\bgit\s+push\s+-f\s+(main|master)\b/, desc: 'git push -f main/master' },
  { pattern: /\bgit\s+push\s+--force\s+origin\s+(main|master)\b/, desc: 'git push --force origin main/master' },
  { pattern: /\bgit\s+push\s+-f\s+origin\s+(main|master)\b/, desc: 'git push -f origin main/master' },
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
  /\bcp\s+(?:-\w+\s+)*\S+\s+(\S+)/,           // cp source target
  /\bmv\s+(?:-\w+\s+)*\S+\s+(\S+)/,           // mv source target
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
 * v4 邏輯：
 * 1. EnterPlanMode → block（無條件）
 * 2. Bash DANGER_PATTERNS → block（無條件）
 * 2.5. Bash 寫檔偵測 → pipelineActive 時攔截寫入程式碼檔案
 * 3. !pipelineActive → allow（v4 核心）
 * 4. activeStages.length > 0 → allow（子 agent 委派中）
 * 5. Task / Skill → allow（委派工具始終放行）
 * 6. READ_ONLY_TOOLS → allow（唯讀白名單）
 * 6.5. 特定 state file 寫入 → allow（cancel skill 逃生門：pipeline-state/task-guard-state/classifier-corpus）
 * 7. 其他 → block（Main Agent 作為 Relay，不直接執行）
 *
 * @param {string} toolName
 * @param {Object} toolInput
 * @param {Object|null} state
 * @returns {{ decision: 'allow'|'block', reason?: string, message?: string }}
 */
function evaluate(toolName, toolInput, state) {
  // ── 1. EnterPlanMode — 無條件阻擋 ──
  if (toolName === 'EnterPlanMode') {
    return {
      decision: 'block',
      reason: 'plan-mode-disabled',
      message:
        `⛔ 禁止使用 EnterPlanMode。\n` +
        `如需規劃，請使用 /vibe:scope 委派給 planner agent。\n`,
    };
  }

  // ── 2. Bash DANGER_PATTERNS — 無條件阻擋（不受 pipeline 影響） ──
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    const dangerResult = evaluateBashDanger(command);
    if (dangerResult) return dangerResult;
  }

  // ── 2.5. Bash 寫檔偵測（pipelineActive 時攔截） ──
  const pipelineActive = isActive(state);
  if (pipelineActive && toolName === 'Bash') {
    const writeResult = detectBashWriteTarget(toolInput?.command || '');
    if (writeResult) return writeResult;
  }

  // ── 3. v4 核心：pipelineActive = false → allow ──
  // 涵蓋：未初始化、IDLE、COMPLETE、已取消、none pipeline 等所有非活躍狀態
  if (!pipelineActive) return { decision: 'allow' };

  // ── 4. activeStages.length > 0 → allow（子 agent 委派中） ──
  // Sub-agent 在 DELEGATING 狀態下需要自由使用工具
  const activeStagesArr = (state?.activeStages || []);
  if (activeStagesArr.length > 0) return { decision: 'allow' };

  // ── 以下：pipelineActive=true 且無 activeStages（Relay 模式） ──

  // ── 5. Task / Skill → allow（委派工具始終放行） ──
  if (toolName === 'Task' || toolName === 'Skill') {
    return { decision: 'allow' };
  }

  // ── 6. READ_ONLY_TOOLS → allow（唯讀白名單） ──
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: 'allow' };
  }

  // ── 6.5. 特定 state file 寫入 → allow（cancel skill 逃生門） ──
  // cancel skill 需要寫入以下檔案來解除 guard，但 guard 本身阻擋所有寫入工具 — 形成死鎖。
  // 白名單（路徑必須在 ~/.claude/ 下）：
  //   1. pipeline-state-*.json  — cancel 解除 pipeline guard
  //   2. task-guard-state-*.json — cancel 解除 task-guard
  //   3. classifier-corpus.jsonl — cancel 語料回饋收集
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';
    const baseName = path.basename(filePath);
    const dirName = path.dirname(filePath);
    const homeDir = require('os').homedir();
    const isClaudeDir = dirName === path.join(homeDir, '.claude');
    if (isClaudeDir) {
      if (
        (baseName.startsWith('pipeline-state-') && baseName.endsWith('.json')) ||
        (baseName.startsWith('task-guard-state-') && baseName.endsWith('.json')) ||
        baseName === 'classifier-corpus.jsonl'
      ) {
        return { decision: 'allow' };
      }
    }
  }

  // ── 7. 其他 → block（Main Agent 是訊息匯流排 Relay，不直接執行） ──
  // Relay 模式下統一阻擋：must-delegate 優先於所有工具特定阻擋
  return {
    decision: 'block',
    reason: 'must-delegate',
    message:
      `⛔ Pipeline [${state?.classification?.pipelineId || '?'}] 等待委派 — 禁止 ${toolName}。\n` +
      `你是訊息匯流排（Relay），不是執行者。請使用 Skill 或 Task 工具委派 sub-agent 執行此任務。\n` +
      `➡️ 下一步：${buildDelegateHint(state)}\n`,
  };
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
  STAGE_SKILL_MAP,
};
