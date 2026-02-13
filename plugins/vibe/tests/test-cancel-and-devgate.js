#!/usr/bin/env node
/**
 * test-cancel-and-devgate.js — 測試 cancel 操作的 state 重設 + dev-gate 放行驗證
 *
 * Part 1: 模擬 cancel 操作（重設 pipelineEnforced/delegationActive flag）
 * Part 2: 驗證 dev-gate.js 在不同 state 條件下的行為（放行 vs 阻擋）
 *
 * 執行：node plugins/vibe/tests/test-cancel-and-devgate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEV_GATE_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'dev-gate.js');

let passed = 0;
let failed = 0;

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

// ─── 輔助函式 ─────────────────────────────

/**
 * 寫入 pipeline state file
 * @param {string} sessionId
 * @param {object} state
 * @returns {string} state file path
 */
function writeState(sessionId, state) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/**
 * 清理 state file
 * @param {string} sessionId
 */
function cleanState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try {
    fs.unlinkSync(p);
  } catch (_) {}
}

/**
 * 讀取 state file
 * @param {string} sessionId
 * @returns {object|null}
 */
function readState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 執行 hook 腳本
 * @param {string} hookPath
 * @param {object} stdinData
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runHook(hookPath, stdinData) {
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData)}' | node "${hookPath}"`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }
    );
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 1: Cancel 操作的 state 重設邏輯');
// ═══════════════════════════════════════════════

test('Pipeline 重設：pipelineEnforced=false, delegationActive=false', () => {
  const sessionId = 'test-cancel-pipeline-1';
  try {
    // 初始 state
    const initialState = {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: true,
      completed: ['vibe:planner'],
      expectedStages: ['PLAN', 'ARCH', 'DEV'],
    };
    writeState(sessionId, initialState);

    // 模擬 cancel 操作
    const state = readState(sessionId);
    state.pipelineEnforced = false;
    state.delegationActive = false;
    writeState(sessionId, state);

    // 驗證結果
    const result = readState(sessionId);
    assert.strictEqual(result.pipelineEnforced, false);
    assert.strictEqual(result.delegationActive, false);
    assert.strictEqual(result.completed.length, 1);
    assert.strictEqual(result.completed[0], 'vibe:planner');
    assert.strictEqual(result.taskType, 'feature');
    assert.strictEqual(result.expectedStages.length, 3);
  } finally {
    cleanState(sessionId);
  }
});

test('Task-guard 重設：cancelled=true', () => {
  const sessionId = 'test-cancel-taskguard-1';
  try {
    // 注意：task-guard 用不同的 state file（假設用 task-guard-state-{sessionId}.json）
    // 這裡為了測試，直接在 pipeline-state 中模擬
    const stateFile = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);

    // 初始 state
    const initialState = {
      blockCount: 3,
      cancelled: false,
      tasks: [{ text: 'TODO item', completed: false }],
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));

    // 模擬 cancel 操作
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.cancelled = true;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    // 驗證結果
    const result = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.blockCount, 3);
    assert.strictEqual(result.tasks.length, 1);

    // 清理
    fs.unlinkSync(stateFile);
  } catch (err) {
    const stateFile = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);
    try {
      fs.unlinkSync(stateFile);
    } catch (_) {}
    throw err;
  }
});

test('只重設 flag，不清除完成記錄', () => {
  const sessionId = 'test-cancel-preserve-1';
  try {
    const initialState = {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: true,
      completed: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
      stageResults: {
        PLAN: { verdict: 'PASS' },
        ARCH: { verdict: 'PASS' },
      },
    };
    writeState(sessionId, initialState);

    // 模擬 cancel
    const state = readState(sessionId);
    state.pipelineEnforced = false;
    state.delegationActive = false;
    writeState(sessionId, state);

    // 驗證：歷史記錄保留
    const result = readState(sessionId);
    assert.strictEqual(result.completed.length, 3);
    assert.strictEqual(result.stageResults.PLAN.verdict, 'PASS');
    assert.strictEqual(result.stageResults.ARCH.verdict, 'PASS');
  } finally {
    cleanState(sessionId);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 2: Dev-gate 放行驗證');
// ═══════════════════════════════════════════════

test('放行 — 無 state file', () => {
  const sessionId = 'test-dg-1';
  cleanState(sessionId);

  const result = runHook(DEV_GATE_SCRIPT, {
    session_id: sessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  assert.strictEqual(result.exitCode, 0);
});

test('放行 — pipelineEnforced=false', () => {
  const sessionId = 'test-dg-2';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'quickfix',
      pipelineEnforced: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — delegationActive=true（sub-agent 操作）', () => {
  const sessionId = 'test-dg-3';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: true,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — 非程式碼檔案（.md）', () => {
  const sessionId = 'test-dg-4';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'README.md' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — 非程式碼檔案（.json）', () => {
  const sessionId = 'test-dg-5';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'package.json' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — pipeline 啟動 + 未委派 + 程式碼檔案', () => {
  const sessionId = 'test-dg-6';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('⛔'));
    assert.ok(result.stderr.includes('Pipeline 模式下禁止直接使用'));
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — cancel 後（pipelineEnforced 已重設）', () => {
  const sessionId = 'test-dg-7';
  try {
    // 模擬 cancel 後的 state
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: false,  // cancel 重設
      delegationActive: false,
      completed: ['vibe:planner', 'vibe:architect'],
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    // 關鍵驗證：cancel 後應該放行
    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — 未初始化（initialized=false）', () => {
  const sessionId = 'test-dg-8';
  try {
    writeState(sessionId, {
      initialized: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — 無 taskType（分類前）', () => {
  const sessionId = 'test-dg-9';
  try {
    writeState(sessionId, {
      initialized: true,
      // taskType 尚未設定
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — Edit 工具同樣受限', () => {
  const sessionId = 'test-dg-10';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/component.tsx' },
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('Edit'));
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — 程式碼檔案但有其他放行條件（.yml 視為非程式碼）', () => {
  const sessionId = 'test-dg-11';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(DEV_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '.github/workflows/ci.yml' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

// ═══════════════════════════════════════════════
// 結果總結
// ═══════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);

if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
