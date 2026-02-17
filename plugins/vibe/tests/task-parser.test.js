#!/usr/bin/env node
/**
 * task-parser.test.js — 測試 lib/task-parser.js 純函式模組
 *
 * 驗證 reconstructTasks / extractPromise / getIncompleteTasks 的獨立行為。
 * 與 task-guard.test.js 互補：task-guard 測整體 hook 行為，這裡測純函式邏輯。
 *
 * 執行：node plugins/vibe/tests/task-parser.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { reconstructTasks, extractPromise, getIncompleteTasks } = require(path.join(__dirname, '..', 'scripts', 'lib', 'task-parser.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u274c ${name}`);
    console.log(`     ${err.message}`);
  }
}

// --- 輔助函式 ---

function mkLine(type, role, content) {
  return JSON.stringify({ type, message: { role, content } });
}

function mkTaskCreate(id, subject) {
  return mkLine('assistant', 'assistant', [
    { type: 'tool_use', id, name: 'TaskCreate', input: { subject } },
  ]);
}

function mkTaskCreateResult(toolUseId, taskId, subject) {
  return mkLine('user', 'user', [
    { type: 'tool_result', tool_use_id: toolUseId, content: `Task #${taskId} created successfully: ${subject}` },
  ]);
}

function mkTaskUpdate(id, taskId, status) {
  return mkLine('assistant', 'assistant', [
    { type: 'tool_use', id, name: 'TaskUpdate', input: { taskId: String(taskId), status } },
  ]);
}

function mkText(text) {
  return mkLine('assistant', 'assistant', [{ type: 'text', text }]);
}

// ===================================================
console.log('\n\ud83e\uddea task-parser: reconstructTasks');
// ===================================================

test('空行陣列 → 空物件', () => {
  assert.deepStrictEqual(reconstructTasks([]), {});
});

test('無任務相關 tool_use → 空物件', () => {
  const lines = [
    mkLine('assistant', 'assistant', [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]),
  ];
  assert.deepStrictEqual(reconstructTasks(lines), {});
});

test('TaskCreate + result → 正確重建', () => {
  const lines = [
    mkTaskCreate('tu-1', '建立元件'),
    mkTaskCreateResult('tu-1', 1, '建立元件'),
  ];
  const tasks = reconstructTasks(lines);
  assert.deepStrictEqual(tasks, { '1': { subject: '建立元件', status: 'pending' } });
});

test('TaskUpdate 更新狀態', () => {
  const lines = [
    mkTaskCreate('tu-1', '任務 A'),
    mkTaskCreateResult('tu-1', 1, '任務 A'),
    mkTaskUpdate('tu-2', 1, 'in_progress'),
    mkTaskUpdate('tu-3', 1, 'completed'),
  ];
  const tasks = reconstructTasks(lines);
  assert.strictEqual(tasks['1'].status, 'completed');
});

test('多任務重建', () => {
  const lines = [
    mkTaskCreate('tu-1', '任務 A'),
    mkTaskCreateResult('tu-1', 1, '任務 A'),
    mkTaskCreate('tu-2', '任務 B'),
    mkTaskCreateResult('tu-2', 2, '任務 B'),
    mkTaskUpdate('tu-3', 1, 'completed'),
  ];
  const tasks = reconstructTasks(lines);
  assert.strictEqual(Object.keys(tasks).length, 2);
  assert.strictEqual(tasks['1'].status, 'completed');
  assert.strictEqual(tasks['2'].status, 'pending');
});

test('只有 TaskUpdate 無 Create → 自動建立', () => {
  const lines = [
    mkTaskUpdate('tu-1', 5, 'in_progress'),
  ];
  const tasks = reconstructTasks(lines);
  assert.strictEqual(tasks['5'].subject, 'Task #5');
  assert.strictEqual(tasks['5'].status, 'in_progress');
});

test('無效 JSON 行被忽略', () => {
  const lines = [
    'invalid json',
    '',
    mkTaskCreate('tu-1', '任務'),
    mkTaskCreateResult('tu-1', 1, '任務'),
  ];
  const tasks = reconstructTasks(lines);
  assert.strictEqual(Object.keys(tasks).length, 1);
});

test('tool_result 陣列格式', () => {
  const lines = [
    mkTaskCreate('tu-1', '任務'),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: [{ type: 'text', text: 'Task #1 created successfully: 任務' }],
        }],
      },
    }),
  ];
  const tasks = reconstructTasks(lines);
  assert.strictEqual(tasks['1'].subject, '任務');
});

// ===================================================
console.log('\n\ud83e\uddea task-parser: extractPromise');
// ===================================================

test('無 assistant 訊息 → null', () => {
  assert.strictEqual(extractPromise([]), null);
});

test('最後 assistant 無 promise → null', () => {
  const lines = [mkText('完成了')];
  assert.strictEqual(extractPromise(lines), null);
});

test('精確提取 promise 內容', () => {
  const lines = [mkText('<promise>ALL_TASKS_COMPLETE</promise>')];
  assert.strictEqual(extractPromise(lines), 'ALL_TASKS_COMPLETE');
});

test('多行文字中的 promise', () => {
  const lines = [mkText('摘要如下\n\n<promise>ALL_TASKS_COMPLETE</promise>\n\n完畢')];
  assert.strictEqual(extractPromise(lines), 'ALL_TASKS_COMPLETE');
});

test('空白正規化', () => {
  const lines = [mkText('<promise>  ALL_TASKS_COMPLETE  </promise>')];
  assert.strictEqual(extractPromise(lines), 'ALL_TASKS_COMPLETE');
});

test('只看最後一個 assistant', () => {
  const lines = [
    mkText('<promise>ALL_TASKS_COMPLETE</promise>'),
    mkText('還在工作中'),
  ];
  assert.strictEqual(extractPromise(lines), null);
});

test('非 assistant 訊息被跳過', () => {
  const lines = [
    mkLine('user', 'user', [{ type: 'text', text: '<promise>ALL_TASKS_COMPLETE</promise>' }]),
  ];
  assert.strictEqual(extractPromise(lines), null);
});

// ===================================================
console.log('\n\ud83e\uddea task-parser: getIncompleteTasks');
// ===================================================

test('空物件 → 空陣列', () => {
  assert.deepStrictEqual(getIncompleteTasks({}), []);
});

test('全部完成 → 空陣列', () => {
  const tasks = { '1': { subject: 'A', status: 'completed' } };
  assert.deepStrictEqual(getIncompleteTasks(tasks), []);
});

test('已刪除 → 不算未完成', () => {
  const tasks = { '1': { subject: 'A', status: 'deleted' } };
  assert.deepStrictEqual(getIncompleteTasks(tasks), []);
});

test('pending → 未完成', () => {
  const tasks = { '1': { subject: 'A', status: 'pending' } };
  const result = getIncompleteTasks(tasks);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, '1');
  assert.strictEqual(result[0].subject, 'A');
});

test('in_progress → 未完成', () => {
  const tasks = { '1': { subject: 'A', status: 'in_progress' } };
  assert.strictEqual(getIncompleteTasks(tasks).length, 1);
});

test('混合狀態篩選', () => {
  const tasks = {
    '1': { subject: 'A', status: 'completed' },
    '2': { subject: 'B', status: 'pending' },
    '3': { subject: 'C', status: 'deleted' },
    '4': { subject: 'D', status: 'in_progress' },
  };
  const result = getIncompleteTasks(tasks);
  assert.strictEqual(result.length, 2);
  const ids = result.map(t => t.id).sort();
  assert.deepStrictEqual(ids, ['2', '4']);
});

// ===================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  console.log('\u274c 有測試失敗\n');
  process.exit(1);
} else {
  console.log('\u2705 全部通過\n');
}
