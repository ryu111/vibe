#!/usr/bin/env node
/**
 * retry-policy.js — 回退策略（純函式）
 *
 * 品質階段（REVIEW/TEST/QA/E2E）失敗時的回退決策邏輯。
 * FAIL:CRITICAL/HIGH → 回退到 DEV，每個階段最多 MAX_RETRIES 輪。
 * FAIL:MEDIUM/LOW → 不回退（只是建議）。
 *
 * @module flow/retry-policy
 */
'use strict';

const { QUALITY_STAGES, MAX_RETRIES } = require('../registry.js');

/**
 * 判斷是否需要回退到 DEV 修復
 * @param {string} currentStage - 當前階段
 * @param {{ verdict: string, severity: string|null }|null} verdict - 解析結果
 * @param {number} retryCount - 已回退次數
 * @returns {{ shouldRetry: boolean, reason: string }}
 */
function shouldRetryStage(currentStage, verdict, retryCount) {
  // 非品質階段 → 不回退
  if (!QUALITY_STAGES.includes(currentStage)) {
    return { shouldRetry: false, reason: '' };
  }

  // 沒有 verdict → 無法判斷，繼續前進
  if (!verdict) {
    return { shouldRetry: false, reason: '無法解析 agent 結論' };
  }

  // PASS → 不回退
  if (verdict.verdict === 'PASS') {
    return { shouldRetry: false, reason: '' };
  }

  // FAIL:MEDIUM/LOW → 不回退（只是建議）
  if (verdict.severity === 'MEDIUM' || verdict.severity === 'LOW') {
    return { shouldRetry: false, reason: `${verdict.severity} 等級問題不需回退` };
  }

  // FAIL:CRITICAL/HIGH → 回退（除非超過上限）
  if (retryCount >= MAX_RETRIES) {
    return { shouldRetry: false, reason: `已達回退上限（${MAX_RETRIES} 輪）` };
  }

  return { shouldRetry: true, reason: `${verdict.severity} 等級問題需要修復` };
}

module.exports = { shouldRetryStage, MAX_RETRIES, QUALITY_STAGES };
