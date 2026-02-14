#!/usr/bin/env node
/**
 * task-guard.test.js — 測試 task-guard Stop hook 的任務檢測和阻擋邏輯
 *
 * 使用真實 ECC transcript JSONL 格式建立 mock 資料，
 * 驗證 TaskCreate/TaskUpdate 解析、狀態重建、阻擋機制。
 *
 * 執行：bun test plugins/vibe/tests/task-guard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'task-guard.js');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TMP_DIR = path.join(os.tmpdir(), 'task-guard-test-' + Date.now());

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

// --- Mock transcript JSONL 建構工具 ---

function mkTranscriptLine(type, role, content) {
  return JSON.stringify({
    type,
    message: { role, content },
  });
}

function mkTaskCreate(toolUseId, subject, description) {
  return mkTranscriptLine('assistant', 'assistant', [
    { type: 'tool_use', id: toolUseId, name: 'TaskCreate', input: { subject, description } },
  ]);
}

function mkTaskCreateResult(toolUseId, taskId, subject) {
  return mkTranscriptLine('user', 'user', [
    { type: 'tool_result', tool_use_id: toolUseId, content: `Task #${taskId} created successfully: ${subject}` },
  ]);
}

function mkTaskUpdate(toolUseId, taskId, status) {
  return mkTranscriptLine('assistant', 'assistant', [
    { type: 'tool_use', id: toolUseId, name: 'TaskUpdate', input: { taskId: String(taskId), status } },
  ]);
}

function mkTaskUpdateResult(toolUseId, taskId) {
  return mkTranscriptLine('user', 'user', [
    { type: 'tool_result', tool_use_id: toolUseId, content: `Updated task #${taskId} status` },
  ]);
}

function writeTranscript(lines) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

function writeState(sessionId, state) {
  const p = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function cleanState(sessionId) {
  const p = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);
  try { fs.unlinkSync(p); } catch (_) {}
}

function runHook(stdinData) {
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData)}' | node "${HOOK_SCRIPT}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    );
    return { exitCode: 0, stdout: stdout.toString().trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

// ===================================================
console.log('\n\ud83e\uddea task-guard: \u653e\u884c\u5834\u666f\uff08\u7121\u4efb\u52d9 / \u5168\u90e8\u5b8c\u6210\uff09');
// ===================================================

test('\u653e\u884c \u2014 \u7121 transcript', () => {
  const sessionId = 'tg-test-1';
  cleanState(sessionId);
  const result = runHook({ session_id: sessionId });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 transcript \u7121\u4efb\u52d9', () => {
  const sessionId = 'tg-test-2';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTranscriptLine('assistant', 'assistant', [{ type: 'text', text: 'Hello!' }]),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 \u5168\u90e8\u4efb\u52d9\u5df2\u5b8c\u6210', () => {
  const sessionId = 'tg-test-3';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u5efa\u7acb API', '\u5efa\u7acb REST API'),
    mkTaskCreateResult('tu-1', 1, '\u5efa\u7acb API'),
    mkTaskUpdate('tu-2', 1, 'in_progress'),
    mkTaskUpdateResult('tu-2', 1),
    mkTaskUpdate('tu-3', 1, 'completed'),
    mkTaskUpdateResult('tu-3', 1),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 \u4efb\u52d9\u5df2\u522a\u9664', () => {
  const sessionId = 'tg-test-4';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u6e2c\u8a66\u4efb\u52d9', '\u6e2c\u8a66'),
    mkTaskCreateResult('tu-1', 1, '\u6e2c\u8a66\u4efb\u52d9'),
    mkTaskUpdate('tu-2', 1, 'deleted'),
    mkTaskUpdateResult('tu-2', 1),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 stop_hook_active \u9632\u8ff4\u5708', () => {
  const sessionId = 'tg-test-5';
  cleanState(sessionId);
  const result = runHook({ session_id: sessionId, stop_hook_active: true });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 \u591a\u500b\u4efb\u52d9\u5168\u90e8\u5b8c\u6210', () => {
  const sessionId = 'tg-test-6';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9 A', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9 A'),
    mkTaskCreate('tu-2', '\u4efb\u52d9 B', ''),
    mkTaskCreateResult('tu-2', 2, '\u4efb\u52d9 B'),
    mkTaskCreate('tu-3', '\u4efb\u52d9 C', ''),
    mkTaskCreateResult('tu-3', 3, '\u4efb\u52d9 C'),
    mkTaskUpdate('tu-4', 1, 'completed'),
    mkTaskUpdate('tu-5', 2, 'completed'),
    mkTaskUpdate('tu-6', 3, 'completed'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 cancelled \u624b\u52d5\u53d6\u6d88', () => {
  const sessionId = 'tg-test-7';
  try {
    writeState(sessionId, { blockCount: 0, cancelled: true });
    const tp = writeTranscript([
      mkTaskCreate('tu-1', '\u672a\u5b8c\u6210\u4efb\u52d9', ''),
      mkTaskCreateResult('tu-1', 1, '\u672a\u5b8c\u6210\u4efb\u52d9'),
    ]);
    const result = runHook({ session_id: sessionId, transcript_path: tp });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '');
  } finally {
    cleanState(sessionId);
  }
});

// ===================================================
console.log('\n\ud83e\uddea task-guard: \u963b\u64cb\u5834\u666f\uff08\u6709\u672a\u5b8c\u6210\u4efb\u52d9\uff09');
// ===================================================

test('\u963b\u64cb \u2014 \u55ae\u500b\u4efb\u52d9\u672a\u5b8c\u6210\uff08pending\uff09', () => {
  const sessionId = 'tg-test-10';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u5efa\u7acb\u5143\u4ef6', '\u5efa\u7acb React \u5143\u4ef6'),
    mkTaskCreateResult('tu-1', 1, '\u5efa\u7acb\u5143\u4ef6'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('\u5efa\u7acb\u5143\u4ef6'));
  assert.ok(output.systemMessage.includes('\u26d4'));
  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 \u55ae\u500b\u4efb\u52d9 in_progress', () => {
  const sessionId = 'tg-test-11';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u5be6\u4f5c API', ''),
    mkTaskCreateResult('tu-1', 1, '\u5be6\u4f5c API'),
    mkTaskUpdate('tu-2', 1, 'in_progress'),
    mkTaskUpdateResult('tu-2', 1),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('\u5be6\u4f5c API'));
  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 \u591a\u500b\u4efb\u52d9\u90e8\u5206\u5b8c\u6210', () => {
  const sessionId = 'tg-test-12';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9 A', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9 A'),
    mkTaskCreate('tu-2', '\u4efb\u52d9 B', ''),
    mkTaskCreateResult('tu-2', 2, '\u4efb\u52d9 B'),
    mkTaskCreate('tu-3', '\u4efb\u52d9 C', ''),
    mkTaskCreateResult('tu-3', 3, '\u4efb\u52d9 C'),
    mkTaskUpdate('tu-4', 1, 'completed'),
    // \u4efb\u52d9 2 \u548c 3 \u672a\u5b8c\u6210
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('2/3'));
  assert.ok(output.systemMessage.includes('\u4efb\u52d9 B'));
  assert.ok(output.systemMessage.includes('\u4efb\u52d9 C'));
  assert.ok(!output.systemMessage.includes('\u4efb\u52d9 A'));
  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 reason \u5305\u542b\u7e7c\u7e8c\u63d0\u793a', () => {
  const sessionId = 'tg-test-13';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u5beb\u6e2c\u8a66', ''),
    mkTaskCreateResult('tu-1', 1, '\u5beb\u6e2c\u8a66'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.ok(output.reason.includes('\u5beb\u6e2c\u8a66'));
  assert.ok(output.reason.includes('\u7e7c\u7e8c\u5b8c\u6210'));
  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 blockCount \u905e\u589e', () => {
  const sessionId = 'tg-test-14';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
  ]);

  // \u7b2c\u4e00\u6b21\u963b\u64cb
  runHook({ session_id: sessionId, transcript_path: tp });
  const state1 = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`), 'utf8'));
  assert.strictEqual(state1.blockCount, 1);

  // \u7b2c\u4e8c\u6b21\u963b\u64cb
  runHook({ session_id: sessionId, transcript_path: tp });
  const state2 = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`), 'utf8'));
  assert.strictEqual(state2.blockCount, 2);

  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 \u4e0d\u5305\u542b\u5df2\u522a\u9664\u4efb\u52d9', () => {
  const sessionId = 'tg-test-15';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9 A', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9 A'),
    mkTaskCreate('tu-2', '\u4efb\u52d9 B', ''),
    mkTaskCreateResult('tu-2', 2, '\u4efb\u52d9 B'),
    mkTaskUpdate('tu-3', 1, 'deleted'),
    // \u4efb\u52d9 B \u672a\u5b8c\u6210
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('\u4efb\u52d9 B'));
  assert.ok(!output.systemMessage.includes('\u4efb\u52d9 A'));
  assert.ok(output.systemMessage.includes('1/2'));
  cleanState(sessionId);
});

// ===================================================
console.log('\n\ud83e\uddea task-guard: \u5b89\u5168\u95a5');
// ===================================================

test('\u5b89\u5168\u95a5 \u2014 \u9054\u5230\u6700\u5927\u963b\u64cb\u6b21\u6578\u5f8c\u653e\u884c', () => {
  const sessionId = 'tg-test-20';
  try {
    writeState(sessionId, { blockCount: 5, maxBlocks: 5 });
    const tp = writeTranscript([
      mkTaskCreate('tu-1', '\u672a\u5b8c\u6210', ''),
      mkTaskCreateResult('tu-1', 1, '\u672a\u5b8c\u6210'),
    ]);
    const result = runHook({ session_id: sessionId, transcript_path: tp });
    assert.strictEqual(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.continue, true);
    assert.ok(output.systemMessage.includes('\u6700\u5927\u963b\u64cb\u6b21\u6578'));
    assert.ok(output.systemMessage.includes('5'));
  } finally {
    cleanState(sessionId);
  }
});

test('\u5b89\u5168\u95a5 \u2014 \u653e\u884c\u5f8c\u6e05\u7406 state file', () => {
  const sessionId = 'tg-test-21';
  writeState(sessionId, { blockCount: 5, maxBlocks: 5 });
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u672a\u5b8c\u6210', ''),
    mkTaskCreateResult('tu-1', 1, '\u672a\u5b8c\u6210'),
  ]);
  runHook({ session_id: sessionId, transcript_path: tp });
  // state file \u61c9\u8a72\u5df2\u88ab\u6e05\u7406
  const statePath = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);
  assert.ok(!fs.existsSync(statePath));
});

// ===================================================
console.log('\n\ud83e\uddea task-guard: JSONL \u89e3\u6790\u908a\u754c\u6848\u4f8b');
// ===================================================

test('\u89e3\u6790 \u2014 \u53ea\u6709 TaskUpdate \u7121 TaskCreate\uff08\u76f4\u63a5\u66f4\u65b0\uff09', () => {
  const sessionId = 'tg-test-30';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskUpdate('tu-1', 1, 'in_progress'),
    mkTaskUpdateResult('tu-1', 1),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('Task #1'));
  cleanState(sessionId);
});

test('\u89e3\u6790 \u2014 \u4efb\u52d9\u72c0\u614b\u591a\u6b21\u8f49\u63db\uff08pending \u2192 in_progress \u2192 completed\uff09', () => {
  const sessionId = 'tg-test-31';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u6e2c\u8a66\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u6e2c\u8a66\u4efb\u52d9'),
    mkTaskUpdate('tu-2', 1, 'in_progress'),
    mkTaskUpdate('tu-3', 1, 'completed'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u89e3\u6790 \u2014 tool_result \u5167\u5bb9\u70ba\u9663\u5217\u683c\u5f0f', () => {
  const sessionId = 'tg-test-32';
  cleanState(sessionId);
  // \u6a21\u64ec tool_result content \u662f\u9663\u5217\u800c\u975e\u5b57\u4e32
  const lines = [
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'text', text: 'Task #1 created successfully: \u4efb\u52d9' }],
          },
        ],
      },
    }),
  ];
  const tp = writeTranscript(lines);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.ok(output.systemMessage.includes('\u4efb\u52d9'));
  cleanState(sessionId);
});

test('\u89e3\u6790 \u2014 \u7a7a JSONL \u884c\u88ab\u5ffd\u7565', () => {
  const sessionId = 'tg-test-33';
  cleanState(sessionId);
  const tp = writeTranscript([
    '',
    'invalid json',
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    '',
    mkTaskUpdate('tu-2', 1, 'completed'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

// ===================================================
console.log('\n\ud83e\uddea task-guard: \u5b8c\u6210\u627f\u8afe\uff08promise\uff09');
// ===================================================

function mkAssistantText(text) {
  return mkTranscriptLine('assistant', 'assistant', [
    { type: 'text', text },
  ]);
}

test('\u653e\u884c \u2014 promise \u7cbe\u78ba\u5339\u914d\uff08\u5373\u4f7f\u6709\u672a\u5b8c\u6210\u4efb\u52d9\uff09', () => {
  const sessionId = 'tg-test-40';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9 A', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9 A'),
    // \u4efb\u52d9\u672a\u5b8c\u6210\uff0c\u4f46\u6709 promise
    mkAssistantText('\u5df2\u5b8c\u6210\u6240\u6709\u5de5\u4f5c\u3002<promise>ALL_TASKS_COMPLETE</promise>'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u963b\u64cb \u2014 promise \u4e0d\u5339\u914d\uff08\u5167\u5bb9\u4e0d\u540c\uff09', () => {
  const sessionId = 'tg-test-41';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    mkAssistantText('\u6211\u89ba\u5f97\u5b8c\u6210\u4e86\u3002<promise>DONE</promise>'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  cleanState(sessionId);
});

test('\u963b\u64cb \u2014 \u7121 promise \u6a19\u7c64', () => {
  const sessionId = 'tg-test-42';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    mkAssistantText('\u5b8c\u6210\u4e86 ALL_TASKS_COMPLETE'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  cleanState(sessionId);
});

test('\u653e\u884c \u2014 promise \u5728\u591a\u884c\u6587\u672c\u4e2d', () => {
  const sessionId = 'tg-test-43';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    mkAssistantText('\u5168\u90e8\u505a\u5b8c\u4e86\u3002\n\n\u4ee5\u4e0b\u662f\u6458\u8981...\n<promise>ALL_TASKS_COMPLETE</promise>\n\n\u8b1d\u8b1d\u3002'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u653e\u884c \u2014 promise \u7a7a\u767d\u6b63\u898f\u5316', () => {
  const sessionId = 'tg-test-44';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    mkAssistantText('<promise>  ALL_TASKS_COMPLETE  </promise>'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, '');
});

test('\u963b\u64cb \u2014 promise \u5728\u975e\u6700\u5f8c assistant \u8a0a\u606f\u4e2d\uff08\u53ea\u770b\u6700\u5f8c\u4e00\u500b\uff09', () => {
  const sessionId = 'tg-test-45';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
    mkAssistantText('<promise>ALL_TASKS_COMPLETE</promise>'),
    // \u6700\u5f8c\u4e00\u500b assistant \u8a0a\u606f\u6c92\u6709 promise
    mkAssistantText('\u6211\u9084\u5728\u5de5\u4f5c\u4e2d...'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  cleanState(sessionId);
});

test('\u963b\u64cb\u8a0a\u606f\u5305\u542b promise \u63d0\u793a', () => {
  const sessionId = 'tg-test-46';
  cleanState(sessionId);
  const tp = writeTranscript([
    mkTaskCreate('tu-1', '\u4efb\u52d9', ''),
    mkTaskCreateResult('tu-1', 1, '\u4efb\u52d9'),
  ]);
  const result = runHook({ session_id: sessionId, transcript_path: tp });
  const output = JSON.parse(result.stdout);
  assert.ok(output.systemMessage.includes('<promise>'));
  assert.ok(output.systemMessage.includes('ALL_TASKS_COMPLETE'));
  cleanState(sessionId);
});

// ===================================================
// 清理暫存目錄
// ===================================================
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (_) {}

// ===================================================
// 結果總結
// ===================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`\u7d50\u679c\uff1a${passed} \u901a\u904e / ${failed} \u5931\u6557 / ${passed + failed} \u7e3d\u8a08`);

if (failed > 0) {
  console.log('\u274c \u6709\u6e2c\u8a66\u5931\u6557\n');
  process.exit(1);
} else {
  console.log('\u2705 \u5168\u90e8\u901a\u904e\n');
}
