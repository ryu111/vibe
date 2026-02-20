#!/usr/bin/env node
/**
 * state-migrator.js — Pipeline State 版本驗證
 *
 * 確保 state 為當前 schema 結構。舊格式一律視為無效，回傳 null。
 * 不再做遷移：使用者明確選擇不支援向下相容，保持新版乾淨。
 *
 * @module flow/state-migrator
 */
'use strict';

/**
 * 偵測 state 版本
 * @param {Object} state
 * @returns {number} 4 或 0（不支援）
 */
function detectVersion(state) {
  if (!state) return 0;
  if (state.version === 4) return 4;
  return 0;
}

/**
 * 確保 state 為當前 schema 結構。
 * 舊格式或未知格式回傳 null（不再遷移）。
 * @param {Object} state
 * @returns {Object|null} 當前 schema state
 */
function ensureCurrentSchema(state) {
  if (!state) return null;
  const version = detectVersion(state);
  if (version === 4) return state;
  return null; // 舊格式不再支援
}

module.exports = { detectVersion, ensureCurrentSchema };
