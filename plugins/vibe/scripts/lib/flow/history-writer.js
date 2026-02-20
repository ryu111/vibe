#!/usr/bin/env node
/**
 * history-writer.js — Pipeline 歷史記錄（S9 Pipeline History）
 *
 * 將每次 pipeline 完成的結果追加到全域 JSONL 檔案，供後續查詢和分析。
 *
 * 設計原則：
 * - recordCompletion：從 state 提取欄位，追加一行 JSON（非關鍵路徑，靜默忽略錯誤）
 * - queryHistory：讀取 JSONL，支援 filter + 降序排列
 * - truncateHistory：保留最新 N 筆，防止檔案無限成長
 * - summarizeHistory：純函式統計分析，不存取 I/O
 *
 * @module flow/history-writer
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 歷史記錄路徑（全域共享，非 session 隔離）
const HISTORY_PATH = path.join(CLAUDE_DIR, 'pipeline-history.jsonl');

// 最大保留記錄數
const MAX_HISTORY_RECORDS = 100;

// ────────────────── getHistoryPath ──────────────────

/**
 * 取得 pipeline-history.jsonl 路徑。
 *
 * @returns {string} 完整路徑
 */
function getHistoryPath() {
  return HISTORY_PATH;
}

// ────────────────── recordCompletion ──────────────────

/**
 * 從 pipeline state 提取欄位，追加一行 JSON 到 JSONL。
 *
 * 欄位對應：
 * - state.classification.pipelineId → pipelineId
 * - state.sessionId → sessionId
 * - state.startedAt → startedAt（如存在）
 * - 當下時間 → completedAt
 * - completedAt - startedAt → durationMs（如 startedAt 存在）
 * - 遍歷 state.stages → stageResults + 計算 totalRetries/totalCrashes
 *
 * @param {object} state - v4 pipeline state
 */
function recordCompletion(state) {
  if (!state || typeof state !== 'object') return;

  try {
    const pipelineId = state.classification?.pipelineId || 'unknown';
    const sessionId = state.sessionId || 'unknown';
    const startedAt = state.startedAt || null;
    const completedAt = new Date().toISOString();

    // 計算 durationMs
    let durationMs = null;
    if (startedAt) {
      try {
        const startMs = new Date(startedAt).getTime();
        const endMs = new Date(completedAt).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
          durationMs = endMs - startMs;
        }
      } catch (_) {}
    }

    // 遍歷 stages 建立 stageResults 並計算 totalRetries / totalCrashes
    const stages = state.stages || {};
    const retries = state.retries || {};
    const crashes = state.crashes || {};

    const stageResults = [];
    let totalRetries = 0;
    let totalCrashes = 0;

    for (const [stageId, stageInfo] of Object.entries(stages)) {
      if (!stageInfo || typeof stageInfo !== 'object') continue;

      const verdict = stageInfo.verdict || (stageInfo.status === 'completed' ? 'PASS' : null);
      const stageRetries = (typeof retries[stageId] === 'number') ? retries[stageId] : 0;
      const stageCrashes = (typeof crashes[stageId] === 'number') ? crashes[stageId] : 0;

      stageResults.push({
        stageId,
        verdict: verdict || null,
        retries: stageRetries,
      });

      totalRetries += stageRetries;
      totalCrashes += stageCrashes;
    }

    // 判斷 finalResult 和 cancelled
    const cancelled = state.cancelled === true;
    let finalResult;
    if (cancelled) {
      finalResult = 'CANCELLED';
    } else if (state.pipelineActive === false && _allStagesCompleted(stages)) {
      finalResult = 'COMPLETE';
    } else {
      finalResult = 'UNKNOWN';
    }

    const record = {
      pipelineId,
      sessionId,
      startedAt,
      completedAt,
      durationMs,
      totalRetries,
      totalCrashes,
      stageResults,
      finalResult,
      cancelled,
    };

    // 確保目錄存在
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }

    // 追加一行 JSON
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {
    // 非關鍵路徑，靜默忽略
  }
}

// ────────────────── queryHistory ──────────────────

/**
 * 查詢歷史記錄。
 *
 * @param {{ pipelineId?: string, limit?: number, since?: string }} [filter] - 過濾條件
 * @returns {object[]} 歷史記錄陣列（按 completedAt 降序排列）
 */
function queryHistory(filter) {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];

    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());

    // 逐行解析，跳過損毀行
    const records = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        records.push(record);
      } catch (_) {
        // 損毀行跳過
      }
    }

    // 按 completedAt 降序排列
    records.sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

    if (!filter || typeof filter !== 'object') return records;

    let result = records;

    // pipelineId 過濾
    if (filter.pipelineId && typeof filter.pipelineId === 'string') {
      result = result.filter(r => r.pipelineId === filter.pipelineId);
    }

    // since 時間過濾（completedAt >= since）
    if (filter.since && typeof filter.since === 'string') {
      try {
        const sinceMs = new Date(filter.since).getTime();
        if (!isNaN(sinceMs)) {
          result = result.filter(r => {
            if (!r.completedAt) return false;
            const rMs = new Date(r.completedAt).getTime();
            return !isNaN(rMs) && rMs >= sinceMs;
          });
        }
      } catch (_) {}
    }

    // limit 截斷
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      result = result.slice(0, filter.limit);
    }

    return result;
  } catch (_) {
    return [];
  }
}

// ────────────────── truncateHistory ──────────────────

/**
 * 截斷歷史記錄，保留最新 maxRecords 筆。
 *
 * 記錄不足 maxRecords 時不做事。
 * 錯誤時靜默忽略。
 *
 * @param {number} [maxRecords=MAX_HISTORY_RECORDS] - 保留記錄數量
 */
function truncateHistory(maxRecords) {
  const limit = typeof maxRecords === 'number' && maxRecords > 0
    ? maxRecords
    : MAX_HISTORY_RECORDS;

  try {
    if (!fs.existsSync(HISTORY_PATH)) return;

    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());

    // 記錄數不超過上限，不做事
    if (lines.length <= limit) return;

    // 解析並保留最新 limit 筆（按 completedAt 降序，取前 limit）
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (_) {
        // 損毀行跳過
      }
    }

    // 按 completedAt 降序排列
    records.sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

    const kept = records.slice(0, limit);

    // 覆寫檔案（降序 → 可直接 append，此處保持降序儲存）
    const content = kept.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(HISTORY_PATH, content, 'utf8');
  } catch (_) {
    // 非關鍵路徑，靜默忽略
  }
}

// ────────────────── summarizeHistory ──────────────────

/**
 * 統計分析歷史記錄。
 *
 * @param {object[]} records - queryHistory 回傳的陣列
 * @returns {{
 *   totalPipelines: number,
 *   avgDurationMs: number,
 *   successRate: number,
 *   stageFailRates: Record<string, number>,
 *   mostUsedPipeline: string
 * }|null} 統計結果，空陣列回傳 null
 */
function summarizeHistory(records) {
  if (!Array.isArray(records) || records.length === 0) return null;

  const totalPipelines = records.length;

  // avgDurationMs：只計算有 durationMs 的記錄
  const durRecords = records.filter(r => typeof r.durationMs === 'number' && r.durationMs >= 0);
  const avgDurationMs = durRecords.length > 0
    ? Math.round(durRecords.reduce((sum, r) => sum + r.durationMs, 0) / durRecords.length)
    : 0;

  // successRate：finalResult='COMPLETE' 且所有 stageResults 的 verdict 均非 'FAIL'
  const successCount = records.filter(r => {
    if (r.finalResult !== 'COMPLETE') return false;
    const stageResults = Array.isArray(r.stageResults) ? r.stageResults : [];
    return stageResults.every(s => s.verdict !== 'FAIL');
  }).length;
  const successRate = totalPipelines > 0 ? successCount / totalPipelines : 0;

  // stageFailRates：各 stage 名稱到 FAIL 比例
  const stageFailCounts = {};
  const stageTotalCounts = {};

  for (const record of records) {
    const stageResults = Array.isArray(record.stageResults) ? record.stageResults : [];
    for (const sr of stageResults) {
      if (!sr || typeof sr.stageId !== 'string') continue;
      const sid = sr.stageId;
      stageTotalCounts[sid] = (stageTotalCounts[sid] || 0) + 1;
      if (sr.verdict === 'FAIL') {
        stageFailCounts[sid] = (stageFailCounts[sid] || 0) + 1;
      }
    }
  }

  const stageFailRates = {};
  for (const sid of Object.keys(stageTotalCounts)) {
    const total = stageTotalCounts[sid];
    const fails = stageFailCounts[sid] || 0;
    stageFailRates[sid] = total > 0 ? fails / total : 0;
  }

  // mostUsedPipeline：出現次數最多的 pipelineId
  const pipelineCounts = {};
  for (const record of records) {
    if (typeof record.pipelineId === 'string') {
      pipelineCounts[record.pipelineId] = (pipelineCounts[record.pipelineId] || 0) + 1;
    }
  }

  let mostUsedPipeline = '';
  let maxCount = 0;
  for (const [pid, count] of Object.entries(pipelineCounts)) {
    if (count > maxCount) {
      maxCount = count;
      mostUsedPipeline = pid;
    }
  }

  return {
    totalPipelines,
    avgDurationMs,
    successRate,
    stageFailRates,
    mostUsedPipeline,
  };
}

// ────────────────── 私有輔助函式 ──────────────────

/**
 * 判斷所有 stage 是否已完成（status === 'completed' 或 'skipped'）。
 *
 * @param {object} stages - state.stages
 * @returns {boolean}
 */
function _allStagesCompleted(stages) {
  if (!stages || typeof stages !== 'object') return false;
  const entries = Object.values(stages);
  if (entries.length === 0) return false;
  return entries.every(s => {
    const status = s?.status;
    return status === 'completed' || status === 'skipped';
  });
}

// ────────────────── Exports ──────────────────

module.exports = {
  getHistoryPath,
  recordCompletion,
  queryHistory,
  truncateHistory,
  summarizeHistory,
  MAX_HISTORY_RECORDS,
};
