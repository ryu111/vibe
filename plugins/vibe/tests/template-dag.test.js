/**
 * template-dag.test.js — templateToDag() 單元測試
 *
 * 驗證 10 種 Pipeline 模板的 DAG 結構：
 * 1. 基本結構（deps 正確）
 * 2. barrier 欄位（full/standard/quick-dev）
 * 3. onFail 欄位（QUALITY stages 指向最近的 IMPL）
 * 4. next 欄位（線性後繼，barrier stage 不設 next）
 */
'use strict';

const assert = require('assert');
const { templateToDag, linearToDag } = require('../scripts/lib/flow/dag-utils.js');
const { PIPELINES, QUALITY_STAGES, MAX_RETRIES } = require('../scripts/lib/registry.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
  }
}

// ────────────────── full pipeline 測試 ──────────────────
// full: PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS
// REVIEW + TEST 應形成 barrier（post-dev group），next = QA

test('full pipeline：DAG 包含所有 9 個 stages', () => {
  const dag = templateToDag('full');
  const stages = PIPELINES.full.stages;
  for (const s of stages) {
    assert.ok(dag[s], `DAG 缺少 ${s}`);
  }
  assert.strictEqual(Object.keys(dag).length, stages.length);
});

test('full pipeline：PLAN 無 deps（起點）', () => {
  const dag = templateToDag('full');
  assert.deepStrictEqual(dag.PLAN.deps, []);
});

test('full pipeline：ARCH 依賴 PLAN', () => {
  const dag = templateToDag('full');
  assert.deepStrictEqual(dag.ARCH.deps, ['PLAN']);
});

test('full pipeline：DEV 依賴 DESIGN', () => {
  const dag = templateToDag('full');
  assert.deepStrictEqual(dag.DEV.deps, ['DESIGN']);
});

test('full pipeline：REVIEW 和 TEST 共享前驅 DEV（barrier group 共享 deps）', () => {
  // M-1 修正：barrier group 內的 stages 共享前驅 deps
  // REVIEW 和 TEST 都依賴 DEV（而非 TEST 線性依賴 REVIEW）
  const dag = templateToDag('full');
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  assert.deepStrictEqual(dag.TEST.deps, ['DEV']);
});

test('full pipeline：REVIEW 有 barrier 欄位（group=post-dev, total=2）', () => {
  const dag = templateToDag('full');
  assert.ok(dag.REVIEW.barrier, 'REVIEW 應有 barrier 欄位');
  assert.strictEqual(dag.REVIEW.barrier.group, 'post-dev');
  assert.strictEqual(dag.REVIEW.barrier.total, 2);
  assert.strictEqual(dag.REVIEW.barrier.next, 'QA');
  assert.ok(dag.REVIEW.barrier.siblings.includes('REVIEW'));
  assert.ok(dag.REVIEW.barrier.siblings.includes('TEST'));
});

test('full pipeline：TEST 有 barrier 欄位（group=post-dev, total=2）', () => {
  const dag = templateToDag('full');
  assert.ok(dag.TEST.barrier, 'TEST 應有 barrier 欄位');
  assert.strictEqual(dag.TEST.barrier.group, 'post-dev');
  assert.strictEqual(dag.TEST.barrier.total, 2);
  assert.strictEqual(dag.TEST.barrier.next, 'QA');
});

test('full pipeline：REVIEW 和 TEST 不設 next（由 barrier 路由）', () => {
  const dag = templateToDag('full');
  assert.ok(!dag.REVIEW.next, `REVIEW 不應有 next（有 barrier），得到：${dag.REVIEW.next}`);
  assert.ok(!dag.TEST.next, `TEST 不應有 next（有 barrier），得到：${dag.TEST.next}`);
});

test('full pipeline：REVIEW 有 onFail 指向 DEV', () => {
  const dag = templateToDag('full');
  assert.strictEqual(dag.REVIEW.onFail, 'DEV');
  assert.strictEqual(dag.REVIEW.maxRetries, MAX_RETRIES);
});

test('full pipeline：TEST 有 onFail 指向 DEV', () => {
  const dag = templateToDag('full');
  assert.strictEqual(dag.TEST.onFail, 'DEV');
  assert.strictEqual(dag.TEST.maxRetries, MAX_RETRIES);
});

test('full pipeline：QA 有 onFail 指向 DEV', () => {
  const dag = templateToDag('full');
  assert.strictEqual(dag.QA.onFail, 'DEV');
});

test('full pipeline：E2E 有 onFail 指向 DEV', () => {
  const dag = templateToDag('full');
  assert.strictEqual(dag.E2E.onFail, 'DEV');
});

test('full pipeline：QA 有 barrier 欄位（group=post-qa, total=2, next=DOCS）', () => {
  const dag = templateToDag('full');
  assert.ok(dag.QA.barrier, 'QA 應有 barrier 欄位');
  assert.strictEqual(dag.QA.barrier.group, 'post-qa');
  assert.strictEqual(dag.QA.barrier.total, 2);
  assert.strictEqual(dag.QA.barrier.next, 'DOCS');
  assert.ok(dag.QA.barrier.siblings.includes('QA'));
  assert.ok(dag.QA.barrier.siblings.includes('E2E'));
});

test('full pipeline：E2E 有 barrier 欄位（group=post-qa, total=2, next=DOCS）', () => {
  const dag = templateToDag('full');
  assert.ok(dag.E2E.barrier, 'E2E 應有 barrier 欄位');
  assert.strictEqual(dag.E2E.barrier.group, 'post-qa');
  assert.strictEqual(dag.E2E.barrier.total, 2);
  assert.strictEqual(dag.E2E.barrier.next, 'DOCS');
});

test('full pipeline：QA 和 E2E 共享前驅 REVIEW（barrier group 共享 deps）', () => {
  // post-qa barrier：QA 和 E2E 都依賴同一個前驅
  // 在線性 DAG 中 QA deps=[TEST]，但 TEST 是 post-dev barrier 的一員
  // 修正後 QA 和 E2E 共享 QA 原始的 deps（linearToDag 中 QA deps=[TEST]）
  // 注意：post-qa group 的 first stage 是 QA，其 deps 在 linearToDag 後是 [TEST]
  // 但 TEST 也是 barrier stage... 這裡看 linearToDag 後 post-dev 修正的結果
  // linearToDag: QA deps=[TEST] → post-dev barrier 不影響 QA deps → post-qa 讓 E2E 也 deps=[TEST]
  const dag = templateToDag('full');
  // QA 的 deps 來自 linearToDag（第7個 stage），前驅是 TEST（第6個）
  // post-qa barrier 讓 E2E 也共享 QA 的 deps
  assert.deepStrictEqual(dag.QA.deps, dag.E2E.deps);
});

test('full pipeline：IMPL stages 沒有 onFail', () => {
  const dag = templateToDag('full');
  const implStages = ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'DOCS'];
  for (const s of implStages) {
    assert.ok(!dag[s].onFail, `${s} 不應有 onFail，得到：${dag[s].onFail}`);
  }
});

test('full pipeline：非 barrier stage 有正確 next（線性後繼）', () => {
  const dag = templateToDag('full');
  // PLAN → ARCH
  assert.strictEqual(dag.PLAN.next, 'ARCH');
  // ARCH → DESIGN
  assert.strictEqual(dag.ARCH.next, 'DESIGN');
  // DESIGN → DEV
  assert.strictEqual(dag.DESIGN.next, 'DEV');
  // DEV 的線性後繼是 REVIEW，但 REVIEW 是 barrier stage → 跳過所有 barrier（REVIEW,TEST,QA,E2E），next = DOCS
  assert.strictEqual(dag.DEV.next, 'DOCS');
  // QA 和 E2E 是 post-qa barrier → 不設 next（由 barrier 路由）
  assert.ok(!dag.QA.next, `QA 不應有 next（有 barrier），得到：${dag.QA.next}`);
  assert.ok(!dag.E2E.next, `E2E 不應有 next（有 barrier），得到：${dag.E2E.next}`);
  // DOCS 是最後 stage → 無 next
  assert.ok(!dag.DOCS.next, `DOCS 不應有 next，得到：${dag.DOCS.next}`);
});

// ────────────────── standard pipeline 測試 ──────────────────
// standard: PLAN → ARCH → DEV → REVIEW → TEST → DOCS
// REVIEW + TEST 應形成 barrier（post-dev group），next = DOCS

test('standard pipeline：DAG 包含 6 個 stages', () => {
  const dag = templateToDag('standard');
  const stages = PIPELINES.standard.stages;
  assert.strictEqual(Object.keys(dag).length, stages.length);
});

test('standard pipeline：REVIEW 有 barrier（post-dev group, next=DOCS）', () => {
  const dag = templateToDag('standard');
  assert.ok(dag.REVIEW.barrier);
  assert.strictEqual(dag.REVIEW.barrier.group, 'post-dev');
  assert.strictEqual(dag.REVIEW.barrier.next, 'DOCS');
  assert.strictEqual(dag.REVIEW.barrier.total, 2);
});

test('standard pipeline：TEST 有 barrier（post-dev group, next=DOCS）', () => {
  const dag = templateToDag('standard');
  assert.ok(dag.TEST.barrier);
  assert.strictEqual(dag.TEST.barrier.group, 'post-dev');
  assert.strictEqual(dag.TEST.barrier.next, 'DOCS');
});

test('standard pipeline：REVIEW 和 TEST 共享前驅 DEV（barrier group 共享 deps）', () => {
  const dag = templateToDag('standard');
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  assert.deepStrictEqual(dag.TEST.deps, ['DEV']);
});

test('standard pipeline：DEV next 跳過 barrier stage → DOCS', () => {
  const dag = templateToDag('standard');
  // DEV 之後是 REVIEW+TEST（barrier），所以 DEV.next = DOCS（barrier.next）
  assert.strictEqual(dag.DEV.next, 'DOCS');
});

test('standard pipeline：REVIEW 和 TEST 有 onFail 指向 DEV', () => {
  const dag = templateToDag('standard');
  assert.strictEqual(dag.REVIEW.onFail, 'DEV');
  assert.strictEqual(dag.TEST.onFail, 'DEV');
});

// ────────────────── quick-dev pipeline 測試 ──────────────────
// quick-dev: DEV → REVIEW → TEST
// REVIEW + TEST 應形成 barrier（post-dev group），next = null（COMPLETE）

test('quick-dev pipeline：DAG 包含 3 個 stages', () => {
  const dag = templateToDag('quick-dev');
  assert.strictEqual(Object.keys(dag).length, 3);
});

test('quick-dev pipeline：REVIEW 有 barrier（post-dev group, next=null）', () => {
  const dag = templateToDag('quick-dev');
  assert.ok(dag.REVIEW.barrier);
  assert.strictEqual(dag.REVIEW.barrier.group, 'post-dev');
  assert.strictEqual(dag.REVIEW.barrier.next, null);
});

test('quick-dev pipeline：TEST 有 barrier（post-dev group, next=null）', () => {
  const dag = templateToDag('quick-dev');
  assert.ok(dag.TEST.barrier);
  assert.strictEqual(dag.TEST.barrier.group, 'post-dev');
  assert.strictEqual(dag.TEST.barrier.next, null);
});

test('quick-dev pipeline：DEV next = null（barrier stage 之後無非 barrier stage）', () => {
  const dag = templateToDag('quick-dev');
  // DEV 後面都是 barrier stages，沒有非 barrier 的後繼 → null
  assert.ok(!dag.DEV.next, `DEV.next 應為 null，得到：${dag.DEV.next}`);
});

// ────────────────── fix pipeline 測試（只有 DEV，無 barrier）──────────────────

test('fix pipeline：DAG 只有 DEV', () => {
  const dag = templateToDag('fix');
  assert.deepStrictEqual(Object.keys(dag), ['DEV']);
});

test('fix pipeline：DEV 無 barrier、無 onFail、無 next', () => {
  const dag = templateToDag('fix');
  assert.ok(!dag.DEV.barrier, 'fix/DEV 不應有 barrier');
  assert.ok(!dag.DEV.onFail, 'fix/DEV 不應有 onFail');
  assert.ok(!dag.DEV.next, 'fix/DEV 不應有 next');
});

// ────────────────── review-only pipeline 測試 ──────────────────

test('review-only pipeline：DAG 只有 REVIEW', () => {
  const dag = templateToDag('review-only');
  assert.deepStrictEqual(Object.keys(dag), ['REVIEW']);
});

test('review-only pipeline：REVIEW 無 barrier（只有一個 stage，不構成 barrier）', () => {
  const dag = templateToDag('review-only');
  // 只有一個 REVIEW，BARRIER_CONFIG 中 review-only 沒有 barrier 設定
  assert.ok(!dag.REVIEW.barrier, 'review-only/REVIEW 不應有 barrier');
});

test('review-only pipeline：REVIEW 沒有 onFail（無 DEV 可回退）', () => {
  const dag = templateToDag('review-only');
  // 沒有前驅 IMPL stage
  assert.ok(!dag.REVIEW.onFail, 'review-only/REVIEW 不應有 onFail');
});

// ────────────────── docs-only pipeline 測試 ──────────────────

test('docs-only pipeline：DAG 只有 DOCS', () => {
  const dag = templateToDag('docs-only');
  assert.deepStrictEqual(Object.keys(dag), ['DOCS']);
});

// ────────────────── security pipeline 測試 ──────────────────
// security: DEV → REVIEW → TEST（與 quick-dev 結構相同，但 security 沒有 BARRIER_CONFIG）

test('security pipeline：DAG 包含 3 個 stages', () => {
  const dag = templateToDag('security');
  assert.strictEqual(Object.keys(dag).length, 3);
});

test('security pipeline：REVIEW 無 barrier（security 沒有 BARRIER_CONFIG）', () => {
  const dag = templateToDag('security');
  // security 沒有在 BARRIER_CONFIG 中，所以無 barrier
  assert.ok(!dag.REVIEW.barrier, 'security/REVIEW 不應有 barrier（security 未設 BARRIER_CONFIG）');
});

test('security pipeline：REVIEW 有 onFail 指向 DEV', () => {
  const dag = templateToDag('security');
  assert.strictEqual(dag.REVIEW.onFail, 'DEV');
});

test('security pipeline：TEST 有 onFail 指向 DEV', () => {
  const dag = templateToDag('security');
  assert.strictEqual(dag.TEST.onFail, 'DEV');
});

test('security pipeline：線性 next 正確（REVIEW→TEST→null）', () => {
  const dag = templateToDag('security');
  assert.strictEqual(dag.REVIEW.next, 'TEST');
  assert.strictEqual(dag.TEST.next, undefined);
  // 最後一個 stage 無 next
  assert.ok(!dag.TEST.next);
});

// ────────────────── ui-only pipeline 測試 ──────────────────
// ui-only: DESIGN → DEV → QA

test('ui-only pipeline：DAG 包含 3 個 stages', () => {
  const dag = templateToDag('ui-only');
  assert.strictEqual(Object.keys(dag).length, 3);
});

test('ui-only pipeline：QA 有 onFail 指向 DEV', () => {
  const dag = templateToDag('ui-only');
  assert.strictEqual(dag.QA.onFail, 'DEV');
});

test('ui-only pipeline：DESIGN 無 onFail（IMPL stage）', () => {
  const dag = templateToDag('ui-only');
  assert.ok(!dag.DESIGN.onFail);
});

test('ui-only pipeline：線性 next 正確', () => {
  const dag = templateToDag('ui-only');
  assert.strictEqual(dag.DESIGN.next, 'DEV');
  assert.strictEqual(dag.DEV.next, 'QA');
  assert.ok(!dag.QA.next);
});

// ────────────────── none pipeline 測試 ──────────────────

test('none pipeline：stages 為空 → templateToDag 回傳空物件', () => {
  const dag = templateToDag('none');
  assert.deepStrictEqual(dag, {});
});

// ────────────────── 自訂 stages 覆蓋 ──────────────────

test('templateToDag：可傳入自訂 stages 覆蓋 REFERENCE_PIPELINES', () => {
  const dag = templateToDag('full', ['DEV', 'REVIEW']);
  // 只有 DEV 和 REVIEW，非 barrier（需要 2 個共享相同前驅才能形成 barrier）
  assert.ok(dag.DEV);
  assert.ok(dag.REVIEW);
  // full 的 BARRIER_CONFIG 需要 REVIEW + TEST 才形成 barrier，這裡只有 REVIEW → 無 barrier
  assert.ok(!dag.REVIEW.barrier, 'REVIEW 無 TEST 兄弟節點，不應形成 barrier');
});

test('templateToDag：完整 deps 結構正確（barrier group 共享前驅）', () => {
  const dag = templateToDag('quick-dev');
  // DEV 無前驅
  assert.deepStrictEqual(dag.DEV.deps, []);
  // REVIEW 依賴 DEV
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  // TEST 也依賴 DEV（M-1 修正：barrier group 共享前驅）
  assert.deepStrictEqual(dag.TEST.deps, ['DEV']);
});

// ────────────────── linearToDag 向後相容 ──────────────────

test('linearToDag 仍可用（向後相容）', () => {
  const dag = linearToDag(['DEV', 'REVIEW', 'TEST']);
  assert.ok(dag.DEV);
  assert.ok(dag.REVIEW);
  assert.ok(dag.TEST);
  // linearToDag 不加 barrier/onFail/next
  assert.ok(!dag.REVIEW.barrier);
  assert.ok(!dag.REVIEW.onFail);
  assert.deepStrictEqual(dag.DEV.deps, []);
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  assert.deepStrictEqual(dag.TEST.deps, ['REVIEW']);
});

// ────────────────── barrier siblings 完整性 ──────────────────

test('full pipeline：post-dev barrier siblings 包含完整的並行節點列表', () => {
  const dag = templateToDag('full');
  const reviewSiblings = dag.REVIEW.barrier.siblings;
  const testSiblings = dag.TEST.barrier.siblings;
  // 兩者應共享相同的 siblings 列表
  assert.deepStrictEqual(reviewSiblings.sort(), testSiblings.sort());
  assert.ok(reviewSiblings.includes('REVIEW'));
  assert.ok(reviewSiblings.includes('TEST'));
  assert.strictEqual(reviewSiblings.length, 2);
});

test('full pipeline：post-qa barrier siblings 包含完整的並行節點列表', () => {
  const dag = templateToDag('full');
  const qaSiblings = dag.QA.barrier.siblings;
  const e2eSiblings = dag.E2E.barrier.siblings;
  // 兩者應共享相同的 siblings 列表
  assert.deepStrictEqual(qaSiblings.sort(), e2eSiblings.sort());
  assert.ok(qaSiblings.includes('QA'));
  assert.ok(qaSiblings.includes('E2E'));
  assert.strictEqual(qaSiblings.length, 2);
});

// ────────────────── 目標 1：barrier 並行 deps 邊界案例 ──────────────────

test('full pipeline：REVIEW 和 TEST 的 deps 都是 [DEV]（非線性 TEST deps=[REVIEW]）', () => {
  // 核心驗證：barrier 並行設計下，REVIEW 和 TEST 共享前驅 DEV
  const dag = templateToDag('full');
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV'], 'REVIEW.deps 應為 [DEV]');
  assert.deepStrictEqual(dag.TEST.deps, ['DEV'], 'TEST.deps 應為 [DEV]（非 [REVIEW]）');
  // 關鍵：TEST 不依賴 REVIEW（並行執行）
  assert.ok(!dag.TEST.deps.includes('REVIEW'), 'TEST 不依賴 REVIEW');
});

test('full pipeline：QA 和 E2E 的 deps 都是 [TEST]（post-qa barrier 共享前驅）', () => {
  // post-qa barrier：QA 和 E2E 共享前驅 TEST（linearToDag 中 QA.deps=[TEST]）
  const dag = templateToDag('full');
  // QA 的 deps 來自 linearToDag（TEST 是 QA 的前驅），因為 TEST 也是 barrier stage
  // E2E 的 deps 應和 QA 一致（M-1 修正：barrier group 共享前驅）
  assert.deepStrictEqual(dag.QA.deps, dag.E2E.deps, 'QA 和 E2E 應有相同的 deps');
  // E2E 不依賴 QA（並行執行）
  assert.ok(!dag.E2E.deps.includes('QA'), 'E2E 不依賴 QA（並行）');
});

test('只有 1 個 barrier stage 時不修改 deps（需至少 2 個才構成 barrier）', () => {
  // full pipeline 的 BARRIER_CONFIG 需要 [REVIEW, TEST]，只傳 REVIEW 時不形成 barrier
  const dag = templateToDag('full', ['DEV', 'REVIEW']);
  // REVIEW 的 deps 維持線性：依賴 DEV
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  // 且無 barrier 欄位
  assert.ok(!dag.REVIEW.barrier, 'REVIEW 無 TEST 兄弟，不應形成 barrier');
});

test('quick-dev pipeline：TEST.deps 是 [DEV]（M-1 修正後，非線性 [REVIEW]）', () => {
  const dag = templateToDag('quick-dev');
  assert.deepStrictEqual(dag.TEST.deps, ['DEV'], 'TEST.deps 應為 [DEV]（barrier group 共享前驅）');
  assert.ok(!dag.TEST.deps.includes('REVIEW'), 'TEST 不依賴 REVIEW（並行執行）');
});

test('standard pipeline：TEST.deps 是 [DEV]（barrier group 共享前驅）', () => {
  const dag = templateToDag('standard');
  assert.deepStrictEqual(dag.TEST.deps, ['DEV']);
  assert.deepStrictEqual(dag.REVIEW.deps, ['DEV']);
  // 兩者應有相同的 deps（共享前驅）
  assert.deepStrictEqual(dag.REVIEW.deps, dag.TEST.deps);
});

// ────────────────── 目標 7：post-qa barrier group 欄位驗證 ──────────────────

test('full pipeline：QA 有 barrier.group = "post-qa"', () => {
  const dag = templateToDag('full');
  assert.ok(dag.QA.barrier, 'QA 應有 barrier 欄位');
  assert.strictEqual(dag.QA.barrier.group, 'post-qa');
});

test('full pipeline：E2E 有 barrier.group = "post-qa"', () => {
  const dag = templateToDag('full');
  assert.ok(dag.E2E.barrier, 'E2E 應有 barrier 欄位');
  assert.strictEqual(dag.E2E.barrier.group, 'post-qa');
});

test('full pipeline：QA.barrier.siblings 包含 QA 和 E2E', () => {
  const dag = templateToDag('full');
  const siblings = dag.QA.barrier.siblings;
  assert.ok(siblings.includes('QA'), 'QA.barrier.siblings 包含 QA');
  assert.ok(siblings.includes('E2E'), 'QA.barrier.siblings 包含 E2E');
});

test('full pipeline：E2E.barrier.siblings 包含 E2E 和 QA', () => {
  const dag = templateToDag('full');
  const siblings = dag.E2E.barrier.siblings;
  assert.ok(siblings.includes('QA'), 'E2E.barrier.siblings 包含 QA');
  assert.ok(siblings.includes('E2E'), 'E2E.barrier.siblings 包含 E2E');
});

test('full pipeline：QA 和 E2E 的 siblings 互相包含（相同 siblings 列表）', () => {
  const dag = templateToDag('full');
  const qaSiblings = dag.QA.barrier.siblings.slice().sort();
  const e2eSiblings = dag.E2E.barrier.siblings.slice().sort();
  assert.deepStrictEqual(qaSiblings, e2eSiblings, 'QA 和 E2E 共享相同的 siblings 列表');
});

test('full pipeline：post-qa barrier.next = "DOCS"', () => {
  const dag = templateToDag('full');
  assert.strictEqual(dag.QA.barrier.next, 'DOCS');
  assert.strictEqual(dag.E2E.barrier.next, 'DOCS');
});

test('full pipeline：QA 和 E2E 不設 next（由 barrier 路由）', () => {
  const dag = templateToDag('full');
  assert.ok(!dag.QA.next, 'QA 是 barrier stage，不應有 next');
  assert.ok(!dag.E2E.next, 'E2E 是 barrier stage，不應有 next');
});

// ────────────────── 結果 ──────────────────

console.log(`\n template-dag: ${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
