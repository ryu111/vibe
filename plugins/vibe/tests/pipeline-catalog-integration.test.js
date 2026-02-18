#!/usr/bin/env node
/**
 * pipeline-catalog-integration.test.js — Pipeline Catalog 整合測試
 *
 * 測試分類器→初始化→前進→完成的完整流程，涵蓋：
 * 1. registry.js PIPELINES/PRIORITY/TASKTYPE 映射正確性
 * 2. classifyWithConfidence Layer 1 顯式覆寫
 * 3. classify() 向後相容
 * 4. Pipeline 子集前進路徑
 * 5. TDD/單階段/回退場景
 * 6. 注入防護/邊界值
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

const asyncQueue = [];
function asyncTest(name, fn) {
  asyncQueue.push({ name, fn });
}

// ===== 模組載入 =====

const {
  PIPELINES,
  PIPELINE_PRIORITY,
  TASKTYPE_TO_PIPELINE,
  PIPELINE_TO_TASKTYPE,
  FRONTEND_FRAMEWORKS,
  STAGE_ORDER,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));

const {
  classifyWithConfidence,
  extractExplicitPipeline,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

// ===== 1. Registry 常量正確性測試 =====

console.log('\n🧪 Part 1: Registry 常量正確性');

test('PIPELINES 包含 10 種 pipeline', () => {
  const ids = Object.keys(PIPELINES);
  assert.strictEqual(ids.length, 10);
  const expected = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security', 'none'];
  expected.forEach(id => {
    assert.ok(ids.includes(id), `缺少 pipeline: ${id}`);
  });
});

test('每個 pipeline 有 stages/enforced/label/description 欄位', () => {
  Object.entries(PIPELINES).forEach(([id, p]) => {
    assert.ok(Array.isArray(p.stages), `${id}.stages 不是陣列`);
    assert.strictEqual(typeof p.enforced, 'boolean', `${id}.enforced 不是布林值`);
    assert.strictEqual(typeof p.label, 'string', `${id}.label 不是字串`);
    assert.strictEqual(typeof p.description, 'string', `${id}.description 不是字串`);
  });
});

test('所有 pipeline 的 stages 是 STAGE_ORDER 子集', () => {
  Object.entries(PIPELINES).forEach(([id, p]) => {
    p.stages.forEach(stage => {
      assert.ok(STAGE_ORDER.includes(stage), `${id} 包含非法 stage: ${stage}`);
    });
  });
});

test('TDD pipeline 包含重複 TEST', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.deepStrictEqual(stages, ['TEST', 'DEV', 'TEST']);
});

test('PIPELINE_PRIORITY 升級路徑正確', () => {
  assert.ok(PIPELINE_PRIORITY['full'] > PIPELINE_PRIORITY['standard']);
  assert.ok(PIPELINE_PRIORITY['standard'] > PIPELINE_PRIORITY['quick-dev']);
  assert.ok(PIPELINE_PRIORITY['quick-dev'] > PIPELINE_PRIORITY['fix']);
  assert.ok(PIPELINE_PRIORITY['fix'] > PIPELINE_PRIORITY['none']);
});

test('只有 none 不 enforce', () => {
  Object.entries(PIPELINES).forEach(([id, p]) => {
    if (id === 'none') {
      assert.strictEqual(p.enforced, false, 'none 不應 enforce');
    } else {
      assert.strictEqual(p.enforced, true, `${id} 應 enforce`);
    }
  });
});

test('TASKTYPE_TO_PIPELINE 所有 7 種 taskType 有對應', () => {
  const types = ['research', 'quickfix', 'bugfix', 'feature', 'refactor', 'test', 'tdd'];
  types.forEach(type => {
    const pipelineId = TASKTYPE_TO_PIPELINE[type];
    assert.ok(PIPELINES[pipelineId], `taskType ${type} 對應到不存在的 pipeline: ${pipelineId}`);
  });
});

// ===== 2. Classifier Layer 1 顯式覆寫測試 =====

console.log('\n🧪 Part 2: Classifier Layer 1 顯式覆寫');

test('extractExplicitPipeline: 正常解析', () => {
  const result = extractExplicitPipeline('修復認證 [pipeline:security] 很急');
  assert.strictEqual(result, 'security');
});

test('extractExplicitPipeline: 無標記 → null', () => {
  const result = extractExplicitPipeline('修復認證很急');
  assert.strictEqual(result, null);
});

test('extractExplicitPipeline: 大小寫不敏感', () => {
  assert.strictEqual(extractExplicitPipeline('[Pipeline:Full]'), 'full');
  assert.strictEqual(extractExplicitPipeline('[PIPELINE:STANDARD]'), 'standard');
});

test('extractExplicitPipeline: 不合法 pipeline ID → null', () => {
  const result = extractExplicitPipeline('[pipeline:invalid-name]');
  assert.strictEqual(result, null);
});

asyncTest('classifyWithConfidence: Layer 1 覆寫信心度 1.0', async () => {
  const result = await classifyWithConfidence('[pipeline:quick-dev] 修個 bug');
  assert.strictEqual(result.pipeline, 'quick-dev');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
});

asyncTest('classifyWithConfidence: Layer 1 語法在結尾', async () => {
  const result = await classifyWithConfidence('建立完整 API [pipeline:full]');
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.source, 'explicit');
});

// ===== 3. Classifier Fallback 行為（無 API key）=====

console.log('\n🧪 Part 3: Classifier Fallback 行為');

asyncTest('classifyWithConfidence: 一般 prompt → none/main-agent', async () => {
  const result = await classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('classifyWithConfidence: 疑問句 → none/main-agent', async () => {
  const result = await classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.source, 'main-agent');
});

asyncTest('classifyWithConfidence: 空字串 → none, 0, fallback, empty', async () => {
  const result = await classifyWithConfidence('');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.source, 'fallback');
  assert.strictEqual(result.matchedRule, 'empty');
});

// ===== 4. Pipeline 子集前進路徑測試 =====

console.log('\n🧪 Part 5: Pipeline 子集前進路徑');

test('quick-dev pipeline 不包含 PLAN/ARCH/DESIGN', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.ok(!stages.includes('PLAN'));
  assert.ok(!stages.includes('ARCH'));
  assert.ok(!stages.includes('DESIGN'));
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

test('ui-only pipeline 階段結構', () => {
  const stages = PIPELINES['ui-only'].stages;
  assert.deepStrictEqual(stages, ['DESIGN', 'DEV', 'QA']);
});

test('security pipeline 階段結構', () => {
  const stages = PIPELINES['security'].stages;
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

// ===== 6. TDD Pipeline 雙 TEST 邊界測試 =====

console.log('\n🧪 Part 6: TDD Pipeline 雙 TEST 邊界測試');

test('TDD pipeline 結構：TEST-DEV-TEST', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.deepStrictEqual(stages, ['TEST', 'DEV', 'TEST']);
});

test('TDD pipeline 有兩個 TEST', () => {
  const stages = PIPELINES['test-first'].stages;
  const testCount = stages.filter(s => s === 'TEST').length;
  assert.strictEqual(testCount, 2);
});

test('TDD pipeline 包含 DEV', () => {
  const stages = PIPELINES['test-first'].stages;
  assert.ok(stages.includes('DEV'));
});

// ===== 7. 單階段 Pipeline 邊界測試 =====

console.log('\n🧪 Part 7: 單階段 Pipeline 邊界測試');

test('fix pipeline: 只有 DEV', () => {
  const stages = PIPELINES['fix'].stages;
  assert.deepStrictEqual(stages, ['DEV']);
});

test('review-only pipeline: 只有 REVIEW', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.deepStrictEqual(stages, ['REVIEW']);
});

test('docs-only pipeline: 只有 DOCS', () => {
  const stages = PIPELINES['docs-only'].stages;
  assert.deepStrictEqual(stages, ['DOCS']);
});

test('none pipeline: 空階段列表', () => {
  const stages = PIPELINES['none'].stages;
  assert.deepStrictEqual(stages, []);
  assert.strictEqual(PIPELINES['none'].enforced, false);
});

// ===== 8. 短 Pipeline 回退場景測試 =====

console.log('\n🧪 Part 8: 短 Pipeline 回退場景');

test('quick-dev pipeline: REVIEW 失敗可回退到 DEV', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.ok(stages.includes('DEV'));
  assert.ok(stages.includes('REVIEW'));
  const devIndex = stages.indexOf('DEV');
  assert.strictEqual(devIndex, 0);
});

test('review-only pipeline: 不包含 DEV，無法回退', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.ok(!stages.includes('DEV'));
});

test('docs-only pipeline: 不包含品質階段，無回退場景', () => {
  const stages = PIPELINES['docs-only'].stages;
  const qualityStages = ['REVIEW', 'TEST', 'QA', 'E2E'];
  qualityStages.forEach(stage => {
    assert.ok(!stages.includes(stage));
  });
});

// ===== 9. Pipeline 升級路徑測試 =====

console.log('\n🧪 Part 9: Pipeline 升級路徑');

test('fix → quick-dev 升級（priority 2 → 4）', () => {
  const isUpgrade = PIPELINE_PRIORITY['quick-dev'] > PIPELINE_PRIORITY['fix'];
  assert.ok(isUpgrade);
});

test('quick-dev → standard 升級（priority 4 → 6）', () => {
  const isUpgrade = PIPELINE_PRIORITY['standard'] > PIPELINE_PRIORITY['quick-dev'];
  assert.ok(isUpgrade);
});

test('standard → full 升級（priority 6 → 7）', () => {
  const isUpgrade = PIPELINE_PRIORITY['full'] > PIPELINE_PRIORITY['standard'];
  assert.ok(isUpgrade);
});

test('full → fix 降級阻擋（priority 7 → 2）', () => {
  const isDowngrade = PIPELINE_PRIORITY['fix'] < PIPELINE_PRIORITY['full'];
  assert.ok(isDowngrade);
});

test('none → fix 升級（priority 0 → 2）', () => {
  const isUpgrade = PIPELINE_PRIORITY['fix'] > PIPELINE_PRIORITY['none'];
  assert.ok(isUpgrade);
});

// ===== 10. 注入防護測試 =====

console.log('\n🧪 Part 10: 注入防護');

test('[pipeline:xxx] 語法不允許空白', () => {
  const result = extractExplicitPipeline('[pipeline: full]');
  assert.strictEqual(result, null);
});

test('[pipeline:xxx] 只允許小寫字母、數字、連字號', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:quick-dev]'), 'quick-dev');
  assert.strictEqual(extractExplicitPipeline('[pipeline:test_first]'), null); // 底線不允許
  assert.strictEqual(extractExplicitPipeline('[pipeline:test.first]'), null); // 點不允許
});

test('[pipeline:xxx] 不允許路徑遍歷', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:../etc/passwd]'), null);
  assert.strictEqual(extractExplicitPipeline('[pipeline:../../secret]'), null);
});

test('[pipeline:xxx] 不允許指令注入', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:fix; rm -rf /]'), null);
  assert.strictEqual(extractExplicitPipeline('[pipeline:fix`whoami`]'), null);
});

// ===== 11. 邊界值測試 =====

console.log('\n🧪 Part 11: 邊界值');

asyncTest('空字串 prompt → 預設 none', async () => {
  const result = await classifyWithConfidence('');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0);
});

asyncTest('null prompt → 預設 none', async () => {
  const result = await classifyWithConfidence(null);
  assert.strictEqual(result.pipeline, 'none');
});

asyncTest('超長 prompt 不影響 Layer 1 分類', async () => {
  const longPrompt = 'A'.repeat(10000) + ' [pipeline:full]';
  const result = await classifyWithConfidence(longPrompt);
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.source, 'explicit');
});

test('多個 [pipeline:xxx] 標記 → 只取第一個', () => {
  const result = extractExplicitPipeline('[pipeline:fix] some text [pipeline:full]');
  assert.strictEqual(result, 'fix');
});

// ===== 12. Pipeline enforced 屬性測試 =====

console.log('\n🧪 Part 12: Pipeline enforced 屬性');

test('enforced pipeline: 除 none 外全部強制', () => {
  const enforced = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security'];
  enforced.forEach(id => {
    assert.strictEqual(PIPELINES[id].enforced, true, `${id} 應為 enforced`);
  });
});

test('non-enforced pipeline: 只有 none', () => {
  assert.strictEqual(PIPELINES['none'].enforced, false, 'none 不應為 enforced');
});

// ===== 13. FRONTEND_FRAMEWORKS 常量測試 =====

console.log('\n🧪 Part 13: FRONTEND_FRAMEWORKS 常量');

test('FRONTEND_FRAMEWORKS 包含 13 個框架', () => {
  assert.strictEqual(FRONTEND_FRAMEWORKS.length, 13);
});

test('FRONTEND_FRAMEWORKS 包含主流前端框架', () => {
  const expected = ['next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular'];
  expected.forEach(fw => {
    assert.ok(FRONTEND_FRAMEWORKS.includes(fw), `缺少前端框架: ${fw}`);
  });
});

test('FRONTEND_FRAMEWORKS 全部小寫（env-detector 回傳小寫）', () => {
  FRONTEND_FRAMEWORKS.forEach(fw => {
    assert.strictEqual(fw, fw.toLowerCase(), `${fw} 應為小寫`);
  });
});

// ===== 摘要 =====

(async () => {
  if (asyncQueue.length > 0) {
    console.log('\n🧪 Async Tests');
    for (const { name, fn } of asyncQueue) {
      try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
      } catch (err) {
        failed++;
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Pipeline Catalog 整合測試結果`);
  console.log(`========================================`);
  console.log(`✅ 通過: ${passed}`);
  console.log(`❌ 失敗: ${failed}`);
  console.log(`總計: ${passed + failed}`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
})();
