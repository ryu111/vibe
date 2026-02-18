/**
 * route-parser.test.js — route-parser.js 單元測試
 *
 * 測試：parseRoute、validateRoute、enforcePolicy
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseRoute,
  validateRoute,
  enforcePolicy,
  convertVerdictToRoute,
} = require('../scripts/lib/flow/route-parser.js');

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

// ────────────── 暫存 transcript 工具 ──────────────

const TMP_DIR = path.join(os.tmpdir(), 'route-parser-tests-' + process.pid);
fs.mkdirSync(TMP_DIR, { recursive: true });

function writeTranscript(filename, lines) {
  const filePath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function makeAssistantEntry(text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ────────────── parseRoute 測試 ──────────────

test('parseRoute: 正常解析 PIPELINE_ROUTE PASS', () => {
  const transcriptPath = writeTranscript('t1.jsonl', [
    makeAssistantEntry('審查完成。'),
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'route');
  assert.strictEqual(parsed.verdict, 'PASS');
  assert.strictEqual(parsed.route, 'NEXT');
});

test('parseRoute: 正常解析 PIPELINE_ROUTE FAIL', () => {
  const transcriptPath = writeTranscript('t2.jsonl', [
    makeAssistantEntry('發現問題。'),
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "FAIL", "route": "DEV", "severity": "HIGH", "hint": "auth 問題" } -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'route');
  assert.strictEqual(parsed.verdict, 'FAIL');
  assert.strictEqual(parsed.route, 'DEV');
  assert.strictEqual(parsed.severity, 'HIGH');
  assert.strictEqual(parsed.hint, 'auth 問題');
});

test('parseRoute: 取最後一個 PIPELINE_ROUTE', () => {
  const transcriptPath = writeTranscript('t3.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "FAIL", "route": "DEV", "severity": "HIGH" } -->'),
    makeAssistantEntry('第二輪審查完成。'),
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'route');
  assert.strictEqual(parsed.verdict, 'PASS'); // 取最後一個
});

test('parseRoute: fallback 到 PIPELINE_VERDICT PASS', () => {
  const transcriptPath = writeTranscript('t4.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_VERDICT: PASS -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'verdict-fallback');
  assert.strictEqual(parsed.verdict, 'PASS');
  assert.strictEqual(parsed.route, 'NEXT');
});

test('parseRoute: fallback 到 PIPELINE_VERDICT FAIL:HIGH', () => {
  const transcriptPath = writeTranscript('t5.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_VERDICT: FAIL:HIGH -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'verdict-fallback');
  assert.strictEqual(parsed.verdict, 'FAIL');
  assert.strictEqual(parsed.route, 'DEV');
  assert.strictEqual(parsed.severity, 'HIGH');
});

test('parseRoute: fallback 到 PIPELINE_VERDICT FAIL:CRITICAL', () => {
  const transcriptPath = writeTranscript('t6.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_VERDICT: FAIL:CRITICAL -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'verdict-fallback');
  assert.strictEqual(parsed.verdict, 'FAIL');
  assert.strictEqual(parsed.severity, 'CRITICAL');
});

test('parseRoute: 都找不到 → source=none', () => {
  const transcriptPath = writeTranscript('t7.jsonl', [
    makeAssistantEntry('沒有任何標記的回應'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'none');
  assert.strictEqual(parsed, null);
});

test('parseRoute: 檔案不存在 → source=none', () => {
  const { parsed, source } = parseRoute('/tmp/nonexistent-file.jsonl');
  assert.strictEqual(source, 'none');
  assert.strictEqual(parsed, null);
});

test('parseRoute: transcriptPath = null → source=none', () => {
  const { parsed, source } = parseRoute(null);
  assert.strictEqual(source, 'none');
  assert.strictEqual(parsed, null);
});

test('parseRoute: JSON 解析失敗的 PIPELINE_ROUTE → 繼續搜尋', () => {
  const transcriptPath = writeTranscript('t8.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_ROUTE: {invalid json} -->'),
    makeAssistantEntry('<!-- PIPELINE_VERDICT: PASS -->'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'verdict-fallback');
  assert.strictEqual(parsed.verdict, 'PASS');
});

test('parseRoute: 多行 transcript 正確掃描最後 30 行', () => {
  // 建立 35 行，PIPELINE_ROUTE 在第 33 行（落在最後 30 行內）
  const lines = [];
  for (let i = 0; i < 32; i++) {
    lines.push(makeAssistantEntry(`line ${i}`));
  }
  lines.push(makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'));
  lines.push(makeAssistantEntry('line 34'));
  lines.push(makeAssistantEntry('line 35'));

  const transcriptPath = writeTranscript('t9.jsonl', lines);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'route');
  assert.strictEqual(parsed.verdict, 'PASS');
});

// ────────────── convertVerdictToRoute 測試 ──────────────

test('convertVerdictToRoute: PASS', () => {
  const r = convertVerdictToRoute('PASS');
  assert.strictEqual(r.verdict, 'PASS');
  assert.strictEqual(r.route, 'NEXT');
});

test('convertVerdictToRoute: FAIL:HIGH', () => {
  const r = convertVerdictToRoute('FAIL:HIGH');
  assert.strictEqual(r.verdict, 'FAIL');
  assert.strictEqual(r.route, 'DEV');
  assert.strictEqual(r.severity, 'HIGH');
});

test('convertVerdictToRoute: FAIL:CRITICAL', () => {
  const r = convertVerdictToRoute('FAIL:CRITICAL');
  assert.strictEqual(r.severity, 'CRITICAL');
});

test('convertVerdictToRoute: FAIL 無 severity → HIGH', () => {
  const r = convertVerdictToRoute('FAIL');
  assert.strictEqual(r.severity, 'HIGH');
});

test('convertVerdictToRoute: FAIL:INVALID → HIGH', () => {
  const r = convertVerdictToRoute('FAIL:INVALID');
  assert.strictEqual(r.severity, 'HIGH');
});

// ────────────── validateRoute 測試 ──────────────

test('validateRoute: 合法 PASS/NEXT', () => {
  const { route, warnings } = validateRoute({ verdict: 'PASS', route: 'NEXT' });
  assert.strictEqual(route.verdict, 'PASS');
  assert.strictEqual(route.route, 'NEXT');
  assert.strictEqual(warnings.length, 0);
});

test('validateRoute: 合法 FAIL/DEV/HIGH', () => {
  const { route, warnings } = validateRoute({ verdict: 'FAIL', route: 'DEV', severity: 'HIGH' });
  assert.strictEqual(route.verdict, 'FAIL');
  assert.strictEqual(route.severity, 'HIGH');
  assert.strictEqual(warnings.length, 0);
});

test('validateRoute: FAIL 缺 severity → 補 MEDIUM', () => {
  const { route, warnings } = validateRoute({ verdict: 'FAIL', route: 'DEV' });
  assert.strictEqual(route.severity, 'MEDIUM');
  assert.ok(warnings.some(w => w.includes('MEDIUM')));
});

test('validateRoute: FAIL severity 不合法 → 補 MEDIUM', () => {
  const { route, warnings } = validateRoute({ verdict: 'FAIL', route: 'DEV', severity: 'EXTREME' });
  assert.strictEqual(route.severity, 'MEDIUM');
  assert.ok(warnings.length > 0);
});

test('validateRoute: PASS 有 severity → 清除', () => {
  const { route } = validateRoute({ verdict: 'PASS', route: 'NEXT', severity: 'HIGH' });
  assert.ok(!route.severity);
});

test('validateRoute: BARRIER 缺 barrierGroup → 補 default', () => {
  const { route, warnings } = validateRoute({ verdict: 'PASS', route: 'BARRIER' });
  assert.strictEqual(route.barrierGroup, 'default');
  assert.ok(warnings.some(w => w.includes('barrierGroup')));
});

test('validateRoute: BARRIER 有 barrierGroup → 保留', () => {
  const { route, warnings } = validateRoute({ verdict: 'PASS', route: 'BARRIER', barrierGroup: 'quality' });
  assert.strictEqual(route.barrierGroup, 'quality');
  assert.ok(!warnings.some(w => w.includes('barrierGroup')));
});

test('validateRoute: route 不合法 → 修正', () => {
  const { route, warnings } = validateRoute({ verdict: 'PASS', route: 'INVALID' });
  assert.strictEqual(route.route, 'NEXT');
  assert.ok(warnings.some(w => w.includes('invalid route')));
});

test('validateRoute: verdict 不合法 → 改 PASS', () => {
  const { route, warnings } = validateRoute({ verdict: 'UNKNOWN', route: 'NEXT' });
  assert.strictEqual(route.verdict, 'PASS');
  assert.ok(warnings.some(w => w.includes('invalid verdict')));
});

test('validateRoute: hint 超過 200 字 → 截斷', () => {
  const longHint = 'x'.repeat(250);
  const { route, warnings } = validateRoute({ verdict: 'FAIL', route: 'DEV', severity: 'HIGH', hint: longHint });
  assert.strictEqual(route.hint.length, 200);
  assert.ok(warnings.some(w => w.includes('truncated')));
});

test('validateRoute: null → route=null + warnings', () => {
  const { route, warnings } = validateRoute(null);
  assert.strictEqual(route, null);
  assert.ok(warnings.length > 0);
});

test('validateRoute: 空物件 → verdict 補 PASS', () => {
  const { route } = validateRoute({});
  assert.strictEqual(route.verdict, 'PASS');
});

// ────────────── enforcePolicy 測試 ──────────────

const makeState = (dag = {}, retries = {}) => ({ dag, retries, retryHistory: {} });

test('enforcePolicy: PASS/NEXT → 不修改', () => {
  const route = { verdict: 'PASS', route: 'NEXT' };
  const { route: r, enforced } = enforcePolicy(route, makeState({ DEV: { deps: [] } }), 'REVIEW');
  assert.strictEqual(r.route, 'NEXT');
  assert.strictEqual(enforced, false);
});

test('enforcePolicy: PASS+DEV → 強制 NEXT（邏輯矛盾）', () => {
  const route = { verdict: 'PASS', route: 'DEV' };
  const { route: r, enforced, reason } = enforcePolicy(route, makeState({ DEV: { deps: [] } }), 'REVIEW');
  assert.strictEqual(r.route, 'NEXT');
  assert.strictEqual(enforced, true);
  assert.ok(reason.includes('PASS'));
});

test('enforcePolicy: 達 MAX_RETRIES → 強制 NEXT', () => {
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const state = makeState({ DEV: { deps: [] } }, { REVIEW: 3 }); // MAX_RETRIES=3
  const { route: r, enforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'NEXT');
  assert.strictEqual(enforced, true);
  assert.ok(r._retryExhausted);
});

test('enforcePolicy: retries < MAX_RETRIES → 不修改', () => {
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const state = makeState({ DEV: { deps: [] } }, { REVIEW: 1 });
  const { route: r, enforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'DEV');
  assert.strictEqual(enforced, false);
});

test('enforcePolicy: DAG 無 DEV → route=DEV 強制 NEXT', () => {
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  // DAG 只有 REVIEW 和 TEST，無 DEV
  const state = makeState({ REVIEW: { deps: [] }, TEST: { deps: ['REVIEW'] } }, {});
  const { route: r, enforced, reason } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'NEXT');
  assert.strictEqual(enforced, true);
  assert.ok(reason.includes('no DEV'));
});

test('enforcePolicy: DAG 有 DEV → 允許回退', () => {
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const state = makeState({ DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } }, {});
  const { route: r, enforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'DEV');
  assert.strictEqual(enforced, false);
});

test('enforcePolicy: route = null → 回傳原值', () => {
  const { route: r } = enforcePolicy(null, makeState(), 'REVIEW');
  assert.strictEqual(r, null);
});

test('enforcePolicy: state = null → 不崩潰', () => {
  const route = { verdict: 'FAIL', route: 'DEV', severity: 'HIGH' };
  const { route: r } = enforcePolicy(route, null, 'REVIEW');
  assert.ok(r); // 不崩潰
});

// ────────────── 清理暫存檔 ──────────────

cleanup();

// ────────────── 結果 ──────────────

console.log(`\n=== route-parser.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
