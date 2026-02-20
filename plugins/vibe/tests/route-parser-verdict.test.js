#!/usr/bin/env node
/**
 * route-parser-verdict.test.js — PIPELINE_ROUTE 解析/驗證/fallback/enforcePolicy
 *
 * 場景：
 *   D03: PIPELINE_VERDICT fallback（v3 格式）
 *   D04: validateRoute 補完（FAIL 缺 severity）
 *   D05: enforcePolicy Rule 1（PASS+DEV→NEXT）
 *   D06: enforcePolicy Rule 3（無 DEV → NEXT）
 *
 * 執行：node plugins/vibe/tests/route-parser-verdict.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const {
  parseRoute,
  validateRoute,
  enforcePolicy,
  convertVerdictToRoute,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/route-parser.js'));

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

// ─── 暫存 transcript 工具 ───────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), `route-parser-verdict-${process.pid}`);
fs.mkdirSync(TMP_DIR, { recursive: true });

function writeTranscript(filename, lines) {
  const p = path.join(TMP_DIR, filename);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

function assistantEntry(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ─── v4 state 工具 ──────────────────────────────────────

function makeState(overrides = {}) {
  return {
    version: 4,
    dag: overrides.dag || {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['REVIEW'] },
    },
    stages: overrides.stages || {},
    retries: overrides.retries || {},
    pipelineActive: true,
    activeStages: [],
    ...overrides,
  };
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n🔄 D03-D06：PIPELINE_ROUTE 解析/驗證/enforcePolicy');

// D03: PIPELINE_VERDICT fallback（v3 格式）
test('D03: v3 PIPELINE_VERDICT PASS → source=verdict-fallback', () => {
  const tp = writeTranscript('d03-pass.jsonl', [
    assistantEntry('審查完成，程式碼品質良好。'),
    assistantEntry('<!-- PIPELINE_VERDICT: PASS -->'),
  ]);
  const { parsed, source } = parseRoute(tp);
  assert.strictEqual(source, 'verdict-fallback', `source 應為 verdict-fallback，實際：${source}`);
  assert.strictEqual(parsed.verdict, 'PASS', `verdict 應為 PASS`);
  assert.strictEqual(parsed.route, 'NEXT', `PASS verdict 應 route=NEXT`);
});

test('D03b: v3 PIPELINE_VERDICT FAIL:HIGH → fallback 含 severity + route=DEV', () => {
  const tp = writeTranscript('d03-fail.jsonl', [
    assistantEntry('發現高嚴重度問題。'),
    assistantEntry('<!-- PIPELINE_VERDICT: FAIL:HIGH -->'),
  ]);
  const { parsed, source } = parseRoute(tp);
  assert.strictEqual(source, 'verdict-fallback', `source 應為 verdict-fallback`);
  assert.strictEqual(parsed.verdict, 'FAIL');
  assert.strictEqual(parsed.severity, 'HIGH');
  assert.strictEqual(parsed.route, 'DEV', `FAIL:HIGH 應 route=DEV`);
});

test('D03c: v3 PIPELINE_VERDICT FAIL:MEDIUM → fallback route=NEXT（不回退）', () => {
  const tp = writeTranscript('d03-medium.jsonl', [
    assistantEntry('<!-- PIPELINE_VERDICT: FAIL:MEDIUM -->'),
  ]);
  const { parsed, source } = parseRoute(tp);
  assert.strictEqual(source, 'verdict-fallback');
  assert.strictEqual(parsed.verdict, 'FAIL');
  assert.strictEqual(parsed.severity, 'MEDIUM');
  assert.strictEqual(parsed.route, 'NEXT', `FAIL:MEDIUM 應 route=NEXT（不回退）`);
});

test('D03d: PIPELINE_ROUTE 優先於 PIPELINE_VERDICT（v4 優先）', () => {
  const tp = writeTranscript('d03-priority.jsonl', [
    assistantEntry('<!-- PIPELINE_VERDICT: FAIL:HIGH -->'),
    assistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'),
  ]);
  const { parsed, source } = parseRoute(tp);
  // PIPELINE_ROUTE 優先
  assert.strictEqual(source, 'route', `v4 PIPELINE_ROUTE 應優先，source 應為 route`);
  assert.strictEqual(parsed.verdict, 'PASS');
});

test('D03e: transcript 不存在 → source=none', () => {
  const { parsed, source } = parseRoute('/nonexistent/path.jsonl');
  assert.strictEqual(source, 'none');
  assert.strictEqual(parsed, null);
});

// D04: validateRoute 補完（FAIL 缺 severity）
test('D04: validateRoute FAIL 缺 severity → 自動補 MEDIUM', () => {
  const parsed = { verdict: 'FAIL', route: 'DEV' };
  const { route, warnings } = validateRoute(parsed);
  assert.strictEqual(route.verdict, 'FAIL');
  assert.strictEqual(route.severity, 'MEDIUM', `缺 severity 應補 MEDIUM，實際：${route.severity}`);
  assert.ok(warnings.some(w => w.includes('severity')), `應有 severity 警告，實際：${warnings}`);
});

test('D04b: validateRoute PASS + severity → 清除 severity', () => {
  const parsed = { verdict: 'PASS', route: 'NEXT', severity: 'HIGH' };
  const { route } = validateRoute(parsed);
  assert.strictEqual(route.verdict, 'PASS');
  assert.strictEqual(route.severity, undefined, `PASS 不應有 severity`);
});

test('D04c: validateRoute 非法 route → 修正為預設值', () => {
  const parsed = { verdict: 'PASS', route: 'INVALID_ROUTE' };
  const { route, warnings } = validateRoute(parsed);
  assert.strictEqual(route.route, 'NEXT', `非法 route 應預設為 NEXT`);
  assert.ok(warnings.length > 0, '應有警告');
});

test('D04d: validateRoute BARRIER 缺 barrierGroup → 補 default', () => {
  const parsed = { verdict: 'PASS', route: 'BARRIER' };
  const { route, warnings } = validateRoute(parsed);
  assert.strictEqual(route.barrierGroup, 'default', `缺 barrierGroup 應補 default`);
  assert.ok(warnings.some(w => w.includes('barrierGroup')));
});

test('D04e: validateRoute null → route=null 含警告', () => {
  const { route, warnings } = validateRoute(null);
  assert.strictEqual(route, null);
  assert.ok(warnings.length > 0);
});

// D05: enforcePolicy Rule 1（PASS+DEV→NEXT，邏輯矛盾）
test('D05: enforcePolicy Rule 1 — PASS+DEV 邏輯矛盾 → 強制 NEXT', () => {
  const route = { verdict: 'PASS', route: 'DEV' };
  const state = makeState();
  const { route: enforced, enforced: wasEnforced, reason } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(enforced.route, 'NEXT', `PASS+DEV 應強制 NEXT，實際：${enforced.route}`);
  assert.strictEqual(wasEnforced, true, '應標記 enforced=true');
  assert.ok(reason && reason.includes('PASS'), `reason 應提及 PASS，實際：${reason}`);
});

// D06: enforcePolicy Rule 3（DAG 無 DEV → NEXT）
test('D06: enforcePolicy Rule 3 — DAG 無 DEV → 強制 NEXT', () => {
  // review-only pipeline：只有 REVIEW，無 DEV
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const state = makeState({
    dag: { REVIEW: { deps: [] } },  // 無 DEV
    retries: {},
  });
  const { route: enforced, enforced: wasEnforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(enforced.route, 'NEXT', `無 DEV 的 DAG，FAIL route=DEV 應強制 NEXT`);
  assert.strictEqual(wasEnforced, true, '應標記 enforced=true');
});

// D06b: enforcePolicy Rule 2（MAX_RETRIES 達上限）
test('D06b: enforcePolicy Rule 2 — retries >= MAX_RETRIES → 強制 NEXT', () => {
  const { MAX_RETRIES } = require(path.join(PLUGIN_ROOT, 'scripts/lib/registry.js'));
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const state = makeState({
    retries: { REVIEW: MAX_RETRIES },  // 已達上限
  });
  const { route: enforced, enforced: wasEnforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(enforced.route, 'NEXT', `達到回退上限應強制 NEXT`);
  assert.strictEqual(enforced._retryExhausted, true, '應標記 _retryExhausted');
});

// convertVerdictToRoute 邊界
test('D07: convertVerdictToRoute FAIL（無 severity）→ route=DEV HIGH', () => {
  const result = convertVerdictToRoute('FAIL');
  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.route, 'DEV', `無 severity 的 FAIL 應 route=DEV`);
  assert.strictEqual(result.severity, 'HIGH', `無 severity 應預設 HIGH`);
});

test('D08: convertVerdictToRoute FAIL:LOW → route=NEXT（不回退）', () => {
  const result = convertVerdictToRoute('FAIL:LOW');
  assert.strictEqual(result.route, 'NEXT', `LOW severity 不應回退，route=NEXT`);
});

// 清理
cleanup();

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
