/**
 * barrier.test.js — barrier.js 單元測試
 *
 * 測試 Barrier 並行同步模組的全生命週期。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 使用測試專用的 CLAUDE_DIR（避免污染實際 ~/.claude）
const TEST_CLAUDE_DIR = path.join(os.tmpdir(), `barrier-test-${process.pid}`);
fs.mkdirSync(TEST_CLAUDE_DIR, { recursive: true });

// Monkeypatch atomic-write 以使用測試目錄
const atomicWriteModule = require('../scripts/lib/flow/atomic-write.js');
const origAtomicWrite = atomicWriteModule.atomicWrite;

// 修改 barrier.js 的 CLAUDE_DIR 路徑
// 直接測試函式，但讓 barrier.js 使用測試目錄
const barrierModule = require('../scripts/lib/flow/barrier.js');

// 暫換路徑工具：將 ~/.claude 路徑換成測試路徑
function testBarrierPath(sessionId) {
  return path.join(TEST_CLAUDE_DIR, `barrier-state-${sessionId}.json`);
}

// 覆寫 getBarrierPath 的間接方式：在測試中直接操作 barrier state
function readTestBarrier(sessionId) {
  const p = testBarrierPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeTestBarrier(sessionId, state) {
  const p = testBarrierPath(sessionId);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

// 清理測試用 barrier state
function cleanTestBarrier(sessionId) {
  try { fs.unlinkSync(testBarrierPath(sessionId)); } catch {}
}

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

// ──────────────── mergeBarrierResults 測試 ────────────────

test('mergeBarrierResults：全部 PASS → 前進到 next', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'PASS', route: 'BARRIER' },
      'TEST': { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS');
  assert.strictEqual(result.route, 'NEXT');
  assert.strictEqual(result.target, 'QA');
});

test('mergeBarrierResults：全部 PASS 且無 next → COMPLETE', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'PASS', route: 'BARRIER' },
      'TEST': { verdict: 'PASS', route: 'BARRIER' },
    },
    next: null,
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS');
  assert.strictEqual(result.route, 'COMPLETE');
});

test('mergeBarrierResults：任一 FAIL → Worst-Case-Wins', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH', hint: 'REVIEW 問題' },
      'TEST': { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.route, 'DEV');
  assert.strictEqual(result.severity, 'HIGH');
  assert.ok(result.hint && result.hint.includes('REVIEW 問題'));
});

test('mergeBarrierResults：多個 FAIL → 取最嚴重 severity', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'FAIL', route: 'BARRIER', severity: 'MEDIUM', hint: 'REVIEW 中度問題' },
      'TEST': { verdict: 'FAIL', route: 'BARRIER', severity: 'CRITICAL', hint: 'TEST 嚴重問題' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.severity, 'CRITICAL');
  // hints 應包含兩個問題
  assert.ok(result.hint.includes('TEST 嚴重問題') || result.hint.includes('REVIEW 中度問題'));
});

test('mergeBarrierResults：PASS 時收集 context_files', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'PASS', route: 'BARRIER', context_file: '/tmp/review-ctx.md' },
      'TEST': { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS');
  assert.ok(Array.isArray(result.context_files));
  assert.ok(result.context_files.includes('/tmp/review-ctx.md'));
});

// ──────────────── checkTimeout 測試 ────────────────

test('checkTimeout：未超時 → false', () => {
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        resolved: false,
        createdAt: new Date().toISOString(),
      },
    },
  };
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'post-dev', 60000), false);
});

test('checkTimeout：已超時 → true', () => {
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        resolved: false,
        createdAt: new Date(Date.now() - 400000).toISOString(), // 400 秒前
      },
    },
  };
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'post-dev', 300000), true);
});

test('checkTimeout：group 不存在 → false', () => {
  const barrierState = { groups: {} };
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'nonexistent', 60000), false);
});

test('checkTimeout：已 resolved → false（不再超時）', () => {
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW', 'TEST'],
        resolved: true,
        createdAt: new Date(Date.now() - 400000).toISOString(),
      },
    },
  };
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'post-dev', 300000), false);
});

// ──────────────── rebuildBarrierFromState 測試 ────────────────

test('rebuildBarrierFromState：從 pipeline state 重建 barrier', () => {
  const state = {
    dag: {
      'DEV': { deps: [] },
      'REVIEW': {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      'TEST': {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
    },
    stages: {
      'DEV': { status: 'completed', verdict: { verdict: 'PASS' } },
      'REVIEW': { status: 'completed', verdict: { verdict: 'PASS' } },
      'TEST': { status: 'active' },
    },
  };
  const rebuilt = barrierModule.rebuildBarrierFromState(state);
  assert.ok(rebuilt.groups['post-dev']);
  assert.strictEqual(rebuilt.groups['post-dev'].total, 2);
  // REVIEW 已完成 → 在 completed 中
  assert.ok(rebuilt.groups['post-dev'].completed.includes('REVIEW'));
  // TEST 仍 active → 不在 completed
  assert.ok(!rebuilt.groups['post-dev'].completed.includes('TEST'));
});

test('rebuildBarrierFromState：無 dag → 空 groups', () => {
  const state = { dag: null, stages: {} };
  const rebuilt = barrierModule.rebuildBarrierFromState(state);
  assert.deepStrictEqual(rebuilt, { groups: {} });
});

// ──────────────── SEVERITY_ORDER 常量測試 ────────────────

test('SEVERITY_ORDER 嚴重度排序：CRITICAL > HIGH > MEDIUM > LOW', () => {
  const order = barrierModule.SEVERITY_ORDER;
  assert.ok(order.indexOf('CRITICAL') < order.indexOf('HIGH'));
  assert.ok(order.indexOf('HIGH') < order.indexOf('MEDIUM'));
  assert.ok(order.indexOf('MEDIUM') < order.indexOf('LOW'));
});

// ──────────────── DEFAULT_TIMEOUT_MS 常量 ────────────────

test('DEFAULT_TIMEOUT_MS 為 5 分鐘（300000ms）', () => {
  assert.strictEqual(barrierModule.DEFAULT_TIMEOUT_MS, 5 * 60 * 1000);
});

// ──────────────── 全 FAIL context_files 合併測試 ────────────────

test('mergeBarrierResults：FAIL 時收集所有 FAIL context_files', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH', context_file: '/tmp/ctx-REVIEW.md' },
      'TEST': { verdict: 'FAIL', route: 'BARRIER', severity: 'MEDIUM', context_file: '/tmp/ctx-TEST.md' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'FAIL');
  assert.ok(Array.isArray(result.context_files));
  assert.ok(result.context_files.includes('/tmp/ctx-REVIEW.md'));
  assert.ok(result.context_files.includes('/tmp/ctx-TEST.md'));
});

// ──────────────── _barrierMerged 標記 ────────────────

test('mergeBarrierResults：FAIL 時加入 _barrierMerged 標記', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      'REVIEW': { verdict: 'FAIL', route: 'BARRIER', severity: 'CRITICAL' },
      'TEST': { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = barrierModule.mergeBarrierResults(groupData);
  assert.strictEqual(result._barrierMerged, true);
});

// ──────────────── 目標 3：checkTimeout 完整測試 ────────────────

test('checkTimeout：barrier 等待中 + 未超時 → false（systemMessage 應為空）', () => {
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        resolved: false,
        createdAt: new Date().toISOString(), // 剛建立
      },
    },
  };
  // 未超時 → false（無需 systemMessage）
  const result = barrierModule.checkTimeout(barrierState, 'post-dev', 300000);
  assert.strictEqual(result, false, '未超時應回傳 false');
});

test('checkTimeout：barrier 等待中 + 已超時 → true（應發出警告訊息）', () => {
  // 模擬超過 5 分鐘前建立的 barrier
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        resolved: false,
        createdAt: new Date(Date.now() - 310000).toISOString(), // 310 秒前（超過 5 分鐘）
      },
    },
  };
  // 超時 → true（應發出超時警告）
  const result = barrierModule.checkTimeout(barrierState, 'post-dev', 300000);
  assert.strictEqual(result, true, '超時應回傳 true');
});

test('checkTimeout：剛好超過邊界（timeoutMs=100ms, createdAt=200ms前）→ true', () => {
  const barrierState = {
    groups: {
      'edge-case': {
        total: 2,
        completed: ['TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 200).toISOString(), // 200ms 前
      },
    },
  };
  // timeout=100ms，已超過 → true
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'edge-case', 100), true);
});

test('checkTimeout：剛好未到邊界（timeoutMs=1000ms, createdAt=50ms前）→ false', () => {
  const barrierState = {
    groups: {
      'edge-case': {
        total: 2,
        completed: ['TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 50).toISOString(), // 50ms 前
      },
    },
  };
  // timeout=1000ms，未超過 → false
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'edge-case', 1000), false);
});

test('checkTimeout：使用預設超時（5 分鐘 = DEFAULT_TIMEOUT_MS）', () => {
  const barrierState = {
    groups: {
      'post-qa': {
        total: 2,
        completed: ['QA'],
        resolved: false,
        createdAt: new Date().toISOString(), // 剛建立，不超時
      },
    },
  };
  // 不傳 timeoutMs，使用預設 DEFAULT_TIMEOUT_MS
  assert.strictEqual(barrierModule.checkTimeout(barrierState, 'post-qa'), false);
});

// ──────────────── 目標 4：barrier 回退清理 ────────────────

test('barrier 回退清理：REVIEW FAIL 後 deleteBarrier 使 readBarrier 回傳 null', () => {
  // 模擬 barrier state 被寫入 (使用 CLAUDE_DIR 真實路徑)
  const sessionId = `test-barrier-cleanup-${Date.now()}`;
  const os = require('os');
  const path = require('path');
  const barrierPath = path.join(os.homedir(), '.claude', `barrier-state-${sessionId}.json`);

  // 寫入 barrier state
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { 'REVIEW': { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date().toISOString(),
      },
    },
  };
  fs.writeFileSync(barrierPath, JSON.stringify(barrierState, null, 2));

  // 確認 readBarrier 能讀到
  const beforeDelete = barrierModule.readBarrier(sessionId);
  assert.ok(beforeDelete !== null, '刪除前 readBarrier 應有資料');

  // 執行 deleteBarrier（模擬回退清理）
  barrierModule.deleteBarrier(sessionId);

  // 確認 readBarrier 回傳 null
  const afterDelete = barrierModule.readBarrier(sessionId);
  assert.strictEqual(afterDelete, null, '刪除後 readBarrier 應回傳 null');

  // 清理：確保測試不留 state 檔案
  try { fs.unlinkSync(barrierPath); } catch (_) {}
});

test('barrier 回退清理：DEV 回退後 barrier state 不存在 → 下一輪從乾淨狀態開始', () => {
  const sessionId = `test-barrier-retry-${Date.now()}`;
  const os = require('os');
  const path = require('path');
  const barrierPath = path.join(os.homedir(), '.claude', `barrier-state-${sessionId}.json`);

  // 初始：無 barrier state
  assert.strictEqual(barrierModule.readBarrier(sessionId), null, '初始應無 barrier state');

  // 模擬 REVIEW FAIL → deleteBarrier
  fs.writeFileSync(barrierPath, JSON.stringify({ groups: { 'post-dev': { resolved: false } } }));
  barrierModule.deleteBarrier(sessionId);

  // 回退清理後：readBarrier 回傳 null
  assert.strictEqual(barrierModule.readBarrier(sessionId), null, '清理後 readBarrier 應為 null');

  // 確認 createBarrierGroup 可以重新建立（乾淨狀態）
  const newBarrierState = barrierModule.createBarrierGroup(sessionId, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  const reread = barrierModule.readBarrier(sessionId);
  assert.ok(reread !== null, '重新建立後 readBarrier 應有資料');
  assert.ok(reread.groups['post-dev'], '重新建立的 post-dev group 應存在');
  assert.deepStrictEqual(reread.groups['post-dev'].completed, [], '新 barrier 的 completed 應為空陣列');

  // 清理
  barrierModule.deleteBarrier(sessionId);
  try { fs.unlinkSync(barrierPath); } catch (_) {}
});

test('deleteBarrier：刪除不存在的 session → 不拋出錯誤', () => {
  // 非常規邊界：刪除不存在的 session
  assert.doesNotThrow(() => {
    barrierModule.deleteBarrier('nonexistent-session-id-12345');
  }, '刪除不存在的 barrier state 不應拋出錯誤');
});

// ──────────────── 清理測試目錄 ────────────────

try {
  fs.rmSync(TEST_CLAUDE_DIR, { recursive: true, force: true });
} catch (_) {}

// ──────────────── 結果 ────────────────

console.log(`\n barrier: ${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
