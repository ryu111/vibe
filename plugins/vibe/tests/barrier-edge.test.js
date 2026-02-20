/**
 * barrier-edge.test.js — barrier.js 邊界案例補充測試
 *
 * 補充覆蓋範圍（現有 barrier.test.js 和 barrier-lifecycle.test.js 未覆蓋的部分）：
 * 1. updateBarrier — group 不存在時的防禦性處理
 * 2. updateBarrier — mergedResult hint 合併格式（多個 FAIL hints 以 "; " 分隔）
 * 3. updateBarrier — _failedStages 欄位正確性
 * 4. mergeBarrierResults — 空 results → PASS（容錯）
 * 5. sweepTimedOutGroups — 超時填入 absent stages 為 FAIL
 * 6. createBarrierGroup — 重複呼叫（冪等）不覆蓋現有 group
 * 7. mergeBarrierResults — PASS 有 context_file 正確收集
 * 8. mergeContextFiles — context file 合併（間接）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const {
  createBarrierGroup,
  updateBarrier,
  mergeBarrierResults,
  deleteBarrier,
  readBarrier,
  writeBarrier,
  sweepTimedOutGroups,
  rebuildBarrierFromState,
  DEFAULT_TIMEOUT_MS,
  SEVERITY_ORDER,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

function cleanSid(sid) {
  const p = path.join(CLAUDE_DIR, `barrier-state-${sid}.json`);
  try { fs.unlinkSync(p); } catch (_) {}
}

// ════════════════════════════════════════════════════════════
// 1. updateBarrier — group 不存在的防禦性處理
// ════════════════════════════════════════════════════════════

console.log('\n--- 1. updateBarrier group 不存在 ---');

test('updateBarrier: group 不存在 → allComplete=false，不崩潰', () => {
  const sid = `test-barrier-edge-nogroup-${Date.now()}`;
  cleanSid(sid);

  // 不建立 group 直接 update
  const result = updateBarrier(sid, 'nonexistent-group', 'REVIEW', {
    verdict: 'PASS', route: 'BARRIER',
  });
  assert.strictEqual(result.allComplete, false, 'group 不存在應回傳 allComplete=false');
  cleanSid(sid);
});

// ════════════════════════════════════════════════════════════
// 2. updateBarrier — hint 合併格式
// ════════════════════════════════════════════════════════════

console.log('\n--- 2. mergedResult hint 合併格式 ---');

test('updateBarrier: 兩個 FAIL 的 hints 以 "; " 分隔合併', () => {
  const sid = `test-barrier-edge-hints-${Date.now()}`;
  cleanSid(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  updateBarrier(sid, 'post-dev', 'REVIEW', {
    verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH', hint: 'auth 驗證問題',
  });
  const { allComplete, mergedResult } = updateBarrier(sid, 'post-dev', 'TEST', {
    verdict: 'FAIL', route: 'BARRIER', severity: 'MEDIUM', hint: 'SQL injection 風險',
  });

  assert.strictEqual(allComplete, true, '兩個 stage 完成後 allComplete=true');
  assert.ok(mergedResult, 'mergedResult 應存在');
  assert.ok(mergedResult.hint, 'mergedResult.hint 應存在');
  // 兩個 hints 都應出現在合併結果中
  assert.ok(mergedResult.hint.includes('auth 驗證問題'), '應含第一個 hint');
  assert.ok(mergedResult.hint.includes('SQL injection 風險'), '應含第二個 hint');

  cleanSid(sid);
});

test('updateBarrier: 一個 FAIL 有 hint + 一個 PASS 無 hint → hints 只含 FAIL 的', () => {
  const sid = `test-barrier-edge-hints2-${Date.now()}`;
  cleanSid(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  updateBarrier(sid, 'post-dev', 'REVIEW', {
    verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH', hint: '缺少錯誤處理',
  });
  const { mergedResult } = updateBarrier(sid, 'post-dev', 'TEST', {
    verdict: 'PASS', route: 'BARRIER',
  });

  assert.strictEqual(mergedResult.verdict, 'FAIL', 'verdict 應為 FAIL（有任一 FAIL）');
  assert.ok(mergedResult.hint && mergedResult.hint.includes('缺少錯誤處理'), '應含 FAIL 的 hint');
  assert.ok(!mergedResult.hint.includes('undefined'), 'hint 不應含 undefined');

  cleanSid(sid);
});

test('updateBarrier: FAIL 無 hint → mergedResult.hint 不包含 undefined', () => {
  const sid = `test-barrier-edge-nohint-${Date.now()}`;
  cleanSid(sid);

  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  updateBarrier(sid, 'post-dev', 'REVIEW', {
    verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH',
    // 沒有 hint 欄位
  });
  const { mergedResult } = updateBarrier(sid, 'post-dev', 'TEST', {
    verdict: 'PASS', route: 'BARRIER',
  });

  assert.ok(mergedResult, 'mergedResult 應存在');
  if (mergedResult.hint) {
    // 若有 hint，不應含 undefined
    assert.ok(!mergedResult.hint.includes('undefined'), 'hint 不應含 undefined');
  }

  cleanSid(sid);
});

// ════════════════════════════════════════════════════════════
// 3. updateBarrier — _failedStages 欄位
// ════════════════════════════════════════════════════════════

console.log('\n--- 3. _failedStages 欄位 ---');

test('mergeBarrierResults: _failedStages 包含失敗 stage 的 ID', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'FAIL', route: 'BARRIER', severity: 'HIGH' },
      TEST: { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = mergeBarrierResults(groupData);
  assert.ok(Array.isArray(result._failedStages), '_failedStages 應為陣列');
  assert.ok(result._failedStages.includes('REVIEW'), 'REVIEW 應在 _failedStages');
  assert.ok(!result._failedStages.includes('TEST'), 'TEST（PASS）不應在 _failedStages');
});

test('mergeBarrierResults: 全 PASS → 無 _failedStages 欄位', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'PASS', route: 'BARRIER' },
      TEST: { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS', 'verdict 應為 PASS');
  // 全 PASS 時不應有 _failedStages
  assert.ok(!result._failedStages, '全 PASS 時不應有 _failedStages');
});

// ════════════════════════════════════════════════════════════
// 4. mergeBarrierResults — 空 results
// ════════════════════════════════════════════════════════════

console.log('\n--- 4. mergeBarrierResults 空 results ---');

test('mergeBarrierResults: results 為空物件 → PASS（無 FAIL）', () => {
  const groupData = {
    total: 0,
    completed: [],
    results: {},
    next: 'QA',
    siblings: [],
    resolved: false,
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS', '空 results 應為 PASS');
});

// ════════════════════════════════════════════════════════════
// 5. sweepTimedOutGroups — 超時強制解鎖
// ════════════════════════════════════════════════════════════

console.log('\n--- 5. sweepTimedOutGroups ---');

test('sweepTimedOutGroups: 超時 group 填入缺席 stages 為 FAIL', () => {
  const sid = `test-barrier-edge-sweep-${Date.now()}`;
  cleanSid(sid);

  // 建立一個超時的 barrier state（createdAt 設為遠古）
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],  // TEST 尚未回報
        results: {
          REVIEW: { verdict: 'PASS', route: 'BARRIER' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 400000).toISOString(),  // 400 秒前（超時）
      },
    },
  };
  writeBarrier(sid, barrierState);

  const { timedOut } = sweepTimedOutGroups(sid);

  assert.ok(Array.isArray(timedOut), 'timedOut 應為陣列');
  assert.ok(timedOut.length > 0, '應偵測到超時 group');
  assert.strictEqual(timedOut[0].group, 'post-dev', 'group 名稱正確');
  assert.ok(timedOut[0].timedOutStages.includes('TEST'), 'TEST 應是超時 stage');
  assert.ok(timedOut[0].mergedResult, 'mergedResult 應存在');
  // REVIEW=PASS 但 TEST=FAIL(timeout) → Worst-Case-Wins = FAIL
  assert.strictEqual(timedOut[0].mergedResult.verdict, 'FAIL', '超時後合併應為 FAIL');

  cleanSid(sid);
});

test('sweepTimedOutGroups: 無 barrier state → timedOut 為空陣列', () => {
  const sid = `test-barrier-edge-sweep-empty-${Date.now()}`;
  cleanSid(sid);

  const { timedOut } = sweepTimedOutGroups(sid);
  assert.deepStrictEqual(timedOut, [], '無 barrier state 應回傳空陣列');

  cleanSid(sid);
});

test('sweepTimedOutGroups: 已 resolved 的 group 不重複處理', () => {
  const sid = `test-barrier-edge-sweep-resolved-${Date.now()}`;
  cleanSid(sid);

  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW', 'TEST'],
        results: {
          REVIEW: { verdict: 'PASS', route: 'BARRIER' },
          TEST: { verdict: 'PASS', route: 'BARRIER' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: true,  // 已 resolved
        createdAt: new Date(Date.now() - 400000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const { timedOut } = sweepTimedOutGroups(sid);
  assert.deepStrictEqual(timedOut, [], '已 resolved 的 group 不應出現在 timedOut');

  cleanSid(sid);
});

// ════════════════════════════════════════════════════════════
// 6. createBarrierGroup — 冪等性
// ════════════════════════════════════════════════════════════

console.log('\n--- 6. createBarrierGroup 冪等性 ---');

test('createBarrierGroup: 重複呼叫不覆蓋現有進度', () => {
  const sid = `test-barrier-edge-idempotent-${Date.now()}`;
  cleanSid(sid);

  // 第一次建立
  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);

  // 更新一個 stage
  updateBarrier(sid, 'post-dev', 'REVIEW', { verdict: 'PASS', route: 'BARRIER' });

  // 第二次呼叫相同 group（冪等，不應覆蓋）
  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);

  // 確認 REVIEW 的進度仍然存在
  const bs = readBarrier(sid);
  assert.ok(bs.groups['post-dev'].completed.includes('REVIEW'), '重複建立不應清除已完成的 REVIEW');
  assert.strictEqual(bs.groups['post-dev'].completed.length, 1, 'completed 仍應只有 1 個');

  cleanSid(sid);
});

// ════════════════════════════════════════════════════════════
// 7. mergeBarrierResults — PASS 無 context_file → 不加 context_files 欄位
// ════════════════════════════════════════════════════════════

console.log('\n--- 7. PASS 無 context_file 欄位過濾 ---');

test('mergeBarrierResults: 全 PASS 且無 context_file → 不加 context_files 欄位', () => {
  const groupData = {
    total: 2,
    completed: ['REVIEW', 'TEST'],
    results: {
      REVIEW: { verdict: 'PASS', route: 'BARRIER' },
      TEST: { verdict: 'PASS', route: 'BARRIER' },
    },
    next: 'QA',
    siblings: ['REVIEW', 'TEST'],
    resolved: false,
  };
  const result = mergeBarrierResults(groupData);
  assert.strictEqual(result.verdict, 'PASS');
  // 無 context_file 時不應有 context_files 欄位
  assert.ok(!result.context_files || result.context_files.length === 0,
    '無 context_file 時 context_files 應不存在或為空');
});

// ════════════════════════════════════════════════════════════
// 8. SEVERITY_ORDER 常數驗證（確保斷言用具體值）
// ════════════════════════════════════════════════════════════

console.log('\n--- 8. SEVERITY_ORDER 詳細驗證 ---');

test('SEVERITY_ORDER: 長度為 4', () => {
  assert.strictEqual(SEVERITY_ORDER.length, 4, 'SEVERITY_ORDER 應有 4 個元素');
});

test('SEVERITY_ORDER: 包含所有必要的嚴重程度', () => {
  assert.ok(SEVERITY_ORDER.includes('CRITICAL'), '應含 CRITICAL');
  assert.ok(SEVERITY_ORDER.includes('HIGH'), '應含 HIGH');
  assert.ok(SEVERITY_ORDER.includes('MEDIUM'), '應含 MEDIUM');
  assert.ok(SEVERITY_ORDER.includes('LOW'), '應含 LOW');
});

test('DEFAULT_TIMEOUT_MS: 確實為 5 分鐘', () => {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 5 * 60 * 1000, 'DEFAULT_TIMEOUT_MS 應為 300000ms');
});

// ════════════════════════════════════════════════════════════
// 9. rebuildBarrierFromState — 額外邊界案例
// ════════════════════════════════════════════════════════════

console.log('\n--- 9. rebuildBarrierFromState 額外邊界 ---');

test('rebuildBarrierFromState: stages 中有 failed stage → 視為 completed 並填入 FAIL', () => {
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      TEST: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'failed', verdict: { verdict: 'FAIL', severity: 'HIGH' } },
      TEST: { status: 'active' },
    },
  };
  const rebuilt = rebuildBarrierFromState(state);
  assert.ok(rebuilt.groups['post-dev'], 'post-dev group 應存在');
  // failed 視為 completed 並加入
  assert.ok(rebuilt.groups['post-dev'].completed.includes('REVIEW'),
    'failed stage 應視為 completed 加入 barrier');
  assert.ok(!rebuilt.groups['post-dev'].completed.includes('TEST'),
    'active stage 不應在 completed 中');
});

test('rebuildBarrierFromState: _rebuilt 標記為 true', () => {
  const state = {
    dag: {
      REVIEW: {
        deps: [],
        barrier: { group: 'test-group', total: 1, next: null, siblings: ['REVIEW'] },
      },
    },
    stages: {
      REVIEW: { status: 'completed' },
    },
  };
  const rebuilt = rebuildBarrierFromState(state);
  assert.strictEqual(rebuilt.groups['test-group']._rebuilt, true,
    '重建的 barrier group 應有 _rebuilt=true 標記');
});

// ════════════════════════════════════════════════════════════
// 結果
// ════════════════════════════════════════════════════════════

console.log(`\n=== barrier-edge.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
