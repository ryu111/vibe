/**
 * dag-state-edge.test.js — dag-state.js 邊界案例與函式覆蓋補充測試
 *
 * 補充測試目標（現有測試未覆蓋的部分）：
 * 1. derivePhase — 所有分支邊界：IDLE/CLASSIFIED/DELEGATING/RETRYING/COMPLETE/pendingRetry
 * 2. getReadyStages — 空 DAG、deps 未滿足、deps 部分滿足、skipped 作為 deps
 * 3. isActive / isComplete — 各種邊界輸入
 * 4. setStageContextFile — stageId 不存在的防禦性處理
 * 5. markStageFailed — retries 累加邏輯
 * 6. resetStageToPending — 清理所有時間戳
 * 7. classify — shouldActivate=false（none pipeline）+ 已有分類時 reclassifications
 * 8. cancelPipeline — 確認 pipelineActive=false
 * 9. reset / resetKeepingClassification — 保留欄位驗證
 * 10. derivePhase COMPLETE 路徑（pipelineActive=false + allDone）
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const { PHASES, STAGE_STATUS } = ds;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

// ── 測試輔助工具 ──

function makeState(overrides = {}) {
  return ds.createInitialState('test-dag-edge', {});
}

function makeStateWithDag(stages, stageOverrides = {}, stateOverrides = {}) {
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = { deps: i > 0 ? [stages[i - 1]] : [] };
  }
  const stagesObj = {};
  for (const s of stages) {
    stagesObj[s] = {
      status: STAGE_STATUS.PENDING,
      agent: null,
      verdict: null,
      contextFile: null,
      ...(stageOverrides[s] || {}),
    };
  }
  return {
    version: 4,
    sessionId: 'test-dag-edge',
    dag,
    stages: stagesObj,
    pipelineActive: true,
    activeStages: [],
    retries: {},
    retryHistory: {},
    crashes: {},
    pendingRetry: null,
    classification: null,
    environment: {},
    meta: { initialized: true, reclassifications: [] },
    ...stateOverrides,
  };
}

// ════════════════════════════════════════════════════════════
// 1. derivePhase — 各分支邊界案例
// ════════════════════════════════════════════════════════════

console.log('\n--- 1. derivePhase 邊界案例 ---');

test('derivePhase: null state → IDLE', () => {
  assert.strictEqual(ds.derivePhase(null), PHASES.IDLE);
});

test('derivePhase: pipelineActive=false + 無 DAG → IDLE', () => {
  const state = { pipelineActive: false, dag: null, stages: {} };
  assert.strictEqual(ds.derivePhase(state), PHASES.IDLE);
});

test('derivePhase: pipelineActive=false + DAG 有階段但尚未完成 → IDLE', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW'], {}, { pipelineActive: false });
  assert.strictEqual(ds.derivePhase(state), PHASES.IDLE);
});

test('derivePhase: pipelineActive=false + 所有 stage completed → COMPLETE', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.COMPLETED },
    },
    { pipelineActive: false }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.COMPLETE);
});

test('derivePhase: pipelineActive=false + 所有 stage skipped → COMPLETE', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {
      DEV: { status: STAGE_STATUS.SKIPPED },
      REVIEW: { status: STAGE_STATUS.SKIPPED },
    },
    { pipelineActive: false }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.COMPLETE);
});

test('derivePhase: pipelineActive=false + mixed completed/skipped → COMPLETE', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW', 'TEST'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.SKIPPED },
      TEST: { status: STAGE_STATUS.COMPLETED },
    },
    { pipelineActive: false }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.COMPLETE);
});

test('derivePhase: pipelineActive=true + 無 DAG → CLASSIFIED', () => {
  const state = { pipelineActive: true, dag: null, stages: {}, activeStages: [] };
  assert.strictEqual(ds.derivePhase(state), PHASES.CLASSIFIED);
});

test('derivePhase: pipelineActive=true + DAG 為空物件 → CLASSIFIED', () => {
  const state = { pipelineActive: true, dag: {}, stages: {}, activeStages: [] };
  assert.strictEqual(ds.derivePhase(state), PHASES.CLASSIFIED);
});

test('derivePhase: pipelineActive=true + activeStages 非空 → DELEGATING', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW'], {}, { activeStages: ['DEV'] });
  assert.strictEqual(ds.derivePhase(state), PHASES.DELEGATING);
});

test('derivePhase: pipelineActive=true + 全部 stages completed → COMPLETE', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.COMPLETED },
    }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.COMPLETE);
});

test('derivePhase: pipelineActive=true + 有 FAILED stage + retries → RETRYING', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.FAILED },
    },
    { retries: { REVIEW: 1 } }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.RETRYING);
});

test('derivePhase: pipelineActive=true + pendingRetry.stages 非空 → RETRYING', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {},
    { pendingRetry: { stages: ['DEV'], reason: 'test' } }
  );
  assert.strictEqual(ds.derivePhase(state), PHASES.RETRYING);
});

test('derivePhase: pipelineActive=true + 無 active/failed/complete → CLASSIFIED', () => {
  // 所有 stage 都是 pending，無 active、無 failed、無 retries
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  assert.strictEqual(ds.derivePhase(state), PHASES.CLASSIFIED);
});

// ════════════════════════════════════════════════════════════
// 2. getReadyStages — 各種依賴情況
// ════════════════════════════════════════════════════════════

console.log('\n--- 2. getReadyStages 邊界案例 ---');

test('getReadyStages: null state → 空陣列', () => {
  assert.deepStrictEqual(ds.getReadyStages(null), []);
});

test('getReadyStages: 無 DAG → 空陣列', () => {
  const state = { dag: null, stages: {} };
  assert.deepStrictEqual(ds.getReadyStages(state), []);
});

test('getReadyStages: 空 DAG → 空陣列', () => {
  const state = { dag: {}, stages: {} };
  assert.deepStrictEqual(ds.getReadyStages(state), []);
});

test('getReadyStages: 線性 DAG 頭節點無 deps → 頭節點 ready', () => {
  const state = makeStateWithDag(['PLAN', 'ARCH', 'DEV']);
  const ready = ds.getReadyStages(state);
  assert.deepStrictEqual(ready, ['PLAN'], `應只有 PLAN，實際: ${JSON.stringify(ready)}`);
});

test('getReadyStages: 前驅 completed → 後繼 ready', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.COMPLETED } }
  );
  const ready = ds.getReadyStages(state);
  assert.deepStrictEqual(ready, ['REVIEW']);
});

test('getReadyStages: 前驅 active（非 completed）→ 後繼不 ready', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.ACTIVE } }
  );
  const ready = ds.getReadyStages(state);
  // DEV 是 active 非 pending，REVIEW deps 未滿足（DEV 非 completed/skipped）
  assert.strictEqual(ready.includes('REVIEW'), false, 'DEV active 時 REVIEW 不應 ready');
});

test('getReadyStages: 前驅 skipped 也視為 deps 滿足', () => {
  // SKIPPED 等同滿足 deps（與 completed 同等對待）
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.SKIPPED } }
  );
  const ready = ds.getReadyStages(state);
  assert.deepStrictEqual(ready, ['REVIEW'], '前驅 skipped 時後繼應 ready');
});

test('getReadyStages: 已是 active 的 stage 不再出現在 ready 清單', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.ACTIVE } }
  );
  const ready = ds.getReadyStages(state);
  assert.strictEqual(ready.includes('DEV'), false, 'active stage 不應出現在 ready');
});

test('getReadyStages: 多個前驅（並行 DAG）須全部完成才 ready', () => {
  // DOCS 需要 REVIEW + TEST 都完成
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
      DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.COMPLETED },
      TEST: { status: STAGE_STATUS.PENDING },
      DOCS: { status: STAGE_STATUS.PENDING },
    },
  };
  const ready = ds.getReadyStages(state);
  // TEST ready（DEV completed），DOCS 不 ready（TEST pending）
  assert.ok(ready.includes('TEST'), 'TEST 應 ready（DEV completed）');
  assert.ok(!ready.includes('DOCS'), 'DOCS 不 ready（TEST 未完成）');
});

test('getReadyStages: 多個前驅全部完成 → DOCS ready', () => {
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
      DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.COMPLETED },
      TEST: { status: STAGE_STATUS.COMPLETED },
      DOCS: { status: STAGE_STATUS.PENDING },
    },
  };
  const ready = ds.getReadyStages(state);
  assert.ok(ready.includes('DOCS'), 'REVIEW+TEST 都 completed 後 DOCS 應 ready');
});

// ════════════════════════════════════════════════════════════
// 3. isActive / isComplete 邊界案例
// ════════════════════════════════════════════════════════════

console.log('\n--- 3. isActive / isComplete ---');

test('isActive: null → false', () => {
  assert.strictEqual(ds.isActive(null), false);
});

test('isActive: pipelineActive=true → true', () => {
  assert.strictEqual(ds.isActive({ pipelineActive: true }), true);
});

test('isActive: pipelineActive=false → false', () => {
  assert.strictEqual(ds.isActive({ pipelineActive: false }), false);
});

test('isActive: pipelineActive=undefined → false', () => {
  assert.strictEqual(ds.isActive({}), false);
});

test('isComplete: 所有 stage completed + pipelineActive=false → true', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: 'completed' }, REVIEW: { status: 'completed' } },
    { pipelineActive: false }
  );
  assert.strictEqual(ds.isComplete(state), true);
});

test('isComplete: 有 pending stage → false', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW'], { DEV: { status: 'completed' } });
  assert.strictEqual(ds.isComplete(state), false);
});

// ════════════════════════════════════════════════════════════
// 4. setStageContextFile 邊界案例
// ════════════════════════════════════════════════════════════

console.log('\n--- 4. setStageContextFile 邊界案例 ---');

test('setStageContextFile: stageId 不存在 → 回傳原 state 不崩潰', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  const result = ds.setStageContextFile(state, 'NONEXISTENT', '/tmp/ctx.md');
  assert.ok(result, '應回傳 state');
  assert.deepStrictEqual(result, state, '不存在的 stageId 不應修改 state');
});

test('setStageContextFile: null state → 回傳 null（防禦性）', () => {
  const result = ds.setStageContextFile(null, 'DEV', '/tmp/ctx.md');
  assert.strictEqual(result, null);
});

test('setStageContextFile: 設定路徑後可讀回', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  const ctxPath = '/tmp/pipeline-context-test-DEV.md';
  const updated = ds.setStageContextFile(state, 'DEV', ctxPath);
  assert.strictEqual(updated.stages['DEV'].contextFile, ctxPath);
});

test('setStageContextFile: 設定 null 路徑清除 contextFile', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW'], {
    DEV: { status: 'active', contextFile: '/old/path.md' },
  });
  const updated = ds.setStageContextFile(state, 'DEV', null);
  assert.strictEqual(updated.stages['DEV'].contextFile, null);
});

// ════════════════════════════════════════════════════════════
// 5. markStageFailed — retries 累加驗證
// ════════════════════════════════════════════════════════════

console.log('\n--- 5. markStageFailed retries 累加 ---');

test('markStageFailed: 首次失敗 retries[stage]=1', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  const updated = ds.markStageFailed(state, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH' });
  assert.strictEqual(updated.retries['REVIEW'], 1, '首次失敗 retries 應為 1');
  assert.strictEqual(updated.stages['REVIEW'].status, STAGE_STATUS.FAILED);
});

test('markStageFailed: 第二次失敗 retries[stage]=2', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW'], {}, { retries: { REVIEW: 1 } });
  const updated = ds.markStageFailed(state, 'REVIEW', { verdict: 'FAIL', severity: 'MEDIUM' });
  assert.strictEqual(updated.retries['REVIEW'], 2, '第二次失敗 retries 應累加到 2');
});

test('markStageFailed: 不影響其他 stage 的 retries', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW', 'TEST'], {}, { retries: { DEV: 1 } });
  const updated = ds.markStageFailed(state, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH' });
  assert.strictEqual(updated.retries['DEV'], 1, 'DEV 的 retries 不應被改變');
  assert.strictEqual(updated.retries['REVIEW'], 1, 'REVIEW retries 應設為 1');
});

// ════════════════════════════════════════════════════════════
// 6. resetStageToPending — 清理時間戳
// ════════════════════════════════════════════════════════════

console.log('\n--- 6. resetStageToPending ---');

test('resetStageToPending: status 改為 pending，verdict 清除', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    {
      REVIEW: {
        status: STAGE_STATUS.FAILED,
        verdict: { verdict: 'FAIL', severity: 'HIGH' },
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T01:00:00Z',
      },
    }
  );
  const updated = ds.resetStageToPending(state, 'REVIEW');
  assert.strictEqual(updated.stages['REVIEW'].status, STAGE_STATUS.PENDING, 'status 應為 pending');
  assert.strictEqual(updated.stages['REVIEW'].verdict, null, 'verdict 應清除');
  assert.strictEqual(updated.stages['REVIEW'].startedAt, null, 'startedAt 應清除');
  assert.strictEqual(updated.stages['REVIEW'].completedAt, null, 'completedAt 應清除');
});

test('resetStageToPending: 不影響其他 stages', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.COMPLETED } }
  );
  const updated = ds.resetStageToPending(state, 'REVIEW');
  assert.strictEqual(updated.stages['DEV'].status, STAGE_STATUS.COMPLETED, 'DEV status 不應變');
});

// ════════════════════════════════════════════════════════════
// 7. classify — shouldActivate 邏輯與 reclassifications
// ════════════════════════════════════════════════════════════

console.log('\n--- 7. classify shouldActivate + reclassifications ---');

test('classify: none pipeline → pipelineActive 不被設為 true', () => {
  const state = ds.createInitialState('test-classify');
  const updated = ds.classify(state, { pipelineId: 'none', taskType: 'trivial' });
  assert.strictEqual(updated.pipelineActive, false, 'none pipeline 不應啟動 guard');
});

test('classify: quick-dev pipeline → pipelineActive=true', () => {
  const state = ds.createInitialState('test-classify');
  const updated = ds.classify(state, { pipelineId: 'quick-dev', taskType: 'bugfix' });
  assert.strictEqual(updated.pipelineActive, true, 'quick-dev 應啟動 guard');
});

test('classify: 第二次分類（reclassification）記錄升級歷史', () => {
  const state1 = ds.createInitialState('test-reclassify');
  const state2 = ds.classify(state1, { pipelineId: 'fix', taskType: 'hotfix' });
  const state3 = ds.classify(state2, { pipelineId: 'quick-dev', taskType: 'bugfix' });

  assert.strictEqual(state3.meta.reclassifications.length, 1, '應有 1 筆 reclassification 記錄');
  assert.strictEqual(state3.meta.reclassifications[0].from, 'fix');
  assert.strictEqual(state3.meta.reclassifications[0].to, 'quick-dev');
});

test('classify: 設定 classifiedAt 時間戳', () => {
  const state = ds.createInitialState('test-classify-ts');
  const updated = ds.classify(state, { pipelineId: 'standard', taskType: 'feature' });
  assert.ok(updated.classification.classifiedAt, 'classifiedAt 應被設定');
  // 確認是合法的 ISO 時間字串
  const ts = new Date(updated.classification.classifiedAt);
  assert.ok(!isNaN(ts.getTime()), 'classifiedAt 應是合法的 ISO 時間字串');
});

// ════════════════════════════════════════════════════════════
// 8. cancelPipeline
// ════════════════════════════════════════════════════════════

console.log('\n--- 8. cancelPipeline ---');

test('cancelPipeline: 設定 pipelineActive=false', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  const updated = ds.cancel(state);
  assert.strictEqual(updated.pipelineActive, false, 'cancelPipeline 應設 pipelineActive=false');
});

test('cancelPipeline: 不清除 stages（保留審計軌跡）', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.COMPLETED } }
  );
  const updated = ds.cancel(state);
  assert.strictEqual(updated.stages['DEV'].status, STAGE_STATUS.COMPLETED, 'stages 狀態應保留');
});

// ════════════════════════════════════════════════════════════
// 9. reset / resetKeepingClassification
// ════════════════════════════════════════════════════════════

console.log('\n--- 9. reset / resetKeepingClassification ---');

test('reset: 清除 dag、stages、pipelineActive', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.COMPLETED } },
    { pipelineActive: true }
  );
  const fresh = ds.reset(state);
  assert.strictEqual(fresh.dag, null, 'reset 後 dag 應為 null');
  assert.deepStrictEqual(fresh.stages, {}, 'reset 後 stages 應為空物件');
  assert.strictEqual(fresh.pipelineActive, false, 'reset 後 pipelineActive 應為 false');
});

test('reset: 保留 sessionId 和 environment', () => {
  const state = makeStateWithDag(
    ['DEV'],
    {},
    { sessionId: 'keep-me', environment: { languages: { primary: 'TypeScript' } } }
  );
  const fresh = ds.reset(state);
  assert.strictEqual(fresh.sessionId, 'keep-me', 'sessionId 應被保留');
  assert.deepStrictEqual(
    fresh.environment,
    { languages: { primary: 'TypeScript' } },
    'environment 應被保留'
  );
});

test('resetKeepingClassification: 保留 classification', () => {
  const state = ds.classify(
    ds.createInitialState('test-rkc'),
    { pipelineId: 'standard', taskType: 'feature' }
  );
  const fresh = ds.resetKeepingClassification(state);
  assert.ok(fresh.classification, 'classification 應被保留');
  assert.strictEqual(fresh.classification.pipelineId, 'standard', 'pipelineId 應保留');
  assert.strictEqual(fresh.pipelineActive, false, 'pipelineActive 應重設為 false');
  assert.strictEqual(fresh.dag, null, 'dag 應清除');
});

test('resetKeepingClassification: 保留 reclassifications 歷史', () => {
  let state = ds.createInitialState('test-rkc-reclass');
  state = ds.classify(state, { pipelineId: 'fix', taskType: 'hotfix' });
  state = ds.classify(state, { pipelineId: 'quick-dev', taskType: 'bugfix' });

  const fresh = ds.resetKeepingClassification(state);
  assert.ok(Array.isArray(fresh.meta.reclassifications), 'reclassifications 應是陣列');
  assert.strictEqual(fresh.meta.reclassifications.length, 1, '應保留 1 筆 reclassification');
});

// ════════════════════════════════════════════════════════════
// 10. setDag — 初始化 stages contextFile + pipelineActive
// ════════════════════════════════════════════════════════════

console.log('\n--- 10. setDag 初始化行為 ---');

test('setDag: 所有 stage 初始化為 pending + contextFile=null', () => {
  const state = ds.createInitialState('test-setdag');
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
  };
  const updated = ds.setDag(state, dag, null);

  assert.strictEqual(updated.pipelineActive, true, 'setDag 後 pipelineActive=true');
  for (const stageId of ['DEV', 'REVIEW']) {
    assert.strictEqual(updated.stages[stageId].status, STAGE_STATUS.PENDING,
      `${stageId} 應初始化為 pending`);
    assert.strictEqual(updated.stages[stageId].contextFile, null,
      `${stageId} contextFile 應初始化為 null`);
  }
});

test('setDag: blueprint 被正確儲存', () => {
  const state = ds.createInitialState('test-setdag-blueprint');
  const dag = { DEV: { deps: [] } };
  const blueprint = { description: 'test blueprint', stages: ['DEV'] };
  const updated = ds.setDag(state, dag, blueprint);
  assert.deepStrictEqual(updated.blueprint, blueprint, 'blueprint 應被儲存');
});

// ════════════════════════════════════════════════════════════
// 11. getActiveStages / getCompletedStages / getSkippedStages
// ════════════════════════════════════════════════════════════

console.log('\n--- 11. getActiveStages / getCompletedStages / getSkippedStages ---');

test('getActiveStages: null state → 空陣列', () => {
  assert.deepStrictEqual(ds.getActiveStages(null), []);
});

test('getActiveStages: 只回傳 active 狀態的 stage', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW', 'TEST'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.ACTIVE },
      TEST: { status: STAGE_STATUS.PENDING },
    }
  );
  assert.deepStrictEqual(ds.getActiveStages(state), ['REVIEW']);
});

test('getCompletedStages: 只回傳 completed 狀態的 stage', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW', 'TEST'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.ACTIVE },
      TEST: { status: STAGE_STATUS.PENDING },
    }
  );
  assert.deepStrictEqual(ds.getCompletedStages(state), ['DEV']);
});

test('getSkippedStages: 只回傳 skipped 狀態的 stage', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW', 'TEST'],
    {
      DEV: { status: STAGE_STATUS.COMPLETED },
      REVIEW: { status: STAGE_STATUS.SKIPPED },
      TEST: { status: STAGE_STATUS.PENDING },
    }
  );
  assert.deepStrictEqual(ds.getSkippedStages(state), ['REVIEW']);
});

test('getSkippedStages: 無 skipped stage → 空陣列', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  assert.deepStrictEqual(ds.getSkippedStages(state), []);
});

// ════════════════════════════════════════════════════════════
// 12. getCurrentStage — 從 stages 找第一個 active
// ════════════════════════════════════════════════════════════

console.log('\n--- 12. getCurrentStage ---');

test('getCurrentStage: 有 active stage → 回傳 stageId', () => {
  const state = makeStateWithDag(
    ['DEV', 'REVIEW'],
    { DEV: { status: STAGE_STATUS.ACTIVE } }
  );
  assert.strictEqual(ds.getCurrentStage(state), 'DEV');
});

test('getCurrentStage: 無 active stage → null', () => {
  const state = makeStateWithDag(['DEV', 'REVIEW']);
  assert.strictEqual(ds.getCurrentStage(state), null);
});

// ════════════════════════════════════════════════════════════
// 13. createInitialState — 欄位完整性
// ════════════════════════════════════════════════════════════

console.log('\n--- 13. createInitialState 欄位完整性 ---');

test('createInitialState: 必要欄位存在', () => {
  const state = ds.createInitialState('test-init');
  assert.strictEqual(state.version, 4, 'version 應為 4');
  assert.strictEqual(state.sessionId, 'test-init', 'sessionId 正確');
  assert.strictEqual(state.pipelineActive, false, 'pipelineActive 初始為 false');
  assert.deepStrictEqual(state.activeStages, [], 'activeStages 初始為空陣列');
  assert.deepStrictEqual(state.stages, {}, 'stages 初始為空物件');
  assert.deepStrictEqual(state.retries, {}, 'retries 初始為空物件');
  assert.deepStrictEqual(state.retryHistory, {}, 'retryHistory 初始為空物件');
  assert.deepStrictEqual(state.crashes, {}, 'crashes 初始為空物件');
  assert.strictEqual(state.dag, null, 'dag 初始為 null');
  assert.strictEqual(state.classification, null, 'classification 初始為 null');
  assert.ok(state.meta.initialized, 'meta.initialized=true');
});

test('createInitialState: 接受 options 參數', () => {
  const env = { languages: { primary: 'Python' } };
  const state = ds.createInitialState('test-opts', {
    environment: env,
    openspecEnabled: true,
    pipelineRules: ['rule1'],
  });
  assert.deepStrictEqual(state.environment, env, 'environment 正確傳入');
  assert.strictEqual(state.openspecEnabled, true, 'openspecEnabled 正確');
  assert.deepStrictEqual(state.meta.pipelineRules, ['rule1'], 'pipelineRules 正確');
});

// ════════════════════════════════════════════════════════════
// 結果
// ════════════════════════════════════════════════════════════

console.log(`\n=== dag-state-edge.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
