#!/usr/bin/env node
/**
 * cancel-and-guard.test.js — 測試 cancel 操作的 state 重設 + pipeline-guard 放行驗證
 *
 * Part 1: 模擬 cancel 操作（重設 FSM phase）
 * Part 2: 驗證 pipeline-guard.js 在不同 FSM state 條件下的行為（放行 vs 阻擋）
 *
 * 執行：node plugins/vibe/tests/cancel-and-guard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PIPELINE_GUARD_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pipeline-guard.js');

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

test('Pipeline 重設：phase=IDLE（cancel 後）', () => {
  const sessionId = 'test-cancel-pipeline-1';
  try {
    // 初始 state（FSM 結構）
    const initialState = {
      phase: 'DELEGATING',
      context: {
        pipelineId: 'standard',
        taskType: 'feature',
        expectedStages: ['PLAN', 'ARCH', 'DEV'],
      },
      progress: {
        currentStage: 'ARCH',
        stageIndex: 1,
        completedAgents: ['vibe:planner'],
        stageResults: {},
        retries: {},
        skippedStages: [],
        pendingRetry: null,
      },
      meta: {
        initialized: true,
        cancelled: false,
      },
    };
    writeState(sessionId, initialState);

    // 模擬 cancel 操作
    const state = readState(sessionId);
    state.phase = 'IDLE';
    state.meta.cancelled = true;
    writeState(sessionId, state);

    // 驗證結果
    const result = readState(sessionId);
    assert.strictEqual(result.phase, 'IDLE');
    assert.strictEqual(result.meta.cancelled, true);
    assert.strictEqual(result.progress.completedAgents.length, 1);
    assert.strictEqual(result.progress.completedAgents[0], 'vibe:planner');
    assert.strictEqual(result.context.taskType, 'feature');
    assert.strictEqual(result.context.expectedStages.length, 3);
  } finally {
    cleanState(sessionId);
  }
});

test('Task-guard 重設：meta.cancelled=true', () => {
  const sessionId = 'test-cancel-taskguard-1';
  try {
    // 注意：task-guard 用不同的 state file（假設用 task-guard-state-{sessionId}.json）
    // 這裡為了測試，直接在 task-guard-state 中模擬
    const stateFile = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);

    // 初始 state
    const initialState = {
      blockCount: 3,
      meta: { cancelled: false },
      tasks: [{ text: 'TODO item', completed: false }],
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));

    // 模擬 cancel 操作
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.meta.cancelled = true;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    // 驗證結果
    const result = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(result.meta.cancelled, true);
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

test('只重設 phase，不清除完成記錄', () => {
  const sessionId = 'test-cancel-preserve-1';
  try {
    const initialState = {
      phase: 'DELEGATING',
      context: {
        pipelineId: 'standard',
        taskType: 'feature',
        expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
      },
      progress: {
        currentStage: 'DEV',
        stageIndex: 2,
        completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
        stageResults: {
          PLAN: { verdict: 'PASS' },
          ARCH: { verdict: 'PASS' },
        },
        retries: {},
        skippedStages: [],
        pendingRetry: null,
      },
      meta: {
        initialized: true,
        cancelled: false,
      },
    };
    writeState(sessionId, initialState);

    // 模擬 cancel
    const state = readState(sessionId);
    state.phase = 'IDLE';
    state.meta.cancelled = true;
    writeState(sessionId, state);

    // 驗證：歷史記錄保留
    const result = readState(sessionId);
    assert.strictEqual(result.progress.completedAgents.length, 3);
    assert.strictEqual(result.progress.stageResults.PLAN.verdict, 'PASS');
    assert.strictEqual(result.progress.stageResults.ARCH.verdict, 'PASS');
  } finally {
    cleanState(sessionId);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 2: Pipeline-guard 放行驗證');
// ═══════════════════════════════════════════════

test('放行 — 無 state file', () => {
  const sessionId = 'test-pg-1';
  cleanState(sessionId);

  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    session_id: sessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  assert.strictEqual(result.exitCode, 0);
});

test('放行 — phase=IDLE（未強制）', () => {
  const sessionId = 'test-pg-2';
  try {
    writeState(sessionId, {
      phase: 'IDLE',
      context: { taskType: 'quickfix' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — phase=DELEGATING（sub-agent 操作）', () => {
  const sessionId = 'test-pg-3';
  try {
    writeState(sessionId, {
      phase: 'DELEGATING',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — 非程式碼檔案（.md）同樣受限', () => {
  const sessionId = 'test-pg-4';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'README.md' },
    });

    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — 非程式碼檔案（.json）同樣受限', () => {
  const sessionId = 'test-pg-5';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'package.json' },
    });

    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — pipeline 啟動 + 未委派 + 程式碼檔案', () => {
  const sessionId = 'test-pg-6';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
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

test('放行 — cancel 後（phase=IDLE + cancelled=true）', () => {
  const sessionId = 'test-pg-7';
  try {
    // 模擬 cancel 後的 state
    writeState(sessionId, {
      phase: 'IDLE',
      context: { taskType: 'feature' },
      progress: {
        completedAgents: ['vibe:planner', 'vibe:architect'],
      },
      meta: { initialized: true, cancelled: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
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

test('放行 — 未初始化（meta.initialized=false）', () => {
  const sessionId = 'test-pg-8';
  try {
    writeState(sessionId, {
      phase: 'IDLE',
      meta: { initialized: false },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
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
  const sessionId = 'test-pg-9';
  try {
    writeState(sessionId, {
      phase: 'IDLE',
      context: {
        // taskType 尚未設定
      },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
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
  const sessionId = 'test-pg-10';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
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

test('阻擋 — .yml 同樣受限', () => {
  const sessionId = 'test-pg-11';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '.github/workflows/ci.yml' },
    });

    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — AskUserQuestion（pipeline 啟動中）', () => {
  const sessionId = 'test-pg-12';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'AskUserQuestion',
      tool_input: {},
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('⛔'));
    assert.ok(result.stderr.includes('自動'));
  } finally {
    cleanState(sessionId);
  }
});

test('放行 — AskUserQuestion（meta.cancelled=true）', () => {
  const sessionId = 'test-pg-13';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true, cancelled: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'AskUserQuestion',
      tool_input: {},
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — EnterPlanMode（無條件阻擋，pipeline 啟動中）', () => {
  const sessionId = 'test-pg-14';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('EnterPlanMode'));
  } finally {
    cleanState(sessionId);
  }
});

test('阻擋 — EnterPlanMode（無條件阻擋，phase=IDLE）', () => {
  const sessionId = 'test-pg-15';
  try {
    writeState(sessionId, {
      phase: 'IDLE',
      context: { taskType: 'quickfix' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    // v1.0.47+: EnterPlanMode 無條件阻擋
    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('EnterPlanMode'));
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
