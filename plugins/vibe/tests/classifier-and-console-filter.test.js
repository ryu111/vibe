#!/usr/bin/env node
/**
 * classifier-and-console-filter.test.js — 單元測試
 *
 * Part 1: Pipeline 分類器（Layer 1 顯式 + Prompt Hook 架構 + Fallback）
 * Part 2: check-console-log 檔案過濾 regex
 * Part 3: 品質守衛 hooks stdin→stdout 驗證
 * Part 4: formatter task.classified 格式驗證
 *
 * 執行：node plugins/vibe/tests/classifier-and-console-filter.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

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
  }
}

// Async test 收集器（classifyWithConfidence 現在是 async）
const asyncQueue = [];
function asyncTest(name, fn) {
  asyncQueue.push({ name, fn });
}

// ═══════════════════════════════════════════════
// Part 1: LLM-first 分類器
// ═══════════════════════════════════════════════

const {
  classifyWithConfidence,
  extractExplicitPipeline,
  isSystemFeedback,
  mapTaskTypeToPipeline,
  SYSTEM_MARKER,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

// ─── Part 1a: extractExplicitPipeline (sync) ──────

console.log('\n🧪 Part 1a: extractExplicitPipeline');
console.log('═'.repeat(50));

test('extractExplicitPipeline: 正常解析', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:quick-dev] 修復問題'), 'quick-dev');
});

test('extractExplicitPipeline: 無標記 → null', () => {
  assert.strictEqual(extractExplicitPipeline('修復問題'), null);
});

test('extractExplicitPipeline: 不合法 ID → null', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:invalid]'), null);
});

test('extractExplicitPipeline: 大小寫不敏感', () => {
  assert.strictEqual(extractExplicitPipeline('[Pipeline:Full]'), 'full');
  assert.strictEqual(extractExplicitPipeline('[PIPELINE:STANDARD]'), 'standard');
});

test('extractExplicitPipeline: 語法在結尾', () => {
  assert.strictEqual(extractExplicitPipeline('修復認證 [pipeline:security]'), 'security');
});

test('extractExplicitPipeline: 語法在中間', () => {
  assert.strictEqual(extractExplicitPipeline('修復認證 [pipeline:security] 很急'), 'security');
});

test('extractExplicitPipeline: undefined → null', () => {
  assert.strictEqual(extractExplicitPipeline(undefined), null);
});

test('extractExplicitPipeline: null → null', () => {
  assert.strictEqual(extractExplicitPipeline(null), null);
});

test('extractExplicitPipeline: 空字串 → null', () => {
  assert.strictEqual(extractExplicitPipeline(''), null);
});

// ─── Part 1b: classifyWithConfidence Layer 1 (async) ──

console.log('\n🧪 Part 1b: classifyWithConfidence — Layer 1 顯式覆寫');
console.log('═'.repeat(50));

asyncTest('Layer 1: [pipeline:quick-dev] → quick-dev, 1.0, explicit', async () => {
  const result = await classifyWithConfidence('[pipeline:quick-dev] 修復認證問題');
  assert.strictEqual(result.pipeline, 'quick-dev');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
  assert.strictEqual(result.matchedRule, 'explicit');
});

asyncTest('Layer 1: [pipeline:full] 大小寫不敏感 → full', async () => {
  const result = await classifyWithConfidence('建立完整系統 [Pipeline:Full]');
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
});

asyncTest('Layer 1: [PIPELINE:SECURITY] 全大寫 → security', async () => {
  const result = await classifyWithConfidence('[PIPELINE:SECURITY] 修復 XSS 漏洞');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('Layer 1: [pipeline:invalid-name] → Layer 2 main-agent 接手', async () => {
  const result = await classifyWithConfidence('[pipeline:invalid-name] fix typo');
  // invalid name 跳過 Layer 1；bugfix rule 因含 'pipeline' 關鍵字被排除條件攔截；
  // heuristic 無法分類 → 交由 Layer 2 main-agent 處理
  assert.strictEqual(result.source, 'main-agent');
  assert.strictEqual(result.pipeline, 'none');
});

asyncTest('Layer 1: 語法在結尾 → 正確解析', async () => {
  const result = await classifyWithConfidence('修復認證 [pipeline:security]');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('Layer 1: 語法在中間 → 正確解析', async () => {
  const result = await classifyWithConfidence('修復認證 [pipeline:security] 很急');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('Layer 1: 所有 pipeline ID 都可解析', async () => {
  const ids = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security', 'none'];
  for (const id of ids) {
    const result = await classifyWithConfidence(`[pipeline:${id}] test`);
    assert.strictEqual(result.pipeline, id, `[pipeline:${id}] 應解析為 ${id}`);
    assert.strictEqual(result.source, 'explicit');
  }
});

// ─── Part 1b-2: isSystemFeedback 偵測 (v5 Always-Pipeline) ──

console.log('\n🧪 Part 1b-2: isSystemFeedback 偵測');
console.log('═'.repeat(50));

test('SYSTEM_MARKER: 常數已匯出且為非空字串', () => {
  assert.ok(typeof SYSTEM_MARKER === 'string', 'SYSTEM_MARKER 應為字串');
  assert.ok(SYSTEM_MARKER.length > 0, 'SYSTEM_MARKER 不應為空');
  assert.strictEqual(SYSTEM_MARKER, '<!-- VIBE_SYSTEM -->', 'SYSTEM_MARKER 應為 HTML 註解格式');
});

test('isSystemFeedback: SYSTEM_MARKER 前綴 → true', () => {
  assert.strictEqual(isSystemFeedback(`${SYSTEM_MARKER}⛔ Pipeline 尚未完成。`), true);
});

test('isSystemFeedback: SYSTEM_MARKER 在中間 → true', () => {
  assert.strictEqual(isSystemFeedback(`一些前綴 ${SYSTEM_MARKER} 後綴`), true);
});

test('isSystemFeedback: ⛔ 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('⛔ 禁止停止！Pipeline 缺 DEV 尚未完成。'), true);
});

test('isSystemFeedback: ⚠️ 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('⚠️ 警告：安全漏洞偵測到'), true);
});

test('isSystemFeedback: ✅ 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('✅ 任務已完成'), true);
});

test('isSystemFeedback: 🔄 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('🔄 正在同步...'), true);
});

test('isSystemFeedback: 📋 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('📋 任務清單更新'), true);
});

test('isSystemFeedback: ➡️ 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('➡️ 下一步：提交 PR'), true);
});

test('isSystemFeedback: 📌 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('📌 重要：請注意這個問題'), true);
});

test('isSystemFeedback: 📄 開頭 → true', () => {
  assert.strictEqual(isSystemFeedback('📄 報告：Pipeline 執行結果'), true);
});

test('isSystemFeedback: "Background task completed" → true', () => {
  assert.strictEqual(isSystemFeedback('Background task completed successfully'), true);
});

test('isSystemFeedback: "Task xxx completed" → true', () => {
  assert.strictEqual(isSystemFeedback('Task npm-build completed'), true);
});

test('isSystemFeedback: "Task xxx failed" → true', () => {
  assert.strictEqual(isSystemFeedback('Task lint-check failed'), true);
});

test('isSystemFeedback: "Result from agent" → true', () => {
  assert.strictEqual(isSystemFeedback('Result from vibe:tester: PASS'), true);
});

test('isSystemFeedback: "Output from xxx" → true', () => {
  assert.strictEqual(isSystemFeedback('Output from build process'), true);
});

test('isSystemFeedback: 普通使用者輸入 → false', () => {
  assert.strictEqual(isSystemFeedback('修復一個小 bug'), false);
});

test('isSystemFeedback: 普通英文 → false', () => {
  assert.strictEqual(isSystemFeedback('fix the failing test'), false);
});

test('isSystemFeedback: 疑問句 → false', () => {
  assert.strictEqual(isSystemFeedback('什麼是 pipeline?'), false);
});

test('isSystemFeedback: null → false', () => {
  assert.strictEqual(isSystemFeedback(null), false);
});

test('isSystemFeedback: undefined → false', () => {
  assert.strictEqual(isSystemFeedback(undefined), false);
});

test('isSystemFeedback: 空字串 → false', () => {
  assert.strictEqual(isSystemFeedback(''), false);
});

test('isSystemFeedback: 只有空白 → false', () => {
  assert.strictEqual(isSystemFeedback('   '), false);
});

asyncTest('classifyWithConfidence: ⛔ stop hook → none/system', async () => {
  const result = await classifyWithConfidence('⛔ 禁止停止！Pipeline 缺 REVIEW, TEST 尚未完成。');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'system');
  assert.strictEqual(result.matchedRule, 'system-feedback');
});

asyncTest('classifyWithConfidence: SYSTEM_MARKER → none/system', async () => {
  const result = await classifyWithConfidence(`${SYSTEM_MARKER}修復任務尚未完成`);
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'system');
  assert.strictEqual(result.matchedRule, 'system-feedback');
});

asyncTest('classifyWithConfidence: Background task → none/system', async () => {
  const result = await classifyWithConfidence('Background task completed successfully');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'system');
});

// ─── Part 1b-3: v5 分類場景 — 原 heuristic 命中的 prompt 現在全部交給 main-agent ──

console.log('\n🧪 Part 1b-3: v5 分類場景（原 heuristic → main-agent）');
console.log('═'.repeat(50));

asyncTest('v5 場景: 修復 bug → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('修復一個小 bug');
  assert.strictEqual(result.source, 'main-agent');
  assert.strictEqual(result.pipeline, 'none');
});

asyncTest('v5 場景: fix typo → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('fix the failing authentication test');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 改成 → main-agent（原 heuristic:fix-change）', async () => {
  const result = await classifyWithConfidence('把 port 改成 3000');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 換成 → main-agent（原 heuristic:fix-change）', async () => {
  const result = await classifyWithConfidence('把 JSON 換成 YAML');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 更新文件 → main-agent（原 heuristic:docs）', async () => {
  const result = await classifyWithConfidence('更新 README 文件');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: review → main-agent（原 heuristic:review-only）', async () => {
  const result = await classifyWithConfidence('review classifier.js 的邏輯');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: code review → main-agent（原 heuristic:review-only）', async () => {
  const result = await classifyWithConfidence('幫我 code review 這段程式碼');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 什麼是 → main-agent（原 heuristic:question）', async () => {
  const result = await classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.source, 'main-agent');
  assert.strictEqual(result.pipeline, 'none');
});

asyncTest('v5 場景: 能否說明 → main-agent（原 heuristic:question）', async () => {
  const result = await classifyWithConfidence('能否說明這個設計的優缺點');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 是否需要 → main-agent（原 heuristic:question）', async () => {
  const result = await classifyWithConfidence('是否需要更新文件');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 修正邊界 → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('修正邊界條件處理');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 補完測試 → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('補完測試案例');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 重構認證模組 → main-agent', async () => {
  const result = await classifyWithConfidence('重構認證模組');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 建立 REST API → main-agent', async () => {
  const result = await classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 新增功能 → main-agent', async () => {
  const result = await classifyWithConfidence('新增使用者認證功能');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 審查最近變更 → main-agent（原 heuristic:review-only）', async () => {
  const result = await classifyWithConfidence('審查最近的變更');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 撰寫 docs → main-agent（原 heuristic:docs）', async () => {
  const result = await classifyWithConfidence('撰寫 JSDoc 註解');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 有沒有更好方式 → main-agent（原 heuristic:question）', async () => {
  const result = await classifyWithConfidence('有沒有更好的方式處理這個問題');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 加上錯誤處理 → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('加上錯誤處理');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('v5 場景: 防禦性檢查 → main-agent（原 heuristic:bugfix）', async () => {
  const result = await classifyWithConfidence('加入防禦性檢查');
  assert.strictEqual(result.source, 'main-agent');
});

// ─── Part 1c: classifyWithConfidence Fallback (async, 無 API key) ──

console.log('\n🧪 Part 1c: classifyWithConfidence — Fallback 行為');
console.log('═'.repeat(50));

asyncTest('Fallback: 空字串 → none, 0, fallback, empty', async () => {
  const result = await classifyWithConfidence('');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.matchedRule, 'empty');
});

asyncTest('Fallback: null → none, 0, fallback, empty', async () => {
  const result = await classifyWithConfidence(null);
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.matchedRule, 'empty');
});

asyncTest('Fallback: undefined → none, 0, fallback, empty', async () => {
  const result = await classifyWithConfidence(undefined);
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'fallback');
});

asyncTest('Fallback: 只有空白 → none, 0, fallback, empty', async () => {
  const result = await classifyWithConfidence('   \t\n  ');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'fallback');
});

asyncTest('Fallback: 一般 prompt → none/main-agent', async () => {
  const result = await classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'main-agent');
  assert.strictEqual(result.matchedRule, 'main-agent');
});

asyncTest('Fallback: 中文 prompt → none/main-agent', async () => {
  const result = await classifyWithConfidence('重構認證模組');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('Fallback: 疑問句 → none/main-agent（v5 無 heuristic）', async () => {
  const result = await classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none');
  // v5：無 heuristic，疑問句交由 Main Agent 判斷
  assert.strictEqual(result.source, 'main-agent');
});

// ─── Part 1f: mapTaskTypeToPipeline ─────────────

console.log('\n🧪 Part 1g: mapTaskTypeToPipeline');
console.log('═'.repeat(50));

test('mapTaskTypeToPipeline: feature → standard', () => {
  assert.strictEqual(mapTaskTypeToPipeline('feature'), 'standard');
});

test('mapTaskTypeToPipeline: quickfix → fix', () => {
  assert.strictEqual(mapTaskTypeToPipeline('quickfix'), 'fix');
});

test('mapTaskTypeToPipeline: bugfix → quick-dev', () => {
  assert.strictEqual(mapTaskTypeToPipeline('bugfix'), 'quick-dev');
});

test('mapTaskTypeToPipeline: research → none', () => {
  assert.strictEqual(mapTaskTypeToPipeline('research'), 'none');
});

test('mapTaskTypeToPipeline: tdd → test-first', () => {
  assert.strictEqual(mapTaskTypeToPipeline('tdd'), 'test-first');
});

test('mapTaskTypeToPipeline: refactor → standard', () => {
  assert.strictEqual(mapTaskTypeToPipeline('refactor'), 'standard');
});

test('mapTaskTypeToPipeline: test → quick-dev', () => {
  assert.strictEqual(mapTaskTypeToPipeline('test'), 'quick-dev');
});

test('mapTaskTypeToPipeline: unknown → fix（預設）', () => {
  assert.strictEqual(mapTaskTypeToPipeline('unknown-type'), 'fix');
});

// ─── Part 1h: Session 快取驗證 ──────────────────

console.log('\n🧪 Part 1h: Session 快取驗證（子行程）');
console.log('═'.repeat(50));

const CLAUDE_TEST_DIR = path.join(os.homedir(), '.claude');
const TC_SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'task-classifier.js');

function runTaskClassifier(stdinData, envOverrides = {}) {
  const input = JSON.stringify(stdinData);
  const testEnv = { ...process.env, ...envOverrides };
  // 確保測試不呼叫真實 API
  delete testEnv.ANTHROPIC_API_KEY;
  try {
    const stdout = execSync(
      `echo '${input.replace(/'/g, "'\\''")}' | node "${TC_SCRIPT}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, env: testEnv }
    ).toString().trim();
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      exitCode: err.status || 1,
    };
  }
}

function createTestState(sessionId, overrides = {}) {
  const p = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`);
  const ctx = overrides.context || {};
  const pid = ctx.pipelineId || null;
  const stages = ctx.expectedStages || [];

  // 建立線性 DAG
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = { deps: i > 0 ? [stages[i - 1]] : [] };
  }

  // 所有 stage 為 pending
  const stagesObj = {};
  for (const s of stages) {
    stagesObj[s] = { status: 'pending', agent: null, verdict: null };
  }

  // pipelineActive：有 pipelineId（非 none）且有 stages
  const pipelineActive = !!(pid && pid !== 'none') && stages.length > 0;

  const state = {
    version: 4,
    sessionId,
    classification: pid ? {
      pipelineId: pid,
      taskType: ctx.taskType || null,
      source: 'test',
      classifiedAt: new Date().toISOString(),
    } : null,
    environment: ctx.environment || { languages: { primary: null, secondary: [] }, framework: null, packageManager: null, tools: {} },
    openspecEnabled: ctx.openspecEnabled || false,
    needsDesign: ctx.needsDesign || false,
    dag: stages.length > 0 ? dag : null,
    blueprint: null,
    pipelineActive,
    activeStages: [],
    stages: stagesObj,
    retries: {},
    retryHistory: {},
    crashes: {},
    pendingRetry: null,
    meta: {
      initialized: true,
      cancelled: (overrides.meta || {}).cancelled || false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: ctx.pipelineRules || [],
    },
  };
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function readTestState(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`), 'utf8'));
}

function cleanupTestState(sessionId) {
  const files = [
    path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`),
    path.join(CLAUDE_TEST_DIR, `timeline-${sessionId}.jsonl`),
  ];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

test('reset 清除分類（pipeline 完成後新分類重設）', () => {
  const sid = 'test-reset-llm-' + Date.now();
  try {
    // 直接建立 v3 COMPLETE state（所有 stage 已完成）
    const statePath = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sid}.json`);
    const v3State = {
      version: 3,
      sessionId: sid,
      classification: { pipelineId: 'fix', taskType: 'quickfix', source: 'explicit' },
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
      dag: { DEV: { deps: [] } },
      enforced: true,
      blueprint: null,
      stages: { DEV: { status: 'completed', verdict: 'PASS', completedAt: new Date().toISOString() } },
      retries: { DEV: 1 },
      pendingRetry: null,
      meta: { initialized: true, cancelled: false, lastTransition: new Date().toISOString(), reclassifications: [] },
    };
    fs.writeFileSync(statePath, JSON.stringify(v3State, null, 2));

    runTaskClassifier({ session_id: sid, prompt: 'implement authentication' });
    const state = readTestState(sid);
    // v3：COMPLETE 觸發 reset → 重新分類（retries 可能被保留用於歷史分析）
    assert.ok(state, 'state 應存在');
    // 新分類應已寫入（無 API key → none pipeline）
    assert.ok(state.classification, '應有 classification');
    assert.ok(state.classification.pipelineId, '應有 pipelineId');
  } finally {
    cleanupTestState(sid);
  }
});

test('一般 prompt 正常分類（Main Agent 自主判斷 → none）', () => {
  const sid = 'test-fallback-cls-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    // 非顯式 prompt → main-agent → none pipeline
    assert.ok(state.classification, '應有 classification');
    assert.strictEqual(state.classification.pipelineId, 'none', '非顯式 → none');
    assert.strictEqual(state.classification.source, 'main-agent', '應為 main-agent source');
  } finally {
    cleanupTestState(sid);
  }
});

test('已分類 state 不重複分類（same non-none pipeline）', () => {
  const sid = 'test-cache-hit-' + Date.now();
  try {
    // 建立已分類為 standard 的 state
    createTestState(sid, {
      phase: 'CLASSIFIED',
      context: {
        pipelineId: 'standard',
        taskType: 'feature',
        expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      },
    });
    // 注入 v3 classification
    const p = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sid}.json`);
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.classification = { pipelineId: 'standard', source: 'main-agent', confidence: 0.8 };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));

    const result = runTaskClassifier({ session_id: sid, prompt: '繼續開發' });
    // 同 pipeline (standard) 不重複分類 → 無輸出
    assert.strictEqual(result.stdout, '', '同 non-none pipeline 不應重複分類');
  } finally {
    cleanupTestState(sid);
  }
});

test('none pipeline 每次都注入 systemMessage', () => {
  const sid = 'test-none-repeat-' + Date.now();
  try {
    createTestState(sid, {
      phase: 'CLASSIFIED',
      context: { pipelineId: 'none', taskType: 'research', expectedStages: [] },
    });
    const p = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sid}.json`);
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.classification = { pipelineId: 'none', source: 'main-agent', confidence: 0 };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));

    const result = runTaskClassifier({ session_id: sid, prompt: '看看專案' });
    // none pipeline 不去重 → 每次注入 systemMessage
    const output = result.stdout.trim();
    assert.ok(output.length > 0, 'none pipeline 應每次都有輸出');
    const parsed = JSON.parse(output);
    assert.ok(parsed.systemMessage, 'none pipeline 應注入 systemMessage');
    assert.ok(parsed.systemMessage.includes('Pipeline 路由器'), 'systemMessage 應包含分類指令');
  } finally {
    cleanupTestState(sid);
  }
});

test('顯式 pipeline 正常寫入 v3 classification', () => {
  const sid = 'test-explicit-cls-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: '[pipeline:standard] implement user authentication' });
    const state = readTestState(sid);
    // 顯式指定 → standard pipeline
    assert.strictEqual(state.classification.pipelineId, 'standard', 'explicit 應映射到 standard');
    assert.strictEqual(state.classification.source, 'explicit', '應為 explicit source');
  } finally {
    cleanupTestState(sid);
  }
});

test('顯式 fix pipeline 寫入', () => {
  const sid = 'test-explicit-fix-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: '[pipeline:fix] 改個 typo' });
    const state = readTestState(sid);
    assert.strictEqual(state.classification.pipelineId, 'fix');
    assert.strictEqual(state.classification.source, 'explicit');
  } finally {
    cleanupTestState(sid);
  }
});

// ═══════════════════════════════════════════════
// Part 2: check-console-log 檔案過濾邏輯
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 2: check-console-log 檔案過濾邏輯');
console.log('═'.repeat(50));

const filterFn = (f) => !/(^|\/)scripts\/hooks\//.test(f) && !/hook-logger\.js$/.test(f);

test('排除：plugins/vibe/scripts/hooks/pipeline-check.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/pipeline-check.js'), false);
});

test('排除：plugins/vibe/scripts/hooks/stage-transition.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/stage-transition.js'), false);
});

test('排除：plugins/vibe/scripts/hooks/task-classifier.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/task-classifier.js'), false);
});

test('排除：scripts/hooks/custom-hook.js', () => {
  assert.strictEqual(filterFn('scripts/hooks/custom-hook.js'), false);
});

test('排除：plugins/vibe/scripts/lib/hook-logger.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/hook-logger.js'), false);
});

test('排除：some/path/hook-logger.js', () => {
  assert.strictEqual(filterFn('some/path/hook-logger.js'), false);
});

test('不排除：src/app.js', () => {
  assert.strictEqual(filterFn('src/app.js'), true);
});

test('不排除：plugins/vibe/scripts/lib/flow/pipeline-discovery.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/flow/pipeline-discovery.js'), true);
});

test('不排除：index.js', () => {
  assert.strictEqual(filterFn('index.js'), true);
});

test('不排除：plugins/vibe/scripts/lib/registry.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/registry.js'), true);
});

test('不排除：plugins/vibe/server.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/server.js'), true);
});

test('不排除：scripts/lib/utils.js', () => {
  assert.strictEqual(filterFn('scripts/lib/utils.js'), true);
});

test('不排除：hooks/my-file.js（hooks/ 不是 scripts/hooks/）', () => {
  assert.strictEqual(filterFn('hooks/my-file.js'), true);
});

test('不排除：some/hooks-helper.js', () => {
  assert.strictEqual(filterFn('some/hooks-helper.js'), true);
});

test('不排除：logger.js（不是 hook-logger.js）', () => {
  assert.strictEqual(filterFn('logger.js'), true);
});

// ═══════════════════════════════════════════════
// Part 3: 品質守衛 hooks stdin→stdout 驗證
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 3: 品質守衛 hooks stdin→stdout 驗證');
console.log('═'.repeat(50));

const PLUGIN_ROOT = path.join(__dirname, '..');

function runSentinelHook(hookName, stdinData) {
  const script = path.join(PLUGIN_ROOT, 'scripts', 'hooks', `${hookName}.js`);
  const input = JSON.stringify(stdinData);
  try {
    const stdout = execSync(
      `echo '${input.replace(/'/g, "'\\''")}' | node "${script}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    ).toString().trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      stderr: err.stderr ? err.stderr.toString().trim() : '',
      exitCode: err.status || 1,
    };
  }
}

// auto-lint + auto-format 已合併至 post-edit.js（v1.0.50），改用純函式驗證
const postEdit = require(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'post-edit.js'));

test('runLintStep：.xyz 檔案 → null（無對應 linter）', () => {
  assert.strictEqual(postEdit.runLintStep('/tmp/test.xyz', 'test', 'Write'), null);
});

test('runLintStep：null 路徑 → null', () => {
  assert.strictEqual(postEdit.runLintStep(null, 'test', 'Write'), null);
});

test('runLintStep：.json → null（linter=null）', () => {
  assert.strictEqual(postEdit.runLintStep('/tmp/test.json', 'test', 'Write'), null);
});

test('runFormatStep：.xyz 檔案 → undefined（無對應 formatter）', () => {
  assert.strictEqual(postEdit.runFormatStep('/tmp/test.xyz', 'test', 'Write'), undefined);
});

test('runFormatStep：null 路徑 → undefined', () => {
  assert.strictEqual(postEdit.runFormatStep(null, 'test', 'Write'), undefined);
});

test('runFormatStep：.py → 不崩潰', () => {
  postEdit.runFormatStep('/tmp/test.py', 'test', 'Write');
  assert.ok(true);
});

// danger-guard 已合併至 guard-rules.js（v1.0.50），改用 evaluateBashDanger 驗證
test('evaluateBashDanger：安全指令 → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger('ls -la'), null);
});

test('evaluateBashDanger：空指令 → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger(''), null);
});

test('evaluateBashDanger：npm install → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger('npm install'), null);
});

test('evaluateBashDanger：chmod 777 → block + matchedPattern', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('chmod 777 /etc/passwd');
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('chmod 777'), 'message 應包含攔截原因');
  assert.strictEqual(result.matchedPattern, 'chmod 777');
});

test('evaluateBashDanger：DROP TABLE → block', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('DROP TABLE users');
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('DROP TABLE'));
});

test('evaluateBashDanger：rm -rf / → block', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('rm -rf / ');
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.matchedPattern, 'rm -rf /');
});

test('check-console-log：stop_hook_active=true → 靜默退出', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: true });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('check-console-log：stop_hook_active=false → 正常執行', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: false });
  assert.strictEqual(r.exitCode, 0);
});

test('runLintStep：.ts 檔案 → null 或 systemMessage 字串', () => {
  const result = postEdit.runLintStep('/tmp/nonexistent.ts', 'test', 'Write');
  assert.ok(result === null || typeof result === 'string', 'null 或 lint 警告字串');
});

// ═══════════════════════════════════════════════
// Part 4: formatter task.classified 格式驗證
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 4: formatter task.classified 格式驗證');
console.log('═'.repeat(50));

const { formatEventText: fmtEvt } = require(path.join(__dirname, '..', 'scripts', 'lib', 'timeline', 'formatter.js'));

test('formatter: task.classified 新格式（有 layer）', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'standard', taskType: 'feature', layer: 2, confidence: 0.80, matchedRule: 'action:feature', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('standard'), '應含 pipelineId');
  assert.ok(text.includes('L2'), '應含 Layer');
  assert.ok(text.includes('0.80'), '應含 confidence');
  assert.ok(text.includes('action:feature'), '應含 matchedRule');
});

test('formatter: task.classified 升級格式', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'full', from: 'fix', layer: 2, confidence: 0.80, matchedRule: 'action:feature', reclassified: true } };
  const text = fmtEvt(event);
  assert.ok(text.includes('升級'), '應含「升級」');
  assert.ok(text.includes('fix'), '應含 from');
  assert.ok(text.includes('full'), '應含 to');
  assert.ok(text.includes('L2'), '應含 Layer');
});

test('formatter: task.classified 舊格式向後相容（無 layer）', () => {
  const event = { type: 'task.classified', data: { taskType: 'feature' } };
  const text = fmtEvt(event);
  assert.ok(text.includes('feature'), '應含 taskType');
  assert.ok(text.startsWith('分類='), '應含分類前綴');
  assert.ok(!/L\d\(/.test(text), '不應含 Layer 標記（L1(/L2(/L3(）');
});

test('formatter: task.classified Layer 1 explicit', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'full', layer: 1, confidence: 1.0, matchedRule: 'explicit', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('L1'), '應含 L1');
  assert.ok(text.includes('1.00'), '應含信心度 1.00');
  assert.ok(text.includes('explicit'), '應含 explicit');
});

test('formatter: task.classified Layer 3 LLM', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'standard', layer: 3, confidence: 0.85, matchedRule: 'weak-explore', source: 'llm', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('L3'), '應含 L3');
  assert.ok(text.includes('0.85'), '應含信心度');
});

// ─── Part 5: Spec 驗收條件 — SYSTEM_MARKER + isSystemFeedback 規格場景 ──

console.log('\n🧪 Part 5: SYSTEM_MARKER + isSystemFeedback 規格場景');
console.log('═'.repeat(50));

// isSystemFeedback: SYSTEM_MARKER 在 prompt 中間也被偵測
test('isSystemFeedback: SYSTEM_MARKER 在 prompt 中間也能被偵測', () => {
  assert.strictEqual(isSystemFeedback('一些前綴文字 <!-- VIBE_SYSTEM --> 一些後綴文字'), true);
});

// isSystemFeedback: SYSTEM_MARKER 優先性（含 review 關鍵字仍偵測為系統回饋）
asyncTest('classifyWithConfidence: SYSTEM_MARKER + review → system（非 main-agent）', async () => {
  const result = await classifyWithConfidence('<!-- VIBE_SYSTEM --> review 一下 auth 模組');
  assert.strictEqual(result.source, 'system');
  assert.strictEqual(result.pipeline, 'none');
});

// hooks spec: pipeline-check reason 含 SYSTEM_MARKER
test('pipeline-check.js 引用 SYSTEM_MARKER 常數（非硬編碼）', () => {
  const pcContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'pipeline-check.js'), 'utf8'
  );
  assert.ok(pcContent.includes('classifier.js'), 'pipeline-check 應 require classifier.js');
  assert.ok(pcContent.includes('SYSTEM_MARKER'), 'pipeline-check 應使用 SYSTEM_MARKER 常數');
  const withoutComment = pcContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!withoutComment.includes('<!-- VIBE_SYSTEM -->'), 'pipeline-check 不應硬編碼標記字串（DRY）');
});

// hooks spec: task-guard systemMessage 含 SYSTEM_MARKER
test('task-guard.js 引用 SYSTEM_MARKER 常數（非硬編碼）', () => {
  const tgContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'task-guard.js'), 'utf8'
  );
  assert.ok(tgContent.includes('classifier.js'), 'task-guard 應 require classifier.js');
  assert.ok(tgContent.includes('SYSTEM_MARKER'), 'task-guard 應使用 SYSTEM_MARKER 常數');
  const withoutComment = tgContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!withoutComment.includes('<!-- VIBE_SYSTEM -->'), 'task-guard 不應硬編碼標記字串（DRY）');
});

test('pipeline-check reason 格式：SYSTEM_MARKER 前綴 + systemMessage', () => {
  const pcContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'pipeline-check.js'), 'utf8'
  );
  assert.ok(
    pcContent.includes('`${SYSTEM_MARKER}${result.systemMessage}`') ||
    pcContent.includes("SYSTEM_MARKER + result.systemMessage") ||
    pcContent.includes('reason: `${SYSTEM_MARKER}'),
    'pipeline-check reason 應以 SYSTEM_MARKER 為前綴'
  );
});

test('task-guard 阻擋路徑 systemMessage 含 SYSTEM_MARKER 前綴', () => {
  const tgContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'task-guard.js'), 'utf8'
  );
  const systemMessageMatches = tgContent.match(/systemMessage:.*SYSTEM_MARKER/g) || [];
  assert.ok(systemMessageMatches.length >= 2, `task-guard 應有至少 2 處 systemMessage 含 SYSTEM_MARKER，實際: ${systemMessageMatches.length}`);
});

// ─── Part 5b: AskUserQuestion guard 放行驗證 ──

console.log('\n🧪 Part 5b: AskUserQuestion guard 放行驗證');
console.log('═'.repeat(50));

test('AskUserQuestion 在 READ_ONLY_TOOLS 白名單中', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  // pipelineActive=true + 無 activeStages → READ_ONLY_TOOLS 白名單判斷
  const state = {
    version: 4,
    pipelineActive: true,
    activeStages: [],
    stages: {},
    dag: { DEV: { deps: [] } },
  };
  const result = evaluate('AskUserQuestion', {}, state);
  assert.strictEqual(result.decision, 'allow', 'AskUserQuestion 應在 pipelineActive 時被白名單放行');
});

test('AskUserQuestion 在 pipelineActive=false 時放行', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const state = {
    version: 4,
    pipelineActive: false,
    activeStages: [],
    stages: {},
  };
  const result = evaluate('AskUserQuestion', {}, state);
  assert.strictEqual(result.decision, 'allow', 'AskUserQuestion 在 pipelineActive=false 時應放行');
});

test('AskUserQuestion 有 activeStages 時放行（sub-agent 委派中）', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const state = {
    version: 4,
    pipelineActive: true,
    activeStages: ['DEV'],
    stages: { DEV: { status: 'active' } },
    dag: { DEV: { deps: [] } },
  };
  const result = evaluate('AskUserQuestion', {}, state);
  assert.strictEqual(result.decision, 'allow', 'AskUserQuestion 在 sub-agent 委派中應放行');
});

test('AskUserQuestion 無 state 時放行（未初始化）', () => {
  const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluate('AskUserQuestion', {}, null);
  assert.strictEqual(result.decision, 'allow', 'AskUserQuestion 在 state=null 時應放行');
});

// ─── Part 5c: S1 新增邊界案例 — isSystemFeedback 完整覆蓋 ──

console.log('\n🧪 Part 5c: S1 新增邊界案例');
console.log('═'.repeat(50));

test('isSystemFeedback: "Task xxx finished" → true（finished 格式）', () => {
  assert.strictEqual(isSystemFeedback('Task webpack-build finished'), true);
});

test('isSystemFeedback: "Task xxx finished" 含空白 → true', () => {
  assert.strictEqual(isSystemFeedback('Task long-running-job finished with output'), true);
});

test('isSystemFeedback: 前置空白後的 emoji → trim() 後仍偵測', () => {
  assert.strictEqual(isSystemFeedback('   ⛔ 系統警告'), true);
});

test('isSystemFeedback: 前置空白後的 SYSTEM_MARKER → true', () => {
  assert.strictEqual(isSystemFeedback(`   ${SYSTEM_MARKER}系統訊息`), true);
});

test('isSystemFeedback: 英文字母開頭（非 emoji / SYSTEM_MARKER / 英文系統通知）→ false', () => {
  // 實作使用字元類別 regex，其 Unicode 範圍可能廣泛命中 emoji
  // 本測試確認：明確非系統訊息的英文開頭字串回傳 false
  assert.strictEqual(isSystemFeedback('Hello, how are you?'), false);
});

test('isSystemFeedback: 中文開頭（無前導 emoji/SYSTEM_MARKER）→ false', () => {
  assert.strictEqual(isSystemFeedback('請幫我新增一個登入功能'), false);
});

test('isSystemFeedback: "background task" 小寫 → true（大小寫不敏感）', () => {
  assert.strictEqual(isSystemFeedback('background task completed'), true);
});

test('isSystemFeedback: "BACKGROUND TASK" 全大寫 → true（大小寫不敏感）', () => {
  assert.strictEqual(isSystemFeedback('BACKGROUND TASK COMPLETED'), true);
});

test('isSystemFeedback: "output from" 小寫 → true（大小寫不敏感）', () => {
  assert.strictEqual(isSystemFeedback('output from linter'), true);
});

test('isSystemFeedback: "result from" 小寫 → true（大小寫不敏感）', () => {
  assert.strictEqual(isSystemFeedback('result from pipeline'), true);
});

test('isSystemFeedback: SYSTEM_MARKER 後跟 newline → true', () => {
  assert.strictEqual(isSystemFeedback(`${SYSTEM_MARKER}\n繼續執行`), true);
});

test('isSystemFeedback: 純 SYSTEM_MARKER 無後綴 → true', () => {
  assert.strictEqual(isSystemFeedback(SYSTEM_MARKER), true);
});

// ─── Part 5d: classifyWithConfidence main-agent 路徑結構驗證 ──

console.log('\n🧪 Part 5d: classifyWithConfidence main-agent 結構驗證');
console.log('═'.repeat(50));

asyncTest('main-agent: 返回 confidence=0', async () => {
  const result = await classifyWithConfidence('幫我寫一個功能');
  assert.strictEqual(result.source, 'main-agent');
  assert.strictEqual(result.confidence, 0, 'main-agent 路徑 confidence 應為 0');
});

asyncTest('main-agent: 返回 matchedRule=main-agent', async () => {
  const result = await classifyWithConfidence('幫我寫一個功能');
  assert.strictEqual(result.matchedRule, 'main-agent', 'main-agent 路徑 matchedRule 應為 main-agent');
});

asyncTest('main-agent: 返回 pipeline=none', async () => {
  const result = await classifyWithConfidence('幫我寫一個功能');
  assert.strictEqual(result.pipeline, 'none', 'main-agent 路徑 pipeline 應為 none');
});

asyncTest('main-agent: 返回物件有四個欄位', async () => {
  const result = await classifyWithConfidence('實作使用者登入');
  assert.ok('pipeline' in result, '應有 pipeline 欄位');
  assert.ok('confidence' in result, '應有 confidence 欄位');
  assert.ok('source' in result, '應有 source 欄位');
  assert.ok('matchedRule' in result, '應有 matchedRule 欄位');
});

asyncTest('system-feedback: 返回 confidence=0.9', async () => {
  const result = await classifyWithConfidence('⛔ Pipeline 尚未完成');
  assert.strictEqual(result.source, 'system');
  assert.strictEqual(result.confidence, 0.9, 'system-feedback 路徑 confidence 應為 0.9');
});

asyncTest('system-feedback: 返回 matchedRule=system-feedback', async () => {
  const result = await classifyWithConfidence('✅ 任務完成');
  assert.strictEqual(result.matchedRule, 'system-feedback');
});

asyncTest('explicit: 返回 confidence=1.0', async () => {
  const result = await classifyWithConfidence('[pipeline:fix] 修正 typo');
  assert.strictEqual(result.source, 'explicit');
  assert.strictEqual(result.confidence, 1.0, 'explicit 路徑 confidence 應為 1.0');
});

asyncTest('explicit: 返回 matchedRule=explicit', async () => {
  const result = await classifyWithConfidence('[pipeline:fix] 修正 typo');
  assert.strictEqual(result.matchedRule, 'explicit');
});

// ─── Part 5e: classify() controller 系統整合 — system-feedback 靜默忽略 ──

console.log('\n🧪 Part 5e: task-classifier 系統整合 — system-feedback 靜默行為');
console.log('═'.repeat(50));

test('system-feedback: ⛔ 開頭 → task-classifier 無輸出（靜默忽略）', () => {
  const sid = 'test-sysfb-block-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: '⛔ Pipeline 缺 DEV 尚未完成。' });
    assert.strictEqual(result.stdout, '', 'system-feedback 訊息不應觸發分類輸出');
  } finally {
    cleanupTestState(sid);
  }
});

test('system-feedback: SYSTEM_MARKER → task-classifier 無輸出', () => {
  const sid = 'test-sysfb-marker-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: `${SYSTEM_MARKER}⛔ Pipeline 修復任務未完成` });
    assert.strictEqual(result.stdout, '', 'SYSTEM_MARKER 訊息不應觸發分類輸出');
  } finally {
    cleanupTestState(sid);
  }
});

test('system-feedback: Background task → task-classifier 無輸出', () => {
  const sid = 'test-sysfb-bg-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: 'Background task completed successfully' });
    assert.strictEqual(result.stdout, '', 'Background task 不應觸發分類輸出');
  } finally {
    cleanupTestState(sid);
  }
});

test('system-feedback: Task xxx finished → task-classifier 無輸出', () => {
  const sid = 'test-sysfb-taskfin-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: 'Task webpack-build finished' });
    assert.strictEqual(result.stdout, '', 'Task finished 訊息不應觸發分類輸出');
  } finally {
    cleanupTestState(sid);
  }
});

// ─── Part 5f: classify() systemMessage 包含 AskUserQuestion 提示 ──

console.log('\n🧪 Part 5f: pipeline 選擇表 systemMessage 包含 AskUserQuestion 提示');
console.log('═'.repeat(50));

test('none pipeline systemMessage 包含 AskUserQuestion 指引', () => {
  const sid = 'test-sysmsg-ask-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: '看看目前的狀況' });
    assert.ok(result.stdout.length > 0, '應有 systemMessage 輸出');
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.systemMessage, '應有 systemMessage');
    assert.ok(
      parsed.systemMessage.includes('AskUserQuestion'),
      'systemMessage 應包含 AskUserQuestion 指引（不確定時詢問使用者）'
    );
  } finally {
    cleanupTestState(sid);
  }
});

test('none pipeline systemMessage 包含所有 pipeline 選項', () => {
  const sid = 'test-sysmsg-options-' + Date.now();
  try {
    createTestState(sid);
    const result = runTaskClassifier({ session_id: sid, prompt: '幫我做點事' });
    const parsed = JSON.parse(result.stdout);
    const msg = parsed.systemMessage;
    // 驗證關鍵 pipeline 選項都在 systemMessage 中
    assert.ok(msg.includes('fix'), '應包含 fix pipeline');
    assert.ok(msg.includes('quick-dev'), '應包含 quick-dev pipeline');
    assert.ok(msg.includes('standard'), '應包含 standard pipeline');
    assert.ok(msg.includes('full'), '應包含 full pipeline');
    assert.ok(msg.includes('chat') || msg.includes('none'), '應包含 chat/none 選項');
  } finally {
    cleanupTestState(sid);
  }
});

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

// Async tests 運行器（收集的 asyncTest 在此執行）
(async () => {
  if (asyncQueue.length > 0) {
    console.log('\n🧪 Async Tests');
    console.log('═'.repeat(50));
    for (const { name, fn } of asyncQueue) {
      try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ 全部通過\n');
  }
})();
