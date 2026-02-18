#!/usr/bin/env node
/**
 * v4-retry.test.js — 回退機制邊界測試（E04-E07）
 *
 * 場景：
 *   E04: MAX_RETRIES 達上限（enforcePolicy Rule 2）
 *   E05: 無 DEV 的 pipeline FAIL 強制繼續
 *   E06: pendingRetry 跨 session 保留（readState 不遺失）
 *   E07: retryHistory 追加記錄（addRetryHistory）
 *
 * 執行：node plugins/vibe/tests/v4-retry.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const { enforcePolicy } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/route-parser.js'));
const { MAX_RETRIES } = require(path.join(PLUGIN_ROOT, 'scripts/lib/registry.js'));

let passed = 0;
let failed = 0;

cleanTestStateFiles();

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

// ─── state 工具 ─────────────────────────────────────────

function makeStandardState(sessionId, overrides = {}) {
  return {
    version: 4,
    sessionId,
    classification: {
      pipelineId: 'standard',
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      DEV: { deps: [], onFail: null },
      REVIEW: { deps: ['DEV'], onFail: 'DEV' },
      TEST: { deps: ['REVIEW'], onFail: 'DEV' },
      DOCS: { deps: ['TEST'], onFail: null },
    },
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
      DOCS: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
    ...overrides,
  };
}

function makeReviewOnlyState(sessionId, overrides = {}) {
  return {
    version: 4,
    sessionId,
    classification: {
      pipelineId: 'review-only',
      taskType: 'quickfix',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      REVIEW: { deps: [], onFail: null },  // 無 DEV
    },
    stages: {
      REVIEW: { status: 'active', agent: 'code-reviewer', verdict: null },
    },
    pipelineActive: true,
    activeStages: ['REVIEW'],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
    ...overrides,
  };
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n🔄 E04-E07：回退機制邊界測試');

// E04: MAX_RETRIES 達上限
test(`E04: MAX_RETRIES=${MAX_RETRIES} 達上限 → enforcePolicy 強制 NEXT + _retryExhausted`, () => {
  const state = makeStandardState('test-e04', {
    retries: { REVIEW: MAX_RETRIES },  // 已達 MAX_RETRIES
  });
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const { route: enforced, enforced: wasEnforced } = enforcePolicy(route, state, 'REVIEW');

  assert.strictEqual(enforced.route, 'NEXT', `達到回退上限應強制 NEXT，實際：${enforced.route}`);
  assert.strictEqual(enforced._retryExhausted, true, '應標記 _retryExhausted=true');
  assert.strictEqual(wasEnforced, true, '應標記 enforced=true');
});

test('E04b: retries < MAX_RETRIES → 不強制（正常回退）', () => {
  const state = makeStandardState('test-e04b', {
    retries: { REVIEW: 1 },  // 未達上限
  });
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const { route: enforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(enforced.route, 'DEV', `未達上限應保持 DEV 路由，實際：${enforced.route}`);
  assert.notStrictEqual(enforced._retryExhausted, true, '不應標記 _retryExhausted');
});

// E05: 無 DEV 的 pipeline FAIL 強制繼續
test('E05: review-only 無 DEV，FAIL → enforcePolicy Rule 3 強制 NEXT', () => {
  const state = makeReviewOnlyState('test-e05');
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'CRITICAL' };
  const { route: enforced, enforced: wasEnforced, reason } = enforcePolicy(route, state, 'REVIEW');

  assert.strictEqual(enforced.route, 'NEXT', `無 DEV → 強制 NEXT，實際：${enforced.route}`);
  assert.strictEqual(wasEnforced, true, '應標記 enforced=true');
  assert.ok(reason && reason.includes('DEV'), `reason 應提及 DEV，實際：${reason}`);
});

// E06: pendingRetry 跨 session 保留
test('E06: pendingRetry 寫入 state 後，重新 readState 不遺失', () => {
  const sid = 'test-e06';
  cleanSessionState(sid);

  // 建立含 pendingRetry 的 state
  const state = makeStandardState(sid, {
    pendingRetry: {
      stages: [{ id: 'REVIEW', severity: 'HIGH', round: 1 }],
    },
  });
  ds.writeState(sid, state);

  // 重新讀取（模擬跨呼叫）
  const readBack = ds.readState(sid);
  assert.ok(readBack, 'state 應存在');
  assert.ok(readBack.pendingRetry, 'pendingRetry 應存在');
  assert.deepStrictEqual(
    readBack.pendingRetry.stages,
    [{ id: 'REVIEW', severity: 'HIGH', round: 1 }],
    'pendingRetry.stages 應完整保留'
  );

  cleanSessionState(sid);
});

// E06b: clearPendingRetry 後重新讀取應為 null
test('E06b: clearPendingRetry 後 readState，pendingRetry 應為 null', () => {
  const sid = 'test-e06b';
  cleanSessionState(sid);

  let state = makeStandardState(sid, {
    pendingRetry: { stages: [{ id: 'REVIEW', severity: 'HIGH', round: 1 }] },
  });
  ds.writeState(sid, state);

  // clearPendingRetry
  state = ds.clearPendingRetry(state);
  ds.writeState(sid, state);

  const readBack = ds.readState(sid);
  assert.strictEqual(readBack.pendingRetry, null, 'clearPendingRetry 後應為 null');

  cleanSessionState(sid);
});

// E07: retryHistory 追加記錄
test('E07: retryHistory 初始為空，每輪 FAIL 追加一筆', () => {
  const sid = 'test-e07';
  cleanSessionState(sid);

  let state = makeStandardState(sid);
  ds.writeState(sid, state);

  // 模擬 addRetryHistory（從 pipeline-controller 內部邏輯提取）
  function addRetryHistory(st, stage, routeResult, retryCount) {
    const retryHistory = { ...(st.retryHistory || {}) };
    const stageHistory = [...(retryHistory[stage] || [])];
    stageHistory.push({
      verdict: routeResult?.verdict || 'FAIL',
      severity: routeResult?.severity || 'MEDIUM',
      round: retryCount + 1,
    });
    retryHistory[stage] = stageHistory;
    return { ...st, retryHistory };
  }

  // 第 1 輪 FAIL
  state = addRetryHistory(state, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  assert.strictEqual(state.retryHistory.REVIEW.length, 1, '第 1 輪後應有 1 筆記錄');
  assert.strictEqual(state.retryHistory.REVIEW[0].round, 1);
  assert.strictEqual(state.retryHistory.REVIEW[0].severity, 'HIGH');

  // 第 2 輪 FAIL
  state = addRetryHistory(state, 'REVIEW', { verdict: 'FAIL', severity: 'MEDIUM' }, 1);
  assert.strictEqual(state.retryHistory.REVIEW.length, 2, '第 2 輪後應有 2 筆記錄');
  assert.strictEqual(state.retryHistory.REVIEW[1].round, 2);
  assert.strictEqual(state.retryHistory.REVIEW[1].severity, 'MEDIUM');

  cleanSessionState(sid);
});

// E07b: 不同 stage 的 retryHistory 互不干擾
test('E07b: 不同 stage 的 retryHistory 獨立追加', () => {
  let state = {
    version: 4,
    retryHistory: {},
    retries: {},
  };

  function addHistory(st, stage, severity, retryCount) {
    const rh = { ...(st.retryHistory || {}) };
    const sh = [...(rh[stage] || [])];
    sh.push({ verdict: 'FAIL', severity, round: retryCount + 1 });
    rh[stage] = sh;
    return { ...st, retryHistory: rh };
  }

  state = addHistory(state, 'REVIEW', 'HIGH', 0);
  state = addHistory(state, 'TEST', 'MEDIUM', 0);

  assert.strictEqual(state.retryHistory.REVIEW.length, 1, 'REVIEW 應有 1 筆');
  assert.strictEqual(state.retryHistory.TEST.length, 1, 'TEST 應有 1 筆');
  assert.strictEqual(state.retryHistory.REVIEW[0].severity, 'HIGH');
  assert.strictEqual(state.retryHistory.TEST[0].severity, 'MEDIUM');
});

// MAX_RETRIES 常量驗證
test('E08: MAX_RETRIES 常量應為 3（預設）', () => {
  assert.strictEqual(typeof MAX_RETRIES, 'number', 'MAX_RETRIES 應為數字');
  assert.ok(MAX_RETRIES >= 1, 'MAX_RETRIES 應 >= 1');
  // 預設值
  assert.strictEqual(MAX_RETRIES, 3, `MAX_RETRIES 預設應為 3，實際：${MAX_RETRIES}`);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
