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
  extractHookClassification,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,
  buildClassifierPrompt,
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

asyncTest('Layer 1: [pipeline:invalid-name] → 降級到 prompt-hook', async () => {
  const result = await classifyWithConfidence('[pipeline:invalid-name] fix typo');
  assert.strictEqual(result.source, 'prompt-hook');
  assert.strictEqual(result.matchedRule, 'prompt-hook');
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

asyncTest('Fallback: 一般 prompt → none/prompt-hook', async () => {
  const result = await classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'prompt-hook');
  assert.strictEqual(result.matchedRule, 'prompt-hook');
});

asyncTest('Fallback: 中文 prompt → none/prompt-hook', async () => {
  const result = await classifyWithConfidence('重構認證模組');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'prompt-hook');
});

asyncTest('Fallback: 疑問句 → none/prompt-hook', async () => {
  const result = await classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'prompt-hook');
});

// ─── Part 1d: extractHookClassification ──────────

console.log('\n🧪 Part 1d: extractHookClassification（Prompt Hook 結果解析）');
console.log('═'.repeat(50));

test('extractHookClassification: 正常 systemMessage → pipeline ID', () => {
  assert.strictEqual(extractHookClassification('此需求適合 [pipeline:standard]。請使用對應 skill 開始委派。'), 'standard');
});

test('extractHookClassification: full pipeline → full', () => {
  assert.strictEqual(extractHookClassification('此需求適合 [pipeline:full]。請使用對應 skill 開始委派。'), 'full');
});

test('extractHookClassification: fix pipeline → fix', () => {
  assert.strictEqual(extractHookClassification('此需求適合 [pipeline:fix]。請使用對應 skill 開始委派。'), 'fix');
});

test('extractHookClassification: 無 pipeline 標記 → null', () => {
  assert.strictEqual(extractHookClassification('這是一般回應，沒有 pipeline 標記'), null);
});

test('extractHookClassification: null → null', () => {
  assert.strictEqual(extractHookClassification(null), null);
});

test('extractHookClassification: undefined → null', () => {
  assert.strictEqual(extractHookClassification(undefined), null);
});

test('extractHookClassification: 空字串 → null', () => {
  assert.strictEqual(extractHookClassification(''), null);
});

test('extractHookClassification: 不合法 ID → null', () => {
  assert.strictEqual(extractHookClassification('[pipeline:invalid-name] test'), null);
});

test('extractHookClassification: 所有 pipeline ID 都可解析', () => {
  const ids = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security', 'none'];
  for (const id of ids) {
    assert.strictEqual(extractHookClassification(`[pipeline:${id}] test`), id, `應解析 ${id}`);
  }
});

// ─── Part 1e: buildClassifierPrompt + buildPipelineCatalogHint ──

console.log('\n🧪 Part 1e: buildClassifierPrompt + buildPipelineCatalogHint');
console.log('═'.repeat(50));

test('buildClassifierPrompt: 回傳非空字串', () => {
  const prompt = buildClassifierPrompt();
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 0);
});

test('buildClassifierPrompt: 包含分類原則', () => {
  const prompt = buildClassifierPrompt();
  assert.ok(prompt.includes('分類原則'), '應包含分類原則');
});

test('buildClassifierPrompt: 包含回覆格式', () => {
  const prompt = buildClassifierPrompt();
  assert.ok(prompt.includes('decision'), '應包含 decision 欄位說明');
  assert.ok(prompt.includes('systemMessage'), '應包含 systemMessage 欄位說明');
});

test('buildClassifierPrompt: 包含所有 pipeline ID', () => {
  const prompt = buildClassifierPrompt();
  const ids = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security', 'none'];
  for (const id of ids) {
    assert.ok(prompt.includes(id), `應包含 pipeline ${id}`);
  }
});

test('buildClassifierPrompt: 包含 JSON 回覆格式', () => {
  const prompt = buildClassifierPrompt();
  assert.ok(prompt.includes('[pipeline:'), '應包含 [pipeline: 語法範例');
});

test('buildPipelineCatalogHint: 回傳非空字串', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(typeof hint === 'string');
  assert.ok(hint.length > 0);
});

test('buildPipelineCatalogHint: 包含 [pipeline:xxx] 語法', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(hint.includes('[pipeline:'), '應包含 [pipeline: 語法');
});

test('buildPipelineCatalogHint: 包含所有非 none 的 pipeline', () => {
  const hint = buildPipelineCatalogHint();
  const expected = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security'];
  for (const id of expected) {
    assert.ok(hint.includes(`[pipeline:${id}]`), `應包含 [pipeline:${id}]`);
  }
});

test('buildPipelineCatalogHint: 不包含 none', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(!hint.includes('[pipeline:none]'), '不應包含 [pipeline:none]');
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
  const state = {
    sessionId,
    phase: overrides.phase || 'IDLE',
    context: {
      pipelineId: null,
      taskType: null,
      expectedStages: [],
      environment: { languages: { primary: null, secondary: [] }, framework: null, packageManager: null, tools: {} },
      openspecEnabled: false,
      pipelineRules: [],
      needsDesign: false,
      ...(overrides.context || {}),
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
      ...(overrides.progress || {}),
    },
    meta: {
      initialized: true,
      classifiedAt: null,
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
      ...(overrides.meta || {}),
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
    // v3：COMPLETE 觸發 reset → 重新分類。retries 應重設（可能是 {} 或 undefined）
    const retries = state.retries || {};
    assert.deepStrictEqual(retries, {}, 'reset 後 retries 應為空物件或 undefined');
    // 新分類應已寫入（無 API key → none pipeline）
    assert.ok(state.classification, '應有 classification');
    assert.ok(state.classification.pipelineId, '應有 pipelineId');
  } finally {
    cleanupTestState(sid);
  }
});

test('一般 prompt 正常分類（prompt-hook 架構 → none）', () => {
  const sid = 'test-fallback-cls-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    // 非顯式 prompt → prompt-hook → none pipeline
    assert.ok(state.classification, '應有 classification');
    assert.strictEqual(state.classification.pipelineId, 'none', '非顯式 → none');
    assert.strictEqual(state.classification.source, 'prompt-hook', '應為 prompt-hook source');
  } finally {
    cleanupTestState(sid);
  }
});

test('已分類 state 不重複分類（same pipeline）', () => {
  const sid = 'test-cache-hit-' + Date.now();
  try {
    // 建立已分類為 none 的 state（無 API key 的預設結果）
    createTestState(sid, {
      phase: 'CLASSIFIED',
      context: {
        pipelineId: 'none',
        taskType: 'research',
        expectedStages: [],
      },
    });
    // 注入 v3 classification
    const p = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sid}.json`);
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.classification = { pipelineId: 'none', source: 'prompt-hook', confidence: 0 };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));

    const result = runTaskClassifier({ session_id: sid, prompt: '看看專案' });
    // 同 pipeline (none) 不重複分類 → 無輸出
    assert.strictEqual(result.stdout, '', '同 pipeline 不應重複分類');
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
