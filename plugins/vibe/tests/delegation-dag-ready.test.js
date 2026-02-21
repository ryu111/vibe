/**
 * delegation-dag-ready.test.js — onDelegate DAG 就緒檢查測試
 *
 * 驗證 pipeline-controller.onDelegate() 在 pipeline 活躍時，
 * 拒絕委派依賴未滿足的 stage（防止跳過中間階段）。
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEST_SESSION = `test-dag-ready-${Date.now()}`;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

function setupState(state) {
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${TEST_SESSION}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2));
}

function cleanup() {
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${TEST_SESSION}.json`);
  try { fs.unlinkSync(fp); } catch (_) {}
}

// ── 標準 DAG：DEV → [REVIEW + TEST] → DOCS ──
function makeStandardState(stageOverrides = {}) {
  const stages = {
    DEV: { status: 'pending', ...stageOverrides.DEV },
    REVIEW: { status: 'pending', ...stageOverrides.REVIEW },
    TEST: { status: 'pending', ...stageOverrides.TEST },
    DOCS: { status: 'pending', ...stageOverrides.DOCS },
  };
  return {
    version: 4,
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
      DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages,
    pipelineActive: true,
    activeStages: [],
    classification: { pipelineId: 'standard', taskType: 'feature' },
    retries: {},
    crashes: {},
  };
}

console.log('\n=== onDelegate DAG 就緒檢查 ===\n');

// ── 放行案例 ──

test('無 pipeline state 時放行', () => {
  cleanup();
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:developer', {});
  assert.strictEqual(result.allow, true);
});

test('pipeline 不活躍時放行', () => {
  setupState({ ...makeStandardState(), pipelineActive: false });
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

test('DEV 無依賴 — 允許委派', () => {
  setupState(makeStandardState());
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:developer', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

test('DEV 已完成 — 允許委派 REVIEW', () => {
  setupState(makeStandardState({ DEV: { status: 'completed' } }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:code-reviewer', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

test('DEV 已完成 — 允許委派 TEST', () => {
  setupState(makeStandardState({ DEV: { status: 'completed' } }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:tester', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

test('REVIEW+TEST 已完成 — 允許委派 DOCS', () => {
  setupState(makeStandardState({
    DEV: { status: 'completed' },
    REVIEW: { status: 'completed' },
    TEST: { status: 'completed' },
  }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

test('非 pipeline agent 類型 — 放行（不在 AGENT_TO_STAGE 中）', () => {
  setupState(makeStandardState());
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:pipeline-architect', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

// ── 阻擋案例 ──

test('DEV 未完成 — 阻擋委派 REVIEW', () => {
  setupState(makeStandardState());
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:code-reviewer', {});
  assert.strictEqual(result.allow, false);
  assert.ok(result.message.includes('DEV'));
  cleanup();
});

test('DEV 未完成 — 阻擋委派 TEST', () => {
  setupState(makeStandardState());
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:tester', {});
  assert.strictEqual(result.allow, false);
  assert.ok(result.message.includes('DEV'));
  cleanup();
});

test('REVIEW 未完成 — 阻擋委派 DOCS', () => {
  setupState(makeStandardState({
    DEV: { status: 'completed' },
    TEST: { status: 'completed' },
    // REVIEW still pending
  }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, false);
  assert.ok(result.message.includes('REVIEW'));
  cleanup();
});

test('TEST 未完成 — 阻擋委派 DOCS', () => {
  setupState(makeStandardState({
    DEV: { status: 'completed' },
    REVIEW: { status: 'completed' },
    // TEST still pending
  }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, false);
  assert.ok(result.message.includes('TEST'));
  cleanup();
});

test('阻擋訊息包含就緒階段提示', () => {
  setupState(makeStandardState({
    DEV: { status: 'completed' },
    // REVIEW and TEST are ready, DOCS is not
  }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, false);
  assert.ok(result.message.includes('REVIEW') || result.message.includes('TEST'));
  cleanup();
});

// ── skipped 依賴視為已滿足 ──

test('依賴被 skipped — 視為已滿足', () => {
  setupState(makeStandardState({
    DEV: { status: 'completed' },
    REVIEW: { status: 'skipped' },
    TEST: { status: 'completed' },
  }));
  const result = ctrl.onDelegate(TEST_SESSION, 'vibe:doc-updater', {});
  assert.strictEqual(result.allow, true);
  cleanup();
});

// ── 清理 ──

cleanup();

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✅ 全部通過\n');
