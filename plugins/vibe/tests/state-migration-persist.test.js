#!/usr/bin/env node
/**
 * state-migration-persist.test.js — loadState 遷移持久化測試
 *
 * 目標 6：驗證 pipeline-controller.js 的 loadState() 自動遷移持久化行為：
 * 1. 寫入 v3 state → loadState 讀取 → 磁碟上應為 v4 格式（含 pipelineActive）
 * 2. v4 state → loadState 讀取 → 不應重新寫入（效能：版本相同不觸發持久化）
 * 3. v2 state → loadState 讀取 → 磁碟上應為 v4 格式（雙跳遷移）
 * 4. 遷移保留所有原有進度（無損遷移）
 * 5. null state → loadState 回傳 null（無 state 情況）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 引入 dag-state 進行讀寫操作
const ds = require('../scripts/lib/flow/dag-state.js');
const { ensureV4 } = require('../scripts/lib/flow/state-migrator.js');

// loadState 是 pipeline-controller 的內部函式，不直接 export
// 改為直接複製其邏輯進行測試（符合「複製不可 require 的模組」慣例）
// 來源：plugins/vibe/scripts/lib/flow/pipeline-controller.js loadState()
// 注意：原始檔修改需同步此處
function loadState(sessionId) {
  const raw = ds.readState(sessionId);
  if (!raw) return null;
  const state = ensureV4(raw);
  // 遷移後持久化：確保磁碟上的 state 是 v4 格式
  if (state && raw.version !== 4) {
    ds.writeState(sessionId, state);
  }
  return state;
}

// ────────────────── 測試框架 ──────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    if (process.env.VERBOSE) console.log(err.stack);
  }
}

function makeSessionId(suffix) {
  return `test-smigrate-${Date.now()}-${suffix}`;
}

function statePath(sessionId) {
  return path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
}

function cleanup(sessionId) {
  try { fs.unlinkSync(statePath(sessionId)); } catch (_) {}
}

function readDisk(sessionId) {
  const p = statePath(sessionId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// ════════════════════════════════════════════════
console.log('\n📦 目標 6：loadState 遷移持久化測試');
console.log('═'.repeat(55));
// ════════════════════════════════════════════════

// ── 6.1 v3 state → loadState → 磁碟應為 v4 ──────────────

test('6.1：寫入 v3 state → loadState → 磁碟上為 v4 格式（含 pipelineActive）', () => {
  const sid = makeSessionId('v3-to-v4');

  // 寫入 v3 state
  const v3State = {
    version: 3,
    sessionId: sid,
    classification: {
      pipelineId: 'standard',
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
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
  ds.writeState(sid, v3State);

  // 確認磁碟上是 v3
  const beforeLoad = readDisk(sid);
  assert.strictEqual(beforeLoad?.version, 3, '寫入後磁碟上應為 v3');

  // loadState 觸發遷移
  const loaded = loadState(sid);

  // 回傳值應為 v4
  assert.strictEqual(loaded?.version, 4, 'loadState 回傳應為 v4');
  assert.ok(typeof loaded.pipelineActive === 'boolean', 'v4 應有 pipelineActive 布林欄位');

  // 磁碟上應已持久化為 v4
  const afterLoad = readDisk(sid);
  assert.strictEqual(afterLoad?.version, 4, '遷移後磁碟上應為 v4');
  assert.ok(typeof afterLoad.pipelineActive === 'boolean', '磁碟 v4 應有 pipelineActive');

  cleanup(sid);
});

test('6.1b：v3 state 有 DAG + 有分類 → 遷移後 pipelineActive=true', () => {
  const sid = makeSessionId('v3-active');

  const v3State = {
    version: 3,
    sessionId: sid,
    classification: { pipelineId: 'quick-dev', taskType: 'bugfix', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v3State);

  const loaded = loadState(sid);
  assert.strictEqual(loaded?.pipelineActive, true, '未完成的 quick-dev pipeline 應為 pipelineActive=true');

  const disk = readDisk(sid);
  assert.strictEqual(disk?.pipelineActive, true, '磁碟上 pipelineActive 應為 true');

  cleanup(sid);
});

test('6.1c：v3 state 全部 stage 完成 → 遷移後 pipelineActive=false', () => {
  const sid = makeSessionId('v3-complete');

  const v3State = {
    version: 3,
    sessionId: sid,
    classification: { pipelineId: 'fix', taskType: 'bugfix', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed', agent: null, verdict: { verdict: 'PASS' } } },
    retries: {},
    pendingRetry: null,
    meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v3State);

  const loaded = loadState(sid);
  // 全部完成 → pipelineActive=false
  assert.strictEqual(loaded?.pipelineActive, false, '全部完成的 pipeline 應為 pipelineActive=false');

  cleanup(sid);
});

// ── 6.2 v4 state → loadState → 不重新寫入 ────────────────

test('6.2：v4 state → loadState → 不應重新寫入（版本相同）', () => {
  const sid = makeSessionId('v4-no-rewrite');

  // 直接寫入 v4 state
  const v4State = {
    version: 4,
    sessionId: sid,
    classification: { pipelineId: 'standard', taskType: 'feature', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    pipelineActive: true,
    activeStages: [],
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v4State);

  // 記錄寫入時間
  const pathP = statePath(sid);
  const statBefore = fs.statSync(pathP);
  const mtimeBefore = statBefore.mtimeMs;

  // 等一小段確保時間差可偵測
  // （loadState 在 version=4 時不呼叫 writeState）
  const loaded = loadState(sid);

  // 確認回傳值是 v4
  assert.strictEqual(loaded?.version, 4, 'v4 loadState 應回傳 v4');
  assert.strictEqual(loaded?.pipelineActive, true, 'pipelineActive 應保持 true');

  // 確認磁碟上 mtime 未改變（未觸發重寫）
  const statAfter = fs.statSync(pathP);
  const mtimeAfter = statAfter.mtimeMs;
  assert.strictEqual(mtimeBefore, mtimeAfter, 'v4 state 不應觸發重寫（mtime 未改變）');

  cleanup(sid);
});

// ── 6.3 v2 state → loadState → 磁碟應為 v4 ──────────────

test('6.3：v2 state → loadState → 磁碟上為 v4 格式（雙跳遷移 v2→v3→v4）', () => {
  const sid = makeSessionId('v2-to-v4');

  // 寫入 v2 state（v2 特徵：有 phase + context.pipelineId）
  const v2State = {
    // v2 無 version 欄位（或為 undefined）
    sessionId: sid,
    phase: 'CLASSIFIED',
    context: {
      taskType: 'feature',
      pipelineId: 'standard',
      expectedStages: ['DEV', 'REVIEW', 'TEST', 'DOCS'],
      environment: {},
    },
    progress: {
      currentStage: null,
      completedAgents: [],
      skippedStages: [],
    },
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
    },
  };
  fs.writeFileSync(statePath(sid), JSON.stringify(v2State, null, 2));

  // loadState 觸發 v2→v3→v4 遷移
  const loaded = loadState(sid);

  // 回傳值應為 v4
  assert.ok(loaded !== null, 'loadState 不應回傳 null');
  assert.strictEqual(loaded?.version, 4, 'loadState 回傳應為 v4');
  assert.ok(typeof loaded.pipelineActive === 'boolean', 'v4 應有 pipelineActive');

  // 磁碟上應持久化為 v4
  const disk = readDisk(sid);
  assert.strictEqual(disk?.version, 4, '磁碟上應為 v4');

  cleanup(sid);
});

// ── 6.4 遷移保留已完成進度（無損遷移）──────────────

test('6.4：v3 state 有部分完成進度 → loadState → v4 保留所有 stage 狀態', () => {
  const sid = makeSessionId('v3-preserve');

  const v3State = {
    version: 3,
    sessionId: sid,
    classification: { pipelineId: 'full', taskType: 'feature', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: {
      PLAN: { deps: [] },
      ARCH: { deps: ['PLAN'] },
      DEV: { deps: ['ARCH'] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      PLAN: { status: 'completed', agent: null, verdict: { verdict: 'PASS' } },
      ARCH: { status: 'completed', agent: null, verdict: { verdict: 'PASS' } },
      DEV: { status: 'active', agent: 'vibe:developer' },
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
  ds.writeState(sid, v3State);

  const loaded = loadState(sid);

  // 確認 stages 狀態保留
  assert.strictEqual(loaded?.stages?.PLAN?.status, 'completed', 'PLAN 狀態應保留 completed');
  assert.strictEqual(loaded?.stages?.ARCH?.status, 'completed', 'ARCH 狀態應保留 completed');
  assert.strictEqual(loaded?.stages?.DEV?.status, 'active', 'DEV 狀態應保留 active');
  assert.strictEqual(loaded?.stages?.REVIEW?.status, 'pending', 'REVIEW 狀態應保留 pending');

  // 確認 classification 保留
  assert.strictEqual(loaded?.classification?.pipelineId, 'full', '分類應保留');

  // 確認 v4 新增欄位存在
  assert.ok(typeof loaded?.pipelineActive === 'boolean', '應有 pipelineActive');
  assert.ok(Array.isArray(loaded?.activeStages), '應有 activeStages 陣列');
  // DEV 是 active → activeStages 應包含 DEV
  assert.ok(loaded?.activeStages?.includes('DEV'), 'activeStages 應包含 active 的 DEV');

  cleanup(sid);
});

// ── 6.5 null state → loadState 回傳 null ──────────────

test('6.5：不存在的 session → loadState 回傳 null', () => {
  const sid = makeSessionId('nonexistent-99999');
  const loaded = loadState(sid);
  assert.strictEqual(loaded, null, '不存在的 session 應回傳 null');
  // 確認沒有留下任何 state 檔案
  assert.ok(!fs.existsSync(statePath(sid)), '不應建立 state 檔案');
});

// ── 6.6 v3 cancelled → pipelineActive=false ──────────────

test('6.6：v3 cancelled=true → loadState → pipelineActive=false', () => {
  const sid = makeSessionId('v3-cancelled');

  const v3State = {
    version: 3,
    sessionId: sid,
    classification: { pipelineId: 'standard', taskType: 'feature', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    retries: {},
    pendingRetry: null,
    meta: { initialized: true, cancelled: true, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v3State);

  const loaded = loadState(sid);
  // cancelled=true → pipelineActive=false（pipeline 已取消）
  assert.strictEqual(loaded?.pipelineActive, false, '已取消的 pipeline 應為 pipelineActive=false');

  cleanup(sid);
});

// ── 6.7 v4 state 持久化後磁碟格式完整性 ──────────────

test('6.7：v3 遷移到 v4 後，磁碟 state 包含 retryHistory 和 crashes 欄位', () => {
  const sid = makeSessionId('v4-fields');

  const v3State = {
    version: 3,
    sessionId: sid,
    classification: { pipelineId: 'fix', taskType: 'bugfix', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending', agent: null, verdict: null } },
    retries: { DEV: 1 },
    pendingRetry: null,
    meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v3State);

  loadState(sid);

  const disk = readDisk(sid);
  // v4 必備欄位
  assert.ok(typeof disk?.pipelineActive === 'boolean', '磁碟 v4 應有 pipelineActive');
  assert.ok(Array.isArray(disk?.activeStages), '磁碟 v4 應有 activeStages');
  assert.ok(typeof disk?.retryHistory === 'object', '磁碟 v4 應有 retryHistory');
  assert.ok(typeof disk?.crashes === 'object', '磁碟 v4 應有 crashes');
  assert.strictEqual(disk?.version, 4, '磁碟版本應為 4');

  cleanup(sid);
});

// ════════════════════════════════════════════════
// 結果輸出
// ════════════════════════════════════════════════

console.log('\n' + '='.repeat(55));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
