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

// v3 state 工具
const { createV3State, writeV3State, cleanTestStateFiles } = require('./test-helpers');
const { derivePhase } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'dag-state.js'));

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

// ─── 輔助函式 ─────────────────────────────

/**
 * 初始化 pipeline state（v3 格式）
 * v2 state 會被 hooks 自動遷移為 v3，但直接建立 v3 更可靠。
 * 無 DAG 的空白初始 state（模擬 pipeline-init hook）
 */
function initState(sessionId, opts = {}) {
  writeV3State(sessionId, opts);
  return path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
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

    // Step 2: task-classifier 分類 trivial 任務（顯式 [pipeline:fix] 建立 DAG）
    const classifyResult = runHook('task-classifier', {
      session_id: sid,
      prompt: '建立一個簡單的 hello world HTTP server [pipeline:fix]',
    });

    test('A1: task-classifier 分類 trivial 為 quickfix', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.taskType, 'quickfix');
    });

    test('A2: DAG 已建立（enforced）', () => {
      const state = readState(sid);
      assert.ok(state.dag, 'DAG 應存在');
      assert.strictEqual(state.enforced, true);
      const phase = derivePhase(state);
      assert.ok(['CLASSIFIED', 'DELEGATING', 'RETRYING'].includes(phase));
    });

    test('A3: DAG 僅含 DEV', () => {
      const state = readState(sid);
      assert.deepStrictEqual(Object.keys(state.dag), ['DEV']);
    });

    test('A4: task-classifier 輸出 systemMessage（enforced pipeline）', () => {
      assert.strictEqual(classifyResult.exitCode, 0);
      assert.ok(classifyResult.json);
      assert.ok(classifyResult.json.systemMessage, '應有 systemMessage');
    });

    // Step 3: pipeline-guard 應阻擋（enforced=true + DAG 存在）
    const gateResult = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.js' },
    });

    test('A5: pipeline-guard 阻擋 trivial 任務的 Write（必須委派）', () => {
      assert.strictEqual(gateResult.exitCode, 2);
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
      assert.strictEqual(state.classification.taskType, 'feature');
    });

    test('B2: DAG 已建立（enforced）', () => {
      const state = readState(sid);
      assert.ok(state.dag, 'DAG 應存在');
      assert.strictEqual(state.enforced, true);
      const phase = derivePhase(state);
      assert.ok(['CLASSIFIED', 'DELEGATING', 'RETRYING'].includes(phase));
    });

    test('B3: DAG 含完整階段（DESIGN 可能被跳過）', () => {
      const state = readState(sid);
      const dagKeys = Object.keys(state.dag);
      // full pipeline: PLAN→ARCH→DESIGN→DEV→REVIEW→TEST→QA→E2E→DOCS
      // DESIGN 可能被跳過（skip-predicates: 純後端專案），但 DAG 中仍有定義
      assert.strictEqual(dagKeys.length, 9);
      assert.strictEqual(dagKeys[0], 'PLAN');
      assert.strictEqual(dagKeys[8], 'DOCS');
    });

    test('B4: task-classifier 輸出 systemMessage（pipeline 已建立）', () => {
      assert.ok(classifyResult.json);
      assert.ok(classifyResult.json.systemMessage, '應有 systemMessage');
      assert.ok(classifyResult.json.systemMessage.includes('⛔'));
      assert.ok(classifyResult.json.systemMessage.includes('已建立'));
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

    test('B6: delegation-tracker 設定 PLAN stage 為 active', () => {
      const state = readState(sid);
      const phase = derivePhase(state);
      assert.strictEqual(phase, 'DELEGATING');
      assert.strictEqual(state.stages.PLAN.status, 'active');
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

    test('B8: stage-transition 記錄 PLAN 完成', () => {
      const state = readState(sid);
      assert.strictEqual(state.stages.PLAN.status, 'completed');
    });

    test('B9: stage-transition 後 phase 非 DELEGATING', () => {
      const state = readState(sid);
      const phase = derivePhase(state);
      assert.notStrictEqual(phase, 'DELEGATING');
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
    // v3: 直接設定所有 stages 為 completed
    const state = readState(sid);
    for (const stageId of Object.keys(state.dag || {})) {
      state.stages[stageId] = {
        status: 'completed', agent: null, verdict: null,
        completedAt: new Date().toISOString(),
      };
    }
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state, null, 2)
    );

    // pipeline-check 應該報告全部完成
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('B12: pipeline-check 全部完成後 state 保留', () => {
      // pipeline-check 不再刪除 state（由 session-cleanup 3 天後過期清理）
      assert.strictEqual(checkResult.exitCode, 0);
      const afterState = readState(sid);
      assert.ok(afterState !== null, 'state file 應保留供 Dashboard/驗證/分析');
      const phase = derivePhase(afterState);
      assert.strictEqual(phase, 'COMPLETE');
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
    // Step 1: 模擬進行中的 feature pipeline（v3: 用 DAG + completed stages）
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN'],
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

    // Step 3: 模擬 /vibe:cancel（cancelled=true）
    const state = readState(sid);
    state.meta.cancelled = true;
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
    test('C3: cancel 後 DAG 和 stages 記錄保留', () => {
      const finalState = readState(sid);
      assert.strictEqual(finalState.stages.PLAN.status, 'completed');
      assert.strictEqual(Object.keys(finalState.dag).length, 9);
    });

    // Step 6: pipeline-check 也不再檢查（cancelled=true → derivePhase=IDLE）
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('C4: cancel 後 pipeline-check 不再提醒', () => {
      assert.strictEqual(checkResult.exitCode, 0);
      // 不應有 systemMessage（cancelled → IDLE → 不檢查）
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
    // Step 1: 初始化 + 首次分類為 fix（顯式路徑，建立 DAG）
    initState(sid);
    runHook('task-classifier', {
      session_id: sid,
      prompt: '改一下按鈕顏色 [pipeline:fix]',
    });

    test('D1: 初始分類為 quickfix（fix pipeline）', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.taskType, 'quickfix');
      assert.strictEqual(state.classification.pipelineId, 'fix');
      assert.ok(state.dag, 'DAG 應存在');
    });

    // Step 2: 第二次 prompt 升級為 standard（顯式路徑）
    const upgradeResult = runHook('task-classifier', {
      session_id: sid,
      prompt: '建立完整的使用者認證系統 [pipeline:standard]',
    });

    test('D2: 升級為 feature（standard pipeline）', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.taskType, 'feature');
      assert.strictEqual(state.classification.pipelineId, 'standard');
    });

    test('D3: 升級後有 reclassifications 記錄', () => {
      const state = readState(sid);
      assert.ok(state.meta.reclassifications);
      assert.ok(state.meta.reclassifications.length >= 1);
    });

    test('D4: 升級輸出 systemMessage', () => {
      assert.ok(upgradeResult.json);
      assert.ok(upgradeResult.json.systemMessage);
      // v3: 顯式路徑輸出「Pipeline [standard]（...）已建立」
      assert.ok(
        upgradeResult.json.systemMessage.includes('已建立') ||
        upgradeResult.json.systemMessage.includes('Pipeline'),
        '應有 pipeline 建立訊息'
      );
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
    stateBeforeDowngrade.meta.lastTransition = new Date().toISOString();
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
      assert.strictEqual(state.classification.taskType, 'feature', '維持 feature 不降級');
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
    // 建立到 REVIEW 階段的 state（REVIEW 為 active 表示 code-reviewer 執行中）
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV'],
      active: 'REVIEW',
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

    test('E2: REVIEW 記錄為 completed', () => {
      const state = readState(sid);
      assert.strictEqual(state.stages.REVIEW.status, 'completed');
    });

    test('E3: REVIEW verdict 為 null（無 verdict transcript）', () => {
      const state = readState(sid);
      // v3: 無 verdict → verdict 為 null（非 UNKNOWN）
      assert.strictEqual(state.stages.REVIEW.verdict, null);
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
    // 只完成 PLAN 和 ARCH（v3: DAG + stages）
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH'],
    });

    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('F1: 偵測到遺漏階段（硬阻擋）', () => {
      assert.ok(checkResult.json);
      assert.strictEqual(checkResult.json.continue, false);
      assert.ok(checkResult.json.stopReason.includes('Pipeline 未完成'));
    });

    test('F2: 遺漏提示包含 DEV 相關資訊', () => {
      const msg = checkResult.json.systemMessage;
      assert.ok(msg.includes('DEV') || msg.includes('/vibe:dev') || msg.includes('developer'));
    });

    test('F3: continue=false（硬阻擋，強制繼續完成遺漏階段）', () => {
      assert.strictEqual(checkResult.json.continue, false);
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
console.log('\n🔗 Scenario G: pipeline-guard 非程式碼檔案阻擋（pipeline 啟動中）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

(() => {
  const sid = 'e2e-noncode-1';
  try {
    // v3: 需要 DAG + enforced 才會阻擋
    writeV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
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

      test(`G: 阻擋非程式碼檔案 ${ext} (${file})`, () => {
        assert.strictEqual(result.exitCode, 2);
        assert.ok(result.stderr.length > 0, `stderr 應有阻擋訊息`);
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
    // Step 1: 初始化 + 分類（顯式路徑建立 DAG）
    initState(sid);
    runHook('task-classifier', {
      session_id: sid,
      prompt: '實作使用者認證系統 [pipeline:standard]',
    });

    test('H1: 分類為 feature + DAG 已建立', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.taskType, 'feature');
      assert.ok(state.dag, 'DAG 應存在');
      const phase = derivePhase(state);
      assert.ok(['CLASSIFIED', 'DELEGATING', 'RETRYING'].includes(phase));
    });

    // Step 2-4: 模擬 3 個 agent 的 delegate → complete 循環
    // standard pipeline: PLAN→ARCH→DEV→REVIEW→TEST→DOCS
    const agents = [
      { type: 'vibe:planner', stage: 'PLAN', nextKeyword: 'architect' },
      { type: 'vibe:architect', stage: 'ARCH', nextKeyword: '/vibe:dev' },
      { type: 'vibe:developer', stage: 'DEV', nextKeyword: 'REVIEW' },
    ];

    for (const { type, stage, nextKeyword } of agents) {
      // delegation-tracker
      runHook('delegation-tracker', {
        session_id: sid,
        tool_name: 'Task',
        tool_input: { subagent_type: type },
      });

      const stateAfterDelegate = readState(sid);
      test(`H: ${type} delegation → phase=DELEGATING`, () => {
        const phase = derivePhase(stateAfterDelegate);
        assert.strictEqual(phase, 'DELEGATING');
      });

      // stage-transition
      const trans = runHook('stage-transition', {
        session_id: sid,
        agent_type: type,
        stop_hook_active: false,
      });

      const stateAfterTrans = readState(sid);
      test(`H: ${type} complete → phase 非 DELEGATING`, () => {
        const phase = derivePhase(stateAfterTrans);
        assert.notStrictEqual(phase, 'DELEGATING');
      });

      test(`H: ${type} complete → 指示 ${nextKeyword}`, () => {
        assert.ok(trans.json.systemMessage.includes(nextKeyword));
      });
    }

    // 驗證最終 stages 狀態
    test('H: 3 個 stage 全部記錄為 completed', () => {
      const state = readState(sid);
      assert.strictEqual(state.stages.PLAN.status, 'completed');
      assert.strictEqual(state.stages.ARCH.status, 'completed');
      assert.strictEqual(state.stages.DEV.status, 'completed');
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
    // 初始化 — feature pipeline，DEV 已完成，REVIEW 為 active（code-reviewer 執行中）
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV'],
      active: 'REVIEW',
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

    test('I1: REVIEW FAIL:CRITICAL → 回退訊息包含 FAIL + developer 委派', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      // v3: 「🔄 REVIEW FAIL:CRITICAL（1/3）\n➡️ 委派 vibe:developer」
      assert.ok(r1.json.systemMessage.includes('FAIL'), '訊息應包含 FAIL');
      assert.ok(
        r1.json.systemMessage.includes('developer') || r1.json.systemMessage.includes('DEV') || r1.json.systemMessage.includes('/vibe:dev'),
        '訊息應指示委派 developer'
      );
    });

    test('I2: state 寫入 pendingRetry 標記', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.ok(s.pendingRetry.stages, '應有 stages 陣列');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'REVIEW');
      assert.strictEqual(s.pendingRetry.stages[0].severity, 'CRITICAL');
      assert.strictEqual(s.pendingRetry.stages[0].round, 1);
    });

    test('I3: retries 計數正確', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.REVIEW, 1);
    });

    // Step 2: DEV 修復完成（無 verdict — DEV 不產生 verdict）
    // 回退後 phase=RETRYING，需先 DELEGATE 才能 STAGE_DONE
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('I4: DEV 修復後 → 重跑 REVIEW 訊息', () => {
      assert.ok(r2.json && r2.json.systemMessage, '應有 systemMessage');
      // v3: pipeline-controller 輸出「🔄 DEV 修復完成 → 重跑 REVIEW」
      assert.ok(r2.json.systemMessage.includes('REVIEW'), '應指示重跑 REVIEW');
      assert.ok(r2.json.systemMessage.includes('DEV'), '應提及 DEV 修復完成');
    });

    test('I5: 重跑訊息包含委派指示', () => {
      // v3: 輸出含 ➡️ 委派提示
      assert.ok(r2.json.systemMessage.includes('➡️'), '應包含委派指示');
    });

    test('I6: pendingRetry 被消費（清除）', () => {
      const s = readState(sid);
      assert.strictEqual(s.pendingRetry, null, 'pendingRetry 應被清除');
    });

    // Step 3: 第二次 REVIEW 完成，verdict PASS → 正常前進到 TEST
    // v3: pendingRetry 清除後 REVIEW reset 為 pending → 需先 delegate 再 stage-transition
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:code-reviewer' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '品質良好 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r3 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('I7: 第二次 REVIEW PASS → 正常前進到 TEST', () => {
      assert.ok(r3.json && r3.json.systemMessage, '應有 systemMessage');
      assert.ok(r3.json.systemMessage.includes('TEST'), '應指示前進到 TEST');
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
        assert.strictEqual(state.classification.taskType, 'quickfix');
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
        assert.strictEqual(state.classification.taskType, 'quickfix');
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
        assert.strictEqual(state.classification.taskType, 'research');
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
        assert.strictEqual(state.classification.taskType, 'feature');
      });
    }

    // J11: Trivial 任務 + 顯式 pipeline → pipeline-guard 阻擋（完整 hook 鏈驗證）
    initState(sid);
    runHook('task-classifier', { session_id: sid, prompt: '做一個 poc 測試看看 [pipeline:fix]' });

    const gateResult = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/poc.ts' },
    });

    test('J11: trivial(poc+看看) + [pipeline:fix] → pipeline-guard 阻擋寫碼', () => {
      assert.strictEqual(gateResult.exitCode, 2);
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
    // 模擬手動觸發場景：使用者在初始 IDLE 狀態直接呼叫 /vibe:scope
    // 無 pipeline 設定（task-classifier 未分類或分類為 none）
    initState(sid);

    test('K1: 初始狀態 phase=IDLE（非 enforced）', () => {
      const state = readState(sid);
      const phase = derivePhase(state);
      assert.strictEqual(phase, 'IDLE');
      assert.strictEqual(state.classification, null);
    });

    // v3: 手動觸發需要先建立 DAG（透過顯式分類）
    // 模擬使用者用 [pipeline:standard] 建立 pipeline，然後逐步委派
    runHook('task-classifier', {
      session_id: sid,
      prompt: '做一個新功能 [pipeline:standard]',
    });

    test('K2: 分類後 DAG 已建立', () => {
      const state = readState(sid);
      assert.ok(state.dag, 'DAG 應存在');
      assert.strictEqual(state.classification.pipelineId, 'standard');
    });

    // 模擬手動 /vibe:scope → planner agent
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

    test('K3: planner 完成後，指示下一步 ARCH', () => {
      assert.ok(t1.json && t1.json.systemMessage);
      assert.ok(
        t1.json.systemMessage.includes('architect') ||
        t1.json.systemMessage.includes('ARCH'),
        '應指示 ARCH 階段'
      );
    });

    test('K4: planner 完成後，phase=CLASSIFIED', () => {
      const state = readState(sid);
      const phase = derivePhase(state);
      assert.strictEqual(phase, 'CLASSIFIED');
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

    test('K5: architect 完成後，指示下一步 DEV', () => {
      assert.ok(t2.json && t2.json.systemMessage);
      assert.ok(
        t2.json.systemMessage.includes('developer') ||
        t2.json.systemMessage.includes('DEV') ||
        t2.json.systemMessage.includes('/vibe:dev'),
        '應指示 DEV 階段'
      );
    });

    test('K6: architect 完成後，phase=CLASSIFIED（enforced）', () => {
      const state = readState(sid);
      const phase = derivePhase(state);
      assert.strictEqual(phase, 'CLASSIFIED');
      assert.strictEqual(state.enforced, true);
    });

    test('K7: DAG 結構正確（standard pipeline 階段）', () => {
      const state = readState(sid);
      const dagKeys = Object.keys(state.dag);
      assert.ok(dagKeys.includes('PLAN'));
      assert.ok(dagKeys.includes('ARCH'));
      assert.ok(dagKeys.includes('DEV'));
    });

    // 現在 pipeline-guard 應該阻擋 Main Agent 直接寫碼
    const gate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'Write',
      tool_input: { file_path: 'src/timeline.js' },
    });

    test('K8: enforced pipeline → pipeline-guard 阻擋 Main Agent 寫碼（exit 2）', () => {
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

    // L2: IDLE（非 enforced）→ 放行
    initState(sid, { taskType: 'quickfix' });
    const r2 = runHook('pipeline-guard', askInput);
    test('L2: IDLE（非 enforced）→ pipeline-guard 放行', () => {
      assert.strictEqual(r2.exitCode, 0);
    });

    // L3: CLASSIFIED（enforced）→ 阻擋（exit 2）
    writeV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    });
    const r3 = runHook('pipeline-guard', askInput);
    test('L3: CLASSIFIED（enforced）→ pipeline-guard 阻擋（exit 2）', () => {
      assert.strictEqual(r3.exitCode, 2);
    });

    test('L4: 阻擋訊息包含 must-delegate 指示', () => {
      assert.ok(r3.stderr.includes('等待委派'), '應提示委派 sub-agent');
    });

    test('L5: 阻擋訊息包含工具名稱', () => {
      assert.ok(r3.stderr.includes('AskUserQuestion'), '應提及被阻擋的工具');
    });

    // L6: cancelled=true → 放行
    writeV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      cancelled: true,
    });
    const r4 = runHook('pipeline-guard', askInput);
    test('L6: pipeline 已取消（cancelled=true）→ pipeline-guard 放行', () => {
      assert.strictEqual(r4.exitCode, 0);
    });

    // L7: 完整 hook 鏈 — feature pipeline + pipeline-guard 阻擋 AskUserQuestion 和 Write
    writeV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    });

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
    // M1: EnterPlanMode 無條件阻擋
    writeV3State(sid, { pipelineId: 'standard', taskType: 'feature', enforced: true, stages: ['PLAN', 'ARCH', 'DEV'] });
    const planMode = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M1: EnterPlanMode 無條件阻擋（pipeline enforced）', () => {
      assert.strictEqual(planMode.exitCode, 2);
      assert.ok(planMode.stderr.includes('EnterPlanMode'));
      assert.ok(planMode.stderr.includes('/vibe:scope'));
    });

    // M2: cancelled=true 後 EnterPlanMode 仍阻擋（無條件）
    writeV3State(sid, { pipelineId: 'standard', taskType: 'feature', enforced: true, stages: ['PLAN', 'ARCH', 'DEV'], cancelled: true });
    const planModeAfterCancel = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M2: cancelled=true → EnterPlanMode 仍阻擋（無條件）', () => {
      assert.strictEqual(planModeAfterCancel.exitCode, 2);
      assert.ok(planModeAfterCancel.stderr.includes('EnterPlanMode'));
    });

    // M3: NotebookEdit 支援（程式碼檔案阻擋）
    writeV3State(sid, { pipelineId: 'standard', taskType: 'feature', enforced: true, stages: ['PLAN', 'ARCH', 'DEV'] });
    const notebook = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'notebook.ipynb' },
    });

    test('M3: NotebookEdit 程式碼檔案 → 阻擋', () => {
      assert.strictEqual(notebook.exitCode, 2);
      assert.ok(notebook.stderr.includes('等待委派') || notebook.stderr.includes('NotebookEdit'));
    });

    // M4: NotebookEdit 非程式碼檔案（.json）也阻擋（CLASSIFIED phase → must-delegate）
    const notebookNonCode = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'NotebookEdit',
      tool_input: { file_path: 'config.json' },
    });

    test('M4: NotebookEdit 非程式碼檔案 → 阻擋', () => {
      assert.strictEqual(notebookNonCode.exitCode, 2);
      assert.ok(notebookNonCode.stderr.length > 0, `stderr 應有阻擋訊息`);
    });

    // M5: DELEGATING 時 EnterPlanMode 仍阻擋（無條件）
    writeV3State(sid, { pipelineId: 'standard', taskType: 'feature', enforced: true, stages: ['PLAN', 'ARCH', 'DEV'], active: 'PLAN' });
    const planModeDelegate = runHook('pipeline-guard', {
      session_id: sid,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    });

    test('M5: phase=DELEGATING → EnterPlanMode 仍阻擋（無條件）', () => {
      assert.strictEqual(planModeDelegate.exitCode, 2);
      assert.ok(planModeDelegate.stderr.includes('EnterPlanMode'));
    });

    // M6: IDLE（非 enforced）時所有工具放行
    initState(sid, { taskType: 'quickfix' });
    const allTools = [
      { tool: 'Write', input: { file_path: 'src/app.js' } },
      { tool: 'Edit', input: { file_path: 'src/component.tsx' } },
      { tool: 'NotebookEdit', input: { file_path: 'notebook.ipynb' } },
      { tool: 'AskUserQuestion', input: {} },
      // EnterPlanMode 已移除：v1.0.47+ 無條件阻擋，不受 pipelineEnforced 影響
    ];

    for (const { tool, input } of allTools) {
      const result = runHook('pipeline-guard', {
        session_id: sid,
        tool_name: tool,
        tool_input: input,
      });

      test(`M6: phase=IDLE → ${tool} 放行`, () => {
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
    // 模擬 REVIEW FAIL → DEV 修復後的 state（v3 格式）
    // REVIEW 為 failed，有 pendingRetry，TEST+ 仍為 pending
    const v3State = createV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV'],
      failed: ['REVIEW'],
    });
    // 設定 pendingRetry（v3 格式）
    v3State.pendingRetry = { stages: [{ id: 'REVIEW', severity: 'CRITICAL', round: 1 }] };
    v3State.retries = { REVIEW: 1 };
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(v3State, null, 2)
    );

    // pipeline-check 的 block 訊息應包含遺漏階段
    const checkResult = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N1: pipeline-check 回應 continue=false', () => {
      assert.ok(checkResult.json);
      assert.strictEqual(checkResult.json.continue, false);
    });

    test('N2: block 訊息包含 REVIEW 和 TEST', () => {
      const msg = checkResult.json.systemMessage || checkResult.json.stopReason || '';
      assert.ok(msg.includes('REVIEW'), 'missing 應包含 REVIEW');
      assert.ok(msg.includes('TEST'), 'missing 應包含 TEST');
    });

    test('N3: stopReason 包含 Pipeline 未完成', () => {
      const reason = checkResult.json.stopReason;
      assert.ok(reason.includes('Pipeline 未完成'), '應包含 Pipeline 未完成');
    });

    // N4: 移除 pendingRetry 後，仍有遺漏（REVIEW failed + TEST+ pending）
    const state = readState(sid);
    state.pendingRetry = null;
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state, null, 2)
    );

    const checkResult2 = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N4: 無 pendingRetry 時仍有遺漏階段', () => {
      assert.ok(checkResult2.json);
      assert.strictEqual(checkResult2.json.continue, false);
      const reason = checkResult2.json.stopReason;
      assert.ok(reason.includes('Pipeline 未完成'), '應包含 Pipeline 未完成');
    });

    // N5: REVIEW reset 為 pending + 有 pendingRetry → 仍在 missing
    const state2 = readState(sid);
    state2.stages.REVIEW = { status: 'pending', agent: null, verdict: null };
    state2.pendingRetry = { stages: [{ id: 'REVIEW', severity: 'HIGH', round: 1 }] };
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(state2, null, 2)
    );

    const checkResult3 = runHook('pipeline-check', {
      session_id: sid,
      stop_hook_active: false,
    });

    test('N5: REVIEW pending + pendingRetry → 仍在 missing 列表中', () => {
      assert.ok(checkResult3.json);
      const msg = checkResult3.json.systemMessage || checkResult3.json.stopReason || '';
      assert.ok(msg.includes('REVIEW'), 'REVIEW 應在 missing 中');
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
    const staleState = createV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['PLAN'],
    });
    staleState.meta.lastTransition = staleTime;
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(staleState, null, 2)
    );

    // 降級分類（research 任務）
    runHook('task-classifier', {
      session_id: sid,
      prompt: '查看目前的程式碼結構',
    });

    test('O1: 過時 pipeline + 降級 → 重設為新分類', () => {
      const state = readState(sid);
      assert.notStrictEqual(state.classification?.pipelineId, 'standard', '應重設 pipeline');
    });

    test('O2: 重設後 stages 為空或全 pending', () => {
      const state = readState(sid);
      // reset → 新初始 state，stages 可能為空或 DAG 為 null
      if (state.dag) {
        // 如果有新 DAG，所有 stages 應為 pending
        for (const [, s] of Object.entries(state.stages)) {
          assert.notStrictEqual(s.status, 'completed', '重設後不應有 completed stages');
        }
      }
    });

    test('O3: 重設後 pendingRetry 被清除', () => {
      const state = readState(sid);
      assert.strictEqual(state.pendingRetry, null, 'pendingRetry 應為 null');
    });

    // O4: 新鮮 pipeline（lastTransition 剛剛）+ 降級 → 不應重設
    const freshState = createV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['PLAN', 'ARCH'],
    });
    freshState.meta.lastTransition = new Date().toISOString();
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(freshState, null, 2)
    );

    runHook('task-classifier', {
      session_id: sid,
      prompt: '這段程式碼是什麼意思？',
    });

    test('O4: 新鮮 pipeline + 降級 → 保持原 pipeline', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.pipelineId, 'standard', '應保持 standard');
      assert.strictEqual(state.enforced, true, '應保持 enforced');
    });

    test('O5: 原 stages 完成記錄保留', () => {
      const state = readState(sid);
      assert.strictEqual(state.stages.PLAN.status, 'completed', 'PLAN 應保留 completed');
      assert.strictEqual(state.stages.ARCH.status, 'completed', 'ARCH 應保留 completed');
    });

    // O6: 無 lastTransition 欄位 → 視為過時
    const noTransState = createV3State(sid, {
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      completed: ['PLAN'],
    });
    noTransState.meta.lastTransition = null;
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(noTransState, null, 2)
    );

    runHook('task-classifier', {
      session_id: sid,
      prompt: '看看這個 API 怎麼用',
    });

    test('O6: 無 lastTransition → 視為過時，降級重設', () => {
      const state = readState(sid);
      assert.notStrictEqual(state.classification?.pipelineId, 'standard', '應重設');
    });

    // O7: 已完成的 pipeline + 降級 → 正常流程（isComplete 先觸發 RESET）
    writeV3State(sid, {
      pipelineId: 'fix',
      taskType: 'quickfix',
      enforced: true,
      stages: ['DEV'],
      completed: ['DEV'],
    });

    runHook('task-classifier', {
      session_id: sid,
      prompt: '這是什麼？',
    });

    test('O7: 已完成 pipeline → isComplete 先 RESET，新分類正常套用', () => {
      const state = readState(sid);
      assert.strictEqual(state.classification.taskType, 'research');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario P: QA 回退重驗流程（對稱於 Scenario I 的 REVIEW 回退）
// QA FAIL:CRITICAL → DEV 修復 → 重跑 QA → QA PASS → E2E
// ═══════════════════════════════════════════════

console.log('\n🔄 Scenario P: QA 回退重驗（QA FAIL → DEV fix → re-QA → E2E）');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-qa-retry';
  try {
    // 初始化 — full pipeline，DEV/REVIEW/TEST 已完成，QA 為 active
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST'],
      active: 'QA',
    });

    // Step 1: QA 完成，verdict FAIL:CRITICAL
    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: 'API 行為不符預期 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    const r1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:qa',
      agent_transcript_path: transcriptPath,
    });

    test('P1: QA FAIL:CRITICAL → 回退訊息包含 FAIL + developer 委派', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      // v3: 「🔄 QA FAIL:CRITICAL（1/3）\n➡️ 委派 vibe:developer」
      assert.ok(r1.json.systemMessage.includes('FAIL'), '訊息應包含 FAIL');
      assert.ok(
        r1.json.systemMessage.includes('developer') || r1.json.systemMessage.includes('DEV') || r1.json.systemMessage.includes('/vibe:dev'),
        '訊息應指示委派 developer'
      );
    });

    test('P2: state 寫入 pendingRetry 標記（stage=QA）', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'QA');
      assert.strictEqual(s.pendingRetry.stages[0].severity, 'CRITICAL');
      assert.strictEqual(s.pendingRetry.stages[0].round, 1);
    });

    test('P3: retries 計數正確（QA: 1）', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.QA, 1);
    });

    // Step 2: DEV 修復完成（回退後 phase=RETRYING，需先 DELEGATE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('P4: DEV 修復後 → 重跑 QA 訊息', () => {
      assert.ok(r2.json && r2.json.systemMessage, '應有 systemMessage');
      // v3: 「🔄 DEV 修復完成 → 重跑 QA」
      assert.ok(r2.json.systemMessage.includes('QA'), '應指示重跑 QA');
      assert.ok(r2.json.systemMessage.includes('DEV'), '應提及 DEV 修復完成');
    });

    test('P5: pendingRetry 被消費', () => {
      const s = readState(sid);
      assert.strictEqual(s.pendingRetry, null, 'pendingRetry 應被清除');
    });

    // Step 3: 第二次 QA PASS → 前進到 E2E
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:qa' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: 'API 行為正確 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r3 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:qa',
      agent_transcript_path: transcriptPath,
    });

    test('P6: 第二次 QA PASS → 前進到 E2E', () => {
      assert.ok(r3.json && r3.json.systemMessage, '應有 systemMessage');
      assert.ok(r3.json.systemMessage.includes('E2E'), '應指示前進到 E2E');
      assert.ok(!r3.json.systemMessage.includes('回退重驗'), '不應包含回退重驗');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario Q: E2E 回退 + 非回退場景
// E2E FAIL:CRITICAL → DEV 回退 | E2E FAIL:MEDIUM → 不回退，繼續 DOCS
// ═══════════════════════════════════════════════

console.log('\n🌐 Scenario Q: E2E 回退與非回退（CRITICAL vs MEDIUM）');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-e2e-retry';
  try {
    // --- Part 1: E2E FAIL:CRITICAL → 回退到 DEV ---

    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA'],
      active: 'E2E',
    });

    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '使用者流程中斷 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    const r1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:e2e-runner',
      agent_transcript_path: transcriptPath,
    });

    test('Q1: E2E FAIL:CRITICAL → 回退到 DEV', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      // v3: 「🔄 E2E FAIL:CRITICAL（1/3）」+ 「➡️ 執行 /vibe:dev」
      assert.ok(r1.json.systemMessage.includes('E2E'), '應包含 E2E');
      assert.ok(r1.json.systemMessage.includes('FAIL'), '應包含 FAIL');
    });

    test('Q2: pendingRetry.stages[0].id === E2E', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'E2E');
      assert.strictEqual(s.pendingRetry.stages[0].severity, 'CRITICAL');
    });

    test('Q3: retries.E2E === 1', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.E2E, 1);
    });

    // --- Part 2: E2E FAIL:MEDIUM → 不回退，繼續 DOCS ---

    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA'],
      active: 'E2E',
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '小問題 <!-- PIPELINE_VERDICT: FAIL:MEDIUM -->' }] },
    }) + '\n');

    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:e2e-runner',
      agent_transcript_path: transcriptPath,
    });

    test('Q4: E2E FAIL:MEDIUM → 不回退，前進到 DOCS', () => {
      assert.ok(r2.json && r2.json.systemMessage, '應有 systemMessage');
      assert.ok(r2.json.systemMessage.includes('DOCS'), '應指示前進到 DOCS');
      assert.ok(!r2.json.systemMessage.includes('Pipeline 回退'), '不應包含 Pipeline 回退');
    });

    test('Q5: 無 pendingRetry（MEDIUM 不回退）', () => {
      const s = readState(sid);
      assert.ok(!s.pendingRetry, '不應有 pendingRetry');
    });

    // --- Part 3: E2E FAIL:HIGH → 回退到 DEV ---

    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA'],
      active: 'E2E',
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '效能問題 <!-- PIPELINE_VERDICT: FAIL:HIGH -->' }] },
    }) + '\n');

    const r3 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:e2e-runner',
      agent_transcript_path: transcriptPath,
    });

    test('Q6: E2E FAIL:HIGH → 回退到 DEV', () => {
      assert.ok(r3.json && r3.json.systemMessage, '應有 systemMessage');
      assert.ok(r3.json.systemMessage.includes('FAIL'), '應包含 FAIL');
    });

    test('Q7: pendingRetry.stages[0].id === E2E（HIGH 嚴重度）', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'E2E');
      assert.strictEqual(s.pendingRetry.stages[0].severity, 'HIGH');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario R: MAX_RETRIES 耗盡 → 強制繼續（不卡死）
// REVIEW 已回退 3 次 → 再次 FAIL → 不再回退，強制前進到 TEST
// ═══════════════════════════════════════════════

console.log('\n⚠️ Scenario R: MAX_RETRIES 耗盡 → 強制繼續');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-max-retries';
  try {
    // 初始化 — 已回退 3 次（MAX_RETRIES=3），REVIEW 為 active
    const maxState = createV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV'],
      active: 'REVIEW',
    });
    maxState.retries = { REVIEW: 3 }; // 已達上限
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(maxState, null, 2)
    );

    // REVIEW 再次 FAIL:CRITICAL — 但已達上限
    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '仍有問題 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    const r1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('R1: MAX_RETRIES 耗盡 → 不回退，前進到 TEST', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      assert.ok(r1.json.systemMessage.includes('TEST'), '應前進到 TEST');
    });

    test('R2: 正常前進（不回退，因為 shouldRetry=false）', () => {
      // v3: MAX_RETRIES 耗盡時 shouldRetry=false → 走 branch C（正常前進）
      assert.ok(r1.json.systemMessage.includes('REVIEW'), '應提及 REVIEW');
    });

    test('R3: 無 pendingRetry（不再回退）', () => {
      const s = readState(sid);
      assert.ok(!s.pendingRetry, '不應設定 pendingRetry');
    });

    test('R4: REVIEW 標記為 completed（強制繼續，不卡死）', () => {
      const s = readState(sid);
      // v3: MAX_RETRIES 耗盡 → markStageCompleted → status='completed'
      assert.strictEqual(s.stages.REVIEW.status, 'completed');
    });

    test('R5: retries 計數保持 3（不再累加）', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.REVIEW, 3, 'retries.REVIEW 應保持 3');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario S: 級聯多階段失敗修復（REVIEW → TEST 連續回退）
// REVIEW FAIL → DEV → REVIEW PASS → TEST FAIL → DEV → TEST PASS → QA
// ═══════════════════════════════════════════════

console.log('\n🔗 Scenario S: 級聯多階段失敗修復');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-cascading-retry';
  try {
    // 初始化 — full pipeline，DEV 已完成，REVIEW 為 active
    writeV3State(sid, {
      pipelineId: 'full',
      taskType: 'feature',
      enforced: true,
      stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      completed: ['PLAN', 'ARCH', 'DESIGN', 'DEV'],
      active: 'REVIEW',
    });

    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);

    // ── Round 1: REVIEW FAIL:HIGH ──
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '邏輯錯誤 <!-- PIPELINE_VERDICT: FAIL:HIGH -->' }] },
    }) + '\n');

    runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('S1: REVIEW FAIL:HIGH → pendingRetry.stages[0].id=REVIEW', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'REVIEW');
    });

    // ── Round 2: DEV fix → 回退重驗指向 REVIEW ──（RETRYING→DELEGATE→DELEGATING→STAGE_DONE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('S2: DEV fix → 重跑 REVIEW', () => {
      // v3: 「🔄 DEV 修復完成 → 重跑 REVIEW」
      assert.ok(r2.json.systemMessage.includes('REVIEW'), '應指向 REVIEW');
      assert.ok(r2.json.systemMessage.includes('DEV'), '應提及 DEV');
    });

    // ── Round 3: REVIEW PASS → 前進到 TEST ──（CLASSIFIED→DELEGATE→DELEGATING→STAGE_DONE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:code-reviewer' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '品質良好 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r3 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('S3: REVIEW PASS → 前進到 TEST', () => {
      assert.ok(r3.json.systemMessage.includes('TEST'), '應前進到 TEST');
    });

    // ── Round 4: TEST FAIL:CRITICAL → 回退到 DEV ──（CLASSIFIED→DELEGATE→DELEGATING→STAGE_DONE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:tester' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '測試失敗 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:tester',
      agent_transcript_path: transcriptPath,
    });

    test('S4: TEST FAIL:CRITICAL → pendingRetry.stages[0].id=TEST', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'TEST');
      assert.strictEqual(s.retries.REVIEW, 1, 'REVIEW retries 保持 1');
      assert.strictEqual(s.retries.TEST, 1, 'TEST retries 新增為 1');
    });

    // ── Round 5: DEV fix → 回退重驗指向 TEST ──（RETRYING→DELEGATE→DELEGATING→STAGE_DONE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r5 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('S5: DEV fix → 重跑 TEST', () => {
      assert.ok(r5.json.systemMessage.includes('TEST'), '應指向 TEST');
      assert.ok(r5.json.systemMessage.includes('DEV'), '應提及 DEV');
    });

    // ── Round 6: TEST PASS → 前進到 QA ──（CLASSIFIED→DELEGATE→DELEGATING→STAGE_DONE）
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:tester' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '測試全過 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r6 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:tester',
      agent_transcript_path: transcriptPath,
    });

    test('S6: TEST PASS → 前進到 QA（非回退）', () => {
      assert.ok(r6.json.systemMessage.includes('QA'), '應前進到 QA');
    });

    test('S7: 累積 retries 正確（REVIEW:1, TEST:1）', () => {
      const s = readState(sid);
      assert.strictEqual(s.retries.REVIEW, 1);
      assert.strictEqual(s.retries.TEST, 1);
      assert.ok(!s.retries.QA, 'QA 無回退');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario T: quick-dev pipeline 含重試循環
// DEV → REVIEW → TEST（TEST FAIL → DEV → TEST PASS → 完成）
// 注：v3 DAG 不支援重複 stage 名稱，test-first pipeline 需要 pipeline-architect 特殊處理
// ═══════════════════════════════════════════════

console.log('\n🔁 Scenario T: quick-dev pipeline 含重試循環');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-tdd-loop';
  try {
    // quick-dev pipeline: DEV → REVIEW → TEST（DEV 為 active）
    writeV3State(sid, {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      enforced: true,
      stages: ['DEV', 'REVIEW', 'TEST'],
      active: 'DEV',
    });

    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);

    // ── Step 1: DEV 完成 → 前進到 REVIEW ──
    const r1 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('T1: DEV 完成 → 前進到 REVIEW', () => {
      assert.ok(r1.json && r1.json.systemMessage, '應有 systemMessage');
      assert.ok(r1.json.systemMessage.includes('REVIEW'), '應前進到 REVIEW');
    });

    // ── Step 2: REVIEW PASS → 前進到 TEST ──
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:code-reviewer' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '品質良好 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r2 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('T2: REVIEW PASS → 前進到 TEST', () => {
      assert.ok(r2.json && r2.json.systemMessage, '應有 systemMessage');
      assert.ok(r2.json.systemMessage.includes('TEST'), '應前進到 TEST');
    });

    // ── Step 3: TEST FAIL:CRITICAL → 回退到 DEV ──
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:tester' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '測試失敗 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:tester',
      agent_transcript_path: transcriptPath,
    });

    test('T3: TEST FAIL:CRITICAL → pendingRetry', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, '應有 pendingRetry');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'TEST');
    });

    // ── Step 4: DEV 修復 → 重跑 TEST ──
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r4 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('T4: DEV 修復 → 重跑 TEST', () => {
      assert.ok(r4.json.systemMessage.includes('TEST'), '應指向 TEST');
    });

    // ── Step 5: TEST PASS → pipeline 完成 ──
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:tester' },
    });

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '綠燈 <!-- PIPELINE_VERDICT: PASS -->' }] },
    }) + '\n');

    const r5 = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:tester',
      agent_transcript_path: transcriptPath,
    });

    test('T5: TEST PASS → pipeline 完成', () => {
      assert.ok(r5.json && r5.json.systemMessage, '應有 systemMessage');
      assert.ok(
        r5.json.systemMessage.includes('Pipeline 完成') || r5.json.systemMessage.includes('完成'),
        '應包含完成訊息'
      );
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario U: Pipeline 升級保留 pendingRetry
// quick-dev REVIEW FAIL → pendingRetry → 升級到 standard → DEV → 重驗 REVIEW
// ═══════════════════════════════════════════════

console.log('\n⬆️ Scenario U: Pipeline 升級保留 pendingRetry');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-upgrade-pending';
  try {
    // 初始化 quick-dev pipeline，已有 pendingRetry（v3 格式）
    const upgradeState = createV3State(sid, {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      enforced: true,
      stages: ['DEV', 'REVIEW', 'TEST'],
      completed: ['DEV'],
      failed: ['REVIEW'],
    });
    upgradeState.retries = { REVIEW: 1 };
    upgradeState.pendingRetry = { stages: [{ id: 'REVIEW', severity: 'HIGH', round: 1 }] };
    upgradeState.meta.lastTransition = new Date().toISOString();
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(upgradeState, null, 2)
    );

    // 升級到 standard（顯式路徑）
    runHook('task-classifier', {
      session_id: sid,
      prompt: '[pipeline:standard] 實作完整的使用者認證系統',
    });

    test('U1: 升級到 standard pipeline', () => {
      const s = readState(sid);
      assert.strictEqual(s.classification.pipelineId, 'standard', '應升級到 standard');
    });

    test('U2: pendingRetry 在升級後保留', () => {
      const s = readState(sid);
      assert.ok(s.pendingRetry, 'pendingRetry 應保留');
      assert.strictEqual(s.pendingRetry.stages[0].id, 'REVIEW');
      assert.strictEqual(s.pendingRetry.stages[0].round, 1);
    });

    // DEV 修復完成 → 應觸發重跑 REVIEW
    runHook('delegation-tracker', {
      session_id: sid,
      tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer' },
    });

    const r = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:developer',
    });

    test('U3: DEV 完成 → 重跑 REVIEW（跨 pipeline 保留）', () => {
      assert.ok(r.json && r.json.systemMessage, '應有 systemMessage');
      assert.ok(r.json.systemMessage.includes('REVIEW'), '應指向 REVIEW');
    });

    test('U4: pendingRetry 被消費', () => {
      const s = readState(sid);
      assert.ok(!s.pendingRetry, 'pendingRetry 應被消費');
    });
  } finally {
    cleanState(sid);
  }
})();

// ═══════════════════════════════════════════════
// Scenario V: review-only — 無 DEV 階段的 REVIEW FAIL
// ═══════════════════════════════════════════════

console.log('\n📝 Scenario V: review-only — 無 DEV 階段的 FAIL 處理');
console.log('═══════════════════════════════════════════════════════');

(() => {
  const sid = 'test-review-only-fail';
  try {
    // code-reviewer 執行中（REVIEW 為 active）
    writeV3State(sid, {
      pipelineId: 'review-only',
      taskType: 'quickfix',
      enforced: true,
      stages: ['REVIEW'],
      active: 'REVIEW',
    });

    const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);

    // REVIEW FAIL:CRITICAL — 但 pipeline 無 DEV 階段
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ text: '嚴重問題 <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }] },
    }) + '\n');

    const r = runHook('stage-transition', {
      session_id: sid,
      agent_type: 'vibe:code-reviewer',
      agent_transcript_path: transcriptPath,
    });

    test('V1: review-only FAIL → 無 DEV 可回退訊息', () => {
      assert.ok(r.json && r.json.systemMessage, '應有 systemMessage');
      // v3: 「⚠️ REVIEW FAIL 但無 DEV 可回退，強制繼續。」
      assert.ok(r.json.systemMessage.includes('REVIEW'), '應提及 REVIEW');
      assert.ok(r.json.systemMessage.includes('FAIL') || r.json.systemMessage.includes('強制繼續'), '應包含 FAIL 或強制繼續');
    });

    test('V2: REVIEW 標記為 completed（強制繼續，不卡死）', () => {
      const s = readState(sid);
      assert.strictEqual(s.stages.REVIEW.status, 'completed', 'REVIEW 應為 completed');
    });

    test('V3: 無 pendingRetry（無 DEV 可回退）', () => {
      const s = readState(sid);
      assert.ok(!s.pendingRetry, '不應有 pendingRetry');
    });

    // 清理 transcript
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
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
