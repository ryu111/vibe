/**
 * state-migrator.test.js — State 遷移單元測試（v3→v4）
 */
'use strict';
const assert = require('assert');
const { detectVersion, migrateV3toV4, ensureV4 } = require('../scripts/lib/flow/state-migrator.js');
const { STAGE_STATUS } = require('../scripts/lib/flow/dag-state.js');

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

test('detectVersion: v3 state → 3', () => {
  assert.strictEqual(detectVersion({ version: 3, dag: {} }), 3);
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

// ──── migrateV3toV4 ────

test('migrateV3toV4: null → null', () => {
  assert.strictEqual(migrateV3toV4(null), null);
});

test('migrateV3toV4: 未初始化（meta.initialized 缺失）→ pipelineActive=false', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    enforced: true,
    meta: {}, // 缺 initialized
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.version, 4);
  assert.strictEqual(v4.pipelineActive, false, 'uninitialized → pipelineActive=false');
});

test('migrateV3toV4: meta.initialized=false → pipelineActive=false', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    enforced: true,
    meta: { initialized: false, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, false);
});

test('migrateV3toV4: 正常 CLASSIFIED enforced pipeline → pipelineActive=true', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'pending' },
      REVIEW: { status: 'pending' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.version, 4);
  assert.strictEqual(v4.pipelineActive, true, 'CLASSIFIED enforced → pipelineActive=true');
  assert.deepStrictEqual(v4.activeStages, [], 'no active stages');
  assert.deepStrictEqual(v4.retryHistory, {}, 'empty retryHistory');
  assert.deepStrictEqual(v4.crashes, {}, 'empty crashes');
});

test('migrateV3toV4: DELEGATING（有 active stage）→ pipelineActive=true + activeStages 推導', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'active' },
      REVIEW: { status: 'pending' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, true);
  assert.deepStrictEqual(v4.activeStages, ['DEV'], 'active stage 應被推導到 activeStages');
});

test('migrateV3toV4: COMPLETE（全部 completed）→ pipelineActive=false', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed' } },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, false, 'COMPLETE → pipelineActive=false');
});

test('migrateV3toV4: CANCELLED（meta.cancelled=true）→ pipelineActive=false', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    enforced: true,
    meta: { initialized: true, cancelled: true },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, false, 'cancelled → pipelineActive=false');
});

test('migrateV3toV4: non-enforced（enforced=false）→ pipelineActive=false', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: null, taskType: 'bugfix' },
    dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] } },
    stages: { PLAN: { status: 'completed' }, DEV: { status: 'pending' } },
    enforced: false,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, false, 'non-enforced → pipelineActive=false');
});

test('migrateV3toV4: retries 推導空 retryHistory', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'quick-dev', taskType: 'quickfix' },
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'failed' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: { REVIEW: 2 },
  };
  const v4 = migrateV3toV4(v3);
  assert.ok('REVIEW' in v4.retryHistory, 'retries 中的 stage 應出現在 retryHistory');
  assert.deepStrictEqual(v4.retryHistory.REVIEW, [], 'retryHistory 初始為空陣列');
});

// ──── ensureV4 ────

test('ensureV4: null → null', () => {
  assert.strictEqual(ensureV4(null), null);
});

test('ensureV4: v4 state → 原樣返回', () => {
  const v4 = { version: 4, pipelineActive: true, activeStages: [] };
  assert.strictEqual(ensureV4(v4), v4, '應返回同一物件（無拷貝）');
});

test('ensureV4: v3 state → 自動遷移到 v4', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const result = ensureV4(v3);
  assert.strictEqual(result.version, 4);
  assert.strictEqual(typeof result.pipelineActive, 'boolean');
  assert.ok(Array.isArray(result.activeStages));
});

test('ensureV4: v2 格式（舊 phase/context）→ null（不支援）', () => {
  const v2 = {
    sessionId: 'test-v2',
    phase: 'CLASSIFIED',
    context: { pipelineId: 'fix', taskType: 'bugfix' },
    progress: { completedAgents: [], skippedStages: [] },
    meta: { initialized: true, cancelled: false },
  };
  assert.strictEqual(ensureV4(v2), null, 'v2 格式不再支援');
});

test('ensureV4: 未知格式 → null', () => {
  assert.strictEqual(ensureV4({ random: true }), null);
});

// ──── 邊界案例 ────

test('detectVersion: {version:2} 數字格式 → 0（不支援）', () => {
  assert.strictEqual(detectVersion({ version: 2 }), 0);
});

test('detectVersion: {version:5} 未來版本 → 0（不支援）', () => {
  assert.strictEqual(detectVersion({ version: 5 }), 0);
});

test('migrateV3toV4: 空 DAG {} + 有分類 → pipelineActive=true（無 stage 未算完成）', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: {}, // 空 DAG：stageIds.length === 0 → v3Complete = false
    stages: {},
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  // 空 DAG 時 stageIds.length===0 → v3Complete=false → pipelineActive=true
  assert.strictEqual(v4.pipelineActive, true, `空 DAG 但有分類 → pipelineActive=true`);
});

test('migrateV3toV4: dag=null + 有分類 → pipelineActive=false（無 DAG 條件不滿足）', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: null, // !!null = false → pipelineActive=false
    stages: {},
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.strictEqual(v4.pipelineActive, false, `dag=null → pipelineActive=false`);
});

test('migrateV3toV4: 多個 active stage（並行 barrier）→ activeStages 包含全部', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: {
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'active' },
      TEST: { status: 'active' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  assert.ok(v4.activeStages.includes('REVIEW'), 'REVIEW 應在 activeStages');
  assert.ok(v4.activeStages.includes('TEST'), 'TEST 應在 activeStages');
  assert.strictEqual(v4.activeStages.length, 2, '應有 2 個 active stages');
});

test('migrateV3toV4: 有 failed stage → pipelineActive=true（failed 不算完成）', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'quick-dev', taskType: 'bugfix' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'failed' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: { REVIEW: 1 },
  };
  const v4 = migrateV3toV4(v3);
  // failed ≠ completed/skipped → v3Complete=false → pipelineActive=true
  assert.strictEqual(v4.pipelineActive, true, `有 failed stage → pipelineActive=true`);
});

test('migrateV3toV4: 全部 stage skipped → pipelineActive=false（skipped 算完成）', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'fix', taskType: 'bugfix' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'skipped' } },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: {},
  };
  const v4 = migrateV3toV4(v3);
  // STAGE_STATUS.SKIPPED 也算完成 → v3Complete=true → pipelineActive=false
  assert.strictEqual(v4.pipelineActive, false, `全部 skipped → pipelineActive=false`);
});

test('ensureV4: {version:2} 數字格式 → null（不支援）', () => {
  assert.strictEqual(ensureV4({ version: 2 }), null);
});

test('migrateV3toV4: retries 多個 stage → retryHistory 每個初始化為空陣列，無 retry 的 stage 不出現', () => {
  const v3 = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'failed' },
      TEST: { status: 'failed' },
    },
    enforced: true,
    meta: { initialized: true, cancelled: false },
    retries: { REVIEW: 2, TEST: 1 },
  };
  const v4 = migrateV3toV4(v3);
  assert.deepStrictEqual(v4.retryHistory.REVIEW, [], 'REVIEW retryHistory 應為空陣列');
  assert.deepStrictEqual(v4.retryHistory.TEST, [], 'TEST retryHistory 應為空陣列');
  assert.ok(!('DEV' in v4.retryHistory), 'DEV 不應出現在 retryHistory（無 retry 記錄）');
});

// ──── 結果 ────

console.log(`\n=== state-migrator.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
