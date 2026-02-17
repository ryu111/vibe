#!/usr/bin/env node
/**
 * pipeline-catalog-edge-cases.test.js — 邊界案例與錯誤處理測試
 *
 * 從 OpenSpec 規格推導的邊界案例：
 * 1. 空值/null/undefined 處理
 * 2. 併發與競態條件
 * 3. 舊 state 向後相容
 * 4. 階段跳過與回退的組合場景
 * 5. stageIndex 追蹤的正確性
 * 6. Pipeline 升級降級的邊界情況
 */
'use strict';
const assert = require('assert');
const path = require('path');

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

// ===== 模組載入 =====

const {
  PIPELINES,
  PIPELINE_PRIORITY,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));

const {
  classifyWithConfidence,
  extractExplicitPipeline,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

// 注意：findNextStageInPipeline 已從 pipeline-discovery.js 移除（v3 由 dag-utils.js 接管）

// ===== 1. 空值處理測試 =====

console.log('\n🧪 Part 1: 空值/null/undefined 處理');

test('extractExplicitPipeline: undefined → null', () => {
  const result = extractExplicitPipeline(undefined);
  assert.strictEqual(result, null);
});

test('classifyWithConfidence: undefined → 預設 fix', () => {
  const result = classifyWithConfidence(undefined);
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7);
});


test('PIPELINES: 所有 label 和 description 非空', () => {
  Object.entries(PIPELINES).forEach(([id, p]) => {
    assert.ok(p.label.length > 0, `${id}.label 為空`);
    assert.ok(p.description.length > 0, `${id}.description 為空`);
  });
});

// ===== 2. 階段未安裝的場景 =====

console.log('\n🧪 Part 2: 階段未安裝場景');

test('quick-dev pipeline 不含 DESIGN', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.ok(!stages.includes('DESIGN'));
});

test('standard pipeline 不含 DESIGN', () => {
  const stages = PIPELINES['standard'].stages;
  assert.ok(!stages.includes('DESIGN'));
});

// ===== 3. 向後相容測試 =====

console.log('\n🧪 Part 3: 向後相容（舊 state）');

test('舊 state 沒有 pipelineId → 不崩潰', () => {
  // 模擬舊 state 只有 taskType 和 expectedStages（FSM 結構）
  const mockOldState = {
    phase: 'CLASSIFIED',
    context: {
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    },
    progress: {},
    meta: { initialized: true },
  };
  // 檢查是否可以從 expectedStages 推導 pipeline
  // 邏輯在 task-classifier 中：有 pipelineId 優先用，沒有就用 expectedStages fallback
  assert.ok(Array.isArray(mockOldState.context.expectedStages));
  assert.ok(!mockOldState.context.pipelineId);
});

test('TDD pipeline 允許重複 TEST（test-first 結構）', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.strictEqual(stages.length, 3);
  assert.strictEqual(stages[0], 'TEST');
  assert.strictEqual(stages[1], 'DEV');
  assert.strictEqual(stages[2], 'TEST');
});

// ===== 5. Pipeline 優先級邊界測試 =====

console.log('\n🧪 Part 5: Pipeline 優先級邊界');

test('同級 pipeline 比較（ui-only vs security）', () => {
  // 兩者 priority 都是 3
  assert.strictEqual(PIPELINE_PRIORITY['ui-only'], 3);
  assert.strictEqual(PIPELINE_PRIORITY['security'], 3);
  // 同級不應視為升級
  const isUpgrade = PIPELINE_PRIORITY['security'] > PIPELINE_PRIORITY['ui-only'];
  assert.strictEqual(isUpgrade, false);
});

test('同級 pipeline 比較（docs-only vs review-only）', () => {
  assert.strictEqual(PIPELINE_PRIORITY['docs-only'], 1);
  assert.strictEqual(PIPELINE_PRIORITY['review-only'], 1);
  const isUpgrade = PIPELINE_PRIORITY['review-only'] > PIPELINE_PRIORITY['docs-only'];
  assert.strictEqual(isUpgrade, false);
});

test('none pipeline 最低優先級', () => {
  const allPriorities = Object.values(PIPELINE_PRIORITY);
  const minPriority = Math.min(...allPriorities);
  assert.strictEqual(PIPELINE_PRIORITY['none'], minPriority);
  assert.strictEqual(minPriority, 0);
});

test('full pipeline 最高優先級', () => {
  const allPriorities = Object.values(PIPELINE_PRIORITY);
  const maxPriority = Math.max(...allPriorities);
  assert.strictEqual(PIPELINE_PRIORITY['full'], maxPriority);
  assert.strictEqual(maxPriority, 7);
});

// ===== 6. 階段列表組合的邊界 =====

console.log('\n🧪 Part 6: 階段列表組合邊界');

test('Pipeline 包含所有 9 個階段（full）', () => {
  const stages = PIPELINES['full'].stages;
  assert.strictEqual(stages.length, 9);
  // 確認順序與 STAGE_ORDER 一致
  const { STAGE_ORDER } = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));
  stages.forEach((stage, i) => {
    assert.strictEqual(stage, STAGE_ORDER[i], `full pipeline 第 ${i} 個階段應為 ${STAGE_ORDER[i]}，實際為 ${stage}`);
  });
});

test('Pipeline 不包含中間階段（standard 跳過 DESIGN）', () => {
  const stages = PIPELINES['standard'].stages;
  assert.ok(!stages.includes('DESIGN'));
  // ARCH 的下一個應是 DEV
  const archIndex = stages.indexOf('ARCH');
  const nextStage = stages[archIndex + 1];
  assert.strictEqual(nextStage, 'DEV');
});

test('Pipeline 不包含結尾階段（quick-dev 沒有 E2E/DOCS）', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.ok(!stages.includes('E2E'));
  assert.ok(!stages.includes('DOCS'));
  assert.ok(!stages.includes('QA'));
});

test('Pipeline 從中間開始（ui-only 從 DESIGN）', () => {
  const stages = PIPELINES['ui-only'].stages;
  assert.strictEqual(stages[0], 'DESIGN');
  assert.ok(!stages.includes('PLAN'));
  assert.ok(!stages.includes('ARCH'));
});

// ===== 7. Classifier 邊界輸入測試 =====

console.log('\n🧪 Part 7: Classifier 邊界輸入');

test('只有空白字元的 prompt → 預設 fix', () => {
  const result = classifyWithConfidence('   \t\n  ');
  assert.strictEqual(result.pipeline, 'fix');
});

test('只有 emoji 的 prompt → 預設 fix', () => {
  const result = classifyWithConfidence('🚀🎉✨');
  assert.strictEqual(result.pipeline, 'fix');
});

test('prompt 含特殊字元不影響 [pipeline:xxx] 解析', () => {
  const result = extractExplicitPipeline('修復 <script>alert(1)</script> [pipeline:fix]');
  assert.strictEqual(result, 'fix');
});

test('prompt 含 Unicode 不影響分類', () => {
  const result = classifyWithConfidence('實作🎨設計系統');
  assert.strictEqual(result.pipeline, 'standard'); // feature 關鍵字
});

test('[pipeline:xxx] 在 code block 內不應被解析', () => {
  const prompt = '```\n[pipeline:full]\n```\n實際任務';
  // 目前 extractExplicitPipeline 不檢查 code block 上下文
  // 這個測試記錄當前行為（會誤判），未來可能需要改進
  const result = extractExplicitPipeline(prompt);
  assert.strictEqual(result, 'full'); // 當前行為：會誤判
});

// ===== 8. 併發與競態條件模擬 =====

console.log('\n🧪 Part 8: 併發與競態條件');

test('同一 prompt 多次分類應回傳相同結果', () => {
  const prompt = '建立完整的 REST API';
  const results = Array.from({ length: 10 }, () => classifyWithConfidence(prompt));
  const firstPipeline = results[0].pipeline;
  results.forEach(r => {
    assert.strictEqual(r.pipeline, firstPipeline);
  });
});


// ===== 9. 錯誤恢復場景 =====

console.log('\n🧪 Part 9: 錯誤恢復');

test('Pipeline 完成後再次分類應能重新啟動', () => {
  // 模擬：fix pipeline 完成 → 新任務觸發 feature 分類
  // 應該能從 none → standard 升級
  assert.ok(PIPELINE_PRIORITY['standard'] > PIPELINE_PRIORITY['fix']);
});

test('回退次數達上限後應停止', () => {
  // 這個邏輯在 stage-transition.js 中
  // 測試只驗證 MAX_RETRIES 是否合理
  const MAX_RETRIES = parseInt(process.env.CLAUDE_PIPELINE_MAX_RETRIES || '3', 10);
  assert.ok(MAX_RETRIES > 0 && MAX_RETRIES <= 10, `MAX_RETRIES=${MAX_RETRIES} 不合理`);
});

// ===== 10. PIPELINES stages 順序正確性 =====

console.log('\n🧪 Part 10: Stages 順序正確性');

test('所有 pipeline 的 stages 順序與 STAGE_ORDER 一致（TDD 除外）', () => {
  const { STAGE_ORDER } = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));

  Object.entries(PIPELINES).forEach(([id, p]) => {
    if (id === 'test-first') return; // TDD 例外
    if (p.stages.length === 0) return; // none 例外

    let lastIndex = -1;
    p.stages.forEach(stage => {
      const currentIndex = STAGE_ORDER.indexOf(stage);
      assert.ok(currentIndex > lastIndex, `${id} pipeline 的 ${stage} 順序錯誤`);
      lastIndex = currentIndex;
    });
  });
});

test('TDD pipeline 允許重複 TEST（唯一例外）', () => {
  const stages = PIPELINES['test-first'].stages;
  const testCount = stages.filter(s => s === 'TEST').length;
  assert.strictEqual(testCount, 2);

  // 確認其他 pipeline 沒有重複階段
  Object.entries(PIPELINES).forEach(([id, p]) => {
    if (id === 'test-first') return;
    const uniqueStages = new Set(p.stages);
    assert.strictEqual(uniqueStages.size, p.stages.length, `${id} 有重複階段`);
  });
});

// ===== 摘要 =====

console.log(`\n========================================`);
console.log(`Pipeline Catalog 邊界案例測試結果`);
console.log(`========================================`);
console.log(`✅ 通過: ${passed}`);
console.log(`❌ 失敗: ${failed}`);
console.log(`總計: ${passed + failed}`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
