#!/usr/bin/env node
/**
 * Timeline Integration Test
 * 測試 Dashboard 和 Remote 的 Timeline consumer 整合
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { emit, cleanup } = require('../scripts/lib/timeline');
const { createConsumer } = require('../scripts/lib/timeline/consumer');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEST_SESSION_ID = 'test-timeline-integration-' + Date.now();

let passed = 0;
let failed = 0;
require('./test-helpers').cleanTestStateFiles();

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`✓ ${message}`);
  } else {
    failed++;
    console.error(`✗ ${message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('\n=== Timeline Integration Test ===\n');

  // 1. 測試 consumer 建立
  const receivedEvents = [];
  const consumer = createConsumer({
    name: 'test-dashboard',
    types: ['pipeline', 'quality'],
    handlers: {
      '*': (event) => {
        receivedEvents.push(event);
      },
    },
  });

  assert(typeof consumer.start === 'function', 'Consumer 有 start 方法');
  assert(typeof consumer.stop === 'function', 'Consumer 有 stop 方法');
  assert(consumer.isActive() === false, 'Consumer 初始狀態為 inactive');

  // 2. 啟動 consumer（replay: false）
  consumer.start(TEST_SESSION_ID, { replay: false });
  assert(consumer.isActive() === true, 'Consumer 啟動後狀態為 active');

  // 等待 fs.watch 就緒（首次啟動較慢）
  await sleep(200);

  // 3. 發送測試事件（批次發送，最後統一檢查）
  emit('stage.start', TEST_SESSION_ID, { stage: 'PLAN', agent: 'planner' });
  emit('quality.lint', TEST_SESSION_ID, { file: 'test.js', pass: true });
  emit('task.classified', TEST_SESSION_ID, { type: 'feature' });

  // 等待 fs.watch 觸發 + debounce
  await sleep(500);

  assert(receivedEvents.length === 2, '收到 2 個訂閱的事件（stage.start + quality.lint）');
  assert(receivedEvents.some(e => e.type === 'stage.start'), '包含 stage.start 事件');
  assert(receivedEvents.some(e => e.type === 'quality.lint'), '包含 quality.lint 事件');

  // 4. 測試分類過濾（task 事件不應被收到）
  assert(!receivedEvents.some(e => e.type === 'task.classified'), 'task 事件被過濾（未訂閱）');

  // 5. 測試 replay
  consumer.stop();
  assert(consumer.isActive() === false, 'Consumer 停止後狀態為 inactive');

  const replayedEvents = [];
  const consumer2 = createConsumer({
    name: 'test-replay',
    types: ['pipeline', 'quality'],
    handlers: {
      '*': (event) => {
        replayedEvents.push(event);
      },
    },
  });

  consumer2.start(TEST_SESSION_ID, { replay: true });
  await sleep(200);
  assert(replayedEvents.length >= 2, 'Replay 回放歷史事件');

  // 6. 測試 event 格式
  const firstEvent = receivedEvents[0];
  assert(firstEvent.type === 'stage.start', '事件有正確的 type');
  assert(typeof firstEvent.timestamp === 'number', '事件有 timestamp');
  assert(firstEvent.sessionId === TEST_SESSION_ID, '事件有正確的 sessionId');
  assert(typeof firstEvent.data === 'object', '事件有 data 物件');

  // 7. 測試 stats
  const stats = consumer2.getStats();
  assert(stats.name === 'test-replay', 'Stats 有 consumer 名稱');
  assert(typeof stats.eventsReceived === 'number', 'Stats 有事件計數');

  // 清理
  consumer2.stop();
  cleanup(TEST_SESSION_ID);

  // 移除 timeline 檔案
  const timelinePath = path.join(CLAUDE_DIR, `timeline-${TEST_SESSION_ID}.jsonl`);
  try { fs.unlinkSync(timelinePath); } catch (_) {}

  console.log(`\n=== 測試結果 ===`);
  console.log(`通過: ${passed}`);
  console.log(`失敗: ${failed}`);
  console.log(failed === 0 ? '✅ 所有測試通過' : '❌ 有測試失敗');
  process.exit(failed === 0 ? 0 : 1);
}

test().catch(err => {
  console.error('測試執行錯誤:', err);
  process.exit(1);
});
