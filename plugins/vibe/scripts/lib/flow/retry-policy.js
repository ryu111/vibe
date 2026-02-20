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

// ────────────────── shouldStop ──────────────────

/**
 * 判斷是否應停止回退（多條件版本）
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

// ────────────────── adaptiveRetryLimit ──────────────────

/**
 * 自適應重試上限 — 根據趨勢動態調整 maxRetries。
 *
 * 策略：
 * - worsening → max(1, baseLimit - 1)（提早放棄，避免浪費 token）
 * - improving → baseLimit + 1（允許額外一輪，因為有改善跡象）
 * - stable/null → baseLimit（不調整）
 *
 * 硬下限：1（至少一次重試機會）
 * 硬上限：baseLimit + 1（不允許無限膨脹）
 *
 * @param {number} baseLimit - 原始 maxRetries（通常從 registry.js MAX_RETRIES 取得）
 * @param {Array} retryHistory - 該 stage 的 retryHistory
 * @param {string|null} trend - analyzeTrend() 的回傳值
 * @returns {number} 調整後的 maxRetries
 */
function adaptiveRetryLimit(baseLimit, retryHistory, trend) {
  // 防呆：baseLimit 必須是正整數
  if (!baseLimit || typeof baseLimit !== 'number' || baseLimit < 1) return 1;

  switch (trend) {
    case 'worsening':
      // 趨勢惡化，提早放棄（硬下限 1）
      return Math.max(1, baseLimit - 1);
    case 'improving':
      // 趨勢改善，允許額外一輪（硬上限 baseLimit + 1）
      return baseLimit + 1;
    case 'stable':
    default:
      // 穩定或無趨勢，維持原設定
      return baseLimit;
  }
}

// ────────────────── detectDuplicateHints ──────────────────

/**
 * 偵測重複 hint — 連續兩輪的 severity + hint 相同。
 *
 * 比較邏輯：
 * - retryHistory 最後兩筆的 severity 相同
 * - hint 前 50 字元相同（精確前綴匹配，不用模糊算法）
 *
 * 用途：當 agent 連續給出相同問題的相同建議但 DEV 未改善時，
 * 強調必須採用完全不同的修復策略。
 *
 * @param {Array<{severity?: string, hint?: string}>} retryHistory
 * @returns {{ isDuplicate: boolean, consecutiveCount: number }}
 */
function detectDuplicateHints(retryHistory) {
  // 防呆：陣列為空或不足兩筆，無法比較
  if (!Array.isArray(retryHistory) || retryHistory.length < 2) {
    return { isDuplicate: false, consecutiveCount: 0 };
  }

  const HINT_PREFIX_LEN = 50;
  const last = retryHistory[retryHistory.length - 1];
  const prev = retryHistory[retryHistory.length - 2];

  // severity 必須相同（null/undefined 視為不同）
  if (last.severity !== prev.severity || last.severity === undefined) {
    return { isDuplicate: false, consecutiveCount: 0 };
  }

  // hint 前 50 字元比較（兩者都必須有實際內容才比較）
  const lastHint = (last.hint || '').slice(0, HINT_PREFIX_LEN);
  const prevHint = (prev.hint || '').slice(0, HINT_PREFIX_LEN);

  // 兩者都必須非空字串才進行比較
  if (!lastHint || !prevHint || lastHint !== prevHint) {
    return { isDuplicate: false, consecutiveCount: 0 };
  }

  // 向前搜尋連續重複次數（至少 2 筆已確認相同）
  let count = 2;
  for (let i = retryHistory.length - 3; i >= 0; i--) {
    const entry = retryHistory[i];
    const entryHint = (entry.hint || '').slice(0, HINT_PREFIX_LEN);
    if (entry.severity === last.severity && entryHint === lastHint) {
      count++;
    } else {
      break;
    }
  }

  return { isDuplicate: true, consecutiveCount: count };
}

module.exports = {
  shouldStop,
  analyzeTrend,
  detectStagnation,
  adaptiveRetryLimit,
  detectDuplicateHints,
  MAX_RETRIES,
  QUALITY_STAGES,
};
