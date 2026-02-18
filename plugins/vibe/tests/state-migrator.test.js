/**
 * state-migrator.test.js — State 遷移單元測試（v2→v3 + v3→v4）
 */
'use strict';
const assert = require('assert');
const { detectVersion, migrateV2toV3, ensureV3, migrateV3toV4, ensureV4 } = require('../scripts/lib/flow/state-migrator.js');
const { STAGE_STATUS, PHASES } = require('../scripts/lib/flow/dag-state.js');

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

test('detectVersion: v2 state（phase + context）→ 2', () => {
  assert.strictEqual(detectVersion({ phase: 'DELEGATING', context: { pipelineId: 'full' } }), 2);
});

test('detectVersion: 未知格式 → 0', () => {
  assert.strictEqual(detectVersion({ foo: 'bar' }), 0);
});

// ──── migrateV2toV3 ────

test('migrateV2toV3: null → null', () => {
  assert.strictEqual(migrateV2toV3(null), null);
});

test('migrateV2toV3: 基本 v2 state → v3 結構正確', () => {
  const v2 = {
    sessionId: 'test-migrate-1',
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'quick-dev',
      taskType: 'quickfix',
      environment: { language: 'javascript' },
    },
    progress: {
      currentStage: null,
      completedAgents: [],
      skippedStages: [],
    },
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: '2026-02-18T00:00:00.000Z',
    },
  };

  const v3 = migrateV2toV3(v2);

  assert.strictEqual(v3.version, 3);
  assert.strictEqual(v3.sessionId, 'test-migrate-1');
  assert.strictEqual(v3.classification.pipelineId, 'quick-dev');
  assert.strictEqual(v3.classification.taskType, 'quickfix');
  assert.strictEqual(v3.classification.source, 'migrated');
  assert.ok(v3.dag, 'DAG 應存在');
  assert.ok(v3.dag.DEV, 'DEV stage 應存在於 DAG');
  assert.ok(v3.dag.REVIEW, 'REVIEW stage 應存在於 DAG');
  assert.ok(v3.dag.TEST, 'TEST stage 應存在於 DAG');
  assert.strictEqual(v3.stages.DEV.status, STAGE_STATUS.PENDING);
  assert.strictEqual(v3.meta.migratedFrom, 'v2');
  assert.ok(v3.meta.migratedAt, 'migratedAt 應有值');
});

test('migrateV2toV3: completedAgents → 對應 stages 標記 completed', () => {
  const v2 = {
    sessionId: 'test-migrate-2',
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
    },
    progress: {
      currentStage: 'DEV',
      completedAgents: ['planner', 'architect'],
      skippedStages: [],
    },
    meta: { lastTransition: '2026-02-18T01:00:00.000Z' },
  };

  const v3 = migrateV2toV3(v2);

  assert.strictEqual(v3.stages.PLAN.status, STAGE_STATUS.COMPLETED);
  assert.strictEqual(v3.stages.ARCH.status, STAGE_STATUS.COMPLETED);
  assert.strictEqual(v3.stages.DEV.status, STAGE_STATUS.ACTIVE, 'currentStage + DELEGATING → active');
  assert.strictEqual(v3.stages.REVIEW.status, STAGE_STATUS.PENDING);
});

test('migrateV2toV3: skippedStages → 標記 skipped', () => {
  const v2 = {
    sessionId: 'test-migrate-3',
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
    },
    progress: {
      completedAgents: [],
      skippedStages: ['DESIGN'],
    },
    meta: {},
  };

  const v3 = migrateV2toV3(v2);

  assert.strictEqual(v3.stages.DESIGN.status, STAGE_STATUS.SKIPPED);
  assert.strictEqual(v3.stages.DESIGN.reason, 'v2 migration');
});

test('migrateV2toV3: pendingRetry → v3 格式', () => {
  const v2 = {
    sessionId: 'test-migrate-4',
    phase: 'RETRYING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
    },
    progress: {
      currentStage: 'DEV',
      completedAgents: ['planner', 'architect'],
      skippedStages: [],
      pendingRetry: { stage: 'REVIEW', severity: 'HIGH', round: 2 },
      retries: { REVIEW: 2 },
    },
    meta: {},
  };

  const v3 = migrateV2toV3(v2);

  assert.ok(v3.pendingRetry, 'pendingRetry 應存在');
  assert.strictEqual(v3.pendingRetry.stages.length, 1);
  assert.strictEqual(v3.pendingRetry.stages[0].id, 'REVIEW');
  assert.strictEqual(v3.pendingRetry.stages[0].severity, 'HIGH');
  assert.strictEqual(v3.pendingRetry.stages[0].round, 2);
  assert.strictEqual(v3.retries.REVIEW, 2);
});

test('migrateV2toV3: 無 pipelineId + expectedStages 回退', () => {
  const v2 = {
    sessionId: 'test-migrate-5',
    phase: 'CLASSIFIED',
    context: {
      expectedStages: ['DEV', 'TEST'],
    },
    progress: {},
    meta: {},
  };

  const v3 = migrateV2toV3(v2);

  assert.ok(v3.dag, 'DAG 應從 expectedStages 建立');
  assert.ok(v3.dag.DEV, 'DEV 應存在');
  assert.ok(v3.dag.TEST, 'TEST 應存在');
  assert.strictEqual(v3.classification, null, '無 pipelineId → classification 為 null');
});

test('migrateV2toV3: 環境和 openspec 欄位保留', () => {
  const v2 = {
    sessionId: 'test-migrate-6',
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'fix',
      environment: { language: 'typescript', framework: { name: 'next' } },
      openspecEnabled: true,
      needsDesign: true,
      pipelineRules: ['rule1'],
    },
    progress: {},
    meta: { cancelled: true, reclassifications: [{ from: 'quick-dev', to: 'fix' }] },
  };

  const v3 = migrateV2toV3(v2);

  assert.deepStrictEqual(v3.environment, { language: 'typescript', framework: { name: 'next' } });
  assert.strictEqual(v3.openspecEnabled, true);
  assert.strictEqual(v3.needsDesign, true);
  assert.strictEqual(v3.meta.cancelled, true);
  assert.strictEqual(v3.meta.pipelineRules.length, 1);
  assert.strictEqual(v3.meta.reclassifications.length, 1);
});

// ──── ensureV3 ────

test('ensureV3: null → null', () => {
  assert.strictEqual(ensureV3(null), null);
});

test('ensureV3: v3 → 原樣返回', () => {
  const v3 = { version: 3, dag: { DEV: { deps: [] } } };
  assert.strictEqual(ensureV3(v3), v3, '應返回同一物件（無拷貝）');
});

test('ensureV3: v2 → 自動遷移', () => {
  const v2 = {
    sessionId: 'test-ensure',
    phase: 'CLASSIFIED',
    context: { pipelineId: 'fix' },
    progress: {},
    meta: {},
  };

  const result = ensureV3(v2);
  assert.strictEqual(result.version, 3);
  assert.strictEqual(result.classification.pipelineId, 'fix');
});

test('ensureV3: 未知格式 → null', () => {
  assert.strictEqual(ensureV3({ random: true }), null);
});

// ──── detectVersion v4 ────

test('detectVersion: v4 state → 4', () => {
  assert.strictEqual(detectVersion({ version: 4, pipelineActive: false }), 4);
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

test('ensureV4: v2 state → 自動遷移到 v4（跨兩版）', () => {
  const v2 = {
    sessionId: 'test-v2-to-v4',
    phase: 'CLASSIFIED',
    context: { pipelineId: 'fix', taskType: 'bugfix' },
    progress: { completedAgents: [], skippedStages: [] },
    meta: { initialized: true, cancelled: false },
  };
  const result = ensureV4(v2);
  assert.strictEqual(result.version, 4, 'v2 → v4 跨版遷移');
  assert.strictEqual(typeof result.pipelineActive, 'boolean');
  assert.strictEqual(result.classification.pipelineId, 'fix');
});

test('ensureV4: 未知格式 → null', () => {
  assert.strictEqual(ensureV4({ random: true }), null);
});

// ──── 結果 ────

console.log(`\n=== state-migrator.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
