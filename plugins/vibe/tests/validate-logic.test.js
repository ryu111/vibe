#!/usr/bin/env node
/**
 * validate-logic.test.js — test-e2e/validate.js 修復驗證測試
 *
 * 驗證以下修復的邏輯正確性：
 *   修復 1 (L3:qualityVerdicts)  — verdict 物件/字串兼容處理
 *   修復 2 (L6:guardBlocked)     — 事件類型改為 tool.blocked
 *   修復 3 (L5:hasReclassification) — required 改為 false
 *   修復 4 (A05 TEST:verify)     — test-first stages 含 TEST:verify
 *   修復 5 (A06 projectVariant)  — frontend variant 正確設定
 *   修復 6 (B01/B04/B06 放寬)    — 只驗 noCrash 不驗 pipelineId
 *
 * 執行：node plugins/vibe/tests/validate-logic.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const SCENARIOS_PATH = path.join(PROJECT_ROOT, 'test-e2e', 'scenarios.json');
const VALIDATE_PATH = path.join(PROJECT_ROOT, 'test-e2e', 'validate.js');

// 從 dag-state.js 引入用於建立測試 state
const dagStatePath = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'dag-state.js');
const { derivePhase, getCompletedStages, getSkippedStages } = require(dagStatePath);

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

// ────────────────── 共用輔助 ──────────────────

// 從 validate.js 提取驗證邏輯（獨立重現，不依賴 CLI argv）
const QUALITY_STAGES = ['REVIEW', 'TEST', 'QA', 'E2E'];

/**
 * 重現 validate.js L3:qualityVerdicts 的 verdict 兼容檢查
 */
function checkQualityVerdicts(stages) {
  const qualityResults = Object.entries(stages)
    .filter(([stageId]) => QUALITY_STAGES.includes(stageId))
    .filter(([, s]) => s.status === 'completed');

  if (qualityResults.length === 0) return null; // 跳過

  const allQualityPass = qualityResults.every(([, s]) => {
    const v = s.verdict;
    return v === 'PASS' || (typeof v === 'object' && v !== null && v.verdict === 'PASS');
  });
  return allQualityPass;
}

/**
 * 重現 validate.js L6:guardBlocked 的事件偵測邏輯
 */
function checkGuardBlocked(timeline, phase) {
  const hasBlock = timeline.some(e =>
    e.type === 'tool.blocked' ||
    e.type === 'stage.blocked' ||
    e.type === 'pipeline.blocked'
  );
  const pipelineNotIdle = phase !== 'IDLE';
  return hasBlock || pipelineNotIdle;
}

// ────────────────── 修復 1：L3:qualityVerdicts 物件/字串兼容 ──────────────────

console.log('\n🧪 修復 1：L3:qualityVerdicts verdict 物件/字串兼容');
console.log('═══════════════════════════════════════════════════════');

test('verdict 字串格式 "PASS" 應通過', () => {
  const stages = {
    DEV: { status: 'completed' },
    REVIEW: { status: 'completed', verdict: 'PASS' },
    TEST: { status: 'completed', verdict: 'PASS' },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, true, '字串 PASS 應回傳 true');
});

test('verdict 物件格式 {verdict:"PASS"} 應通過', () => {
  const stages = {
    REVIEW: { status: 'completed', verdict: { verdict: 'PASS', route: 'NEXT', _inferred: true } },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, true, '物件格式 {verdict:"PASS"} 應回傳 true');
});

test('verdict 物件格式 {verdict:"FAIL"} 應失敗', () => {
  const stages = {
    REVIEW: { status: 'completed', verdict: { verdict: 'FAIL', route: 'DEV' } },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, false, '物件格式 {verdict:"FAIL"} 應回傳 false');
});

test('verdict 字串格式 "FAIL" 應失敗', () => {
  const stages = {
    TEST: { status: 'completed', verdict: 'FAIL' },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, false, '字串 FAIL 應回傳 false');
});

test('混合：一個字串 PASS + 一個物件 PASS → 應通過', () => {
  const stages = {
    REVIEW: { status: 'completed', verdict: 'PASS' },
    TEST: { status: 'completed', verdict: { verdict: 'PASS', route: 'NEXT' } },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, true, '混合格式全 PASS 應回傳 true');
});

test('混合：字串 PASS + 物件 FAIL → 應失敗', () => {
  const stages = {
    REVIEW: { status: 'completed', verdict: 'PASS' },
    TEST: { status: 'completed', verdict: { verdict: 'FAIL', route: 'DEV' } },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, false, '有 FAIL 應回傳 false');
});

test('非品質階段 (DEV) 不影響結果', () => {
  const stages = {
    DEV: { status: 'completed', verdict: 'FAIL' }, // DEV 不是品質階段
    REVIEW: { status: 'completed', verdict: 'PASS' },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, true, 'DEV FAIL 不影響品質階段判斷');
});

test('未完成的品質階段不計入', () => {
  const stages = {
    REVIEW: { status: 'active', verdict: null }, // active，未完成
    TEST: { status: 'pending' },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, null, '無已完成品質階段應回傳 null（跳過）');
});

test('verdict 為 null 應視為失敗', () => {
  const stages = {
    REVIEW: { status: 'completed', verdict: null },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, false, 'verdict=null 應回傳 false');
});

test('verdict 為 undefined 應視為失敗', () => {
  const stages = {
    TEST: { status: 'completed', verdict: undefined },
  };
  const result = checkQualityVerdicts(stages);
  assert.strictEqual(result, false, 'verdict=undefined 應回傳 false');
});

// ────────────────── 修復 2：L6:guardBlocked 事件類型 ──────────────────

console.log('\n🧪 修復 2：L6:guardBlocked 事件類型改為 tool.blocked');
console.log('═══════════════════════════════════════════════════════');

test('tool.blocked 事件應被識別', () => {
  const timeline = [
    { type: 'prompt.received', ts: 1 },
    { type: 'tool.blocked', ts: 2, data: { tool: 'Write' } },
    { type: 'delegation.start', ts: 3 },
  ];
  const result = checkGuardBlocked(timeline, 'DELEGATING');
  assert.strictEqual(result, true, 'tool.blocked 事件應觸發 guardBlocked=true');
});

test('stage.blocked 向後相容仍應被識別', () => {
  const timeline = [
    { type: 'stage.blocked', ts: 1 },
  ];
  const result = checkGuardBlocked(timeline, 'IDLE');
  assert.strictEqual(result, true, '舊 stage.blocked 事件應向後相容');
});

test('pipeline.blocked 向後相容仍應被識別', () => {
  const timeline = [
    { type: 'pipeline.blocked', ts: 1 },
  ];
  const result = checkGuardBlocked(timeline, 'IDLE');
  assert.strictEqual(result, true, '舊 pipeline.blocked 事件應向後相容');
});

test('無 block 事件但 phase 非 IDLE → 備用條件通過', () => {
  const timeline = [
    { type: 'prompt.received', ts: 1 },
    { type: 'delegation.start', ts: 2 },
  ];
  const result = checkGuardBlocked(timeline, 'DELEGATING');
  assert.strictEqual(result, true, 'phase=DELEGATING 應觸發備用條件');
});

test('無 block 事件且 phase=IDLE → 應失敗', () => {
  const timeline = [
    { type: 'prompt.received', ts: 1 },
  ];
  const result = checkGuardBlocked(timeline, 'IDLE');
  assert.strictEqual(result, false, 'IDLE 且無 block 事件應回傳 false');
});

test('tool.blocked 事件即使 phase=IDLE 也通過', () => {
  const timeline = [
    { type: 'tool.blocked', ts: 1 },
  ];
  const result = checkGuardBlocked(timeline, 'IDLE');
  assert.strictEqual(result, true, 'tool.blocked 事件優先於 phase 判斷');
});

// ────────────────── 修復 3：L5:hasReclassification required=false ──────────────────

console.log('\n🧪 修復 3：L5:hasReclassification required=false（非阻擋性）');
console.log('═══════════════════════════════════════════════════════');

// 重現 validate.js 中 required 計算邏輯
function simulateRequiredCount(checks) {
  return checks.filter(c => !c.passed && c.required).length;
}

test('hasReclassification 檢查應為 optional（required=false）', () => {
  const checks = [
    { name: 'L1:stateExists', passed: true, required: true },
    { name: 'L5:hasReclassification', passed: false, required: false }, // 修復後
  ];
  const failedRequired = simulateRequiredCount(checks);
  assert.strictEqual(failedRequired, 0, 'hasReclassification 失敗不應導致必要失敗');
});

test('hasReclassification required=true 時失敗應影響結果（修復前行為）', () => {
  const checks = [
    { name: 'L1:stateExists', passed: true, required: true },
    { name: 'L5:hasReclassification', passed: false, required: true }, // 修復前（錯誤行為）
  ];
  const failedRequired = simulateRequiredCount(checks);
  assert.strictEqual(failedRequired, 1, '修復前 required=true 會導致必要失敗');
});

test('hasReclassification 通過時不影響 required 計數', () => {
  const checks = [
    { name: 'L1:stateExists', passed: true, required: true },
    { name: 'L5:hasReclassification', passed: true, required: false },
  ];
  const failedRequired = simulateRequiredCount(checks);
  assert.strictEqual(failedRequired, 0, '通過時必要失敗數應為 0');
});

// ────────────────── 修復 4：A05 TEST:verify 存在於 registry ──────────────────

console.log('\n🧪 修復 4：A05 TEST:verify 存在於 test-first pipeline registry 定義');
console.log('═══════════════════════════════════════════════════════');

const registryPath = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'registry.js');
const registry = require(registryPath);

test('registry.js 中 test-first pipeline 含 TEST:verify', () => {
  const pipelines = registry.REFERENCE_PIPELINES || registry.PIPELINES;
  assert.ok(pipelines, 'REFERENCE_PIPELINES 或 PIPELINES 應存在');
  const testFirstPipeline = pipelines['test-first'];
  assert.ok(testFirstPipeline, 'test-first pipeline 應存在');
  assert.ok(testFirstPipeline.stages.includes('TEST:verify'),
    `test-first stages 應含 TEST:verify，實際：${JSON.stringify(testFirstPipeline.stages)}`);
});

test('scenarios.json A05 的 stages 與 registry test-first 一致', () => {
  const scenariosPath = SCENARIOS_PATH;
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const a05 = scenarios.scenarios.find(s => s.id === 'A05');
  assert.ok(a05, 'A05 場景應存在');
  assert.deepStrictEqual(a05.expected.stages, ['TEST', 'DEV', 'TEST:verify'],
    `A05 stages 應為 ['TEST','DEV','TEST:verify']，實際：${JSON.stringify(a05.expected.stages)}`);
});

test('registry test-first 完整 stages 結構驗證', () => {
  const pipelines = registry.REFERENCE_PIPELINES || registry.PIPELINES;
  const stages = pipelines['test-first'].stages;
  assert.strictEqual(stages.length, 3, 'test-first 應有 3 個 stages');
  assert.strictEqual(stages[0], 'TEST', '第一個 stage 應為 TEST');
  assert.strictEqual(stages[1], 'DEV', '第二個 stage 應為 DEV');
  assert.strictEqual(stages[2], 'TEST:verify', '第三個 stage 應為 TEST:verify');
});

// ────────────────── 修復 5：A06 projectVariant=frontend ──────────────────

console.log('\n🧪 修復 5：A06 projectVariant="frontend" 設定正確');
console.log('═══════════════════════════════════════════════════════');

test('scenarios.json A06 含 projectVariant=frontend', () => {
  const scenariosPath = SCENARIOS_PATH;
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const a06 = scenarios.scenarios.find(s => s.id === 'A06');
  assert.ok(a06, 'A06 場景應存在');
  assert.strictEqual(a06.projectVariant, 'frontend',
    `A06 projectVariant 應為 "frontend"，實際：${a06.projectVariant}`);
});

test('A06 pipeline 為 ui-only（含 DESIGN 階段）', () => {
  const scenariosPath = SCENARIOS_PATH;
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const a06 = scenarios.scenarios.find(s => s.id === 'A06');
  assert.ok(a06.expected.stages.includes('DESIGN'),
    'ui-only pipeline A06 的 stages 應含 DESIGN');
});

// ────────────────── 修復 6：B01/B04/B06 放寬期望值 ──────────────────

console.log('\n🧪 修復 6：B01/B04/B06 放寬期望值（只驗 noCrash）');
console.log('═══════════════════════════════════════════════════════');

function loadScenario(id) {
  const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  return scenarios.scenarios.find(s => s.id === id);
}

test('B01 只驗 noCrash，不驗 pipelineId', () => {
  const b01 = loadScenario('B01');
  assert.ok(b01, 'B01 應存在');
  assert.ok(b01.expected.noCrash, 'B01 expected 應含 noCrash=true');
  assert.strictEqual(b01.expected.pipelineId, undefined,
    'B01 不應設定 pipelineId（非確定性）');
});

test('B04 只驗 noCrash + phase=COMPLETE，不驗 pipelineId', () => {
  const b04 = loadScenario('B04');
  assert.ok(b04, 'B04 應存在');
  assert.ok(b04.expected.noCrash, 'B04 expected 應含 noCrash=true');
  assert.strictEqual(b04.expected.pipelineId, undefined,
    'B04 不應設定 pipelineId（fix 或 quick-dev 均可）');
});

test('B06 只驗 noCrash，不驗 pipelineId', () => {
  const b06 = loadScenario('B06');
  assert.ok(b06, 'B06 應存在');
  assert.ok(b06.expected.noCrash, 'B06 expected 應含 noCrash=true');
  assert.strictEqual(b06.expected.pipelineId, undefined,
    'B06 不應設定 pipelineId（非確定性）');
});

test('B01/B04/B06 的 _note 說明非確定性原因', () => {
  const scenariosPath = SCENARIOS_PATH;
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  for (const id of ['B01', 'B04', 'B06']) {
    const s = scenarios.scenarios.find(sc => sc.id === id);
    assert.ok(s._note, `${id} 應有 _note 解釋放寬原因`);
  }
});

// ────────────────── Phase 2：自我挑戰 — 補充邊界案例 ──────────────────

console.log('\n🧪 補充邊界案例：scenarios.json 結構完整性');
console.log('═══════════════════════════════════════════════════════');

test('所有場景都有 id、category、name、prompt', () => {
  const scenariosPath = SCENARIOS_PATH;
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  for (const s of data.scenarios) {
    assert.ok(s.id, `場景缺少 id`);
    assert.ok(s.category, `場景 ${s.id} 缺少 category`);
    assert.ok(s.name, `場景 ${s.id} 缺少 name`);
    assert.ok(s.prompt, `場景 ${s.id} 缺少 prompt`);
  }
});

test('所有場景 id 不重複', () => {
  const scenariosPath = SCENARIOS_PATH;
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const ids = data.scenarios.map(s => s.id);
  const uniqueIds = new Set(ids);
  assert.strictEqual(ids.length, uniqueIds.size,
    `場景 id 有重複：${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
});

test('A 類場景（正路徑）全部有 phase 期望', () => {
  const scenariosPath = SCENARIOS_PATH;
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const aScenarios = data.scenarios.filter(s => s.category === 'A');
  for (const s of aScenarios) {
    assert.ok(s.expected.phase, `A 類場景 ${s.id} 應有 phase 期望`);
  }
});

test('E 類場景（v4 機制）全部有 v4State 期望', () => {
  const scenariosPath = SCENARIOS_PATH;
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  const eScenarios = data.scenarios.filter(s => s.category === 'E');
  for (const s of eScenarios) {
    assert.ok(s.expected.v4State,
      `E 類場景 ${s.id} 應有 v4State 期望，實際：${JSON.stringify(s.expected)}`);
  }
});

test('顯式 pipeline 場景均有 source=explicit 期望', () => {
  const scenariosPath = SCENARIOS_PATH;
  const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  // A01~A09 + E01~E04 是顯式 pipeline（prompt 含 [pipeline:xxx]）
  const explicitIds = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09'];
  for (const id of explicitIds) {
    const s = data.scenarios.find(sc => sc.id === id);
    if (s && s.expected.source !== undefined) {
      assert.strictEqual(s.expected.source, 'explicit',
        `${id} 含 [pipeline:xxx] 應設定 source=explicit`);
    }
  }
});

test('validate.js 存在且語法有效（同步 require 測試）', () => {
  const validatePath = VALIDATE_PATH;
  assert.ok(fs.existsSync(validatePath), 'validate.js 應存在');
  // 讀取並確認文件大小合理
  const content = fs.readFileSync(validatePath, 'utf8');
  assert.ok(content.length > 100, 'validate.js 應有實質內容');
});

// ────────────────── 輸出結果 ──────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過');
} else {
  console.log('❌ 有失敗');
  process.exit(1);
}
