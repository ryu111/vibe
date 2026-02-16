/**
 * skip-rules.js — 智慧跳過規則（純函式）
 *
 * 判斷 pipeline 中的某個階段是否應該被跳過。
 * 目前支援：DESIGN（純後端/CLI 不需視覺設計）、E2E（純 API 不需瀏覽器測試）。
 *
 * @module flow/skip-rules
 */
'use strict';

const { FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS } = require('../registry.js');

/**
 * 判斷指定階段是否應跳過
 * @param {string} stage - 候選階段名稱
 * @param {Object} state - Pipeline state
 * @param {string[]} pipelineStages - 當前 pipeline 的階段列表
 * @returns {{ skip: boolean, reason: string }}
 */
function shouldSkipStage(stage, state, pipelineStages) {
  const isInPipeline = pipelineStages.includes(stage);
  if (!isInPipeline) return { skip: false, reason: '' };

  const envInfo = state.environment || {};
  const frameworkName = ((envInfo.framework && envInfo.framework.name) || '').toLowerCase();

  if (stage === 'DESIGN') {
    // 明確標記 needsDesign 或偵測到前端框架 → 不跳過
    if (state.needsDesign === true) return { skip: false, reason: '' };
    if (FRONTEND_FRAMEWORKS.some(f => frameworkName.includes(f))) return { skip: false, reason: '' };
    return { skip: true, reason: 'DESIGN（純後端/CLI 專案不需視覺設計）' };
  }

  if (stage === 'E2E') {
    if (API_ONLY_FRAMEWORKS.includes(frameworkName)) {
      return { skip: true, reason: 'E2E（純 API 專案不需瀏覽器測試）' };
    }
  }

  return { skip: false, reason: '' };
}

/**
 * 從 candidate 開始，找到第一個不該跳過的階段
 * @param {string} startStage - 起始候選階段
 * @param {number} startIndex - 起始在 pipelineStages 中的 index
 * @param {Object} state - Pipeline state
 * @param {string[]} pipelineStages - 當前 pipeline 的階段列表
 * @param {Object} stageMap - stage → agent 映射
 * @param {Function} findNext - findNextStageInPipeline 函式
 * @returns {{ stage: string|null, index: number, skipped: string[] }}
 */
function resolveNextStage(startStage, startIndex, state, pipelineStages, stageMap, findNext) {
  let candidate = startStage;
  let candidateIndex = startIndex;
  const skipped = [];

  while (candidate) {
    const result = shouldSkipStage(candidate, state, pipelineStages);
    if (!result.skip) break;

    skipped.push(result.reason);
    // 記錄到 state.skippedStages
    if (!state.skippedStages) state.skippedStages = [];
    if (!state.skippedStages.includes(candidate)) {
      state.skippedStages.push(candidate);
    }
    // 查找再下一個
    const nextResult = findNext(pipelineStages, stageMap, candidate, candidateIndex);
    candidate = nextResult.stage;
    candidateIndex = nextResult.index;
  }

  return { stage: candidate, index: candidateIndex, skipped };
}

module.exports = { shouldSkipStage, resolveNextStage };
