#!/usr/bin/env node
/**
 * suggest-compact-classified.test.js — CLASSIFIED 階段委派提醒測試
 *
 * 測試重點：
 * 1. CLASSIFIED 階段：每次工具呼叫遞增 classifiedReadCount
 * 2. 達閾值（3 次）觸發 systemMessage 提醒
 * 3. DELEGATING 階段：重設 classifiedReadCount
 * 4. compact 提醒 + CLASSIFIED 提醒合併為單一 systemMessage
 * 5. 無 state 時靜默（不報錯）
 * 6. extractToolInfo 各工具類型正確提取
 *
 * 執行：node plugins/vibe/tests/suggest-compact-classified.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

let passed = 0;
let failed = 0;

require('./test-helpers').cleanTestStateFiles();

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

// ─── 輔助函式 ───────────────────────────────────────────

function writeState(sessionId, state) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function readState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeCounter(sessionId, count) {
  const p = path.join(CLAUDE_DIR, `flow-counter-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify({ count, lastRemind: 0 }));
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

function cleanupSession(sessionId) {
  cleanup(
    path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`),
    path.join(CLAUDE_DIR, `flow-counter-${sessionId}.json`),
    path.join(CLAUDE_DIR, `timeline-${sessionId}.jsonl`),
    path.join(CLAUDE_DIR, `classified-reads-${sessionId}.json`),
    path.join(CLAUDE_DIR, `heartbeat-${sessionId}`),
  );
}

/** 寫入獨立計數檔（v3.1: classifiedReadCount 從 pipeline state 移出） */
function writeClassifiedCount(sessionId, count) {
  const p = path.join(CLAUDE_DIR, `classified-reads-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify({ count }));
}

/** 讀取獨立計數檔 */
function readClassifiedCount(sessionId) {
  const p = path.join(CLAUDE_DIR, `classified-reads-${sessionId}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).count || 0; } catch (_) { return 0; }
}

/** 檢查獨立計數檔是否存在 */
function classifiedCountExists(sessionId) {
  return fs.existsSync(path.join(CLAUDE_DIR, `classified-reads-${sessionId}.json`));
}

/**
 * 建立 CLASSIFIED phase 的 v4 state（有 dag + classification，無 active stage）
 */
function makeClassifiedState(sessionId, { pipelineId = 'standard' } = {}) {
  return {
    version: 4,
    sessionId,
    pipelineActive: true,
    activeStages: [],
    classification: { pipelineId, taskType: 'feature', source: 'regex' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['REVIEW'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    retryHistory: {},
    crashes: {},
    pendingRetry: null,
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
    },
  };
}

/**
 * 建立 DELEGATING phase 的 v4 state（有 active stage）
 */
function makeDelegatingState(sessionId, { pipelineId = 'standard' } = {}) {
  return {
    version: 4,
    sessionId,
    pipelineActive: true,
    activeStages: ['DEV'],
    classification: { pipelineId, taskType: 'feature', source: 'regex' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'active', agent: 'vibe:developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    retryHistory: {},
    crashes: {},
    pendingRetry: null,
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
    },
  };
}

function runHook(stdinData) {
  return execSync(
    `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'suggest-compact.js')}"`,
    {
      input: JSON.stringify(stdinData),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    }
  );
}

// ═══════════════════════════════════════════════════════
console.log('\n=== CLASSIFIED 計數遞增邏輯 ===');
// ═══════════════════════════════════════════════════════

test('CLASSIFIED 階段：首次呼叫 → classifiedReadCount = 1', () => {
  const sessionId = 'test-sc-c-count-1';
  writeState(sessionId, makeClassifiedState(sessionId));

  try {
    runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/foo/bar.js' } });
    assert.strictEqual(readClassifiedCount(sessionId), 1,
      'classifiedReadCount 應遞增為 1');
  } finally {
    cleanupSession(sessionId);
  }
});

test('CLASSIFIED 階段：多次呼叫累積計數', () => {
  const sessionId = 'test-sc-c-count-2';
  writeState(sessionId, makeClassifiedState(sessionId));
  writeClassifiedCount(sessionId, 1);

  try {
    runHook({ session_id: sessionId, tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
    assert.strictEqual(readClassifiedCount(sessionId), 2,
      'classifiedReadCount 應從 1 遞增為 2');
  } finally {
    cleanupSession(sessionId);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n=== CLASSIFIED 閾值觸發提醒 ===');
// ═══════════════════════════════════════════════════════

test('CLASSIFIED 達閾值（第 3 次）→ systemMessage 包含委派提醒', () => {
  const sessionId = 'test-sc-c-threshold-1';
  writeState(sessionId, makeClassifiedState(sessionId, { pipelineId: 'quick-dev' }));
  writeClassifiedCount(sessionId, 2);

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Grep', tool_input: { pattern: 'foo' } });
    const json = JSON.parse(output.trim());
    assert.ok(json.systemMessage, '應輸出 systemMessage');
    assert.ok(json.systemMessage.includes('Pipeline'), 'systemMessage 應包含 Pipeline');
    assert.ok(json.systemMessage.includes('3'), 'systemMessage 應包含次數 3');
    assert.ok(json.systemMessage.includes('委派') || json.systemMessage.includes('sub-agent'),
      'systemMessage 應提示委派 sub-agent');
  } finally {
    cleanupSession(sessionId);
  }
});

test('CLASSIFIED 達閾值 → systemMessage 包含 pipelineId 標籤', () => {
  const sessionId = 'test-sc-c-threshold-2';
  writeState(sessionId, makeClassifiedState(sessionId, { pipelineId: 'standard' }));
  writeClassifiedCount(sessionId, 2);

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    const json = JSON.parse(output.trim());
    assert.ok(json.systemMessage.includes('standard'), 'systemMessage 應包含 pipelineId');
  } finally {
    cleanupSession(sessionId);
  }
});

test('CLASSIFIED 達閾值 → systemMessage 包含下一個 ready stage', () => {
  const sessionId = 'test-sc-c-threshold-3';
  writeState(sessionId, makeClassifiedState(sessionId, { pipelineId: 'quick-dev' }));
  writeClassifiedCount(sessionId, 2);

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Glob', tool_input: { pattern: '*.js' } });
    const json = JSON.parse(output.trim());
    // DEV 是第一個 ready stage（無 deps）
    assert.ok(json.systemMessage.includes('DEV'), 'systemMessage 應包含下一個 stage DEV');
  } finally {
    cleanupSession(sessionId);
  }
});

test('CLASSIFIED 未達閾值（第 2 次）→ 無 systemMessage', () => {
  const sessionId = 'test-sc-c-nothreshold';
  writeState(sessionId, makeClassifiedState(sessionId));
  writeClassifiedCount(sessionId, 1);

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    // 輸出空白（無 systemMessage）
    assert.strictEqual(output.trim(), '', '未達閾值不應輸出 systemMessage');
  } finally {
    cleanupSession(sessionId);
  }
});

test('CLASSIFIED 超過閾值後繼續累積計數', () => {
  const sessionId = 'test-sc-c-beyond';
  writeState(sessionId, makeClassifiedState(sessionId));
  writeClassifiedCount(sessionId, 4);

  try {
    runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    assert.strictEqual(readClassifiedCount(sessionId), 5, '計數應繼續累積到 5');
  } finally {
    cleanupSession(sessionId);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n=== DELEGATING 重設計數器 ===');
// ═══════════════════════════════════════════════════════

test('DELEGATING 階段：已有計數檔 → 刪除', () => {
  const sessionId = 'test-sc-c-delegating';
  writeState(sessionId, makeDelegatingState(sessionId));
  writeClassifiedCount(sessionId, 5);

  try {
    assert.ok(classifiedCountExists(sessionId), '執行前計數檔應存在');
    runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    assert.ok(!classifiedCountExists(sessionId), 'DELEGATING 應刪除計數檔');
  } finally {
    cleanupSession(sessionId);
  }
});

test('DELEGATING 階段：無計數檔 → 靜默（不報錯）', () => {
  const sessionId = 'test-sc-c-delegating-zero';
  writeState(sessionId, makeDelegatingState(sessionId));
  // 不建立計數檔

  try {
    assert.ok(!classifiedCountExists(sessionId), '執行前計數檔不應存在');
    runHook({ session_id: sessionId, tool_name: 'Grep', tool_input: { pattern: 'foo' } });
    // 無計數檔 → unlinkSync 拋錯被 catch → 靜默
    assert.ok(!classifiedCountExists(sessionId), '執行後計數檔仍不應存在');
  } finally {
    cleanupSession(sessionId);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n=== compact + CLASSIFIED 合併輸出 ===');
// ═══════════════════════════════════════════════════════

test('compact 提醒 + CLASSIFIED 提醒 → 合併為單一 systemMessage（包含兩段）', () => {
  const sessionId = 'test-sc-c-combined';
  writeState(sessionId, makeClassifiedState(sessionId, { pipelineId: 'standard' }));
  writeClassifiedCount(sessionId, 2);
  // 設定 counter 達 compact 閾值（THRESHOLD=200, REMIND_INTERVAL=40）
  // increment 後 count=200，200-0 >= 40 → 觸發 compact 提醒
  writeCounter(sessionId, 199);

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    const json = JSON.parse(output.trim());
    // 合併輸出：一個 JSON 物件包含兩段訊息
    assert.ok(json.systemMessage, '應輸出合併 systemMessage');
    assert.ok(json.systemMessage.includes('compact') || json.systemMessage.includes('Context'),
      'systemMessage 應包含 compact 提醒');
    assert.ok(json.systemMessage.includes('Pipeline') || json.systemMessage.includes('委派'),
      'systemMessage 應包含 CLASSIFIED 委派提醒');
    // 確認是單一 JSON 物件（不是兩個 console.log 輸出）
    const lines = output.trim().split('\n').filter(l => l.trim());
    assert.strictEqual(lines.length, 1, '應只輸出一行 JSON（合併輸出）');
  } finally {
    cleanupSession(sessionId);
    cleanup(path.join(CLAUDE_DIR, `flow-counter-${sessionId}.json`));
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n=== 無 state 時靜默 ===');
// ═══════════════════════════════════════════════════════

test('無 pipeline state → 不報錯，無 systemMessage', () => {
  const sessionId = 'test-sc-c-nostate';
  // 不建立 state 檔案

  try {
    const output = runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    // 無 state 時無 CLASSIFIED 邏輯，輸出空白
    assert.strictEqual(output.trim(), '', '無 state 時不應輸出 systemMessage');
  } finally {
    cleanupSession(sessionId);
  }
});

test('無效 JSON state → 不報錯，靜默降級', () => {
  const sessionId = 'test-sc-c-badjson';
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(statePath, 'not-valid-json');

  try {
    // 不應拋出錯誤（catch 區塊處理）
    const output = runHook({ session_id: sessionId, tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    assert.strictEqual(output.trim(), '', '無效 JSON state 時不應輸出 systemMessage');
  } finally {
    cleanup(statePath);
    cleanupSession(sessionId);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n=== extractToolInfo 各工具提取 ===');
// ═══════════════════════════════════════════════════════

test('Task 工具 → 跳過 tool.used 但仍遞增 classifiedReadCount', () => {
  const sessionId = 'test-sc-c-task';
  writeState(sessionId, makeClassifiedState(sessionId));

  try {
    // Task 不觸發 tool.used（由 delegation-tracker 處理），但 CLASSIFIED 計數仍遞增
    runHook({ session_id: sessionId, tool_name: 'Task', tool_input: { description: 'do something' } });
    assert.strictEqual(readClassifiedCount(sessionId), 1, 'Task 工具也應遞增 classifiedReadCount');
  } finally {
    cleanupSession(sessionId);
  }
});

test('Bash 工具 → 命令提取（前 80 字元）', () => {
  const sessionId = 'test-sc-c-bash';
  // 無 state，只測試 hook 不崩潰
  try {
    const longCmd = 'A'.repeat(100);
    runHook({ session_id: sessionId, tool_name: 'Bash', tool_input: { command: longCmd } });
    // 確認沒有拋出例外
    assert.ok(true, 'Bash 工具不應拋出例外');
  } finally {
    cleanupSession(sessionId);
  }
});

test('MCP 工具（mcp__plugin_vibe_mcp__search）→ 不崩潰', () => {
  const sessionId = 'test-sc-c-mcp';
  try {
    runHook({ session_id: sessionId, tool_name: 'mcp__plugin_vibe_mcp__search', tool_input: { query: 'test' } });
    assert.ok(true, 'MCP 工具不應拋出例外');
  } finally {
    cleanupSession(sessionId);
  }
});

// ═══════════════════════════════════════════════════════
// 清理 + 結果
// ═══════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
