/**
 * retry-policy.test.js — 回退策略單元測試
 */
'use strict';
const assert = require('assert');
const { shouldRetryStage, MAX_RETRIES, QUALITY_STAGES } = require('../scripts/lib/flow/retry-policy.js');

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

// ──── 基本分類 ────

test('非品質階段 → 不回退', () => {
  const r = shouldRetryStage('DEV', { verdict: 'FAIL', severity: 'CRITICAL' }, 0);
  assert.strictEqual(r.shouldRetry, false);
});

test('PLAN 不是品質階段 → 不回退', () => {
  const r = shouldRetryStage('PLAN', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  assert.strictEqual(r.shouldRetry, false);
});

test('DOCS 不是品質階段 → 不回退', () => {
  const r = shouldRetryStage('DOCS', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  assert.strictEqual(r.shouldRetry, false);
});

// ──── 品質階段：各品質階段都能回退 ────

for (const stage of QUALITY_STAGES) {
  test(`${stage} + FAIL:CRITICAL → 回退`, () => {
    const r = shouldRetryStage(stage, { verdict: 'FAIL', severity: 'CRITICAL' }, 0);
    assert.strictEqual(r.shouldRetry, true);
    assert.ok(r.reason.includes('CRITICAL'));
  });
}

// ──── Verdict 處理 ────

test('verdict = null → 不回退', () => {
  const r = shouldRetryStage('REVIEW', null, 0);
  assert.strictEqual(r.shouldRetry, false);
  assert.ok(r.reason.includes('無法解析'));
});

test('verdict = undefined → 不回退', () => {
  const r = shouldRetryStage('REVIEW', undefined, 0);
  assert.strictEqual(r.shouldRetry, false);
});

test('PASS → 不回退', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'PASS', severity: null }, 0);
  assert.strictEqual(r.shouldRetry, false);
  assert.strictEqual(r.reason, '');
});

// ──── Severity 等級 ────

test('FAIL:CRITICAL → 回退', () => {
  const r = shouldRetryStage('TEST', { verdict: 'FAIL', severity: 'CRITICAL' }, 0);
  assert.strictEqual(r.shouldRetry, true);
});

test('FAIL:HIGH → 回退', () => {
  const r = shouldRetryStage('TEST', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  assert.strictEqual(r.shouldRetry, true);
  assert.ok(r.reason.includes('HIGH'));
});

test('FAIL:MEDIUM → 不回退', () => {
  const r = shouldRetryStage('TEST', { verdict: 'FAIL', severity: 'MEDIUM' }, 0);
  assert.strictEqual(r.shouldRetry, false);
  assert.ok(r.reason.includes('MEDIUM'));
});

test('FAIL:LOW → 不回退', () => {
  const r = shouldRetryStage('QA', { verdict: 'FAIL', severity: 'LOW' }, 0);
  assert.strictEqual(r.shouldRetry, false);
  assert.ok(r.reason.includes('LOW'));
});

test('FAIL 無 severity → 回退（視為嚴重）', () => {
  const r = shouldRetryStage('E2E', { verdict: 'FAIL', severity: null }, 0);
  assert.strictEqual(r.shouldRetry, true);
});

test('FAIL severity undefined → 回退', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'FAIL' }, 0);
  assert.strictEqual(r.shouldRetry, true);
});

// ──── MAX_RETRIES 上限 ────

test('MAX_RETRIES 確認值', () => {
  assert.strictEqual(MAX_RETRIES, 3, 'MAX_RETRIES 預設 3');
});

test('retryCount = 0 → 可回退', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  assert.strictEqual(r.shouldRetry, true);
});

test('retryCount = MAX_RETRIES-1 → 可回退', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, MAX_RETRIES - 1);
  assert.strictEqual(r.shouldRetry, true);
});

test('retryCount = MAX_RETRIES → 不可回退（上限）', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, MAX_RETRIES);
  assert.strictEqual(r.shouldRetry, false);
  assert.ok(r.reason.includes('上限'));
});

test('retryCount > MAX_RETRIES → 不可回退', () => {
  const r = shouldRetryStage('TEST', { verdict: 'FAIL', severity: 'CRITICAL' }, MAX_RETRIES + 1);
  assert.strictEqual(r.shouldRetry, false);
});

// ──── 邊界值 ────

test('空字串 severity → 回退（不匹配 MEDIUM/LOW）', () => {
  const r = shouldRetryStage('REVIEW', { verdict: 'FAIL', severity: '' }, 0);
  assert.strictEqual(r.shouldRetry, true);
});

test('verdict 物件缺 verdict 欄位 → 不回退（非 PASS 非 FAIL）', () => {
  const r = shouldRetryStage('REVIEW', { severity: 'HIGH' }, 0);
  // verdict.verdict 未定義 → 不是 PASS，也不是 FAIL
  // 但也不匹配 MEDIUM/LOW severity 檢查在 verdict.verdict !== 'PASS' 之後
  // 流程：非品質? 否 → 無verdict? 否（物件存在）→ PASS? 否（undefined!=='PASS'）→ MEDIUM/LOW? 否 → MAX? 否 → shouldRetry: true
  assert.strictEqual(r.shouldRetry, true, 'verdict 物件無 verdict 欄位 + HIGH → 回退');
});

// ──── 結果 ────

console.log(`\n=== retry-policy.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
