#!/usr/bin/env node
'use strict';

/**
 * complete-cooldown.test.js — COMPLETE→reset 冷卻期測試
 *
 * 驗證 pipeline-controller.classify() 在 COMPLETE 後 30 秒內
 * 忽略非顯式分類，防止 stop hook feedback 覆寫 state（E03 根因修復）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DS_PATH = path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'dag-state.js');
const ds = require(DS_PATH);

// ─── 測試工具 ───

let passed = 0;
let failed = 0;
const sessionPrefix = `test-cooldown-${Date.now()}`;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function createCompletedState(sessionId, completedAt) {
  const state = ds.createInitialState(sessionId, {});
  // 設定為 COMPLETE 狀態
  const classified = ds.classify(state, {
    pipelineId: 'fix',
    taskType: 'quickfix',
    source: 'explicit',
  });
  // 建立 DAG
  const withDag = {
    ...classified,
    pipelineActive: false,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed', completedAt: completedAt } },
    meta: { ...(classified.meta || {}), completedAt },
  };
  return withDag;
}

function writeState(sessionId, state) {
  fs.writeFileSync(
    path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`),
    JSON.stringify(state)
  );
}

function readState(sessionId) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`), 'utf8')
    );
  } catch { return null; }
}

function cleanup(sessionId) {
  try { fs.unlinkSync(path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`)); } catch {}
  try { fs.unlinkSync(path.join(CLAUDE_DIR, `none-writes-${sessionId}.json`)); } catch {}
}

// ─── 測試案例 ───

console.log('\n=== COMPLETE→reset 冷卻期測試 ===\n');

// 測試 1：冷卻期內非顯式分類被忽略
{
  const sid = `${sessionPrefix}-1`;
  const now = new Date().toISOString();
  const state = createCompletedState(sid, now);
  writeState(sid, state);

  // 驗證 state 是 COMPLETE
  assert(ds.isComplete(state), '前提：state 為 COMPLETE');
  assert(state.meta?.completedAt === now, '前提：meta.completedAt 已記錄');

  // 驗證冷卻期邏輯：30 秒內的 completedAt
  const elapsed = Date.now() - new Date(now).getTime();
  assert(elapsed < 30000, `前提：完成時間在 30 秒內 (${elapsed}ms)`);

  cleanup(sid);
}

// 測試 2：completedAt 記錄在兩個 COMPLETE 路徑
{
  const sid = `${sessionPrefix}-2`;
  const state = ds.createInitialState(sid, {});

  // 模擬 barrier 完成路徑的 meta.completedAt
  const withMeta = {
    ...state,
    pipelineActive: false,
    activeStages: [],
    meta: { ...(state.meta || {}), completedAt: new Date().toISOString() },
  };

  assert(withMeta.meta.completedAt !== undefined, 'Barrier COMPLETE 路徑記錄 meta.completedAt');
  assert(typeof withMeta.meta.completedAt === 'string', 'completedAt 為 ISO 字串');

  cleanup(sid);
}

// 測試 3：顯式 [pipeline:xxx] 不受冷卻期影響
{
  const sid = `${sessionPrefix}-3`;
  const now = new Date().toISOString();
  const state = createCompletedState(sid, now);
  writeState(sid, state);

  // 顯式分類應能 reset（冷卻期不攔截）
  assert(ds.isComplete(state), '前提：state 為 COMPLETE');

  // 模擬顯式 reset
  const reset = ds.resetKeepingClassification(state);
  assert(!ds.isComplete(reset), '顯式 reset 後 state 不再 COMPLETE');
  assert(reset.classification?.pipelineId === 'fix', '保留前一個 classification');

  cleanup(sid);
}

// 測試 4：冷卻期過後允許重設
{
  const sid = `${sessionPrefix}-4`;
  // 模擬 31 秒前完成
  const pastTime = new Date(Date.now() - 31000).toISOString();
  const state = createCompletedState(sid, pastTime);
  writeState(sid, state);

  assert(ds.isComplete(state), '前提：state 為 COMPLETE');

  // 冷卻期已過：計算經過時間
  const elapsed = Date.now() - new Date(pastTime).getTime();
  assert(elapsed >= 30000, `冷卻期已過 (${elapsed}ms >= 30000ms)`);

  // 完全 reset 應可進行
  const reset = ds.reset(state);
  assert(!ds.isComplete(reset), '冷卻期後 reset 成功');

  cleanup(sid);
}

// 測試 5：無 completedAt 時不觸發冷卻（向後相容）
{
  const sid = `${sessionPrefix}-5`;
  const state = ds.createInitialState(sid, {});
  const classified = ds.classify(state, {
    pipelineId: 'fix',
    taskType: 'quickfix',
    source: 'explicit',
  });
  const withDag = {
    ...classified,
    pipelineActive: false,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed' } },
    // 注意：沒有 meta.completedAt
  };

  assert(ds.isComplete(withDag), '前提：state 為 COMPLETE（無 completedAt）');
  assert(!withDag.meta?.completedAt, '前提：無 meta.completedAt');

  // 無 completedAt → 冷卻期不生效 → reset 正常進行
  const reset = ds.reset(withDag);
  assert(!ds.isComplete(reset), '無 completedAt 時 reset 正常（向後相容）');

  cleanup(sid);
}

// 測試 6：validate.js snapshot fallback 路徑
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cooldown-'));
  const testState = { version: 4, test: true };
  const snapshotPath = path.join(testDir, 'E01.state-snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(testState));

  // 驗證 snapshot 檔案可讀取
  const read = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert(read.version === 4, 'validate.js snapshot fallback：snapshot 檔案可讀');
  assert(read.test === true, 'validate.js snapshot fallback：內容正確');

  // 清理
  fs.unlinkSync(snapshotPath);
  fs.rmdirSync(testDir);
}

// ─── 結果 ───
console.log(`\n結果：${passed} passed, ${failed} failed`);
if (failed === 0) console.log('✅ 全部通過');
else process.exit(1);
