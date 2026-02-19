#!/usr/bin/env node
/**
 * state-migrator.js — Pipeline State 自動遷移（v3 → v4）
 *
 * 當 readState() 讀到 v3 state 時，自動轉換為 v4 結構。
 * 遷移是無損的：保留所有已完成的進度。
 *
 * v2 格式（phase + context + progress）已不支援，
 * 若讀到 v2 或未知格式，回傳 null。
 *
 * @module flow/state-migrator
 */
'use strict';

const { STAGE_STATUS } = require('./dag-state.js');

/**
 * 偵測 state 版本
 * @param {Object} state
 * @returns {number} 3、4、或 0（不支援）
 */
function detectVersion(state) {
  if (!state) return 0;
  if (state.version === 4) return 4;
  if (state.version === 3) return 3;
  return 0;
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
 * 確保 state 為 v4 結構（自動從 v3 遷移）
 * v2 或未知格式回傳 null。
 * @param {Object} state
 * @returns {Object|null} v4 state
 */
function ensureV4(state) {
  if (!state) return null;
  const version = detectVersion(state);

  if (version === 4) return state;
  if (version === 3) return migrateV3toV4(state);
  return null; // v2 或未知格式不再支援
}

module.exports = { detectVersion, migrateV3toV4, ensureV4 };
