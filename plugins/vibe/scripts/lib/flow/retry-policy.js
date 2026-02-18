#!/usr/bin/env node
/**
 * retry-policy.js — 回退策略（純函式）
 *
 * shouldStop 判斷條件：
 * 1. PASS → stop（成功）
 * 2. retryCount >= maxRetries → stop（達上限）
 * 3. 趨勢分析 — 記錄趨勢（不停止，附加資訊）
 *
 * 注意：收斂停滯（連續同 severity）不觸發 stop，
 * 因為只有 retryCount >= maxRetries 才是強制停止的合法條件。
 *
 * @module flow/retry-policy
 */
'use strict';

const { QUALITY_STAGES, MAX_RETRIES } = require('../registry.js');

// ────────────────── v4 shouldStop ──────────────────

/**
 * 判斷是否應停止回退（v4 多條件版本）
 *
 * @param {string} stage - 當前階段
 * @param {{ verdict: string, severity?: string }|null} verdict - 解析結果
 * @param {number} retryCount - 已回退次數
 * @param {Array<{ verdict: string, severity: string, round: number }>} retryHistory - 歷史回退記錄
 * @param {number} [maxRetries] - 最大回退次數（預設 MAX_RETRIES）
 * @returns {{ stop: boolean, reason: string, action: 'NEXT'|'FORCE_NEXT'|'RETRY', trend?: string }}
 */
function shouldStop(stage, verdict, retryCount, retryHistory = [], maxRetries = MAX_RETRIES) {
  // 條件 1：PASS → 停止（成功）
  if (verdict && verdict.verdict === 'PASS') {
    return { stop: true, reason: 'PASS', action: 'NEXT' };
  }

  // 條件 2：retryCount >= maxRetries → 停止（達上限）
  if (retryCount >= maxRetries) {
    return {
      stop: true,
      reason: `已達回退上限（${retryCount}/${maxRetries}）`,
      action: 'FORCE_NEXT',
    };
  }

  // 條件 3：趨勢分析（僅記錄，不停止）
  // 收斂停滯（連續同 severity）只作為觀察信號，不觸發強制停止，
  // 因為 retryCount < maxRetries 時仍應允許回退。
  const trend = analyzeTrend(retryHistory);
  const stagnation = detectStagnation(retryHistory);

  return {
    stop: false,
    reason: `繼續回退（第 ${retryCount + 1} 輪）`,
    action: 'RETRY',
    ...(trend ? { trend } : {}),
    ...(stagnation ? { stagnation } : {}),
  };
}

/**
 * 偵測收斂停滯（最近 2 輪同 severity）
 * 純觀察，不觸發停止。
 * @param {Array<{ severity: string }>} retryHistory
 * @returns {string|null} 停滯的 severity 字串，或 null
 */
function detectStagnation(retryHistory) {
  if (!retryHistory || retryHistory.length < 2) return null;
  const last2 = retryHistory.slice(-2);
  const allSame = last2.every(h => h.severity === last2[0].severity);
  return (allSame && last2[0].severity) ? last2[0].severity : null;
}

/**
 * 分析 retryHistory 趨勢（純函式，不觸發停止）
 * @param {Array<{ severity: string }>} retryHistory
 * @returns {string|null} 'improving' | 'worsening' | 'stable' | null
 */
function analyzeTrend(retryHistory) {
  if (!retryHistory || retryHistory.length < 2) return null;

  const severityRank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  const recent = retryHistory.slice(-2);
  const prev = severityRank[recent[0]?.severity] || 0;
  const curr = severityRank[recent[1]?.severity] || 0;

  if (curr < prev) return 'improving';
  if (curr > prev) return 'worsening';
  return 'stable';
}

module.exports = {
  shouldStop,
  analyzeTrend,
  detectStagnation,
  MAX_RETRIES,
  QUALITY_STAGES,
};
