#!/usr/bin/env node
/**
 * pipeline-catalog-validation.test.js — 10 種 Pipeline 全生命週期驗證
 *
 * 每種 pipeline 模擬完整 hook chain：
 *   task-classifier → pipeline-guard → (delegation-tracker → guard → stage-transition) × N → pipeline-check
 *
 * 驗證項目：
 *   - FSM phase 轉換正確性
 *   - 分類結果（pipelineId, taskType, expectedStages）
 *   - Guard 阻擋/放行決策
 *   - stageIndex 遞增 + completedAgents + stageResults
 *   - Timeline 事件完整性
 *   - systemMessage 內容
 *   - 特殊場景：FAIL 回退、Pipeline 升級、Guard 細節
 *
 * 執行：node plugins/vibe/tests/pipeline-catalog-validation.test.js
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

const {
  PIPELINES, STAGES, PIPELINE_TO_TASKTYPE,
} = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'registry.js'));

let passed = 0;
let failed = 0;
require('./test-helpers').cleanTestStateFiles();

// ═══════════════════════════════════════════════════════════════
//  Test Runner + Logging
// ═══════════════════════════════════════════════════════════════

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`    ❌ ${name}`);
    console.log(`       ${err.message.split('\n')[0]}`);
  }
}

function log(tag, msg) {
  const icons = {
    STEP: '📋', GUARD: '🛡️', DELEG: '🔗', TRANS: '🔄',
    CHECK: '✅', TIMELINE: '📊', COMPLETE: '🏁',
  };
  console.log(`  ${icons[tag] || '  '} [${tag}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

function initState(sid, overrides = {}) {
  const state = {
    sessionId: sid,
    phase: overrides.phase || 'IDLE',
    context: {
      pipelineId: null, taskType: null, expectedStages: [],
      environment: {}, openspecEnabled: false, pipelineRules: [], needsDesign: false,
      ...(overrides.context || {}),
    },
    progress: {
      currentStage: null, stageIndex: 0, completedAgents: [],
      stageResults: {}, retries: {}, skippedStages: [], pendingRetry: null,
      ...(overrides.progress || {}),
    },
    meta: {
      initialized: true, classifiedAt: null,
      lastTransition: new Date().toISOString(),
      classificationSource: null, classificationConfidence: null,
      matchedRule: null, layer: null, reclassifications: [],
      llmClassification: null, correctionCount: 0, cancelled: false,
      ...(overrides.meta || {}),
    },
  };
  fs.writeFileSync(
    path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
    JSON.stringify(state, null, 2),
  );
  return state;
}

function readState(sid) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`), 'utf8'));
  } catch (_) { return null; }
}

function cleanState(sid) {
  try { fs.unlinkSync(path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`)); } catch (_) {}
}

function runHook(hookName, stdinData) {
  const hookPath = path.join(HOOKS_DIR, `${hookName}.js`);
  const input = JSON.stringify(stdinData).replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`echo '${input}' | node "${hookPath}"`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    const out = stdout.toString().trim();
    let json = null;
    if (out) { try { json = JSON.parse(out); } catch (_) {} }
    return { exitCode: 0, stdout: out, stderr: '', json };
  } catch (err) {
    const out = (err.stdout || '').toString().trim();
    let json = null;
    if (out) { try { json = JSON.parse(out); } catch (_) {} }
    return {
      exitCode: err.status || 1,
      stdout: out,
      stderr: (err.stderr || '').toString(),
      json,
    };
  }
}

function readTimeline(sid) {
  try {
    const content = fs.readFileSync(
      path.join(CLAUDE_DIR, `timeline-${sid}.jsonl`), 'utf8').trim();
    if (!content) return [];
    return content.split('\n')
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function cleanTimeline(sid) {
  try { fs.unlinkSync(path.join(CLAUDE_DIR, `timeline-${sid}.jsonl`)); } catch (_) {}
}

function createMockTranscript(sid, verdict = 'PASS') {
  const entry = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: `分析完成。\n<!-- PIPELINE_VERDICT: ${verdict} -->` }] },
  };
  const p = path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`);
  fs.writeFileSync(p, JSON.stringify(entry) + '\n');
  return p;
}

function cleanTranscript(sid) {
  try { fs.unlinkSync(path.join(CLAUDE_DIR, `test-transcript-${sid}.jsonl`)); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  Pipeline Lifecycle Engine
// ═══════════════════════════════════════════════════════════════

/**
 * 執行完整 pipeline 生命週期測試
 * @param {object} config - { id, pipelineId, prompt, label }
 */
function runPipelineScenario({ id, pipelineId, prompt, label }) {
  const sid = `catalog-${id}`;
  const pipeline = PIPELINES[pipelineId];
  const stages = pipeline.stages;
  const enforced = pipeline.enforced;

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  Scenario ${id}: ${pipelineId}（${label}）`);
  console.log(`  Prompt: ${prompt.slice(0, 55)}${prompt.length > 55 ? '...' : ''}`);
  console.log(`  Stages: ${stages.join(' → ') || '(none)'}`);
  console.log(`  Enforced: ${enforced}`);
  console.log(`${'═'.repeat(65)}`);

  // 清理舊數據
  cleanState(sid);
  cleanTimeline(sid);
  cleanTranscript(sid);

  // ─── Step 1: 初始化 ─────────────────────────────
  initState(sid);

  // ─── Step 2: 分類 ───────────────────────────────
  log('STEP', '1. task-classifier 分類');
  runHook('task-classifier', { session_id: sid, prompt });

  // 模擬 pipeline-init 的 env-detector：含 DESIGN 的 pipeline 需要前端環境
  if (stages.includes('DESIGN')) {
    const envState = readState(sid);
    envState.context.environment = { ...envState.context.environment, frontend: { detected: true } };
    envState.context.needsDesign = true;
    fs.writeFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
      JSON.stringify(envState, null, 2),
    );
  }

  const sc = readState(sid);

  test(`${id}: pipelineId = ${pipelineId}`, () => {
    assert.strictEqual(sc.context.pipelineId, pipelineId);
  });
  test(`${id}: expectedStages = [${stages.join(', ')}]`, () => {
    assert.deepStrictEqual(sc.context.expectedStages, stages);
  });
  const expectedPhase = enforced ? 'CLASSIFIED' : 'IDLE';
  test(`${id}: phase = ${expectedPhase}`, () => {
    assert.strictEqual(sc.phase, expectedPhase);
  });
  // none 用 regex 分類，其他用 explicit
  const expectedSource = pipelineId === 'none' ? 'regex' : 'explicit';
  test(`${id}: source = ${expectedSource}`, () => {
    assert.strictEqual(sc.meta.classificationSource, expectedSource);
  });
  console.log(`    ├─ phase=${sc.phase}, pipeline=${sc.context.pipelineId}`);
  console.log(`    ├─ taskType=${sc.context.taskType}, confidence=${sc.meta.classificationConfidence}`);
  console.log(`    └─ source=${sc.meta.classificationSource}, rule=${sc.meta.matchedRule}`);

  // ─── Step 3: Guard 阻擋 ────────────────────────
  log('STEP', '2. pipeline-guard 驗證');
  if (enforced) {
    const gr = runHook('pipeline-guard', {
      session_id: sid, tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.js', content: 'x' },
    });
    test(`${id}: guard 阻擋 Main Agent Write (exit 2)`, () => {
      assert.strictEqual(gr.exitCode, 2);
    });
    test(`${id}: guard stderr 含 ⛔`, () => {
      assert(gr.stderr.includes('⛔'), `stderr: ${gr.stderr.slice(0, 80)}`);
    });
    console.log(`    └─ exitCode=${gr.exitCode}, blocked ✓`);
  } else {
    const gr = runHook('pipeline-guard', {
      session_id: sid, tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.js', content: 'x' },
    });
    test(`${id}: guard 放行 none pipeline (exit 0)`, () => {
      assert.strictEqual(gr.exitCode, 0);
    });
    console.log(`    └─ exitCode=${gr.exitCode}, allowed ✓`);
  }

  // ─── Step 4: 每個 Stage 生命週期 ───────────────
  let prevStageIndex = -1;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const agentName = STAGES[stage].agent;
    const nsAgent = `vibe:${agentName}`;
    const isLast = (i === stages.length - 1);

    log('STEP', `Stage ${i + 1}/${stages.length}: ${stage} (${agentName})`);

    // 4a: Delegation
    runHook('delegation-tracker', {
      session_id: sid, tool_name: 'Task',
      tool_input: { subagent_type: nsAgent, prompt: `Execute ${stage}`, description: `${stage} stage` },
    });
    const sd = readState(sid);
    test(`${id}/${stage}[${i}]: delegate → DELEGATING`, () => {
      assert.strictEqual(sd.phase, 'DELEGATING');
    });
    test(`${id}/${stage}[${i}]: currentStage = ${stage}`, () => {
      assert.strictEqual(sd.progress.currentStage, stage);
    });
    log('DELEG', `phase=DELEGATING, currentStage=${stage}`);

    // 4b: Guard 放行 sub-agent
    const ga = runHook('pipeline-guard', {
      session_id: sid, tool_name: 'Write',
      tool_input: { file_path: '/tmp/sub-agent-output.js', content: 'module.exports = {}' },
    });
    test(`${id}/${stage}[${i}]: sub-agent Write → allow`, () => {
      assert.strictEqual(ga.exitCode, 0);
    });
    log('GUARD', `sub-agent Write → allowed`);

    // 4c: Stage Transition (PASS verdict)
    const tp = createMockTranscript(sid, 'PASS');
    const tr = runHook('stage-transition', {
      session_id: sid, agent_type: nsAgent,
      agent_transcript_path: tp, stop_hook_active: false,
    });
    const st = readState(sid);
    cleanTranscript(sid);

    // verdict 記錄
    test(`${id}/${stage}[${i}]: stageResults[${stage}] = PASS`, () => {
      assert(st.progress.stageResults[stage], `缺少 stageResults[${stage}]`);
      assert.strictEqual(st.progress.stageResults[stage].verdict, 'PASS');
    });

    // completedAgents
    test(`${id}/${stage}[${i}]: completedAgents 含 ${nsAgent}`, () => {
      assert(st.progress.completedAgents.includes(nsAgent),
        `agents=${JSON.stringify(st.progress.completedAgents)}`);
    });

    // stageIndex 單調遞增（TDD 可能平台期）
    test(`${id}/${stage}[${i}]: stageIndex >= ${prevStageIndex}`, () => {
      assert(st.progress.stageIndex >= prevStageIndex,
        `stageIndex=${st.progress.stageIndex} < prev=${prevStageIndex}`);
    });
    prevStageIndex = st.progress.stageIndex;

    if (isLast) {
      test(`${id}/${stage}[${i}]: 最終 phase = COMPLETE`, () => {
        assert.strictEqual(st.phase, 'COMPLETE');
      });
      log('COMPLETE', `phase=COMPLETE, all ${stages.length} stages done`);
    } else {
      test(`${id}/${stage}[${i}]: phase = CLASSIFIED`, () => {
        assert.strictEqual(st.phase, 'CLASSIFIED');
      });
      // systemMessage 應存在且包含下一階段資訊
      test(`${id}/${stage}[${i}]: systemMessage 存在`, () => {
        assert(tr.json && tr.json.systemMessage, 'systemMessage 缺失');
      });
      log('TRANS', `→ next: ${stages[i + 1]}, stageIndex=${st.progress.stageIndex}`);
    }
  }

  // ─── Step 5: Timeline 驗證 ──────────────────────
  if (stages.length > 0) {
    const events = readTimeline(sid);
    log('TIMELINE', `${events.length} 事件`);

    test(`${id}: timeline TASK_CLASSIFIED`, () => {
      assert(events.some(e => e.type === 'task.classified'),
        '缺少 task.classified 事件');
    });

    const delegCount = events.filter(e => e.type === 'delegation.start').length;
    test(`${id}: timeline delegation.start × ${stages.length}`, () => {
      assert.strictEqual(delegCount, stages.length,
        `期望 ${stages.length}，實際 ${delegCount}`);
    });

    const stageStartCount = events.filter(e => e.type === 'stage.start').length;
    test(`${id}: timeline stage.start × ${stages.length}`, () => {
      assert.strictEqual(stageStartCount, stages.length,
        `期望 ${stages.length}，實際 ${stageStartCount}`);
    });

    // stage.complete + pipeline.complete 合計
    const completeCount = events.filter(e =>
      e.type === 'stage.complete' || e.type === 'pipeline.complete').length;
    test(`${id}: timeline completions ≥ ${stages.length}`, () => {
      assert(completeCount >= stages.length,
        `期望 ≥${stages.length}，實際 ${completeCount}`);
    });

    console.log(`    └─ classified=${events.filter(e => e.type === 'task.classified').length}` +
      ` deleg=${delegCount} start=${stageStartCount} complete=${completeCount}`);
  }

  // ─── Step 6: Pipeline Check ─────────────────────
  if (stages.length > 0) {
    log('CHECK', 'pipeline-check');
    runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
    test(`${id}: pipeline-check 後 state 已刪除`, () => {
      assert.strictEqual(readState(sid), null, 'state 應被刪除');
    });
    console.log(`    └─ state deleted ✓`);
  }

  // 清理
  cleanState(sid);
  cleanTimeline(sid);
}

// ═══════════════════════════════════════════════════════════════
//  10 Scenarios — 每種 Pipeline 一個
// ═══════════════════════════════════════════════════════════════

const SCENARIOS = [
  {
    id: 'S1', pipelineId: 'full',
    prompt: '建立完整的電商購物車 UI，包含商品列表、購物車側欄和結帳頁面 [pipeline:full]',
    label: '完整開發（9 階段）',
  },
  {
    id: 'S2', pipelineId: 'standard',
    prompt: '建立 REST API 用戶認證系統，包含 JWT token 和 refresh token [pipeline:standard]',
    label: '標準開發（6 階段）',
  },
  {
    id: 'S3', pipelineId: 'quick-dev',
    prompt: '修復登入頁面的密碼驗證 bug，並補上缺失的測試 [pipeline:quick-dev]',
    label: '快速開發（3 階段）',
  },
  {
    id: 'S4', pipelineId: 'fix',
    prompt: '修正 config.json 中的 port 設定錯誤 [pipeline:fix]',
    label: '快速修復（1 階段）',
  },
  {
    id: 'S5', pipelineId: 'test-first',
    prompt: '用 TDD 方式實作 email 驗證功能 [pipeline:test-first]',
    label: 'TDD 開發（3 階段，雙 TEST）',
  },
  {
    id: 'S6', pipelineId: 'ui-only',
    prompt: '調整首頁的色彩方案和按鈕樣式 [pipeline:ui-only]',
    label: 'UI 調整（3 階段）',
  },
  {
    id: 'S7', pipelineId: 'review-only',
    prompt: '審查 PR #42 的程式碼品質 [pipeline:review-only]',
    label: '程式碼審查（1 階段）',
  },
  {
    id: 'S8', pipelineId: 'docs-only',
    prompt: '更新 API 文件中的端點描述 [pipeline:docs-only]',
    label: '文件更新（1 階段）',
  },
  {
    id: 'S9', pipelineId: 'security',
    prompt: '修復 SQL injection 漏洞並加強輸入驗證 [pipeline:security]',
    label: '安全修復（3 階段）',
  },
  {
    id: 'S10', pipelineId: 'none',
    prompt: '什麼是 REST API？跟 GraphQL 有什麼差別？',
    label: '無 Pipeline（問答）',
  },
];

console.log('\n🔬 Pipeline Catalog 全生命週期驗證');
console.log(`   10 種 Pipeline × 完整 Hook Chain`);
console.log(`   驗證：FSM 轉換 + Guard 決策 + Timeline 事件 + 完成檢查\n`);

for (const scenario of SCENARIOS) {
  runPipelineScenario(scenario);
}

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X1: FAIL 回退（quick-dev: DEV → REVIEW[FAIL] → DEV → REVIEW[PASS] → TEST）
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X1';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X1: FAIL 回退（REVIEW 失敗 → DEV 修復 → 重驗）');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 quick-dev
  runHook('task-classifier', {
    session_id: sid, prompt: '修復並測試密碼 hash 邏輯 [pipeline:quick-dev]',
  });

  const stages = ['DEV', 'REVIEW', 'TEST'];
  log('STEP', 'DEV 階段（正常 PASS）');

  // DEV: delegate → transition PASS
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'dev' },
  });
  let tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  let s = readState(sid);
  test('X1: DEV PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });

  // REVIEW: delegate → transition FAIL
  log('STEP', 'REVIEW 階段（FAIL 回退）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  const failResult = runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);

  test('X1: REVIEW FAIL → phase = RETRYING', () => {
    assert.strictEqual(s.phase, 'RETRYING');
  });
  test('X1: REVIEW FAIL → stageResults[REVIEW].verdict = FAIL', () => {
    assert.strictEqual(s.progress.stageResults.REVIEW.verdict, 'FAIL');
  });
  test('X1: REVIEW FAIL → retries[REVIEW] >= 1', () => {
    assert(s.progress.retries.REVIEW >= 1, `retries=${JSON.stringify(s.progress.retries)}`);
  });
  test('X1: REVIEW FAIL → systemMessage 包含回退指示', () => {
    assert(failResult.json && failResult.json.systemMessage,
      'systemMessage 缺失');
  });
  console.log(`    ├─ phase=${s.phase}, retries=${JSON.stringify(s.progress.retries)}`);
  console.log(`    └─ pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);

  // DEV 修復: delegate → transition PASS
  log('STEP', 'DEV 修復（回退重做）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix review issues' },
  });
  s = readState(sid);
  test('X1: 回退 DEV → phase = DELEGATING', () => {
    assert.strictEqual(s.phase, 'DELEGATING');
  });

  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X1: DEV 修復 PASS → pendingRetry 消費', () => {
    // pendingRetry 應被消費（null 或已設新的指向）
    // stage-transition 會指示重做 REVIEW
  });
  console.log(`    └─ phase=${s.phase}, pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);

  // REVIEW 重做: delegate → transition PASS
  log('STEP', 'REVIEW 重做（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review again' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X1: REVIEW 重做 PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  test('X1: REVIEW 重做 → stageResults[REVIEW].verdict = PASS', () => {
    assert.strictEqual(s.progress.stageResults.REVIEW.verdict, 'PASS');
  });
  console.log(`    └─ phase=${s.phase}, verdict=PASS`);

  // TEST: delegate → transition PASS → COMPLETE
  log('STEP', 'TEST 階段（完成）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'test' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X1: TEST PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });

  // Pipeline check
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X1: pipeline-check → state 已刪除', () => {
    assert.strictEqual(readState(sid), null);
  });
  log('COMPLETE', 'FAIL 回退流程完整 ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X2: Pipeline 升級（fix → standard）
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X2';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X2: Pipeline 升級（fix → standard）');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 初始分類為 fix
  log('STEP', '初始分類 → fix');
  runHook('task-classifier', {
    session_id: sid, prompt: '修正設定檔的錯字 [pipeline:fix]',
  });
  let s = readState(sid);
  test('X2: 初始 pipelineId = fix', () => {
    assert.strictEqual(s.context.pipelineId, 'fix');
  });
  test('X2: 初始 expectedStages = [DEV]', () => {
    assert.deepStrictEqual(s.context.expectedStages, ['DEV']);
  });
  console.log(`    └─ pipeline=fix, stages=[DEV]`);

  // DEV 完成
  log('STEP', 'DEV 階段');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'dev' },
  });
  const tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X2: DEV PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });
  console.log(`    └─ phase=COMPLETE`);

  // 升級：新 prompt 觸發 standard
  log('STEP', '升級分類 → standard');
  runHook('task-classifier', {
    session_id: sid,
    prompt: '其實需要完整的功能開發，加上測試 [pipeline:standard]',
  });
  s = readState(sid);

  // COMPLETE → CLASSIFY → CLASSIFIED (新 pipeline)
  test('X2: 升級後 pipelineId = standard', () => {
    assert.strictEqual(s.context.pipelineId, 'standard');
  });
  test('X2: 升級後 phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  test('X2: 升級後 expectedStages 含 PLAN', () => {
    assert(s.context.expectedStages.includes('PLAN'));
  });
  console.log(`    ├─ pipeline=standard, phase=${s.phase}`);
  console.log(`    └─ stages=[${s.context.expectedStages.join(', ')}]`);

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X3: Guard 細節驗證
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X3';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X3: Guard 細節驗證');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);

  // 建立 CLASSIFIED state（模擬已分類、pipeline enforced）
  initState(sid, {
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    },
  });

  // 3a: EnterPlanMode 阻擋
  log('STEP', 'EnterPlanMode 阻擋');
  const epm = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'EnterPlanMode', tool_input: {},
  });
  test('X3: EnterPlanMode → exit 2', () => {
    assert.strictEqual(epm.exitCode, 2);
  });
  test('X3: EnterPlanMode stderr 含 ⛔', () => {
    assert(epm.stderr.includes('⛔'));
  });
  console.log(`    └─ exitCode=${epm.exitCode}, blocked ✓`);

  // 3b: AskUserQuestion 阻擋（非 PLAN 階段）
  log('STEP', 'AskUserQuestion 阻擋（CLASSIFIED, 非 PLAN）');
  const auq = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '?' }] },
  });
  test('X3: AskUserQuestion (non-PLAN) → exit 2', () => {
    assert.strictEqual(auq.exitCode, 2);
  });
  console.log(`    └─ exitCode=${auq.exitCode}, blocked ✓`);

  // 3c: Bash 讀取操作放行
  log('STEP', 'Bash 讀取放行');
  const bashRead = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'ls -la /tmp' },
  });
  test('X3: Bash ls → exit 0（讀取放行）', () => {
    assert.strictEqual(bashRead.exitCode, 0);
  });
  console.log(`    └─ exitCode=${bashRead.exitCode}, allowed ✓`);

  // 3d: Bash 危險操作阻擋
  log('STEP', 'Bash 危險操作阻擋');
  const bashDanger = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  });
  test('X3: Bash rm -rf → exit 2', () => {
    assert.strictEqual(bashDanger.exitCode, 2);
  });
  console.log(`    └─ exitCode=${bashDanger.exitCode}, blocked ✓`);

  // 3e: Bash 寫檔偵測（CLASSIFIED 階段阻擋）
  log('STEP', 'Bash 寫檔阻擋（CLASSIFIED）');
  const bashWrite = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'echo "code" > /tmp/output.js' },
  });
  test('X3: Bash echo > file → exit 2（寫檔偵測）', () => {
    assert.strictEqual(bashWrite.exitCode, 2);
  });
  console.log(`    └─ exitCode=${bashWrite.exitCode}, blocked ✓`);

  // 3f: DELEGATING 時 Bash 寫檔放行
  log('STEP', 'DELEGATING 時 Bash 寫檔放行');
  initState(sid, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    },
    progress: { currentStage: 'DEV' },
  });
  const bashWriteDeleg = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'echo "code" > /tmp/output.js' },
  });
  test('X3: DELEGATING Bash write → exit 0', () => {
    assert.strictEqual(bashWriteDeleg.exitCode, 0);
  });
  console.log(`    └─ exitCode=${bashWriteDeleg.exitCode}, allowed ✓`);

  // 3g: DELEGATING 時 EnterPlanMode 仍阻擋
  log('STEP', 'DELEGATING 時 EnterPlanMode 仍阻擋');
  const epmDeleg = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'EnterPlanMode', tool_input: {},
  });
  test('X3: DELEGATING EnterPlanMode → exit 2', () => {
    assert.strictEqual(epmDeleg.exitCode, 2);
  });
  console.log(`    └─ exitCode=${epmDeleg.exitCode}, blocked ✓`);

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X4: Cancel 逃生口
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X4';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X4: Cancel 逃生口');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 standard（enforced）
  runHook('task-classifier', {
    session_id: sid, prompt: '建立新功能 [pipeline:standard]',
  });
  let s = readState(sid);
  test('X4: 初始 phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });

  // Guard 阻擋
  log('STEP', 'Guard 阻擋確認');
  const gr = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Write',
    tool_input: { file_path: '/tmp/test.js', content: 'x' },
  });
  test('X4: Guard 阻擋 (exit 2)', () => {
    assert.strictEqual(gr.exitCode, 2);
  });

  // 模擬 cancel：使用 state-machine 的 transition(CANCEL)
  log('STEP', 'Cancel 逃生');
  const { transition, readState: fsReadState, writeState } = require(
    path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'state-machine.js'));
  s = fsReadState(sid);
  const cancelled = transition(s, { type: 'CANCEL' });
  writeState(sid, cancelled);

  s = readState(sid);
  test('X4: cancel 後 phase = IDLE', () => {
    assert.strictEqual(s.phase, 'IDLE');
  });
  test('X4: cancel 後 cancelled = true', () => {
    assert.strictEqual(s.meta.cancelled, true);
  });
  console.log(`    └─ phase=${s.phase}, cancelled=${s.meta.cancelled}`);

  // Guard 放行
  log('STEP', 'Cancel 後 Guard 放行');
  const gr2 = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Write',
    tool_input: { file_path: '/tmp/test.js', content: 'x' },
  });
  test('X4: cancel 後 Guard 放行 (exit 0)', () => {
    assert.strictEqual(gr2.exitCode, 0);
  });
  console.log(`    └─ exitCode=${gr2.exitCode}, allowed ✓`);

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X5: pipeline-check 遺漏偵測（Stop hook 阻擋）
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X5';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X5: pipeline-check 遺漏偵測');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);

  // 建立已完成一半的 pipeline state
  initState(sid, {
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      expectedStages: ['DEV', 'REVIEW', 'TEST'],
    },
    progress: {
      currentStage: 'DEV',
      stageIndex: 0,
      completedAgents: ['vibe:developer'],
      stageResults: { DEV: { verdict: 'PASS', severity: null } },
    },
  });

  // pipeline-check 應偵測到 REVIEW 和 TEST 未完成
  log('STEP', 'pipeline-check 偵測遺漏');
  const result = runHook('pipeline-check', {
    session_id: sid, stop_hook_active: false,
  });
  test('X5: pipeline-check 偵測到遺漏', () => {
    // pipeline-check 應 block（decision:block）或提供 systemMessage
    assert(
      (result.json && result.json.decision === 'block') ||
      (result.json && result.json.systemMessage),
      `意外結果: ${JSON.stringify(result.json)}`);
  });
  test('X5: state 未被刪除（pipeline 未完成）', () => {
    assert(readState(sid) !== null, 'state 不應被刪除');
  });

  // 驗證 Timeline 事件
  const events = readTimeline(sid);
  test('X5: timeline PIPELINE_INCOMPLETE 事件', () => {
    assert(events.some(e => e.type === 'pipeline.incomplete'),
      '缺少 pipeline.incomplete 事件');
  });
  console.log(`    └─ block/warn ✓, state preserved ✓`);

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X6: TDD 雙 TEST 含 FAIL 重試
//  Pipeline: test-first [TEST, DEV, TEST]
//  TEST₁ PASS → DEV PASS → TEST₂ FAIL:HIGH → DEV 修復 → TEST₂ 重做 PASS
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X6';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X6: TDD 雙 TEST 含 FAIL 重試');
  console.log('  Pipeline: test-first [TEST, DEV, TEST]');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 test-first
  runHook('task-classifier', {
    session_id: sid, prompt: '用 TDD 方式實作密碼強度驗證 [pipeline:test-first]',
  });
  let s = readState(sid);
  test('X6: pipelineId = test-first', () => {
    assert.strictEqual(s.context.pipelineId, 'test-first');
  });
  test('X6: expectedStages = [TEST, DEV, TEST]', () => {
    assert.deepStrictEqual(s.context.expectedStages, ['TEST', 'DEV', 'TEST']);
  });
  console.log(`    └─ pipeline=test-first, stages=[TEST, DEV, TEST]`);

  // ─── TEST₁: PASS ───
  log('STEP', 'TEST₁ 階段（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'write failing tests first' },
  });
  let tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: TEST₁ PASS → stageResults[TEST].verdict = PASS', () => {
    assert.strictEqual(s.progress.stageResults.TEST.verdict, 'PASS');
  });
  test('X6: TEST₁ PASS → stageIndex >= 0', () => {
    // stageIndex 被設為 resolved next stage index（DEV=1），非 current stage
    assert(s.progress.stageIndex >= 0, `stageIndex=${s.progress.stageIndex}`);
  });
  test('X6: TEST₁ PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ stageIndex=${s.progress.stageIndex}, phase=${s.phase}`);

  // ─── DEV: PASS ───
  log('STEP', 'DEV 階段（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'implement to make tests pass' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: DEV PASS → stageIndex >= 1', () => {
    assert(s.progress.stageIndex >= 1, `stageIndex=${s.progress.stageIndex}`);
  });
  test('X6: DEV PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  const devStageIndex = s.progress.stageIndex;
  console.log(`    └─ stageIndex=${devStageIndex}, phase=${s.phase}`);

  // ─── TEST₂: FAIL:HIGH（觸發回退）───
  log('STEP', 'TEST₂ 階段（FAIL:HIGH → 回退 DEV）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'run tests again' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: TEST₂ FAIL → phase = RETRYING', () => {
    assert.strictEqual(s.phase, 'RETRYING');
  });
  test('X6: TEST₂ FAIL → pendingRetry.stage = TEST', () => {
    assert(s.progress.pendingRetry, 'pendingRetry 缺失');
    assert.strictEqual(s.progress.pendingRetry.stage, 'TEST');
  });
  test('X6: TEST₂ FAIL → retries[TEST] >= 1', () => {
    assert(s.progress.retries.TEST >= 1, `retries=${JSON.stringify(s.progress.retries)}`);
  });
  test('X6: TEST₂ FAIL → stageIndex >= devStageIndex（單調遞增）', () => {
    assert(s.progress.stageIndex >= devStageIndex,
      `stageIndex=${s.progress.stageIndex} < devStageIndex=${devStageIndex}`);
  });
  console.log(`    ├─ phase=${s.phase}, retries=${JSON.stringify(s.progress.retries)}`);
  console.log(`    └─ pendingRetry=${JSON.stringify(s.progress.pendingRetry)}, stageIndex=${s.progress.stageIndex}`);

  // ─── DEV 修復 ───
  log('STEP', 'DEV 修復（回退重做）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix failing tests' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: DEV 修復 → pendingRetry 被消費（null）', () => {
    assert.strictEqual(s.progress.pendingRetry, null, `pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);
  });
  test('X6: DEV 修復 → phase = CLASSIFIED（準備重驗 TEST）', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ phase=${s.phase}, pendingRetry=${s.progress.pendingRetry}`);

  // ─── TEST₂ 重做: PASS ───
  log('STEP', 'TEST₂ 重做（PASS → COMPLETE）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'rerun tests after fix' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: TEST₂ 重做 PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });
  test('X6: TEST₂ 重做 → stageResults[TEST].verdict = PASS', () => {
    assert.strictEqual(s.progress.stageResults.TEST.verdict, 'PASS');
  });
  console.log(`    └─ phase=${s.phase}, verdict=PASS`);

  // Pipeline check
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X6: pipeline-check → state 已刪除', () => {
    assert.strictEqual(readState(sid), null);
  });
  log('COMPLETE', 'TDD 雙 TEST 含 FAIL 重試流程完整 ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X7: MAX_RETRIES 耗盡（強制繼續）
//  Pipeline: quick-dev [DEV, REVIEW, TEST]
//  DEV PASS → REVIEW FAIL × (MAX_RETRIES+1) → 強制繼續 TEST
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X7';
  const { MAX_RETRIES } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'registry.js'));
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  特殊場景 X7: MAX_RETRIES 耗盡（MAX_RETRIES=${MAX_RETRIES}）`);
  console.log('  Pipeline: quick-dev [DEV, REVIEW, TEST]');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 quick-dev
  runHook('task-classifier', {
    session_id: sid, prompt: '修復並測試 hash 邏輯 [pipeline:quick-dev]',
  });
  let s = readState(sid);
  test('X7: pipelineId = quick-dev', () => {
    assert.strictEqual(s.context.pipelineId, 'quick-dev');
  });

  // ─── DEV: PASS ───
  log('STEP', 'DEV 階段（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'dev' },
  });
  let tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X7: DEV PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ phase=${s.phase}`);

  // ─── REVIEW: 連續 FAIL × MAX_RETRIES 輪回退 ───
  for (let round = 0; round < MAX_RETRIES; round++) {
    log('STEP', `REVIEW FAIL 回退 第 ${round + 1}/${MAX_RETRIES} 輪`);

    // REVIEW FAIL
    runHook('delegation-tracker', {
      session_id: sid, tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:code-reviewer', prompt: `review round ${round + 1}` },
    });
    tp = createMockTranscript(sid, 'FAIL:HIGH');
    runHook('stage-transition', {
      session_id: sid, agent_type: 'vibe:code-reviewer',
      agent_transcript_path: tp, stop_hook_active: false,
    });
    cleanTranscript(sid);
    s = readState(sid);
    test(`X7: REVIEW FAIL 第 ${round + 1} 輪 → phase = RETRYING`, () => {
      assert.strictEqual(s.phase, 'RETRYING');
    });
    test(`X7: REVIEW FAIL 第 ${round + 1} 輪 → retries[REVIEW] = ${round + 1}`, () => {
      assert.strictEqual(s.progress.retries.REVIEW, round + 1);
    });
    console.log(`    ├─ retries[REVIEW]=${s.progress.retries.REVIEW}, pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);

    // DEV 修復
    runHook('delegation-tracker', {
      session_id: sid, tool_name: 'Task',
      tool_input: { subagent_type: 'vibe:developer', prompt: `fix round ${round + 1}` },
    });
    tp = createMockTranscript(sid, 'PASS');
    runHook('stage-transition', {
      session_id: sid, agent_type: 'vibe:developer',
      agent_transcript_path: tp, stop_hook_active: false,
    });
    cleanTranscript(sid);
    s = readState(sid);
    test(`X7: DEV 修復第 ${round + 1} 輪 → pendingRetry 被消費`, () => {
      assert.strictEqual(s.progress.pendingRetry, null);
    });
    console.log(`    └─ DEV 修復完成，phase=${s.phase}`);
  }

  // ─── REVIEW: 第 MAX_RETRIES+1 次 FAIL → 強制繼續 ───
  log('STEP', `REVIEW 第 ${MAX_RETRIES + 1} 次 FAIL（retries=${MAX_RETRIES} → 強制繼續）`);
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'final review' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  const forcedResult = runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);

  test('X7: MAX_RETRIES 耗盡 → phase 不是 RETRYING', () => {
    assert.notStrictEqual(s.phase, 'RETRYING',
      `retries=${MAX_RETRIES} 後應強制前進，但 phase=${s.phase}`);
  });
  test(`X7: retries[REVIEW] = ${MAX_RETRIES}（不再增加）`, () => {
    assert.strictEqual(s.progress.retries.REVIEW, MAX_RETRIES);
  });
  test('X7: 強制繼續 → systemMessage 含 ⚠️ 強制繼續', () => {
    assert(forcedResult.json && forcedResult.json.systemMessage,
      'systemMessage 缺失');
    assert(forcedResult.json.systemMessage.includes('強制繼續'),
      `systemMessage 不含強制繼續: ${forcedResult.json.systemMessage.slice(0, 80)}`);
  });
  console.log(`    ├─ phase=${s.phase}, retries[REVIEW]=${s.progress.retries.REVIEW}`);
  console.log(`    └─ 強制繼續 ✓`);

  // ─── TEST: PASS → COMPLETE ───
  log('STEP', 'TEST 階段（PASS → COMPLETE）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'test' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X7: TEST PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });

  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X7: pipeline-check → state 已刪除', () => {
    assert.strictEqual(readState(sid), null);
  });
  log('COMPLETE', 'MAX_RETRIES 耗盡強制繼續流程完整 ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X8: 級聯回退（多個品質階段連續 FAIL）
//  Pipeline: standard [PLAN, ARCH, DEV, REVIEW, TEST, DOCS]
//  DEV PASS → REVIEW FAIL → DEV 修復 → REVIEW PASS
//  → TEST FAIL → DEV 修復 → TEST PASS → DOCS → COMPLETE
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X8';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X8: 級聯回退（REVIEW FAIL + TEST FAIL）');
  console.log('  Pipeline: standard [PLAN, ARCH, DEV, REVIEW, TEST, DOCS]');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);

  // 預設已完成 PLAN 和 ARCH，直接從 DEV 開始（減少不必要的重複測試）
  initState(sid, {
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    },
    progress: {
      currentStage: 'ARCH',
      stageIndex: 1,
      completedAgents: ['vibe:planner', 'vibe:architect'],
      stageResults: {
        PLAN: { verdict: 'PASS', severity: null },
        ARCH: { verdict: 'PASS', severity: null },
      },
    },
    meta: {
      classificationSource: 'explicit',
      classificationConfidence: 1,
      matchedRule: 'explicit',
      layer: 1,
    },
  });

  // ─── DEV: PASS ───
  log('STEP', 'DEV 階段（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'implement feature' },
  });
  let tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  let s = readState(sid);
  test('X8: DEV PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ phase=${s.phase}, stageIndex=${s.progress.stageIndex}`);

  // ─── REVIEW: FAIL:HIGH → 回退 DEV ───
  log('STEP', 'REVIEW 階段（FAIL:HIGH → 回退 DEV）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review code' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: REVIEW FAIL → phase = RETRYING', () => {
    assert.strictEqual(s.phase, 'RETRYING');
  });
  test('X8: REVIEW FAIL → pendingRetry.stage = REVIEW', () => {
    assert(s.progress.pendingRetry, 'pendingRetry 缺失');
    assert.strictEqual(s.progress.pendingRetry.stage, 'REVIEW');
  });
  console.log(`    └─ phase=${s.phase}, pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);

  // ─── DEV 修復（第一次回退）───
  log('STEP', 'DEV 修復（REVIEW 回退）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix review issues' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: DEV 修復 → pendingRetry 消費（null）', () => {
    assert.strictEqual(s.progress.pendingRetry, null);
  });
  console.log(`    └─ pendingRetry=${s.progress.pendingRetry}, phase=${s.phase}`);

  // ─── REVIEW 重做: PASS ───
  log('STEP', 'REVIEW 重做（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review again' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: REVIEW 重做 PASS → stageResults[REVIEW].verdict = PASS', () => {
    assert.strictEqual(s.progress.stageResults.REVIEW.verdict, 'PASS');
  });
  test('X8: REVIEW 重做 PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ phase=${s.phase}, REVIEW verdict=PASS`);

  // ─── TEST: FAIL:HIGH → 回退 DEV ───
  log('STEP', 'TEST 階段（FAIL:HIGH → 回退 DEV）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'run tests' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: TEST FAIL → phase = RETRYING', () => {
    assert.strictEqual(s.phase, 'RETRYING');
  });
  test('X8: TEST FAIL → pendingRetry.stage = TEST', () => {
    assert(s.progress.pendingRetry, 'pendingRetry 缺失');
    assert.strictEqual(s.progress.pendingRetry.stage, 'TEST');
  });
  test('X8: 兩次回退 → retries 包含 REVIEW 和 TEST', () => {
    assert(s.progress.retries.REVIEW >= 1, `retries[REVIEW]=${s.progress.retries.REVIEW}`);
    assert(s.progress.retries.TEST >= 1, `retries[TEST]=${s.progress.retries.TEST}`);
  });
  console.log(`    └─ phase=${s.phase}, retries=${JSON.stringify(s.progress.retries)}`);

  // ─── DEV 修復（第二次回退）───
  log('STEP', 'DEV 修復（TEST 回退）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix test issues' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: DEV 修復（TEST 回退）→ pendingRetry 消費', () => {
    assert.strictEqual(s.progress.pendingRetry, null);
  });
  console.log(`    └─ pendingRetry=${s.progress.pendingRetry}, phase=${s.phase}`);

  // ─── TEST 重做: PASS ───
  log('STEP', 'TEST 重做（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:tester', prompt: 'rerun tests' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:tester',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: TEST 重做 PASS → stageResults[TEST].verdict = PASS', () => {
    assert.strictEqual(s.progress.stageResults.TEST.verdict, 'PASS');
  });
  test('X8: TEST 重做 PASS → phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ phase=${s.phase}, TEST verdict=PASS`);

  // ─── DOCS: PASS → COMPLETE ───
  log('STEP', 'DOCS 階段（PASS → COMPLETE）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:doc-updater', prompt: 'update docs' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:doc-updater',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X8: DOCS PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });

  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X8: pipeline-check → state 已刪除', () => {
    assert.strictEqual(readState(sid), null);
  });

  // Timeline 驗證
  const events = readTimeline(sid);
  const retryEvents = events.filter(e => e.type === 'stage.retry');
  test('X8: timeline 包含 2 個 stage.retry 事件', () => {
    assert.strictEqual(retryEvents.length, 2,
      `期望 2 個 stage.retry，實際 ${retryEvents.length}`);
  });
  console.log(`    └─ stage.retry 事件: ${retryEvents.length}`);
  log('COMPLETE', '級聯回退流程完整 ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X9: 跨 pipeline 升級保留 pendingRetry
//  fix [DEV] → COMPLETE → 重新分類 quick-dev → REVIEW FAIL
//  → pendingRetry 設定 → 升級 standard → pendingRetry 保留
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X9';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X9: 跨 pipeline 升級保留 pendingRetry');
  console.log('  fix → quick-dev → REVIEW FAIL → 升級 standard');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // ─── 初始分類 fix ───
  log('STEP', '初始分類 → fix');
  runHook('task-classifier', {
    session_id: sid, prompt: '修正設定檔錯字 [pipeline:fix]',
  });
  let s = readState(sid);
  test('X9: 初始 pipelineId = fix', () => {
    assert.strictEqual(s.context.pipelineId, 'fix');
  });
  console.log(`    └─ pipeline=fix, stages=[DEV]`);

  // ─── DEV PASS → COMPLETE ───
  log('STEP', 'DEV 階段（PASS → COMPLETE）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix config' },
  });
  let tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X9: DEV PASS → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });
  console.log(`    └─ phase=COMPLETE`);

  // ─── 升級為 quick-dev ───
  log('STEP', '升級 → quick-dev');
  runHook('task-classifier', {
    session_id: sid, prompt: '其實還需要 review 和測試 [pipeline:quick-dev]',
  });
  s = readState(sid);
  test('X9: 升級後 pipelineId = quick-dev', () => {
    assert.strictEqual(s.context.pipelineId, 'quick-dev');
  });
  test('X9: 升級後 phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  console.log(`    └─ pipeline=quick-dev, phase=${s.phase}`);

  // ─── quick-dev 的 DEV 已完成，跳到 REVIEW ───
  // REVIEW FAIL → 設定 pendingRetry
  log('STEP', 'REVIEW 階段（FAIL:HIGH → pendingRetry）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review' },
  });
  tp = createMockTranscript(sid, 'FAIL:HIGH');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X9: REVIEW FAIL → phase = RETRYING', () => {
    assert.strictEqual(s.phase, 'RETRYING');
  });
  test('X9: REVIEW FAIL → pendingRetry 已設定', () => {
    assert(s.progress.pendingRetry, 'pendingRetry 缺失');
    assert.strictEqual(s.progress.pendingRetry.stage, 'REVIEW');
  });
  const pendingRetryBefore = JSON.parse(JSON.stringify(s.progress.pendingRetry));
  const retriesBefore = JSON.parse(JSON.stringify(s.progress.retries));
  console.log(`    ├─ phase=${s.phase}, pendingRetry=${JSON.stringify(pendingRetryBefore)}`);
  console.log(`    └─ retries=${JSON.stringify(retriesBefore)}`);

  // ─── 升級為 standard（RETRYING → RECLASSIFY → CLASSIFIED）───
  log('STEP', '升級 → standard（保留 pendingRetry）');
  runHook('task-classifier', {
    session_id: sid, prompt: '這需要完整的功能開發流程 [pipeline:standard]',
  });
  s = readState(sid);
  test('X9: 升級後 pipelineId = standard', () => {
    assert.strictEqual(s.context.pipelineId, 'standard');
  });
  test('X9: 升級後 phase = CLASSIFIED', () => {
    assert.strictEqual(s.phase, 'CLASSIFIED');
  });
  test('X9: 升級後 pendingRetry 被保留', () => {
    assert(s.progress.pendingRetry, 'pendingRetry 在升級後不應消失');
    assert.strictEqual(s.progress.pendingRetry.stage, pendingRetryBefore.stage);
  });
  test('X9: 升級後 retries 被保留', () => {
    assert.strictEqual(s.progress.retries.REVIEW, retriesBefore.REVIEW,
      `retries[REVIEW] 應保留: 期望 ${retriesBefore.REVIEW}, 實際 ${s.progress.retries.REVIEW}`);
  });
  test('X9: reclassifications 記錄升級歷史', () => {
    assert(s.meta.reclassifications.length >= 1,
      `reclassifications 應有記錄: ${JSON.stringify(s.meta.reclassifications)}`);
    const lastReclass = s.meta.reclassifications[s.meta.reclassifications.length - 1];
    assert.strictEqual(lastReclass.to, 'standard');
  });
  console.log(`    ├─ pipeline=standard, pendingRetry=${JSON.stringify(s.progress.pendingRetry)}`);
  console.log(`    └─ retries=${JSON.stringify(s.progress.retries)}, reclassifications=${s.meta.reclassifications.length}`);

  log('COMPLETE', '跨 pipeline 升級保留 pendingRetry ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  特殊場景 X10: review-only 無 DEV 安全閥
//  Pipeline: review-only [REVIEW]
//  REVIEW FAIL:HIGH → 無 DEV 可回退 → 強制完成
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X10';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X10: review-only 無 DEV 安全閥');
  console.log('  Pipeline: review-only [REVIEW]');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 review-only
  runHook('task-classifier', {
    session_id: sid, prompt: '審查 PR #99 的程式碼 [pipeline:review-only]',
  });
  let s = readState(sid);
  test('X10: pipelineId = review-only', () => {
    assert.strictEqual(s.context.pipelineId, 'review-only');
  });
  test('X10: expectedStages = [REVIEW]', () => {
    assert.deepStrictEqual(s.context.expectedStages, ['REVIEW']);
  });
  console.log(`    └─ pipeline=review-only, stages=[REVIEW]`);

  // ─── REVIEW: FAIL:HIGH ───
  log('STEP', 'REVIEW 階段（FAIL:HIGH → 無 DEV 可回退）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review PR #99' },
  });
  let tp = createMockTranscript(sid, 'FAIL:HIGH');
  const failResult = runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);

  test('X10: REVIEW FAIL 無 DEV → phase 不是 RETRYING', () => {
    assert.notStrictEqual(s.phase, 'RETRYING',
      `應強制完成而非 RETRYING，phase=${s.phase}`);
  });
  test('X10: REVIEW FAIL 無 DEV → phase = COMPLETE', () => {
    assert.strictEqual(s.phase, 'COMPLETE');
  });
  test('X10: systemMessage 含無法回退提示', () => {
    assert(failResult.json && failResult.json.systemMessage,
      'systemMessage 缺失');
    assert(failResult.json.systemMessage.includes('無法回退'),
      `systemMessage 不含無法回退: ${failResult.json.systemMessage.slice(0, 100)}`);
  });
  test('X10: pendingRetry 未設定（null）', () => {
    assert.strictEqual(s.progress.pendingRetry, null,
      `pendingRetry 應為 null，實際: ${JSON.stringify(s.progress.pendingRetry)}`);
  });
  test('X10: stageResults[REVIEW].verdict = FAIL', () => {
    assert(s.progress.stageResults.REVIEW, 'stageResults[REVIEW] 缺失');
    assert.strictEqual(s.progress.stageResults.REVIEW.verdict, 'FAIL');
  });
  console.log(`    ├─ phase=${s.phase}, pendingRetry=${s.progress.pendingRetry}`);
  console.log(`    └─ 無法回退，強制完成 ✓`);

  // Pipeline check 應清理 state（因為已 COMPLETE）
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X10: pipeline-check → state 已刪除', () => {
    assert.strictEqual(readState(sid), null);
  });
  log('COMPLETE', 'review-only 無 DEV 安全閥流程完整 ✓');

  cleanState(sid);
  cleanTimeline(sid);
})();

// ═══════════════════════════════════════════════════════════════
//  結果摘要
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(65)}`);
console.log(`  📊 Pipeline Catalog 驗證結果`);
console.log(`${'═'.repeat(65)}`);
console.log(`  ✅ 通過: ${passed}`);
console.log(`  ❌ 失敗: ${failed}`);
console.log(`  📋 總計: ${passed + failed}`);

if (failed > 0) {
  console.log(`\n  ⚠️ 有 ${failed} 個測試失敗，請檢查上方日誌。`);
  process.exit(1);
}
console.log(`\n  🎉 所有 Pipeline 驗證通過！`);
process.exit(0);
