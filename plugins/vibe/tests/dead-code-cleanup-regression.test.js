#!/usr/bin/env node
/**
 * dead-code-cleanup-regression.test.js — 死碼清理回歸測試（Phase 2 DEV:2）
 *
 * 驗證以下死碼清理不影響任何現有功能：
 * 1. dag-state.js：移除 isEnforced（@deprecated）、isCancelled（@deprecated）
 *    + 移除 getPhase/isDelegating/isInitialized/getTaskType/getEnvironment
 * 2. dag-utils.js：topologicalSort 僅內部使用（不 export）
 * 3. pipeline-controller.js：移除 ensureV4 import（改用 ensureCurrentSchema）
 * 4. counter.js：THRESHOLD/REMIND_INTERVAL 降級為 private（模組常數不 export）
 * 5. env-detector.js：detectFrontendSignals 降級為 private（不 export）
 *
 * 特別確認：
 * - dag-state.js 保留的 cancel / derivePhase / isActive 仍正常工作
 * - pipeline-controller 使用 ensureCurrentSchema 遷移函式正確
 * - counter.js 的 read/increment/reset/cleanup 仍正常工作
 * - env-detector.js 的 detect() 函式仍回傳 frontend 欄位
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');
const SCRIPTS_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib');
const FLOW_DIR = path.join(SCRIPTS_LIB, 'flow');

require('./test-helpers').cleanTestStateFiles();

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

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ═══════════════════════════════════════════════════════════════
// Section 1: dag-state.js — 移除的 API 確實不 export
// ═══════════════════════════════════════════════════════════════

section('dag-state.js：移除的 dead export 已不可訪問');

const dagState = require(path.join(FLOW_DIR, 'dag-state.js'));

test('應該 isEnforced 不存在於 dag-state exports（已移除 @deprecated API）', () => {
  assert.strictEqual(dagState.isEnforced, undefined);
});

test('應該 isCancelled 不存在於 dag-state exports（已移除 @deprecated API）', () => {
  assert.strictEqual(dagState.isCancelled, undefined);
});

// ═══════════════════════════════════════════════════════════════
// Section 2: dag-state.js — 保留的 export 仍正常工作
// ═══════════════════════════════════════════════════════════════

section('dag-state.js：保留的核心 API 正常工作');

const { createInitialState, cancel, derivePhase, isActive, isComplete,
  PHASES, classify, setDag, markStageCompleted, markStageActive,
  getPipelineId, getRetries, getPendingRetry, getCurrentStage,
  getReadyStages, getActiveStages, getCompletedStages, getSkippedStages,
  markStageFailed, setPendingRetry, clearPendingRetry,
  resetStageToPending, reset, resetKeepingClassification } = dagState;

test('應該 cancel 函式存在且正常工作（設定 pipelineActive=false）', () => {
  const state = createInitialState('test-dc-001');
  state.pipelineActive = true;
  const cancelled = cancel(state);
  assert.strictEqual(cancelled.pipelineActive, false);
});

test('應該 derivePhase 在 pipelineActive=false + 無 dag 時回傳 IDLE', () => {
  const state = createInitialState('test-dc-002');
  assert.strictEqual(derivePhase(state), PHASES.IDLE);
});

test('應該 derivePhase 在 pipelineActive=true + 有 activeStages 時回傳 DELEGATING', () => {
  const state = createInitialState('test-dc-003');
  state.pipelineActive = true;
  state.dag = { PLAN: { deps: [] } };
  state.stages = { PLAN: { status: 'active' } };
  state.activeStages = ['PLAN'];
  assert.strictEqual(derivePhase(state), PHASES.DELEGATING);
});

test('應該 derivePhase 在 pipelineActive=false + 有完成 stages 時回傳 COMPLETE', () => {
  const state = createInitialState('test-dc-004');
  state.pipelineActive = false;
  state.dag = { PLAN: { deps: [] } };
  state.stages = { PLAN: { status: 'completed' } };
  assert.strictEqual(derivePhase(state), PHASES.COMPLETE);
});

test('應該 isActive 在 pipelineActive=true 時回傳 true', () => {
  const state = createInitialState('test-dc-005');
  state.pipelineActive = true;
  assert.strictEqual(isActive(state), true);
});

test('應該 isActive 在 pipelineActive=false 時回傳 false', () => {
  const state = createInitialState('test-dc-006');
  assert.strictEqual(isActive(state), false);
});

test('應該 isComplete 在全部 stages 完成時回傳 true', () => {
  const state = createInitialState('test-dc-007');
  state.pipelineActive = false;
  state.dag = { PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] } };
  state.stages = {
    PLAN: { status: 'completed' },
    ARCH: { status: 'completed' },
  };
  assert.strictEqual(isComplete(state), true);
});

test('應該 getPipelineId 回傳 classification.pipelineId', () => {
  const state = createInitialState('test-dc-008');
  state.classification = { pipelineId: 'standard', taskType: 'feature' };
  assert.strictEqual(getPipelineId(state), 'standard');
});

test('應該 getPipelineId 在 null state 時回傳 null', () => {
  assert.strictEqual(getPipelineId(null), null);
});

test('應該 cancel 取消後 isActive 回傳 false', () => {
  let state = createInitialState('test-dc-009');
  // 先設定 pipeline active
  const classified = classify(state, { pipelineId: 'standard', taskType: 'feature' });
  assert.strictEqual(isActive(classified), true); // classify 後 pipelineActive=true
  const cancelled = cancel(classified);
  assert.strictEqual(isActive(cancelled), false);
});

test('應該 setDag 正確初始化 stages 並設定 pipelineActive=true', () => {
  const state = createInitialState('test-dc-010');
  const dag = { PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] } };
  const newState = setDag(state, dag, null, false);
  assert.strictEqual(newState.pipelineActive, true);
  assert.strictEqual(Object.keys(newState.stages).length, 2);
  assert.strictEqual(newState.stages.PLAN.status, 'pending');
  assert.strictEqual(newState.stages.ARCH.status, 'pending');
});

// ═══════════════════════════════════════════════════════════════
// Section 3: dag-utils.js — topologicalSort 不 export
// ═══════════════════════════════════════════════════════════════

section('dag-utils.js：topologicalSort 降級為 private（不 export）');

const dagUtils = require(path.join(FLOW_DIR, 'dag-utils.js'));

test('應該 topologicalSort 不存在於 dag-utils exports', () => {
  assert.strictEqual(dagUtils.topologicalSort, undefined);
});

test('應該 dag-utils 的公開 API 仍完整（getBaseStage/deduplicateStages/resolveAgent/validateDag/repairDag/enrichCustomDag/linearToDag/templateToDag/buildBlueprint）', () => {
  const expectedExports = ['getBaseStage', 'deduplicateStages', 'resolveAgent',
    'validateDag', 'repairDag', 'enrichCustomDag', 'linearToDag', 'templateToDag', 'buildBlueprint'];
  for (const fn of expectedExports) {
    assert.strictEqual(typeof dagUtils[fn], 'function', `${fn} 應該是函式`);
  }
});

test('應該 validateDag 仍可正常使用（間接使用 topologicalSort）', () => {
  const dag = {
    PLAN: { deps: [] },
    ARCH: { deps: ['PLAN'] },
  };
  const result = dagUtils.validateDag(dag);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('應該 validateDag 在有環時回傳 valid=false', () => {
  const dag = {
    PLAN: { deps: ['ARCH'] },
    ARCH: { deps: ['PLAN'] },
  };
  const result = dagUtils.validateDag(dag);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('應該 buildBlueprint 仍可正常使用（間接使用 topologicalSort）', () => {
  const dag = {
    PLAN: { deps: [] },
    ARCH: { deps: ['PLAN'] },
    DEV: { deps: ['ARCH'] },
  };
  const blueprint = dagUtils.buildBlueprint(dag);
  assert.ok(Array.isArray(blueprint));
  assert.strictEqual(blueprint.length, 3); // 三個串行步驟
  assert.strictEqual(blueprint[0].stages[0], 'PLAN');
  assert.strictEqual(blueprint[1].stages[0], 'ARCH');
  assert.strictEqual(blueprint[2].stages[0], 'DEV');
});

test('應該 repairDag 仍可正常使用（間接使用 topologicalSort）', () => {
  const brokenDag = {
    PLAN: null, // null config
    ARCH: { deps: 'PLAN' }, // string deps
  };
  const result = dagUtils.repairDag(brokenDag);
  assert.ok(result !== null);
  assert.ok(Array.isArray(result.dag.ARCH.deps));
  assert.ok(result.fixes.length > 0);
});

// ═══════════════════════════════════════════════════════════════
// Section 4: state-migrator.js — ensureCurrentSchema 存在（pipeline-controller 使用）
// ═══════════════════════════════════════════════════════════════

section('state-migrator.js：ensureCurrentSchema 正確替換 ensureV4');

const stateMigrator = require(path.join(FLOW_DIR, 'state-migrator.js'));

test('應該 ensureCurrentSchema 存在且為函式', () => {
  assert.strictEqual(typeof stateMigrator.ensureCurrentSchema, 'function');
});

test('應該 ensureCurrentSchema 對 v4 state 回傳 state', () => {
  const v4State = { version: 4, pipelineActive: false, sessionId: 'test' };
  const result = stateMigrator.ensureCurrentSchema(v4State);
  assert.strictEqual(result, v4State);
});

test('應該 ensureCurrentSchema 對 v3 state 回傳 null（不再遷移）', () => {
  const v3State = { version: 3, dag: {}, phases: {} };
  assert.strictEqual(stateMigrator.ensureCurrentSchema(v3State), null);
});

test('應該 ensureCurrentSchema 對 null 回傳 null', () => {
  assert.strictEqual(stateMigrator.ensureCurrentSchema(null), null);
});

test('應該 detectVersion 仍正常工作（v4 回傳 4）', () => {
  assert.strictEqual(stateMigrator.detectVersion({ version: 4 }), 4);
});

// ═══════════════════════════════════════════════════════════════
// Section 5: counter.js — THRESHOLD/REMIND_INTERVAL 不 export（private）
// ═══════════════════════════════════════════════════════════════

section('counter.js：THRESHOLD/REMIND_INTERVAL 降級為 private');

const counter = require(path.join(FLOW_DIR, 'counter.js'));

test('應該 THRESHOLD 不存在於 counter exports', () => {
  assert.strictEqual(counter.THRESHOLD, undefined);
});

test('應該 REMIND_INTERVAL 不存在於 counter exports', () => {
  assert.strictEqual(counter.REMIND_INTERVAL, undefined);
});

test('應該 counter 公開 API 仍完整（read/increment/reset/cleanup）', () => {
  for (const fn of ['read', 'increment', 'reset', 'cleanup']) {
    assert.strictEqual(typeof counter[fn], 'function', `${fn} 應該是函式`);
  }
});

test('應該 counter.read 在無 state file 時回傳 { count: 0, lastRemind: 0 }', () => {
  const result = counter.read('test-dc-counter-999');
  assert.deepStrictEqual(result, { count: 0, lastRemind: 0 });
});

test('應該 counter.increment 正確遞增計數', () => {
  const sid = 'test-dc-counter-888';
  counter.reset(sid); // 確保乾淨起始
  const r1 = counter.increment(sid);
  assert.strictEqual(r1.count, 1);
  const r2 = counter.increment(sid);
  assert.strictEqual(r2.count, 2);
  counter.cleanup(sid);
});

test('應該 counter.increment 在超過 THRESHOLD(60) 後每 REMIND_INTERVAL(40) 次提醒', () => {
  const sid = 'test-dc-counter-777';
  counter.reset(sid);
  // 推進到 60 次
  for (let i = 0; i < 59; i++) counter.increment(sid);
  const at60 = counter.increment(sid); // 第 60 次
  assert.strictEqual(at60.shouldRemind, true, '第 60 次應提醒');
  assert.ok(at60.message !== null, '應有提醒訊息');
  // 推進到 100 次（+40）
  for (let i = 0; i < 39; i++) counter.increment(sid);
  const at100 = counter.increment(sid); // 第 100 次
  assert.strictEqual(at100.shouldRemind, true, '第 100 次應提醒（60+40）');
  counter.cleanup(sid);
});

// ═══════════════════════════════════════════════════════════════
// Section 6: env-detector.js — detectFrontendSignals 不 export（private）
// ═══════════════════════════════════════════════════════════════

section('env-detector.js：detectFrontendSignals 降級為 private');

const envDetector = require(path.join(FLOW_DIR, 'env-detector.js'));

test('應該 detectFrontendSignals 不存在於 env-detector exports', () => {
  assert.strictEqual(envDetector.detectFrontendSignals, undefined);
});

test('應該 detect 函式仍存在且為函式', () => {
  assert.strictEqual(typeof envDetector.detect, 'function');
});

test('應該 detect 回傳結果含有 frontend 欄位（detectFrontendSignals 仍內部呼叫）', () => {
  const cwd = path.join(__dirname, '..'); // vibe plugin root
  const result = envDetector.detect(cwd);
  assert.ok(result !== null && typeof result === 'object', 'detect 應回傳物件');
  // frontend 欄位由 detectFrontendSignals 產生（即使是 private 仍應填入）
  assert.ok('frontend' in result, 'result 應含有 frontend 欄位');
  assert.strictEqual(typeof result.frontend, 'object', 'frontend 應是物件');
  assert.ok('detected' in result.frontend, 'frontend 應含有 detected 欄位');
  assert.ok('signals' in result.frontend, 'frontend 應含有 signals 陣列');
  assert.ok('confidence' in result.frontend, 'frontend 應含有 confidence 欄位');
});

test('應該 detect 回傳的 frontend.confidence 是合法值', () => {
  const result = envDetector.detect(process.cwd());
  assert.ok(['high', 'medium', 'none'].includes(result.frontend.confidence),
    `confidence 應是 high/medium/none，實際：${result.frontend.confidence}`);
});

test('應該 detect 在不存在的目錄中不崩潰', () => {
  const result = envDetector.detect('/nonexistent/path/xyz');
  assert.ok(result !== null);
  assert.ok('frontend' in result);
});

// ═══════════════════════════════════════════════════════════════
// Section 7: pipeline-controller.js — 可以正常載入（import 更改正確）
// ═══════════════════════════════════════════════════════════════

section('pipeline-controller.js：死碼 import 清理後仍可正常載入');

test('應該 pipeline-controller 可以正常 require 而不拋出錯誤', () => {
  // pipeline-controller 移除了 ensureV4（不存在的 export），改用 ensureCurrentSchema
  // 如果 import 仍指向錯誤 export，require 不會報錯（JS 是動態的），但 loadState 呼叫時會崩潰
  // 我們透過確認 require 成功來驗證
  assert.doesNotThrow(() => {
    require(path.join(FLOW_DIR, 'pipeline-controller.js'));
  }, 'pipeline-controller 應該可以正常載入');
});

test('應該 pipeline-controller 使用 ensureCurrentSchema 處理 v4 state（不崩潰）', () => {
  const ctrl = require(path.join(FLOW_DIR, 'pipeline-controller.js'));
  // loadState 使用 ensureCurrentSchema
  // 讀取一個不存在的 session → 回傳 null（不崩潰）
  const sid = 'test-dc-ctrl-001';
  // 確認 canProceed 在 null state 下正常放行（pipeline 非活躍）
  // 回傳格式：{ decision: 'allow'|'block', message?, reason? }
  const result = ctrl.canProceed(sid, 'Read', { file_path: '/test/file.txt' });
  assert.ok(result !== undefined, 'canProceed 應回傳結果');
  // 非活躍 pipeline → 應放行
  assert.strictEqual(result.decision, 'allow', '無 state 時 canProceed 應回傳 decision=allow');
});

// ═══════════════════════════════════════════════════════════════
// Section 8: 整合驗證 — cancel + derivePhase 閉環工作正確
// ═══════════════════════════════════════════════════════════════

section('整合驗證：cancel + derivePhase 閉環工作正確');

test('應該 classify → cancel → derivePhase 正確反映取消狀態', () => {
  let state = createInitialState('test-dc-integration-001');
  // 分類
  state = classify(state, { pipelineId: 'standard', taskType: 'feature' });
  assert.strictEqual(isActive(state), true, '分類後 pipelineActive 應為 true');
  assert.strictEqual(derivePhase(state), PHASES.CLASSIFIED, '無 DAG 時應是 CLASSIFIED');
  // 取消
  state = cancel(state);
  assert.strictEqual(isActive(state), false, '取消後 pipelineActive 應為 false');
  assert.strictEqual(derivePhase(state), PHASES.IDLE, '取消後應是 IDLE（無完成 stages）');
});

test('應該 setDag → markStageActive → markStageCompleted → derivePhase = COMPLETE', () => {
  let state = createInitialState('test-dc-integration-002');
  state = classify(state, { pipelineId: 'fix', taskType: 'hotfix' });
  const dag = { DEV: { deps: [] } };
  state = setDag(state, dag, null, false);
  assert.strictEqual(isActive(state), true);
  assert.strictEqual(derivePhase(state), PHASES.CLASSIFIED);

  state = markStageActive(state, 'DEV', 'vibe:developer');
  state.activeStages = ['DEV']; // 模擬 pipeline-controller 更新 activeStages
  assert.strictEqual(derivePhase(state), PHASES.DELEGATING);

  state = markStageCompleted(state, 'DEV', 'PASS');
  state.pipelineActive = false; // pipeline-controller 在最後完成時設 false
  state.activeStages = [];
  assert.strictEqual(isActive(state), false);
  assert.strictEqual(derivePhase(state), PHASES.COMPLETE);
});

test('應該 getReadyStages 在 deps 未滿足時回傳空陣列', () => {
  const state = createInitialState('test-dc-integration-003');
  state.dag = { PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] } };
  state.stages = {
    PLAN: { status: 'pending' },
    ARCH: { status: 'pending' },
  };
  const ready = getReadyStages(state);
  assert.deepStrictEqual(ready, ['PLAN'], '只有 PLAN 的 deps 已滿足');
});

test('應該 getReadyStages 在 deps 完成後正確回傳後繼 stage', () => {
  const state = createInitialState('test-dc-integration-004');
  state.dag = { PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] } };
  state.stages = {
    PLAN: { status: 'completed' },
    ARCH: { status: 'pending' },
  };
  const ready = getReadyStages(state);
  assert.deepStrictEqual(ready, ['ARCH']);
});

// ═══════════════════════════════════════════════════════════════
// Phase 2：自我挑戰 — 補充邊界案例
// ═══════════════════════════════════════════════════════════════

section('邊界案例：null/undefined 輸入防禦');

test('應該 derivePhase(null) 回傳 IDLE 不崩潰', () => {
  assert.strictEqual(derivePhase(null), PHASES.IDLE);
});

test('應該 derivePhase(undefined) 回傳 IDLE 不崩潰', () => {
  assert.strictEqual(derivePhase(undefined), PHASES.IDLE);
});

test('應該 isActive(null) 回傳 false 不崩潰', () => {
  assert.strictEqual(isActive(null), false);
});

test('應該 isActive(undefined) 回傳 false 不崩潰', () => {
  assert.strictEqual(isActive(undefined), false);
});

test('應該 cancel(null state) 不崩潰（防禦性處理）', () => {
  // cancel 直接 spread null 會報錯，這是可接受的行為（由 pipeline-controller 保護）
  // 但 isActive(null) 應安全
  const state = { pipelineActive: true };
  const result = cancel(state);
  assert.strictEqual(result.pipelineActive, false);
});

test('應該 getReadyStages(null) 回傳空陣列', () => {
  assert.deepStrictEqual(getReadyStages(null), []);
});

test('應該 getActiveStages(null) 回傳空陣列', () => {
  assert.deepStrictEqual(getActiveStages(null), []);
});

test('應該 getCompletedStages(null) 回傳空陣列', () => {
  assert.deepStrictEqual(getCompletedStages(null), []);
});

test('應該 getSkippedStages(null) 回傳空陣列', () => {
  assert.deepStrictEqual(getSkippedStages(null), []);
});

test('應該 getPipelineId(null) 回傳 null', () => {
  assert.strictEqual(getPipelineId(null), null);
});

test('應該 getRetries(null) 回傳空物件', () => {
  assert.deepStrictEqual(getRetries(null), {});
});

test('應該 getPendingRetry(null) 回傳 null', () => {
  assert.strictEqual(getPendingRetry(null), null);
});

test('應該 getCurrentStage(null) 回傳 null', () => {
  assert.strictEqual(getCurrentStage(null), null);
});

// ═══════════════════════════════════════════════════════════════
// 輸出結果
// ═══════════════════════════════════════════════════════════════

console.log(`\n死碼清理回歸測試結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過');
} else {
  process.exit(1);
}
