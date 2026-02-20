#!/usr/bin/env node
/**
 * dag-state.js — Pipeline 宣告式狀態管理
 *
 * 核心概念：
 * - pipelineActive: true  → pipeline 執行中（guard 啟動）
 * - pipelineActive: false → pipeline 閒置/完成/已取消（guard 關閉）
 *
 * 設計原則：
 * 1. 宣告式 — stages 記錄各 stage 狀態，phase 是衍生值
 * 2. DAG 驅動 — getReadyStages() 從 DAG + stages 計算下一批可執行的 stages
 * 3. 集中 I/O — 統一讀寫 state file（使用 atomicWrite 確保原子性）
 * 4. 純函式查詢 — 所有查詢都不修改 state
 *
 * @module flow/dag-state
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('./atomic-write.js');

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
 * 建立初始 state
 * @param {string} sessionId
 * @param {Object} options - { environment, openspecEnabled, pipelineRules }
 * @returns {Object}
 */
function createInitialState(sessionId, options = {}) {
  return {
    version: 4,
    sessionId,

    // 分類結果
    classification: null,

    // 環境
    environment: options.environment || {},
    openspecEnabled: options.openspecEnabled || false,
    needsDesign: false,

    // DAG（pipeline-architect 產出）
    dag: null,
    blueprint: null,

    // pipeline 執行狀態（pipelineActive 布林值取代複雜的 5 phase 推導）
    pipelineActive: false,

    // 並行追蹤：目前 active 的 stages
    activeStages: [],

    // 各 stage 狀態
    stages: {},

    // 重試
    retries: {},
    pendingRetry: null,

    // 重試歷史（每個 stage 的每輪重試記錄）
    retryHistory: {},

    // crash 計數器（barrier 崩潰追蹤用）
    crashes: {},

    // Token 效率追蹤：累積品質 stage transcript 洩漏字元數
    // 超過閾值時 suggest-compact 會建議 compact
    leakAccumulated: 0,

    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: options.pipelineRules || [],
    },
  };
}

// ────────────────── Phase 推導 ──────────────────

/**
 * 從 state 推導當前 phase（純函式）
 *
 * 使用 pipelineActive 布林值 + activeStages 陣列判斷。
 *
 * 暫態說明（H-3）：
 * 當 pipelineActive=true 且所有 stages 均已完成（allDone=true）時，
 * 此函式回傳 COMPLETE，但 pipelineActive 仍維持 true（因為純函式不修改 state）。
 * 這是正常的暫態——pipeline-controller 的 onStageComplete 在最後一個 stage 完成後
 * 會立即設定 pipelineActive=false 並寫回磁碟，Guard 下一次讀到的 state 就是已解除的狀態。
 * Guard（guard-rules.evaluate）使用 isActive()（即 pipelineActive 布林值）而非 derivePhase，
 * 因此在這個暫態期間 guard 可能仍會阻擋寫入操作——這是預期行為，不是 bug。
 *
 * @param {Object} state
 * @returns {string} PHASES 值
 */
function derivePhase(state) {
  if (!state) return PHASES.IDLE;

  // pipelineActive=false → IDLE（或 COMPLETE，根據是否有已完成 stages 判斷）
  if (!state.pipelineActive) {
    // 若有完成的 stages → COMPLETE，否則 IDLE
    if (state.dag) {
      const stageIds = Object.keys(state.dag);
      const stages = state.stages || {};
      if (stageIds.length > 0) {
        const allDone = stageIds.every(id => {
          const s = stages[id]?.status;
          return s === STAGE_STATUS.COMPLETED || s === STAGE_STATUS.SKIPPED;
        });
        if (allDone) return PHASES.COMPLETE;
      }
    }
    return PHASES.IDLE;
  }

  // pipelineActive=true → 根據 stages 狀態推導
  // 無 DAG（如 test-first 重複 stage，等待 pipeline-architect 建立）→ CLASSIFIED
  if (!state.dag) return PHASES.CLASSIFIED;

  const stages = state.stages || {};
  const stageIds = Object.keys(state.dag);
  if (stageIds.length === 0) return PHASES.CLASSIFIED;

  // activeStages.length > 0 → DELEGATING
  const activeStagesArr = state.activeStages || [];
  if (activeStagesArr.length > 0) return PHASES.DELEGATING;

  // 全部完成/跳過 → COMPLETE
  const allDone = stageIds.every(id => {
    const s = stages[id]?.status;
    return s === STAGE_STATUS.COMPLETED || s === STAGE_STATUS.SKIPPED;
  });
  if (allDone) return PHASES.COMPLETE;

  // 有 failed + retries → RETRYING
  const hasFailed = stageIds.some(id => stages[id]?.status === STAGE_STATUS.FAILED);
  const hasRetries = Object.keys(state.retries || {}).length > 0;
  if (hasFailed && hasRetries) return PHASES.RETRYING;

  // pendingRetry → RETRYING
  if (Array.isArray(state.pendingRetry?.stages) && state.pendingRetry.stages.length > 0) {
    return PHASES.RETRYING;
  }

  // 其餘 → CLASSIFIED
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

// ────────────────── 核心查詢 ──────────────────

/**
 * pipeline 是否活躍（guard 是否應該啟動）
 *
 * 只需一個布林值判斷是否需要 guard。
 *
 * @param {Object|null} state
 * @returns {boolean}
 */
function isActive(state) {
  return state?.pipelineActive === true;
}

// ────────────────── 衍生查詢 ──────────────────

function isComplete(state) { return derivePhase(state) === PHASES.COMPLETE; }
function getPipelineId(state) { return state?.classification?.pipelineId || null; }
function getRetries(state) { return state?.retries || {}; }
function getPendingRetry(state) { return state?.pendingRetry || null; }
function getCurrentStage(state) {
  const active = getActiveStages(state);
  return active[0] || null;
}

// ────────────────── State 變更操作 ──────────────────

function _touch(state) {
  return { ...state, meta: { ...(state.meta || {}), lastTransition: new Date().toISOString() } };
}

/** 設定分類結果（升級時追蹤 reclassifications）
 *
 * 若分類為非 trivial pipeline（非 none），立即設 pipelineActive=true，
 * 確保 guard 在 DAG 建立前即啟動。
 */
function classify(state, classification) {
  const reclassifications = [...(state.meta?.reclassifications || [])];
  if (state.classification?.pipelineId) {
    reclassifications.push({
      from: state.classification.pipelineId,
      to: classification.pipelineId,
      at: new Date().toISOString(),
    });
  }

  // 非 none + 非 trivial pipeline → pipelineActive=true（DAG 尚未建立時也 guard）
  const pipelineId = classification.pipelineId;
  const shouldActivate = pipelineId && pipelineId !== 'none';

  return _touch({
    ...state,
    classification: { ...classification, classifiedAt: new Date().toISOString() },
    pipelineActive: shouldActivate ? true : (state.pipelineActive || false),
    meta: { ...(state.meta || {}), reclassifications },
  });
}

/** 設定 DAG + 初始化 stages（同步設定 pipelineActive=true） */
function setDag(state, dag, blueprint, _enforced) {
  const stages = {};
  for (const stageId of Object.keys(dag)) {
    stages[stageId] = {
      status: STAGE_STATUS.PENDING,
      agent: null,
      verdict: null,
      contextFile: null,  // Phase 2：context file 路徑（stage 完成時寫入）
    };
  }
  return _touch({
    ...state,
    dag,
    blueprint: blueprint || null,
    pipelineActive: true,  // DAG 建立即啟動 guard
    stages,
  });
}

/**
 * 設定 stage 的 contextFile 路徑（Phase 2）
 *
 * 當 stage 完成並產出 context file 時呼叫，
 * 供下一個 stage 的 Node Context 透傳使用。
 *
 * @param {Object} state - pipeline state
 * @param {string} stageId - stage ID
 * @param {string|null} contextFilePath - context file 路徑（null 表示無產出）
 * @returns {Object} 更新後的 state
 */
function setStageContextFile(state, stageId, contextFilePath) {
  if (!state?.stages?.[stageId]) return state;
  return _touch({
    ...state,
    stages: {
      ...state.stages,
      [stageId]: {
        ...(state.stages[stageId] || {}),
        contextFile: contextFilePath || null,
      },
    },
  });
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

/** 取消 pipeline（設定 pipelineActive=false，guard 放行） */
function cancelPipeline(state) {
  return _touch({
    ...state,
    pipelineActive: false,  // 取消即停止 guard
  });
}

/** 重設 state（新任務） */
function reset(state) {
  return createInitialState(state.sessionId, {
    environment: state.environment,
    openspecEnabled: state.openspecEnabled,
    pipelineRules: state.meta?.pipelineRules || [],
  });
}

/**
 * 重設 state 但保留前一個分類（供 reclassification 追蹤）
 *
 * COMPLETE → 新 pipeline 時使用。reset() 會清空 classification，
 * 導致 ds.classify() 無法記錄 from→to 的升級歷史。
 * 此函式保留舊的 classification + reclassifications，
 * 讓後續 classify() 能正確追蹤 pipeline 變更。
 */
function resetKeepingClassification(state) {
  const fresh = createInitialState(state.sessionId, {
    environment: state.environment,
    openspecEnabled: state.openspecEnabled,
    pipelineRules: state.meta?.pipelineRules || [],
  });
  fresh.classification = state.classification;
  fresh.meta.reclassifications = state.meta?.reclassifications || [];
  return fresh;
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
  // v4（任務 3.6）：改用 atomicWrite 確保原子寫入（write .tmp → rename）
  atomicWrite(getStatePath(sessionId), state);
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
  setStageContextFile,
  markStageActive,
  markStageCompleted,
  markStageSkipped,
  markStageFailed,
  setPendingRetry,
  clearPendingRetry,
  resetStageToPending,
  cancel: cancelPipeline,
  reset,
  resetKeepingClassification,

  // Phase derivation
  derivePhase,

  // DAG queries
  getReadyStages,
  getActiveStages,
  getCompletedStages,
  getSkippedStages,

  // 核心查詢
  isActive,

  // 衍生查詢
  isComplete,
  getPipelineId,
  getRetries,
  getPendingRetry,
  getCurrentStage,

  // I/O
  getStatePath,
  readState,
  writeState,
  deleteState,
};
