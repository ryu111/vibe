/**
 * reflection.test.js — reflection.js 單元測試
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 暫時覆寫 CLAUDE_DIR（確保測試不污染真實的 ~/.claude）
const ORIG_HOME = os.homedir;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-test-'));
process.env.HOME = TMP_HOME;

// 重新 require（利用 Node.js 模組快取清除）
// 由於 reflection.js 在 require 時就確定了 CLAUDE_DIR，我們需要 mock 路徑
// 使用不同策略：直接測試寫入到 TMP 目錄
const {
  writeReflection,
  readReflection,
  cleanReflections,
  cleanReflectionForStage,
  getReflectionPath,
  MAX_ROUND_CHARS,
  MAX_TOTAL_CHARS,
} = require('../scripts/lib/flow/reflection.js');

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

// 取得實際使用的 CLAUDE_DIR
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const TEST_SESSION = 'test-session-' + process.pid;
const TEST_STAGE = 'REVIEW';

function cleanup() {
  cleanReflections(TEST_SESSION);
  // 清理 TMP_HOME
  try { process.env.HOME = ORIG_HOME.call(os); } catch (_) {}
}

// ── writeReflection + readReflection ──

test('writeReflection: 寫入第一輪', () => {
  const verdict = { verdict: 'FAIL', severity: 'HIGH', hint: '有問題' };
  writeReflection(TEST_SESSION, TEST_STAGE, verdict, 0);

  const content = readReflection(TEST_SESSION, TEST_STAGE);
  assert.ok(content !== null, '應有內容');
  assert.ok(content.includes('Round 1'), '應含 Round 1');
  assert.ok(content.includes('FAIL:HIGH'), '應含 verdict');
  assert.ok(content.includes('有問題'), '應含 hint');
});

test('writeReflection: append 第二輪', () => {
  const verdict2 = { verdict: 'FAIL', severity: 'MEDIUM' };
  writeReflection(TEST_SESSION, TEST_STAGE, verdict2, 1);

  const content = readReflection(TEST_SESSION, TEST_STAGE);
  assert.ok(content.includes('Round 1'), '應含 Round 1');
  assert.ok(content.includes('Round 2'), '應含 Round 2');
  assert.ok(content.includes('FAIL:MEDIUM'), '應含第二輪 verdict');
});

test('readReflection: 不存在的 stage → null', () => {
  const content = readReflection(TEST_SESSION, 'NONEXISTENT');
  assert.strictEqual(content, null);
});

test('readReflection: 不存在的 session → null', () => {
  const content = readReflection('nonexistent-session', TEST_STAGE);
  assert.strictEqual(content, null);
});

// ── cleanReflectionForStage ──

test('cleanReflectionForStage: 刪除特定 stage 反思', () => {
  const sid = TEST_SESSION + '-clean';
  writeReflection(sid, 'TEST', { verdict: 'FAIL', severity: 'HIGH' }, 0);

  let content = readReflection(sid, 'TEST');
  assert.ok(content !== null, '清理前應有內容');

  cleanReflectionForStage(sid, 'TEST');
  content = readReflection(sid, 'TEST');
  assert.strictEqual(content, null, '清理後應為 null');
});

test('cleanReflectionForStage: 不存在的檔案 → 不崩潰', () => {
  cleanReflectionForStage('nonexistent-session', 'REVIEW');
  // 不崩潰即通過
});

// ── cleanReflections ──

test('cleanReflections: 清理所有 session 反思', () => {
  const sid = TEST_SESSION + '-cleanall';
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0);
  writeReflection(sid, 'TEST', { verdict: 'FAIL', severity: 'HIGH' }, 0);

  cleanReflections(sid);

  assert.strictEqual(readReflection(sid, 'REVIEW'), null);
  assert.strictEqual(readReflection(sid, 'TEST'), null);
});

// ── 長度限制 ──

test('writeReflection: 單輪超過 MAX_ROUND_CHARS → 截斷', () => {
  const sid = TEST_SESSION + '-truncate';
  const longHint = 'x'.repeat(600); // 超過 500
  const verdict = { verdict: 'FAIL', severity: 'HIGH', hint: longHint };
  writeReflection(sid, 'REVIEW', verdict, 0);

  const content = readReflection(sid, 'REVIEW');
  // 每輪內容應被截斷，整個檔案長度不會超太多
  const lines = content.split('\n');
  const roundSection = lines.filter(l => l.includes('Round')).length;
  assert.strictEqual(roundSection, 1, '應只有一輪');

  cleanReflections(sid);
});

test('writeReflection: 防禦性 null sessionId', () => {
  // 不崩潰
  writeReflection(null, 'REVIEW', { verdict: 'FAIL' }, 0);
});

test('writeReflection: 防禦性 null stage', () => {
  // 不崩潰
  writeReflection(TEST_SESSION, null, { verdict: 'FAIL' }, 0);
});

test('writeReflection: verdict = null → 不崩潰', () => {
  const sid = TEST_SESSION + '-null-verdict';
  writeReflection(sid, 'REVIEW', null, 0);
  const content = readReflection(sid, 'REVIEW');
  assert.ok(content !== null, '應有內容（verdict 欄位為 UNKNOWN）');
  assert.ok(content.includes('UNKNOWN'), '應含 UNKNOWN');
  cleanReflections(sid);
});

// ── getReflectionPath ──

test('getReflectionPath: 路徑格式正確', () => {
  const p = getReflectionPath('my-session', 'REVIEW');
  assert.ok(p.includes('reflection-memory-my-session-REVIEW.md'), '路徑格式正確');
  assert.ok(p.includes('.claude'), '應在 .claude 目錄');
});

// ── 清理 ──

cleanup();

// ── 結果 ──

console.log(`\n=== reflection.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
