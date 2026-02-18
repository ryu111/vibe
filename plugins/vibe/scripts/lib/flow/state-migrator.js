#!/usr/bin/env node
/**
 * state-migrator.js — Pipeline State 自動遷移（v2 → v3 → v4）
 *
 * 當 readState() 讀到舊版 state 時，自動轉換為 v4 結構。
 * 遷移是無損的：保留所有已完成的進度。
 *
 * @module flow/state-migrator
 */
'use strict';

const { PIPELINES } = require('../registry.js');
const { STAGE_STATUS } = require('./dag-state.js');
const { linearToDag } = require('./dag-utils.js');

/**
 * 偵測 state 版本
 * @param {Object} state
 * @returns {number} 2、3、4、或 0（未知）
 */
function detectVersion(state) {
  if (!state) return 0;
  if (state.version === 4) return 4;
  if (state.version === 3) return 3;
  // v2 特徵：有 phase + context.pipelineId
  if (state.phase && state.context) return 2;
  return 0;
}

/**
 * 從 v2 completedAgents 推導已完成的 stages
 * @param {string[]} completedAgents
 * @param {Object} agentToStage - agent name → stage 映射
 * @returns {Set<string>}
 */
function deriveCompletedFromAgents(completedAgents, agentToStage) {
  const completed = new Set();
  for (const agent of (completedAgents || [])) {
    const stage = agentToStage[agent];
    if (stage) completed.add(stage);
  }
  return completed;
}

/**
 * 將 v2 state 遷移為 v3 結構
 * @param {Object} v2State - v2 格式的 state
 * @param {Object} [agentToStage] - agent name → stage 映射（可選，預設使用 registry）
 * @returns {Object} v3 格式的 state
 */
function migrateV2toV3(v2State, agentToStage) {
  if (!v2State) return null;

  // 提取 v2 欄位
  const ctx = v2State.context || {};
  const progress = v2State.progress || {};
  const meta = v2State.meta || {};

  // 取得 pipeline stages
  const pipelineId = ctx.pipelineId;
  const pipelineStages = (pipelineId && PIPELINES[pipelineId])
    ? PIPELINES[pipelineId].stages
    : (ctx.expectedStages || []);

  // 建立 DAG（線性）
  const dag = pipelineStages.length > 0 ? linearToDag(pipelineStages) : null;

  // 推導各 stage 狀態
  const stages = {};
  if (dag) {
    // 用 agent → stage 映射推導已完成的 stages
    const { AGENT_TO_STAGE, NAMESPACED_AGENT_TO_STAGE } = require('../registry.js');
    const atsMerged = { ...(agentToStage || {}), ...AGENT_TO_STAGE, ...NAMESPACED_AGENT_TO_STAGE };
    const completedSet = deriveCompletedFromAgents(progress.completedAgents, atsMerged);
    const skippedSet = new Set(progress.skippedStages || []);

    for (const stageId of Object.keys(dag)) {
      if (completedSet.has(stageId)) {
        stages[stageId] = {
          status: STAGE_STATUS.COMPLETED,
          agent: null,
          verdict: progress.stageResults?.[stageId] || null,
          completedAt: meta.lastTransition || null,
        };
      } else if (skippedSet.has(stageId)) {
        stages[stageId] = {
          status: STAGE_STATUS.SKIPPED,
          reason: 'v2 migration',
        };
      } else if (stageId === progress.currentStage && v2State.phase === 'DELEGATING') {
        stages[stageId] = {
          status: STAGE_STATUS.ACTIVE,
          agent: null,
          startedAt: meta.lastTransition || null,
        };
      } else {
        stages[stageId] = {
          status: STAGE_STATUS.PENDING,
          agent: null,
          verdict: null,
        };
      }
    }
  }

  // 遷移 pendingRetry
  let pendingRetry = null;
  if (progress.pendingRetry) {
    const pr = progress.pendingRetry;
    pendingRetry = {
      stages: [{
        id: pr.stage,
        severity: pr.severity,
        round: pr.round || 1,
      }],
    };
  }

  return {
    version: 3,
    sessionId: v2State.sessionId,

    classification: pipelineId ? {
      pipelineId,
      taskType: ctx.taskType || null,
      source: meta.classificationSource || 'migrated',
      classifiedAt: meta.classifiedAt || new Date().toISOString(),
    } : null,

    environment: ctx.environment || {},
    openspecEnabled: ctx.openspecEnabled || false,
    needsDesign: ctx.needsDesign || false,

    dag,
    blueprint: null, // v2 沒有 blueprint

    stages,
    retries: progress.retries || {},
    pendingRetry,

    meta: {
      initialized: true,
      cancelled: meta.cancelled || false,
      lastTransition: meta.lastTransition || new Date().toISOString(),
      reclassifications: meta.reclassifications || [],
      pipelineRules: ctx.pipelineRules || [],
      migratedFrom: 'v2',
      migratedAt: new Date().toISOString(),
    },
  };
}

/**
 * 自動偵測版本並遷移（如需要）
 * @param {Object} state
 * @param {Object} [agentToStage]
 * @returns {Object} v3 state
 */
function ensureV3(state, agentToStage) {
  if (!state) return null;
  const version = detectVersion(state);
  if (version === 3) return state;
  if (version === 4) return state; // v4 也是相容的（ensureV3 的語意是「至少 v3」）
  if (version === 2) return migrateV2toV3(state, agentToStage);
  return null; // 無法辨識
}

/**
 * v3 → v4 State 遷移
 *
 * 新增 v4 欄位：pipelineActive、activeStages（正式化）、retryHistory、crashes。
 * 從既有 v3 欄位推導 pipelineActive。
 *
 * @param {Object} v3State - v3 格式的 state
 * @returns {Object} v4 格式的 state
 */
function migrateV3toV4(v3State) {
  if (!v3State) return null;

  // v3 未初始化（meta.initialized 非 true）→ pipelineActive=false（未就緒）
  if (!v3State.meta?.initialized) {
    return {
      ...v3State,
      version: 4,
      pipelineActive: false,
      activeStages: [],
      retryHistory: {},
      crashes: {},
    };
  }

  // 推導 pipelineActive：從 v3 欄位直接推導（不經 derivePhase，因為 v3 無 pipelineActive）
  // 條件：有 DAG + 未取消 + 有分類的非 trivial pipeline + 未全部完成
  const pid = v3State?.classification?.pipelineId;
  const v3Enforced = !!(pid && pid !== 'none');
  const v3Cancelled = !!v3State.meta?.cancelled;
  let v3Complete = false;
  if (v3State.dag) {
    const stageIds = Object.keys(v3State.dag);
    if (stageIds.length > 0) {
      v3Complete = stageIds.every(id => {
        const s = (v3State.stages || {})[id]?.status;
        return s === STAGE_STATUS.COMPLETED || s === STAGE_STATUS.SKIPPED;
      });
    }
  }
  const pipelineActive = v3Enforced && !v3Cancelled && !!v3State.dag && !v3Complete;

  // 從 stages 中 status=active 推導 activeStages
  const activeStages = [];
  const stages = v3State.stages || {};
  for (const [stageId, stageInfo] of Object.entries(stages)) {
    if (stageInfo?.status === STAGE_STATUS.ACTIVE) {
      activeStages.push(stageId);
    }
  }

  // retryHistory 從 retries 推導空陣列（每個 stage 有 retry → 初始化為空陣列供追加）
  const retryHistory = {};
  for (const stageId of Object.keys(v3State.retries || {})) {
    retryHistory[stageId] = [];
  }

  return {
    ...v3State,
    version: 4,
    pipelineActive,
    activeStages,
    retryHistory,
    crashes: {},
  };
}

/**
 * 確保 state 為 v4 結構（自動從 v2/v3 遷移）
 * @param {Object} state
 * @param {Object} [agentToStage]
 * @returns {Object} v4 state
 */
function ensureV4(state, agentToStage) {
  if (!state) return null;
  const version = detectVersion(state);

  if (version === 4) return state;
  if (version === 3) return migrateV3toV4(state);
  if (version === 2) {
    const v3 = migrateV2toV3(state, agentToStage);
    return v3 ? migrateV3toV4(v3) : null;
  }
  return null; // 無法辨識
}

module.exports = { detectVersion, migrateV2toV3, ensureV3, migrateV3toV4, ensureV4 };
