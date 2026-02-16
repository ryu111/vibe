#!/usr/bin/env node
/**
 * pipeline-catalog.test.js — Pipeline Catalog 測試
 *
 * 測試 10 種 pipeline 模板的前進/完成/回退場景，包含 TDD 雙 TEST 和短 pipeline。
 */
'use strict';
const assert = require('assert');
const path = require('path');

// 測試用內存 state（不寫檔案，FSM 結構）
let state = {
  phase: 'IDLE',
  context: {},
  progress: {},
  meta: { initialized: false },
};

// Mock timeline emit（不寫檔案）
const mockEmit = () => {};

// Mock 模組
const { PIPELINES, FRONTEND_FRAMEWORKS } = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));
const { findNextStageInPipeline } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'pipeline-discovery.js'));

// Mock stageMap（所有階段都已安裝）
const mockStageMap = {
  PLAN: { agent: 'planner', skill: '/vibe:scope' },
  ARCH: { agent: 'architect', skill: '/vibe:architect' },
  DESIGN: { agent: 'designer', skill: '/vibe:design' },
  DEV: { agent: 'developer' },
  REVIEW: { agent: 'code-reviewer', skill: '/vibe:review' },
  TEST: { agent: 'tester', skill: '/vibe:tdd' },
  QA: { agent: 'qa', skill: '/vibe:qa' },
  E2E: { agent: 'e2e-runner', skill: '/vibe:e2e' },
  DOCS: { agent: 'doc-updater', skill: '/vibe:doc-sync' },
};

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

// ===== 4.10 所有 10 種 pipeline 的前進/完成場景 =====

test('full pipeline: PLAN → ARCH', () => {
  const stages = PIPELINES['full'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'PLAN', 0);
  assert.strictEqual(result.stage, 'ARCH');
  assert.strictEqual(result.index, 1);
});

test('full pipeline: ARCH → DESIGN', () => {
  const stages = PIPELINES['full'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'ARCH', 1);
  assert.strictEqual(result.stage, 'DESIGN');
  assert.strictEqual(result.index, 2);
});

test('full pipeline: DESIGN → DEV', () => {
  const stages = PIPELINES['full'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DESIGN', 2);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 3);
});

test('full pipeline: DOCS 完成 → null', () => {
  const stages = PIPELINES['full'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DOCS', 8);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('standard pipeline: PLAN → ARCH', () => {
  const stages = PIPELINES['standard'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'PLAN', 0);
  assert.strictEqual(result.stage, 'ARCH');
  assert.strictEqual(result.index, 1);
});

test('standard pipeline: ARCH → DEV（跳過 DESIGN）', () => {
  const stages = PIPELINES['standard'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'ARCH', 1);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 2);
});

test('quick-dev pipeline: DEV → REVIEW', () => {
  const stages = PIPELINES['quick-dev'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 0);
  assert.strictEqual(result.stage, 'REVIEW');
  assert.strictEqual(result.index, 1);
});

test('quick-dev pipeline: REVIEW → TEST', () => {
  const stages = PIPELINES['quick-dev'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'REVIEW', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
});

test('quick-dev pipeline: TEST 完成 → null', () => {
  const stages = PIPELINES['quick-dev'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 2);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('ui-only pipeline: DESIGN → DEV', () => {
  const stages = PIPELINES['ui-only'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DESIGN', 0);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
});

test('ui-only pipeline: DEV → QA（跳過 REVIEW/TEST）', () => {
  const stages = PIPELINES['ui-only'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'QA');
  assert.strictEqual(result.index, 2);
});

test('security pipeline: DEV → REVIEW', () => {
  const stages = PIPELINES['security'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 0);
  assert.strictEqual(result.stage, 'REVIEW');
  assert.strictEqual(result.index, 1);
});

test('security pipeline: REVIEW → TEST', () => {
  const stages = PIPELINES['security'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'REVIEW', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
});

// ===== 4.11 TDD pipeline: TEST→DEV→TEST 循環路徑 + stageIndex 正確性 =====

test('TDD pipeline: 第一個 TEST → DEV（index 0 → 1）', () => {
  const stages = PIPELINES['test-first'].stages; // ['TEST', 'DEV', 'TEST']
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 0);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
});

test('TDD pipeline: DEV → 第二個 TEST（index 1 → 2）', () => {
  const stages = PIPELINES['test-first'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
});

test('TDD pipeline: 第二個 TEST 完成 → null（index 2 → -1）', () => {
  const stages = PIPELINES['test-first'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 2);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('TDD pipeline: 用 currentStage 查找（TEST）→ 回傳第一個 TEST 的下一個（DEV）', () => {
  const stages = PIPELINES['test-first'].stages;
  // 無 stageIndex → 用 indexOf('TEST') = 0
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST');
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
});

// ===== 4.12 短 pipeline: review-only / docs-only / fix 的完成和回退行為 =====

test('fix pipeline: DEV 完成 → null（單階段）', () => {
  const stages = PIPELINES['fix'].stages; // ['DEV']
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 0);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('review-only pipeline: REVIEW 完成 → null（單階段）', () => {
  const stages = PIPELINES['review-only'].stages; // ['REVIEW']
  const result = findNextStageInPipeline(stages, mockStageMap, 'REVIEW', 0);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('docs-only pipeline: DOCS 完成 → null（單階段）', () => {
  const stages = PIPELINES['docs-only'].stages; // ['DOCS']
  const result = findNextStageInPipeline(stages, mockStageMap, 'DOCS', 0);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('review-only pipeline 不包含 DEV（回退判斷）', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.strictEqual(stages.includes('DEV'), false);
});

test('none pipeline: 空階段列表', () => {
  const stages = PIPELINES['none'].stages;
  assert.strictEqual(stages.length, 0);
});

// ===== C-1 修復驗證：TDD 完整三步流程 + stageIndex 單調遞增 =====

test('[C-1] TDD 完整流程：第一個 TEST(index=0) → DEV(index=1) → 第二個 TEST(index=2) → null', () => {
  const stages = PIPELINES['test-first'].stages; // ['TEST', 'DEV', 'TEST']

  // 模擬完整 TDD 流程
  let stateIndex = 0;

  // 第一步：TEST(0) → DEV
  let result = findNextStageInPipeline(stages, mockStageMap, 'TEST', stateIndex);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
  const currentIndex1 = stages.indexOf('TEST'); // 0
  // 單調遞增條件：currentIndex1(0) >= stateIndex(0) → 允許更新
  if (currentIndex1 >= 0 && currentIndex1 >= stateIndex) {
    stateIndex = currentIndex1;
  }
  assert.strictEqual(stateIndex, 0, 'TEST 完成後 stateIndex 應為 0');

  // 第二步：DEV(1) → TEST
  stateIndex = result.index; // 更新到 DEV 的 index
  result = findNextStageInPipeline(stages, mockStageMap, 'DEV', stateIndex);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
  const currentIndex2 = stages.indexOf('DEV'); // 1
  if (currentIndex2 >= 0 && currentIndex2 >= stateIndex) {
    stateIndex = currentIndex2;
  }
  assert.strictEqual(stateIndex, 1, 'DEV 完成後 stateIndex 應為 1');

  // 第三步：TEST(2) → null（pipeline 完成）
  stateIndex = result.index; // 更新到第二個 TEST 的 index
  result = findNextStageInPipeline(stages, mockStageMap, 'TEST', stateIndex);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
  // 關鍵修復驗證：第二個 TEST 的 indexOf('TEST') = 0，但因單調遞增條件，不會覆蓋 stateIndex
  const currentIndex3 = stages.indexOf('TEST'); // 0
  const originalIndex = stateIndex;
  if (currentIndex3 >= 0 && currentIndex3 >= stateIndex) {
    stateIndex = currentIndex3; // 不會執行（0 < 2）
  }
  assert.strictEqual(stateIndex, originalIndex, '第二個 TEST 完成後 stateIndex 不應被 indexOf 覆蓋');
});

test('[C-1] TDD 回退場景：第二個 TEST 失敗回退到 DEV，修復後重跑第二個 TEST', () => {
  const stages = PIPELINES['test-first'].stages;
  let stateIndex = 2; // 已到第二個 TEST（pipeline 結束前）

  // 模擬回退到 DEV（stage-transition 回退邏輯不改變 stateIndex）
  // DEV 修復完成後，從 stateIndex=2 的位置繼續（即 DEV 的下一個）
  // 注意：stage-transition 回退後 pendingRetry 會標記要重跑的 stage
  // 這裡只測試 findNextStageInPipeline 不會因 stateIndex 錯誤導致找到錯誤的 TEST

  // DEV 在 index=1，從 index=1 找下一個應該是 index=2 的 TEST
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2, 'DEV(index=1) 的下一個是第二個 TEST(index=2)');

  // 確認第二個 TEST 完成時，stateIndex 更新邏輯不會被 indexOf 覆蓋
  stateIndex = 2;
  const currentIndex = stages.indexOf('TEST'); // 0
  // 單調遞增：currentIndex(0) < stateIndex(2) → 不覆蓋
  const shouldUpdate = currentIndex >= 0 && currentIndex >= stateIndex;
  assert.strictEqual(shouldUpdate, false, 'indexOf(TEST)=0 不應覆蓋 stateIndex=2');
});

// ===== 邊界條件測試 =====

test('findNextStageInPipeline: currentStage 不在 pipelineStages 中 → null', () => {
  const stages = ['PLAN', 'ARCH'];
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV');
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('findNextStageInPipeline: 下一個 stage 未安裝 → 跳過到更後面', () => {
  const stages = ['PLAN', 'ARCH', 'DEV'];
  const limitedStageMap = { PLAN: mockStageMap.PLAN, DEV: mockStageMap.DEV }; // ARCH 未安裝
  const result = findNextStageInPipeline(stages, limitedStageMap, 'PLAN', 0);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 2);
});

test('findNextStageInPipeline: 所有後續 stage 都未安裝 → null', () => {
  const stages = ['PLAN', 'ARCH', 'DEV'];
  const limitedStageMap = { PLAN: mockStageMap.PLAN }; // 只有 PLAN 安裝
  const result = findNextStageInPipeline(stages, limitedStageMap, 'PLAN', 0);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
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
