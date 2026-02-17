#!/usr/bin/env node
/**
 * pipeline-resume.js — Pipeline 跨 Session 接續工具
 *
 * 提供兩個純函式：
 * 1. findIncompletePipelines()：掃描未完成的 pipeline state
 * 2. resumePipeline()：將舊 session 的 pipeline 接續到新 session
 *
 * @module flow/pipeline-resume
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { derivePhase, PHASES } = require('./dag-state.js');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小時

/**
 * 將 ISO 時間字串轉換為相對時間描述（如「2 小時前」）
 * @param {string} isoString
 * @returns {string}
 */
function formatRelativeTime(isoString) {
  if (!isoString) return '未知';
  try {
    const ms = Date.now() - new Date(isoString).getTime();
    if (isNaN(ms)) return '未知';
    if (ms < 60000) return '剛才';
    if (ms < 3600000) return `${Math.floor(ms / 60000)} 分鐘前`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小時前`;
    return `${Math.floor(ms / 86400000)} 天前`;
  } catch (_) {
    return '未知';
  }
}

/**
 * 計算 pipeline 的完成/總計數
 * @param {Object} state - v3 state
 * @returns {{ completedCount: number, totalCount: number }}
 */
function countStages(state) {
  if (!state?.dag) return { completedCount: 0, totalCount: 0 };
  const stageIds = Object.keys(state.dag);
  const totalCount = stageIds.length;
  const completedCount = stageIds.filter(id => {
    const s = state.stages?.[id]?.status;
    return s === 'completed' || s === 'skipped';
  }).length;
  return { completedCount, totalCount };
}

/**
 * 掃描 ~/.claude/ 下的 pipeline-state-*.json，找到未完成的 pipeline
 *
 * @param {string} currentSessionId - 當前 session ID（排除自己）
 * @param {Object} [options]
 * @param {number} [options.maxAgeMs=86400000] - 最大年齡（預設 24h）
 * @param {string} [options.claudeDir] - ~/.claude 路徑（測試用）
 * @returns {Array<{sessionId, pipelineId, phase, completedCount, totalCount, lastTransition}>}
 */
function findIncompletePipelines(currentSessionId, options = {}) {
  const claudeDir = options.claudeDir || DEFAULT_CLAUDE_DIR;
  const maxAgeMs = options.maxAgeMs !== undefined ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;

  const results = [];

  let files;
  try {
    files = fs.readdirSync(claudeDir);
  } catch (_) {
    return results;
  }

  const now = Date.now();

  for (const file of files) {
    if (!file.startsWith('pipeline-state-') || !file.endsWith('.json')) continue;

    const filePath = path.join(claudeDir, file);

    // 提取 sessionId
    const sessionId = file.replace('pipeline-state-', '').replace('.json', '');

    // 排除自己
    if (sessionId === currentSessionId) continue;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }

    // 過濾過期檔案（maxAgeMs=0 代表所有檔案都已過期）
    const ageMs = Math.max(0, now - stat.mtimeMs);
    if (ageMs >= maxAgeMs) continue;

    let state;
    try {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      continue;
    }

    // 只處理 v3 state
    if (state.version !== 3) continue;

    // 推導 phase
    const phase = derivePhase(state);

    // 排除 IDLE 和 COMPLETE
    if (phase === PHASES.IDLE || phase === PHASES.COMPLETE) continue;

    const { completedCount, totalCount } = countStages(state);
    const pipelineId = state.classification?.pipelineId || null;
    const lastTransition = state.meta?.lastTransition || null;

    results.push({
      sessionId,
      pipelineId,
      phase,
      completedCount,
      totalCount,
      lastTransition,
    });
  }

  // 依最後活動時間降序排列（最近的在前）
  results.sort((a, b) => {
    const ta = a.lastTransition ? new Date(a.lastTransition).getTime() : 0;
    const tb = b.lastTransition ? new Date(b.lastTransition).getTime() : 0;
    return tb - ta;
  });

  return results;
}

/**
 * 將舊 session 的 pipeline 接續到新 session
 *
 * 操作：
 * 1. 讀取舊 state，更新 sessionId → 寫入新 state file
 * 2. 如果 timeline-{old}.jsonl 存在，複製為 timeline-{new}.jsonl
 *
 * @param {string} oldSessionId
 * @param {string} newSessionId
 * @param {Object} [options]
 * @param {string} [options.claudeDir]
 * @returns {{ success: boolean, error?: string }}
 */
function resumePipeline(oldSessionId, newSessionId, options = {}) {
  const claudeDir = options.claudeDir || DEFAULT_CLAUDE_DIR;

  const oldStatePath = path.join(claudeDir, `pipeline-state-${oldSessionId}.json`);
  const newStatePath = path.join(claudeDir, `pipeline-state-${newSessionId}.json`);

  // 1. 讀取舊 state
  let state;
  try {
    if (!fs.existsSync(oldStatePath)) {
      return { success: false, error: `找不到舊 state：${oldStatePath}` };
    }
    state = JSON.parse(fs.readFileSync(oldStatePath, 'utf8'));
  } catch (err) {
    return { success: false, error: `讀取舊 state 失敗：${err.message}` };
  }

  // 更新 sessionId
  state.sessionId = newSessionId;
  state.meta = state.meta || {};
  state.meta.resumedFrom = oldSessionId;
  state.meta.resumedAt = new Date().toISOString();

  // 寫入新 state
  try {
    fs.writeFileSync(newStatePath, JSON.stringify(state, null, 2));
  } catch (err) {
    return { success: false, error: `寫入新 state 失敗：${err.message}` };
  }

  // 2. 複製 timeline（若存在）
  const oldTimelinePath = path.join(claudeDir, `timeline-${oldSessionId}.jsonl`);
  const newTimelinePath = path.join(claudeDir, `timeline-${newSessionId}.jsonl`);
  try {
    if (fs.existsSync(oldTimelinePath)) {
      fs.copyFileSync(oldTimelinePath, newTimelinePath);
    }
  } catch (_) {
    // timeline 複製失敗不影響主要功能，忽略
  }

  return { success: true };
}

module.exports = {
  findIncompletePipelines,
  resumePipeline,
  formatRelativeTime,
};
