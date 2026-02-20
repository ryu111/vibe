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
    { prefix: 'pipeline-state-catalog-', suffix: '.json' },
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
    // v4 barrier / reflection / context 檔案
    { prefix: 'barrier-state-test-', suffix: '.json' },
    { prefix: 'barrier-state-e2e-', suffix: '.json' },
    { prefix: 'barrier-state-catalog-', suffix: '.json' },
    { prefix: 'reflection-memory-test-', suffix: '.md' },
    { prefix: 'reflection-memory-e2e-', suffix: '.md' },
    { prefix: 'reflection-memory-catalog-', suffix: '.md' },
    { prefix: 'pipeline-context-test-', suffix: '.md' },
    { prefix: 'pipeline-context-e2e-', suffix: '.md' },
    { prefix: 'pipeline-context-catalog-', suffix: '.md' },
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
 * 建立測試用 Pipeline state（DAG 結構）
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
 * @returns {Object} pipeline state
 */
function createTestState(sessionId, opts = {}) {
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

  // 推導 pipelineActive
  const pid = opts.pipelineId || null;
  const enforced = opts.enforced !== undefined ? opts.enforced : (stages.length > 0);
  const cancelled = opts.cancelled || false;
  const allDone = stages.length > 0 && stages.every(s => completedSet.has(s) || skippedSet.has(s));
  const pipelineActive = !!(pid && pid !== 'none') && enforced && !cancelled && stages.length > 0 && !allDone;

  // 推導 activeStages
  const activeStages = opts.active ? [opts.active] : [];

  return {
    version: 4,
    sessionId,
    classification: (pid || opts.taskType) ? {
      pipelineId: pid || null,
      taskType: opts.taskType || null,
      source: opts.source || 'test',
      classifiedAt: new Date().toISOString(),
    } : null,
    environment: opts.environment || {},
    openspecEnabled: opts.openspecEnabled || false,
    needsDesign: opts.needsDesign || false,
    dag: stages.length > 0 ? dag : null,
    blueprint: null,
    pipelineActive,
    activeStages,
    stages: stagesObj,
    retries: opts.retries || {},
    retryHistory: opts.retryHistory || {},
    crashes: opts.crashes || {},
    pendingRetry: opts.pendingRetry || null,
    meta: {
      initialized: true,
      cancelled,
      lastTransition: opts.lastTransition || new Date().toISOString(),
      reclassifications: [],
      pipelineRules: opts.pipelineRules || [],
    },
  };
}

/**
 * 寫入 pipeline state 到 state file
 */
function writeTestState(sessionId, opts = {}) {
  const state = createTestState(sessionId, opts);
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/**
 * 清理單一 session 的所有相關 state 檔案（含 v4 barrier/reflection/context）
 * 替代各測試檔案自行實作的 cleanState(sid)
 * @param {string} sessionId
 */
function cleanSessionState(sessionId) {
  const fixed = [
    `pipeline-state-${sessionId}.json`,
    `barrier-state-${sessionId}.json`,
    `timeline-${sessionId}.jsonl`,
    `classified-reads-${sessionId}.json`,
    `flow-counter-${sessionId}.json`,
  ];
  for (const f of fixed) {
    try { fs.unlinkSync(path.join(CLAUDE_DIR, f)); } catch (_) {}
  }
  // reflection-memory-{sid}-{STAGE}.md 和 pipeline-context-{sid}-{STAGE}.md
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    for (const f of files) {
      if ((f.startsWith(`reflection-memory-${sessionId}-`) || f.startsWith(`pipeline-context-${sessionId}-`)) && f.endsWith('.md')) {
        try { fs.unlinkSync(path.join(CLAUDE_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

module.exports = { cleanTestStateFiles, createTestState, writeTestState, cleanSessionState, CLAUDE_DIR };
