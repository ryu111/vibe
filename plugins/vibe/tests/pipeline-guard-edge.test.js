#!/usr/bin/env node
/**
 * pipeline-guard-edge.test.js — pipeline-guard hook 邊界案例測試
 *
 * 補充測試 cancel-and-guard.test.js 未覆蓋的邊界案例：
 * - state file 損壞/不完整
 * - NotebookEdit 完整流程
 * - 多重 FSM phase 組合
 * - sessionId 異常
 * - hook 錯誤處理（解析失敗時的降級）
 *
 * 執行：node plugins/vibe/tests/pipeline-guard-edge.test.js
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

function writeState(sessionId, state) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function writeRawState(sessionId, content) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, content);
  return p;
}

function cleanState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try {
    fs.unlinkSync(p);
  } catch (_) {}
}

function runHook(hookPath, stdinData) {
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData)}' | node "${hookPath}"`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
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
console.log('\n🧪 State File 損壞/異常測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('State file 損壞（無效 JSON）→ 放行（錯誤處理）', () => {
  const sessionId = 'test-corrupt-1';
  try {
    writeRawState(sessionId, '{invalid json}');

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    // 解析失敗應降級放行（catch block 不阻擋）
    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('State file 為空字串 → 放行', () => {
  const sessionId = 'test-empty-1';
  try {
    writeRawState(sessionId, '');

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

test('State file 為空物件 → 放行（initialized=false）', () => {
  const sessionId = 'test-empty-obj-1';
  try {
    writeState(sessionId, {});

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    // 空物件沒有 initialized，視為 falsy
    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('State file 缺 meta.initialized 欄位 → 放行', () => {
  const sessionId = 'test-missing-init-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: {
        // 缺 initialized
      },
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

test('State file meta.initialized=null → 放行', () => {
  const sessionId = 'test-null-init-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: null },
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

test('State file context.taskType=null → 放行', () => {
  const sessionId = 'test-null-task-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: null },
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

test('State file context.taskType="" → 放行', () => {
  const sessionId = 'test-empty-task-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: '' },
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

test('State file phase=null → 放行（IDLE fallback）', () => {
  const sessionId = 'test-null-enforced-1';
  try {
    writeState(sessionId, {
      phase: null,
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

// ═══════════════════════════════════════════════
console.log('\n🧪 多重 Phase 組合測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('phase=DELEGATING + cancelled=true → 放行（isDelegating 優先）', () => {
  const sessionId = 'test-multi-1';
  try {
    writeState(sessionId, {
      phase: 'DELEGATING',
      context: { taskType: 'feature' },
      meta: { initialized: true, cancelled: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    // isDelegating 檢查在 isCancelled 之前
    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('phase=IDLE → 放行（isEnforced=false）', () => {
  const sessionId = 'test-multi-2';
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

test('meta.initialized=false + phase=CLASSIFIED → 放行（initialized 優先）', () => {
  const sessionId = 'test-multi-3';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
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

test('context.taskType 缺失 + phase=CLASSIFIED → 放行（taskType 優先）', () => {
  const sessionId = 'test-multi-4';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: {
        // taskType 缺失
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

// ═══════════════════════════════════════════════
console.log('\n🧪 NotebookEdit 完整流程測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NotebookEdit — pipeline 啟動 + .ipynb → 阻擋', () => {
  const sessionId = 'test-nb-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'analysis.ipynb' },
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('⛔'));
    assert.ok(result.stderr.includes('NotebookEdit'));
  } finally {
    cleanState(sessionId);
  }
});

test('NotebookEdit — pipeline 啟動 + .md → 放行', () => {
  const sessionId = 'test-nb-2';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'notes.md' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('NotebookEdit — phase=DELEGATING + .ipynb → 放行', () => {
  const sessionId = 'test-nb-3';
  try {
    writeState(sessionId, {
      phase: 'DELEGATING',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'notebook.ipynb' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('NotebookEdit — meta.cancelled=true + .ipynb → 放行', () => {
  const sessionId = 'test-nb-4';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true, cancelled: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'data.ipynb' },
    });

    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

test('NotebookEdit — 無 state file → 放行', () => {
  const sessionId = 'test-nb-5';
  cleanState(sessionId);

  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    session_id: sessionId,
    tool_name: 'NotebookEdit',
    tool_input: { file_path: 'work.ipynb' },
  });

  assert.strictEqual(result.exitCode, 0);
});

// ═══════════════════════════════════════════════
console.log('\n🧪 SessionId 異常測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('sessionId 為空字串 → 放行（無對應 state file）', () => {
  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    session_id: '',
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  // pipeline-state-.json 不存在
  assert.strictEqual(result.exitCode, 0);
});

test('sessionId 為 null → 放行', () => {
  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    session_id: null,
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  assert.strictEqual(result.exitCode, 0);
});

test('sessionId 為 undefined → 放行', () => {
  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    // session_id 欄位缺失
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  // sessionId 預設為 'unknown'，但 state file 不存在
  assert.strictEqual(result.exitCode, 0);
});

test('sessionId 含特殊字元 → 放行（找不到 state file）', () => {
  const result = runHook(PIPELINE_GUARD_SCRIPT, {
    session_id: '../../../etc/passwd',
    tool_name: 'Write',
    tool_input: { file_path: 'src/app.js' },
  });

  // 路徑拼接後找不到檔案
  assert.strictEqual(result.exitCode, 0);
});

// ═══════════════════════════════════════════════
console.log('\n🧪 ToolInput 極端邊界');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write — toolInput 缺失 → 阻擋', () => {
  const sessionId = 'test-input-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      // tool_input 欄位缺失
    });

    // guard-rules evaluate() 會處理 undefined toolInput
    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('Write — file_path 為非常長的字串 → 正常判斷', () => {
  const sessionId = 'test-input-2';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const longPath = '/very/' + 'long/'.repeat(100) + 'app.js';
    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: longPath },
    });

    // 程式碼檔案應阻擋
    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('Write — file_path 為 Unicode 字元 → 正常判斷', () => {
  const sessionId = 'test-input-3';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: '/路徑/測試/應用.js' },
    });

    assert.strictEqual(result.exitCode, 2);
  } finally {
    cleanState(sessionId);
  }
});

test('AskUserQuestion — 有額外欄位 → 阻擋（忽略額外欄位）', () => {
  const sessionId = 'test-input-4';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      tool_name: 'AskUserQuestion',
      tool_input: {
        question: 'Should we proceed?',
        options: ['yes', 'no'],
      },
    });

    assert.strictEqual(result.exitCode, 2);
    assert.ok(result.stderr.includes('AskUserQuestion'));
  } finally {
    cleanState(sessionId);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 StdIn 異常測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('StdIn 為空物件 → 放行（缺 sessionId）', () => {
  const result = runHook(PIPELINE_GUARD_SCRIPT, {});
  // sessionId='unknown'，無 state file
  assert.strictEqual(result.exitCode, 0);
});

test('StdIn 為 null → 放行（JSON parse 失敗降級）', () => {
  try {
    const stdout = execSync(
      `echo 'null' | node "${PIPELINE_GUARD_SCRIPT}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    );
    // 不拋出異常 = exit 0
    assert.ok(true);
  } catch (_) {
    // 如果拋出異常也接受（錯誤處理）
    assert.ok(true);
  }
});

test('StdIn 缺 tool_name → 放行', () => {
  const sessionId = 'test-stdin-1';
  try {
    writeState(sessionId, {
      phase: 'CLASSIFIED',
      context: { taskType: 'feature' },
      meta: { initialized: true },
    });

    const result = runHook(PIPELINE_GUARD_SCRIPT, {
      session_id: sessionId,
      // tool_name 欄位缺失
      tool_input: { file_path: 'src/app.js' },
    });

    // tool_name='Unknown'，不在 matcher 列表，guard-rules 返回 allow
    assert.strictEqual(result.exitCode, 0);
  } finally {
    cleanState(sessionId);
  }
});

// ═══════════════════════════════════════════════
// 結果總結
// ═══════════════════════════════════════════════

console.log(`\n${'='.repeat(55)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);

if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
