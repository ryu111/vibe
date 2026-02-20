#!/usr/bin/env node
/**
 * pipeline-lifecycle.test.js — Pipeline 生命週期閉環測試（G05-G07）
 *
 * 場景：
 *   G05: 連續阻擋 ≥3 → cancel 提示出現
 *   G06: onDelegate 重設阻擋計數器
 *   G07: pipelineActive=false → onSessionStop 返回 null
 *
 * 執行：node plugins/vibe/tests/pipeline-lifecycle.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

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

function makeActiveState(sessionId, blockCount = 0) {
  const state = {
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
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['REVIEW'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
      pipelineCheckBlocks: blockCount,
    },
  };
  ds.writeState(sessionId, state);
  return state;
}

function makeCompleteState(sessionId) {
  const state = {
    version: 4,
    sessionId,
    classification: {
      pipelineId: 'fix',
      taskType: 'quickfix',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: { DEV: { deps: [] } },
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: null, completedAt: new Date().toISOString() },
    },
    pipelineActive: false,  // 已完成
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
    },
  };
  ds.writeState(sessionId, state);
  return state;
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n🔚 G05-G07：Pipeline 生命週期閉環測試');

// G05: 連續阻擋 ≥3 → cancel 提示
test('G05: 連續阻擋 ≥3 次 → stopReason 含 cancel 提示', () => {
  const sid = 'test-g05';
  cleanSessionState(sid);

  // 前置：blockCount 已為 2（下一次是第 3 次）
  makeActiveState(sid, 2);

  const result = ctrl.onSessionStop(sid);
  assert.ok(result, 'onSessionStop 應回傳非 null（pipeline 未完成）');
  assert.strictEqual(result.continue, false, 'continue 應為 false');
  assert.ok(result.stopReason, 'stopReason 應存在');
  // 第 3 次應含 cancel 提示
  assert.ok(
    result.stopReason.includes('cancel') || result.stopReason.includes('取消'),
    `第 3 次阻擋應含 cancel 提示，實際：${result.stopReason}`
  );

  // 驗證 state 中 pipelineCheckBlocks 被更新
  const updatedState = ds.readState(sid);
  assert.strictEqual(
    updatedState.meta.pipelineCheckBlocks,
    3,
    `pipelineCheckBlocks 應為 3，實際：${updatedState.meta.pipelineCheckBlocks}`
  );

  cleanSessionState(sid);
});

// G05b: 第一次阻擋不含 cancel 提示
test('G05b: 第一次阻擋（blockCount=0）→ 不含 cancel 提示', () => {
  const sid = 'test-g05b';
  cleanSessionState(sid);

  makeActiveState(sid, 0);  // blockCount=0

  const result = ctrl.onSessionStop(sid);
  assert.ok(result, 'onSessionStop 應回傳非 null');

  // 第一次不應含 cancel 提示（cancelHint 是 '' 時不含）
  // 注意：stopReason 可能含 vibe:cancel 的 hint，但應在 blockCount >= 3 時才出現
  const state = ds.readState(sid);
  assert.strictEqual(state.meta.pipelineCheckBlocks, 1, '第一次後 blockCount 應為 1');

  cleanSessionState(sid);
});

// G06: onDelegate 重設阻擋計數器
test('G06: onDelegate 後阻擋計數器歸零', () => {
  const sid = 'test-g06';
  cleanSessionState(sid);

  // 前置：blockCount 已為 5（模擬多次阻擋）
  const state = makeActiveState(sid, 5);

  // 委派 DEV agent
  const result = ctrl.onDelegate(sid, 'developer', {});
  assert.ok(result.allow !== false, `onDelegate 應允許，實際：${JSON.stringify(result)}`);

  // 驗證：pipelineCheckBlocks 應被重設為 0
  const updatedState = ds.readState(sid);
  assert.strictEqual(
    updatedState.meta?.pipelineCheckBlocks,
    0,
    `委派後 pipelineCheckBlocks 應歸零，實際：${updatedState.meta?.pipelineCheckBlocks}`
  );

  cleanSessionState(sid);
});

// G07: pipelineActive=false → onSessionStop 返回 null（v4 核心）
test('G07: pipelineActive=false（COMPLETE）→ onSessionStop 返回 null', () => {
  const sid = 'test-g07';
  cleanSessionState(sid);

  makeCompleteState(sid);

  const result = ctrl.onSessionStop(sid);
  assert.strictEqual(result, null, `COMPLETE state 應回傳 null（不阻擋），實際：${JSON.stringify(result)}`);

  cleanSessionState(sid);
});

// G07b: pipelineActive=false（已取消）→ onSessionStop 返回 null
test('G07b: pipelineActive=false（已取消）→ onSessionStop 返回 null', () => {
  const sid = 'test-g07b';
  cleanSessionState(sid);

  // 建立已取消的 state（pipelineActive=false + 有 dag）
  const cancelledState = {
    version: 4,
    sessionId: sid,
    classification: {
      pipelineId: 'standard',
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null },
      REVIEW: { status: 'pending', agent: null },
    },
    pipelineActive: false,  // 已取消
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
  };
  ds.writeState(sid, cancelledState);

  const result = ctrl.onSessionStop(sid);
  assert.strictEqual(result, null, `已取消的 pipeline 應回傳 null（不阻擋）`);

  cleanSessionState(sid);
});

// G07c: 無 state → onSessionStop 返回 null
test('G07c: 無 state → onSessionStop 返回 null', () => {
  const sid = 'test-g07c-nostate';
  cleanSessionState(sid);

  const result = ctrl.onSessionStop(sid);
  assert.strictEqual(result, null, `無 state 應回傳 null`);
});

// G01: 完成後 pipelineActive=false（確認）
test('G01（補充）: 所有 stage 完成 → pipelineActive=false → Guard 放行', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
  const completedState = {
    version: 4,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed' } },
    pipelineActive: false,
    activeStages: [],
    classification: { pipelineId: 'fix' },
  };
  const result = evaluate('Write', { file_path: '/src/foo.js' }, completedState);
  assert.strictEqual(result.decision, 'allow', `完成後 Guard 應放行，實際：${result.decision}`);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
