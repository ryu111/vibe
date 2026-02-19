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
  classifyByHeuristic,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,
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

// ─── Part 1b-2: classifyByHeuristic — system-feedback 偵測 ──

console.log('\n🧪 Part 1b-2: classifyByHeuristic — system-feedback 偵測');
console.log('═'.repeat(50));

test('system-feedback: ⛔ 開頭 → none（stop hook reason）', () => {
  const r = classifyByHeuristic('⛔ 禁止停止！Pipeline 缺 DEV 尚未完成。\n你必須立即呼叫 Skill 工具');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('system-feedback: ⛔ 含修復關鍵字仍匹配 system-feedback（優先於 bugfix）', () => {
  const r = classifyByHeuristic('⛔ 禁止停止！修復尚未完成');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('system-feedback: 非 ⛔ 開頭不匹配', () => {
  const r = classifyByHeuristic('修復一個小 bug');
  assert.ok(r);
  assert.strictEqual(r.matchedRule, 'heuristic:bugfix', '非 ⛔ 開頭應正常匹配 bugfix');
});

asyncTest('Layer 1.5: ⛔ stop hook feedback → none/heuristic:system-feedback', async () => {
  const result = await classifyWithConfidence('⛔ 禁止停止！Pipeline 缺 REVIEW, TEST 尚未完成。');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'heuristic');
  assert.strictEqual(result.matchedRule, 'heuristic:system-feedback');
});

// ─── Part 1b-3: SYSTEM_MARKER 偵測 (任務 1.6) ──────

console.log('\n🧪 Part 1b-3: SYSTEM_MARKER 偵測');
console.log('═'.repeat(50));

test('SYSTEM_MARKER: 常數已匯出且為非空字串', () => {
  assert.ok(typeof SYSTEM_MARKER === 'string', 'SYSTEM_MARKER 應為字串');
  assert.ok(SYSTEM_MARKER.length > 0, 'SYSTEM_MARKER 不應為空');
  assert.strictEqual(SYSTEM_MARKER, '<!-- VIBE_SYSTEM -->', 'SYSTEM_MARKER 應為 HTML 註解格式');
});

test('SYSTEM_MARKER 偵測：純標記前綴 → system-feedback', () => {
  const r = classifyByHeuristic(`${SYSTEM_MARKER}⛔ Pipeline 尚未完成。`);
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('SYSTEM_MARKER 偵測：標記 + emoji → system-feedback（標記優先）', () => {
  const r = classifyByHeuristic(`${SYSTEM_MARKER}✅ 任務完成通知`);
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('SYSTEM_MARKER 偵測：標記優先於 bugfix 規則', () => {
  // 即使 prompt 含有「修復」關鍵字，SYSTEM_MARKER 也應優先攔截
  const r = classifyByHeuristic(`${SYSTEM_MARKER}修復任務尚未完成，請繼續。`);
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('SYSTEM_MARKER 偵測：無標記的普通修復 prompt 不受影響', () => {
  const r = classifyByHeuristic('修復一個小 bug');
  assert.ok(r);
  assert.strictEqual(r.matchedRule, 'heuristic:bugfix', '無標記應正常匹配 bugfix');
});

// ─── Part 1b-4: 擴充 emoji 偵測 (任務 1.7 + 1.8) ──

console.log('\n🧪 Part 1b-4: 擴充 emoji 偵測');
console.log('═'.repeat(50));

test('emoji 擴充：✅ 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('✅ 任務已完成');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 擴充：🔄 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('🔄 正在同步...');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 擴充：📋 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('📋 任務清單更新');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 擴充：➡️ 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('➡️ 下一步：提交 PR');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 擴充：📌 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('📌 重要：請注意這個問題');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 擴充：📄 開頭 → system-feedback（新增）', () => {
  const r = classifyByHeuristic('📄 報告：Pipeline 執行結果');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 回歸：⛔ 開頭仍正常匹配（回歸驗證）', () => {
  const r = classifyByHeuristic('⛔ 禁止停止！必須繼續委派。');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('emoji 回歸：⚠️ 開頭仍正常匹配（回歸驗證）', () => {
  const r = classifyByHeuristic('⚠️ 警告：安全漏洞偵測到');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

// ─── Part 1b-5: review-only heuristic (任務 2.3 + 2.4) ──

console.log('\n🧪 Part 1b-5: review-only heuristic');
console.log('═'.repeat(50));

test('review-only: "review XXX" 正面匹配', () => {
  const r = classifyByHeuristic('review classifier.js 的邏輯');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

test('review-only: "code review" 正面匹配', () => {
  const r = classifyByHeuristic('幫我 code review 這段程式碼');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

test('review-only: "審查 XXX" 中文正面匹配', () => {
  const r = classifyByHeuristic('審查 pipeline-controller 的邏輯');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

test('review-only: "程式碼審查" 正面匹配', () => {
  const r = classifyByHeuristic('請做一次程式碼審查');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

test('review-only 負面排除: "review + 修復" → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review 之後修復發現的 bug');
  // 含「修復」→ 不匹配 review-only（應由 Layer 2 判斷）
  assert.ok(!r || r.matchedRule !== 'heuristic:review-only',
    '含「修復」不應匹配 review-only，實際: ' + (r ? r.matchedRule : 'null'));
});

test('review-only 負面排除: "review + 重構" → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review 並重構 classifier 的 HEURISTIC_RULES');
  assert.ok(!r || r.matchedRule !== 'heuristic:review-only',
    '含「重構」不應匹配 review-only，實際: ' + (r ? r.matchedRule : 'null'));
});

test('review-only 負面排除: "review + 新增" → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review 完之後新增一個測試案例');
  assert.ok(!r || r.matchedRule !== 'heuristic:review-only',
    '含「新增」不應匹配 review-only，實際: ' + (r ? r.matchedRule : 'null'));
});

test('review-only 負面排除: "review + 實作" → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review 後按建議實作改善');
  assert.ok(!r || r.matchedRule !== 'heuristic:review-only',
    '含「實作」不應匹配 review-only，實際: ' + (r ? r.matchedRule : 'null'));
});

test('review-only 負面排除: "review + fix" → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review and fix the authentication flow');
  assert.ok(!r || r.matchedRule !== 'heuristic:review-only',
    '含「fix」不應匹配 review-only，實際: ' + (r ? r.matchedRule : 'null'));
});

// ─── Part 1b-6: question heuristic 擴充 (任務 2.5 + 2.6) ──

console.log('\n🧪 Part 1b-6: question heuristic 擴充');
console.log('═'.repeat(50));

test('question 擴充：能否 → none（新增疑問句型）', () => {
  const r = classifyByHeuristic('能否說明這個設計的優缺點');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

test('question 擴充：可以 → none（新增疑問句型）', () => {
  const r = classifyByHeuristic('可以解釋一下 DAG 的工作原理嗎');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

test('question 擴充：有沒有 → none（新增疑問句型）', () => {
  const r = classifyByHeuristic('有沒有更好的方式處理這個問題');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

test('question 擴充：是否 → none（新增疑問句型）', () => {
  const r = classifyByHeuristic('是否需要更新文件');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

test('question 擴充：含檔案路徑的「能否」不匹配', () => {
  // 含檔案路徑 → FILE_PATH_PATTERN 排除，即使有疑問詞也不走 question
  const r = classifyByHeuristic('能否確認 plugins/vibe/scripts/lib/flow/classifier.js 的邏輯');
  assert.ok(!r || r.matchedRule !== 'heuristic:question',
    '含檔案路徑不應匹配 question，實際: ' + (r ? r.matchedRule : 'null'));
});

test('question 回歸：? 結尾仍正常匹配（回歸驗證）', () => {
  const r = classifyByHeuristic('什麼是 pipeline?');
  assert.ok(r);
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
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

asyncTest('Fallback: 疑問句 → none/heuristic', async () => {
  const result = await classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none');
  // Layer 1.5 heuristic 的 question 規則偵測疑問句
  assert.strictEqual(result.source, 'heuristic');
});

// ─── Part 1d: buildPipelineCatalogHint ──────────

console.log('\n🧪 Part 1d: buildPipelineCatalogHint');
console.log('═'.repeat(50));

test('buildPipelineCatalogHint: 回傳非空字串', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(typeof hint === 'string');
  assert.ok(hint.length > 0);
});

test('buildPipelineCatalogHint: 包含 [pipeline:xxx] 語法', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(hint.includes('[pipeline:'), '應包含 [pipeline: 語法');
});

test('buildPipelineCatalogHint: 無參數時包含最常用的 5 個 pipeline', () => {
  const hint = buildPipelineCatalogHint();
  // 無參數時回傳最常用的 5 個（PRIORITY_ORDER 前 5 個：quick-dev, standard, fix, full, test-first）
  const top5 = ['quick-dev', 'standard', 'fix', 'full', 'test-first'];
  for (const id of top5) {
    assert.ok(hint.includes(`[pipeline:${id}]`), `應包含 [pipeline:${id}]`);
  }
  // 並且不超過 5 個（counting [pipeline:xxx] 出現次數）
  const matches = (hint.match(/\[pipeline:[a-z-]+\]/g) || []).length;
  assert.ok(matches <= 5, `不應超過 5 個 pipeline，實際: ${matches}`);
  // 應包含 fallback 提示
  assert.ok(hint.includes('/vibe:pipeline'), '應包含完整清單提示');
});

test('buildPipelineCatalogHint: 有 pipelineId 時回傳相鄰 pipeline 並排除自身', () => {
  const hint = buildPipelineCatalogHint('quick-dev');
  // quick-dev 在 PRIORITY_ORDER index=0，相鄰窗口後排除自身
  assert.ok(!hint.includes('[pipeline:quick-dev]'), '不應包含 quick-dev 自身');
  // 應包含相鄰的 pipeline（standard 在 index=1）
  assert.ok(hint.includes('[pipeline:standard]'), '應包含相鄰的 standard');
  // 不超過 5 個
  const matches = (hint.match(/\[pipeline:[a-z-]+\]/g) || []).length;
  assert.ok(matches <= 5, `不應超過 5 個 pipeline，實際: ${matches}`);
});

test('buildPipelineCatalogHint: 有中間 pipelineId 時排除自身', () => {
  // standard 在 PRIORITY_ORDER index=1，相鄰窗口為 [quick-dev, standard, fix, full]
  // 排除自身 standard 後應為 [quick-dev, fix, full]
  const hint = buildPipelineCatalogHint('standard');
  assert.ok(!hint.includes('[pipeline:standard]'), '不應包含 standard 自身');
  assert.ok(hint.includes('[pipeline:quick-dev]'), '應包含相鄰的 quick-dev');
  assert.ok(hint.includes('[pipeline:fix]'), '應包含相鄰的 fix');
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
    assert.ok(parsed.systemMessage.includes('Pipeline 自主分類'), 'systemMessage 應包含分類指令');
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

// ─── Part 5: Spec 驗收條件 — SYSTEM_MARKER 規格場景（P4 獨立驗證）──

console.log('\n🧪 Part 5: SYSTEM_MARKER 規格場景（P4 獨立驗證）');
console.log('═'.repeat(50));

// classifier spec: SYSTEM_MARKER 在 prompt 中間也被偵測
test('SYSTEM_MARKER 在 prompt 中間也能被偵測', () => {
  const r = classifyByHeuristic('一些前綴文字 <!-- VIBE_SYSTEM --> 一些後綴文字');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

// classifier spec: SYSTEM_MARKER 優先於 review-only
test('SYSTEM_MARKER 優先於 review-only 規則', () => {
  // prompt 同時匹配 system-feedback（SYSTEM_MARKER）和 review-only（含「review」）
  // system-feedback 應優先
  const r = classifyByHeuristic('<!-- VIBE_SYSTEM --> review 一下 auth 模組');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback', 'SYSTEM_MARKER 應優先於 review-only');
  assert.strictEqual(r.pipeline, 'none');
});

// hooks spec: pipeline-check reason 含 SYSTEM_MARKER
test('pipeline-check.js 引用 SYSTEM_MARKER 常數（非硬編碼）', () => {
  const pcContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'pipeline-check.js'), 'utf8'
  );
  // 應從 classifier.js require SYSTEM_MARKER
  assert.ok(pcContent.includes('classifier.js'), 'pipeline-check 應 require classifier.js');
  assert.ok(pcContent.includes('SYSTEM_MARKER'), 'pipeline-check 應使用 SYSTEM_MARKER 常數');
  // 不應有硬編碼的 <!-- VIBE_SYSTEM --> 字串
  const withoutComment = pcContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!withoutComment.includes('<!-- VIBE_SYSTEM -->'), 'pipeline-check 不應硬編碼標記字串（DRY）');
});

// hooks spec: task-guard systemMessage 含 SYSTEM_MARKER（常數來源統一）
test('task-guard.js 引用 SYSTEM_MARKER 常數（非硬編碼）', () => {
  const tgContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'task-guard.js'), 'utf8'
  );
  // 應從 classifier.js require SYSTEM_MARKER
  assert.ok(tgContent.includes('classifier.js'), 'task-guard 應 require classifier.js');
  assert.ok(tgContent.includes('SYSTEM_MARKER'), 'task-guard 應使用 SYSTEM_MARKER 常數');
  // 不應有硬編碼的 <!-- VIBE_SYSTEM --> 字串
  const withoutComment = tgContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!withoutComment.includes('<!-- VIBE_SYSTEM -->'), 'task-guard 不應硬編碼標記字串（DRY）');
});

// hooks spec: pipeline-check reason 格式為 SYSTEM_MARKER + 原有內容
// 此測試透過直接讀取原始碼確認格式（子行程測試需要特定 pipeline state）
test('pipeline-check reason 格式：SYSTEM_MARKER 前綴 + systemMessage', () => {
  const pcContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'pipeline-check.js'), 'utf8'
  );
  // reason 組合格式：`${SYSTEM_MARKER}${result.systemMessage}`
  assert.ok(
    pcContent.includes('`${SYSTEM_MARKER}${result.systemMessage}`') ||
    pcContent.includes("SYSTEM_MARKER + result.systemMessage") ||
    pcContent.includes('reason: `${SYSTEM_MARKER}'),
    'pipeline-check reason 應以 SYSTEM_MARKER 為前綴'
  );
});

// hooks spec: task-guard 兩個輸出路徑都含 SYSTEM_MARKER
test('task-guard 阻擋路徑 systemMessage 含 SYSTEM_MARKER 前綴', () => {
  const tgContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'hooks', 'task-guard.js'), 'utf8'
  );
  // 找到阻擋輸出的 systemMessage 賦值模式
  // 確認兩處 systemMessage（安全閥 + 正常阻擋）都有 SYSTEM_MARKER
  const systemMessageMatches = tgContent.match(/systemMessage:.*SYSTEM_MARKER/g) || [];
  assert.ok(systemMessageMatches.length >= 2, `task-guard 應有至少 2 處 systemMessage 含 SYSTEM_MARKER，實際: ${systemMessageMatches.length}`);
});

// ─── Part 5b: question heuristic 擴充 — 新 Scenario ──

console.log('\n🧪 Part 5b: question heuristic 擴充場景（spec 獨立驗證）');
console.log('═'.repeat(50));

// spec: 「是不是 bug」分類為 none（question）
test('question: 是不是 bug → none（是否/是不是 句型）', () => {
  const r = classifyByHeuristic('是不是 bug');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

// spec: 「有沒有辦法加速 CI」→ question（不含檔案路徑）
test('question: 有沒有辦法加速 CI → none（有沒有 句型）', () => {
  const r = classifyByHeuristic('有沒有辦法加速 CI');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

// spec: 「是否需要更新 registry」→ none（是否 句型，不含檔案路徑）
test('question: 是否需要更新 registry → none（是否 句型）', () => {
  const r = classifyByHeuristic('是否需要更新 registry');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:question');
});

// ─── Part 5c: review-only spec 場景 ──────────────

console.log('\n🧪 Part 5c: review-only spec 場景（獨立驗證）');
console.log('═'.repeat(50));

// spec: 「review 這段程式碼」→ review-only
test('review-only: review 這段程式碼 → review-only', () => {
  const r = classifyByHeuristic('review 這段程式碼');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

// spec: 「審查最近的變更」→ review-only
test('review-only: 審查最近的變更 → review-only', () => {
  const r = classifyByHeuristic('審查最近的變更');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

// spec: 「review 後修復問題」→ 不是 review-only（含「修復」）
test('review-only 負面排除: review 後修復問題 → 不匹配 review-only', () => {
  const r = classifyByHeuristic('review 後修復問題');
  const notReviewOnly = !r || r.matchedRule !== 'heuristic:review-only';
  assert.ok(notReviewOnly, `含「修復」的 review prompt 不應匹配 review-only，實際: ${r ? r.matchedRule : 'null'}`);
});

// spec: 「code review」→ review-only
test('review-only: code review → review-only', () => {
  const r = classifyByHeuristic('code review');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'review-only');
  assert.strictEqual(r.matchedRule, 'heuristic:review-only');
});

// spec: HEURISTIC_RULES 順序 — system-feedback 在 question 前面（question 的 review 疑問不被 review-only 優先）
test('HEURISTIC_RULES 順序: 什麼是 review？→ question（非 review-only）', () => {
  const r = classifyByHeuristic('什麼是 review？');
  // 「什麼是」是疑問詞 → question 先匹配
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.matchedRule, 'heuristic:question', '疑問詞 question 規則應優先於 review-only');
});

// ─── Part 5d: system-feedback 背景任務通知模式 ──

console.log('\n🧪 Part 5d: system-feedback 背景任務通知模式');
console.log('═'.repeat(50));

// system-feedback 的第 3 條規則：英文 background task 通知
test('system-feedback: "Background task completed" → none', () => {
  const r = classifyByHeuristic('Background task completed successfully');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('system-feedback: "Task xxx completed" → none', () => {
  const r = classifyByHeuristic('Task npm-build completed');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('system-feedback: "Result from agent" → none', () => {
  const r = classifyByHeuristic('Result from vibe:tester: PASS');
  assert.ok(r, '應有匹配結果');
  assert.strictEqual(r.pipeline, 'none');
  assert.strictEqual(r.matchedRule, 'heuristic:system-feedback');
});

test('system-feedback: 普通英文句子不被誤攔', () => {
  const r = classifyByHeuristic('fix the failing authentication test');
  // 這應該走 bugfix，不是 system-feedback
  assert.ok(!r || r.matchedRule !== 'heuristic:system-feedback',
    '普通 fix 句子不應匹配 system-feedback，實際: ' + (r ? r.matchedRule : 'null'));
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
