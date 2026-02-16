#!/usr/bin/env node
/**
 * state-machine.js — Pipeline FSM 核心模組
 *
 * v2.0.0 重構：顯式有限狀態機取代 flag-based 隱式狀態。
 *
 * Phase 狀態圖：
 *   IDLE → CLASSIFIED → DELEGATING → CLASSIFIED (advance)
 *                 ↑         ↓              ↗
 *                 ↑     RETRYING ──→ DELEGATING
 *                 ↑         ↓
 *                 ↑     COMPLETE
 *                 └─────────┘ (RESET)
 *
 * 設計原則：
 * 1. 單一 phase 欄位 — 取代 5+ boolean flags
 * 2. 集中 transition() — 驗證合法轉換，拒絕不合法操作
 * 3. context 不可變 — 分類時設定，執行期不變（解決 autoEnforce 副作用）
 * 4. progress 由 transition 統一修改 — 不散佈在多個 hook
 * 5. 衍生查詢 — 取代直接讀 flag
 *
 * @module flow/state-machine
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ────────────────── Phase 定義 ──────────────────

const PHASES = {
  IDLE: 'IDLE',             // 已初始化，未分類或 none pipeline
  CLASSIFIED: 'CLASSIFIED', // 已分類，等待委派
  DELEGATING: 'DELEGATING', // Sub-agent 執行中
  RETRYING: 'RETRYING',     // 品質失敗，等待回退委派 DEV
  COMPLETE: 'COMPLETE',     // Pipeline 所有階段完成
};

// 合法轉換表（from → allowed actions）
const VALID_TRANSITIONS = {
  [PHASES.IDLE]: ['CLASSIFY', 'DELEGATE', 'CANCEL'],
  [PHASES.CLASSIFIED]: ['DELEGATE', 'RECLASSIFY', 'RESET', 'CANCEL'],
  [PHASES.DELEGATING]: ['STAGE_DONE', 'CANCEL'],
  [PHASES.RETRYING]: ['DELEGATE', 'RECLASSIFY', 'CANCEL'],
  [PHASES.COMPLETE]: ['CLASSIFY', 'RESET', 'CANCEL'],
};

// ────────────────── 初始化 ──────────────────

/**
 * 建立初始 state（pipeline-init 使用）
 * @param {string} sessionId
 * @param {object} options - { environment, openspecEnabled, pipelineRules }
 * @returns {object} 新 state
 */
function createInitialState(sessionId, options = {}) {
  return {
    sessionId,
    phase: PHASES.IDLE,

    context: {
      pipelineId: null,
      taskType: null,
      expectedStages: [],
      environment: options.environment || {},
      openspecEnabled: options.openspecEnabled || false,
      pipelineRules: options.pipelineRules || [],
      needsDesign: false,
    },

    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },

    meta: {
      initialized: true,
      classifiedAt: null,
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  };
}

// ────────────────── 核心 Transition ──────────────────

/**
 * 執行狀態轉換
 *
 * @param {object} state - 當前 state
 * @param {object} action - { type: string, ...params }
 * @returns {object} 新 state（不可變）
 * @throws {Error} 不合法轉換
 */
function transition(state, action) {
  const phase = state.phase || PHASES.IDLE;
  const actionType = action.type;

  // 驗證轉換合法性
  const allowed = VALID_TRANSITIONS[phase];
  if (!allowed || !allowed.includes(actionType)) {
    throw new Error(`Invalid transition: ${phase} + ${actionType}`);
  }

  const handler = HANDLERS[actionType];
  if (!handler) {
    throw new Error(`Unknown action type: ${actionType}`);
  }

  return handler(state, action);
}

// ────────────────── Action Handlers ──────────────────

const HANDLERS = {

  /**
   * CLASSIFY — 任務分類（task-classifier）
   * IDLE → CLASSIFIED（有 pipeline）或 IDLE（none）
   * COMPLETE → CLASSIFIED（新任務）
   */
  CLASSIFY(state, action) {
    const { pipelineId, taskType, expectedStages, source, confidence, matchedRule, layer } = action;
    const isNone = pipelineId === 'none' || !expectedStages || expectedStages.length === 0;

    // 從 COMPLETE 來的要先重設 progress
    const progress = state.phase === PHASES.COMPLETE
      ? createEmptyProgress()
      : { ...state.progress };

    return {
      ...state,
      phase: isNone ? PHASES.IDLE : PHASES.CLASSIFIED,
      context: {
        ...state.context,
        pipelineId,
        taskType,
        expectedStages: expectedStages || [],
      },
      progress,
      meta: {
        ...state.meta,
        classifiedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        classificationSource: source || null,
        classificationConfidence: confidence || null,
        matchedRule: matchedRule || null,
        layer: layer || null,
        cancelled: false,
      },
    };
  },

  /**
   * DELEGATE — 委派 sub-agent（delegation-tracker）
   * CLASSIFIED → DELEGATING
   * RETRYING → DELEGATING
   * IDLE → DELEGATING（手動觸發，自動推導 context）
   */
  DELEGATE(state, action) {
    const { stage, agentType } = action;

    // IDLE 時的手動觸發：自動推導 context（取代 autoEnforce）
    let context = { ...state.context };
    if (state.phase === PHASES.IDLE && !context.pipelineId) {
      // 手動觸發 pipeline agent，自動設定 context
      // 具體 pipelineId 由呼叫者提供或由 stage-transition 後續補齊
      context = {
        ...context,
        pipelineId: action.pipelineId || null,
        taskType: action.taskType || 'feature',
        expectedStages: action.expectedStages || [],
      };
    }

    return {
      ...state,
      phase: PHASES.DELEGATING,
      context,
      progress: {
        ...state.progress,
        currentStage: stage || state.progress.currentStage,
      },
      meta: {
        ...state.meta,
        lastTransition: new Date().toISOString(),
      },
    };
  },

  /**
   * STAGE_DONE — 階段完成（stage-transition）
   * DELEGATING → CLASSIFIED（前進）/ RETRYING（回退）/ COMPLETE（完成）
   */
  STAGE_DONE(state, action) {
    const {
      stage, agentType, verdict, nextStage,
      shouldRetry, retryCount, isComplete: done,
      skippedStages: newSkipped, stageIndex,
      pendingRetry,
    } = action;

    // 更新 progress
    const completedAgents = [...state.progress.completedAgents];
    if (agentType && !completedAgents.includes(agentType)) {
      completedAgents.push(agentType);
    }

    const stageResults = { ...state.progress.stageResults };
    if (stage && verdict) {
      stageResults[stage] = verdict;
    }

    const retries = { ...state.progress.retries };
    if (shouldRetry && stage) {
      retries[stage] = (retries[stage] || 0) + 1;
    }

    const skippedStages = newSkipped
      ? [...new Set([...state.progress.skippedStages, ...newSkipped])]
      : [...state.progress.skippedStages];

    // 決定新 phase
    let newPhase;
    if (done) {
      newPhase = PHASES.COMPLETE;
    } else if (shouldRetry) {
      newPhase = PHASES.RETRYING;
    } else {
      newPhase = PHASES.CLASSIFIED;
    }

    return {
      ...state,
      phase: newPhase,
      progress: {
        currentStage: nextStage || state.progress.currentStage,
        stageIndex: typeof stageIndex === 'number' ? stageIndex : state.progress.stageIndex,
        completedAgents,
        stageResults,
        retries,
        skippedStages,
        pendingRetry: pendingRetry !== undefined ? pendingRetry : state.progress.pendingRetry,
      },
      meta: {
        ...state.meta,
        lastTransition: new Date().toISOString(),
      },
    };
  },

  /**
   * RECLASSIFY — 重新分類 / Pipeline 升級（task-classifier）
   * CLASSIFIED → CLASSIFIED
   */
  RECLASSIFY(state, action) {
    const { oldPipelineId, newPipelineId, newTaskType, newExpectedStages, remainingStages, skippedByUpgrade, source, confidence, matchedRule, layer } = action;

    const reclassifications = [...(state.meta.reclassifications || [])];
    reclassifications.push({
      from: oldPipelineId,
      to: newPipelineId,
      at: new Date().toISOString(),
      skippedStages: skippedByUpgrade || [],
    });

    return {
      ...state,
      phase: PHASES.CLASSIFIED,
      context: {
        ...state.context,
        pipelineId: newPipelineId,
        taskType: newTaskType,
        expectedStages: newExpectedStages || [],
      },
      meta: {
        ...state.meta,
        lastTransition: new Date().toISOString(),
        classificationSource: source || state.meta.classificationSource,
        classificationConfidence: confidence || state.meta.classificationConfidence,
        matchedRule: matchedRule || state.meta.matchedRule,
        layer: layer || state.meta.layer,
        reclassifications,
      },
    };
  },

  /**
   * RESET — 重設 state（新任務 / stale pipeline）
   * 任何 phase → IDLE
   */
  RESET(state) {
    return {
      ...state,
      phase: PHASES.IDLE,
      context: {
        ...state.context,
        pipelineId: null,
        taskType: null,
        expectedStages: [],
        needsDesign: false,
      },
      progress: createEmptyProgress(),
      meta: {
        ...state.meta,
        lastTransition: new Date().toISOString(),
        classifiedAt: null,
        classificationSource: null,
        classificationConfidence: null,
        matchedRule: null,
        layer: null,
        reclassifications: [],
        llmClassification: null,
        correctionCount: 0,
        cancelled: false,
      },
    };
  },

  /**
   * CANCEL — 使用者取消 pipeline
   * 任何 phase → IDLE
   */
  CANCEL(state) {
    return {
      ...state,
      phase: PHASES.IDLE,
      meta: {
        ...state.meta,
        lastTransition: new Date().toISOString(),
        cancelled: true,
      },
    };
  },
};

// ────────────────── 衍生查詢 ──────────────────

/** 取得當前 phase */
function getPhase(state) {
  return (state && state.phase) || PHASES.IDLE;
}

/** Sub-agent 是否正在執行 */
function isDelegating(state) {
  return getPhase(state) === PHASES.DELEGATING;
}

/** Pipeline 是否為強制模式（CLASSIFIED/DELEGATING/RETRYING 都是強制的） */
function isEnforced(state) {
  const phase = getPhase(state);
  return phase === PHASES.CLASSIFIED || phase === PHASES.DELEGATING || phase === PHASES.RETRYING;
}

/** Pipeline 是否完成 */
function isComplete(state) {
  return getPhase(state) === PHASES.COMPLETE;
}

/** 取得當前階段 */
function getCurrentStage(state) {
  return state?.progress?.currentStage || null;
}

/** 取得 Pipeline ID */
function getPipelineId(state) {
  return state?.context?.pipelineId || null;
}

/** 取得任務類型 */
function getTaskType(state) {
  return state?.context?.taskType || null;
}

/** 取得預期階段列表 */
function getExpectedStages(state) {
  return state?.context?.expectedStages || [];
}

/** 取得已完成 agents */
function getCompletedAgents(state) {
  return state?.progress?.completedAgents || [];
}

/** 取得階段結果 */
function getStageResults(state) {
  return state?.progress?.stageResults || {};
}

/** 取得重試計數 */
function getRetries(state) {
  return state?.progress?.retries || {};
}

/** 取得待回退資訊 */
function getPendingRetry(state) {
  return state?.progress?.pendingRetry || null;
}

/** 取得已跳過階段 */
function getSkippedStages(state) {
  return state?.progress?.skippedStages || [];
}

/** 取得 stageIndex */
function getStageIndex(state) {
  return state?.progress?.stageIndex || 0;
}

/** 取得環境資訊 */
function getEnvironment(state) {
  return state?.context?.environment || {};
}

/** OpenSpec 是否啟用 */
function isOpenSpecEnabled(state) {
  return !!state?.context?.openspecEnabled;
}

/** 是否已初始化 */
function isInitialized(state) {
  return !!state?.meta?.initialized;
}

/** 是否已取消 */
function isCancelled(state) {
  return !!state?.meta?.cancelled;
}

/** 是否已分類（有 pipelineId） */
function isClassified(state) {
  return !!state?.context?.pipelineId;
}

// ────────────────── I/O 工具 ──────────────────

/**
 * 取得 state 檔案路徑
 * @param {string} sessionId
 * @returns {string}
 */
function getStatePath(sessionId) {
  return path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
}

/**
 * 讀取 state（回傳 null 如不存在）
 * @param {string} sessionId
 * @returns {object|null}
 */
function readState(sessionId) {
  const statePath = getStatePath(sessionId);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 寫入 state
 * @param {string} sessionId
 * @param {object} state
 */
function writeState(sessionId, state) {
  const statePath = getStatePath(sessionId);
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * 刪除 state 檔案
 * @param {string} sessionId
 */
function deleteState(sessionId) {
  const statePath = getStatePath(sessionId);
  try { fs.unlinkSync(statePath); } catch (_) {}
}

// ────────────────── 內部工具 ──────────────────

function createEmptyProgress() {
  return {
    currentStage: null,
    stageIndex: 0,
    completedAgents: [],
    stageResults: {},
    retries: {},
    skippedStages: [],
    pendingRetry: null,
  };
}

// ────────────────── Exports ──────────────────

module.exports = {
  // Constants
  PHASES,

  // Lifecycle
  createInitialState,
  transition,

  // Derived Queries
  getPhase,
  isDelegating,
  isEnforced,
  isComplete,
  getCurrentStage,
  getPipelineId,
  getTaskType,
  getExpectedStages,
  getCompletedAgents,
  getStageResults,
  getRetries,
  getPendingRetry,
  getSkippedStages,
  getStageIndex,
  getEnvironment,
  isOpenSpecEnabled,
  isInitialized,
  isCancelled,
  isClassified,

  // I/O
  getStatePath,
  readState,
  writeState,
  deleteState,
};
