/**
 * retry-adaptive.test.js — S10 Smart Retry 自適應重試策略測試
 *
 * 涵蓋：
 * 1. adaptiveRetryLimit — 趨勢動態調整 maxRetries（6 case）
 * 2. detectDuplicateHints — 偵測連續重複 hint（6 case）
 * 3. 整合測試：shouldStop 使用 adjustedLimit（2 case）
 * 4. 整合測試：getRetryContext + duplicateHints 注入（2 case）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 暫時 mock HOME 目錄避免污染真實 ~/.claude ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-adaptive-test-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = TMP_HOME;

// 確保 CLAUDE_DIR 存在
const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  shouldStop,
  analyzeTrend,
  adaptiveRetryLimit,
  detectDuplicateHints,
  MAX_RETRIES,
} = require('../scripts/lib/flow/retry-policy.js');

const {
  getRetryContext,
} = require('../scripts/lib/flow/node-context.js');

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

// ────────────────── adaptiveRetryLimit 測試（6 case）──────────────────

test('Case 1: worsening + baseLimit=3 → 回傳 2', () => {
  const result = adaptiveRetryLimit(3, [], 'worsening');
  assert.strictEqual(result, 2, `期望 2，實際 ${result}`);
});

test('Case 2: improving + baseLimit=3 → 回傳 4', () => {
  const result = adaptiveRetryLimit(3, [], 'improving');
  assert.strictEqual(result, 4, `期望 4，實際 ${result}`);
});

test('Case 3: stable + baseLimit=3 → 回傳 3（不調整）', () => {
  const result = adaptiveRetryLimit(3, [], 'stable');
  assert.strictEqual(result, 3, `期望 3，實際 ${result}`);
});

test('Case 4: null trend + baseLimit=3 → 回傳 3（不調整）', () => {
  const result = adaptiveRetryLimit(3, [], null);
  assert.strictEqual(result, 3, `期望 3，實際 ${result}`);
});

test('Case 5: worsening + baseLimit=1 → 回傳 1（硬下限保護）', () => {
  const result = adaptiveRetryLimit(1, [], 'worsening');
  assert.strictEqual(result, 1, `期望 1（硬下限），實際 ${result}`);
});

test('Case 6: invalid baseLimit (0) → 回傳 1（防呆）', () => {
  const result0 = adaptiveRetryLimit(0, [], 'stable');
  assert.strictEqual(result0, 1, `baseLimit=0 期望 1，實際 ${result0}`);

  const resultUndef = adaptiveRetryLimit(undefined, [], 'stable');
  assert.strictEqual(resultUndef, 1, `baseLimit=undefined 期望 1，實際 ${resultUndef}`);
});

// ────────────────── detectDuplicateHints 測試（6 case）──────────────────

test('Case 7: 兩筆相同 severity + hint → isDuplicate=true, consecutiveCount=2', () => {
  const history = [
    { severity: 'HIGH', hint: 'function foo 沒有錯誤處理，需要補充 try-catch 邏輯' },
    { severity: 'HIGH', hint: 'function foo 沒有錯誤處理，需要補充 try-catch 邏輯' },
  ];
  const result = detectDuplicateHints(history);
  assert.strictEqual(result.isDuplicate, true, '期望 isDuplicate=true');
  assert.strictEqual(result.consecutiveCount, 2, `期望 consecutiveCount=2，實際 ${result.consecutiveCount}`);
});

test('Case 8: 兩筆不同 severity → isDuplicate=false', () => {
  const history = [
    { severity: 'CRITICAL', hint: 'SQL injection 漏洞，需要 parameterized query' },
    { severity: 'HIGH', hint: 'SQL injection 漏洞，需要 parameterized query' },
  ];
  const result = detectDuplicateHints(history);
  assert.strictEqual(result.isDuplicate, false, '不同 severity 應回傳 isDuplicate=false');
  assert.strictEqual(result.consecutiveCount, 0, `期望 consecutiveCount=0，實際 ${result.consecutiveCount}`);
});

test('Case 9: 只有一筆 → isDuplicate=false', () => {
  const history = [
    { severity: 'HIGH', hint: '缺少 null 檢查' },
  ];
  const result = detectDuplicateHints(history);
  assert.strictEqual(result.isDuplicate, false, '單筆歷史應回傳 isDuplicate=false');
  assert.strictEqual(result.consecutiveCount, 0, `期望 consecutiveCount=0，實際 ${result.consecutiveCount}`);
});

test('Case 10: 空陣列 → isDuplicate=false', () => {
  const result = detectDuplicateHints([]);
  assert.strictEqual(result.isDuplicate, false, '空陣列應回傳 isDuplicate=false');
  assert.strictEqual(result.consecutiveCount, 0, `期望 consecutiveCount=0，實際 ${result.consecutiveCount}`);
});

test('Case 11: hint 前 50 字元相同但後面不同 → isDuplicate=true（前綴匹配）', () => {
  // 兩個 hint 的前 50 字元完全相同，後面不同
  const prefix = '12345678901234567890123456789012345678901234567890'; // 剛好 50 字元
  const history = [
    { severity: 'MEDIUM', hint: prefix + '【詳細說明 A】' },
    { severity: 'MEDIUM', hint: prefix + '【詳細說明 B 完全不同的結尾】' },
  ];
  const result = detectDuplicateHints(history);
  assert.strictEqual(result.isDuplicate, true, '前 50 字元相同應判定為重複');
  assert.strictEqual(result.consecutiveCount, 2, `期望 consecutiveCount=2，實際 ${result.consecutiveCount}`);
});

test('Case 12: 三筆連續重複 → consecutiveCount=3', () => {
  const hint = 'validateInput 函式缺少邊界條件檢查，輸入為 null 時會拋出 TypeError';
  const history = [
    { severity: 'HIGH', hint },
    { severity: 'HIGH', hint },
    { severity: 'HIGH', hint },
  ];
  const result = detectDuplicateHints(history);
  assert.strictEqual(result.isDuplicate, true, '三筆連續重複應回傳 isDuplicate=true');
  assert.strictEqual(result.consecutiveCount, 3, `期望 consecutiveCount=3，實際 ${result.consecutiveCount}`);
});

// ────────────────── 整合測試：shouldStop 使用 adjustedLimit（4 case）──────────────────

test('Case 13: worsening 情境 — adjustedLimit=2，retryCount=2 → stop=true', () => {
  // worsening 時 adjustedLimit = max(1, 3-1) = 2
  // retryCount=2 >= adjustedLimit=2 → FORCE_NEXT
  const history = [
    { verdict: 'FAIL', severity: 'LOW', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 }, // severity 惡化
  ];
  const trend = analyzeTrend(history);
  assert.strictEqual(trend, 'worsening', '趨勢應為 worsening');

  const adjustedLimit = adaptiveRetryLimit(MAX_RETRIES, history, trend);
  assert.strictEqual(adjustedLimit, 2, `adjustedLimit 應為 2（MAX_RETRIES=${MAX_RETRIES} - 1），實際 ${adjustedLimit}`);

  const result = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 2, history, adjustedLimit);
  assert.strictEqual(result.stop, true, 'retryCount=2 >= adjustedLimit=2 應停止');
  assert.strictEqual(result.action, 'FORCE_NEXT', '應強制前進');
});

test('Case 14: improving 情境 — adjustedLimit=4，retryCount=3 → stop=false', () => {
  // improving 時 adjustedLimit = 3+1 = 4
  // retryCount=3 < adjustedLimit=4 → 繼續回退
  const history = [
    { verdict: 'FAIL', severity: 'CRITICAL', round: 1 },
    { verdict: 'FAIL', severity: 'HIGH', round: 2 }, // severity 改善
  ];
  const trend = analyzeTrend(history);
  assert.strictEqual(trend, 'improving', '趨勢應為 improving');

  const adjustedLimit = adaptiveRetryLimit(MAX_RETRIES, history, trend);
  assert.strictEqual(adjustedLimit, 4, `adjustedLimit 應為 4（MAX_RETRIES=${MAX_RETRIES} + 1），實際 ${adjustedLimit}`);

  const result = shouldStop('REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 3, history, adjustedLimit);
  assert.strictEqual(result.stop, false, 'retryCount=3 < adjustedLimit=4 應繼續');
  assert.strictEqual(result.action, 'RETRY', '應繼續回退');
});

// ────────────────── 整合測試：getRetryContext + duplicateHints 注入（2 case）──────────────────

test('Case 15: getRetryContext + 重複 hint → hint 含 ⛔ 前綴', () => {
  // 建立有重複 hint 的 state
  const sessionId = `test-adaptive-${process.pid}`;
  const repeatedHint = 'validateInput 函式未檢查 null 輸入，導致 TypeError';
  const state = {
    retries: { REVIEW: 2 },
    dag: {
      REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
      DEV: { deps: [] },
    },
    retryHistory: {
      REVIEW: [
        { verdict: 'FAIL', severity: 'HIGH', hint: repeatedHint },
        { verdict: 'FAIL', severity: 'HIGH', hint: repeatedHint },
      ],
    },
  };

  const result = getRetryContext(sessionId, 'DEV', state);
  assert.ok(result, 'getRetryContext 應回傳非 null 結果');
  assert.strictEqual(result.failedStage, 'REVIEW', '失敗 stage 應為 REVIEW');
  assert.ok(result.hint.includes('⛔'), `hint 應含 ⛔ 前綴（連續重複警告），實際: ${result.hint}`);
  assert.ok(result.hint.includes('連續 2 輪'), `hint 應提及 consecutiveCount=2，實際: ${result.hint}`);
  assert.ok(result.duplicateHint, 'duplicateHint 欄位應存在');
  assert.strictEqual(result.duplicateHint.isDuplicate, true, 'duplicateHint.isDuplicate 應為 true');
  assert.strictEqual(result.duplicateHint.consecutiveCount, 2, 'duplicateHint.consecutiveCount 應為 2');
});

test('Case 16: getRetryContext + 無重複 hint → hint 不含 ⛔ 前綴', () => {
  // 建立不重複的 retryHistory
  const sessionId = `test-adaptive-nodup-${process.pid}`;
  const state = {
    retries: { REVIEW: 1 },
    dag: {
      REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
      DEV: { deps: [] },
    },
    retryHistory: {
      REVIEW: [
        { verdict: 'FAIL', severity: 'HIGH', hint: '問題 A：缺少 null 檢查' },
        { verdict: 'FAIL', severity: 'HIGH', hint: '問題 B：邊界條件錯誤，與上輪不同' },
      ],
    },
  };

  const result = getRetryContext(sessionId, 'DEV', state);
  assert.ok(result, 'getRetryContext 應回傳非 null 結果');
  assert.strictEqual(result.failedStage, 'REVIEW', '失敗 stage 應為 REVIEW');
  assert.ok(!result.hint.includes('⛔'), `hint 不應含 ⛔ 前綴（無重複），實際: ${result.hint}`);
  assert.ok(!result.duplicateHint, 'duplicateHint 欄位應不存在（undefined）');
});

// ────────────────── 清理 ──────────────────

// 恢復 HOME 環境變數
process.env.HOME = ORIG_HOME;

// 清理暫存目錄
try {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
} catch (_) {
  // 忽略清理錯誤
}

// ────────────────── 結果輸出 ──────────────────

console.log(`\n=== retry-adaptive.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
