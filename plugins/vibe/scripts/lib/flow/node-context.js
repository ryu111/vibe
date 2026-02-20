#!/usr/bin/env node
/**
 * node-context.js — Node Context 動態生成（v4 Phase 2）
 *
 * 每個 stage 委派時生成完整的 Node Context JSON，讓 agent 知道：
 * 1. 自己在 DAG 中的位置（prev/next/onFail/barrier）
 * 2. 前驅 stage 的 context file 路徑（結構化報告）
 * 3. 環境資訊（language/framework/frontend）
 * 4. 回退上下文（Reflexion Memory，首次為 null）
 *
 * Node Context JSON 大小必須 < 500 tokens（約 2000 chars）。
 *
 * @module flow/node-context
 */
'use strict';

const path = require('path');
const os = require('os');

const { readReflection, getReflectionPath } = require('./reflection.js');
const { getBaseStage } = require('./dag-utils.js');
const { readWisdom } = require('./wisdom.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Node Context 最大字元上限（約 500 tokens，S4 調整為 2500 容納 wisdom 欄位）
const MAX_NODE_CONTEXT_CHARS = 2500;

// Phase 任務範圍最大字元上限（注入到 systemMessage）
const MAX_PHASE_SCOPE_CHARS = 500;

// ────────────────── getRetryContext ──────────────────

/**
 * 從 Reflexion Memory 讀取回退上下文。
 *
 * 從 state.retries 反向查找是哪個品質 stage 回退到此 stage，
 * 解決 stage 參數（委派目標 DEV）與反思記憶命名（品質 stage REVIEW）的錯位問題。
 *
 * @param {string} sessionId - session 識別碼
 * @param {string} stage - 委派目標 stage（如 DEV）
 * @param {Object} state - pipeline state（含 retries + dag）
 * @returns {{ failedStage: string, round: number, reflectionFile: string, hint: string }|null}
 */
function getRetryContext(sessionId, stage, state) {
  if (!sessionId || !stage || !state) return null;

  const baseStage = getBaseStage(stage);
  const retries = state.retries || {};
  const dag = state.dag || {};

  // 從 state.retries + dag[s].onFail 反向查找 failedStage
  // 條件：retries > 0 且 dag[s].onFail === baseStage（或 stage）
  const failedStage = Object.keys(retries).find(s => {
    if ((retries[s] || 0) <= 0) return false;
    const onFail = dag[s]?.onFail;
    if (!onFail) return false;
    // onFail 可以是 stage ID 字串（如 'DEV'）
    return onFail === baseStage || onFail === stage;
  });

  if (!failedStage) return null;

  // 嘗試讀取反思記憶內容
  const reflectionFile = getReflectionPath(sessionId, failedStage);
  const reflectionContent = readReflection(sessionId, failedStage);

  return {
    failedStage,
    round: (retries[failedStage] || 0) + 1,
    reflectionFile,
    // 只包含摘要 hint，避免 Node Context 過大
    hint: `⚠️ 你是因為 ${failedStage} FAIL 而被回退的。請先閱讀反思記憶檔案：${reflectionFile}`,
    // reflectionContent 提供給需要 inline 讀取的場景（如 retryContext.reflectionContent）
    reflectionContent: reflectionContent ? reflectionContent.slice(0, 500) : null,
  };
}

// ────────────────── buildNodeContext ──────────────────

/**
 * 生成 Node Context JSON。
 *
 * 設計原則：
 * - node：從 DAG 結構提取拓撲資訊（prev/next/onFail/barrier）
 * - context_files：前驅 stage 的 contextFile 路徑陣列
 * - env：state.environment 的精簡版本（language/framework/frontend）
 * - retryContext：回退上下文（首次執行時為 null）
 *
 * @param {Object} dag - DAG 物件（pipeline-state.dag）
 * @param {Object} state - pipeline state
 * @param {string} stage - 目標 stage ID（如 'REVIEW'）
 * @param {string} sessionId - session 識別碼
 * @returns {Object} Node Context JSON（< 500 tokens）
 */
function buildNodeContext(dag, state, stage, sessionId) {
  if (!dag || !stage) {
    return {
      node: { stage: stage || '', prev: [], next: [], onFail: null, barrier: null },
      context_files: [],
      env: {},
      retryContext: null,
    };
  }

  const node = dag[stage] || { deps: [] };
  const prevStages = node.deps || [];

  // 取得所有前驅 stage 的 contextFile 路徑（過濾 null/undefined）
  const prevContextFiles = prevStages
    .map(s => state.stages?.[s]?.contextFile)
    .filter(Boolean);

  // 計算 next stages（有哪些 stages 的 deps 含此 stage）
  const nextStages = Object.keys(dag).filter(s => {
    return (dag[s]?.deps || []).includes(stage);
  });

  // 組裝 onFail 資訊（QUALITY stage 有 onFail；IMPL stage 為 null）
  let onFail = null;
  if (node.onFail) {
    const failTarget = node.onFail;
    const maxRetries = node.maxRetries || 3;
    const currentRound = (state.retries?.[stage] || 0) + 1;
    onFail = {
      target: failTarget,
      maxRetries,
      currentRound,
    };
  }

  // 環境資訊精簡版（只取 language/framework/frontend）
  const env = buildEnvSnapshot(state);

  // 讀取跨 stage 知識（S4 Wisdom Accumulation）
  const wisdom = sessionId ? readWisdom(sessionId) : null;

  // 組裝 Node Context
  const context = {
    node: {
      stage,
      prev: prevStages,
      next: nextStages,
      onFail,
      barrier: node.barrier || null,
    },
    context_files: prevContextFiles,
    env,
    retryContext: getRetryContext(sessionId, stage, state),
    wisdom: wisdom || null,
  };

  // 確保 JSON 不超過 MAX_NODE_CONTEXT_CHARS
  // M-4 修正：截斷後重新 stringify 確認長度，必要時進一步截斷直到符合限制
  let json = JSON.stringify(context);
  if (json.length > MAX_NODE_CONTEXT_CHARS) {
    // 第一步：截斷 retryContext.reflectionContent（最大的欄位）
    if (context.retryContext?.reflectionContent) {
      const overrun = json.length - MAX_NODE_CONTEXT_CHARS;
      const currentLen = context.retryContext.reflectionContent.length;
      const newLen = Math.max(0, currentLen - overrun - 10);
      context.retryContext.reflectionContent = context.retryContext.reflectionContent.slice(0, newLen) + '...';

      // 重新 stringify 確認截斷後是否符合限制
      json = JSON.stringify(context);
    }

    // 若仍超過（例如 reflectionContent 已清空，但其他欄位仍太大）→ 移除 reflectionContent
    if (json.length > MAX_NODE_CONTEXT_CHARS && context.retryContext?.reflectionContent !== undefined) {
      context.retryContext.reflectionContent = null;
      json = JSON.stringify(context);
    }

    // 最後防線：若還是超過，移除整個 retryContext 只保留最小 hint
    if (json.length > MAX_NODE_CONTEXT_CHARS && context.retryContext) {
      context.retryContext = context.retryContext.hint
        ? { hint: context.retryContext.hint.slice(0, 100) }
        : null;
    }
  }

  return context;
}

// ────────────────── 輔助函式 ──────────────────

/**
 * 從 state.environment 提取精簡環境快照
 *
 * @param {Object} state - pipeline state
 * @returns {Object} 精簡環境資訊
 */
function buildEnvSnapshot(state) {
  const env = state?.environment || {};
  const snapshot = {};

  // 語言資訊
  const primaryLang = env.languages?.primary;
  if (primaryLang) snapshot.language = primaryLang;

  // 框架資訊
  const framework = env.framework?.name;
  if (framework) snapshot.framework = framework;

  // 前端偵測
  if (env.frontend?.detected !== undefined) {
    snapshot.frontend = { detected: !!env.frontend.detected };
  }

  return snapshot;
}

/**
 * 將 Node Context 格式化為 systemMessage 嵌入格式。
 *
 * 採用 key-value 簡寫格式（取代 JSON），減少 token 消耗：
 *   stage=X | prev=Y,Z | next=W | onFail=V:r/m | barrier=G | env=lang/fw | ctx_files=N | retry=S:r/m
 *
 * Agent 無需解析 JSON，只需語意理解，key-value 格式同樣可讀且更緊湊。
 *
 * @param {Object} nodeContext - buildNodeContext 的回傳值
 * @returns {string} 嵌入格式字串
 */
function formatNodeContext(nodeContext) {
  if (!nodeContext) return '<!-- NODE_CONTEXT: stage=unknown -->';

  const node = nodeContext.node || {};
  const parts = [];

  // stage
  parts.push(`stage=${node.stage || 'unknown'}`);

  // prev（逗號分隔，空時省略）
  if (node.prev && node.prev.length > 0) {
    parts.push(`prev=${node.prev.join(',')}`);
  }

  // next（逗號分隔，空時省略）
  if (node.next && node.next.length > 0) {
    parts.push(`next=${node.next.join(',')}`);
  }

  // onFail（格式：target:round/max，null 時省略）
  if (node.onFail) {
    const of = node.onFail;
    parts.push(`onFail=${of.target}:${of.currentRound || 1}/${of.maxRetries || 3}`);
  }

  // barrier（格式：group，null 時省略）
  if (node.barrier) {
    const bg = node.barrier.group || node.barrier;
    parts.push(`barrier=${typeof bg === 'string' ? bg : JSON.stringify(bg)}`);
  }

  // env（格式：language/framework，空時省略）
  const env = nodeContext.env || {};
  const envParts = [];
  if (env.language) envParts.push(env.language);
  if (env.framework) envParts.push(env.framework);
  if (envParts.length > 0) parts.push(`env=${envParts.join('/')}`);

  // ctx_files（只記錄數量，完整路徑太長）
  const ctxFiles = nodeContext.context_files || [];
  if (ctxFiles.length > 0) parts.push(`ctx_files=${ctxFiles.length}`);

  // retry（格式：failedStage:round/max，null 時省略）
  const retry = nodeContext.retryContext;
  if (retry) {
    const maxR = node.onFail?.maxRetries || 3;
    parts.push(`retry=${retry.failedStage}:${retry.round || 1}/${maxR}`);
    // hint（截斷到 60 字元）
    if (retry.hint) {
      parts.push(`hint=${retry.hint.slice(0, 60)}`);
    }
  }

  // wisdom（之前 stage 的學習筆記，null 時省略；截斷到 100 字元避免格式行過長）
  if (nodeContext.wisdom) {
    const wisdomSnippet = nodeContext.wisdom.slice(0, 100);
    parts.push(`wisdom=${wisdomSnippet}`);
  }

  return `<!-- NODE_CONTEXT: ${parts.join(' | ')} -->`;
}

// ────────────────── buildPhaseScopeHint ──────────────────

/**
 * 為 suffixed stage（如 DEV:2）從 pipeline state 的 phaseInfo 提取 phase 任務範圍。
 *
 * 設計原則：
 * - 只在 suffixed stage（stageId 含 `:N`）時觸發
 * - 從 state.phaseInfo[N] 讀取該 phase 的 task 列表
 * - 總長度超過 MAX_PHASE_SCOPE_CHARS 時截斷
 * - 非 suffixed stage 或無 phaseInfo → 返回空字串
 *
 * @param {string} stageId - stage ID（如 'DEV:2'）
 * @param {Object} state - pipeline state（含 phaseInfo）
 * @returns {string} phase 任務範圍字串，空或截斷後返回
 */
function buildPhaseScopeHint(stageId, state) {
  // 只處理 suffixed stage（DEV:N, REVIEW:N, TEST:N）
  const suffixMatch = stageId && stageId.match(/^([A-Z]+):(\d+)$/);
  if (!suffixMatch) return '';

  const phaseIdx = parseInt(suffixMatch[2], 10);
  const phaseInfo = state?.phaseInfo;
  if (!phaseInfo || !phaseInfo[phaseIdx]) return '';

  const info = phaseInfo[phaseIdx];
  if (!info.tasks || info.tasks.length === 0) return '';

  const phaseName = info.name || `Phase ${phaseIdx}`;
  const taskLines = info.tasks.map(t => `- [ ] ${t}`).join('\n');
  const hint = `## ${phaseName} 任務範圍\n${taskLines}`;

  // 截斷保護
  if (hint.length > MAX_PHASE_SCOPE_CHARS) {
    return hint.slice(0, MAX_PHASE_SCOPE_CHARS - 3) + '...';
  }
  return hint;
}

// ────────────────── Exports ──────────────────

module.exports = {
  buildNodeContext,
  getRetryContext,
  buildEnvSnapshot,
  formatNodeContext,
  buildPhaseScopeHint,
  MAX_NODE_CONTEXT_CHARS,
  MAX_PHASE_SCOPE_CHARS,
};
