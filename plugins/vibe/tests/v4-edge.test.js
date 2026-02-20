#!/usr/bin/env node
/**
 * v4-edge.test.js — 邊界與錯誤處理測試（J01-J04）
 *
 * 場景：
 *   J01: state 損壞（JSON 格式錯誤）→ readState 回 null
 *   J02: transcript 不存在 → parseRoute 回 source=none
 *   J03: v2→v4 遷移鏈（ensureV4 兩步遷移）
 *   J04: 不合法 route（ABORT）→ validateRoute 自動修正為 DEV，走回退邏輯
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

// J03: v2 格式已不支援（v2→v3 遷移路徑已移除）
test('J03: v2 state → ensureV4 回傳 null（v2 不再支援）', () => {
  // 建立 v2 格式 state（phase + context.pipelineId 特徵）
  const v2State = {
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

  // v2 格式偵測返回 0（不支援）
  const version = detectVersion(v2State);
  assert.strictEqual(version, 0, `v2 state 應被偵測為版本 0（不支援），實際：${version}`);

  // ensureV4 對 v2 回傳 null
  const v4State = ensureV4(v2State);
  assert.strictEqual(v4State, null, 'v2 state 應無法遷移，ensureV4 應回傳 null');
});

// J03b: v3 state 不再支援（v3→v4 遷移已移除）
test('J03b: v3 state → ensureV4 回傳 null（v3 不再支援）', () => {
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

  // v3 被 detectVersion 識別為版本 0（不支援），與 v2 同等處理
  const version = detectVersion(v3State);
  assert.strictEqual(version, 0, 'v3 state 應被偵測為版本 0（不支援），與 v2 相同');

  // ensureV4 對 v3 應回傳 null（v3→v4 遷移已移除）
  const result = ensureV4(v3State);
  assert.strictEqual(result, null, 'v3 state 不再支援遷移，ensureV4 應回傳 null');
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

// J04: 不合法 route（ABORT）→ validateRoute 自動修正為 DEV，走回退邏輯
test('J04: 不合法 route（ABORT）→ validateRoute 修正為 DEV，onStageComplete 走回退', () => {
  // ABORT 已從 VALID_ROUTES 移除，validateRoute 遇到 ABORT 會自動修正為 DEV
  // （verdict=FAIL 預設回退到 DEV），controller 走分支 A（回退），不終止
  const sid = 'test-j04';
  cleanSessionState(sid);

  // 建立含 ABORT route 的 transcript（模擬舊版 agent 輸出）
  const TMP_DIR = os.tmpdir();
  const transcriptPath = path.join(TMP_DIR, `test-j04-transcript.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '<!-- PIPELINE_ROUTE: { "verdict": "FAIL", "route": "ABORT", "severity": "HIGH", "hint": "系統錯誤" } -->' }],
    },
  }) + '\n');

  // 建立 active state（含 DEV stage 以便回退）
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

  // 驗證 validateRoute 修正行為
  const { validateRoute } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/route-parser.js'));
  const { route: corrected, warnings } = validateRoute({ verdict: 'FAIL', route: 'ABORT', severity: 'HIGH' });
  assert.ok(corrected, 'validateRoute 應回傳修正後的 route');
  assert.strictEqual(corrected.route, 'DEV',
    `ABORT 應被修正為 DEV（FAIL verdict 預設回退），實際：${corrected.route}`);
  assert.ok(warnings.some(w => w.includes('ABORT')),
    `warnings 應含 ABORT 相關訊息，實際：${JSON.stringify(warnings)}`);

  // 呼叫 onStageComplete（模擬 REVIEW agent 完成）
  const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));
  const result = ctrl.onStageComplete(sid, 'code-reviewer', transcriptPath);

  // 驗證：走回退邏輯，systemMessage 應含回退指示（而非終止）
  assert.ok(result.systemMessage, 'systemMessage 應存在');
  assert.ok(
    result.systemMessage.includes('FAIL') || result.systemMessage.includes('回退') || result.systemMessage.includes('DEV') || result.systemMessage.includes('🔄'),
    `systemMessage 應含回退相關訊息，實際：${result.systemMessage}`
  );

  // 驗證：pipeline 應仍 active（回退，不是終止）
  // 注意：REVIEW FAIL → DEV 修復，pipelineActive 仍為 true
  const updatedState = ds.readState(sid);
  assert.ok(updatedState, 'state 應存在');
  assert.strictEqual(updatedState.pipelineActive, true,
    `ABORT 修正為 DEV 後 pipeline 應仍 active（回退，非終止），實際：${updatedState.pipelineActive}`);

  // 清理
  try { fs.unlinkSync(transcriptPath); } catch (_) {}
  cleanSessionState(sid);
});

// J04b: pipeline 停止後 Guard 放行
test('J04b: pipeline 停止後 pipelineActive=false → Guard 放行', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
  const stoppedState = {
    version: 4,
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'completed' },
    },
    pipelineActive: false,  // pipeline 停止後設為 false
    activeStages: [],
    classification: { pipelineId: 'quick-dev' },
  };

  const result = evaluate('Write', { file_path: '/src/foo.js' }, stoppedState);
  assert.strictEqual(result.decision, 'allow', `pipeline 停止後 Guard 應放行，實際：${result.decision}`);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
