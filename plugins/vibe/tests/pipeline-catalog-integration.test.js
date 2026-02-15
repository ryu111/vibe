#!/usr/bin/env node
/**
 * pipeline-catalog-integration.test.js — Pipeline Catalog 整合測試
 *
 * 測試分類器→初始化→前進→完成的完整流程，涵蓋：
 * 1. classifyWithConfidence 三層級聯分類（Layer 1+2）
 * 2. registry.js PIPELINES/PRIORITY/TASKTYPE 映射正確性
 * 3. task-classifier 動態設定 expectedStages + pipelineId
 * 4. stage-transition 在 pipeline 子集中查找下一階段
 * 5. pipeline-check stageIndex 感知檢查
 * 6. 邊界案例：TDD 雙 TEST、單階段 pipeline、舊 state 向後相容
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
  TASKTYPE_TO_PIPELINE,
  FRONTEND_FRAMEWORKS,
  STAGE_ORDER,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'registry.js'));

const {
  classifyWithConfidence,
  extractExplicitPipeline,
  classify,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

const {
  findNextStageInPipeline,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'pipeline-discovery.js'));

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

test('enforced pipeline 優先級 >= 3', () => {
  Object.entries(PIPELINES).forEach(([id, p]) => {
    if (p.enforced) {
      assert.ok(PIPELINE_PRIORITY[id] >= 3, `enforced pipeline ${id} 優先級只有 ${PIPELINE_PRIORITY[id]}`);
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

test('classifyWithConfidence: Layer 1 覆寫信心度 1.0', () => {
  const result = classifyWithConfidence('[pipeline:quick-dev] 修個 bug');
  assert.strictEqual(result.pipeline, 'quick-dev');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
});

test('classifyWithConfidence: Layer 1 語法在結尾', () => {
  const result = classifyWithConfidence('建立完整 API [pipeline:full]');
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.source, 'explicit');
});

// ===== 3. Classifier Layer 2 信心度評分測試 =====

console.log('\n🧪 Part 3: Classifier Layer 2 信心度評分');

test('classifyWithConfidence: Strong question → none, 0.95', () => {
  const result = classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none');
  assert.ok(result.confidence >= 0.9, `信心度只有 ${result.confidence}`);
  assert.strictEqual(result.source, 'regex');
});

test('classifyWithConfidence: Trivial → fix, 0.9', () => {
  const result = classifyWithConfidence('做個 hello world 試試');
  assert.strictEqual(result.pipeline, 'fix');
  assert.ok(result.confidence >= 0.85, `信心度只有 ${result.confidence}`);
  assert.strictEqual(result.source, 'regex');
});

test('classifyWithConfidence: TDD 關鍵字 → test-first, 0.8', () => {
  const result = classifyWithConfidence('用 TDD 方式開發');
  assert.strictEqual(result.pipeline, 'test-first');
  assert.ok(result.confidence >= 0.75, `信心度只有 ${result.confidence}`);
  assert.strictEqual(result.source, 'regex');
});

test('classifyWithConfidence: Feature 關鍵字 → standard, 0.8', () => {
  const result = classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.pipeline, 'standard');
  assert.ok(result.confidence >= 0.75, `信心度只有 ${result.confidence}`);
  assert.strictEqual(result.source, 'regex');
});

test('classifyWithConfidence: Weak explore → none, 0.6', () => {
  const result = classifyWithConfidence('看看這個專案');
  assert.strictEqual(result.pipeline, 'none');
  assert.ok(result.confidence >= 0.5 && result.confidence < 0.8, `信心度應在 0.5~0.8 之間，實際為 ${result.confidence}`);
  // 信心度 < 0.7 時 source 標記為 pending-llm（Phase 5 LLM fallback 佔位）
  assert.strictEqual(result.source, 'pending-llm');
});

test('classifyWithConfidence: 預設 quickfix → fix, 0.7', () => {
  const result = classifyWithConfidence('改個名');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7);
  assert.strictEqual(result.source, 'regex');
});

// ===== 4. Classifier 向後相容測試 =====

console.log('\n🧪 Part 4: Classifier 向後相容');

test('classify() 繼續回傳 taskType（向後相容）', () => {
  assert.strictEqual(classify('什麼'), 'research');
  assert.strictEqual(classify('hello world'), 'quickfix');
  assert.strictEqual(classify('TDD'), 'tdd');
  assert.strictEqual(classify('implement API'), 'feature');
  assert.strictEqual(classify('fix bug'), 'bugfix');
});

test('classifyWithConfidence 與 classify 映射一致', () => {
  const prompts = [
    '什麼',
    'hello world',
    'TDD',
    'implement API',
    'fix bug',
  ];
  prompts.forEach(prompt => {
    const taskType = classify(prompt);
    const { pipeline } = classifyWithConfidence(prompt);
    const expectedPipeline = TASKTYPE_TO_PIPELINE[taskType];
    assert.strictEqual(pipeline, expectedPipeline, `${prompt} → taskType=${taskType} → pipeline=${pipeline}（預期 ${expectedPipeline}）`);
  });
});

// ===== 5. Pipeline 子集前進路徑測試 =====

console.log('\n🧪 Part 5: Pipeline 子集前進路徑');

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

test('quick-dev pipeline 不包含 PLAN/ARCH/DESIGN', () => {
  const stages = PIPELINES['quick-dev'].stages;
  assert.ok(!stages.includes('PLAN'));
  assert.ok(!stages.includes('ARCH'));
  assert.ok(!stages.includes('DESIGN'));
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

test('ui-only pipeline: DESIGN → DEV → QA（跳過 REVIEW/TEST）', () => {
  const stages = PIPELINES['ui-only'].stages;
  let result = findNextStageInPipeline(stages, mockStageMap, 'DESIGN', 0);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);

  result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'QA');
  assert.strictEqual(result.index, 2);

  result = findNextStageInPipeline(stages, mockStageMap, 'QA', 2);
  assert.strictEqual(result.stage, null);
});

test('security pipeline: DEV → REVIEW → TEST（含安全審查）', () => {
  const stages = PIPELINES['security'].stages;
  let result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 0);
  assert.strictEqual(result.stage, 'REVIEW');

  result = findNextStageInPipeline(stages, mockStageMap, 'REVIEW', 1);
  assert.strictEqual(result.stage, 'TEST');

  result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 2);
  assert.strictEqual(result.stage, null);
});

// ===== 6. TDD Pipeline 雙 TEST 邊界測試 =====

console.log('\n🧪 Part 6: TDD Pipeline 雙 TEST 邊界測試');

test('TDD 第一個 TEST: indexOf=0, stageIndex=0 → DEV index=1', () => {
  const stages = PIPELINES['test-first'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 0);
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
});

test('TDD DEV: stageIndex=1 → 第二個 TEST index=2', () => {
  const stages = PIPELINES['test-first'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
});

test('TDD 第二個 TEST: stageIndex=2 → null（pipeline 完成）', () => {
  const stages = PIPELINES['test-first'].stages;
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST', 2);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('TDD 無 stageIndex 時預設用 indexOf → 回到第一個 TEST 的邏輯', () => {
  const stages = PIPELINES['test-first'].stages;
  // 不提供 stageIndex → 用 currentStage='TEST' → indexOf=0
  const result = findNextStageInPipeline(stages, mockStageMap, 'TEST');
  assert.strictEqual(result.stage, 'DEV');
  assert.strictEqual(result.index, 1);
});

test('TDD 回退到 DEV 後重跑第二個 TEST', () => {
  const stages = PIPELINES['test-first'].stages;
  // 模擬：第二個 TEST 失敗 → 回退到 DEV（stageIndex 不變=1）
  // DEV 修復完成 → 從 index=1 找下一個 = index=2 的 TEST
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 1);
  assert.strictEqual(result.stage, 'TEST');
  assert.strictEqual(result.index, 2);
});

// ===== 7. 單階段 Pipeline 邊界測試 =====

console.log('\n🧪 Part 7: 單階段 Pipeline 邊界測試');

test('fix pipeline: 只有 DEV，完成即結束', () => {
  const stages = PIPELINES['fix'].stages;
  assert.deepStrictEqual(stages, ['DEV']);
  const result = findNextStageInPipeline(stages, mockStageMap, 'DEV', 0);
  assert.strictEqual(result.stage, null);
  assert.strictEqual(result.index, -1);
});

test('review-only pipeline: 只有 REVIEW，完成即結束', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.deepStrictEqual(stages, ['REVIEW']);
  const result = findNextStageInPipeline(stages, mockStageMap, 'REVIEW', 0);
  assert.strictEqual(result.stage, null);
});

test('docs-only pipeline: 只有 DOCS，完成即結束', () => {
  const stages = PIPELINES['docs-only'].stages;
  assert.deepStrictEqual(stages, ['DOCS']);
  const result = findNextStageInPipeline(stages, mockStageMap, 'DOCS', 0);
  assert.strictEqual(result.stage, null);
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
  // DEV 在 pipeline 中的 index=0
  assert.ok(stages.includes('DEV'));
  assert.ok(stages.includes('REVIEW'));
  // 回退邏輯：從 REVIEW 回到 DEV，修復後重跑 REVIEW
  const devIndex = stages.indexOf('DEV');
  assert.strictEqual(devIndex, 0);
});

test('review-only pipeline: 不包含 DEV，無法回退', () => {
  const stages = PIPELINES['review-only'].stages;
  assert.ok(!stages.includes('DEV'));
  // 回退邏輯應該檢查 pipeline 中是否有 DEV，沒有則不回退
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

test('空字串 prompt → 預設 fix', () => {
  const result = classifyWithConfidence('');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7);
});

test('null prompt → 預設 fix', () => {
  const result = classifyWithConfidence(null);
  assert.strictEqual(result.pipeline, 'fix');
});

test('超長 prompt 不影響分類', () => {
  const longPrompt = 'A'.repeat(10000) + ' [pipeline:full]';
  const result = classifyWithConfidence(longPrompt);
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.source, 'explicit');
});

test('多個 [pipeline:xxx] 標記 → 只取第一個', () => {
  const result = extractExplicitPipeline('[pipeline:fix] some text [pipeline:full]');
  assert.strictEqual(result, 'fix');
});

// ===== 12. Pipeline enforced 屬性測試 =====

console.log('\n🧪 Part 12: Pipeline enforced 屬性');

test('enforced pipeline: full, standard, quick-dev, test-first, ui-only, security', () => {
  const enforced = ['full', 'standard', 'quick-dev', 'test-first', 'ui-only', 'security'];
  enforced.forEach(id => {
    assert.strictEqual(PIPELINES[id].enforced, true, `${id} 應為 enforced`);
  });
});

test('non-enforced pipeline: fix, review-only, docs-only, none', () => {
  const nonEnforced = ['fix', 'review-only', 'docs-only', 'none'];
  nonEnforced.forEach(id => {
    assert.strictEqual(PIPELINES[id].enforced, false, `${id} 不應為 enforced`);
  });
});

// ===== 13. FRONTEND_FRAMEWORKS 常量測試 =====

console.log('\n🧪 Part 13: FRONTEND_FRAMEWORKS 常量');

test('FRONTEND_FRAMEWORKS 包含 8 個框架', () => {
  assert.strictEqual(FRONTEND_FRAMEWORKS.length, 8);
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

console.log(`\n========================================`);
console.log(`Pipeline Catalog 整合測試結果`);
console.log(`========================================`);
console.log(`✅ 通過: ${passed}`);
console.log(`❌ 失敗: ${failed}`);
console.log(`總計: ${passed + failed}`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
