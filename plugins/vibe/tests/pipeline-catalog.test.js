#!/usr/bin/env node
/**
 * pipeline-catalog.test.js — Pipeline Catalog 測試
 *
 * 測試 10 種 pipeline 模板的結構正確性與 PIPELINES 常量。
 * 注意：findNextStageInPipeline 已從 pipeline-discovery.js 移除（v3 由 dag-utils.js 接管）。
 */
'use strict';
const assert = require('assert');
const path = require('path');

// Mock 模組
const { PIPELINES, FRONTEND_FRAMEWORKS } = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));

// 測試計數器
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

// ===== 10 種 pipeline 的結構與內容正確性 =====

test('full pipeline 包含所有 9 個階段', () => {
  const stages = PIPELINES['full'].stages;
  assert.deepStrictEqual(stages, ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']);
});

test('standard pipeline 包含 6 個階段（跳過 DESIGN/QA/E2E）', () => {
  const stages = PIPELINES['standard'].stages;
  assert.deepStrictEqual(stages, ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS']);
});

test('quick-dev pipeline 包含 3 個階段', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

test('fix pipeline 只有 DEV', () => {
  const stages = PIPELINES['fix'].stages;
  assert.deepStrictEqual(stages, ['DEV']);
});

test('test-first pipeline：TDD 語意化後綴結構', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.deepStrictEqual(stages, ['TEST', 'DEV', 'TEST:verify']);
});

test('ui-only pipeline 包含 3 個階段', () => {
  const stages = PIPELINES['ui-only'].stages;
  assert.deepStrictEqual(stages, ['DESIGN', 'DEV', 'QA']);
});

test('review-only pipeline 只有 REVIEW', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.deepStrictEqual(stages, ['REVIEW']);
});

test('docs-only pipeline 只有 DOCS', () => {
  const stages = PIPELINES['docs-only'].stages;
  assert.deepStrictEqual(stages, ['DOCS']);
});

test('security pipeline 包含 3 個階段', () => {
  const stages = PIPELINES['security'].stages;
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

test('none pipeline: 空階段列表', () => {
  const stages = PIPELINES['none'].stages;
  assert.strictEqual(stages.length, 0);
});

// ===== enforced 屬性 =====

test('review-only pipeline 不包含 DEV（回退判斷）', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.strictEqual(stages.includes('DEV'), false);
});

test('所有有階段的 pipeline 均為 enforced', () => {
  const enforced = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security'];
  enforced.forEach(id => {
    assert.strictEqual(PIPELINES[id].enforced, true, `${id} 應為 enforced`);
  });
});

test('none pipeline 不強制', () => {
  assert.strictEqual(PIPELINES['none'].enforced, false);
});

// ===== TDD 雙 TEST 結構驗證 =====

test('TDD pipeline 含 TEST:verify 語意化後綴', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.ok(stages.includes('TEST:verify'),
    `test-first 應含 TEST:verify，實際：${JSON.stringify(stages)}`);
});

test('TDD pipeline DEV 出現一次', () => {
  const stages = PIPELINES['test-first'].stages;
  const devCount = stages.filter(s => s === 'DEV').length;
  assert.strictEqual(devCount, 1);
});

// ===== 摘要 =====
console.log(`\n========================================`);
console.log(`Pipeline Catalog 測試結果`);
console.log(`========================================`);
console.log(`✅ 通過: ${passed}`);
console.log(`❌ 失敗: ${failed}`);
console.log(`總計: ${passed + failed}`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
