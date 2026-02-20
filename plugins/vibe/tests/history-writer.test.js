/**
 * history-writer.test.js — history-writer.js 單元測試（S9 Pipeline History）
 *
 * 測試範圍：
 * 1. getHistoryPath：路徑格式
 * 2. recordCompletion：正常記錄、缺少欄位容錯、cancelled 記錄
 * 3. queryHistory：無檔案回傳 []、正常查詢、filter 過濾、損毀行跳過
 * 4. truncateHistory：不足不截斷、超過截斷、空檔案
 * 5. summarizeHistory：正常統計、空陣列回傳 null、單筆記錄、successRate 計算
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 覆寫 HOME 避免污染真實 ~/.claude
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'history-writer-test-'));
process.env.HOME = TMP_HOME;

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  getHistoryPath,
  recordCompletion,
  queryHistory,
  truncateHistory,
  summarizeHistory,
  MAX_HISTORY_RECORDS,
} = require('../scripts/lib/flow/history-writer.js');

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

// ── 輔助：清理歷史檔案 ──

function cleanupHistory() {
  const p = getHistoryPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

// ── 輔助：建立測試 state ──

function makeState(overrides) {
  return {
    sessionId: 'test-sid-001',
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 分鐘前
    pipelineActive: false,
    cancelled: false,
    classification: { pipelineId: 'standard' },
    stages: {
      PLAN: { status: 'completed', verdict: 'PASS' },
      DEV:  { status: 'completed', verdict: 'PASS' },
    },
    retries: { PLAN: 0, DEV: 1 },
    crashes: { DEV: 0 },
    ...overrides,
  };
}

// ── 1. getHistoryPath ──

test('getHistoryPath: 回傳正確路徑', () => {
  const p = getHistoryPath();
  assert.ok(typeof p === 'string', '應為字串');
  assert.ok(p.includes('pipeline-history.jsonl'), `應包含 pipeline-history.jsonl，實際: ${p}`);
  assert.ok(path.isAbsolute(p), '應為絕對路徑');
});

test('getHistoryPath: 多次呼叫回傳相同路徑', () => {
  assert.strictEqual(getHistoryPath(), getHistoryPath());
});

// ── 2. recordCompletion ──

test('recordCompletion: 正常記錄 — 寫入 JSONL', () => {
  cleanupHistory();
  const state = makeState();
  recordCompletion(state);

  const p = getHistoryPath();
  assert.ok(fs.existsSync(p), '應建立 JSONL 檔案');
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, '應有一行記錄');
  const record = JSON.parse(lines[0]);
  assert.strictEqual(record.pipelineId, 'standard', 'pipelineId 應正確');
  assert.strictEqual(record.sessionId, 'test-sid-001', 'sessionId 應正確');
  assert.ok(record.completedAt, 'completedAt 應存在');
  cleanupHistory();
});

test('recordCompletion: 計算 totalRetries', () => {
  cleanupHistory();
  const state = makeState({
    retries: { PLAN: 0, DEV: 2 },
  });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.totalRetries, 2, 'totalRetries 應為 2');
  cleanupHistory();
});

test('recordCompletion: 計算 durationMs', () => {
  cleanupHistory();
  const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 分鐘前
  const state = makeState({ startedAt });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.ok(typeof record.durationMs === 'number', 'durationMs 應為數字');
  assert.ok(record.durationMs > 0, 'durationMs 應大於 0');
  cleanupHistory();
});

test('recordCompletion: startedAt 缺失時 durationMs 為 null', () => {
  cleanupHistory();
  const state = makeState({ startedAt: null });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.durationMs, null, 'durationMs 應為 null');
  cleanupHistory();
});

test('recordCompletion: cancelled state 記錄 CANCELLED', () => {
  cleanupHistory();
  const state = makeState({ cancelled: true });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.finalResult, 'CANCELLED', 'finalResult 應為 CANCELLED');
  assert.strictEqual(record.cancelled, true, 'cancelled 應為 true');
  cleanupHistory();
});

test('recordCompletion: 所有 stage completed → finalResult COMPLETE', () => {
  cleanupHistory();
  const state = makeState();
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.finalResult, 'COMPLETE', 'finalResult 應為 COMPLETE');
  cleanupHistory();
});

test('recordCompletion: stageResults 包含各 stage 資訊', () => {
  cleanupHistory();
  const state = makeState();
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.ok(Array.isArray(record.stageResults), 'stageResults 應為陣列');
  const planStage = record.stageResults.find(s => s.stageId === 'PLAN');
  assert.ok(planStage, '應包含 PLAN stage');
  assert.strictEqual(planStage.verdict, 'PASS', 'PLAN verdict 應為 PASS');
  cleanupHistory();
});

test('recordCompletion: null state 靜默忽略（不拋錯）', () => {
  recordCompletion(null);
  recordCompletion(undefined);
  recordCompletion('not-an-object');
  assert.ok(true, '不應拋錯');
});

test('recordCompletion: 多次呼叫追加記錄', () => {
  cleanupHistory();
  recordCompletion(makeState({ sessionId: 'sid-a' }));
  recordCompletion(makeState({ sessionId: 'sid-b' }));
  const lines = fs.readFileSync(getHistoryPath(), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '應有兩行記錄');
  cleanupHistory();
});

// ── 3. queryHistory ──

test('queryHistory: 無檔案回傳空陣列', () => {
  cleanupHistory();
  const result = queryHistory();
  assert.deepStrictEqual(result, [], '無檔案時應回傳 []');
});

test('queryHistory: 正常查詢回傳記錄', () => {
  cleanupHistory();
  recordCompletion(makeState({ sessionId: 'sid-q1' }));
  const result = queryHistory();
  assert.ok(result.length > 0, '應有記錄');
  assert.strictEqual(result[0].sessionId, 'sid-q1', 'sessionId 應正確');
  cleanupHistory();
});

test('queryHistory: 按 completedAt 降序排列', () => {
  cleanupHistory();
  // 寫入兩筆，completedAt 不同
  const p = getHistoryPath();
  const old = { pipelineId: 'fix', completedAt: '2026-01-01T00:00:00.000Z', finalResult: 'COMPLETE' };
  const recent = { pipelineId: 'standard', completedAt: '2026-02-01T00:00:00.000Z', finalResult: 'COMPLETE' };
  fs.writeFileSync(p, JSON.stringify(old) + '\n' + JSON.stringify(recent) + '\n', 'utf8');
  const result = queryHistory();
  assert.strictEqual(result[0].pipelineId, 'standard', '較新的應排在前');
  assert.strictEqual(result[1].pipelineId, 'fix', '較舊的應排在後');
  cleanupHistory();
});

test('queryHistory: filter.pipelineId 過濾', () => {
  cleanupHistory();
  recordCompletion(makeState({ classification: { pipelineId: 'standard' } }));
  recordCompletion(makeState({ classification: { pipelineId: 'fix' } }));
  const result = queryHistory({ pipelineId: 'standard' });
  assert.ok(result.every(r => r.pipelineId === 'standard'), '只應包含 standard');
  cleanupHistory();
});

test('queryHistory: filter.limit 截斷', () => {
  cleanupHistory();
  for (let i = 0; i < 5; i++) {
    recordCompletion(makeState({ sessionId: `sid-${i}` }));
  }
  const result = queryHistory({ limit: 3 });
  assert.strictEqual(result.length, 3, '應只回傳 3 筆');
  cleanupHistory();
});

test('queryHistory: filter.since 時間過濾', () => {
  cleanupHistory();
  const p = getHistoryPath();
  const old = { pipelineId: 'fix', completedAt: '2026-01-01T00:00:00.000Z', finalResult: 'COMPLETE' };
  const recent = { pipelineId: 'standard', completedAt: '2026-02-15T00:00:00.000Z', finalResult: 'COMPLETE' };
  fs.writeFileSync(p, JSON.stringify(old) + '\n' + JSON.stringify(recent) + '\n', 'utf8');
  const result = queryHistory({ since: '2026-02-01T00:00:00.000Z' });
  assert.strictEqual(result.length, 1, '只應包含 2026-02 之後的記錄');
  assert.strictEqual(result[0].pipelineId, 'standard');
  cleanupHistory();
});

test('queryHistory: 損毀行跳過，有效行正常回傳', () => {
  cleanupHistory();
  const p = getHistoryPath();
  const valid = { pipelineId: 'standard', completedAt: '2026-02-21T10:00:00.000Z', finalResult: 'COMPLETE' };
  fs.writeFileSync(p, '{ broken json }\n' + JSON.stringify(valid) + '\n', 'utf8');
  const result = queryHistory();
  assert.strictEqual(result.length, 1, '損毀行應跳過，有效記錄應回傳');
  assert.strictEqual(result[0].pipelineId, 'standard');
  cleanupHistory();
});

// ── 4. truncateHistory ──

test('truncateHistory: 無檔案時靜默忽略', () => {
  cleanupHistory();
  truncateHistory(10); // 無檔案，不應拋錯
  assert.ok(true, '不應拋錯');
});

test('truncateHistory: 記錄不足 maxRecords 時不做事', () => {
  cleanupHistory();
  const p = getHistoryPath();
  const record = { pipelineId: 'standard', completedAt: '2026-02-21T10:00:00.000Z' };
  fs.writeFileSync(p, JSON.stringify(record) + '\n', 'utf8');
  truncateHistory(10);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, '記錄數不變');
  cleanupHistory();
});

test('truncateHistory: 超過 maxRecords 時截斷保留最新', () => {
  cleanupHistory();
  const p = getHistoryPath();
  // 寫入 5 筆，completedAt 遞增
  const records = Array.from({ length: 5 }, (_, i) => ({
    pipelineId: 'standard',
    completedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
    finalResult: 'COMPLETE',
  }));
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  truncateHistory(3);
  const result = queryHistory();
  assert.strictEqual(result.length, 3, '截斷後應剩 3 筆');
  // 最新的應保留（completedAt 最大）
  assert.strictEqual(result[0].completedAt, '2026-02-05T00:00:00.000Z', '最新記錄應保留');
  cleanupHistory();
});

test('truncateHistory: 空檔案靜默忽略', () => {
  cleanupHistory();
  const p = getHistoryPath();
  fs.writeFileSync(p, '', 'utf8');
  truncateHistory(10); // 空檔案，不應拋錯
  assert.ok(true, '不應拋錯');
  cleanupHistory();
});

test('truncateHistory: maxRecords 預設為 MAX_HISTORY_RECORDS', () => {
  assert.strictEqual(MAX_HISTORY_RECORDS, 100, 'MAX_HISTORY_RECORDS 應為 100');
});

// ── 5. summarizeHistory ──

test('summarizeHistory: 空陣列回傳 null', () => {
  assert.strictEqual(summarizeHistory([]), null);
  assert.strictEqual(summarizeHistory(null), null);
  assert.strictEqual(summarizeHistory(undefined), null);
});

test('summarizeHistory: 正常統計', () => {
  const records = [
    {
      pipelineId: 'standard',
      completedAt: '2026-02-21T10:00:00.000Z',
      durationMs: 60000,
      finalResult: 'COMPLETE',
      stageResults: [
        { stageId: 'PLAN', verdict: 'PASS', retries: 0 },
        { stageId: 'DEV', verdict: 'PASS', retries: 0 },
      ],
    },
    {
      pipelineId: 'standard',
      completedAt: '2026-02-21T09:00:00.000Z',
      durationMs: 120000,
      finalResult: 'COMPLETE',
      stageResults: [
        { stageId: 'PLAN', verdict: 'PASS', retries: 0 },
        { stageId: 'DEV', verdict: 'FAIL', retries: 1 },
      ],
    },
    {
      pipelineId: 'fix',
      completedAt: '2026-02-21T08:00:00.000Z',
      durationMs: 30000,
      finalResult: 'CANCELLED',
      stageResults: [],
    },
  ];

  const summary = summarizeHistory(records);
  assert.ok(summary, '應有統計結果');
  assert.strictEqual(summary.totalPipelines, 3, 'totalPipelines 應為 3');
  assert.strictEqual(summary.avgDurationMs, Math.round((60000 + 120000 + 30000) / 3), 'avgDurationMs 計算正確');
  assert.strictEqual(summary.mostUsedPipeline, 'standard', 'mostUsedPipeline 應為 standard');
});

test('summarizeHistory: successRate 計算（COMPLETE 且無 FAIL）', () => {
  const records = [
    {
      pipelineId: 'standard',
      finalResult: 'COMPLETE',
      stageResults: [{ stageId: 'DEV', verdict: 'PASS', retries: 0 }],
      durationMs: null,
    },
    {
      pipelineId: 'fix',
      finalResult: 'COMPLETE',
      stageResults: [{ stageId: 'DEV', verdict: 'FAIL', retries: 1 }],
      durationMs: null,
    },
    {
      pipelineId: 'quick-dev',
      finalResult: 'CANCELLED',
      stageResults: [],
      durationMs: null,
    },
  ];

  const summary = summarizeHistory(records);
  // 只有第一筆 COMPLETE 且無 FAIL → successRate = 1/3
  assert.ok(Math.abs(summary.successRate - 1 / 3) < 0.001, `successRate 應為 1/3，實際: ${summary.successRate}`);
});

test('summarizeHistory: stageFailRates 計算', () => {
  const records = [
    {
      pipelineId: 'standard',
      finalResult: 'COMPLETE',
      durationMs: null,
      stageResults: [
        { stageId: 'REVIEW', verdict: 'FAIL', retries: 1 },
        { stageId: 'TEST', verdict: 'PASS', retries: 0 },
      ],
    },
    {
      pipelineId: 'standard',
      finalResult: 'COMPLETE',
      durationMs: null,
      stageResults: [
        { stageId: 'REVIEW', verdict: 'PASS', retries: 0 },
        { stageId: 'TEST', verdict: 'PASS', retries: 0 },
      ],
    },
  ];

  const summary = summarizeHistory(records);
  // REVIEW: 1 FAIL / 2 total = 0.5
  assert.ok(Math.abs(summary.stageFailRates.REVIEW - 0.5) < 0.001, `REVIEW fail rate 應為 0.5，實際: ${summary.stageFailRates.REVIEW}`);
  // TEST: 0 FAIL / 2 total = 0
  assert.strictEqual(summary.stageFailRates.TEST, 0, 'TEST fail rate 應為 0');
});

test('summarizeHistory: 單筆記錄', () => {
  const records = [
    {
      pipelineId: 'fix',
      finalResult: 'COMPLETE',
      durationMs: 5000,
      stageResults: [{ stageId: 'DEV', verdict: 'PASS', retries: 0 }],
    },
  ];

  const summary = summarizeHistory(records);
  assert.ok(summary, '應有統計結果');
  assert.strictEqual(summary.totalPipelines, 1);
  assert.strictEqual(summary.mostUsedPipeline, 'fix');
  assert.strictEqual(summary.avgDurationMs, 5000);
});

test('summarizeHistory: 無 durationMs 記錄時 avgDurationMs 為 0', () => {
  const records = [
    { pipelineId: 'fix', finalResult: 'COMPLETE', durationMs: null, stageResults: [] },
    { pipelineId: 'standard', finalResult: 'COMPLETE', durationMs: null, stageResults: [] },
  ];
  const summary = summarizeHistory(records);
  assert.strictEqual(summary.avgDurationMs, 0, 'avgDurationMs 應為 0');
});

// ── 6. 邊界案例補充（Phase 2 自我挑戰） ──

test('recordCompletion: pipelineActive=true 時 finalResult=UNKNOWN', () => {
  cleanupHistory();
  const state = makeState({ pipelineActive: true });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.finalResult, 'UNKNOWN', 'pipelineActive=true 應為 UNKNOWN');
  cleanupHistory();
});

test('recordCompletion: stages 有 null stageInfo 時跳過不崩潰', () => {
  cleanupHistory();
  const state = makeState({
    stages: {
      PLAN: null,
      DEV: { status: 'completed', verdict: 'PASS' },
    },
  });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.ok(Array.isArray(record.stageResults), 'stageResults 應為陣列');
  // null stageInfo 被跳過，只剩 DEV
  assert.strictEqual(record.stageResults.length, 1, '只有有效 stage 被計入');
  assert.strictEqual(record.stageResults[0].stageId, 'DEV');
  cleanupHistory();
});

test('recordCompletion: totalCrashes 正確累加', () => {
  cleanupHistory();
  const state = makeState({
    crashes: { PLAN: 2, DEV: 1 },
  });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.totalCrashes, 3, 'totalCrashes 應為 3（2+1）');
  cleanupHistory();
});

test('recordCompletion: pipelineId 缺失時記為 unknown', () => {
  cleanupHistory();
  const state = makeState({ classification: null });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  assert.strictEqual(record.pipelineId, 'unknown', 'pipelineId 缺失時應為 unknown');
  cleanupHistory();
});

test('recordCompletion: stage verdict 缺失但 status=completed 時推導為 PASS', () => {
  cleanupHistory();
  const state = makeState({
    stages: {
      DEV: { status: 'completed' }, // 無 verdict
    },
  });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  const devStage = record.stageResults.find(s => s.stageId === 'DEV');
  assert.strictEqual(devStage.verdict, 'PASS', 'status=completed 時推導 verdict=PASS');
  cleanupHistory();
});

test('recordCompletion: stage status 為 active 時 verdict 為 null', () => {
  cleanupHistory();
  const state = makeState({
    stages: {
      DEV: { status: 'active' }, // 尚未完成
    },
  });
  recordCompletion(state);
  const record = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8').trim());
  const devStage = record.stageResults.find(s => s.stageId === 'DEV');
  assert.strictEqual(devStage.verdict, null, 'active stage verdict 應為 null');
  cleanupHistory();
});

test('queryHistory: JSONL 最後一行不完整（斷電模擬）時跳過損毀行', () => {
  cleanupHistory();
  const p = getHistoryPath();
  const valid = { pipelineId: 'standard', completedAt: '2026-02-21T10:00:00.000Z', finalResult: 'COMPLETE' };
  // 最後一行不完整（模擬寫入中途斷電）
  fs.writeFileSync(p, JSON.stringify(valid) + '\n{"pipelineId": "fix", "completedAt":', 'utf8');
  const result = queryHistory();
  assert.strictEqual(result.length, 1, '不完整行應跳過，有效記錄應回傳');
  assert.strictEqual(result[0].pipelineId, 'standard');
  cleanupHistory();
});

test('queryHistory: limit=0 不截斷（回傳所有記錄）', () => {
  cleanupHistory();
  for (let i = 0; i < 3; i++) {
    recordCompletion(makeState({ sessionId: `sid-limit0-${i}` }));
  }
  const result = queryHistory({ limit: 0 });
  assert.strictEqual(result.length, 3, 'limit=0 不截斷，應回傳全部 3 筆');
  cleanupHistory();
});

test('queryHistory: since 為無效日期格式時不過濾（容錯）', () => {
  cleanupHistory();
  recordCompletion(makeState({ sessionId: 'sid-since-invalid' }));
  const result = queryHistory({ since: 'not-a-date' });
  // 無效 since → isNaN，不進行過濾 → 回傳所有記錄
  assert.strictEqual(result.length, 1, '無效 since 應容錯，不過濾記錄');
  cleanupHistory();
});

test('truncateHistory: maxRecords=0 時使用預設 MAX_HISTORY_RECORDS', () => {
  cleanupHistory();
  const p = getHistoryPath();
  // 寫 3 筆，若 maxRecords=0 不使用 0（使用預設 100），不截斷
  const records = Array.from({ length: 3 }, (_, i) => ({
    pipelineId: 'standard',
    completedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
    finalResult: 'COMPLETE',
  }));
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  truncateHistory(0); // 無效的 maxRecords，改用預設 100
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 3, 'maxRecords=0 應使用預設 100，3 筆不截斷');
  cleanupHistory();
});

test('truncateHistory: 負數 maxRecords 使用預設 MAX_HISTORY_RECORDS', () => {
  cleanupHistory();
  const p = getHistoryPath();
  const record = { pipelineId: 'standard', completedAt: '2026-02-21T10:00:00.000Z' };
  fs.writeFileSync(p, JSON.stringify(record) + '\n', 'utf8');
  truncateHistory(-5); // 負數使用預設 100，1 筆不截斷
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, '負數 maxRecords 應使用預設 100，記錄保留');
  cleanupHistory();
});

test('truncateHistory: 1000 筆大量記錄截斷保留最新 100', () => {
  cleanupHistory();
  const p = getHistoryPath();
  // 寫入 110 筆（避免 1000 筆耗時太長，但足以驗證截斷行為）
  const records = Array.from({ length: 110 }, (_, i) => ({
    pipelineId: 'standard',
    completedAt: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    finalResult: 'COMPLETE',
    idx: i,
  }));
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  truncateHistory(100); // 截斷保留 100 筆
  const result = queryHistory();
  assert.strictEqual(result.length, 100, '截斷後應剩 100 筆');
  cleanupHistory();
});

test('summarizeHistory: 所有 FAIL 記錄時 successRate=0', () => {
  const records = [
    {
      pipelineId: 'standard',
      finalResult: 'COMPLETE',
      durationMs: null,
      stageResults: [{ stageId: 'DEV', verdict: 'FAIL', retries: 2 }],
    },
    {
      pipelineId: 'fix',
      finalResult: 'CANCELLED',
      durationMs: null,
      stageResults: [],
    },
  ];
  const summary = summarizeHistory(records);
  assert.strictEqual(summary.successRate, 0, 'successRate 應為 0（有 FAIL 的 COMPLETE + CANCELLED）');
});

test('summarizeHistory: stageResults 為 null/undefined 時不崩潰', () => {
  const records = [
    { pipelineId: 'fix', finalResult: 'COMPLETE', durationMs: null, stageResults: null },
    { pipelineId: 'fix', finalResult: 'COMPLETE', durationMs: null },
  ];
  const summary = summarizeHistory(records);
  assert.ok(summary, '應有統計結果，不崩潰');
  assert.strictEqual(summary.totalPipelines, 2);
});

test('summarizeHistory: mostUsedPipeline 有並列時回傳其中之一', () => {
  const records = [
    { pipelineId: 'standard', finalResult: 'COMPLETE', durationMs: null, stageResults: [] },
    { pipelineId: 'fix', finalResult: 'COMPLETE', durationMs: null, stageResults: [] },
  ];
  const summary = summarizeHistory(records);
  assert.ok(
    summary.mostUsedPipeline === 'standard' || summary.mostUsedPipeline === 'fix',
    `並列時 mostUsedPipeline 應為 standard 或 fix，實際: ${summary.mostUsedPipeline}`
  );
});

// ── 結果輸出 ──

console.log('');
console.log(`history-writer.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
