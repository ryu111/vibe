#!/usr/bin/env node
/**
 * state-migration-persist.test.js — loadState 版本驗證測試
 *
 * 目標：驗證 pipeline-controller.js 的 loadState() 版本驗證行為：
 * 1. 寫入 v3 state → loadState 讀取 → 回傳 null（v3 不再支援）
 * 2. v4 state → loadState 讀取 → 不應重新寫入（效能：版本相同不觸發持久化）
 * 3. v3 state（部分完成）→ loadState 回傳 null（v3 不再支援，不保留進度）
 * 4. null state → loadState 回傳 null（無 state 情況）
 * 5. v2 格式（舊 phase/context）→ loadState 回傳 null（不再支援）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 引入 dag-state 進行讀寫操作
const ds = require('../scripts/lib/flow/dag-state.js');
const { ensureCurrentSchema } = require('../scripts/lib/flow/state-migrator.js');

// loadState 是 pipeline-controller 的內部函式，不直接 export
// 改為直接複製其邏輯進行測試（符合「複製不可 require 的模組」慣例）
// 來源：plugins/vibe/scripts/lib/flow/pipeline-controller.js loadState()
// 注意：原始檔修改需同步此處
function loadState(sessionId) {
  const raw = ds.readState(sessionId);
  if (!raw) return null;
  const state = ensureCurrentSchema(raw);
  // 遷移後持久化：確保磁碟上的 state 是當前 schema 格式
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
console.log('\n📦 loadState 版本驗證測試');
console.log('═'.repeat(55));
// ════════════════════════════════════════════════

// ── 1. v3 state → loadState → 回傳 null（v3 不再支援）──────────────

test('1：寫入 v3 state → loadState → 回傳 null（v3 不再支援）', () => {
  const sid = makeSessionId('v3-unsupported');

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

  // loadState 應回傳 null（v3 不再支援）
  const loaded = loadState(sid);
  assert.strictEqual(loaded, null, 'v3 state 不再支援，loadState 應回傳 null');

  // 磁碟上應保持 v3（未被覆寫，因為 state=null 不觸發持久化）
  const afterLoad = readDisk(sid);
  assert.strictEqual(afterLoad?.version, 3, '磁碟上應保持原本的 v3（未被覆寫）');

  cleanup(sid);
});

test('1b：v3 state 有 DAG + 有分類 → loadState 回傳 null（v3 不再支援）', () => {
  const sid = makeSessionId('v3-dag-null');

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
  assert.strictEqual(loaded, null, 'v3 state 不再支援，應回傳 null');

  cleanup(sid);
});

test('1c：v3 state 全部 stage 完成 → loadState 回傳 null（v3 不再支援）', () => {
  const sid = makeSessionId('v3-complete-null');

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
  assert.strictEqual(loaded, null, 'v3 state 不再支援，全部完成的 pipeline 應回傳 null');

  cleanup(sid);
});

// ── 2. v4 state → loadState → 不重新寫入 ────────────────

test('2：v4 state → loadState → 不應重新寫入（版本相同）', () => {
  const sid = makeSessionId('v4-no-rewrite');

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

  const pathP = statePath(sid);
  const statBefore = fs.statSync(pathP);
  const mtimeBefore = statBefore.mtimeMs;

  const loaded = loadState(sid);

  assert.strictEqual(loaded?.version, 4, 'v4 loadState 應回傳 v4');
  assert.strictEqual(loaded?.pipelineActive, true, 'pipelineActive 應保持 true');

  const statAfter = fs.statSync(pathP);
  const mtimeAfter = statAfter.mtimeMs;
  assert.strictEqual(mtimeBefore, mtimeAfter, 'v4 state 不應觸發重寫（mtime 未改變）');

  cleanup(sid);
});

// ── 3. v3 state（部分完成）→ loadState 回傳 null（v3 不再支援）──────────────

test('3：v3 state 有部分完成進度 → loadState 回傳 null（v3 不再支援）', () => {
  const sid = makeSessionId('v3-partial-null');

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
  assert.strictEqual(loaded, null, 'v3 state 不再支援，部分完成的 pipeline 應回傳 null');

  cleanup(sid);
});

// ── 4. null state → loadState 回傳 null ──────────────

test('4：不存在的 session → loadState 回傳 null', () => {
  const sid = makeSessionId('nonexistent-99999');
  const loaded = loadState(sid);
  assert.strictEqual(loaded, null, '不存在的 session 應回傳 null');
  assert.ok(!fs.existsSync(statePath(sid)), '不應建立 state 檔案');
});

// ── 5. v2 格式 → loadState 回傳 null ──────────────

test('5：v2 格式（舊 phase/context）→ loadState 回傳 null（不再支援）', () => {
  const sid = makeSessionId('v2-unsupported');

  const v2State = {
    sessionId: sid,
    phase: 'CLASSIFIED',
    context: {
      taskType: 'feature',
      pipelineId: 'standard',
    },
    progress: {
      currentStage: null,
      completedAgents: [],
      skippedStages: [],
    },
    meta: {
      initialized: true,
      cancelled: false,
    },
  };
  fs.writeFileSync(statePath(sid), JSON.stringify(v2State, null, 2));

  const loaded = loadState(sid);
  assert.strictEqual(loaded, null, 'v2 格式不再支援，應回傳 null');

  cleanup(sid);
});

// ── 6. v3 cancelled → loadState 回傳 null（v3 不再支援）──────────────

test('6：v3 cancelled=true → loadState 回傳 null（v3 不再支援）', () => {
  const sid = makeSessionId('v3-cancelled-null');

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
  assert.strictEqual(loaded, null, 'v3 state 不再支援，已取消的 pipeline 應回傳 null');

  cleanup(sid);
});

// ── 7. v4 state 直接通過，磁碟格式完整性 ──────────────

test('7：v4 state 直接通過 loadState，磁碟 state 包含 pipelineActive、retryHistory 和 crashes 欄位', () => {
  const sid = makeSessionId('v4-fields');

  const v4State = {
    version: 4,
    sessionId: sid,
    classification: { pipelineId: 'fix', taskType: 'bugfix', source: 'test' },
    environment: {},
    openspecEnabled: false,
    needsDesign: false,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending', agent: null, verdict: null } },
    pipelineActive: true,
    activeStages: [],
    retries: { DEV: 1 },
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
  };
  ds.writeState(sid, v4State);

  const loaded = loadState(sid);
  assert.strictEqual(loaded?.version, 4, 'v4 state 應直接通過，版本為 4');

  const disk = readDisk(sid);
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
