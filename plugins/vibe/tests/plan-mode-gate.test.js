#!/usr/bin/env node
/**
 * plan-mode-gate.test.js — 測試 plan-mode-gate hook 的阻擋/放行邏輯
 *
 * 驗證 Pipeline 模式下 EnterPlanMode 被硬阻擋，
 * 非 Pipeline 模式下（或 /cancel 後）放行。
 *
 * 執行：bun test plugins/vibe/tests/plan-mode-gate.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLAN_GATE_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'plan-mode-gate.js');

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

function writeState(sessionId, state) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function cleanState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try { fs.unlinkSync(p); } catch (_) {}
}

function runHook(hookPath, stdinData) {
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData)}' | node "${hookPath}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
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

// ===================================================
console.log('\n\ud83e\uddea plan-mode-gate: \u653e\u884c\u5834\u666f');
// ===================================================

test('\u653e\u884c \u2014 \u7121 state file', () => {
  const sessionId = 'test-pmg-1';
  cleanState(sessionId);

  const result = runHook(PLAN_GATE_SCRIPT, {
    session_id: sessionId,
    tool_name: 'EnterPlanMode',
  });

  assert.strictEqual(result.exitCode, 0);
});

test('\u653e\u884c \u2014 initialized=false', () => {
  const sessionId = 'test-pmg-2';
  try {
    writeState(sessionId, { initialized: false });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('\u653e\u884c \u2014 pipelineEnforced=false\uff08quickfix \u4efb\u52d9\uff09', () => {
  const sessionId = 'test-pmg-3';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'quickfix',
      pipelineEnforced: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('\u653e\u884c \u2014 pipelineEnforced=false\uff08research \u4efb\u52d9\uff09', () => {
  const sessionId = 'test-pmg-4';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'research',
      pipelineEnforced: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('\u653e\u884c \u2014 /cancel \u5f8c\uff08pipelineEnforced \u5df2\u91cd\u8a2d\uff09', () => {
  const sessionId = 'test-pmg-5';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: false, // cancel \u91cd\u8a2d
      delegationActive: false,
      completed: ['vibe:planner', 'vibe:architect'],
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('\u653e\u884c \u2014 bugfix \u4efb\u52d9\uff08\u975e FULL_PIPELINE_TYPES\uff09', () => {
  const sessionId = 'test-pmg-6';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'bugfix',
      pipelineEnforced: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

// ===================================================
console.log('\n\ud83e\uddea plan-mode-gate: \u963b\u64cb\u5834\u666f');
// ===================================================

test('\u963b\u64cb \u2014 feature pipeline \u555f\u52d5\u4e2d', () => {
  const sessionId = 'test-pmg-7';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('\u26d4'));
    assert.ok(result.stderr.includes('EnterPlanMode'));
    assert.ok(result.stderr.includes('vibe:planner'));
  } finally {
    cleanState(sessionId);
  }
});

test('\u963b\u64cb \u2014 refactor pipeline \u555f\u52d5\u4e2d', () => {
  const sessionId = 'test-pmg-8';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'refactor',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('\u26d4'));
  } finally {
    cleanState(sessionId);
  }
});

test('\u963b\u64cb \u2014 tdd pipeline \u555f\u52d5\u4e2d', () => {
  const sessionId = 'test-pmg-9';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'tdd',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('\u26d4'));
  } finally {
    cleanState(sessionId);
  }
});

test('\u963b\u64cb \u2014 \u5373\u4f7f delegationActive=true \u4e5f\u963b\u64cb\uff08\u59d4\u6d3e\u4e2d\u4ecd\u4e0d\u61c9\u7528 Plan Mode\uff09', () => {
  const sessionId = 'test-pmg-10';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: true,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    // EnterPlanMode \u662f Main Agent \u5c08\u5c6c\u5de5\u5177\uff0c\u4e0d\u6703\u88ab sub-agent \u547c\u53eb
    // Pipeline \u6a21\u5f0f\u4e0b\u5373\u4f7f delegationActive=true \u4e5f\u61c9\u963b\u64cb
    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('\u963b\u64cb\u8a0a\u606f\u5305\u542b /cancel \u63d0\u793a', () => {
  const sessionId = 'test-pmg-11';
  try {
    writeState(sessionId, {
      initialized: true,
      taskType: 'feature',
      pipelineEnforced: true,
    });

    const result = runHook(PLAN_GATE_SCRIPT, {
      session_id: sessionId,
      tool_name: 'EnterPlanMode',
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('/cancel'));
    assert.ok(result.stderr.includes('/vibe:scope'));
  } finally {
    cleanState(sessionId);
  }
});

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
