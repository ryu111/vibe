#!/usr/bin/env node
/**
 * v4-edge.test.js — 邊界與錯誤處理測試（J01-J04）
 *
 * 場景：
 *   J01: state 損壞（JSON 格式錯誤）→ readState 回 null
 *   J02: transcript 不存在 → parseRoute 回 source=none
 *   J03: v2→v4 遷移鏈（ensureV4 兩步遷移）
 *   J04: ABORT route → pipelineActive=false（強制終止解除 guard）
 *
 * 執行：node plugins/vibe/tests/v4-edge.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const { parseRoute } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/route-parser.js'));
const { ensureV4, detectVersion } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/state-migrator.js'));

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

// ─── 測試 ────────────────────────────────────────────────

console.log('\n⚡ J01-J04：邊界與錯誤處理');

// J01: state 損壞（JSON 格式錯誤）→ readState 回 null
test('J01: state 檔案 JSON 格式錯誤 → readState 回 null', () => {
  const sid = 'test-j01';
  cleanSessionState(sid);

  // 寫入損壞的 JSON
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(statePath, '{ "version": 4, "invalid json }{', 'utf8');

  const state = ds.readState(sid);
  assert.strictEqual(state, null, `損壞 JSON 應回 null，實際：${JSON.stringify(state)}`);

  cleanSessionState(sid);
});

// J01b: state 檔案不存在 → readState 回 null
test('J01b: state 檔案不存在 → readState 回 null', () => {
  const sid = 'test-j01b-nonexistent';
  cleanSessionState(sid);  // 確保不存在

  const state = ds.readState(sid);
  assert.strictEqual(state, null, `不存在的 state 應回 null`);
});

// J01c: state 檔案為空 → readState 回 null
test('J01c: state 檔案為空 → readState 回 null', () => {
  const sid = 'test-j01c';
  cleanSessionState(sid);

  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(statePath, '', 'utf8');

  const state = ds.readState(sid);
  assert.strictEqual(state, null, `空檔案應回 null`);

  cleanSessionState(sid);
});

// J02: transcript 不存在 → parseRoute 回 source=none
test('J02: transcript 不存在 → parseRoute source=none', () => {
  const { parsed, source } = parseRoute('/nonexistent/transcript.jsonl');
  assert.strictEqual(source, 'none', `不存在的 transcript 應回 source=none`);
  assert.strictEqual(parsed, null, `parsed 應為 null`);
});

// J02b: transcript 路徑為 null → source=none
test('J02b: transcript 路徑為 null → parseRoute source=none', () => {
  const { parsed, source } = parseRoute(null);
  assert.strictEqual(source, 'none', `null 路徑應回 source=none`);
  assert.strictEqual(parsed, null);
});

// J02c: transcript 路徑為空字串 → source=none
test('J02c: transcript 路徑為空字串 → parseRoute source=none', () => {
  const { parsed, source } = parseRoute('');
  assert.strictEqual(source, 'none', `空字串應回 source=none`);
  assert.strictEqual(parsed, null);
});

// J03: v2→v4 遷移鏈
test('J03: v2 state → ensureV4 兩步遷移（v2→v3→v4）', () => {
  // 建立 v2 格式 state
  const v2State = {
    // v2 特徵：有 phase + context.pipelineId
    phase: 'DELEGATING',
    context: {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      expectedStages: ['DEV', 'REVIEW', 'TEST'],
    },
    progress: {
      completedAgents: ['developer'],
      currentStage: 'REVIEW',
      skippedStages: [],
      retries: {},
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      classificationSource: 'v2-test',
      reclassifications: [],
    },
  };

  // 驗證版本偵測
  const version = detectVersion(v2State);
  assert.strictEqual(version, 2, `v2 state 應被偵測為版本 2，實際：${version}`);

  // 執行遷移
  const v4State = ensureV4(v2State);
  assert.ok(v4State, 'v4 state 應存在');
  assert.strictEqual(v4State.version, 4, `遷移後應為版本 4，實際：${v4State.version}`);

  // 驗證 v4 新增欄位存在
  assert.ok('pipelineActive' in v4State, 'v4 應有 pipelineActive 欄位');
  assert.ok('activeStages' in v4State, 'v4 應有 activeStages 欄位');
  assert.ok('retryHistory' in v4State, 'v4 應有 retryHistory 欄位');
  assert.ok('crashes' in v4State, 'v4 應有 crashes 欄位');

  // 驗證分類資訊保留
  assert.strictEqual(v4State.classification?.pipelineId, 'quick-dev',
    `pipelineId 應保留，實際：${v4State.classification?.pipelineId}`);
});

// J03b: v3→v4 遷移（只需一步）
test('J03b: v3 state → ensureV4 一步遷移（v3→v4）', () => {
  const v3State = {
    version: 3,
    sessionId: 'test-j03b',
    classification: {
      pipelineId: 'standard',
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
    },
  };

  const version = detectVersion(v3State);
  assert.strictEqual(version, 3, 'v3 state 應被偵測為版本 3');

  const v4State = ensureV4(v3State);
  assert.strictEqual(v4State.version, 4, '遷移後應為版本 4');
  assert.ok('pipelineActive' in v4State, 'v4 應有 pipelineActive');
  // v3 有 standard pipeline + 未取消 + 有 DAG + 未全完成 → pipelineActive=true
  assert.strictEqual(v4State.pipelineActive, true,
    `v3 進行中的 pipeline 應遷移為 pipelineActive=true，實際：${v4State.pipelineActive}`);
});

// J03c: v4 state 直接通過（不重複遷移）
test('J03c: v4 state 直接通過 ensureV4（無修改）', () => {
  const v4State = {
    version: 4,
    pipelineActive: true,
    activeStages: ['REVIEW'],
    retryHistory: {},
    crashes: {},
    classification: { pipelineId: 'standard' },
  };
  const result = ensureV4(v4State);
  assert.strictEqual(result, v4State, 'v4 state 應直接返回（無副本）');
  assert.strictEqual(result.version, 4);
});

// J04: ABORT route → pipelineActive=false
test('J04: ABORT route → 模擬 onStageComplete 後 pipelineActive=false', () => {
  // 直接驗證 ABORT 邏輯：讀取含 ABORT 路由的 transcript，
  // pipeline-controller 應設 pipelineActive=false
  const sid = 'test-j04';
  cleanSessionState(sid);

  // 建立含 ABORT route 的 transcript
  const TMP_DIR = os.tmpdir();
  const transcriptPath = path.join(TMP_DIR, `test-j04-transcript.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '<!-- PIPELINE_ROUTE: { "verdict": "FAIL", "route": "ABORT", "hint": "系統錯誤" } -->' }],
    },
  }) + '\n');

  // 建立 active state
  const activeState = {
    version: 4,
    sessionId: sid,
    classification: {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: null },
      REVIEW: { status: 'active', agent: 'code-reviewer', verdict: null },
    },
    pipelineActive: true,
    activeStages: ['REVIEW'],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
  };
  ds.writeState(sid, activeState);

  // 呼叫 onStageComplete（模擬 REVIEW agent 完成）
  const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));
  const result = ctrl.onStageComplete(sid, 'code-reviewer', transcriptPath);

  // 驗證：systemMessage 應含終止訊息
  assert.ok(result.systemMessage, 'systemMessage 應存在');
  assert.ok(
    result.systemMessage.includes('⛔') || result.systemMessage.includes('終止') || result.systemMessage.includes('ABORT'),
    `systemMessage 應含終止相關訊息，實際：${result.systemMessage}`
  );

  // 驗證：state 應 pipelineActive=false
  const updatedState = ds.readState(sid);
  assert.ok(updatedState, 'state 應存在');
  assert.strictEqual(updatedState.pipelineActive, false,
    `ABORT 後 pipelineActive 應為 false，實際：${updatedState.pipelineActive}`);

  // 清理
  try { fs.unlinkSync(transcriptPath); } catch (_) {}
  cleanSessionState(sid);
});

// J04b: ABORT 後 Guard 放行
test('J04b: ABORT 後 pipelineActive=false → Guard 放行', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
  const abortedState = {
    version: 4,
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'completed' },
    },
    pipelineActive: false,  // ABORT 後設為 false
    activeStages: [],
    classification: { pipelineId: 'quick-dev' },
  };

  const result = evaluate('Write', { file_path: '/src/foo.js' }, abortedState);
  assert.strictEqual(result.decision, 'allow', `ABORT 後 Guard 應放行，實際：${result.decision}`);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
