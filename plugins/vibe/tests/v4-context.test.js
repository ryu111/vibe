#!/usr/bin/env node
/**
 * v4-context.test.js — Node Context 注入與 Reflexion Memory 測試（H01-H05）
 *
 * 場景：
 *   H01: buildNodeContext 基本注入（prev/next/onFail）
 *   H02: context_files 從前驅 stage 讀取（state.stages[prev].contextFile）
 *   H03: retryContext 第一次為 null（無重試歷史）
 *   H04: retryContext 有回退記錄（readReflection 非空）
 *   H05: Reflexion Memory PASS 後清除（cleanReflectionForStage）
 *
 * 執行：node plugins/vibe/tests/v4-context.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const {
  buildNodeContext,
  getRetryContext,
  formatNodeContext,
  MAX_NODE_CONTEXT_CHARS,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/node-context.js'));
const {
  writeReflection,
  readReflection,
  cleanReflectionForStage,
  getReflectionPath,
  MAX_ROUND_CHARS,
  MAX_TOTAL_CHARS,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/reflection.js'));

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

console.log('\n🧠 H01-H05：Node Context 注入與 Reflexion Memory');

// H01: buildNodeContext 基本注入
test('H01: buildNodeContext 正確提取 prev/next/onFail', () => {
  const dag = {
    DEV: { deps: [], onFail: null },
    REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
    TEST: { deps: ['REVIEW'], onFail: 'DEV' },
    DOCS: { deps: ['TEST'], onFail: null },
  };
  const state = {
    version: 4,
    dag,
    stages: {
      DEV: { status: 'completed', contextFile: null },
      REVIEW: { status: 'active', contextFile: null },
      TEST: { status: 'pending', contextFile: null },
      DOCS: { status: 'pending', contextFile: null },
    },
    retries: {},
    environment: { languages: { primary: 'TypeScript' } },
  };

  const ctx = buildNodeContext(dag, state, 'REVIEW', 'test-h01');

  assert.ok(ctx, 'context 應存在');
  assert.strictEqual(ctx.node.stage, 'REVIEW', 'stage 應為 REVIEW');
  assert.deepStrictEqual(ctx.node.prev, ['DEV'], 'prev 應為 [DEV]');
  assert.ok(ctx.node.next.includes('TEST'), 'next 應含 TEST');
  assert.ok(ctx.node.onFail, 'onFail 應存在');
  assert.strictEqual(ctx.node.onFail.target, 'DEV', 'onFail.target 應為 DEV');
  assert.strictEqual(ctx.node.onFail.maxRetries, 3);
  assert.strictEqual(ctx.node.onFail.currentRound, 1, '初次應為第 1 輪');
});

// H01b: formatNodeContext 格式正確
test('H01b: formatNodeContext 產生 <!-- NODE_CONTEXT: {...} --> 格式', () => {
  const dag = { DEV: { deps: [] } };
  const state = {
    version: 4, dag,
    stages: { DEV: { status: 'pending', contextFile: null } },
    retries: {}, environment: {},
  };
  const ctx = buildNodeContext(dag, state, 'DEV', 'test-h01b');
  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.startsWith('<!-- NODE_CONTEXT:'), `應以 <!-- NODE_CONTEXT: 開頭`);
  assert.ok(formatted.endsWith('-->'), `應以 --> 結尾`);

  // 驗證 JSON 可解析
  const jsonMatch = formatted.match(/<!-- NODE_CONTEXT: (.+) -->/s);
  assert.ok(jsonMatch, '應能提取 JSON');
  const parsed = JSON.parse(jsonMatch[1]);
  assert.strictEqual(parsed.node.stage, 'DEV');
});

// H01c: Node Context 大小限制
test('H01c: buildNodeContext 結果不超過 MAX_NODE_CONTEXT_CHARS', () => {
  const dag = { DEV: { deps: [] }, REVIEW: { deps: ['DEV'], onFail: 'DEV' } };
  const state = {
    version: 4, dag,
    stages: {
      DEV: { status: 'completed', contextFile: '/very/long/path/to/context/file.md' },
      REVIEW: { status: 'active', contextFile: null },
    },
    retries: { REVIEW: 2 },
    environment: { languages: { primary: 'TypeScript', secondary: ['JavaScript'] } },
  };
  const ctx = buildNodeContext(dag, state, 'REVIEW', 'test-h01c');
  const json = JSON.stringify(ctx);
  assert.ok(json.length <= MAX_NODE_CONTEXT_CHARS,
    `context JSON 不應超過 ${MAX_NODE_CONTEXT_CHARS} chars，實際：${json.length}`);
});

// H02: context_files 從前驅 stage 讀取
test('H02: DEV 有 contextFile → REVIEW 的 context_files 含此路徑', () => {
  const fakeContextFile = path.join(CLAUDE_DIR, 'pipeline-context-test-h02-DEV.md');
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV' },
  };
  const state = {
    version: 4, dag,
    stages: {
      DEV: { status: 'completed', contextFile: fakeContextFile },
      REVIEW: { status: 'pending', contextFile: null },
    },
    retries: {},
    environment: {},
  };

  const ctx = buildNodeContext(dag, state, 'REVIEW', 'test-h02');
  assert.ok(ctx.context_files.includes(fakeContextFile),
    `context_files 應含 DEV 的 contextFile，實際：${ctx.context_files}`);
});

// H02b: 前驅 contextFile 為 null → context_files 為空
test('H02b: 前驅 contextFile 為 null → context_files 為空陣列', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
  };
  const state = {
    version: 4, dag,
    stages: {
      DEV: { status: 'completed', contextFile: null },
      REVIEW: { status: 'pending', contextFile: null },
    },
    retries: {}, environment: {},
  };
  const ctx = buildNodeContext(dag, state, 'REVIEW', 'test-h02b');
  assert.deepStrictEqual(ctx.context_files, [], 'contextFile=null 時 context_files 應為空');
});

// H03: retryContext 第一次為 null（無重試歷史）
test('H03: 無重試歷史時 retryContext 應為 null', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV' },
  };
  const state = {
    version: 4, dag,
    stages: {
      DEV: { status: 'pending', contextFile: null },
      REVIEW: { status: 'pending', contextFile: null },
    },
    retries: {},  // 無重試記錄
    environment: {},
  };
  const ctx = buildNodeContext(dag, state, 'DEV', 'test-h03');
  assert.strictEqual(ctx.retryContext, null,
    `第一次無重試歷史時 retryContext 應為 null，實際：${JSON.stringify(ctx.retryContext)}`);
});

// H04: retryContext 有回退記錄
test('H04: REVIEW FAIL 後，DEV 的 retryContext 含 failedStage + reflectionFile', () => {
  const sid = 'test-h04';
  cleanSessionState(sid);

  // 先寫入 reflection memory（模擬 REVIEW FAIL）
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH', hint: 'auth 問題' }, 0);

  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV' },
  };
  const state = {
    version: 4, dag,
    stages: {
      DEV: { status: 'pending', contextFile: null },
      REVIEW: { status: 'failed', contextFile: null },
    },
    retries: { REVIEW: 1 },  // 已重試一次
    environment: {},
  };

  const ctx = buildNodeContext(dag, state, 'DEV', sid);
  assert.ok(ctx.retryContext, `有重試歷史時 retryContext 不應為 null`);
  assert.strictEqual(ctx.retryContext.failedStage, 'REVIEW',
    `failedStage 應為 REVIEW，實際：${ctx.retryContext.failedStage}`);
  assert.ok(ctx.retryContext.reflectionFile, 'reflectionFile 應存在');
  assert.ok(ctx.retryContext.hint, 'hint 應存在');

  cleanSessionState(sid);
});

// H05: Reflexion Memory PASS 後清除
test('H05: cleanReflectionForStage 後 readReflection 回傳 null', () => {
  const sid = 'test-h05';
  cleanSessionState(sid);

  // 寫入 reflection memory
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH' }, 0);

  // 確認寫入成功
  const beforeClean = readReflection(sid, 'REVIEW');
  assert.ok(beforeClean, 'PASS 前 reflection 應存在');
  assert.ok(beforeClean.includes('REVIEW'), 'reflection 應含 stage 名稱');

  // PASS 後清除
  cleanReflectionForStage(sid, 'REVIEW');

  // 確認已清除
  const afterClean = readReflection(sid, 'REVIEW');
  assert.strictEqual(afterClean, null, 'cleanReflectionForStage 後應回傳 null');

  cleanSessionState(sid);
});

// H05b: writeReflection 多輪 append
test('H05b: writeReflection 多輪累積（append mode）', () => {
  const sid = 'test-h05b';
  cleanSessionState(sid);

  writeReflection(sid, 'TEST', { verdict: 'FAIL', severity: 'HIGH', hint: '第一輪問題' }, 0);
  writeReflection(sid, 'TEST', { verdict: 'FAIL', severity: 'MEDIUM', hint: '第二輪問題' }, 1);

  const content = readReflection(sid, 'TEST');
  assert.ok(content, 'reflection 應存在');
  assert.ok(content.includes('Round 1'), '應含 Round 1');
  assert.ok(content.includes('Round 2'), '應含 Round 2');

  cleanSessionState(sid);
});

// H05c: reflection memory 大小限制
test('H05c: reflection 超過 MAX_TOTAL_CHARS 時截斷', () => {
  const sid = 'test-h05c';
  cleanSessionState(sid);

  // 寫入大量 rounds 強制截斷
  for (let i = 0; i < 20; i++) {
    writeReflection(sid, 'REVIEW', {
      verdict: 'FAIL',
      severity: 'HIGH',
      hint: 'X'.repeat(400),  // 每輪接近上限
    }, i);
  }

  const content = readReflection(sid, 'REVIEW');
  assert.ok(content, 'reflection 應存在');
  assert.ok(content.length <= MAX_TOTAL_CHARS,
    `截斷後應不超過 ${MAX_TOTAL_CHARS} chars，實際：${content.length}`);

  cleanSessionState(sid);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
