/**
 * state-migrator.test.js — State 版本驗證單元測試
 *
 * 已移除 v3→v4 遷移測試（不支援向下相容）。
 * 只測試 detectVersion 和 ensureCurrentSchema 的版本驗證行為。
 */
'use strict';
const assert = require('assert');
const { detectVersion, ensureCurrentSchema } = require('../scripts/lib/flow/state-migrator.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`❌ ${name}: ${err.message}`);
  }
}

// ──── detectVersion ────

test('detectVersion: null → 0', () => {
  assert.strictEqual(detectVersion(null), 0);
});

test('detectVersion: empty object → 0', () => {
  assert.strictEqual(detectVersion({}), 0);
});

test('detectVersion: v3 state → 0（不再支援）', () => {
  assert.strictEqual(detectVersion({ version: 3, dag: {} }), 0);
});

test('detectVersion: v4 state → 4', () => {
  assert.strictEqual(detectVersion({ version: 4, pipelineActive: false }), 4);
});

test('detectVersion: v2 格式（phase + context）→ 0（不支援）', () => {
  assert.strictEqual(detectVersion({ phase: 'DELEGATING', context: { pipelineId: 'full' } }), 0);
});

test('detectVersion: 未知格式 → 0', () => {
  assert.strictEqual(detectVersion({ foo: 'bar' }), 0);
});

test('detectVersion: {version:2} 數字格式 → 0（不支援）', () => {
  assert.strictEqual(detectVersion({ version: 2 }), 0);
});

test('detectVersion: {version:5} 未來版本 → 0（不支援）', () => {
  assert.strictEqual(detectVersion({ version: 5 }), 0);
});

// ──── ensureCurrentSchema ────

test('ensureCurrentSchema: null → null', () => {
  assert.strictEqual(ensureCurrentSchema(null), null);
});

test('ensureCurrentSchema: v4 state → 原樣返回', () => {
  const v4 = { version: 4, pipelineActive: true, activeStages: [] };
  assert.strictEqual(ensureCurrentSchema(v4), v4, '應返回同一物件（無拷貝）');
});

test('ensureCurrentSchema: v3 state → null（不再遷移）', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  assert.strictEqual(ensureCurrentSchema(v3), null, 'v3 不再遷移，回傳 null');
});

test('ensureCurrentSchema: v2 格式（舊 phase/context）→ null（不支援）', () => {
  const v2 = {
    sessionId: 'test-v2',
    phase: 'CLASSIFIED',
    context: { pipelineId: 'fix', taskType: 'bugfix' },
    progress: { completedAgents: [], skippedStages: [] },
    meta: { initialized: true, cancelled: false },
  };
  assert.strictEqual(ensureCurrentSchema(v2), null, 'v2 格式不再支援');
});

test('ensureCurrentSchema: 未知格式 → null', () => {
  assert.strictEqual(ensureCurrentSchema({ random: true }), null);
});

test('ensureCurrentSchema: {version:2} 數字格式 → null（不支援）', () => {
  assert.strictEqual(ensureCurrentSchema({ version: 2 }), null);
});

// ──── 結果 ────

console.log(`\n=== state-migrator.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
