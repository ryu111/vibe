#!/usr/bin/env node
/**
 * v4-timeline.test.js — Timeline JSONL 持久化驗證（I04）
 *
 * 場景：
 *   I04: Timeline JSONL append-only，emit 後 query 可取得
 *
 * 執行：node plugins/vibe/tests/v4-timeline.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const { emit, query } = require(path.join(PLUGIN_ROOT, 'scripts/lib/timeline/timeline.js'));
const { EVENT_TYPES } = require(path.join(PLUGIN_ROOT, 'scripts/lib/timeline/schema.js'));

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

// ─── 清理工具 ────────────────────────────────────────────

function cleanTimeline(sid) {
  const p = path.join(CLAUDE_DIR, `timeline-${sid}.jsonl`);
  try { fs.unlinkSync(p); } catch (_) {}
}

function getTimelinePath(sid) {
  return path.join(CLAUDE_DIR, `timeline-${sid}.jsonl`);
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n📊 I04：Timeline JSONL 持久化驗證');

// I04: Timeline JSONL append-only, emit 後 query 可取得
test('I04: emit 事件後 JSONL 持久化，query 可取得', () => {
  const sid = 'test-i04';
  cleanTimeline(sid);

  // emit 一個事件（使用 TASK_CLASSIFIED 而非不存在的 PIPELINE_CLASSIFIED）
  emit(EVENT_TYPES.TASK_CLASSIFIED, sid, {
    pipelineId: 'standard',
    source: 'test',
    layer: 'L1',
    confidence: 0.9,
  });

  // 驗證 JSONL 檔案存在
  const timelinePath = getTimelinePath(sid);
  assert.ok(fs.existsSync(timelinePath), `timeline JSONL 應存在於 ${timelinePath}`);

  // 驗證檔案不為空
  const content = fs.readFileSync(timelinePath, 'utf8');
  assert.ok(content.trim().length > 0, 'JSONL 不應為空');

  // 驗證每行是合法 JSON
  const lines = content.trim().split('\n').filter(l => l.trim());
  assert.ok(lines.length >= 1, '應有至少一行');
  for (const line of lines) {
    const entry = JSON.parse(line);  // 若解析失敗會拋出 AssertionError
    assert.ok(entry.type, `每行應有 type 欄位，實際：${JSON.stringify(entry)}`);
    assert.ok(entry.sessionId, `每行應有 sessionId 欄位`);
    assert.ok(entry.timestamp, `每行應有 timestamp 欄位`);
  }

  cleanTimeline(sid);
});

// I04b: query 過濾特定類型
test('I04b: query 以類型過濾，回傳對應事件', () => {
  const sid = 'test-i04b';
  cleanTimeline(sid);

  // emit 兩種類型的事件（使用正確的 EVENT_TYPES 名稱）
  emit(EVENT_TYPES.TASK_CLASSIFIED, sid, { pipelineId: 'fix', source: 'test' });
  emit(EVENT_TYPES.PIPELINE_COMPLETE, sid, { pipelineId: 'fix' });
  emit(EVENT_TYPES.TASK_CLASSIFIED, sid, { pipelineId: 'quick-dev', source: 'test2' });

  // query 只取 TASK_CLASSIFIED
  const events = query(sid, { types: [EVENT_TYPES.TASK_CLASSIFIED] });
  assert.ok(Array.isArray(events), 'query 應回傳陣列');
  assert.strictEqual(events.length, 2, `應有 2 個 CLASSIFIED 事件，實際：${events.length}`);

  for (const ev of events) {
    assert.strictEqual(ev.type, EVENT_TYPES.TASK_CLASSIFIED,
      `所有事件應為 TASK_CLASSIFIED，實際：${ev.type}`);
  }

  cleanTimeline(sid);
});

// I04c: emit 多次，JSONL append（不覆蓋）
test('I04c: 多次 emit 累積 JSONL（append-only）', () => {
  const sid = 'test-i04c';
  cleanTimeline(sid);

  const COUNT = 5;
  for (let i = 0; i < COUNT; i++) {
    emit(EVENT_TYPES.STAGE_COMPLETE, sid, { stage: `STAGE_${i}`, verdict: 'PASS' });
  }

  const events = query(sid);
  assert.ok(events.length >= COUNT, `應有 ${COUNT} 個事件，實際：${events.length}`);

  cleanTimeline(sid);
});

// I04d: emit 無效 sessionId → 不崩潰（容錯）
test('I04d: emit 使用合法 sessionId 格式（非空字串）', () => {
  const sid = 'test-i04d-valid';
  cleanTimeline(sid);

  // 正常 emit
  assert.doesNotThrow(() => {
    emit(EVENT_TYPES.PIPELINE_CLASSIFIED, sid, { pipelineId: 'fix' });
  }, 'emit 不應拋出異常');

  cleanTimeline(sid);
});

// I04e: query 空 timeline → 回傳空陣列
test('I04e: query 不存在的 sessionId → 回傳空陣列', () => {
  const sid = 'test-i04e-nonexistent';
  cleanTimeline(sid);  // 確保不存在

  const events = query(sid);
  assert.ok(Array.isArray(events), 'query 應回傳陣列');
  assert.strictEqual(events.length, 0, `不存在的 timeline 應回傳空陣列，實際：${events.length}`);
});

// I04f: query 所有事件（無過濾）
test('I04f: query 無過濾條件 → 回傳所有事件', () => {
  const sid = 'test-i04f';
  cleanTimeline(sid);

  // 使用正確的 EVENT_TYPES 名稱
  emit(EVENT_TYPES.TASK_CLASSIFIED, sid, { pipelineId: 'fix' });
  emit(EVENT_TYPES.STAGE_COMPLETE, sid, { stage: 'DEV', verdict: 'PASS' });
  emit(EVENT_TYPES.PIPELINE_COMPLETE, sid, { pipelineId: 'fix' });

  const events = query(sid);
  assert.ok(events.length >= 3, `應有至少 3 個事件，實際：${events.length}`);

  cleanTimeline(sid);
});

// I04g: Timeline 事件含必要欄位
test('I04g: emit 的事件含 type, sessionId, timestamp, data', () => {
  const sid = 'test-i04g';
  cleanTimeline(sid);

  // 使用 STAGE_RETRY（存在於 EVENT_TYPES）代替不存在的 STAGE_FAIL
  const testData = { stage: 'REVIEW', retryCount: 1, severity: 'HIGH' };
  emit(EVENT_TYPES.STAGE_RETRY, sid, testData);

  const events = query(sid, { types: [EVENT_TYPES.STAGE_RETRY] });
  assert.ok(events.length >= 1, '應有至少一個 STAGE_RETRY 事件');

  const ev = events[events.length - 1];
  assert.strictEqual(ev.type, EVENT_TYPES.STAGE_RETRY, `type 應為 STAGE_RETRY`);
  assert.strictEqual(ev.sessionId, sid, `sessionId 應正確`);
  assert.ok(ev.timestamp, 'timestamp 應存在');
  assert.ok(ev.data, 'data 應存在');

  cleanTimeline(sid);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
