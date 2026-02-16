#!/usr/bin/env node
/**
 * e2e-hook-chain.test.js — Hook 鏈端到端整合測試
 *
 * 模擬完整 pipeline 生命週期，驗證 hook 間的 state 傳遞：
 *   Scenario A: Trivial 任務 → 不鎖 pipeline → pipeline-guard 放行
 *   Scenario B: Feature 任務 → 鎖 pipeline → pipeline-guard 阻擋 → delegation 放行 → stage-transition 前進
 *   Scenario C: Cancel 逃生 → 重設 state → pipeline-guard 放行
 *   Scenario D: Reclassification 升級 → quickfix → feature
 *   Scenario E: Console.log 過濾 → hook 腳本排除
 *
 * 執行：node plugins/vibe/tests/e2e-hook-chain.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');

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
 * 初始化 pipeline state（模擬 pipeline-init hook）
 */
function initState(sessionId, overrides = {}) {
  const state = {
    initialized: true,
    completed: [],
    expectedStages: [],
    stageResults: {},
    retries: {},
    delegationActive: false,
    pipelineEnforced: false,
    ...overrides,
  };
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/**
 * 讀取 state file
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
 * 清理 state file
 */
function cleanState(sessionId) {
  const p = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try { fs.unlinkSync(p); } catch (_) {}
}

/**
 * 執行 hook 腳本
 * @returns {{ exitCode: number, stdout: string, stderr: string, json: object|null }}
 */
function runHook(hookName, stdinData) {
  const hookPath = path.join(HOOKS_DIR, `${hookName}.js`);
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData).replace(/'/g, "'\\''")}' | node "${hookPath}"`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );
    const out = stdout.toString().trim();
    let json = null;
    if (out) {
      try { json = JSON.parse(out); } catch (_) {}
    }
    return { exitCode: 0, stdout: out, stderr: '', json };
  } catch (err) {
    const out = (err.stdout || '').toString().trim();
    let json = null;
    if (out) {
      try { json = JSON.parse(out); } catch (_) {}
    }
    return {
      exitCode: err.status || 1,
      stdout: out,
      stderr: (err.stderr || '').toString(),
      json,
    };
  }
}

/**
 * 執行 hook 腳本（帶額外環境變數）
 */
function runHookWithEnv(hookName, stdinData, extraEnv) {
  const hookPath = path.join(HOOKS_DIR, `${hookName}.js`);
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData).replace(/'/g, "'\\''")}' | node "${hookPath}"`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv },
      }
    );
    const out = stdout.toString().trim();
    let json = null;
    if (out) {
      try { json = JSON.parse(out); } catch (_) {}
    }
    return { exitCode: 0, stdout: out, stderr: '', json };
  } catch (err) {
    const out = (err.stdout || '').toString().trim();
    let json = null;
    if (out) {
      try { json = JSON.parse(out); } catch (_) {}
    }
    return {
      exitCode: err.status || 1,
      stdout: out,
      stderr: (err.stderr || '').toString(),
      json,
    };
  }
}

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario A: Trivial 任務 → 不鎖 pipeline → pipeline-guard 放行');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-trivial-1';
  try {
    // Step 1: pipeline-init 初始化 state
    initState(sid);

    // Step 2: task-classifier 分類 trivial 任務
    const classifyResult = runHook('task-classifier', {
      session_id: sid,
      prompt: '建立一個簡單的 hello world HTTP server',
    });

    test('A1: task-classifier 分類 trivial 為 quickfix', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'quickfix');
    });

    test('A2: pipelineEnforced 不被啟動', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineEnforced, false);
    });

    test('A3: expectedStages 僅含 DEV', () => {
      const state = readState(sid);
      assert.deepStrictEqual(state.expectedStages, ['DEV']);
    });

    test('A4: task-classifier 輸出 additionalContext（非 systemMessage）', () => {
      assert.strictEqual(classifyResult.exitCode, 0);
      assert.ok(classifyResult.json);
      assert.ok(classifyResult.json.additionalContext, '應有 additionalContext');
      assert.strictEqual(classifyResult.json.systemMessage, undefined, '不應有 systemMessage');
    });

    // Step 3: pipeline-guard 應放行（pipelineEnforced=false）
    const gateResult = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('A5: pipeline-guard 放行 trivial 任務的 Write', () => {
      assert.strictEqual(gateResult.exitCode, 0);
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario B: Feature 任務 → 完整 pipeline 生命週期');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-feature-1';
  try {
    // Step 1: 初始化
    initState(sid);

    // Step 2: task-classifier 分類 feature 任務（顯式 [pipeline:full] 確保完整 9 階段）
    const classifyResult = runHook('task-classifier', {
      session_id: sid,
      prompt: '建立完整的 REST API server，包含使用者認證 [pipeline:full]',
    });

    test('B1: task-classifier 分類為 feature', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'feature');
    });

    test('B2: pipelineEnforced 啟動', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineEnforced, true);
    });

    test('B3: expectedStages 含完整 9 階段', () => {
      const state = readState(sid);
      assert.strictEqual(state.expectedStages.length, 9);
      assert.strictEqual(state.expectedStages[0], 'PLAN');
      assert.strictEqual(state.expectedStages[8], 'DOCS');
    });

    test('B4: task-classifier 輸出 systemMessage（pipeline 規則）', () => {
      assert.ok(classifyResult.json);
      assert.ok(classifyResult.json.systemMessage, '應有 systemMessage');
      assert.ok(classifyResult.json.systemMessage.includes('⛔'));
      assert.ok(classifyResult.json.systemMessage.includes('禁止'));
    });

    // Step 3: pipeline-guard 應阻擋 Main Agent 的 Write
    const gateBlock = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('B5: pipeline-guard 阻擋 Main Agent 直接 Write', () => {
      assert.strictEqual(gateBlock.exitCode, 2);
      assert.ok(gateBlock.stderr.includes('⛔'));
    });

    // Step 4: delegation-tracker 設定 delegationActive
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:planner' },
    });

    test('B6: delegation-tracker 設定 delegationActive=true', () => {
      const state = readState(sid);
      assert.strictEqual(state.delegationActive, true);
    });

    // Step 5: pipeline-guard 放行 sub-agent 的 Write
    const gateAllow = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('B7: pipeline-guard 放行（delegationActive=true）', () => {
      assert.strictEqual(gateAllow.exitCode, 0);
    });

    // Step 6: stage-transition（planner 完成）
    const transResult = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:planner',
      stop_hook_active: false,
    });

    test('B8: stage-transition 記錄 planner 完成', () => {
      const state = readState(sid);
      assert.ok(state.completed.includes('vibe:planner'));
    });

    test('B9: stage-transition 重設 delegationActive=false', () => {
      const state = readState(sid);
      assert.strictEqual(state.delegationActive, false);
    });

    test('B10: stage-transition 指示下一階段 ARCH', () => {
      assert.ok(transResult.json);
      assert.ok(transResult.json.systemMessage);
      assert.ok(transResult.json.systemMessage.includes('architect'));
    });

    // Step 7: pipeline-guard 再次阻擋（delegation 已重設）
    const gateBlock2 = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/component.tsx' },
    });

    test('B11: pipeline-guard 再次阻擋（delegation 已重設）', () => {
      assert.strictEqual(gateBlock2.exitCode, 2);
    });

    // Step 8: 模擬完成所有階段直到 pipeline-check
    // 補齊其餘 agent 完成紀錄 + stageIndex（pipeline-check 用 stageIndex 判斷完成度）
    const state = readState(sid);
    state.completed = [
      'vibe:planner', 'vibe:architect', 'vibe:designer', 'vibe:developer',
      'vibe:code-reviewer', 'vibe:tester', 'vibe:qa',
      'vibe:e2e-runner', 'vibe:doc-updater',
    ];
    state.stageIndex = state.expectedStages.length - 1; // 最後一個階段的索引
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state, null, 2)
    );

    // pipeline-check 應該報告全部完成
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('B12: pipeline-check 全部完成後清理 state file', () => {
      // pipeline-check 完成時刪除 state file
      assert.strictEqual(checkResult.exitCode, 0);
      const afterState = readState(sid);
      assert.strictEqual(afterState, null, 'state file 應已刪除');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario C: Cancel 逃生口');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-cancel-1';
  try {
    // Step 1: 模擬進行中的 feature pipeline
    initState(sid, {
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
      completed: ['vibe:planner'],
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    });

    // Step 2: pipeline-guard 阻擋
    const gateBlock = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('C1: 取消前 pipeline-guard 阻擋', () => {
      assert.strictEqual(gateBlock.exitCode, 2);
    });

    // Step 3: 模擬 /vibe:cancel（重設 pipeline flags）
    const state = readState(sid);
    state.pipelineEnforced = false;
    state.delegationActive = false;
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state, null, 2)
    );

    // Step 4: pipeline-guard 放行
    const gateAllow = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('C2: cancel 後 pipeline-guard 放行', () => {
      assert.strictEqual(gateAllow.exitCode, 0);
    });

    // Step 5: 驗證歷史記錄保留
    test('C3: cancel 後完成記錄保留', () => {
      const finalState = readState(sid);
      assert.ok(finalState.completed.includes('vibe:planner'));
      assert.strictEqual(finalState.expectedStages.length, 9);
    });

    // Step 6: pipeline-check 也不再檢查（pipelineEnforced=false）
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('C4: cancel 後 pipeline-check 不再提醒', () => {
      assert.strictEqual(checkResult.exitCode, 0);
      // 不應有 systemMessage（因為 pipelineEnforced=false）
      if (checkResult.json) {
        assert.strictEqual(checkResult.json.systemMessage, undefined);
      }
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario D: 任務升級（quickfix → feature）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-upgrade-1';
  try {
    // Step 1: 初始化 + 首次分類為 quickfix
    initState(sid);
    runHook('task-classifier', {
      session_id: sid,
      prompt: '改一下按鈕顏色',
    });

    test('D1: 初始分類為 quickfix', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'quickfix');
      assert.strictEqual(state.pipelineEnforced, false);
    });

    // Step 2: 第二次 prompt 升級為 feature
    const upgradeResult = runHook('task-classifier', {
      session_id: sid,
      prompt: '建立完整的使用者認證系統',
    });

    test('D2: 升級為 feature', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'feature');
      assert.strictEqual(state.pipelineEnforced, true);
    });

    test('D3: 升級後有 reclassifications 記錄', () => {
      const state = readState(sid);
      assert.ok(state.reclassifications);
      assert.strictEqual(state.reclassifications.length, 1);
      assert.strictEqual(state.reclassifications[0].from, 'fix');      // pipeline ID（非 taskType）
      assert.strictEqual(state.reclassifications[0].to, 'standard');   // pipeline ID（非 taskType）
    });

    test('D4: 升級輸出 systemMessage', () => {
      assert.ok(upgradeResult.json);
      assert.ok(upgradeResult.json.systemMessage);
      assert.ok(upgradeResult.json.systemMessage.includes('Pipeline 升級'));
    });

    // Step 3: pipeline-guard 此時應阻擋
    const gateResult = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('D5: 升級後 pipeline-guard 阻擋', () => {
      assert.strictEqual(gateResult.exitCode, 2);
    });

    // Step 4: 降級應被忽略（需設 lastTransition 避免 stale 重設）
    const stateBeforeDowngrade = readState(sid);
    stateBeforeDowngrade.lastTransition = new Date().toISOString();
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(stateBeforeDowngrade, null, 2)
    );

    runHook('task-classifier', {
      session_id: sid,
      prompt: '查看一下測試狀態',
    });

    test('D6: 降級（feature → research）被忽略（非過時 pipeline）', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'feature', '維持 feature 不降級');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario E: Stage-transition 回退機制');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-retry-1';
  try {
    // 建立到 REVIEW 階段的 state
    initState(sid, {
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
      completed: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    });

    // 模擬 code-reviewer 完成但無 verdict
    const transResult = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      stop_hook_active: false,
    });

    test('E1: 無 verdict 時正常前進（不回退）', () => {
      assert.ok(transResult.json);
      assert.ok(transResult.json.systemMessage);
      // 應指示下一個 stage（TEST）
      assert.ok(
        transResult.json.systemMessage.includes('tester') ||
        transResult.json.systemMessage.includes('TEST'),
        '應指示 TEST 階段'
      );
    });

    test('E2: code-reviewer 記錄為完成', () => {
      const state = readState(sid);
      assert.ok(state.completed.includes('vibe:code-reviewer'));
    });

    test('E3: stageResults 記錄 UNKNOWN', () => {
      const state = readState(sid);
      assert.strictEqual(state.stageResults.REVIEW.verdict, 'UNKNOWN');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario F: Pipeline-check 遺漏偵測');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-check-1';
  try {
    // 只完成 PLAN 和 ARCH
    initState(sid, {
      taskType: 'feature',
      pipelineEnforced: true,
      completed: ['vibe:planner', 'vibe:architect'],
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    });

    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('F1: 偵測到遺漏階段（硬阻擋）', () => {
      assert.ok(checkResult.json);
      assert.strictEqual(checkResult.json.decision, 'block');
      assert.ok(checkResult.json.reason.includes('Pipeline 未完成'));
    });

    test('F2: 遺漏提示包含 namespaced agent', () => {
      const msg = checkResult.json.reason;
      assert.ok(msg.includes('/vibe:dev') || msg.includes('developer'));
    });

    test('F3: decision=block（硬阻擋，強制繼續完成遺漏階段）', () => {
      assert.strictEqual(checkResult.json.decision, 'block');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario G: pipeline-guard 非程式碼檔案放行（pipeline 啟動中）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-noncode-1';
  try {
    initState(sid, {
      taskType: 'feature',
      pipelineEnforced: true,
      delegationActive: false,
    });

    const exts = [
      { file: 'README.md', ext: '.md' },
      { file: 'package.json', ext: '.json' },
      { file: '.github/workflows/ci.yml', ext: '.yml' },
      { file: 'styles/main.css', ext: '.css' },
      { file: 'index.html', ext: '.html' },
    ];

    for (const { file, ext } of exts) {
      const result = runHook('pipeline-guard', {
        session_id: sid,
        tool_name: 'Write',
        tool_input: { file_path: file },
      });

      test(`G: 放行非程式碼檔案 ${ext} (${file})`, () => {
        assert.strictEqual(result.exitCode, 0);
      });
    }

    // 程式碼檔案應阻擋
    const codeExts = ['src/app.js', 'src/index.ts', 'src/App.tsx', 'main.py', 'main.go'];
    for (const file of codeExts) {
      const result = runHook('pipeline-guard', {
        session_id: sid,
        tool_name: 'Write',
        tool_input: { file_path: file },
      });

      test(`G: 阻擋程式碼檔案 ${path.extname(file)} (${file})`, () => {
        assert.strictEqual(result.exitCode, 2);
      });
    }
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario H: 完整 lifecycle（classify → delegate → transition × 3）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-lifecycle-1';
  try {
    // Step 1: 初始化 + 分類
    initState(sid);
    runHook('task-classifier', {
      session_id: sid,
      prompt: '實作使用者認證系統',
    });

    test('H1: 分類為 feature + pipeline 啟動', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'feature');
      assert.strictEqual(state.pipelineEnforced, true);
    });

    // Step 2-4: 模擬 3 個 agent 的 delegate → complete 循環
    const agents = [
      { type: 'vibe:planner', nextKeyword: 'architect' },
      { type: 'vibe:architect', nextKeyword: '/vibe:dev' },
      { type: 'vibe:developer', nextKeyword: 'REVIEW' },  // skill-based: /vibe:review
    ];

    for (const { type, nextKeyword } of agents) {
      // delegation-tracker
      runHook('delegation-tracker', {
        session_id: sid,
        tool_name: 'Task',
        tool_input: { subagent_type: type },
      });

      const stateAfterDelegate = readState(sid);
      test(`H: ${type} delegation → delegationActive=true`, () => {
        assert.strictEqual(stateAfterDelegate.delegationActive, true);
      });

      // stage-transition
      const trans = runHook('stage-transition', {
        session_id: sid,
        agent_type: type,
        stop_hook_active: false,
      });

      const stateAfterTrans = readState(sid);
      test(`H: ${type} complete → delegationActive=false`, () => {
        assert.strictEqual(stateAfterTrans.delegationActive, false);
      });

      test(`H: ${type} complete → 指示 ${nextKeyword}`, () => {
        assert.ok(trans.json.systemMessage.includes(nextKeyword));
      });
    }

    // 驗證最終 completed 列表
    test('H: 3 個 agent 全部記錄在 completed', () => {
      const state = readState(sid);
      assert.ok(state.completed.includes('vibe:planner'));
      assert.ok(state.completed.includes('vibe:architect'));
      assert.ok(state.completed.includes('vibe:developer'));
      assert.strictEqual(state.completed.length, 3);
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario I: 回退重驗流程
// REVIEW FAIL:CRITICAL → DEV 修復 → 重跑 REVIEW（不跳到 TEST）
// ═══════════════════════════════════════════════

console.log('\n🔄 Scenario I: 回退重驗（REVIEW FAIL → DEV fix → re-REVIEW）');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-retry-revalidation';
  try {
    // 初始化 — feature pipeline，DEV 已完成
    initState(sid, {
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      pipelineEnforced: true,
      completed: ['vibe:developer'],
    });

    // Step 1: REVIEW 完成，verdict FAIL:CRITICAL
    // 模擬帶 verdict 的 transcript
    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '發現問題 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    const r1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('I1: REVIEW FAIL:CRITICAL → 回退訊息包含 pendingRetry', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      assert.ok(r1.json.systemMessage.includes('Pipeline 回退'), '訊息應包含 Pipeline 回退');
      assert.ok(r1.json.systemMessage.includes('DEV'), '訊息應指示回到 DEV');
    });

    test('I2: state 寫入 pendingRetry 標記', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stage, 'REVIEW');
      assert.strictEqual(s.pendingRetry.severity, 'CRITICAL');
      assert.strictEqual(s.pendingRetry.round, 1);
    });

    test('I3: retries 計數正確', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.REVIEW, 1);
    });

    // Step 2: DEV 修復完成（無 verdict — DEV 不產生 verdict）
    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('I4: DEV 修復後 → 回退重驗訊息（非正常前進）', () => {
      assert.ok(r2.json && r2.json.systemMessage, '應有 systemMessage');
      assert.ok(r2.json.systemMessage.includes('回退重驗'), '訊息應包含「回退重驗」');
      assert.ok(r2.json.systemMessage.includes('REVIEW'), '應指示重跑 REVIEW');
    });

    test('I5: 回退重驗訊息禁止跳到其他階段', () => {
      assert.ok(r2.json.systemMessage.includes('不可跳過'), '應包含不可跳過');
      assert.ok(r2.json.systemMessage.includes('不可跳到其他階段'), '應包含不可跳到其他階段');
    });

    test('I6: 回退重驗訊息禁止 AskUserQuestion', () => {
      assert.ok(r2.json.systemMessage.includes('AskUserQuestion'), '應提及禁止 AskUserQuestion');
    });

    test('I7: pendingRetry 被消費（清除）', () => {
      const s = readState(sid);
      assert.strictEqual(s.pendingRetry, undefined, 'pendingRetry 應被刪除');
    });

    // Step 3: 第二次 REVIEW 完成，verdict PASS → 正常前進到 TEST
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '品質良好 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r3 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('I8: 第二次 REVIEW PASS → 正常前進到 TEST', () => {
      assert.ok(r3.json && r3.json.systemMessage, '應有 systemMessage');
      assert.ok(r3.json.systemMessage.includes('TEST'), '應指示前進到 TEST');
      assert.ok(!r3.json.systemMessage.includes('回退重驗'), '不應包含回退重驗');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario J: Trivial 分類優先順序（regex 交叉匹配邊界）
// 驗證 trivial regex 移到 research 之前後，各種衝突場景的正確分類
// ═══════════════════════════════════════════════

console.log('\n🎯 Scenario J: Trivial 分類優先順序（regex 交叉匹配）');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-trivial-priority';
  try {
    // J1-J3: Trivial + Research 衝突 — trivial 應優先
    const trivialResearchCases = [
      { prompt: '做一個 poc 測試看看', note: 'poc(trivial) + 看看(research)' },
      { prompt: 'scaffold 一個新專案', note: 'scaffold(trivial)' },
      { prompt: '簡單的範例 demo', note: '簡單的 範例(trivial)' },
    ];

    for (let i = 0; i < trivialResearchCases.length; i++) {
      const { prompt, note } = trivialResearchCases[i];
      initState(sid);
      runHook('task-classifier', { session_id: sid, prompt });

      test(`J${i + 1}: trivial 優先 — ${note}`, () => {
        const state = readState(sid);
        assert.strictEqual(state.taskType, 'quickfix');
        assert.strictEqual(state.pipelineEnforced, false);
      });
    }

    // J4-J5: Trivial + Feature 衝突 — trivial 意圖明確時應優先
    const trivialFeatureCases = [
      { prompt: '建立 hello world express server', note: 'hello world(trivial) > 建立 server(feature)' },
      { prompt: 'develop a prototype app', note: 'prototype(trivial) > develop(feature)' },
    ];

    for (let i = 0; i < trivialFeatureCases.length; i++) {
      const { prompt, note } = trivialFeatureCases[i];
      initState(sid);
      runHook('task-classifier', { session_id: sid, prompt });

      test(`J${i + 4}: trivial > feature — ${note}`, () => {
        const state = readState(sid);
        assert.strictEqual(state.taskType, 'quickfix');
      });
    }

    // J6-J8: 純 Research 不被 trivial 影響（迴歸驗證）
    const pureResearchCases = [
      { prompt: '查看目前的架構', note: '查看(research)，無 trivial 關鍵字' },
      { prompt: '這個 API 是什麼？', note: '是什麼(research)' },
      { prompt: 'how does this work?', note: 'how(research)' },
    ];

    for (let i = 0; i < pureResearchCases.length; i++) {
      const { prompt, note } = pureResearchCases[i];
      initState(sid);
      runHook('task-classifier', { session_id: sid, prompt });

      test(`J${i + 6}: research 迴歸 — ${note}`, () => {
        const state = readState(sid);
        assert.strictEqual(state.taskType, 'research');
      });
    }

    // J9-J10: 純 Feature 不被影響（迴歸驗證）
    const pureFeatureCases = [
      { prompt: '建立完整的使用者認證系統', note: '建立...系統(feature)，無 trivial' },
      { prompt: 'implement user authentication', note: 'implement(feature)' },
    ];

    for (let i = 0; i < pureFeatureCases.length; i++) {
      const { prompt, note } = pureFeatureCases[i];
      initState(sid);
      runHook('task-classifier', { session_id: sid, prompt });

      test(`J${i + 9}: feature 迴歸 — ${note}`, () => {
        const state = readState(sid);
        assert.strictEqual(state.taskType, 'feature');
        assert.strictEqual(state.pipelineEnforced, true);
      });
    }

    // J11: Trivial 任務 pipeline-guard 不阻擋（完整 hook 鏈驗證）
    initState(sid);
    runHook('task-classifier', { session_id: sid, prompt: '做一個 poc 測試看看' });

    const gateResult = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/poc.ts' },
    });

    test('J11: trivial(poc+看看) → pipeline-guard 放行寫碼', () => {
      assert.strictEqual(gateResult.exitCode, 0);
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario K: 手動 scope/architect 後自動 enforce pipeline
// 驗證：task-classifier 初始分類為 quickfix，但 PLAN+ARCH 完成後
// stage-transition 自動設定 pipelineEnforced=true，pipeline-guard 阻擋 Main Agent
// ═══════════════════════════════════════════════

console.log('\n🔒 Scenario K: 手動 scope/architect 後自動 enforce pipeline');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-auto-enforce';
  try {
    // 模擬初始分類為 quickfix（使用者說「開始規劃」不匹配 feature regex）
    initState(sid, {
      taskType: 'quickfix',
      pipelineEnforced: false,
      expectedStages: ['DEV'],
    });

    test('K1: 初始狀態 pipelineEnforced=false', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineEnforced, false);
      assert.strictEqual(state.taskType, 'quickfix');
    });

    // 模擬手動 /vibe:scope → planner agent 完成
    // delegation-tracker 設定 delegationActive
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:planner' },
    });

    // planner 完成 → stage-transition 觸發
    const t1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:planner',
      stop_hook_active: false,
    });

    test('K2: planner 完成後，指示下一步 ARCH', () => {
      assert.ok(t1.json && t1.json.systemMessage);
      assert.ok(
        t1.json.systemMessage.includes('architect') ||
        t1.json.systemMessage.includes('ARCH'),
        '應指示 ARCH 階段'
      );
    });

    test('K3: planner 完成後，pipelineEnforced 仍為 false（PLAN→ARCH 不觸發 enforce）', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineEnforced, false);
    });

    // 模擬手動 /vibe:architect → architect agent 完成
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:architect' },
    });

    const t2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:architect',
      stop_hook_active: false,
    });

    test('K4: architect 完成後，指示下一步 DEV', () => {
      assert.ok(t2.json && t2.json.systemMessage);
      assert.ok(
        t2.json.systemMessage.includes('developer') ||
        t2.json.systemMessage.includes('DEV'),
        '應指示 DEV 階段'
      );
    });

    test('K5: architect 完成後，pipelineEnforced 自動升級為 true', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineEnforced, true);
    });

    test('K6: taskType 自動升級為 feature', () => {
      const state = readState(sid);
      assert.strictEqual(state.taskType, 'feature');
    });

    test('K7: expectedStages 自動補全', () => {
      const state = readState(sid);
      assert.ok(state.expectedStages.length > 2, '應有完整的階段列表');
      assert.ok(state.expectedStages.includes('DEV'));
      assert.ok(state.expectedStages.includes('REVIEW'));
    });

    // 現在 pipeline-guard 應該阻擋 Main Agent 直接寫碼
    const gate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/timeline.js' },
    });

    test('K8: 自動 enforce 後，pipeline-guard 阻擋 Main Agent 寫碼（exit 2）', () => {
      assert.strictEqual(gate.exitCode, 2);
    });

    // 但 delegation 後應該放行
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const gateAfterDelegate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/timeline.js' },
    });

    test('K9: delegation 後 pipeline-guard 放行（sub-agent 可寫碼）', () => {
      assert.strictEqual(gateAfterDelegate.exitCode, 0);
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario L: pipeline-guard — Pipeline 模式下阻擋 AskUserQuestion
// 驗證：pipelineEnforced=true 時 AskUserQuestion 被硬阻擋（exit 2）
// ═══════════════════════════════════════════════

console.log('\n⛔ Scenario L: pipeline-guard — Pipeline 自動閉環（阻擋 AskUserQuestion）');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-pipeline-guard-ask';
  try {
    const askInput = {
      session_id: sid,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '下一步？', options: [] }] },
    };

    // L1: 無 state → 放行
    cleanState(sid);
    const r1 = runHook('pipeline-guard', askInput);
    test('L1: 無 pipeline state → pipeline-guard 放行', () => {
      assert.strictEqual(r1.exitCode, 0);
    });

    // L2: pipelineEnforced=false → 放行
    initState(sid, { taskType: 'quickfix', pipelineEnforced: false });
    const r2 = runHook('pipeline-guard', askInput);
    test('L2: pipelineEnforced=false → pipeline-guard 放行', () => {
      assert.strictEqual(r2.exitCode, 0);
    });

    // L3: pipelineEnforced=true → 阻擋（exit 2）
    initState(sid, { taskType: 'feature', pipelineEnforced: true, expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW'] });
    const r3 = runHook('pipeline-guard', askInput);
    test('L3: pipelineEnforced=true → pipeline-guard 阻擋（exit 2）', () => {
      assert.strictEqual(r3.exitCode, 2);
    });

    test('L4: 阻擋訊息包含 /vibe:cancel 逃生口', () => {
      assert.ok(r3.stderr.includes('cancel'), '應提示 /vibe:cancel 退出方式');
    });

    test('L5: 阻擋訊息說明 pipeline 自動模式', () => {
      assert.ok(r3.stderr.includes('自動'), '應提及自動模式');
    });

    // L6: cancelled=true → 放行
    initState(sid, { taskType: 'feature', pipelineEnforced: true, cancelled: true });
    const r4 = runHook('pipeline-guard', askInput);
    test('L6: pipeline 已取消（cancelled=true）→ pipeline-guard 放行', () => {
      assert.strictEqual(r4.exitCode, 0);
    });

    // L7: 完整 hook 鏈 — feature pipeline + pipeline-guard 阻擋 AskUserQuestion 和 Write
    initState(sid, { taskType: 'feature', pipelineEnforced: true, expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV'] });

    const askGate = runHook('pipeline-guard', askInput);
    const writeGate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('L7: feature pipeline 同時阻擋 AskUserQuestion 和 Write', () => {
      assert.strictEqual(askGate.exitCode, 2, 'pipeline-guard 應阻擋 AskUserQuestion');
      assert.strictEqual(writeGate.exitCode, 2, 'pipeline-guard 應阻擋 Write');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario M: pipeline-guard 白名單測試
// 驗證：EnterPlanMode 阻擋、cancelled 放行、NotebookEdit 支援
// ═══════════════════════════════════════════════

console.log('\n🔐 Scenario M: pipeline-guard 白名單與擴充工具');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-whitelist';
  try {
    // M1: EnterPlanMode 阻擋
    initState(sid, { taskType: 'feature', pipelineEnforced: true });
    const planMode = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M1: pipelineEnforced=true → 阻擋 EnterPlanMode', () => {
      assert.strictEqual(planMode.exitCode, 2);
      assert.ok(planMode.stderr.includes('EnterPlanMode'));
      assert.ok(planMode.stderr.includes('vibe:planner'));
      assert.ok(planMode.stderr.includes('/vibe:scope'));
    });

    // M2: cancelled=true 後 EnterPlanMode 也放行
    initState(sid, { taskType: 'feature', pipelineEnforced: true, cancelled: true });
    const planModeAfterCancel = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M2: cancelled=true → EnterPlanMode 放行', () => {
      assert.strictEqual(planModeAfterCancel.exitCode, 0);
    });

    // M3: NotebookEdit 支援（程式碼檔案阻擋）
    initState(sid, { taskType: 'feature', pipelineEnforced: true });
    const notebook = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'notebook.ipynb' },
    });

    test('M3: NotebookEdit 程式碼檔案 → 阻擋', () => {
      assert.strictEqual(notebook.exitCode, 2);
      assert.ok(notebook.stderr.includes('NotebookEdit'));
    });

    // M4: NotebookEdit 非程式碼檔案（.json）放行
    const notebookNonCode = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'config.json' },
    });

    test('M4: NotebookEdit 非程式碼檔案 → 放行', () => {
      assert.strictEqual(notebookNonCode.exitCode, 0);
    });

    // M5: delegationActive=true 時 EnterPlanMode 也放行（實際不會發生，但邏輯覆蓋）
    initState(sid, { taskType: 'feature', pipelineEnforced: true, delegationActive: true });
    const planModeDelegate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M5: delegationActive=true → EnterPlanMode 放行（統一 delegation 白名單）', () => {
      assert.strictEqual(planModeDelegate.exitCode, 0);
    });

    // M6: pipelineEnforced=false 時所有工具放行
    initState(sid, { taskType: 'quickfix', pipelineEnforced: false });
    const allTools = [
      { tool: 'Write', input: { file_path: 'src/app.js' } },
      { tool: 'Edit', input: { file_path: 'src/component.tsx' } },
      { tool: 'NotebookEdit', input: { file_path: 'notebook.ipynb' } },
      { tool: 'AskUserQuestion', input: {} },
      { tool: 'EnterPlanMode', input: {} },
    ];

    for (const { tool, input } of allTools) {
      const result = runHook('pipeline-guard', {
        session_id: sid,
        tool_name: tool,
        tool_input: input,
      });

      test(`M6: pipelineEnforced=false → ${tool} 放行`, () => {
        assert.strictEqual(result.exitCode, 0);
      });
    }
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario N: pipeline-check pendingRetry 優先（v1.0.43 修復）
// 驗證：REVIEW FAIL → DEV 修復後，pipeline-check 的 block 訊息
//       應以 REVIEW 為第一優先（而非跳到 TEST）
// ═══════════════════════════════════════════════

console.log('\n🔄 Scenario N: pipeline-check pendingRetry 優先');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-pending-retry-check';
  try {
    // 模擬 REVIEW FAIL → DEV 修復後的 state
    // pendingRetry 標記存在，表示 REVIEW 需要重跑
    initState(sid, {
      taskType: 'feature',
      pipelineId: 'full',
      pipelineEnforced: true,
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['vibe:planner', 'vibe:architect', 'vibe:developer', 'vibe:code-reviewer'],
      stageResults: {
        PLAN: { verdict: 'PASS' },
        ARCH: { verdict: 'PASS' },
        DEV: { verdict: 'UNKNOWN' },
        REVIEW: { verdict: 'FAIL', severity: 'CRITICAL' },
      },
      stageIndex: 4, // REVIEW 完成位置
      pendingRetry: { stage: 'REVIEW', severity: 'CRITICAL', round: 1 },
      retries: { REVIEW: 1 },
    });

    // pipeline-check 的 block 訊息應以 REVIEW 為首
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N1: pipeline-check 回應 decision=block', () => {
      assert.ok(checkResult.json);
      assert.strictEqual(checkResult.json.decision, 'block');
    });

    test('N2: block 訊息第一個遺漏階段是 REVIEW（pendingRetry 優先）', () => {
      const reason = checkResult.json.reason;
      // 「缺：REVIEW（...）, TEST（...）, ...」— REVIEW 應在 TEST 前面
      const reviewIdx = reason.indexOf('REVIEW');
      const testIdx = reason.indexOf('TEST');
      assert.ok(reviewIdx >= 0, 'block 訊息應包含 REVIEW');
      assert.ok(testIdx >= 0, 'block 訊息應包含 TEST');
      assert.ok(reviewIdx < testIdx, 'REVIEW 應在 TEST 前面（pendingRetry 優先）');
    });

    test('N3: REVIEW 不會重複出現在 missing 列表中', () => {
      const reason = checkResult.json.reason;
      // 計算 REVIEW 在 「缺：」 後面出現的次數
      const missingSection = reason.split('缺：')[1] || '';
      const matches = missingSection.match(/REVIEW/g) || [];
      // REVIEW 應只出現一次作為 stage 名稱（在 missingLabels 中）
      // 加上 missingHints 中可能再提一次 → 最多 2 次
      assert.ok(matches.length <= 2, `REVIEW 不應重複出現：找到 ${matches.length} 次`);
    });

    // N4: 沒有 pendingRetry 時，TEST 在 REVIEW 前面（因為用 stageIndex 計算）
    const state = readState(sid);
    delete state.pendingRetry;
    // stageIndex=4 → slice(5) 從 TEST 開始，REVIEW 不在 missing 中
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state, null, 2)
    );

    const checkResult2 = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N4: 無 pendingRetry 時，遺漏列表按 stageIndex 正常計算', () => {
      assert.ok(checkResult2.json);
      assert.strictEqual(checkResult2.json.decision, 'block');
      const reason = checkResult2.json.reason;
      // stageIndex=4（REVIEW）→ slice(5) = TEST, QA, E2E, DOCS
      assert.ok(reason.includes('TEST'), '應包含 TEST');
      // REVIEW 不在遺漏中（stageIndex 計算跳過已完成的）
    });

    // N5: pendingRetry stage 不在 stageIndex 計算的 missing 中 → unshift 新增
    const state2 = readState(sid);
    state2.pendingRetry = { stage: 'REVIEW', severity: 'HIGH', round: 1 };
    state2.stageIndex = 4; // REVIEW 位置
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state2, null, 2)
    );

    const checkResult3 = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N5: pendingRetry stage 不在 missing 時也會被 unshift', () => {
      assert.ok(checkResult3.json);
      const reason = checkResult3.json.reason;
      const reviewIdx = reason.indexOf('REVIEW');
      assert.ok(reviewIdx >= 0, 'REVIEW 應被 unshift 到 missing');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario O: task-classifier stale pipeline 重設（v1.0.43 修復）
// 驗證：過時的 enforced pipeline 在降級分類時自動重設
// ═══════════════════════════════════════════════

console.log('\n🕰️ Scenario O: task-classifier stale pipeline 重設');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'e2e-stale-pipeline';
  try {
    // O1: 過時 pipeline（lastTransition 超過 10 分鐘）+ 降級 → 應重設
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 分鐘前
    initState(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      pipelineEnforced: true,
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['vibe:planner'],
      stageResults: {},
      lastTransition: staleTime,
    });

    // 降級分類（research 任務）
    const r1 = runHook('task-classifier', {
      session_id: sid,
      prompt: '查看目前的程式碼結構',
    });

    test('O1: 過時 pipeline + 降級 → 重設為新分類', () => {
      const state = readState(sid);
      assert.notStrictEqual(state.pipelineId, 'standard', '應重設 pipeline');
      assert.strictEqual(state.pipelineEnforced, false, 'research 不 enforce');
    });

    test('O2: 重設後 completed 被清空', () => {
      const state = readState(sid);
      assert.deepStrictEqual(state.completed, [], 'completed 應為空');
    });

    test('O3: 重設後 pendingRetry 被清除', () => {
      const state = readState(sid);
      assert.strictEqual(state.pendingRetry, false, 'pendingRetry 應為 false');
    });

    // O4: 新鮮 pipeline（lastTransition 剛剛）+ 降級 → 不應重設
    const freshTime = new Date().toISOString(); // 現在
    initState(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      pipelineEnforced: true,
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['vibe:planner', 'vibe:architect'],
      stageResults: {},
      lastTransition: freshTime,
    });

    runHook('task-classifier', {
      session_id: sid,
      prompt: '這段程式碼是什麼意思？',
    });

    test('O4: 新鮮 pipeline + 降級 → 保持原 pipeline', () => {
      const state = readState(sid);
      assert.strictEqual(state.pipelineId, 'standard', '應保持 standard');
      assert.strictEqual(state.pipelineEnforced, true, '應保持 enforced');
    });

    test('O5: 原 completed 記錄保留', () => {
      const state = readState(sid);
      assert.ok(state.completed.includes('vibe:planner'), 'planner 應保留');
      assert.ok(state.completed.includes('vibe:architect'), 'architect 應保留');
    });

    // O6: 無 lastTransition 欄位（舊格式 state）→ 視為過時
    initState(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      pipelineEnforced: true,
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['vibe:planner'],
      stageResults: {},
      // 故意不設 lastTransition
    });

    runHook('task-classifier', {
      session_id: sid,
      prompt: '看看這個 API 怎麼用',
    });

    test('O6: 無 lastTransition → 視為過時，降級重設', () => {
      const state = readState(sid);
      assert.notStrictEqual(state.pipelineId, 'standard', '應重設');
      assert.strictEqual(state.pipelineEnforced, false);
    });

    // O7: 已完成的 pipeline + 降級 → 正常流程（isPipelineComplete 先觸發重設）
    initState(sid, {
      pipelineId: 'fix',
      taskType: 'quickfix',
      pipelineEnforced: false,
      expectedStages: ['DEV'],
      completed: ['vibe:developer'],
      stageResults: { DEV: { verdict: 'PASS' } },
      lastTransition: staleTime,
    });

    runHook('task-classifier', {
      session_id: sid,
      prompt: '這是什麼？',
    });

    test('O7: 已完成 pipeline → isPipelineComplete 先重設，新分類正常套用', () => {
      const state = readState(sid);
      // isPipelineComplete 先清除 pipelineId → 進入初始分類路徑
      assert.strictEqual(state.taskType, 'research');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

console.log('\n' + '='.repeat(55));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
