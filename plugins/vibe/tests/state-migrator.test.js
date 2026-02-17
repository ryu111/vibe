/**
 * state-migrator.test.js — v2→v3 State 遷移單元測試
 */
'use strict';
const assert = require('assert');
const { detectVersion, migrateV2toV3, ensureV3 } = require('../scripts/lib/flow/state-migrator.js');
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
  assert.strictEqual(v3.enforced, false, '無 pipelineId → 不 enforced');
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

// ──── 結果 ────

console.log(`\n=== state-migrator.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
