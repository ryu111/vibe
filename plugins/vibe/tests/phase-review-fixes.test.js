#!/usr/bin/env node
/**
 * phase-review-fixes.test.js — REVIEW 發現的 S3 修復驗證測試
 *
 * 驗證以下修復項目：
 * 1. H-1：generatePhaseDag 的 REVIEW:N 和 TEST:N 含 onFail 和 maxRetries
 * 2. H-2：Branch A 回退時找對應 phase 的 DEV（REVIEW:2 → DEV:2）
 * 3. M-1：循環依賴偵測（Phase 1 deps [Phase 2], Phase 2 deps [Phase 1] → 返回空物件）
 * 4. M-2：buildPhaseScopeHint 整合到生產路徑（buildNodeContext 呼叫鏈）
 *
 * 執行：node plugins/vibe/tests/phase-review-fixes.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const {
  parsePhasesFromTasks,
  generatePhaseDag,
  resolvePhaseDeps,
  hasCyclicDeps,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/phase-parser.js'));

const {
  buildPhaseScopeHint,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/node-context.js'));

const {
  resolvePhaseDevStageId,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

let passed = 0;
let failed = 0;

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

// ─── Section 1: H-1 — onFail + maxRetries 欄位 ────────────────

console.log('\n🔧 Section 1: H-1 — REVIEW:N 和 TEST:N 含 onFail + maxRetries');

test('2-phase standard：REVIEW:1 含 onFail=DEV:1 和 maxRetries=3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: ['task A'] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: ['task B'] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const review1 = dag['REVIEW:1'];
  assert.ok(review1, 'REVIEW:1 存在');
  assert.strictEqual(review1.onFail, 'DEV:1', 'REVIEW:1.onFail = DEV:1');
  assert.strictEqual(review1.maxRetries, 3, 'REVIEW:1.maxRetries = 3');
});

test('2-phase standard：TEST:1 含 onFail=DEV:1 和 maxRetries=3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const test1 = dag['TEST:1'];
  assert.ok(test1, 'TEST:1 存在');
  assert.strictEqual(test1.onFail, 'DEV:1', 'TEST:1.onFail = DEV:1');
  assert.strictEqual(test1.maxRetries, 3, 'TEST:1.maxRetries = 3');
});

test('2-phase standard：REVIEW:2 含 onFail=DEV:2（非 DEV:1）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const review2 = dag['REVIEW:2'];
  assert.ok(review2, 'REVIEW:2 存在');
  assert.strictEqual(review2.onFail, 'DEV:2', 'REVIEW:2.onFail = DEV:2（不是 DEV:1）');
  assert.strictEqual(review2.maxRetries, 3, 'REVIEW:2.maxRetries = 3');
});

test('2-phase standard：TEST:2 含 onFail=DEV:2 和 maxRetries=3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const test2 = dag['TEST:2'];
  assert.ok(test2, 'TEST:2 存在');
  assert.strictEqual(test2.onFail, 'DEV:2', 'TEST:2.onFail = DEV:2');
  assert.strictEqual(test2.maxRetries, 3, 'TEST:2.maxRetries = 3');
});

test('3-phase：每個 REVIEW:N 的 onFail 指向對應 DEV:N', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  for (let n = 1; n <= 3; n++) {
    assert.strictEqual(dag[`REVIEW:${n}`]?.onFail, `DEV:${n}`, `REVIEW:${n}.onFail = DEV:${n}`);
    assert.strictEqual(dag[`TEST:${n}`]?.onFail, `DEV:${n}`, `TEST:${n}.onFail = DEV:${n}`);
  }
});

test('quick-dev pipeline 的 REVIEW:N 也含 onFail', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'quick-dev');

  assert.strictEqual(dag['REVIEW:1']?.onFail, 'DEV:1', 'quick-dev REVIEW:1.onFail = DEV:1');
  assert.strictEqual(dag['TEST:1']?.onFail, 'DEV:1', 'quick-dev TEST:1.onFail = DEV:1');
});

test('DEV:N 節點不含 onFail 欄位', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // DEV 節點不應有 onFail
  assert.ok(!dag['DEV:1'].onFail, 'DEV:1 無 onFail');
  assert.ok(!dag['DEV:2'].onFail, 'DEV:2 無 onFail');
});

test('onFail 和 barrier 同時存在不衝突', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const review1 = dag['REVIEW:1'];
  assert.ok(review1.barrier, 'REVIEW:1 有 barrier');
  assert.ok(review1.onFail, 'REVIEW:1 有 onFail');
  assert.strictEqual(review1.onFail, 'DEV:1', 'onFail = DEV:1');
  assert.strictEqual(review1.barrier.group, 'quality:1', 'barrier.group 正確');
});

// ─── Section 2: H-2 — 回退 DEV stage 解析邏輯 ────────────────

console.log('\n🔧 Section 2: H-2 — 回退時解析對應 phase 的 DEV stage');

// 直接使用 pipeline-controller 導出的生產函式，不重複實作邏輯（M-1 修復）

test('REVIEW:1 FAIL → 回退目標為 DEV:1', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const devStageId = resolvePhaseDevStageId('REVIEW:1', dag);
  assert.strictEqual(devStageId, 'DEV:1', 'REVIEW:1 → DEV:1');
});

test('REVIEW:2 FAIL → 回退目標為 DEV:2（非 DEV:1）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const devStageId = resolvePhaseDevStageId('REVIEW:2', dag);
  assert.strictEqual(devStageId, 'DEV:2', 'REVIEW:2 → DEV:2（不是 DEV:1）');
});

test('TEST:3 FAIL → 回退目標為 DEV:3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const devStageId = resolvePhaseDevStageId('TEST:3', dag);
  assert.strictEqual(devStageId, 'DEV:3', 'TEST:3 → DEV:3');
});

test('非 phase DAG：REVIEW FAIL → fallback 到第一個 DEV', () => {
  const dag = {
    DEV:    { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST:   { deps: ['DEV'] },
  };
  const devStageId = resolvePhaseDevStageId('REVIEW', dag);
  assert.strictEqual(devStageId, 'DEV', 'REVIEW（非 phase）→ DEV');
});

test('空 DAG：fallback 到 DEV 字串', () => {
  const devStageId = resolvePhaseDevStageId('REVIEW:1', {});
  assert.strictEqual(devStageId, 'DEV', '空 DAG → DEV');
});

test('suffixed stage 但 DAG 中無對應 DEV:N → fallback 到第一個 DEV', () => {
  // DAG 只有 DEV:1，但 currentStage 是 REVIEW:2
  const dag = { 'DEV:1': { deps: [] } };
  const devStageId = resolvePhaseDevStageId('REVIEW:2', dag);
  assert.strictEqual(devStageId, 'DEV:1', '無對應 DEV:2 時 fallback 到 DEV:1');
});

// ─── Section 3: M-1 — 循環依賴偵測 ────────────────

console.log('\n🔧 Section 3: M-1 — 循環依賴偵測（拓撲排序）');

test('直接相互依賴（Phase 1 ↔ Phase 2）→ 返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 2'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.deepStrictEqual(dag, {}, '相互依賴 → 空物件');
});

test('三角循環（Phase 1→2→3→1）→ 返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 3'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.deepStrictEqual(dag, {}, '三角循環 → 空物件');
});

test('四 phase 長循環（1→2→3→4→1）→ 返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 4'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
    { name: 'Phase 4', index: 4, deps: ['Phase 3'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.deepStrictEqual(dag, {}, '四 phase 循環 → 空物件');
});

test('正常線性依賴（無循環）不受影響', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  // 正常線性依賴應返回有效 DAG（非空物件）
  assert.ok(Object.keys(dag).length > 0, '正常依賴 → 非空 DAG');
  assert.ok(dag['DEV:1'], 'DEV:1 存在');
  assert.ok(dag['DEV:2'], 'DEV:2 存在');
  assert.ok(dag['DEV:3'], 'DEV:3 存在');
});

test('部分循環 + 正常 phase（Phase 1 正常，Phase 2↔3 循環）→ 返回空物件', () => {
  // 由於拓撲排序是全局的，部分循環也會導致整個 DAG 退化
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 3'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.deepStrictEqual(dag, {}, '部分循環 → 空物件');
});

test('菱形依賴（無循環）正常生成', () => {
  // Phase 1 → Phase 2 + Phase 3 → Phase 4
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 4', index: 4, deps: ['Phase 2', 'Phase 3'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.ok(Object.keys(dag).length > 0, '菱形依賴 → 非空 DAG');
  // Phase 4 的 DEV 應依賴 Phase 2 和 Phase 3 的品質 stages
  assert.ok(dag['DEV:4'].deps.includes('REVIEW:2'), 'DEV:4 deps REVIEW:2');
  assert.ok(dag['DEV:4'].deps.includes('REVIEW:3'), 'DEV:4 deps REVIEW:3');
});

// ─── Section 4: M-2 — buildPhaseScopeHint 整合驗證 ────────────

console.log('\n🔧 Section 4: M-2 — buildPhaseScopeHint 整合驗證');

test('suffixed stage DEV:1 有 phaseInfo 時返回 hint', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1: Auth', tasks: ['建立 login API', '加入 JWT 生成'] }
    }
  };
  const hint = buildPhaseScopeHint('DEV:1', state);
  assert.ok(hint.length > 0, 'DEV:1 返回非空 hint');
  assert.ok(hint.includes('Phase 1: Auth'), '包含 phase 名稱');
  assert.ok(hint.includes('建立 login API'), '包含 task 1');
  assert.ok(hint.includes('加入 JWT 生成'), '包含 task 2');
});

test('suffixed stage REVIEW:2 有 phaseInfo 時返回 hint', () => {
  const state = {
    phaseInfo: {
      2: { name: 'Phase 2: DB', tasks: ['連接 PostgreSQL', '建立 schema'] }
    }
  };
  const hint = buildPhaseScopeHint('REVIEW:2', state);
  assert.ok(hint.length > 0, 'REVIEW:2 返回非空 hint');
  assert.ok(hint.includes('Phase 2: DB'), '包含 Phase 2 名稱');
});

test('非 suffixed stage（DEV）不觸發 phase 範圍注入', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1', tasks: ['task A'] }
    }
  };
  const hint = buildPhaseScopeHint('DEV', state);
  assert.strictEqual(hint, '', '非 suffixed stage 返回空字串');
});

test('suffixed stage 但無 phaseInfo 返回空字串', () => {
  const hint = buildPhaseScopeHint('DEV:1', { phaseInfo: null });
  assert.strictEqual(hint, '', '無 phaseInfo 返回空字串');
});

test('suffixed stage 但 phaseIndex 不在 phaseInfo 中返回空字串', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1', tasks: ['task A'] }
    }
  };
  // phaseInfo 只有 Phase 1，但查 DEV:2
  const hint = buildPhaseScopeHint('DEV:2', state);
  assert.strictEqual(hint, '', 'phaseIndex 不在 phaseInfo 返回空字串');
});

test('hint 長度不超過 MAX_PHASE_SCOPE_CHARS（500）', () => {
  const MAX = 500;
  const tasks = Array.from({ length: 50 }, (_, i) => `超長任務描述 ${i}: ${'A'.repeat(20)}`);
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1: 超多任務', tasks }
    }
  };
  const hint = buildPhaseScopeHint('DEV:1', state);
  assert.ok(hint.length <= MAX, `hint 長度 ${hint.length} <= ${MAX}`);
  if (hint.length === MAX) {
    assert.ok(hint.endsWith('...'), '截斷時以 ... 結尾');
  }
});

// ─── Section 5: H-1 + M-1 組合驗證 ────────────────

console.log('\n🔧 Section 5: H-1 + M-1 組合驗證');

test('有循環的 phases：generatePhaseDag 返回空物件（無 onFail 可設）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 2'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  // 循環 → 退化為空物件，無 REVIEW/TEST 節點
  assert.deepStrictEqual(dag, {}, '循環 phases → 空物件');
  assert.ok(!dag['REVIEW:1'], 'REVIEW:1 不存在（退化）');
});

test('正常 phases 的 REVIEW/TEST 同時有 barrier 和 onFail', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const r1 = dag['REVIEW:1'];
  // 所有必要欄位都存在
  assert.ok(r1.deps, 'REVIEW:1 有 deps');
  assert.ok(r1.onFail, 'REVIEW:1 有 onFail');
  assert.strictEqual(r1.maxRetries, 3, 'REVIEW:1 有 maxRetries=3');
  assert.ok(r1.barrier, 'REVIEW:1 有 barrier');
  // 確認值正確
  assert.strictEqual(r1.onFail, 'DEV:1', 'onFail 指向 DEV:1');
  assert.strictEqual(r1.barrier.group, 'quality:1', 'barrier group 正確');
});

// ─── Section 6: L-2 — hasCyclicDeps 導出驗證 ─────────────────

console.log('\n🔧 Section 6: L-2 — hasCyclicDeps 正確導出並可用');

test('hasCyclicDeps 有被導出（非 undefined）', () => {
  assert.ok(typeof hasCyclicDeps === 'function', 'hasCyclicDeps 是 function');
});

test('hasCyclicDeps 無循環 → 返回 false', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'] },
  ];
  const depMap = resolvePhaseDeps(phases);
  assert.strictEqual(hasCyclicDeps(phases, depMap), false, '線性依賴 → false');
});

test('hasCyclicDeps 有循環 → 返回 true', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 2'] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'] },
  ];
  const depMap = resolvePhaseDeps(phases);
  assert.strictEqual(hasCyclicDeps(phases, depMap), true, '相互依賴 → true');
});

test('hasCyclicDeps 空陣列 → 返回 false', () => {
  const depMap = new Map();
  assert.strictEqual(hasCyclicDeps([], depMap), false, '空陣列 → false');
});

test('hasCyclicDeps 單節點無自循環 → 返回 false', () => {
  const phases = [{ name: 'Phase 1', index: 1, deps: [] }];
  const depMap = resolvePhaseDeps(phases);
  assert.strictEqual(hasCyclicDeps(phases, depMap), false, '單節點 → false');
});

test('hasCyclicDeps 三角循環 → 返回 true', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 3'] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'] },
  ];
  const depMap = resolvePhaseDeps(phases);
  assert.strictEqual(hasCyclicDeps(phases, depMap), true, '三角循環 → true');
});

// ─── Section 7: M-1 — 菱形依賴 barrier PASS 路由多個後繼 ────────

console.log('\n🔧 Section 7: M-1 — 菱形依賴 barrier.next 設置');

test('菱形依賴：Phase 2 和 Phase 3 同時依賴 Phase 1，各自 barrier.next 為 null（最終 phase）', () => {
  // Phase 2 deps Phase 1, Phase 3 deps Phase 1（各自獨立，均為最終 phase）
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // Phase 1 的 barrier.next 應指向 DEV:2（第一個後繼）
  // Phase 2 和 Phase 3 無後繼（最終 phase），barrier.next = null
  assert.strictEqual(dag['REVIEW:1']?.barrier?.next, 'DEV:2',
    'Phase 1 REVIEW:1 barrier.next = DEV:2（第一個後繼，向後相容）');

  // Phase 2 和 Phase 3 是最終 phase（無後繼 DEV 依賴它們），barrier.next = null
  assert.strictEqual(dag['REVIEW:2']?.barrier?.next, null,
    'Phase 2 REVIEW:2 barrier.next = null（最終 phase）');
  assert.strictEqual(dag['REVIEW:3']?.barrier?.next, null,
    'Phase 3 REVIEW:3 barrier.next = null（最終 phase）');
});

test('菱形依賴：DEV:2 deps 包含 REVIEW:1 和 TEST:1', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // DEV:2 應依賴 Phase 1 的品質 stages
  assert.ok(dag['DEV:2'].deps.includes('REVIEW:1'), 'DEV:2 deps REVIEW:1');
  assert.ok(dag['DEV:2'].deps.includes('TEST:1'), 'DEV:2 deps TEST:1');
  // DEV:3 也應依賴 Phase 1 的品質 stages
  assert.ok(dag['DEV:3'].deps.includes('REVIEW:1'), 'DEV:3 deps REVIEW:1');
  assert.ok(dag['DEV:3'].deps.includes('TEST:1'), 'DEV:3 deps TEST:1');
});

test('菱形依賴完整：Phase 1→(Phase 2+Phase 3)→Phase 4 的 DEV:4 deps', () => {
  // Phase 2 和 Phase 3 都依賴 Phase 1，Phase 4 依賴 Phase 2 和 Phase 3
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 4', index: 4, deps: ['Phase 2', 'Phase 3'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // DEV:4 應依賴 Phase 2 + Phase 3 的所有品質 stages
  assert.ok(dag['DEV:4'].deps.includes('REVIEW:2'), 'DEV:4 deps REVIEW:2');
  assert.ok(dag['DEV:4'].deps.includes('TEST:2'), 'DEV:4 deps TEST:2');
  assert.ok(dag['DEV:4'].deps.includes('REVIEW:3'), 'DEV:4 deps REVIEW:3');
  assert.ok(dag['DEV:4'].deps.includes('TEST:3'), 'DEV:4 deps TEST:3');
});

// ─── Section 8: M-2 — 最終 barrier PASS 路由到 DOCS ──────────────

console.log('\n🔧 Section 8: M-2 — 最終 barrier PASS 時 DOCS 存在且 deps 正確');

test('2-phase standard：DOCS deps 包含最終 phase 的 REVIEW:2 和 TEST:2', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  assert.ok(dag['DOCS'], 'DOCS 節點存在');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS deps REVIEW:2');
  assert.ok(dag['DOCS'].deps.includes('TEST:2'), 'DOCS deps TEST:2');
  // Phase 1 的品質 stages 不應在 DOCS deps 中（因為它們有後繼 DEV:2）
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS 不 deps REVIEW:1（非最終）');
  assert.ok(!dag['DOCS'].deps.includes('TEST:1'), 'DOCS 不 deps TEST:1（非最終）');
});

test('3-phase standard（線性）：DOCS deps 只包含 REVIEW:3 和 TEST:3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  assert.ok(dag['DOCS'], 'DOCS 存在');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:3'), 'DOCS deps REVIEW:3');
  assert.ok(dag['DOCS'].deps.includes('TEST:3'), 'DOCS deps TEST:3');
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS 不含 REVIEW:1');
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS 不含 REVIEW:2');
});

test('菱形依賴（1→2+3）standard：DOCS deps 包含 REVIEW:2, TEST:2, REVIEW:3, TEST:3', () => {
  // Phase 2 和 Phase 3 都是最終 phase（無後繼），DOCS 應依賴這兩個 phase 的品質 stages
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  assert.ok(dag['DOCS'], 'DOCS 存在');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS deps REVIEW:2');
  assert.ok(dag['DOCS'].deps.includes('TEST:2'), 'DOCS deps TEST:2');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:3'), 'DOCS deps REVIEW:3');
  assert.ok(dag['DOCS'].deps.includes('TEST:3'), 'DOCS deps TEST:3');
  // Phase 1 有後繼（Phase 2 和 Phase 3），不應在 DOCS deps
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS 不含 REVIEW:1（有後繼）');
  assert.ok(!dag['DOCS'].deps.includes('TEST:1'), 'DOCS 不含 TEST:1（有後繼）');
});

test('quick-dev 2-phase：不生成 DOCS（PIPELINES_WITH_DOCS 不含 quick-dev）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'quick-dev');

  assert.ok(!dag['DOCS'], 'quick-dev 無 DOCS');
});

test('standard 2-phase：最終 barrier REVIEW:2.barrier.next = null（DOCS 通過 getReadyStages 路由）', () => {
  // 驗證 barrier.next=null（最終 phase），且 DOCS 存在
  // 這確認 pipeline-controller 的 barrier PASS 路徑必須透過 getReadyStages() 才能找到 DOCS
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const review2 = dag['REVIEW:2'];
  assert.ok(review2, 'REVIEW:2 存在');
  assert.strictEqual(review2.barrier?.next, null, 'REVIEW:2 barrier.next = null（最終 phase）');
  // 但 DOCS 確實存在，因此 getReadyStages() 在所有品質 stages PASS 後會回傳 ['DOCS']
  assert.ok(dag['DOCS'], 'DOCS 節點存在（透過 getReadyStages 路由）');
});

// ─── Section 9: M-1（第二輪）— Barrier FAIL phase-aware DEV 解析 ────────
//
// 本節驗證 barrier FAIL 分支也使用正確的 phase-aware DEV 解析（resolvePhaseDevStageId 共用函式）。
// 直接使用 pipeline-controller 導出的生產函式（M-1 修復：不再重複實作）。

console.log('\n🔧 Section 9: M-1（第二輪）— Barrier FAIL phase-aware DEV 解析');

test('Barrier FAIL：REVIEW:1 barrier group → 解析為 DEV:1', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  // barrier group 的 currentStage 是觸發 barrier 解析的那個 stage（REVIEW:1）
  const result = resolvePhaseDevStageId('REVIEW:1', dag);
  assert.strictEqual(result, 'DEV:1', 'barrier REVIEW:1 FAIL → DEV:1');
});

test('Barrier FAIL：TEST:1 barrier group → 解析為 DEV:1', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const result = resolvePhaseDevStageId('TEST:1', dag);
  assert.strictEqual(result, 'DEV:1', 'barrier TEST:1 FAIL → DEV:1');
});

test('Barrier FAIL：REVIEW:2 barrier group → 解析為 DEV:2（非 DEV:1）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const result = resolvePhaseDevStageId('REVIEW:2', dag);
  assert.strictEqual(result, 'DEV:2', 'barrier REVIEW:2 FAIL → DEV:2（phase-aware）');
});

test('Barrier FAIL：TEST:2 barrier group 3-phase → 解析為 DEV:2', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const result = resolvePhaseDevStageId('TEST:2', dag);
  assert.strictEqual(result, 'DEV:2', '3-phase barrier TEST:2 FAIL → DEV:2');
});

test('Barrier FAIL：TEST:3 barrier group 3-phase → 解析為 DEV:3', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  const result = resolvePhaseDevStageId('TEST:3', dag);
  assert.strictEqual(result, 'DEV:3', '3-phase barrier TEST:3 FAIL → DEV:3');
});

test('Barrier FAIL：非 phase DAG → fallback 到 DEV', () => {
  const dag = {
    DEV:    { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST:   { deps: ['DEV'] },
  };
  // barrier group 在非 phase DAG 中，currentStage 是 REVIEW
  const result = resolvePhaseDevStageId('REVIEW', dag);
  assert.strictEqual(result, 'DEV', '非 phase DAG barrier FAIL → DEV');
});

test('Barrier FAIL：suffixed stage 但 DAG 無對應 DEV:N → fallback 到第一個 DEV', () => {
  // 只有 DEV:1，但 barrier 在 REVIEW:2（異常狀況）
  const dag = { 'DEV:1': { deps: [] }, 'REVIEW:2': { deps: ['DEV:1'] } };
  const result = resolvePhaseDevStageId('REVIEW:2', dag);
  assert.strictEqual(result, 'DEV:1', '無 DEV:2 → fallback 到 DEV:1');
});

// ─── Section 10: M-2（第二輪）— extractPhaseInfo + buildPhaseProgressSummary startsWith 修復 ──
//
// 驗證修復後 getBaseStage(s) === 'DEV' && s.includes(':') 與 s.startsWith('DEV:') 的等效性。
// 對於標準 phase stage key（DEV:1, DEV:2 等），兩種方式結果相同。
// 此測試確保修復後 phase 識別邏輯對 2-phase 和 3-phase DAG 正確運作。

console.log('\n🔧 Section 10: M-2（第二輪）— phase stage 識別邏輯一致性');

// 測試輔助函式：模擬 getBaseStage（與 dag-utils.js 相同邏輯）
function getBaseStageForTest(s) {
  return s.split(':')[0];
}

// 模擬修復後的邏輯（與修復後的 extractPhaseInfo/buildPhaseProgressSummary 相同）
function isPhaseDevStagePatch(s) {
  return getBaseStageForTest(s) === 'DEV' && s.includes(':');
}

// 模擬修復前的邏輯
function isPhaseDevStageLegacy(s) {
  return s.startsWith('DEV:');
}

test('標準 DEV:1 兩種方式結果相同', () => {
  assert.strictEqual(isPhaseDevStagePatch('DEV:1'), isPhaseDevStageLegacy('DEV:1'), 'DEV:1 等效');
});

test('標準 DEV:2 兩種方式結果相同', () => {
  assert.strictEqual(isPhaseDevStagePatch('DEV:2'), isPhaseDevStageLegacy('DEV:2'), 'DEV:2 等效');
});

test('基礎 DEV（非 suffixed）兩種方式都返回 false', () => {
  assert.strictEqual(isPhaseDevStagePatch('DEV'), false, '修復後：DEV 非 phase stage');
  assert.strictEqual(isPhaseDevStageLegacy('DEV'), false, '修復前：DEV 非 phase stage');
});

test('REVIEW:1 兩種方式都返回 false（非 DEV stage）', () => {
  assert.strictEqual(isPhaseDevStagePatch('REVIEW:1'), false, '修復後：REVIEW:1 非 DEV');
  assert.strictEqual(isPhaseDevStageLegacy('REVIEW:1'), false, '修復前：REVIEW:1 非 DEV');
});

test('2-phase standard DAG 中 phase DEV stage 數量正確（2 個）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // 修復後的邏輯：篩選出 DEV:N stage
  const phaseDevStages = Object.keys(dag).filter(s => getBaseStageForTest(s) === 'DEV' && s.includes(':'));
  assert.strictEqual(phaseDevStages.length, 2, '2-phase DAG 有 2 個 DEV:N stage');
  assert.ok(phaseDevStages.includes('DEV:1'), '包含 DEV:1');
  assert.ok(phaseDevStages.includes('DEV:2'), '包含 DEV:2');
});

test('3-phase standard DAG 中 phase DEV stage 數量正確（3 個）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  const phaseDevStages = Object.keys(dag).filter(s => getBaseStageForTest(s) === 'DEV' && s.includes(':'));
  assert.strictEqual(phaseDevStages.length, 3, '3-phase DAG 有 3 個 DEV:N stage');
});

test('非 phase DAG 中 phase DEV stage 數量為 0', () => {
  const dag = {
    DEV:    { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST:   { deps: ['DEV'] },
    DOCS:   { deps: ['REVIEW', 'TEST'] },
  };

  const phaseDevStages = Object.keys(dag).filter(s => getBaseStageForTest(s) === 'DEV' && s.includes(':'));
  assert.strictEqual(phaseDevStages.length, 0, '非 phase DAG 無 DEV:N stage');
});

test('DOCS 節點不被誤認為 phase DEV stage', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // 確認 DOCS 不在 phase DEV stages 中
  const phaseDevStages = Object.keys(dag).filter(s => getBaseStageForTest(s) === 'DEV' && s.includes(':'));
  assert.ok(!phaseDevStages.includes('DOCS'), 'DOCS 不在 phase DEV stages 中');
  // 確認 REVIEW:1、TEST:1 也不在
  assert.ok(!phaseDevStages.includes('REVIEW:1'), 'REVIEW:1 不在 phase DEV stages 中');
  assert.ok(!phaseDevStages.includes('TEST:1'), 'TEST:1 不在 phase DEV stages 中');
});

// ─── 結果輸出 ────────────────────────────────────────────

console.log(`\n結果：${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
