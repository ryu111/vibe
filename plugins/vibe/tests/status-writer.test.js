/**
 * status-writer.test.js — status-writer.js 單元測試（S5 FIC 狀態壓縮）
 *
 * 測試範圍：
 * 1. generateStatus：空 state、已完成 stage、進行中 stage、含 wisdom 決策記錄
 * 2. updateStatus + readStatus：往返測試
 * 3. readStatus：檔案不存在回傳 null
 * 4. getStatusPath：路徑格式
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 覆寫 HOME 避免污染真實 ~/.claude
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'status-writer-test-'));
process.env.HOME = TMP_HOME;

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  generateStatus,
  updateStatus,
  readStatus,
  getStatusPath,
} = require('../scripts/lib/flow/status-writer.js');

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

const SESSION_ID = 'test-status-' + process.pid;

function cleanupStatus() {
  const filePath = getStatusPath(SESSION_ID);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ── 1. getStatusPath ──

test('getStatusPath: 格式正確', () => {
  const p = getStatusPath('abc123');
  assert.ok(p.includes('pipeline-status-abc123.md'), `期望包含 pipeline-status-abc123.md，實際: ${p}`);
  assert.ok(path.isAbsolute(p), '應為絕對路徑');
});

test('getStatusPath: sessionId 含連字號和數字格式正確', () => {
  const p = getStatusPath('session-20250101-42');
  assert.ok(p.includes('pipeline-status-session-20250101-42.md'), `路徑格式不正確: ${p}`);
});

// ── 2. generateStatus — 空 state ──

test('generateStatus: null state 回傳空字串', () => {
  const result = generateStatus(null);
  assert.strictEqual(result, '');
});

test('generateStatus: 空 state 物件回傳基本格式', () => {
  const state = { classification: { pipelineId: 'quick-dev' }, stages: {}, dag: {}, meta: {} };
  const result = generateStatus(state);
  assert.ok(result.includes('Pipeline Status'), `應含標題，實際: ${result}`);
  assert.ok(result.includes('quick-dev'), `應含 pipelineId，實際: ${result}`);
});

// ── 3. generateStatus — 已完成 stage ──

test('generateStatus: 有已完成 stage 的 state', () => {
  const state = {
    classification: { pipelineId: 'standard' },
    meta: { sessionId: 'abc123def456' },
    stages: {
      PLAN: { status: 'completed', verdict: 'PASS', completedAt: new Date().toISOString() },
      DEV: { status: 'completed', verdict: 'PASS', completedAt: new Date().toISOString() },
    },
    dag: {
      PLAN: { deps: [] },
      DEV: { deps: ['PLAN'] },
    },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('## 已完成'), `應含已完成區塊，實際:\n${result}`);
  assert.ok(result.includes('[x] PLAN'), `應含 PLAN，實際:\n${result}`);
  assert.ok(result.includes('[x] DEV'), `應含 DEV，實際:\n${result}`);
  assert.ok(result.includes('PASS'), `應含 PASS verdict，實際:\n${result}`);
});

test('generateStatus: SKIPPED stage 也列為已完成', () => {
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'skipped', verdict: 'SKIP' },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('[x] DEV'), `skipped stage 應列為完成，實際:\n${result}`);
});

// ── 4. generateStatus — 進行中 stage ──

test('generateStatus: 有進行中 stage 的 state', () => {
  const state = {
    classification: { pipelineId: 'standard' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'active' },
    },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('## 進行中'), `應含進行中區塊，實際:\n${result}`);
  assert.ok(result.includes('REVIEW'), `應含 REVIEW，實際:\n${result}`);
  assert.ok(result.includes('執行中'), `應含執行中，實際:\n${result}`);
});

test('generateStatus: pending stage（依賴已完成）顯示等待委派', () => {
  const state = {
    classification: { pipelineId: 'standard' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'pending' },
    },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('等待委派'), `依賴已完成的 pending 應顯示等待委派，實際:\n${result}`);
});

test('generateStatus: pending stage（依賴未完成）顯示等待依賴', () => {
  const state = {
    classification: { pipelineId: 'standard' },
    meta: {},
    stages: {
      DEV: { status: 'pending' },
      REVIEW: { status: 'pending' },
    },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
  };
  const result = generateStatus(state);
  // REVIEW 的 deps=['DEV']，DEV 狀態為 pending，REVIEW 應顯示等待依賴
  assert.ok(result.includes('等待依賴'), `依賴未完成的 pending 應顯示等待依賴，實際:\n${result}`);
});

// ── 5. generateStatus — 決策記錄（wisdom）──

test('generateStatus: 包含 wisdom 決策記錄', () => {
  const state = {
    classification: { pipelineId: 'quick-dev' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS' },
    },
    dag: { DEV: { deps: [] } },
  };
  const wisdomContent = '## REVIEW\n- 發現：null 邊界未處理\n- 建議：加入 try-catch';
  const result = generateStatus(state, wisdomContent);
  assert.ok(result.includes('## 決策記錄'), `應含決策記錄區塊，實際:\n${result}`);
  assert.ok(result.includes('null 邊界未處理'), `應含 wisdom 要點，實際:\n${result}`);
});

test('generateStatus: wisdomContent 為 null 時不產生決策記錄區塊', () => {
  const state = {
    classification: { pipelineId: 'quick-dev' },
    meta: {},
    stages: { DEV: { status: 'completed', verdict: 'PASS' } },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state, null);
  assert.ok(!result.includes('## 決策記錄'), `null wisdom 不應產生決策記錄，實際:\n${result}`);
});

// ── 6. updateStatus + readStatus 往返 ──

test('updateStatus + readStatus: 往返正確', () => {
  cleanupStatus();
  const state = {
    classification: { pipelineId: 'quick-dev' },
    meta: { sessionId: SESSION_ID },
    stages: {
      DEV: { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'pending' },
    },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
  };

  updateStatus(SESSION_ID, state);
  const content = readStatus(SESSION_ID);
  assert.ok(content !== null, '應讀到內容');
  assert.ok(content.includes('Pipeline Status'), `應含標題，實際: ${content}`);
  assert.ok(content.includes('DEV'), `應含 DEV，實際: ${content}`);
  assert.ok(content.includes('REVIEW'), `應含 REVIEW，實際: ${content}`);
  cleanupStatus();
});

test('updateStatus: 重複呼叫覆寫（非追加）', () => {
  cleanupStatus();
  const state1 = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: { DEV: { status: 'completed', verdict: 'PASS' } },
    dag: { DEV: { deps: [] } },
  };
  const state2 = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'completed', verdict: 'PASS' },
    },
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
  };

  updateStatus(SESSION_ID, state1);
  updateStatus(SESSION_ID, state2);
  const content = readStatus(SESSION_ID);
  // 只有一個 Pipeline Status 標題（覆寫非追加）
  const titleCount = (content.match(/# Pipeline Status/g) || []).length;
  assert.strictEqual(titleCount, 1, `應只有一個標題（覆寫模式），實際 ${titleCount} 個`);
  cleanupStatus();
});

test('updateStatus: null 參數靜默忽略', () => {
  // 不應拋出 error
  updateStatus(null, {});
  updateStatus(SESSION_ID, null);
  assert.ok(true, '不應拋出例外');
});

// ── 7. readStatus — 檔案不存在 ──

test('readStatus: 檔案不存在回傳 null', () => {
  cleanupStatus();
  const result = readStatus(SESSION_ID);
  assert.strictEqual(result, null, '檔案不存在應回傳 null');
});

test('readStatus: null sessionId 回傳 null', () => {
  assert.strictEqual(readStatus(null), null);
  assert.strictEqual(readStatus(undefined), null);
});

test('readStatus: 空白檔案回傳 null', () => {
  cleanupStatus();
  fs.writeFileSync(getStatusPath(SESSION_ID), '   \n\n   ', 'utf8');
  const result = readStatus(SESSION_ID);
  assert.strictEqual(result, null, '空白檔案應回傳 null');
  cleanupStatus();
});

// ── 8. _formatRelativeTime 分支覆蓋（透過 generateStatus 間接測試）──

test('_formatRelativeTime: 剛剛（不足 1 分鐘）', () => {
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS', completedAt: new Date().toISOString() },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  // 剛剛完成 → 時間標記為「剛剛」
  assert.ok(result.includes('剛剛'), `應含「剛剛」，實際:\n${result}`);
});

test('_formatRelativeTime: 分鐘前（2 分鐘）', () => {
  const twoMinAgo = new Date(Date.now() - 120000).toISOString();
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS', completedAt: twoMinAgo },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('分鐘前'), `應含「分鐘前」，實際:\n${result}`);
});

test('_formatRelativeTime: 小時前（2 小時）', () => {
  const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS', completedAt: twoHoursAgo },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('小時前'), `應含「小時前」，實際:\n${result}`);
});

test('_formatRelativeTime: 天前（2 天）', () => {
  const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS', completedAt: twoDaysAgo },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  assert.ok(result.includes('天前'), `應含「天前」，實際:\n${result}`);
});

test('_formatRelativeTime: 無效日期不顯示時間標記', () => {
  const state = {
    classification: { pipelineId: 'fix' },
    meta: {},
    stages: {
      DEV: { status: 'completed', verdict: 'PASS', completedAt: 'not-a-date' },
    },
    dag: { DEV: { deps: [] } },
  };
  const result = generateStatus(state);
  // 無效日期應靜默忽略，不顯示時間標記（不含「分鐘前」「小時前」「天前」「剛剛」）
  assert.ok(!result.includes('分鐘前'), `無效日期不應顯示「分鐘前」，實際:\n${result}`);
  assert.ok(!result.includes('小時前'), `無效日期不應顯示「小時前」，實際:\n${result}`);
  assert.ok(!result.includes('天前'), `無效日期不應顯示「天前」，實際:\n${result}`);
  assert.ok(!result.includes('剛剛'), `無效日期不應顯示「剛剛」，實際:\n${result}`);
  // stage 本身仍應列出
  assert.ok(result.includes('[x] DEV'), `stage 仍應列出，實際:\n${result}`);
});

// ── 清理暫存目錄 ──

cleanupStatus();

// ── 結果輸出 ──

console.log(`\nstatus-writer.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
