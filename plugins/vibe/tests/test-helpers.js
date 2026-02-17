/**
 * test-helpers.js — 測試共用輔助函式
 *
 * 提供跨測試檔案的共用功能，避免重複程式碼。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * 清理上次測試殘留的 state 檔案
 * 刪除所有 test-* / e2e-* 前綴的 pipeline-state、timeline、task-guard-state、test-transcript
 * 在每個測試檔案開頭呼叫，確保乾淨的起始狀態
 */
function cleanTestStateFiles() {
  const patterns = [
    { prefix: 'pipeline-state-test-', suffix: '.json' },
    { prefix: 'pipeline-state-e2e-', suffix: '.json' },
    { prefix: 'timeline-test-', suffix: '.jsonl' },
    { prefix: 'timeline-e2e-', suffix: '.jsonl' },
    { prefix: 'timeline-tg-test-', suffix: '.jsonl' },
    { prefix: 'timeline-integration-test-', suffix: '.jsonl' },
    { prefix: 'timeline-unknown', suffix: '.jsonl' },
    { prefix: 'task-guard-state-', suffix: '.json' },
    { prefix: 'test-transcript-', suffix: '.jsonl' },
    { prefix: 'classified-reads-test-', suffix: '.json' },
    { prefix: 'classified-reads-e2e-', suffix: '.json' },
    { prefix: 'flow-counter-test-', suffix: '.json' },
    { prefix: 'flow-counter-e2e-', suffix: '.json' },
  ];

  let count = 0;
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    for (const file of files) {
      for (const { prefix, suffix } of patterns) {
        if (file.startsWith(prefix) && file.endsWith(suffix)) {
          try {
            fs.unlinkSync(path.join(CLAUDE_DIR, file));
            count++;
          } catch (_) {}
          break;
        }
      }
    }
  } catch (_) {}
  return count;
}

/**
 * 建立 v3 Pipeline state（DAG 結構）
 *
 * @param {string} sessionId
 * @param {Object} opts
 * @param {string[]} opts.stages - 線性 stage 列表（自動建立串行 DAG）
 * @param {string[]} opts.completed - 已完成的 stage ID
 * @param {string} opts.active - 當前 active 的 stage ID
 * @param {string[]} opts.skipped - 跳過的 stages
 * @param {string[]} opts.failed - 失敗的 stages
 * @param {Object} opts.environment
 * @param {boolean} opts.openspecEnabled
 * @param {boolean} opts.needsDesign
 * @param {string} opts.pipelineId
 * @param {string} opts.taskType
 * @param {boolean} opts.enforced
 * @param {boolean} opts.cancelled
 * @param {Object} opts.pendingRetry
 * @param {Object} opts.retries
 * @returns {Object} v3 state
 */
function createV3State(sessionId, opts = {}) {
  const stages = opts.stages || [];

  // 建立線性 DAG
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = { deps: i > 0 ? [stages[i - 1]] : [] };
  }

  // 建立各 stage 狀態
  const stagesObj = {};
  const completedSet = new Set(opts.completed || []);
  const skippedSet = new Set(opts.skipped || []);
  const failedSet = new Set(opts.failed || []);

  for (const s of stages) {
    if (completedSet.has(s)) {
      stagesObj[s] = { status: 'completed', agent: null, verdict: null, completedAt: new Date().toISOString() };
    } else if (skippedSet.has(s)) {
      stagesObj[s] = { status: 'skipped', reason: 'test skip' };
    } else if (failedSet.has(s)) {
      stagesObj[s] = { status: 'failed', agent: null, verdict: { severity: 'HIGH' } };
    } else if (s === opts.active) {
      stagesObj[s] = { status: 'active', agent: null, startedAt: new Date().toISOString() };
    } else {
      stagesObj[s] = { status: 'pending', agent: null, verdict: null };
    }
  }

  return {
    version: 3,
    sessionId,
    classification: (opts.pipelineId || opts.taskType) ? {
      pipelineId: opts.pipelineId || null,
      taskType: opts.taskType || null,
      source: opts.source || 'test',
      classifiedAt: new Date().toISOString(),
    } : null,
    environment: opts.environment || {},
    openspecEnabled: opts.openspecEnabled || false,
    needsDesign: opts.needsDesign || false,
    dag: stages.length > 0 ? dag : null,
    enforced: opts.enforced !== undefined ? opts.enforced : (stages.length > 0),
    blueprint: null,
    stages: stagesObj,
    retries: opts.retries || {},
    pendingRetry: opts.pendingRetry || null,
    meta: {
      initialized: true,
      cancelled: opts.cancelled || false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: opts.pipelineRules || [],
    },
  };
}

/**
 * 寫入 v3 state 到 state file
 */
function writeV3State(sessionId, opts = {}) {
  const state = createV3State(sessionId, opts);
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

module.exports = { cleanTestStateFiles, createV3State, writeV3State, CLAUDE_DIR };
