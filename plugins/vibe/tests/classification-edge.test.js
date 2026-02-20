#!/usr/bin/env node
/**
 * classification-edge.test.js — Pipeline 分類邊界測試
 *
 * 場景：
 *   A07: 已取消 state 下顯式 [pipeline:xxx] 重啟
 *   A08: 已取消 state 下非顯式分類被抑制
 *
 * 執行：node plugins/vibe/tests/classification-edge.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

let passed = 0;
let failed = 0;

cleanTestStateFiles();

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        passed++;
        console.log(`  ✅ ${name}`);
      }).catch(err => {
        failed++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      });
    }
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

/**
 * 建立「已取消」v4 state（pipelineActive=false + dag + classification）
 */
function makeCancelledState(sessionId, pipelineId = 'standard') {
  const dag = { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['REVIEW'] } };
  const state = {
    version: 4,
    sessionId,
    classification: {
      pipelineId,
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag,
    blueprint: null,
    pipelineActive: false,  // 已取消
    activeStages: [],
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: {
      initialized: true,
      lastTransition: new Date(Date.now() - 60000).toISOString(),
      reclassifications: [],
      pipelineRules: [],
    },
  };
  ds.writeState(sessionId, state);
  return state;
}

// ─── 測試區塊 ──────────────────────────────────────────────

console.log('\n📋 A07/A08：已取消 state 下的分類行為');

const promises = [];

// A07: 已取消 state + 顯式 [pipeline:standard] → 重新啟動
promises.push(test('A07: 已取消 state 顯式重啟（pipelineActive=false + DAG + 顯式分類）', async () => {
  const sid = 'test-v4-a07';
  cleanSessionState(sid);

  // 前置：建立已取消 state
  makeCancelledState(sid, 'quick-dev');

  // 操作：顯式分類（source='explicit'）
  const result = await ctrl.classify(sid, '[pipeline:standard] 新增模組');

  // 驗證：輸出不應為 null（顯式分類應重設取消狀態）
  assert.ok(result.output !== null, '顯式分類不應被抑制（應重啟 pipeline）');

  // 驗證：state 應被重設並重新分類
  const newState = ds.readState(sid);
  assert.ok(newState, 'state 應存在');
  // 驗證：分類結果含 standard
  assert.strictEqual(
    newState.classification?.pipelineId,
    'standard',
    `pipelineId 應為 standard，實際：${newState.classification?.pipelineId}`
  );

  cleanSessionState(sid);
}));

// A08: 已取消 state + 非顯式分類 → 抑制
promises.push(test('A08: 已取消 state 非顯式分類被抑制', async () => {
  const sid = 'test-v4-a08';
  cleanSessionState(sid);

  // 前置：建立已取消 state（已有 standard pipeline）
  makeCancelledState(sid, 'standard');

  // 操作：非顯式分類（prompt 不含 [pipeline:xxx]）
  // 模擬 classifier 的 prompt-hook 分類（source='prompt-hook'）
  // classifyWithConfidence 對非顯式 prompt 會回傳 source='prompt-hook'
  // 這時 isCancelledState=true + source!='explicit' → output: null
  const result = await ctrl.classify(sid, '修復一個小 bug');

  // 驗證：output 應為 null（非顯式分類被抑制）
  assert.strictEqual(
    result.output,
    null,
    `已取消 state 下非顯式分類應被抑制，實際 output: ${JSON.stringify(result.output)}`
  );

  cleanSessionState(sid);
}));

// A09: active pipeline 下非顯式分類被抑制（防止 stop hook feedback 幽靈 pipeline）
promises.push(test('A09: active pipeline 非顯式分類被抑制（stop hook feedback 防禦）', async () => {
  const sid = 'test-v4-a09';
  cleanSessionState(sid);

  // 前置：建立 ACTIVE state（pipelineActive=true + DAG + 進行中的 stages）
  const dag = { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['DEV'] } };
  const state = {
    version: 4,
    sessionId: sid,
    classification: {
      pipelineId: 'quick-dev',
      taskType: 'bugfix',
      source: 'heuristic',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag,
    blueprint: null,
    pipelineActive: true,  // ACTIVE
    activeStages: ['DEV'],
    stages: {
      DEV: { status: 'active', agent: 'developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
    },
  };
  ds.writeState(sid, state);

  // 操作：非顯式分類（模擬 stop hook feedback 被 classifier 匹配為 fix）
  const result = await ctrl.classify(sid, '修復一個小 bug');

  // 驗證：output 應為 null（active pipeline 不接受非顯式重分類）
  assert.strictEqual(
    result.output,
    null,
    `active pipeline 下非顯式分類應被抑制，實際 output: ${JSON.stringify(result.output)}`
  );

  // 驗證：pipeline 分類未被覆寫
  const newState = ds.readState(sid);
  assert.strictEqual(newState.classification.pipelineId, 'quick-dev', 'pipelineId 不應被改變');
  assert.strictEqual(newState.pipelineActive, true, 'pipelineActive 應維持 true');

  cleanSessionState(sid);
}));

// A10: active pipeline 下顯式 [pipeline:xxx] 仍可覆寫
promises.push(test('A10: active pipeline 顯式分類可覆寫', async () => {
  const sid = 'test-v4-a10';
  cleanSessionState(sid);

  // 前置：同 A09，建立 ACTIVE state
  const dag = { DEV: { deps: [] } };
  const state = {
    version: 4,
    sessionId: sid,
    classification: {
      pipelineId: 'fix',
      taskType: 'quickfix',
      source: 'heuristic',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag,
    blueprint: null,
    pipelineActive: true,
    activeStages: ['DEV'],
    stages: {
      DEV: { status: 'active', agent: 'developer', verdict: null },
    },
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
    },
  };
  ds.writeState(sid, state);

  // 操作：顯式分類
  const result = await ctrl.classify(sid, '[pipeline:standard] 重新規劃');

  // 驗證：顯式分類不應被抑制
  assert.ok(result.output !== null, '顯式分類不應被抑制');

  cleanSessionState(sid);
}));

// A04 衍生：COMPLETE state 自動 reset
promises.push(test('A04（衍生）: COMPLETE state 分類前自動重設', async () => {
  const sid = 'test-v4-a04-derived';
  cleanSessionState(sid);

  // 建立 COMPLETE state（所有 stage 已完成 + pipelineActive=false）
  const dag = { DEV: { deps: [] } };
  const state = {
    version: 4,
    sessionId: sid,
    classification: {
      pipelineId: 'fix',
      taskType: 'quickfix',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag,
    blueprint: null,
    pipelineActive: false,
    activeStages: [],
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: null, completedAt: new Date().toISOString() },
    },
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
  };
  ds.writeState(sid, state);

  // 確認是 COMPLETE
  const phase = ds.derivePhase(state);
  assert.strictEqual(phase, 'COMPLETE', '初始應為 COMPLETE phase');

  // 操作：分類（COMPLETE state 應自動 reset）
  const result = await ctrl.classify(sid, '[pipeline:quick-dev] 實作新功能');

  // 驗證：分類後 state 不再是 COMPLETE
  const newState = ds.readState(sid);
  const newPhase = ds.derivePhase(newState);
  assert.notStrictEqual(newPhase, 'COMPLETE', '分類後不應仍為 COMPLETE');

  cleanSessionState(sid);
}));

Promise.all(promises).then(() => {
  console.log(`\n結果：${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
