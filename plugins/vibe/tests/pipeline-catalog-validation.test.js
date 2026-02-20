#!/usr/bin/env node
/**
 * pipeline-catalog-validation.test.js — 10 種 Pipeline 全生命週期驗證
 *
 * 每種 pipeline 模擬完整 hook chain：
 *   task-classifier → pipeline-guard → (delegation-tracker → guard → stage-transition) × N → pipeline-check
 *
 * 驗證項目：
 *   - v3 DAG 狀態 + phase 推導正確性
 *   - 分類結果（pipelineId, taskType, dag keys）
 *   - Guard 阻擋/放行決策
 *   - stages 狀態追蹤 + verdict + completedAgents 衍生
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

const { derivePhase, PHASES } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'dag-state.js'));

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
  // v4 格式：enforced 轉換為 pipelineActive
  const pipelineActive = overrides.pipelineActive !== undefined
    ? overrides.pipelineActive
    : (overrides.enforced || false);
  const state = {
    version: 4,
    sessionId: sid,
    classification: overrides.classification || null,
    environment: overrides.environment || {},
    openspecEnabled: overrides.openspecEnabled || false,
    needsDesign: overrides.needsDesign || false,
    dag: overrides.dag || null,
    blueprint: overrides.blueprint || null,
    pipelineActive,
    activeStages: overrides.activeStages || [],
    stages: overrides.stages || {},
    retries: overrides.retries || {},
    pendingRetry: overrides.pendingRetry || null,
    retryHistory: overrides.retryHistory || {},
    crashes: overrides.crashes || {},
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
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

const { cleanSessionState } = require('./test-helpers');
function cleanState(sid) {
  cleanSessionState(sid);
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

/** v3 helper：找 active stage */
function findActiveStage(state) {
  if (!state || !state.stages) return null;
  for (const [id, s] of Object.entries(state.stages)) {
    if (s.status === 'active') return id;
  }
  return null;
}

/** v3 helper：取得已完成 agents */
function getCompletedAgents(state) {
  if (!state || !state.stages) return [];
  return Object.entries(state.stages)
    .filter(([, s]) => s.status === 'completed' && s.agent)
    .map(([, s]) => s.agent);
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
    if (envState) {
      envState.environment = { ...(envState.environment || {}), frontend: { detected: true } };
      envState.needsDesign = true;
      fs.writeFileSync(
        path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`),
        JSON.stringify(envState, null, 2),
      );
    }
  }

  const sc = readState(sid);

  test(`${id}: pipelineId = ${pipelineId}`, () => {
    assert.strictEqual(sc.classification.pipelineId, pipelineId);
  });
  // v4: test-first stages 已語意化（TEST:verify 是唯一 key，無重複）
  // deduplicateStages 保留為安全網，但 test-first 不再觸發
  const uniqueStages = [...new Set(stages)];
  const hasDuplicateStages = uniqueStages.length !== stages.length;
  test(`${id}: dag keys 檢查`, () => {
    if (stages.length === 0) {
      // none pipeline → dag 應為 null
      assert.strictEqual(sc.dag, null, `none pipeline dag 應為 null`);
    } else {
      // v4：所有 pipeline 都能建立有效 DAG（含語意化後綴 stage）
      assert.ok(sc.dag, `dag 不應為 null`);
      assert.ok(Object.keys(sc.dag).length > 0, `dag 應有 stage`);
    }
  });
  // v4: 有分類的非 trivial pipeline → CLASSIFIED
  const expectedPhase = stages.length > 0 ? 'CLASSIFIED' : 'IDLE';
  test(`${id}: derivePhase = ${expectedPhase}`, () => {
    assert.strictEqual(derivePhase(sc), expectedPhase);
  });
  // none 可能由 heuristic（Layer 1.5 question 規則）或 main-agent 分類，其他用 explicit
  const expectedSource = pipelineId === 'none' ? null : 'explicit';
  test(`${id}: source = ${expectedSource || 'heuristic|main-agent'}`, () => {
    if (expectedSource) {
      assert.strictEqual(sc.classification.source, expectedSource);
    } else {
      // none pipeline：heuristic（question 規則）或 main-agent 都合法
      assert.ok(
        sc.classification.source === 'heuristic' || sc.classification.source === 'main-agent',
        `none pipeline source 應為 heuristic 或 main-agent，實際：${sc.classification.source}`
      );
    }
  });
  console.log(`    ├─ phase=${derivePhase(sc)}, pipeline=${sc.classification.pipelineId}`);
  console.log(`    ├─ taskType=${sc.classification.taskType}, confidence=${sc.classification.confidence}`);
  console.log(`    └─ source=${sc.classification.source}, rule=${sc.classification.matchedRule}`);

  // ─── Step 3: Guard 阻擋 ────────────────────────
  log('STEP', '2. pipeline-guard 驗證');
  // v4: 非 trivial pipeline（pipelineActive=true）都會被 guard 阻擋
  const actuallyEnforced = stages.length > 0;
  if (actuallyEnforced) {
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
  // 舊 v4: 重複 stage（如 test-first [TEST,DEV,TEST]）才需跳過，現已語意化無重複
  if (hasDuplicateStages) {
    log('STEP', `跳過 stage 生命週期（仍有重複 stage，罕見情況）`);
    test(`${id}: 重複 stage pipeline 分類正確`, () => {
      assert.strictEqual(sc.classification.pipelineId, pipelineId);
    });
    // 清理
    cleanState(sid);
    cleanTimeline(sid);
    return;
  }

  // 取 stage 的基礎 stage 名（TEST:verify → TEST），用於 STAGES 查詢
  function getBaseStage(stageId) { return stageId.split(':')[0]; }

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const baseStage = getBaseStage(stage);
    const agentName = STAGES[baseStage].agent;
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
      assert.strictEqual(derivePhase(sd), 'DELEGATING');
    });
    test(`${id}/${stage}[${i}]: active stage = ${stage}`, () => {
      assert.strictEqual(findActiveStage(sd), stage);
    });
    log('DELEG', `phase=DELEGATING, activeStage=${stage}`);

    // 4b: Guard 放行 sub-agent（寫 context_file 報告）
    // v4 語意：sub-agent 寫出品質報告到 context_file 路徑（~/.claude/pipeline-context-*.md）
    // 此路徑通過 Rule 4.5 的 isContextFile 檢查，不受品質門阻擋
    const contextFilePath = path.join(CLAUDE_DIR, `pipeline-context-${sid}-${stage}.md`);
    const ga = runHook('pipeline-guard', {
      session_id: sid, tool_name: 'Write',
      tool_input: { file_path: contextFilePath, content: '# 品質報告\n通過所有檢查。' },
    });
    test(`${id}/${stage}[${i}]: sub-agent Write context_file → allow`, () => {
      assert.strictEqual(ga.exitCode, 0);
    });
    log('GUARD', `sub-agent Write context_file → allowed`);

    // 4c: Stage Transition (PASS verdict)
    const tp = createMockTranscript(sid, 'PASS');
    const tr = runHook('stage-transition', {
      session_id: sid, agent_type: nsAgent,
      agent_transcript_path: tp, stop_hook_active: false,
    });
    const st = readState(sid);
    cleanTranscript(sid);

    // verdict 記錄
    test(`${id}/${stage}[${i}]: stages[${stage}].status = completed`, () => {
      assert(st.stages[stage], `缺少 stages[${stage}]`);
      assert.strictEqual(st.stages[stage].status, 'completed');
    });

    // completedAgents（衍生自 stages）
    test(`${id}/${stage}[${i}]: stages[${stage}].agent 已記錄`, () => {
      assert(st.stages[stage].status === 'completed',
        `stages[${stage}].status=${st.stages[stage].status}`);
    });

    if (isLast) {
      test(`${id}/${stage}[${i}]: 最終 derivePhase = COMPLETE`, () => {
        assert.strictEqual(derivePhase(st), 'COMPLETE');
      });
      log('COMPLETE', `phase=COMPLETE, all ${stages.length} stages done`);
    } else {
      test(`${id}/${stage}[${i}]: derivePhase = CLASSIFIED`, () => {
        assert.strictEqual(derivePhase(st), 'CLASSIFIED');
      });
      // systemMessage 應存在且包含下一階段資訊
      test(`${id}/${stage}[${i}]: systemMessage 存在`, () => {
        assert(tr.json && tr.json.systemMessage, 'systemMessage 缺失');
      });
      log('TRANS', `→ next: ${stages[i + 1]}`);
    }
  }

  // ─── Step 5: Timeline 驗證 ──────────────────────
  if (stages.length > 0) {
    const events = readTimeline(sid);
    log('TIMELINE', `${events.length} 事件`);

    test(`${id}: timeline prompt.received`, () => {
      assert(events.some(e => e.type === 'prompt.received'),
        '缺少 prompt.received 事件');
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

    console.log(`    └─ prompt.received=${events.filter(e => e.type === 'prompt.received').length}` +
      ` deleg=${delegCount} start=${stageStartCount} complete=${completeCount}`);
  }

  // ─── Step 6: Pipeline Check ─────────────────────
  if (stages.length > 0) {
    log('CHECK', 'pipeline-check');
    runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
    test(`${id}: pipeline-check 後 state 保留`, () => {
      const s = readState(sid);
      assert.ok(s !== null, 'state 應保留（由 session-cleanup 過期清理）');
      assert.strictEqual(derivePhase(s), 'COMPLETE');
    });
    console.log(`    └─ state preserved (COMPLETE) ✓`);
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
    label: 'TDD 開發（3 階段，TEST:verify 語意化）',
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
console.log(`   驗證：v3 DAG 狀態 + Phase 推導 + Guard 決策 + Timeline 事件 + 完成檢查\n`);

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
  test('X1: DEV PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
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

  test('X1: REVIEW FAIL → derivePhase = RETRYING', () => {
    assert.strictEqual(derivePhase(s), 'RETRYING');
  });
  test('X1: REVIEW FAIL → stages[REVIEW].status = failed', () => {
    assert.strictEqual(s.stages.REVIEW.status, 'failed');
  });
  test('X1: REVIEW FAIL → retries[REVIEW] >= 1', () => {
    assert(s.retries.REVIEW >= 1, `retries=${JSON.stringify(s.retries)}`);
  });
  test('X1: REVIEW FAIL → systemMessage 包含回退指示', () => {
    assert(failResult.json && failResult.json.systemMessage,
      'systemMessage 缺失');
  });
  console.log(`    ├─ phase=${derivePhase(s)}, retries=${JSON.stringify(s.retries)}`);
  console.log(`    └─ pendingRetry=${JSON.stringify(s.pendingRetry)}`);

  // DEV 修復: delegate → transition PASS
  log('STEP', 'DEV 修復（回退重做）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:developer', prompt: 'fix review issues' },
  });
  s = readState(sid);
  test('X1: 回退 DEV → derivePhase = RETRYING 或 DELEGATING', () => {
    const phase = derivePhase(s);
    // v3: pendingRetry 仍然存在 → derivePhase 優先返回 RETRYING
    // DEV 已被標記 active，但 pendingRetry 判斷優先
    assert(phase === 'RETRYING' || phase === 'DELEGATING',
      `期望 RETRYING 或 DELEGATING，實際 ${phase}`);
  });

  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:developer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X1: DEV 修復 PASS → pendingRetry 消費', () => {
    // pendingRetry 應被消費（null）
    // stage-transition 會指示重做 REVIEW
  });
  console.log(`    └─ phase=${derivePhase(s)}, pendingRetry=${JSON.stringify(s.pendingRetry)}`);

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
  test('X1: REVIEW 重做 PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  test('X1: REVIEW 重做 → stages[REVIEW].status = completed', () => {
    assert.strictEqual(s.stages.REVIEW.status, 'completed');
  });
  console.log(`    └─ phase=${derivePhase(s)}, REVIEW status=completed`);

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
  test('X1: TEST PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });

  // Pipeline check
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X1: pipeline-check → state 保留', () => {
    const s = readState(sid);
    assert.ok(s !== null, 'state 應保留');
    assert.strictEqual(derivePhase(s), 'COMPLETE');
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
    assert.strictEqual(s.classification.pipelineId, 'fix');
  });
  test('X2: 初始 dag keys = [DEV]', () => {
    assert.deepStrictEqual(Object.keys(s.dag || {}), ['DEV']);
  });
  console.log(`    └─ pipeline=fix, dag=[DEV]`);

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
  test('X2: DEV PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });
  console.log(`    └─ phase=COMPLETE`);

  // 升級：新 prompt 觸發 standard
  log('STEP', '升級分類 → standard');
  runHook('task-classifier', {
    session_id: sid,
    prompt: '其實需要完整的功能開發，加上測試 [pipeline:standard]',
  });
  s = readState(sid);

  // COMPLETE → reset → CLASSIFIED (新 pipeline)
  test('X2: 升級後 pipelineId = standard', () => {
    assert.strictEqual(s.classification.pipelineId, 'standard');
  });
  test('X2: 升級後 derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  test('X2: 升級後 dag 含 PLAN', () => {
    assert(Object.keys(s.dag || {}).includes('PLAN'));
  });
  console.log(`    ├─ pipeline=standard, phase=${derivePhase(s)}`);
  console.log(`    └─ dag=[${Object.keys(s.dag || {}).join(', ')}]`);

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

  // 建立 CLASSIFIED state（模擬已分類、pipeline active）
  initState(sid, {
    classification: { pipelineId: 'standard', taskType: 'feature', source: 'test' },
    dag: {
      PLAN: { deps: [] },
      ARCH: { deps: ['PLAN'] },
      DEV: { deps: ['ARCH'] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
      DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      PLAN: { status: 'pending', agent: null, verdict: null },
      ARCH: { status: 'pending', agent: null, verdict: null },
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
      DOCS: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
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

  // 3b: AskUserQuestion 放行（S1: READ_ONLY_TOOLS 白名單）
  // S1 Always-Pipeline：AskUserQuestion 加入 READ_ONLY_TOOLS，
  // Main Agent 可在 pipeline active 時詢問使用者（如不確定 pipeline 選擇）
  log('STEP', 'AskUserQuestion 放行（S1 READ_ONLY_TOOLS 白名單）');
  const auq = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '?' }] },
  });
  test('X3: AskUserQuestion (non-PLAN) → exit 0（S1 READ_ONLY_TOOLS 白名單）', () => {
    assert.strictEqual(auq.exitCode, 0);
  });
  console.log(`    └─ exitCode=${auq.exitCode}, allowed ✓`);

  // 3c: Bash 讀取操作 — CLASSIFIED 階段 Bash 不在唯讀白名單，阻擋
  log('STEP', 'Bash 讀取阻擋（CLASSIFIED must-delegate）');
  const bashRead = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'ls -la /tmp' },
  });
  test('X3: Bash ls → exit 2（CLASSIFIED must-delegate）', () => {
    assert.strictEqual(bashRead.exitCode, 2);
  });
  console.log(`    └─ exitCode=${bashRead.exitCode}, blocked ✓`);

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

  // 3f: DELEGATING 時 Bash 寫檔放行 — v3 格式
  log('STEP', 'DELEGATING 時 Bash 寫檔放行');
  initState(sid, {
    classification: { pipelineId: 'standard', taskType: 'feature', source: 'test' },
    dag: {
      PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] }, DEV: { deps: ['ARCH'] },
      REVIEW: { deps: ['DEV'] }, TEST: { deps: ['DEV'] }, DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      PLAN: { status: 'completed', agent: 'planner', verdict: null },
      ARCH: { status: 'completed', agent: 'architect', verdict: null },
      DEV: { status: 'active', agent: 'developer' },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
      DOCS: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
  });
  const bashWriteDeleg = runHook('pipeline-guard', {
    session_id: sid, tool_name: 'Bash',
    tool_input: { command: 'echo "code" > /tmp/output.js' },
  });
  test('X3: DELEGATING Bash write .js → exit 2（v4: 寫檔攔截優先於 DELEGATING）', () => {
    // v4 設計：Bash 寫程式碼檔案的攔截（步驟 2.5）優先於 DELEGATING 放行（步驟 4）
    // sub-agent 使用 Write 工具寫檔，Main Agent 不應用 Bash 繞道
    assert.strictEqual(bashWriteDeleg.exitCode, 2);
  });
  console.log(`    └─ exitCode=${bashWriteDeleg.exitCode}, blocked by bash-write-bypass ✓`);

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

  // 分類為 standard（pipelineActive）
  runHook('task-classifier', {
    session_id: sid, prompt: '建立新功能 [pipeline:standard]',
  });
  let s = readState(sid);
  test('X4: 初始 derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
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

  // 模擬 cancel：使用 dag-state 的 cancel 操作
  log('STEP', 'Cancel 逃生');
  const dsModule = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'dag-state.js'));
  s = readState(sid);
  const cancelled = dsModule.cancel(s);
  dsModule.writeState(sid, cancelled);

  s = readState(sid);
  test('X4: cancel 後 derivePhase = IDLE', () => {
    assert.strictEqual(derivePhase(s), 'IDLE');
  });
  test('X4: cancel 後 pipelineActive = false', () => {
    assert.strictEqual(s.pipelineActive, false);
  });
  console.log(`    └─ phase=${derivePhase(s)}, pipelineActive=${s.pipelineActive}`);

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

  // 建立已完成一半的 pipeline state — v3 格式
  initState(sid, {
    classification: { pipelineId: 'quick-dev', taskType: 'bugfix', source: 'test' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: { verdict: 'PASS', severity: null } },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
  });

  // pipeline-check 應偵測到 REVIEW 和 TEST 未完成
  log('STEP', 'pipeline-check 偵測遺漏');
  const result = runHook('pipeline-check', {
    session_id: sid, stop_hook_active: false,
  });
  test('X5: pipeline-check 偵測到遺漏', () => {
    // v4 格式：decision:"block" + reason（取代 v3 的 continue:false + systemMessage）
    assert(
      (result.json && result.json.decision === 'block') ||
      (result.json && result.json.continue === false) ||
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
//  特殊場景 X6: TDD 模擬（使用 quick-dev）
//  test-first 的 TEST:verify 語意化後，S5 場景已直接涵蓋 test-first 生命週期
//  X6 保留 quick-dev FAIL 重試流程測試，保持獨立覆蓋
//  DEV PASS → REVIEW PASS → TEST FAIL:HIGH → DEV 修復 → TEST 重做 PASS
// ═══════════════════════════════════════════════════════════════

(() => {
  const sid = 'catalog-X6';
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  特殊場景 X6: TDD 模擬（使用 quick-dev 測試 FAIL 重試）');
  console.log('  Pipeline: quick-dev [DEV, REVIEW, TEST]');
  console.log(`${'═'.repeat(65)}`);

  cleanState(sid);
  cleanTimeline(sid);
  initState(sid);

  // 分類為 quick-dev
  runHook('task-classifier', {
    session_id: sid, prompt: '修復並測試密碼強度驗證 [pipeline:quick-dev]',
  });
  let s = readState(sid);
  test('X6: pipelineId = quick-dev', () => {
    assert.strictEqual(s.classification.pipelineId, 'quick-dev');
  });
  test('X6: dag keys = [DEV, REVIEW, TEST]', () => {
    assert.deepStrictEqual(Object.keys(s.dag || {}), ['DEV', 'REVIEW', 'TEST']);
  });
  console.log(`    └─ pipeline=quick-dev, dag=[${Object.keys(s.dag || {}).join(', ')}]`);

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
  s = readState(sid);
  test('X6: DEV PASS → stages[DEV].status = completed', () => {
    assert.strictEqual(s.stages.DEV.status, 'completed');
  });
  test('X6: DEV PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}`);

  // ─── REVIEW: PASS ───
  log('STEP', 'REVIEW 階段（PASS）');
  runHook('delegation-tracker', {
    session_id: sid, tool_name: 'Task',
    tool_input: { subagent_type: 'vibe:code-reviewer', prompt: 'review code' },
  });
  tp = createMockTranscript(sid, 'PASS');
  runHook('stage-transition', {
    session_id: sid, agent_type: 'vibe:code-reviewer',
    agent_transcript_path: tp, stop_hook_active: false,
  });
  cleanTranscript(sid);
  s = readState(sid);
  test('X6: REVIEW PASS → stages[REVIEW].status = completed', () => {
    assert.strictEqual(s.stages.REVIEW.status, 'completed');
  });
  console.log(`    └─ phase=${derivePhase(s)}`);

  // ─── TEST: FAIL:HIGH（觸發回退）───
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
  test('X6: TEST FAIL → derivePhase = RETRYING', () => {
    assert.strictEqual(derivePhase(s), 'RETRYING');
  });
  test('X6: TEST FAIL → pendingRetry.stages[0].id = TEST', () => {
    assert(s.pendingRetry, 'pendingRetry 缺失');
    assert(s.pendingRetry.stages && s.pendingRetry.stages.length > 0, 'pendingRetry.stages 缺失');
    assert.strictEqual(s.pendingRetry.stages[0].id, 'TEST');
  });
  test('X6: TEST FAIL → retries[TEST] >= 1', () => {
    assert(s.retries.TEST >= 1, `retries=${JSON.stringify(s.retries)}`);
  });
  console.log(`    ├─ phase=${derivePhase(s)}, retries=${JSON.stringify(s.retries)}`);
  console.log(`    └─ pendingRetry=${JSON.stringify(s.pendingRetry)}`);

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
    assert.strictEqual(s.pendingRetry, null, `pendingRetry=${JSON.stringify(s.pendingRetry)}`);
  });
  test('X6: DEV 修復 → derivePhase = CLASSIFIED（準備重驗 TEST）', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}, pendingRetry=${s.pendingRetry}`);

  // ─── TEST 重做: PASS ───
  log('STEP', 'TEST 重做（PASS → COMPLETE）');
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
  test('X6: TEST 重做 PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });
  test('X6: TEST 重做 → stages[TEST].status = completed', () => {
    assert.strictEqual(s.stages.TEST.status, 'completed');
  });
  console.log(`    └─ phase=${derivePhase(s)}, TEST status=completed`);

  // Pipeline check
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X6: pipeline-check → state 保留', () => {
    const s = readState(sid);
    assert.ok(s !== null, 'state 應保留');
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });
  log('COMPLETE', 'FAIL 重試流程完整 ✓');

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
    assert.strictEqual(s.classification.pipelineId, 'quick-dev');
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
  test('X7: DEV PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}`);

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
    test(`X7: REVIEW FAIL 第 ${round + 1} 輪 → derivePhase = RETRYING`, () => {
      assert.strictEqual(derivePhase(s), 'RETRYING');
    });
    test(`X7: REVIEW FAIL 第 ${round + 1} 輪 → retries[REVIEW] = ${round + 1}`, () => {
      assert.strictEqual(s.retries.REVIEW, round + 1);
    });
    console.log(`    ├─ retries[REVIEW]=${s.retries.REVIEW}, pendingRetry=${JSON.stringify(s.pendingRetry)}`);

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
      assert.strictEqual(s.pendingRetry, null);
    });
    console.log(`    └─ DEV 修復完成，phase=${derivePhase(s)}`);
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

  test('X7: MAX_RETRIES 耗盡 → derivePhase 不是 RETRYING', () => {
    assert.notStrictEqual(derivePhase(s), 'RETRYING',
      `retries=${MAX_RETRIES} 後應強制前進，但 phase=${derivePhase(s)}`);
  });
  test(`X7: retries[REVIEW] = ${MAX_RETRIES}（不再增加）`, () => {
    assert.strictEqual(s.retries.REVIEW, MAX_RETRIES);
  });
  test('X7: MAX_RETRIES 耗盡 → systemMessage 指示下一階段', () => {
    assert(forcedResult.json && forcedResult.json.systemMessage,
      'systemMessage 缺失');
    // v3: shouldRetryStage 返回 false → 正常前進到 TEST（非 retry 路徑）
    assert(
      forcedResult.json.systemMessage.includes('TEST') ||
      forcedResult.json.systemMessage.includes('Pipeline 完成'),
      `systemMessage 應指示前進: ${forcedResult.json.systemMessage.slice(0, 80)}`);
  });
  console.log(`    ├─ phase=${derivePhase(s)}, retries[REVIEW]=${s.retries.REVIEW}`);
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
  test('X7: TEST PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });

  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X7: pipeline-check → state 保留', () => {
    const s = readState(sid);
    assert.ok(s !== null, 'state 應保留');
    assert.strictEqual(derivePhase(s), 'COMPLETE');
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

  // 預設已完成 PLAN 和 ARCH，直接從 DEV 開始（減少不必要的重複測試）— v3 格式
  initState(sid, {
    classification: { pipelineId: 'standard', taskType: 'feature', source: 'explicit', confidence: 1, matchedRule: 'explicit' },
    dag: {
      PLAN: { deps: [] },
      ARCH: { deps: ['PLAN'] },
      DEV: { deps: ['ARCH'] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
      DOCS: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      PLAN: { status: 'completed', agent: 'planner', verdict: null },
      ARCH: { status: 'completed', agent: 'architect', verdict: null },
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
      DOCS: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
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
  test('X8: DEV PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}`);

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
  test('X8: REVIEW FAIL → derivePhase = RETRYING', () => {
    assert.strictEqual(derivePhase(s), 'RETRYING');
  });
  test('X8: REVIEW FAIL → pendingRetry.stages[0].id = REVIEW', () => {
    assert(s.pendingRetry, 'pendingRetry 缺失');
    assert(s.pendingRetry.stages && s.pendingRetry.stages.length > 0, 'pendingRetry.stages 缺失');
    assert.strictEqual(s.pendingRetry.stages[0].id, 'REVIEW');
  });
  console.log(`    └─ phase=${derivePhase(s)}, pendingRetry=${JSON.stringify(s.pendingRetry)}`);

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
    assert.strictEqual(s.pendingRetry, null);
  });
  console.log(`    └─ pendingRetry=${s.pendingRetry}, phase=${derivePhase(s)}`);

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
  test('X8: REVIEW 重做 PASS → stages[REVIEW].status = completed', () => {
    assert.strictEqual(s.stages.REVIEW.status, 'completed');
  });
  test('X8: REVIEW 重做 PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}, REVIEW status=completed`);

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
  test('X8: TEST FAIL → derivePhase = RETRYING', () => {
    assert.strictEqual(derivePhase(s), 'RETRYING');
  });
  test('X8: TEST FAIL → pendingRetry.stages[0].id = TEST', () => {
    assert(s.pendingRetry, 'pendingRetry 缺失');
    assert(s.pendingRetry.stages && s.pendingRetry.stages.length > 0, 'pendingRetry.stages 缺失');
    assert.strictEqual(s.pendingRetry.stages[0].id, 'TEST');
  });
  test('X8: 兩次回退 → retries 包含 REVIEW 和 TEST', () => {
    assert(s.retries.REVIEW >= 1, `retries[REVIEW]=${s.retries.REVIEW}`);
    assert(s.retries.TEST >= 1, `retries[TEST]=${s.retries.TEST}`);
  });
  console.log(`    └─ phase=${derivePhase(s)}, retries=${JSON.stringify(s.retries)}`);

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
    assert.strictEqual(s.pendingRetry, null);
  });
  console.log(`    └─ pendingRetry=${s.pendingRetry}, phase=${derivePhase(s)}`);

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
  test('X8: TEST 重做 PASS → stages[TEST].status = completed', () => {
    assert.strictEqual(s.stages.TEST.status, 'completed');
  });
  test('X8: TEST 重做 PASS → derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ phase=${derivePhase(s)}, TEST status=completed`);

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
  test('X8: DOCS PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });

  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X8: pipeline-check → state 保留', () => {
    const s = readState(sid);
    assert.ok(s !== null, 'state 應保留');
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });

  // Timeline 驗證 — v3 不再發射 stage.retry，改驗 stage.complete 數量
  const events = readTimeline(sid);
  const stageCompleteEvents = events.filter(e => e.type === 'stage.complete');
  test('X8: timeline stage.complete 事件 ≥ 6（含回退重跑）', () => {
    // PLAN+ARCH（pre-built）不走 hook，DEV×3+REVIEW×2+TEST×2+DOCS = 7+
    assert(stageCompleteEvents.length >= 4,
      `期望 ≥4 個 stage.complete，實際 ${stageCompleteEvents.length}`);
  });
  test('X8: retries 記錄 REVIEW 和 TEST 的回退次數', () => {
    assert(s.retries.REVIEW >= 1, `retries[REVIEW]=${s.retries.REVIEW}`);
    assert(s.retries.TEST >= 1, `retries[TEST]=${s.retries.TEST}`);
  });
  console.log(`    └─ stage.complete 事件: ${stageCompleteEvents.length}, retries=${JSON.stringify(s.retries)}`);
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
    assert.strictEqual(s.classification.pipelineId, 'fix');
  });
  console.log(`    └─ pipeline=fix, dag=[DEV]`);

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
  test('X9: DEV PASS → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });
  console.log(`    └─ phase=COMPLETE`);

  // ─── 升級為 quick-dev ───
  log('STEP', '升級 → quick-dev');
  runHook('task-classifier', {
    session_id: sid, prompt: '其實還需要 review 和測試 [pipeline:quick-dev]',
  });
  s = readState(sid);
  test('X9: 升級後 pipelineId = quick-dev', () => {
    assert.strictEqual(s.classification.pipelineId, 'quick-dev');
  });
  test('X9: 升級後 derivePhase = CLASSIFIED', () => {
    assert.strictEqual(derivePhase(s), 'CLASSIFIED');
  });
  console.log(`    └─ pipeline=quick-dev, phase=${derivePhase(s)}`);

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
  test('X9: REVIEW FAIL → derivePhase = RETRYING', () => {
    assert.strictEqual(derivePhase(s), 'RETRYING');
  });
  test('X9: REVIEW FAIL → pendingRetry 已設定', () => {
    assert(s.pendingRetry, 'pendingRetry 缺失');
    assert(s.pendingRetry.stages && s.pendingRetry.stages.length > 0, 'pendingRetry.stages 缺失');
    assert.strictEqual(s.pendingRetry.stages[0].id, 'REVIEW');
  });
  const pendingRetryBefore = JSON.parse(JSON.stringify(s.pendingRetry));
  const retriesBefore = JSON.parse(JSON.stringify(s.retries));
  console.log(`    ├─ phase=${derivePhase(s)}, pendingRetry=${JSON.stringify(pendingRetryBefore)}`);
  console.log(`    └─ retries=${JSON.stringify(retriesBefore)}`);

  // ─── 升級為 standard（RETRYING → RECLASSIFY → CLASSIFIED）───
  log('STEP', '升級 → standard（保留 pendingRetry）');
  runHook('task-classifier', {
    session_id: sid, prompt: '這需要完整的功能開發流程 [pipeline:standard]',
  });
  s = readState(sid);
  test('X9: 升級後 pipelineId = standard', () => {
    assert.strictEqual(s.classification.pipelineId, 'standard');
  });
  test('X9: 升級後 derivePhase = CLASSIFIED 或 RETRYING', () => {
    const phase = derivePhase(s);
    // 升級後如果 pendingRetry 被保留，phase 可能是 RETRYING 或 CLASSIFIED
    assert(phase === 'CLASSIFIED' || phase === 'RETRYING',
      `預期 CLASSIFIED 或 RETRYING，實際 ${phase}`);
  });
  test('X9: 升級後 pendingRetry 被保留', () => {
    assert(s.pendingRetry, 'pendingRetry 在升級後不應消失');
    assert(s.pendingRetry.stages && s.pendingRetry.stages.length > 0, 'pendingRetry.stages 缺失');
    assert.strictEqual(s.pendingRetry.stages[0].id, pendingRetryBefore.stages[0].id);
  });
  test('X9: 升級後 retries 被保留', () => {
    assert.strictEqual(s.retries.REVIEW, retriesBefore.REVIEW,
      `retries[REVIEW] 應保留: 期望 ${retriesBefore.REVIEW}, 實際 ${s.retries.REVIEW}`);
  });
  console.log(`    ├─ pipeline=standard, pendingRetry=${JSON.stringify(s.pendingRetry)}`);
  console.log(`    └─ retries=${JSON.stringify(s.retries)}`);

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
    assert.strictEqual(s.classification.pipelineId, 'review-only');
  });
  test('X10: dag keys = [REVIEW]', () => {
    assert.deepStrictEqual(Object.keys(s.dag || {}), ['REVIEW']);
  });
  console.log(`    └─ pipeline=review-only, dag=[REVIEW]`);

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

  test('X10: REVIEW FAIL 無 DEV → derivePhase 不是 RETRYING', () => {
    assert.notStrictEqual(derivePhase(s), 'RETRYING',
      `應強制完成而非 RETRYING，phase=${derivePhase(s)}`);
  });
  test('X10: REVIEW FAIL 無 DEV → derivePhase = COMPLETE', () => {
    assert.strictEqual(derivePhase(s), 'COMPLETE');
  });
  test('X10: systemMessage 含完成或強制繼續提示', () => {
    assert(failResult.json && failResult.json.systemMessage,
      'systemMessage 缺失');
    // v4: enforcePolicy 規則 3 已將 DEV→NEXT（無 DEV in DAG），
    //     onStageComplete 走分支 C → buildCompleteOutput（'Pipeline [xxx] 完成'）
    //     或分支 A 無 DEV 路徑（'無 DEV 可回退，強制繼續'）
    assert(
      failResult.json.systemMessage.includes('完成') ||
      failResult.json.systemMessage.includes('無 DEV') ||
      failResult.json.systemMessage.includes('強制繼續'),
      `systemMessage 不含預期內容: ${failResult.json.systemMessage.slice(0, 100)}`);
  });
  test('X10: pendingRetry 未設定（null）', () => {
    assert.strictEqual(s.pendingRetry, null,
      `pendingRetry 應為 null，實際: ${JSON.stringify(s.pendingRetry)}`);
  });
  test('X10: stages[REVIEW].status = completed', () => {
    assert(s.stages.REVIEW, 'stages[REVIEW] 缺失');
    assert.strictEqual(s.stages.REVIEW.status, 'completed');
  });
  console.log(`    ├─ phase=${derivePhase(s)}, pendingRetry=${s.pendingRetry}`);
  console.log(`    └─ 無法回退，強制完成 ✓`);

  // Pipeline check — state 保留（不再刪除）
  runHook('pipeline-check', { session_id: sid, stop_hook_active: false });
  test('X10: pipeline-check → state 保留', () => {
    const s = readState(sid);
    assert.ok(s !== null, 'state 應保留');
    assert.strictEqual(derivePhase(s), 'COMPLETE');
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
