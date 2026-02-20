#!/usr/bin/env node
/**
 * phase-parser-edge-cases.test.js — Phase Parser + Node Context 邊界案例測試（S3 補充）
 *
 * 測試範圍：
 * 1. 循環依賴偵測（Phase 1 deps [Phase 2], Phase 2 deps [Phase 1]）
 * 2. 大量 phases（10+ phases）
 * 3. phase 名稱包含特殊字元
 * 4. tasks.md 格式不規範
 * 5. generatePhaseDag 對不同 pipelineId 行為差異
 * 6. node-context buildPhaseScopeHint 的 phase 資訊缺失情境
 * 7. resolvePhaseDeps 邊界案例
 * 8. 常數驗證
 *
 * 執行：node plugins/vibe/tests/phase-parser-edge-cases.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const {
  parsePhasesFromTasks,
  generatePhaseDag,
  resolvePhaseDeps,
  PIPELINE_PHASE_STAGES,
  PIPELINES_WITH_DOCS,
  PIPELINES_WITH_BARRIER,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/phase-parser.js'));

const {
  buildPhaseScopeHint,
  MAX_PHASE_SCOPE_CHARS,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/node-context.js'));

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

// ─── Section 1: 循環依賴邊界案例 ──────────────────────────

console.log('\n📋 Section 1: 循環依賴與相互依賴邊界案例');

test('Phase 1 deps Phase 2 時 resolvePhaseDeps 應正常解析（無死鎖）', () => {
  // Phase 1 依賴 Phase 2，Phase 2 依賴 Phase 1 → 相互依賴
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 2'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  // resolvePhaseDeps 只做名稱→index 轉換，不做環檢測
  // 但 index 不等於 self → 都可解析
  const depMap = resolvePhaseDeps(phases);
  // Phase 1 依賴 Phase 2（index=2）
  assert.deepStrictEqual(depMap.get(1), [2], 'Phase 1 deps [2]');
  // Phase 2 依賴 Phase 1（index=1）
  assert.deepStrictEqual(depMap.get(2), [1], 'Phase 2 deps [1]');
});

test('相互依賴的 phases 傳給 generatePhaseDag 不崩潰且返回空物件', () => {
  // M-1 修復：循環依賴偵測（拓撲排序），有循環時退化為空物件
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 2'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  let result;
  assert.doesNotThrow(() => {
    result = generatePhaseDag(phases, 'standard');
  }, '相互依賴不崩潰');
  // M-1 修復後：循環 → 返回空物件（安全退化）
  assert.deepStrictEqual(result, {}, '相互依賴 → 退化為空物件');
});

test('三 phase 間接循環（1→2→3→1）不崩潰且返回空物件', () => {
  // M-1 修復：拓撲排序偵測三角循環
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 3'], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  let result;
  assert.doesNotThrow(() => {
    result = generatePhaseDag(phases, 'standard');
  }, '三角循環不崩潰');
  // M-1 修復後：循環 → 返回空物件
  assert.deepStrictEqual(result, {}, '三角循環 → 退化為空物件');
});

test('Phase 自我依賴在 parsePhasesFromTasks 後可正確解析', () => {
  const content = `
## Phase 1: 自我依賴測試
deps: [Phase 1]
- [ ] task A
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1);
  assert.deepStrictEqual(phases[0].deps, ['Phase 1'], '原始 deps 保留');

  // resolvePhaseDeps 應過濾自我依賴
  const depMap = resolvePhaseDeps(phases);
  assert.deepStrictEqual(depMap.get(1), [], '自我依賴被過濾');
});

// ─── Section 2: 空 phases 邊界 ──────────────────────────

console.log('\n📋 Section 2: 空 phases / null / undefined 邊界');

test('parsePhasesFromTasks 接受空字串', () => {
  assert.deepStrictEqual(parsePhasesFromTasks(''), []);
});

test('parsePhasesFromTasks 接受純空白字串', () => {
  assert.deepStrictEqual(parsePhasesFromTasks('   \n\n\t  '), []);
});

test('parsePhasesFromTasks 接受 null', () => {
  assert.deepStrictEqual(parsePhasesFromTasks(null), []);
});

test('parsePhasesFromTasks 接受 undefined', () => {
  assert.deepStrictEqual(parsePhasesFromTasks(undefined), []);
});

test('parsePhasesFromTasks 接受數字（非字串）返回空陣列', () => {
  assert.deepStrictEqual(parsePhasesFromTasks(42), []);
});

test('parsePhasesFromTasks 接受物件（非字串）返回空陣列', () => {
  assert.deepStrictEqual(parsePhasesFromTasks({ content: '## Phase 1\n' }), []);
});

test('generatePhaseDag 空陣列返回空物件', () => {
  assert.deepStrictEqual(generatePhaseDag([], 'standard'), {});
});

test('generatePhaseDag null 返回空物件', () => {
  assert.deepStrictEqual(generatePhaseDag(null, 'standard'), {});
});

test('generatePhaseDag 單 phase 返回空物件', () => {
  const phases = [{ name: 'Phase 1', index: 1, deps: [], tasks: ['task'] }];
  assert.deepStrictEqual(generatePhaseDag(phases, 'standard'), {});
});

test('resolvePhaseDeps 空陣列返回空 Map', () => {
  const depMap = resolvePhaseDeps([]);
  assert.strictEqual(depMap.size, 0, '空 Map');
});

// ─── Section 3: 大量 phases（10+ phases） ──────────────────

console.log('\n📋 Section 3: 大量 phases（10 個線性依賴）');

test('10 個線性 phase 不崩潰且正確生成 DAG', () => {
  const phases = Array.from({ length: 10 }, (_, i) => ({
    name: `Phase ${i + 1}`,
    index: i + 1,
    deps: i === 0 ? [] : [`Phase ${i}`],
    tasks: [`task ${i + 1}`],
  }));

  assert.doesNotThrow(() => {
    const dag = generatePhaseDag(phases, 'standard');
    // 應有 10 個 DEV + 10 個 REVIEW + 10 個 TEST + 1 個 DOCS = 31 個節點
    assert.strictEqual(Object.keys(dag).length, 31, '31 個節點');

    // DEV:1 無依賴
    assert.deepStrictEqual(dag['DEV:1'].deps, []);

    // DEV:10 依賴 REVIEW:9 和 TEST:9
    assert.ok(dag['DEV:10'].deps.includes('REVIEW:9'), 'DEV:10 deps REVIEW:9');
    assert.ok(dag['DEV:10'].deps.includes('TEST:9'), 'DEV:10 deps TEST:9');

    // DOCS 只依賴最終 phase 10 的品質 stages
    assert.ok(dag['DOCS'].deps.includes('REVIEW:10'), 'DOCS deps REVIEW:10');
    assert.ok(dag['DOCS'].deps.includes('TEST:10'), 'DOCS deps TEST:10');
    // 中間 phase 不在 DOCS deps
    assert.ok(!dag['DOCS'].deps.includes('REVIEW:5'), 'DOCS 不 deps REVIEW:5');
  }, '10 phase 不崩潰');
});

test('10 個並行 phase（互無依賴）DOCS 依賴全部', () => {
  const phases = Array.from({ length: 10 }, (_, i) => ({
    name: `Phase ${i + 1}`,
    index: i + 1,
    deps: [], // 全部並行
    tasks: [`task ${i + 1}`],
  }));

  const dag = generatePhaseDag(phases, 'standard');
  // 所有 DEV:N 都無依賴
  for (let i = 1; i <= 10; i++) {
    assert.deepStrictEqual(dag[`DEV:${i}`].deps, [], `DEV:${i} 無依賴`);
  }
  // DOCS 依賴所有 REVIEW:N 和 TEST:N（10*2=20 個）
  assert.strictEqual(dag['DOCS'].deps.length, 20, 'DOCS 依賴 20 個品質 stages');
});

// ─── Section 4: phase 名稱特殊字元 ──────────────────────

console.log('\n📋 Section 4: phase 名稱特殊字元');

test('phase 名稱含中文字元正確解析', () => {
  const content = `
## Phase 1: 認證模組
deps: []
- [ ] 建立登入功能

## Phase 2: 資料庫整合
deps: [Phase 1]
- [ ] 連接 PostgreSQL
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2, '兩個 phase');
  assert.strictEqual(phases[0].name, 'Phase 1: 認證模組', 'Phase 1 名稱正確');
  assert.strictEqual(phases[1].name, 'Phase 2: 資料庫整合', 'Phase 2 名稱正確');
  assert.deepStrictEqual(phases[1].deps, ['Phase 1'], 'Phase 2 deps 正確');
});

test('phase 名稱含連字號和底線正確解析', () => {
  const content = `
## Phase 1: API-setup_v2
deps: []
- [ ] task A

## Phase 2: UI_Component-Library
deps: [Phase 1]
- [ ] task B
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2, '兩個 phase');
  assert.strictEqual(phases[0].name, 'Phase 1: API-setup_v2', 'Phase 1 名稱含特殊字元');
  assert.deepStrictEqual(phases[1].deps, ['Phase 1'], 'Phase 2 deps 正確');
});

test('phase 名稱含括號和點號正確解析', () => {
  const content = `
## Phase 1: 核心 (v1.0)
deps: []
- [ ] task A
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1, '一個 phase');
  assert.strictEqual(phases[0].name, 'Phase 1: 核心 (v1.0)', 'Phase 1 名稱含括號');
});

test('deps 中使用全名匹配（包含標題）', () => {
  // 用全 phase 名稱作 dep
  const phases = [
    { name: 'Phase 1: Auth Login', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2: Register', index: 2, deps: ['Phase 1: Auth Login'], tasks: [] },
  ];
  const depMap = resolvePhaseDeps(phases);
  // 全名匹配也應能解析（case insensitive）
  assert.deepStrictEqual(depMap.get(2), [1], 'Phase 2 deps 解析為 [1]');
});

// ─── Section 5: tasks.md 格式不規範 ──────────────────────

console.log('\n📋 Section 5: tasks.md 格式不規範（容錯）');

test('缺少 deps 行的 phase 視為無依賴', () => {
  const content = `
## Phase 1: 測試
- [ ] task A
- [ ] task B

## Phase 2: 延伸
- [ ] task C
`;
  const phases = parsePhasesFromTasks(content);
  // Phase 標題匹配，但無 deps 行
  assert.strictEqual(phases.length, 2, '兩個 phase');
  assert.deepStrictEqual(phases[0].deps, [], 'Phase 1 deps 為空');
  assert.deepStrictEqual(phases[1].deps, [], 'Phase 2 deps 為空');
});

test('deps 行含多餘空白仍正確解析', () => {
  const content = `
## Phase 1: 測試
deps:   [  Phase 2  ,  Phase 3  ]
- [ ] task A
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1, '一個 phase');
  // 空白應被 trim
  assert.deepStrictEqual(phases[0].deps, ['Phase 2', 'Phase 3'], 'deps 正確 trim');
});

test('deps 行大小寫混用仍正確解析', () => {
  const content = `
## Phase 1: 基礎
Deps: []
- [ ] task A

## Phase 2: 延伸
DEPS: [Phase 1]
- [ ] task B
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2, '兩個 phase');
  assert.deepStrictEqual(phases[0].deps, [], 'Phase 1 deps 為空（空 []）');
  assert.deepStrictEqual(phases[1].deps, ['Phase 1'], 'Phase 2 deps 解析正確');
});

test('phase 之間有多行空白仍正確解析', () => {
  const content = `
## Phase 1: 基礎
deps: []
- [ ] task A



## Phase 2: 延伸
deps: [Phase 1]
- [ ] task B
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2, '兩個 phase');
});

test('tasks 含程式碼標記正確解析', () => {
  const content = `
## Phase 1: 實作
deps: []
- [ ] 建立 \`UserService.ts\`（src/services/）
- [ ] 加入 \`@Injectable()\` 裝飾器
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1, '一個 phase');
  assert.strictEqual(phases[0].tasks.length, 2, '兩個 task');
  assert.ok(phases[0].tasks[0].includes('UserService.ts'), '含程式碼標記的 task 正確解析');
});

test('phase index 不連續仍正確解析（Phase 1, Phase 3）', () => {
  const content = `
## Phase 1: 第一
deps: []
- [ ] task A

## Phase 3: 第三
deps: [Phase 1]
- [ ] task B
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2, '兩個 phase');
  assert.strictEqual(phases[0].index, 1, 'Phase 1 index 正確');
  assert.strictEqual(phases[1].index, 3, 'Phase 3 index 正確');
  assert.deepStrictEqual(phases[1].deps, ['Phase 1'], 'Phase 3 deps 正確');
});

test('非標準格式的章節標題（## 1. 主題）不被解析為 phase', () => {
  const content = `
## 1. 初始化（非 phase 標題）
- [ ] task 不在 phase 中

## Phase 1: 真正的 phase
deps: []
- [ ] phase 內 task
`;
  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1, '只有一個 phase');
  assert.strictEqual(phases[0].index, 1, 'index 正確');
  assert.deepStrictEqual(phases[0].tasks, ['phase 內 task'], '只包含 phase 內的 task');
});

// ─── Section 6: generatePhaseDag pipelineId 行為差異 ──────

console.log('\n📋 Section 6: generatePhaseDag 不同 pipelineId 行為差異');

test('standard pipeline 含 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');
  assert.ok(dag['DOCS'], 'standard 含 DOCS');
});

test('full pipeline 含 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'full');
  assert.ok(dag['DOCS'], 'full 含 DOCS');
});

test('quick-dev pipeline 不含 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'quick-dev');
  assert.ok(!dag['DOCS'], 'quick-dev 不含 DOCS');
});

test('security pipeline 不含 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'security');
  assert.ok(!dag['DOCS'], 'security 不含 DOCS');
});

test('fix pipeline 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, 'fix'), {});
});

test('test-first pipeline 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, 'test-first'), {});
});

test('review-only pipeline 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, 'review-only'), {});
});

test('docs-only pipeline 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, 'docs-only'), {});
});

test('undefined pipelineId 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, undefined), {});
});

test('null pipelineId 退化返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, null), {});
});

// ─── Section 7: buildPhaseScopeHint 邊界案例 ──────────────

console.log('\n📋 Section 7: buildPhaseScopeHint 邊界案例');

test('TEST:N 也能注入 phase 範圍（不只 DEV/REVIEW）', () => {
  const state = {
    phaseInfo: {
      3: { name: 'Phase 3: 整合測試', tasks: ['撰寫 E2E 測試', '設定 CI'] }
    }
  };
  const hint = buildPhaseScopeHint('TEST:3', state);
  assert.ok(hint.includes('Phase 3: 整合測試'), '包含 Phase 3 名稱');
  assert.ok(hint.includes('撰寫 E2E 測試'), '包含 task');
});

test('DOCS:N 形式也能解析（若 DAG 有此節點）', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1', tasks: ['撰寫文件'] }
    }
  };
  // DOCS:1 是合法的 suffixed stage 格式
  const hint = buildPhaseScopeHint('DOCS:1', state);
  assert.ok(hint.includes('Phase 1'), '包含 Phase 1');
});

test('state 為 null 不崩潰', () => {
  assert.doesNotThrow(() => {
    const result = buildPhaseScopeHint('DEV:1', null);
    assert.strictEqual(result, '', '返回空字串');
  });
});

test('state 為 undefined 不崩潰', () => {
  assert.doesNotThrow(() => {
    const result = buildPhaseScopeHint('DEV:1', undefined);
    assert.strictEqual(result, '', '返回空字串');
  });
});

test('stageId 為空字串返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: ['task'] } } };
  assert.strictEqual(buildPhaseScopeHint('', state), '');
});

test('stageId 為 null 返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: ['task'] } } };
  assert.strictEqual(buildPhaseScopeHint(null, state), '');
});

test('stageId 為 undefined 返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: ['task'] } } };
  assert.strictEqual(buildPhaseScopeHint(undefined, state), '');
});

test('超多 tasks 的截斷邊界精確', () => {
  // 建立剛好超過 MAX_PHASE_SCOPE_CHARS 的 tasks
  const singleTaskLen = 50;
  const headerLen = '## Phase 1: test 任務範圍\n'.length;
  const taskCount = Math.ceil((MAX_PHASE_SCOPE_CHARS - headerLen) / (singleTaskLen + '- [ ] \n'.length)) + 2;
  const tasks = Array.from({ length: taskCount }, (_, i) => 'A'.repeat(singleTaskLen) + ` ${i}`);
  const state = { phaseInfo: { 1: { name: 'Phase 1: test', tasks } } };

  const hint = buildPhaseScopeHint('DEV:1', state);
  assert.ok(hint.length <= MAX_PHASE_SCOPE_CHARS, `長度 ${hint.length} <= ${MAX_PHASE_SCOPE_CHARS}`);
  assert.ok(hint.endsWith('...'), '截斷後以 ... 結尾');
});

test('phaseInfo 的 key 為字串而非數字時也能匹配', () => {
  // JavaScript 物件的 key 通常是字串，確認 parseInt 正確處理
  const state = {
    phaseInfo: {
      '2': { name: 'Phase 2: 字串 key', tasks: ['task X'] }
    }
  };
  const hint = buildPhaseScopeHint('DEV:2', state);
  assert.ok(hint.includes('Phase 2: 字串 key'), '字串 key 正確解析');
});

test('phaseInfo 有對應 phase 但 tasks 為 null 時返回空字串', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1', tasks: null }
    }
  };
  const result = buildPhaseScopeHint('DEV:1', state);
  assert.strictEqual(result, '', 'tasks 為 null 返回空字串');
});

// ─── Section 8: 常數驗證 ─────────────────────────────────

console.log('\n📋 Section 8: 模組常數驗證');

test('PIPELINE_PHASE_STAGES 包含預期 pipeline', () => {
  assert.ok('standard' in PIPELINE_PHASE_STAGES, 'standard 存在');
  assert.ok('full' in PIPELINE_PHASE_STAGES, 'full 存在');
  assert.ok('quick-dev' in PIPELINE_PHASE_STAGES, 'quick-dev 存在');
  assert.ok('security' in PIPELINE_PHASE_STAGES, 'security 存在');
});

test('PIPELINE_PHASE_STAGES 不含單階段 pipeline', () => {
  assert.ok(!('fix' in PIPELINE_PHASE_STAGES), 'fix 不存在');
  assert.ok(!('review-only' in PIPELINE_PHASE_STAGES), 'review-only 不存在');
  assert.ok(!('docs-only' in PIPELINE_PHASE_STAGES), 'docs-only 不存在');
  assert.ok(!('test-first' in PIPELINE_PHASE_STAGES), 'test-first 不存在');
});

test('PIPELINES_WITH_DOCS 只含 standard 和 full', () => {
  assert.ok(PIPELINES_WITH_DOCS.has('standard'), 'standard 有 DOCS');
  assert.ok(PIPELINES_WITH_DOCS.has('full'), 'full 有 DOCS');
  assert.ok(!PIPELINES_WITH_DOCS.has('quick-dev'), 'quick-dev 無 DOCS');
  assert.ok(!PIPELINES_WITH_DOCS.has('security'), 'security 無 DOCS');
});

test('PIPELINES_WITH_BARRIER 包含四個 pipeline', () => {
  assert.ok(PIPELINES_WITH_BARRIER.has('standard'), 'standard 有 barrier');
  assert.ok(PIPELINES_WITH_BARRIER.has('full'), 'full 有 barrier');
  assert.ok(PIPELINES_WITH_BARRIER.has('quick-dev'), 'quick-dev 有 barrier');
  assert.ok(PIPELINES_WITH_BARRIER.has('security'), 'security 有 barrier');
});

test('MAX_PHASE_SCOPE_CHARS 為 500', () => {
  assert.strictEqual(MAX_PHASE_SCOPE_CHARS, 500, 'MAX_PHASE_SCOPE_CHARS = 500');
});

test('所有 PIPELINE_PHASE_STAGES 的 stages 都含 DEV', () => {
  for (const [pid, stages] of Object.entries(PIPELINE_PHASE_STAGES)) {
    assert.ok(stages.includes('DEV'), `${pid} 含 DEV`);
  }
});

test('所有 PIPELINE_PHASE_STAGES 的 stages 都含 REVIEW 和 TEST', () => {
  for (const [pid, stages] of Object.entries(PIPELINE_PHASE_STAGES)) {
    assert.ok(stages.includes('REVIEW'), `${pid} 含 REVIEW`);
    assert.ok(stages.includes('TEST'), `${pid} 含 TEST`);
  }
});

// ─── Section 9: resolvePhaseDeps 進階邊界案例 ─────────────

console.log('\n📋 Section 9: resolvePhaseDeps 進階邊界案例');

test('deps 包含空字串被過濾', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['', 'Phase 2', '  '], tasks: [] },
    { name: 'Phase 2', index: 2, deps: [], tasks: [] },
  ];
  // parsePhasesFromTasks 中已 filter，但直接傳給 resolvePhaseDeps 時測試防禦
  const depMap = resolvePhaseDeps(phases);
  // '' 和 '  ' 都是無效 dep 名稱，找不到對應 index → 被忽略
  const deps = depMap.get(1);
  assert.ok(!deps.includes(undefined), '不含 undefined');
});

test('大寫 phase 名稱在 deps 中仍可匹配（case insensitive）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['PHASE 1'], tasks: [] },
  ];
  const depMap = resolvePhaseDeps(phases);
  // case insensitive 匹配：'PHASE 1' → 'phase 1' → index 1
  assert.deepStrictEqual(depMap.get(2), [1], 'PHASE 1 大寫 deps 解析');
});

test('重複 dep 在 resolvePhaseDeps 中不去重（呼叫方負責）', () => {
  // resolvePhaseDeps 不負責去重，其行為依賴呼叫方傳入的 deps
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1', 'Phase 1'], tasks: [] },
  ];
  const depMap = resolvePhaseDeps(phases);
  // 重複 dep → 重複 index（符合 single-pass 設計）
  const deps = depMap.get(2);
  assert.ok(deps.every(d => d === 1), '所有 dep 都是 index 1');
});

// ─── Section 10: generatePhaseDag barrier 結構完整性 ──────

console.log('\n📋 Section 10: generatePhaseDag barrier 結構完整性');

test('barrier siblings 正確（REVIEW:N 和 TEST:N）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // REVIEW:1 barrier
  const r1barrier = dag['REVIEW:1'].barrier;
  assert.ok(r1barrier.siblings.includes('REVIEW:1'), 'siblings 含 REVIEW:1');
  assert.ok(r1barrier.siblings.includes('TEST:1'), 'siblings 含 TEST:1');
  assert.strictEqual(r1barrier.siblings.length, 2, 'siblings 長度為 2');

  // TEST:1 barrier（與 REVIEW:1 共享相同配置）
  const t1barrier = dag['TEST:1'].barrier;
  assert.ok(t1barrier.siblings.includes('REVIEW:1'), 'TEST:1 siblings 含 REVIEW:1');
  assert.ok(t1barrier.siblings.includes('TEST:1'), 'TEST:1 siblings 含 TEST:1');
});

test('barrier group 命名格式為 quality:N', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 2'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  assert.strictEqual(dag['REVIEW:1'].barrier.group, 'quality:1', 'barrier group Phase 1');
  assert.strictEqual(dag['REVIEW:2'].barrier.group, 'quality:2', 'barrier group Phase 2');
  assert.strictEqual(dag['REVIEW:3'].barrier.group, 'quality:3', 'barrier group Phase 3');
});

test('barrier total 固定為 2（REVIEW + TEST）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  assert.strictEqual(dag['REVIEW:1'].barrier.total, 2, 'REVIEW:1 total=2');
  assert.strictEqual(dag['TEST:1'].barrier.total, 2, 'TEST:1 total=2');
  assert.strictEqual(dag['REVIEW:2'].barrier.total, 2, 'REVIEW:2 total=2');
  assert.strictEqual(dag['TEST:2'].barrier.total, 2, 'TEST:2 total=2');
});

test('quick-dev pipeline 的 barrier 無 DOCS 后繼', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'quick-dev');

  // Phase 2 是最終 phase，barrier.next 應為 null
  assert.strictEqual(dag['REVIEW:2'].barrier.next, null, 'quick-dev 最終 barrier.next=null');
  assert.strictEqual(dag['TEST:2'].barrier.next, null, 'quick-dev 最終 barrier.next=null');
});

test('DEV:N 節點無 barrier 配置', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];
  const dag = generatePhaseDag(phases, 'standard');

  // DEV 節點不應有 barrier
  assert.ok(!dag['DEV:1'].barrier, 'DEV:1 無 barrier');
  assert.ok(!dag['DEV:2'].barrier, 'DEV:2 無 barrier');
});

// ─── 結果輸出 ────────────────────────────────────────────

console.log(`\n結果：${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
