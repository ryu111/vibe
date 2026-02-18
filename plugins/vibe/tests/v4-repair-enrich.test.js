#!/usr/bin/env node
/**
 * v4-repair-enrich.test.js — repairDag + enrichCustomDag 測試
 *
 * 驗證 pipeline-architect 產出的格式偏差 DAG 能被自動修復，
 * 以及修復後的 DAG 能被正確注入 v4 metadata（barrier/onFail/next）。
 */
'use strict';

const path = require('path');
const libPath = path.join(__dirname, '..', 'scripts', 'lib');
const { repairDag, enrichCustomDag, validateDag, getBaseStage } = require(path.join(libPath, 'flow', 'dag-utils.js'));
const { QUALITY_STAGES, MAX_RETRIES } = require(path.join(libPath, 'registry.js'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

// ═══════════════ repairDag 測試 ═══════════════

console.log('\n=== R01: 不可修復 — DAG 不是物件 ===');
assert(repairDag(null) === null, 'null → null');
assert(repairDag(undefined) === null, 'undefined → null');
assert(repairDag('string') === null, 'string → null');
assert(repairDag(42) === null, 'number → null');

console.log('\n=== R02: 不可修復 — 修復後 DAG 為空 ===');
assert(repairDag({}) === null, '空物件 → null');
assert(repairDag({ UNKNOWN: { deps: [] } }) === null, '只有未知 stage → null');

console.log('\n=== R03: 修復 deps 缺失 ===');
{
  const result = repairDag({ PLAN: {}, ARCH: { deps: ['PLAN'] } });
  assert(result !== null, '修復成功');
  assert(Array.isArray(result.dag.PLAN.deps), 'PLAN.deps 是陣列');
  assert(result.dag.PLAN.deps.length === 0, 'PLAN.deps 為空');
  assert(result.fixes.length > 0, '有修復記錄');
  assert(result.fixes.some(f => f.includes('PLAN')), '修復記錄提及 PLAN');
}

console.log('\n=== R04: 修復 deps 為 string ===');
{
  const result = repairDag({ DEV: { deps: [] }, REVIEW: { deps: 'DEV' } });
  assert(result !== null, '修復成功');
  assert(Array.isArray(result.dag.REVIEW.deps), 'REVIEW.deps 是陣列');
  assert(result.dag.REVIEW.deps[0] === 'DEV', 'REVIEW.deps[0] === DEV');
  assert(result.fixes.some(f => f.includes('string')), '修復記錄提及 string');
}

console.log('\n=== R05: 修復 config 為 null ===');
{
  const result = repairDag({ DEV: null, REVIEW: { deps: ['DEV'] } });
  assert(result !== null, '修復成功');
  assert(result.dag.DEV.deps.length === 0, 'DEV.deps 為空陣列');
  assert(result.fixes.some(f => f.includes('config 為空')), '修復記錄提及 config 為空');
}

console.log('\n=== R06: 移除懸空 dep 引用 ===');
{
  const result = repairDag({ DEV: { deps: [] }, REVIEW: { deps: ['DEV', 'NONEXIST'] } });
  assert(result !== null, '修復成功');
  assert(result.dag.REVIEW.deps.length === 1, 'REVIEW 只有 1 個 dep');
  assert(result.dag.REVIEW.deps[0] === 'DEV', '保留有效的 DEV dep');
  assert(result.fixes.some(f => f.includes('NONEXIST')), '修復記錄提及 NONEXIST');
}

console.log('\n=== R07: 移除未知 stage ===');
{
  const result = repairDag({
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    FOOBAR: { deps: ['DEV'] },
  });
  assert(result !== null, '修復成功');
  assert(result.dag.FOOBAR === undefined, 'FOOBAR 被移除');
  assert(Object.keys(result.dag).length === 2, '剩 DEV + REVIEW');
  assert(result.fixes.some(f => f.includes('FOOBAR')), '修復記錄提及 FOOBAR');
}

console.log('\n=== R08: 修復後仍有環 → 不可修復 ===');
{
  const result = repairDag({ DEV: { deps: ['REVIEW'] }, REVIEW: { deps: ['DEV'] } });
  assert(result === null, '環形 DAG → null');
}

console.log('\n=== R09: 正常 DAG 不需修復 ===');
{
  const result = repairDag({
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
  });
  assert(result !== null, '回傳非 null');
  assert(result.fixes.length === 0, '無修復記錄');
  assert(Object.keys(result.dag).length === 3, '3 個 stage 保留');
}

console.log('\n=== R10: 複雜修復 — 多種問題同時 ===');
{
  const result = repairDag({
    PLAN: undefined,
    ARCH: { deps: 'PLAN' },
    DEV: { deps: ['ARCH'] },
    REVIEW: { deps: ['DEV', 'PHANTOM'] },
    UNKNOWN_STAGE: { deps: [] },
  });
  assert(result !== null, '修復成功');
  assert(result.dag.UNKNOWN_STAGE === undefined, 'UNKNOWN_STAGE 被移除');
  assert(Array.isArray(result.dag.ARCH.deps), 'ARCH.deps 是陣列');
  assert(result.dag.ARCH.deps[0] === 'PLAN', 'ARCH → PLAN');
  assert(result.dag.REVIEW.deps.length === 1, 'REVIEW 移除了 PHANTOM');
  assert(result.fixes.length >= 3, '至少 3 項修復');
}

console.log('\n=== R11: TDD 帶後綴 stage ===');
{
  const result = repairDag({
    'TEST:write': { deps: [] },
    DEV: { deps: ['TEST:write'] },
    'TEST:verify': { deps: ['DEV'] },
  });
  assert(result !== null, '修復成功（帶後綴 stage 合法）');
  assert(result.fixes.length === 0, '無修復需要');
}

// ═══════════════ enrichCustomDag 測試 ═══════════════

console.log('\n=== E01: 基本 DAG enrichment ===');
{
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.REVIEW.barrier !== undefined, 'REVIEW 有 barrier');
  assert(enriched.TEST.barrier !== undefined, 'TEST 有 barrier');
  assert(enriched.REVIEW.barrier.group === enriched.TEST.barrier.group, 'REVIEW+TEST 同 barrier group');
  assert(enriched.REVIEW.barrier.total === 2, 'barrier total = 2');
}

console.log('\n=== E02: barrier 只應用於品質 stages ===');
{
  const dag = {
    PLAN: { deps: [] },
    ARCH: { deps: [] },
    DEV: { deps: ['PLAN', 'ARCH'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.PLAN.barrier === undefined, 'PLAN 無 barrier（非品質 stage）');
  assert(enriched.ARCH.barrier === undefined, 'ARCH 無 barrier（非品質 stage）');
}

console.log('\n=== E03: onFail 指向最近的 IMPL stage ===');
{
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
    DOCS: { deps: ['REVIEW', 'TEST'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.REVIEW.onFail === 'DEV', 'REVIEW.onFail = DEV');
  assert(enriched.TEST.onFail === 'DEV', 'TEST.onFail = DEV');
  assert(enriched.REVIEW.maxRetries === MAX_RETRIES, 'REVIEW.maxRetries 正確');
  assert(enriched.DOCS.onFail === undefined, 'DOCS 無 onFail（非品質 stage）');
}

console.log('\n=== E04: barrier next 偵測 ===');
{
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
    DOCS: { deps: ['REVIEW', 'TEST'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.REVIEW.barrier.next === 'DOCS', 'barrier.next = DOCS');
  assert(enriched.TEST.barrier.next === 'DOCS', 'TEST barrier.next = DOCS');
}

console.log('\n=== E05: 線性 DAG（無 barrier） ===');
{
  const dag = {
    PLAN: { deps: [] },
    ARCH: { deps: ['PLAN'] },
    DEV: { deps: ['ARCH'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.PLAN.barrier === undefined, 'PLAN 無 barrier');
  assert(enriched.PLAN.next === 'ARCH', 'PLAN.next = ARCH');
  assert(enriched.ARCH.next === 'DEV', 'ARCH.next = DEV');
}

console.log('\n=== E06: full pipeline DAG enrichment ===');
{
  const dag = {
    PLAN: { deps: [] },
    ARCH: { deps: ['PLAN'] },
    DEV: { deps: ['ARCH'] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
    QA: { deps: ['REVIEW', 'TEST'] },
    E2E: { deps: ['REVIEW', 'TEST'] },
    DOCS: { deps: ['QA', 'E2E'] },
  };
  const enriched = enrichCustomDag(dag);

  // REVIEW+TEST barrier
  assert(enriched.REVIEW.barrier !== undefined, 'REVIEW 有 barrier');
  assert(enriched.TEST.barrier !== undefined, 'TEST 有 barrier');
  assert(enriched.REVIEW.barrier.group === enriched.TEST.barrier.group, 'REVIEW+TEST 同 group');

  // QA+E2E barrier
  assert(enriched.QA.barrier !== undefined, 'QA 有 barrier');
  assert(enriched.E2E.barrier !== undefined, 'E2E 有 barrier');
  assert(enriched.QA.barrier.group === enriched.E2E.barrier.group, 'QA+E2E 同 group');

  // onFail
  assert(enriched.REVIEW.onFail === 'DEV', 'REVIEW.onFail = DEV');
  assert(enriched.QA.onFail === 'DEV', 'QA.onFail = DEV');

  // next（非 barrier 節點）
  assert(enriched.PLAN.next === 'ARCH', 'PLAN.next = ARCH');
  assert(enriched.ARCH.next === 'DEV', 'ARCH.next = DEV');
}

console.log('\n=== E07: enrichCustomDag null 防護 ===');
{
  assert(enrichCustomDag(null) === null, 'null → null');
  assert(enrichCustomDag(undefined) === undefined, 'undefined → undefined');
}

console.log('\n=== E08: barrier.next 為 null 當沒有後繼 ===');
{
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
  };
  const enriched = enrichCustomDag(dag);
  assert(enriched.REVIEW.barrier.next === null, 'barrier.next = null（無後繼）');
}

// ═══════════════ 整合測試：repair → validate → enrich ═══════════════

console.log('\n=== I01: 完整修復鏈 ===');
{
  // 模擬 pipeline-architect 格式偏差的輸出
  const rawDag = {
    PLAN: undefined,       // config 缺失
    ARCH: { deps: 'PLAN' }, // deps 為 string
    DEV: { deps: ['ARCH'] },
    REVIEW: { deps: ['DEV', 'GHOST'] }, // 懸空引用
    TEST: { deps: ['DEV'] },
    DOCS: { deps: ['REVIEW', 'TEST'] },
    FOOBAR: { deps: [] },   // 未知 stage
  };

  // Step 1: repair
  const repair = repairDag(rawDag);
  assert(repair !== null, 'repair 成功');
  assert(repair.fixes.length >= 4, `${repair.fixes.length} 項修復`);

  // Step 2: validate
  const validation = validateDag(repair.dag);
  assert(validation.valid, '修復後驗證通過');

  // Step 3: enrich
  const enriched = enrichCustomDag(repair.dag);
  assert(enriched.REVIEW.barrier !== undefined, 'REVIEW 有 barrier');
  assert(enriched.REVIEW.onFail === 'DEV', 'REVIEW.onFail = DEV');
  assert(enriched.PLAN.next === 'ARCH', 'PLAN.next = ARCH');
  assert(enriched.FOOBAR === undefined, 'FOOBAR 已移除');
}

// ═══════════════ 結果 ═══════════════

console.log(`\n結果：${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
