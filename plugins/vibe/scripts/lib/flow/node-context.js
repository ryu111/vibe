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

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Node Context 最大字元上限（約 500 tokens）
const MAX_NODE_CONTEXT_CHARS = 2000;

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
 * 格式：
 * <!-- NODE_CONTEXT: {JSON} -->
 *
 * @param {Object} nodeContext - buildNodeContext 的回傳值
 * @returns {string} 嵌入格式字串
 */
function formatNodeContext(nodeContext) {
  const json = JSON.stringify(nodeContext);
  return `<!-- NODE_CONTEXT: ${json} -->`;
}

// ────────────────── Exports ──────────────────

module.exports = {
  buildNodeContext,
  getRetryContext,
  buildEnvSnapshot,
  formatNodeContext,
  MAX_NODE_CONTEXT_CHARS,
};
