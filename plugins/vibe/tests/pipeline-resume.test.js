#!/usr/bin/env node
/**
 * pipeline-resume.test.js — Pipeline 跨 Session 接續測試
 *
 * 測試重點：
 * 1. findIncompletePipelines：空目錄、已完成、未完成、過期、排除自己
 * 2. resumePipeline：正常複製、state 不存在、timeline 複製
 *
 * 執行：node plugins/vibe/tests/pipeline-resume.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PLUGIN_ROOT = path.join(__dirname, '..');
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

const { findIncompletePipelines, resumePipeline, formatRelativeTime } =
  require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'pipeline-resume.js'));

let passed = 0;
let failed = 0;

// 使用暫存目錄模擬 ~/.claude
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-resume-test-'));

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

function makeV3State(sessionId, { pipelineId = 'standard', phase = 'CLASSIFIED', completedStages = [] } = {}) {
  // 建立 v3 dag + stages
  const stageList = ['DEV', 'REVIEW', 'TEST'];
  const dag = {};
  const stages = {};
  stageList.forEach((s, i) => {
    dag[s] = { deps: i === 0 ? [] : [stageList[i - 1]] };
    stages[s] = { status: 'pending', agent: null, verdict: null };
  });

  // 根據 completedStages 標記
  for (const cs of completedStages) {
    if (stages[cs]) stages[cs].status = 'completed';
  }

  // 設定 DELEGATING 時需要有 active stage
  if (phase === 'DELEGATING') {
    // 找第一個 pending 改為 active
    const firstPending = stageList.find(s => stages[s].status === 'pending');
    if (firstPending) stages[firstPending].status = 'active';
  }

  // 設定 COMPLETE
  if (phase === 'COMPLETE') {
    stageList.forEach(s => { stages[s].status = 'completed'; });
  }

  return {
    version: 3,
    sessionId,
    classification: { pipelineId, taskType: 'feature' },
    dag,
    stages,
    enforced: true,
    pendingRetry: null,
    retries: {},
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
    },
  };
}

function writeState(sessionId, state) {
  const filePath = path.join(tmpDir, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

function cleanup() {
  // 刪除測試建立的所有檔案
  for (const f of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, f));
  }
}

// ─── findIncompletePipelines 測試 ─────────────────────────────

console.log('\n=== findIncompletePipelines ===');

test('空目錄 → 回傳空陣列', () => {
  cleanup();
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.deepStrictEqual(result, []);
});

test('只有自己的 state → 排除自己，回傳空陣列', () => {
  cleanup();
  const state = makeV3State('my-session', { phase: 'CLASSIFIED' });
  writeState('my-session', state);
  const result = findIncompletePipelines('my-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 0);
});

test('COMPLETE state → 排除（不需接續）', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'COMPLETE' });
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 0);
});

test('IDLE state（無 dag）→ 排除', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED' });
  delete state.dag; // 無 dag = IDLE
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 0);
});

test('CLASSIFIED state → 回傳', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED', pipelineId: 'standard' });
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].sessionId, 'old-session');
  assert.strictEqual(result[0].pipelineId, 'standard');
  assert.strictEqual(result[0].phase, 'CLASSIFIED');
  assert.strictEqual(result[0].completedCount, 0);
  assert.strictEqual(result[0].totalCount, 3);
});

test('DELEGATING state → 回傳', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'DELEGATING', pipelineId: 'quick-dev' });
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].phase, 'DELEGATING');
});

test('部分完成的 pipeline → completedCount 正確', () => {
  cleanup();
  const state = makeV3State('old-session', {
    phase: 'CLASSIFIED',
    completedStages: ['DEV'],
  });
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].completedCount, 1);
  assert.strictEqual(result[0].totalCount, 3);
});

test('maxAgeMs=0 → 所有檔案都過期，回傳空陣列', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED' });
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir, maxAgeMs: 0 });
  assert.strictEqual(result.length, 0);
});

test('多個 incomplete pipelines → 依最後活動時間降序排列', () => {
  cleanup();
  // 較舊的
  const older = makeV3State('old-session-1', { phase: 'CLASSIFIED' });
  older.meta.lastTransition = new Date(Date.now() - 3600000).toISOString(); // 1 小時前
  writeState('old-session-1', older);

  // 較新的
  const newer = makeV3State('old-session-2', { phase: 'DELEGATING' });
  newer.meta.lastTransition = new Date(Date.now() - 600000).toISOString(); // 10 分鐘前
  writeState('old-session-2', newer);

  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 2);
  // 最新的在前
  assert.strictEqual(result[0].sessionId, 'old-session-2');
  assert.strictEqual(result[1].sessionId, 'old-session-1');
});

test('非 v3 state → 排除', () => {
  cleanup();
  const state = { version: 2, pipelineId: 'standard' };
  writeState('old-session', state);
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 0);
});

test('無效 JSON → 忽略該檔案', () => {
  cleanup();
  const filePath = path.join(tmpDir, 'pipeline-state-bad-session.json');
  fs.writeFileSync(filePath, 'not-valid-json');
  const result = findIncompletePipelines('current-session', { claudeDir: tmpDir });
  assert.strictEqual(result.length, 0);
});

// ─── resumePipeline 測試 ─────────────────────────────

console.log('\n=== resumePipeline ===');

test('正常接續：state 複製，sessionId 更新', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED', pipelineId: 'standard' });
  writeState('old-session', state);

  const result = resumePipeline('old-session', 'new-session', { claudeDir: tmpDir });
  assert.strictEqual(result.success, true);

  // 確認新 state 存在且 sessionId 已更新
  const newStatePath = path.join(tmpDir, 'pipeline-state-new-session.json');
  assert.ok(fs.existsSync(newStatePath));
  const newState = JSON.parse(fs.readFileSync(newStatePath, 'utf8'));
  assert.strictEqual(newState.sessionId, 'new-session');
  assert.strictEqual(newState.classification.pipelineId, 'standard');
  assert.strictEqual(newState.meta.resumedFrom, 'old-session');
  assert.ok(newState.meta.resumedAt);
});

test('舊 state 不存在 → success: false + error', () => {
  cleanup();
  const result = resumePipeline('nonexistent-session', 'new-session', { claudeDir: tmpDir });
  assert.strictEqual(result.success, false);
  assert.ok(result.error);
  assert.ok(result.error.includes('找不到舊 state'));
});

test('timeline 存在時複製', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED' });
  writeState('old-session', state);

  // 建立 timeline
  const oldTimelinePath = path.join(tmpDir, 'timeline-old-session.jsonl');
  fs.writeFileSync(oldTimelinePath, '{"type":"session.start","ts":1234}\n');

  resumePipeline('old-session', 'new-session', { claudeDir: tmpDir });

  // 確認 timeline 已複製
  const newTimelinePath = path.join(tmpDir, 'timeline-new-session.jsonl');
  assert.ok(fs.existsSync(newTimelinePath));
  const content = fs.readFileSync(newTimelinePath, 'utf8');
  assert.ok(content.includes('session.start'));
});

test('timeline 不存在時不報錯', () => {
  cleanup();
  const state = makeV3State('old-session', { phase: 'CLASSIFIED' });
  writeState('old-session', state);

  // 不建立 timeline
  const result = resumePipeline('old-session', 'new-session', { claudeDir: tmpDir });
  assert.strictEqual(result.success, true); // 不因為 timeline 不存在而失敗
});

// ─── formatRelativeTime 測試 ─────────────────────────────

console.log('\n=== formatRelativeTime ===');

test('剛才（< 1 分鐘）', () => {
  const result = formatRelativeTime(new Date().toISOString());
  assert.strictEqual(result, '剛才');
});

test('分鐘前', () => {
  const ts = new Date(Date.now() - 90000).toISOString(); // 1.5 分鐘前
  const result = formatRelativeTime(ts);
  assert.ok(result.includes('分鐘前'));
});

test('小時前', () => {
  const ts = new Date(Date.now() - 7200000).toISOString(); // 2 小時前
  const result = formatRelativeTime(ts);
  assert.ok(result.includes('小時前'));
});

test('天前', () => {
  const ts = new Date(Date.now() - 172800000).toISOString(); // 2 天前
  const result = formatRelativeTime(ts);
  assert.ok(result.includes('天前'));
});

test('null → 未知', () => {
  assert.strictEqual(formatRelativeTime(null), '未知');
});

test('無效日期 → 未知', () => {
  assert.strictEqual(formatRelativeTime('not-a-date'), '未知');
});

// ─── 清理暫存目錄 ─────────────────────────────

try {
  cleanup();
  fs.rmdirSync(tmpDir);
} catch (_) {}

// ─── 結果報告 ─────────────────────────────

console.log(`\n結果：${passed} 通過，${failed} 失敗`);
if (failed > 0) process.exit(1);
