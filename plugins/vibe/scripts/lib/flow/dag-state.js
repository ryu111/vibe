#!/usr/bin/env node
/**
 * dag-state.js — Pipeline v3 宣告式狀態管理
 *
 * 取代 state-machine.js 的 FSM 模式。
 * Phase 從 stages 狀態自動推導（derivePhase），不需要手動管理轉換矩陣。
 *
 * 設計原則：
 * 1. 宣告式 — stages 記錄各 stage 狀態，phase 是衍生值
 * 2. DAG 驅動 — getReadyStages() 從 DAG + stages 計算下一批可執行的 stages
 * 3. 集中 I/O — 統一讀寫 state file
 * 4. 純函式查詢 — 所有查詢都不修改 state
 *
 * @module flow/dag-state
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ────────────────── 常量定義 ──────────────────

const PHASES = {
  IDLE: 'IDLE',
  CLASSIFIED: 'CLASSIFIED',
  DELEGATING: 'DELEGATING',
  RETRYING: 'RETRYING',
  COMPLETE: 'COMPLETE',
};

const STAGE_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

// ────────────────── 初始化 ──────────────────

/**
 * 建立初始 state（v3 結構）
 * @param {string} sessionId
 * @param {Object} options - { environment, openspecEnabled, pipelineRules }
 * @returns {Object}
 */
function createInitialState(sessionId, options = {}) {
  return {
    version: 3,
    sessionId,

    // 分類結果
    classification: null,

    // 環境
    environment: options.environment || {},
    openspecEnabled: options.openspecEnabled || false,
    needsDesign: false,

    // DAG（pipeline-architect 產出）
    dag: null,
    enforced: false,
    blueprint: null,

    // 各 stage 狀態
    stages: {},

    // 重試
    retries: {},
    pendingRetry: null,

    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: options.pipelineRules || [],
    },
  };
}

// ────────────────── Phase 推導 ──────────────────

/**
 * 從 state 推導當前 phase（純函式）
 * @param {Object} state
 * @returns {string} PHASES 值
 */
function derivePhase(state) {
  if (!state) return PHASES.IDLE;
  if (state.meta?.cancelled) return PHASES.IDLE;
  if (!state.dag) {
    // 安全網：有分類但無 DAG（極端情況）→ CLASSIFIED（讓 guard 生效）
    const pid = state.classification?.pipelineId;
    if (pid && pid !== 'none') return PHASES.CLASSIFIED;
    return PHASES.IDLE;
  }

  const stages = state.stages || {};
  const stageIds = Object.keys(state.dag);
  if (stageIds.length === 0) return PHASES.IDLE;

  // pendingRetry → RETRYING
  if (state.pendingRetry?.stages?.length > 0) {
    return PHASES.RETRYING;
  }

  // 全部完成/跳過 → COMPLETE
  const allDone = stageIds.every(id => {
    const s = stages[id]?.status;
    return s === STAGE_STATUS.COMPLETED || s === STAGE_STATUS.SKIPPED;
  });
  if (allDone) return PHASES.COMPLETE;

  // 有 active → DELEGATING
  const hasActive = stageIds.some(id => stages[id]?.status === STAGE_STATUS.ACTIVE);
  if (hasActive) return PHASES.DELEGATING;

  // 有 DAG 但沒 active → CLASSIFIED
  return PHASES.CLASSIFIED;
}

// ────────────────── DAG 查詢 ──────────────────

/**
 * 取得所有 deps 已滿足且 status=pending 的 stages
 * @param {Object} state
 * @returns {string[]}
 */
function getReadyStages(state) {
  if (!state?.dag) return [];

  const dag = state.dag;
  const stages = state.stages || {};
  const ready = [];

  for (const [stageId, config] of Object.entries(dag)) {
    const status = stages[stageId]?.status || STAGE_STATUS.PENDING;
    if (status !== STAGE_STATUS.PENDING) continue;

    const deps = config.deps || [];
    const satisfied = deps.every(dep => {
      const ds = stages[dep]?.status;
      return ds === STAGE_STATUS.COMPLETED || ds === STAGE_STATUS.SKIPPED;
    });

    if (satisfied) ready.push(stageId);
  }

  return ready;
}

/**
 * 取得所有 active stages
 */
function getActiveStages(state) {
  if (!state?.stages) return [];
  return Object.entries(state.stages)
    .filter(([, s]) => s.status === STAGE_STATUS.ACTIVE)
    .map(([id]) => id);
}

/**
 * 取得所有 completed stages
 */
function getCompletedStages(state) {
  if (!state?.stages) return [];
  return Object.entries(state.stages)
    .filter(([, s]) => s.status === STAGE_STATUS.COMPLETED)
    .map(([id]) => id);
}

/**
 * 取得所有 skipped stages
 */
function getSkippedStages(state) {
  if (!state?.stages) return [];
  return Object.entries(state.stages)
    .filter(([, s]) => s.status === STAGE_STATUS.SKIPPED)
    .map(([id]) => id);
}

// ────────────────── 向後相容衍生查詢 ──────────────────

function getPhase(state) { return derivePhase(state); }
function isDelegating(state) { return derivePhase(state) === PHASES.DELEGATING; }
function isEnforced(state) {
  if (!state) return false;
  const phase = derivePhase(state);
  if (![PHASES.CLASSIFIED, PHASES.DELEGATING, PHASES.RETRYING].includes(phase)) return false;
  if (state.enforced) return true;
  // 安全網：有分類的非 trivial pipeline = enforced（即使 setDag 尚未執行）
  const pid = state?.classification?.pipelineId;
  return !!pid && pid !== 'none';
}
function isComplete(state) { return derivePhase(state) === PHASES.COMPLETE; }
function isInitialized(state) { return !!state?.meta?.initialized; }
function isCancelled(state) { return !!state?.meta?.cancelled; }
function getPipelineId(state) { return state?.classification?.pipelineId || null; }
function getTaskType(state) { return state?.classification?.taskType || null; }
function getEnvironment(state) { return state?.environment || {}; }
function isOpenSpecEnabled(state) { return !!state?.openspecEnabled; }
function getRetries(state) { return state?.retries || {}; }
function getPendingRetry(state) { return state?.pendingRetry || null; }
function getCurrentStage(state) {
  const active = getActiveStages(state);
  return active[0] || null;
}

// ────────────────── State 變更操作 ──────────────────

function _touch(state) {
  return { ...state, meta: { ...state.meta, lastTransition: new Date().toISOString() } };
}

/** 設定分類結果（升級時追蹤 reclassifications） */
function classify(state, classification) {
  const reclassifications = [...(state.meta?.reclassifications || [])];
  if (state.classification?.pipelineId) {
    reclassifications.push({
      from: state.classification.pipelineId,
      to: classification.pipelineId,
      at: new Date().toISOString(),
    });
  }
  return _touch({
    ...state,
    classification: { ...classification, classifiedAt: new Date().toISOString() },
    meta: { ...state.meta, cancelled: false, reclassifications },
  });
}

/** 設定 DAG + 初始化 stages */
function setDag(state, dag, blueprint, enforced) {
  const stages = {};
  for (const stageId of Object.keys(dag)) {
    stages[stageId] = { status: STAGE_STATUS.PENDING, agent: null, verdict: null };
  }
  return _touch({ ...state, dag, blueprint: blueprint || null, enforced: enforced !== false, stages });
}

/** 標記 active */
function markStageActive(state, stageId, agentType) {
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        status: STAGE_STATUS.ACTIVE,
        agent: agentType || null,
        startedAt: new Date().toISOString(),
      },
    },
  });
}

/** 標記 completed */
function markStageCompleted(state, stageId, verdict) {
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        status: STAGE_STATUS.COMPLETED,
        verdict: verdict || null,
        completedAt: new Date().toISOString(),
      },
    },
  });
}

/** 標記 skipped */
function markStageSkipped(state, stageId, reason) {
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        status: STAGE_STATUS.SKIPPED,
        reason: reason || '',
      },
    },
  });
}

/** 標記 failed + 更新 retries */
function markStageFailed(state, stageId, verdict) {
  const retries = { ...state.retries };
  retries[stageId] = (retries[stageId] || 0) + 1;
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        status: STAGE_STATUS.FAILED,
        verdict,
        completedAt: new Date().toISOString(),
      },
    },
    retries,
  });
}

/** 設定 pendingRetry */
function setPendingRetry(state, retryInfo) {
  return _touch({ ...state, pendingRetry: retryInfo });
}

/** 清除 pendingRetry */
function clearPendingRetry(state) {
  return _touch({ ...state, pendingRetry: null });
}

/** 重設 stage 為 pending（回退後重跑） */
function resetStageToPending(state, stageId) {
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        status: STAGE_STATUS.PENDING,
        verdict: null,
        startedAt: null,
        completedAt: null,
      },
    },
  });
}

/** 取消 pipeline */
function cancelPipeline(state) {
  return _touch({ ...state, meta: { ...state.meta, cancelled: true } });
}

/** 重設 state（新任務） */
function reset(state) {
  return createInitialState(state.sessionId, {
    environment: state.environment,
    openspecEnabled: state.openspecEnabled,
    pipelineRules: state.meta?.pipelineRules || [],
  });
}

// ────────────────── I/O ──────────────────

function getStatePath(sessionId) {
  return path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
}

function readState(sessionId) {
  const p = getStatePath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(sessionId, state) {
  if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(getStatePath(sessionId), JSON.stringify(state, null, 2));
}

function deleteState(sessionId) {
  try { fs.unlinkSync(getStatePath(sessionId)); } catch (_) {}
}

// ────────────────── Exports ──────────────────

module.exports = {
  // Constants
  PHASES,
  STAGE_STATUS,

  // Lifecycle
  createInitialState,
  classify,
  setDag,
  markStageActive,
  markStageCompleted,
  markStageSkipped,
  markStageFailed,
  setPendingRetry,
  clearPendingRetry,
  resetStageToPending,
  cancel: cancelPipeline,
  reset,

  // Phase derivation
  derivePhase,

  // DAG queries
  getReadyStages,
  getActiveStages,
  getCompletedStages,
  getSkippedStages,

  // Backward-compatible queries
  getPhase,
  isDelegating,
  isEnforced,
  isComplete,
  isInitialized,
  isCancelled,
  getPipelineId,
  getTaskType,
  getEnvironment,
  isOpenSpecEnabled,
  getRetries,
  getPendingRetry,
  getCurrentStage,

  // I/O
  getStatePath,
  readState,
  writeState,
  deleteState,
};
