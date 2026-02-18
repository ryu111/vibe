/**
 * retry-policy.test.js — 回退策略單元測試
 *
 * 涵蓋：
 * - v4 shouldStop（主 API）
 * - analyzeTrend
 * - detectStagnation
 */
'use strict';
const assert = require('assert');
const { shouldStop, analyzeTrend, detectStagnation, MAX_RETRIES, QUALITY_STAGES } = require('../scripts/lib/flow/retry-policy.js');

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

// ──── shouldStop 基本判斷 ────

test('PASS → stop=true, action=NEXT', () => {
  const r = shouldStop('REVIEW', { verdict: 'PASS' }, 0, [], MAX_RETRIES);
  assert.strictEqual(r.stop, true);
  assert.strictEqual(r.action, 'NEXT');
  assert.ok(r.reason === 'PASS');
});

test('FAIL + retryCount < maxRetries → stop=false, RETRY', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0, [], MAX_RETRIES);
  assert.strictEqual(r.stop, false);
  assert.strictEqual(r.action, 'RETRY');
});

test('FAIL + retryCount >= maxRetries → stop=true, FORCE_NEXT', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, MAX_RETRIES, [], MAX_RETRIES);
  assert.strictEqual(r.stop, true);
  assert.strictEqual(r.action, 'FORCE_NEXT');
  assert.ok(r.reason.includes('上限'));
});

test('retryCount > maxRetries → stop=true, FORCE_NEXT', () => {
  const r = shouldStop('TEST', { verdict: 'FAIL', severity: 'CRITICAL' }, MAX_RETRIES + 1, [], MAX_RETRIES);
  assert.strictEqual(r.stop, true);
  assert.strictEqual(r.action, 'FORCE_NEXT');
});

test('verdict=null → stop=false（繼續嘗試）', () => {
  const r = shouldStop('REVIEW', null, 0, [], MAX_RETRIES);
  assert.strictEqual(r.stop, false);
});

// ──── 收斂停滯（stagnation）觀察，不停止 ────

test('收斂停滯（連續 2 輪同 severity）→ stop=false，只記錄 stagnation', () => {
  // 設計：收斂停滯不觸發強制停止，只有 retryCount >= maxRetries 才停止。
  const history = [
    { verdict: 'FAIL', severity: 'HIGH', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 },
  ];
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 1, history, MAX_RETRIES);
  assert.strictEqual(r.stop, false);
  assert.strictEqual(r.action, 'RETRY');
  assert.strictEqual(r.stagnation, 'HIGH');
});

test('不同 severity 不觸發收斂停滯', () => {
  const history = [
    { verdict: 'FAIL', severity: 'CRITICAL', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 },
  ];
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 1, history, MAX_RETRIES);
  assert.strictEqual(r.stop, false);
  assert.ok(!r.stagnation);
});

test('只有 1 輪歷史 → 不觸發收斂停滯', () => {
  const history = [
    { verdict: 'FAIL', severity: 'HIGH', round: 1 },
  ];
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0, history, MAX_RETRIES);
  assert.strictEqual(r.stop, false);
  assert.ok(!r.stagnation);
});

// ──── trend 分析 ────

test('回傳 trend（改善）', () => {
  const history = [
    { verdict: 'FAIL', severity: 'CRITICAL', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 },
  ];
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 1, history, MAX_RETRIES);
  assert.strictEqual(r.trend, 'improving');
});

test('回傳 trend（惡化）', () => {
  const history = [
    { verdict: 'FAIL', severity: 'LOW', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 },
  ];
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 1, history, MAX_RETRIES);
  assert.strictEqual(r.trend, 'worsening');
});

test('自訂 maxRetries', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 5, [], 5);
  assert.strictEqual(r.stop, true);
  assert.strictEqual(r.action, 'FORCE_NEXT');
});

// ──── MAX_RETRIES 確認 ────

test('MAX_RETRIES 確認值', () => {
  assert.strictEqual(MAX_RETRIES, 3, 'MAX_RETRIES 預設 3');
});

test('retryCount = 0 → stop=false', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0, [], MAX_RETRIES);
  assert.strictEqual(r.stop, false);
});

test('retryCount = MAX_RETRIES-1 → stop=false', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, MAX_RETRIES - 1, [], MAX_RETRIES);
  assert.strictEqual(r.stop, false);
});

test('retryCount = MAX_RETRIES → stop=true', () => {
  const r = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, MAX_RETRIES, [], MAX_RETRIES);
  assert.strictEqual(r.stop, true);
});

// ──── analyzeTrend 測試 ────

test('analyzeTrend: 空歷史 → null', () => {
  assert.strictEqual(analyzeTrend([]), null);
});

test('analyzeTrend: 一筆歷史 → null', () => {
  assert.strictEqual(analyzeTrend([{ severity: 'HIGH' }]), null);
});

test('analyzeTrend: CRITICAL→HIGH → improving', () => {
  assert.strictEqual(analyzeTrend([{ severity: 'CRITICAL' }, { severity: 'HIGH' }]), 'improving');
});

test('analyzeTrend: LOW→HIGH → worsening', () => {
  assert.strictEqual(analyzeTrend([{ severity: 'LOW' }, { severity: 'HIGH' }]), 'worsening');
});

test('analyzeTrend: HIGH→HIGH → stable', () => {
  assert.strictEqual(analyzeTrend([{ severity: 'HIGH' }, { severity: 'HIGH' }]), 'stable');
});

// ──── detectStagnation 測試 ────

test('detectStagnation: 空歷史 → null', () => {
  assert.strictEqual(detectStagnation([]), null);
});

test('detectStagnation: 一筆歷史 → null', () => {
  assert.strictEqual(detectStagnation([{ severity: 'HIGH' }]), null);
});

test('detectStagnation: 同 severity × 2 → 回傳 severity', () => {
  assert.strictEqual(detectStagnation([{ severity: 'HIGH' }, { severity: 'HIGH' }]), 'HIGH');
});

test('detectStagnation: 不同 severity → null', () => {
  assert.strictEqual(detectStagnation([{ severity: 'CRITICAL' }, { severity: 'HIGH' }]), null);
});

test('detectStagnation: 最後 2 筆同，前面不同 → 回傳最後 severity', () => {
  assert.strictEqual(detectStagnation([
    { severity: 'CRITICAL' },
    { severity: 'HIGH' },
    { severity: 'HIGH' },
  ]), 'HIGH');
});

// ──── QUALITY_STAGES 確認 ────

test('QUALITY_STAGES 包含 REVIEW/TEST/QA/E2E', () => {
  assert.ok(QUALITY_STAGES.includes('REVIEW'));
  assert.ok(QUALITY_STAGES.includes('TEST'));
  assert.ok(QUALITY_STAGES.includes('QA'));
  assert.ok(QUALITY_STAGES.includes('E2E'));
});

// ──── 結果 ────

console.log(`\n=== retry-policy.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
