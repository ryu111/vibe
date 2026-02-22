#!/usr/bin/env node
/**
 * skip-predicates.js — 階段跳過判斷（純函式）
 *
 * 取代 skip-rules.js。更簡單的 API：
 * shouldSkip(stageId, state) → boolean
 *
 * 目前支援：
 * - DESIGN：純後端/CLI 不需視覺設計
 * - E2E：純 API 不需瀏覽器測試
 *
 * @module flow/skip-predicates
 */
'use strict';

const { FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS } = require('../registry.js');
const { getBaseStage } = require('./dag-utils.js');

/**
 * 判斷指定 stage 是否應跳過
 * @param {string} stageId - stage ID（可含後綴如 TEST:write）
 * @param {Object} state - Pipeline v3 state
 * @returns {{ skip: boolean, reason: string }}
 */
function shouldSkip(stageId, state) {
  const base = getBaseStage(stageId);
  const env = state.environment || {};
  const frameworkName = ((env.framework?.name) || '').toLowerCase();

  if (base === 'DESIGN') {
    // 明確標記 needsDesign → 不跳
    if (state.needsDesign === true) return { skip: false, reason: '' };
    // pipeline 選擇含 DESIGN 意圖（full/ui-only）→ 不跳
    const pid = state.classification?.pipelineId;
    if (pid === 'full' || pid === 'ui-only') return { skip: false, reason: '' };
    // 偵測到前端框架或前端信號 → 不跳
    if (env.frontend?.detected) return { skip: false, reason: '' };
    if (FRONTEND_FRAMEWORKS.some(f => frameworkName.includes(f))) return { skip: false, reason: '' };
    return { skip: true, reason: '純後端/CLI 專案不需視覺設計' };
  }

  if (base === 'E2E') {
    if (API_ONLY_FRAMEWORKS.includes(frameworkName)) {
      return { skip: true, reason: '純 API 專案不需瀏覽器測試' };
    }
  }

  return { skip: false, reason: '' };
}

module.exports = { shouldSkip };
