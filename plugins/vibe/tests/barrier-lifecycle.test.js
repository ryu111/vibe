#!/usr/bin/env node
/**
 * barrier-lifecycle.test.js — Barrier 並行同步生命週期測試（F01-F04, F06）
 *
 * 場景：
 *   F01: REVIEW+TEST 雙 PASS → 全 PASS
 *   F02: REVIEW PASS + TEST FAIL → Worst-Case-Wins FAIL
 *   F03: barrier 超時強制解鎖
 *   F04: barrier 回退後刪除計數器（deleteBarrier on FAIL）
 *   F06: severity 合併（CRITICAL+HIGH=CRITICAL）
 *
 * 執行：node plugins/vibe/tests/barrier-lifecycle.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const {
  createBarrierGroup,
  updateBarrier,
  mergeBarrierResults,
  deleteBarrier,
  checkTimeout,
  readBarrier,
  writeBarrier,
  DEFAULT_TIMEOUT_MS,
  SEVERITY_ORDER,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));

let passed = 0;
let failed = 0;

cleanTestStateFiles();

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

function cleanBarrier(sid) {
  cleanSessionState(sid);
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n🚧 F01-F06：Barrier 並行同步生命週期');

// F01: REVIEW+TEST 雙 PASS → 全 PASS
test('F01: REVIEW+TEST 雙 PASS → mergeBarrierResults verdict=PASS', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'PASS', route: 'BARRIER', barrierGroup: 'post-dev' },
      TEST: { verdict: 'PASS', route: 'BARRIER', barrierGroup: 'post-dev' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS', `雙 PASS 應為 PASS，實際：${result.verdict}`);
  assert.strictEqual(result.route, 'NEXT', `PASS 應 route=NEXT`);
  assert.strictEqual(result.target, 'QA', `target 應為下一個 stage: QA`);
});

// F01b: 無 next 的 PASS → COMPLETE
test('F01b: 無 next 的雙 PASS → route=COMPLETE', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'PASS', route: 'BARRIER' },
      TEST: { verdict: 'PASS', route: 'BARRIER' },
    },
    next: null,  // 無 next
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS');
  assert.strictEqual(result.route, 'COMPLETE', `無 next 的 PASS 應 route=COMPLETE`);
});

// F02: REVIEW PASS + TEST FAIL → Worst-Case-Wins
test('F02: REVIEW PASS + TEST FAIL:HIGH → verdict=FAIL severity=HIGH', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'PASS', route: 'BARRIER' },
      TEST: { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH', hint: '測試失敗' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'FAIL', `有 FAIL 應合併為 FAIL`);
  assert.strictEqual(result.severity, 'HIGH', `severity 應取 HIGH`);
  assert.strictEqual(result.route, 'DEV', `FAIL 應 route=DEV`);
  assert.ok(result.hint, '應有合併 hint');
});

// F02b: updateBarrier 完整流程（兩個 stage 依序完成）
test('F02b: updateBarrier 依序完成兩個 stage 觸發 allComplete', () => {
  const sid = 'test-f02b';
  cleanBarrier(sid);

  // 建立 barrier group
  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);

  // 第一個 stage 完成（未到齊）
  const { allComplete: first } = updateBarrier(sid, 'post-dev', 'REVIEW', {
    verdict: 'PASS', route: 'BARRIER', barrierGroup: 'post-dev',
  });
  assert.strictEqual(first, false, '第一個 stage 完成後 allComplete 應為 false');

  // 第二個 stage 完成（到齊）
  const { allComplete: second, mergedResult } = updateBarrier(sid, 'post-dev', 'TEST', {
    verdict: 'PASS', route: 'BARRIER', barrierGroup: 'post-dev',
  });
  assert.strictEqual(second, true, '第二個 stage 完成後 allComplete 應為 true');
  assert.ok(mergedResult, '應有合併結果');
  assert.strictEqual(mergedResult.verdict, 'PASS');

  cleanBarrier(sid);
});

// F03: barrier 超時強制解鎖
test('F03: checkTimeout 正確偵測超時（createdAt 設為過去）', () => {
  const sid = 'test-f03';
  cleanBarrier(sid);

  // 手動建立一個已超時的 barrier state
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        // 設為 10 分鐘前（超時）
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  // 讀取後檢查超時（使用 1 ms timeout 確保觸發）
  const readBack = readBarrier(sid);
  assert.ok(readBack, 'barrier state 應可讀取');

  const timedOut = checkTimeout(readBack, 'post-dev', 1);  // 1ms timeout → 必定超時
  assert.strictEqual(timedOut, true, '應偵測到超時');

  cleanBarrier(sid);
});

test('F03b: checkTimeout 未超時回傳 false', () => {
  const sid = 'test-f03b';
  cleanBarrier(sid);

  createBarrierGroup(sid, 'test-group', 2, null, ['REVIEW', 'TEST']);
  const readBack = readBarrier(sid);
  assert.ok(readBack, 'barrier state 應存在');

  // 使用預設超時（5 分鐘）→ 剛建立的不會超時
  const timedOut = checkTimeout(readBack, 'test-group', DEFAULT_TIMEOUT_MS);
  assert.strictEqual(timedOut, false, '剛建立的 barrier 不應超時');

  cleanBarrier(sid);
});

// F04: barrier 回退後刪除計數器（deleteBarrier）
test('F04: deleteBarrier 後 readBarrier 回傳 null', () => {
  const sid = 'test-f04';
  cleanBarrier(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  const before = readBarrier(sid);
  assert.ok(before, '建立後 barrier 應存在');

  deleteBarrier(sid);
  const after = readBarrier(sid);
  assert.strictEqual(after, null, 'deleteBarrier 後應回傳 null');
});

// F04b: 回退場景模擬（FAIL → deleteBarrier）
test('F04b: FAIL 合併結果後 deleteBarrier 清除計數器', () => {
  const sid = 'test-f04b';
  cleanBarrier(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  updateBarrier(sid, 'post-dev', 'REVIEW', { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH' });
  const { allComplete, mergedResult } = updateBarrier(sid, 'post-dev', 'TEST', { verdict: 'FAIL', route: 'BARRIER', severity: 'MEDIUM' });

  assert.strictEqual(allComplete, true, '兩個 FAIL 都到齊應 allComplete=true');
  assert.strictEqual(mergedResult.verdict, 'FAIL', '合併應為 FAIL');

  // FAIL 時應刪除 barrier
  deleteBarrier(sid);
  assert.strictEqual(readBarrier(sid), null, '回退後 barrier 應被清除');
});

// F05: barrier group 冪等（重複 updateBarrier）
test('F05: 同 stage 重複 updateBarrier 不重複計數', () => {
  const sid = 'test-f05';
  cleanBarrier(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);

  // REVIEW 完成（第一次）
  updateBarrier(sid, 'post-dev', 'REVIEW', { verdict: 'PASS', route: 'BARRIER' });

  // REVIEW 重複（冪等）
  updateBarrier(sid, 'post-dev', 'REVIEW', { verdict: 'PASS', route: 'BARRIER' });

  const bs = readBarrier(sid);
  const completedCount = bs.groups['post-dev'].completed.length;
  assert.strictEqual(completedCount, 1, `同 stage 重複應只計 1 次，實際：${completedCount}`);

  cleanBarrier(sid);
});

// F06: severity 合併（CRITICAL+HIGH=CRITICAL）
test('F06: CRITICAL+HIGH → Worst-Case-Wins = CRITICAL', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH' },
      TEST: { verdict: 'FAIL', route: 'BARRIER', severity: 'CRITICAL' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.severity, 'CRITICAL', `CRITICAL+HIGH 應取最嚴重 CRITICAL，實際：${result.severity}`);
});

// F06b: severity 順序驗證
test('F06b: SEVERITY_ORDER 確認排序正確', () => {
  assert.deepStrictEqual(SEVERITY_ORDER, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
    `SEVERITY_ORDER 應為 CRITICAL > HIGH > MEDIUM > LOW`);
});

// F06c: LOW+MEDIUM → MEDIUM
test('F06c: LOW+MEDIUM → Worst-Case-Wins = MEDIUM', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'FAIL', severity: 'LOW', route: 'BARRIER' },
      TEST: { verdict: 'FAIL', severity: 'MEDIUM', route: 'BARRIER' },
    },
    next: null,
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.severity, 'MEDIUM', `LOW+MEDIUM 應取 MEDIUM`);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
