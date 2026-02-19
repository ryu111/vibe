#!/usr/bin/env node
/**
 * timeline.test.js — Timeline 模組單元測試
 *
 * 涵蓋：schema 驗證、emit→query round-trip、queryLast、
 * watch 差量觸發、consumer lifecycle、truncation、cleanup
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  EVENT_TYPES, CATEGORIES, VALID_TYPES,
  createEnvelope, validate, getTypesByCategory,
  emit, query, queryLast, watch, cleanup, listSessions, getPath, MAX_EVENTS,
  createConsumer,
} = require('../scripts/lib/timeline');

// ── 測試框架 ────────────────────────────────────────
let passed = 0;
let failed = 0;
require('./test-helpers').cleanTestStateFiles();
function assert(condition, label) {
  if (condition) {
    console.log(`  \u2705 ${label}`);
    passed++;
  } else {
    console.log(`  \u274C ${label}`);
    failed++;
  }
}
function section(title) {
  console.log(`\n\uD83E\uDDEA ${title}`);
}

// ── 測試用 sessionId（避免影響真實資料） ──────────────
const TEST_SESSION = `test-timeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function cleanupTestFile() {
  try {
    const p = getPath(TEST_SESSION);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════
// Part 1: Schema
// ══════════════════════════════════════════════════════
section('Part 1: Schema — 事件類型與 envelope');

// 1.1 EVENT_TYPES 完整性
assert(Object.keys(EVENT_TYPES).length === 32, 'EVENT_TYPES 有 32 種事件（移除 PIPELINE_ABORTED）');

// 1.2 CATEGORIES 覆蓋所有事件
const allCatTypes = Object.values(CATEGORIES).flat();
assert(new Set(allCatTypes).size === 32, 'CATEGORIES 涵蓋全部 32 種事件（去重後，移除 PIPELINE_ABORTED）');

// 1.3 CATEGORIES 和 EVENT_TYPES 一致
const allEventValues = new Set(Object.values(EVENT_TYPES));
const allCatSet = new Set(allCatTypes);
assert(
  allEventValues.size === allCatSet.size &&
  [...allEventValues].every(v => allCatSet.has(v)),
  'CATEGORIES 與 EVENT_TYPES 值完全對齊'
);

// 1.4 VALID_TYPES 是 Set
assert(VALID_TYPES instanceof Set && VALID_TYPES.size === 32, 'VALID_TYPES 是 32 元素 Set（移除 PIPELINE_ABORTED）');

// 1.5 createEnvelope
const env = createEnvelope('session.start', 'sess-1', { foo: 'bar' });
assert(typeof env.id === 'string' && env.id.length > 0, 'createEnvelope 產生 id');
assert(env.type === 'session.start', 'createEnvelope 設定 type');
assert(env.sessionId === 'sess-1', 'createEnvelope 設定 sessionId');
assert(typeof env.timestamp === 'number' && env.timestamp > 0, 'createEnvelope 設定 timestamp');
assert(env.data.foo === 'bar', 'createEnvelope 設定 data');

// 1.6 createEnvelope 預設 data
const env2 = createEnvelope('task.classified', 'sess-2');
assert(typeof env2.data === 'object' && Object.keys(env2.data).length === 0, 'createEnvelope 預設空 data');

// 1.7 validate 正常 envelope
assert(validate(env).valid === true, 'validate 正常 envelope');

// 1.8 validate 各種錯誤
assert(validate(null).valid === false, 'validate null');
assert(validate({}).valid === false, 'validate 缺 id');
assert(validate({ id: 'x', type: 'invalid.type', sessionId: 's', timestamp: 1, data: {} }).valid === false, 'validate 無效 type');
assert(validate({ id: 'x', type: 'session.start', sessionId: '', timestamp: 1, data: {} }).valid === false, 'validate 空 sessionId');
assert(validate({ id: 'x', type: 'session.start', sessionId: 's', timestamp: -1, data: {} }).valid === false, 'validate 無效 timestamp');
assert(validate({ id: 'x', type: 'session.start', sessionId: 's', timestamp: 1, data: 'str' }).valid === false, 'validate data 非物件');

// 1.9 getTypesByCategory
assert(getTypesByCategory('pipeline').length === 13, 'pipeline 分類有 13 種事件（移除 pipeline.aborted）');
assert(getTypesByCategory('nonexist').length === 0, '不存在的分類回傳空陣列');

// ── 目標 5：Timeline 新事件類型 ────────────────────
section('目標 5：Timeline 新事件類型驗證');

// 5.A EVENT_TYPES 總數為 32（移除 PIPELINE_ABORTED）
assert(Object.keys(EVENT_TYPES).length === 32, 'EVENT_TYPES 總數應為 32');

// 5.B CATEGORIES 為 7 個分類
assert(Object.keys(CATEGORIES).length === 7, 'CATEGORIES 應有 7 個分類（session/task/agent/pipeline/quality/remote/safety）');

// 5.C PIPELINE_CANCELLED 事件類型存在
assert(EVENT_TYPES.PIPELINE_CANCELLED === 'pipeline.cancelled', 'PIPELINE_CANCELLED 值應為 pipeline.cancelled');

// 5.D TRANSCRIPT_LEAK_WARNING 事件類型存在
assert(EVENT_TYPES.TRANSCRIPT_LEAK_WARNING === 'safety.transcript-leak', 'TRANSCRIPT_LEAK_WARNING 值應為 safety.transcript-leak');

// 5.E pipeline 分類包含 pipeline.cancelled
assert(
  CATEGORIES.pipeline.includes('pipeline.cancelled'),
  'pipeline 分類應包含 pipeline.cancelled'
);

// 5.F safety 分類包含 safety.transcript-leak
assert(
  CATEGORIES.safety.includes('safety.transcript-leak'),
  'safety 分類應包含 safety.transcript-leak'
);

// 5.G safety 分類包含正確的事件類型（agent.crash + safety.transcript-leak，已移除 pipeline.aborted）
assert(CATEGORIES.safety.includes('agent.crash'), 'safety 分類應包含 agent.crash');
assert(!CATEGORIES.safety.includes('pipeline.aborted'), 'safety 分類不應包含 pipeline.aborted（已移除）');
assert(CATEGORIES.safety.length === 4, 'safety 分類應有 4 個事件類型（移除 pipeline.aborted 後）');

// 5.H VALID_TYPES 包含新事件類型
assert(VALID_TYPES.has('pipeline.cancelled'), 'VALID_TYPES 應包含 pipeline.cancelled');
assert(VALID_TYPES.has('safety.transcript-leak'), 'VALID_TYPES 應包含 safety.transcript-leak');

// 5.I validate 新事件類型
const pipelineCancelledEnv = createEnvelope('pipeline.cancelled', 'test-sess', { reason: '使用者取消' });
assert(validate(pipelineCancelledEnv).valid === true, 'pipeline.cancelled envelope 應通過 validate');

const transcriptLeakEnv = createEnvelope('safety.transcript-leak', 'test-sess', { source: 'remote-hub' });
assert(validate(transcriptLeakEnv).valid === true, 'safety.transcript-leak envelope 應通過 validate');

// 5.J formatEventText 測試（需要引入 formatter）
const { formatEventText, EMOJI_MAP } = require('../scripts/lib/timeline/formatter.js');

// PIPELINE_CANCELLED 格式化
const cancelledEvent = {
  type: 'pipeline.cancelled',
  data: { reason: '使用者主動取消' },
};
const cancelledText = formatEventText(cancelledEvent);
assert(cancelledText.includes('Pipeline 已取消'), `pipeline.cancelled 格式化應包含「Pipeline 已取消」，得到：${cancelledText}`);

// PIPELINE_CANCELLED 無 reason
const cancelledNoReason = { type: 'pipeline.cancelled', data: {} };
assert(formatEventText(cancelledNoReason) === 'Pipeline 已取消', '無 reason 時應輸出「Pipeline 已取消」');

// TRANSCRIPT_LEAK_WARNING 格式化
const leakEvent = {
  type: 'safety.transcript-leak',
  data: { detail: 'found secret key', source: 'remote-hub' },
};
const leakText = formatEventText(leakEvent);
assert(leakText.includes('Transcript 洩漏警告'), `safety.transcript-leak 格式化應包含「Transcript 洩漏警告」，得到：${leakText}`);
assert(leakText.includes('found secret key') || leakText.includes('remote-hub'), '格式化應包含 detail 或 source');

// TRANSCRIPT_LEAK_WARNING 無 detail，用 source
const leakNoDetail = { type: 'safety.transcript-leak', data: { source: 'bot.js' } };
const leakNoDetailText = formatEventText(leakNoDetail);
assert(leakNoDetailText.includes('bot.js'), `無 detail 時應使用 source，得到：${leakNoDetailText}`);

// 5.K EMOJI_MAP 包含新事件的 emoji
assert(EMOJI_MAP['pipeline.cancelled'] === '🚫', `pipeline.cancelled emoji 應為 🚫，得到：${EMOJI_MAP['pipeline.cancelled']}`);
assert(EMOJI_MAP['safety.transcript-leak'] === '🔐', `safety.transcript-leak emoji 應為 🔐，得到：${EMOJI_MAP['safety.transcript-leak']}`);

// 5.L getTypesByCategory('safety') 回傳 4 個事件（移除 pipeline.aborted，含 barrier.crash-guard + stage.crash-recovery）
assert(getTypesByCategory('safety').length === 4, 'safety 分類應有 4 個事件類型（移除 pipeline.aborted 後）');

// ══════════════════════════════════════════════════════
// Part 2: Timeline — emit / query / queryLast
// ══════════════════════════════════════════════════════
section('Part 2: Timeline — emit / query / queryLast');
cleanupTestFile();

// 2.1 emit 回傳 envelope
const e1 = emit(EVENT_TYPES.SESSION_START, TEST_SESSION, { env: 'node' });
assert(e1 !== null && e1.type === 'session.start', 'emit 回傳 envelope');

// 2.2 emit 無效 type 回傳 null
const e2 = emit('invalid.type', TEST_SESSION, {});
assert(e2 === null, 'emit 無效 type 回傳 null');

// 2.3 JSONL 檔案存在
assert(fs.existsSync(getPath(TEST_SESSION)), 'emit 建立 JSONL 檔案');

// 2.4 query 回傳正確事件
const events = query(TEST_SESSION);
assert(events.length === 1, 'query 回傳 1 筆事件');
assert(events[0].type === 'session.start', 'query 事件 type 正確');
assert(events[0].data.env === 'node', 'query 事件 data 正確');

// 2.5 多筆 emit + query
emit(EVENT_TYPES.TASK_CLASSIFIED, TEST_SESSION, { taskType: 'feature' });
emit(EVENT_TYPES.STAGE_COMPLETE, TEST_SESSION, { stage: 'PLAN', verdict: 'PASS' });
emit(EVENT_TYPES.STAGE_COMPLETE, TEST_SESSION, { stage: 'ARCH', verdict: 'PASS' });
const all = query(TEST_SESSION);
assert(all.length === 4, 'query 回傳全部 4 筆');

// 2.6 query types 過濾
const stageOnly = query(TEST_SESSION, { types: ['stage.complete'] });
assert(stageOnly.length === 2, 'query types 過濾正確');

// 2.7 query since 過濾（用第一筆的 timestamp - 1 確保能捕獲後續事件）
const sinceTs = all[0].timestamp - 1;
const afterFirst = query(TEST_SESSION, { since: sinceTs });
assert(afterFirst.length === 4, 'query since 過濾正確（timestamp-1 回傳全部 4 筆）');

// 2.8 query limit
const limited = query(TEST_SESSION, { limit: 2 });
assert(limited.length === 2, 'query limit 正確');

// 2.9 query offset + limit
const paged = query(TEST_SESSION, { offset: 1, limit: 2 });
assert(paged.length === 2 && paged[0].type === 'task.classified', 'query offset+limit 正確');

// 2.10 queryLast
const last = queryLast(TEST_SESSION, 'stage.complete');
assert(last !== null && last.data.stage === 'ARCH', 'queryLast 回傳最後一筆 stage.complete');

// 2.11 queryLast 不存在的 type
const noLast = queryLast(TEST_SESSION, 'pipeline.complete');
assert(noLast === null, 'queryLast 不存在的 type 回傳 null');

// 2.12 queryLast 不存在的 session
const noSession = queryLast('nonexist-session', 'session.start');
assert(noSession === null, 'queryLast 不存在的 session 回傳 null');

// ══════════════════════════════════════════════════════
// Part 3~5 需要 await，用 async IIFE 包裹
// ══════════════════════════════════════════════════════
(async () => {

// ── Part 3: Timeline — watch（差量觸發） ─────────────
section('Part 3: Timeline — watch 差量觸發');
cleanupTestFile();

// 用 Promise 包裝 watch callback
const watchResult = new Promise((resolve) => {
  const received = [];
  const handle = watch(TEST_SESSION, (events) => {
    received.push(...events);
    if (received.length >= 2) {
      handle.stop();
      resolve(received);
    }
  });

  // 延遲寫入（讓 watch 先啟動）
  setTimeout(() => {
    emit(EVENT_TYPES.TASK_CLASSIFIED, TEST_SESSION, { taskType: 'bugfix' });
    emit(EVENT_TYPES.STAGE_START, TEST_SESSION, { stage: 'DEV' });
  }, 100);
});

// 等待 watch 結果（最多 3 秒）
const watchTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
const watchEvents = await Promise.race([watchResult, watchTimeout]);

assert(watchEvents !== null, 'watch 在 3 秒內收到事件');
if (watchEvents) {
  assert(watchEvents.length >= 2, `watch 收到 ${watchEvents.length} 筆事件`);
  assert(watchEvents[0].type === 'task.classified', 'watch 第一筆 type 正確');
  assert(watchEvents[1].type === 'stage.start', 'watch 第二筆 type 正確');
}

// 3.2 watch with types filter
cleanupTestFile();
const filteredResult = new Promise((resolve) => {
  const received = [];
  const handle = watch(TEST_SESSION, (events) => {
    received.push(...events);
    handle.stop();
    resolve(received);
  }, { types: ['stage.complete'] });

  setTimeout(() => {
    emit(EVENT_TYPES.TASK_CLASSIFIED, TEST_SESSION, { taskType: 'feature' });
    emit(EVENT_TYPES.STAGE_COMPLETE, TEST_SESSION, { stage: 'PLAN' });
  }, 100);
});

const filteredTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
const filteredEvents = await Promise.race([filteredResult, filteredTimeout]);

if (filteredEvents) {
  assert(filteredEvents.length === 1, 'watch types 過濾只收到 stage.complete');
  assert(filteredEvents[0].type === 'stage.complete', 'watch 過濾後 type 正確');
} else {
  assert(false, 'watch types 過濾超時');
}

// ══════════════════════════════════════════════════════
// Part 4: Timeline — cleanup / listSessions
// ══════════════════════════════════════════════════════
section('Part 4: Timeline — cleanup / listSessions');

// 4.1 listSessions 包含測試 session
emit(EVENT_TYPES.SESSION_START, TEST_SESSION, {});
const sessions = listSessions();
assert(sessions.includes(TEST_SESSION), 'listSessions 包含測試 session');

// 4.2 cleanup
const cleanResult = cleanup(TEST_SESSION);
assert(cleanResult === true, 'cleanup 回傳 true');
assert(!fs.existsSync(getPath(TEST_SESSION)), 'cleanup 刪除 JSONL 檔案');

// 4.3 cleanup 不存在的 session
assert(cleanup('nonexist') === true, 'cleanup 不存在的 session 也回傳 true');

// 4.4 query 不存在的檔案
assert(query('nonexist').length === 0, 'query 不存在的 session 回傳空陣列');

// ══════════════════════════════════════════════════════
// Part 5: Consumer — createConsumer lifecycle
// ══════════════════════════════════════════════════════
section('Part 5: Consumer — createConsumer lifecycle');
cleanupTestFile();

// 5.1 基本建立
const received = [];
const errors = [];
const consumer = createConsumer({
  name: 'test-consumer',
  types: ['pipeline'],
  handlers: {
    'stage.complete': (event) => received.push(event),
    '*': () => {},  // 萬用不重複推
  },
  onError: (name, err) => errors.push({ name, err }),
});

assert(consumer.isActive() === false, 'consumer 初始未啟動');

// 5.2 start + emit
consumer.start(TEST_SESSION);
assert(consumer.isActive() === true, 'consumer.start() 後 isActive=true');

// 等一下讓 watch 啟動
await new Promise(r => setTimeout(r, 100));

emit(EVENT_TYPES.STAGE_COMPLETE, TEST_SESSION, { stage: 'PLAN' });
emit(EVENT_TYPES.TASK_CLASSIFIED, TEST_SESSION, { taskType: 'feature' }); // 不在 pipeline 分類
emit(EVENT_TYPES.STAGE_COMPLETE, TEST_SESSION, { stage: 'ARCH' });

// 等 watch debounce
await new Promise(r => setTimeout(r, 200));

assert(received.length === 2, `consumer 只收到 pipeline 類事件（${received.length} 筆）`);
assert(received[0].data.stage === 'PLAN', 'consumer 第一筆 stage=PLAN');
assert(received[1].data.stage === 'ARCH', 'consumer 第二筆 stage=ARCH');

// 5.3 stats
const stats = consumer.getStats();
assert(stats.name === 'test-consumer', 'stats.name 正確');
assert(stats.eventsReceived >= 2, `stats.eventsReceived >= 2（${stats.eventsReceived}）`);

// 5.4 stop
consumer.stop();
assert(consumer.isActive() === false, 'consumer.stop() 後 isActive=false');

// 5.5 分類展開
const consumer2 = createConsumer({
  name: 'test-quality',
  types: ['quality', 'stage.complete'],  // 混合分類名 + 具體事件
  handlers: { '*': () => {} },
});
// quality 分類有 5 個 + stage.complete 1 個 = 6 個 types
// 無法直接驗證內部 types，但驗證啟動不報錯
consumer2.start(TEST_SESSION);
assert(consumer2.isActive() === true, '混合分類+具體事件 consumer 正常啟動');
consumer2.stop();

// 5.6 replay 模式
const replayReceived = [];
const replayConsumer = createConsumer({
  name: 'test-replay',
  types: ['pipeline'],
  handlers: {
    'stage.complete': (event) => replayReceived.push(event),
  },
});
replayConsumer.start(TEST_SESSION, { replay: true });
// replay 應該讀到之前寫入的 2 筆 stage.complete
assert(replayReceived.length === 2, `replay 收到歷史 pipeline 事件（${replayReceived.length} 筆）`);
replayConsumer.stop();

// 5.7 錯誤隔離（重置 timeline 檔案避免 fs.watch 殘留狀態）
cleanupTestFile();
const errorConsumer = createConsumer({
  name: 'test-error',
  handlers: {
    'session.start': () => { throw new Error('test error'); },
  },
  onError: (name, err) => errors.push({ name, msg: err.message }),
});
errorConsumer.start(TEST_SESSION);
await new Promise(r => setTimeout(r, 300));
emit(EVENT_TYPES.SESSION_START, TEST_SESSION, {});
await new Promise(r => setTimeout(r, 500));
errorConsumer.stop();
assert(errors.some(e => e.msg === 'test error'), '錯誤被 onError 捕獲（不影響其他 handler）');

// ══════════════════════════════════════════════════════
// 清理 + 結果
// ══════════════════════════════════════════════════════
cleanupTestFile();

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('\u2705 全部通過\n');
} else {
  console.log('\u274C 有失敗的測試\n');
  process.exit(1);
}

})().catch(err => {
  console.error('測試執行錯誤:', err);
  process.exit(1);
});
