#!/usr/bin/env node
/**
 * phase-parser.test.js — Phase Parser 單元測試（S3.12）
 *
 * 測試範圍：
 * 1. parsePhasesFromTasks()：正常解析、deps、空內容、混合格式
 * 2. generatePhaseDag()：2-phase、3-phase、並行、退化條件
 * 3. 不同 pipelineId 的 stage 組合差異
 *
 * 執行：node plugins/vibe/tests/phase-parser.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');
const {
  parsePhasesFromTasks,
  generatePhaseDag,
  resolvePhaseDeps,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/phase-parser.js'));

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

// ─── parsePhasesFromTasks ──────────────────────────────────

console.log('\n📋 Section 1: parsePhasesFromTasks()');

test('空內容返回空陣列', () => {
  assert.deepStrictEqual(parsePhasesFromTasks(''), []);
  assert.deepStrictEqual(parsePhasesFromTasks(null), []);
  assert.deepStrictEqual(parsePhasesFromTasks(undefined), []);
});

test('無 phase 結構返回空陣列', () => {
  const content = `
# 實作任務

## 1. 基礎設施
- [ ] 建立資料庫連線
- [ ] 設定環境變數

## 2. 功能實作
- [ ] 實作 API endpoint
`;
  assert.deepStrictEqual(parsePhasesFromTasks(content), []);
});

test('2-phase 正常解析', () => {
  const content = `
# Tasks

## Phase 1: Auth Login
deps: []
- [ ] 建立 login API endpoint
- [ ] 加入 JWT token 生成

## Phase 2: Auth Register
deps: [Phase 1]
- [ ] 建立 register API endpoint
- [x] email 驗證流程（已完成）
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2);

  assert.strictEqual(phases[0].name, 'Phase 1: Auth Login');
  assert.strictEqual(phases[0].index, 1);
  assert.deepStrictEqual(phases[0].deps, []);
  assert.deepStrictEqual(phases[0].tasks, [
    '建立 login API endpoint',
    '加入 JWT token 生成',
  ]);

  assert.strictEqual(phases[1].name, 'Phase 2: Auth Register');
  assert.strictEqual(phases[1].index, 2);
  assert.deepStrictEqual(phases[1].deps, ['Phase 1']);
  assert.deepStrictEqual(phases[1].tasks, [
    '建立 register API endpoint',
    'email 驗證流程（已完成）',
  ]);
});

test('3-phase 含並行依賴解析', () => {
  const content = `
## Phase 1: Auth Login
deps: []
- [ ] 建立 login API

## Phase 2: Auth Register
deps: [Phase 1]
- [ ] 建立 register API

## Phase 3: Auth Middleware
deps: [Phase 1]
- [ ] JWT middleware
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 3);
  assert.deepStrictEqual(phases[0].deps, []);
  assert.deepStrictEqual(phases[1].deps, ['Phase 1']);
  assert.deepStrictEqual(phases[2].deps, ['Phase 1']);
});

test('多依賴解析 [Phase 1, Phase 3]', () => {
  const content = `
## Phase 1: 基礎
deps: []
- [ ] task A

## Phase 2: 延伸
deps: []
- [ ] task B

## Phase 3: 整合
deps: [Phase 1, Phase 2]
- [ ] task C
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 3);
  assert.deepStrictEqual(phases[2].deps, ['Phase 1', 'Phase 2']);
});

test('混合格式：phase 外的 task 被忽略', () => {
  const content = `
# 實作任務

- [ ] 這個 task 在 phase 外，應被忽略

## Phase 1: 核心功能
deps: []
- [ ] phase 內的 task

## 2. 其他章節（非 phase）
- [ ] 這個也被忽略
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 1);
  assert.strictEqual(phases[0].index, 1);
  assert.deepStrictEqual(phases[0].tasks, ['phase 內的 task']);
});

test('無標題的 phase', () => {
  const content = `
## Phase 1
deps: []
- [ ] task A

## Phase 2
deps: [Phase 1]
- [ ] task B
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases.length, 2);
  assert.strictEqual(phases[0].name, 'Phase 1');
  assert.strictEqual(phases[1].name, 'Phase 2');
});

test('已完成 task [x] 也被收集', () => {
  const content = `
## Phase 1: 測試
deps: []
- [ ] 待完成
- [x] 已完成
- [X] 也算已完成
`;

  const phases = parsePhasesFromTasks(content);
  assert.strictEqual(phases[0].tasks.length, 3);
});

// ─── resolvePhaseDeps ──────────────────────────────────

console.log('\n📋 Section 2: resolvePhaseDeps()');

test('正確解析 phase index 依賴', () => {
  const phases = [
    { name: 'Phase 1: Login', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2: Register', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3: Middleware', index: 3, deps: ['Phase 1'], tasks: [] },
  ];

  const depMap = resolvePhaseDeps(phases);
  assert.deepStrictEqual(depMap.get(1), []);
  assert.deepStrictEqual(depMap.get(2), [1]);
  assert.deepStrictEqual(depMap.get(3), [1]);
});

test('多依賴正確解析', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: [], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1', 'Phase 2'], tasks: [] },
  ];

  const depMap = resolvePhaseDeps(phases);
  assert.deepStrictEqual(depMap.get(3), [1, 2]);
});

test('自我依賴被忽略（防循環）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['Phase 1'], tasks: [] },
  ];

  const depMap = resolvePhaseDeps(phases);
  assert.deepStrictEqual(depMap.get(1), []);
});

test('無法解析的 dep 名稱被靜默忽略', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: ['不存在的 Phase'], tasks: [] },
  ];

  const depMap = resolvePhaseDeps(phases);
  assert.deepStrictEqual(depMap.get(1), []);
});

// ─── generatePhaseDag ──────────────────────────────────

console.log('\n📋 Section 3: generatePhaseDag()');

test('退化：phases < 2 返回空物件', () => {
  const singlePhase = [{ name: 'Phase 1', index: 1, deps: [], tasks: ['task'] }];
  assert.deepStrictEqual(generatePhaseDag([], 'standard'), {});
  assert.deepStrictEqual(generatePhaseDag(singlePhase, 'standard'), {});
  assert.deepStrictEqual(generatePhaseDag(null, 'standard'), {});
});

test('退化：不支援的 pipelineId 返回空物件', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: [], tasks: [] },
  ];
  assert.deepStrictEqual(generatePhaseDag(phases, 'fix'), {});
  assert.deepStrictEqual(generatePhaseDag(phases, 'docs-only'), {});
  assert.deepStrictEqual(generatePhaseDag(phases, 'unknown'), {});
});

test('2-phase 線性依賴 standard pipeline', () => {
  const phases = [
    { name: 'Phase 1: Login', index: 1, deps: [], tasks: ['task A'] },
    { name: 'Phase 2: Register', index: 2, deps: ['Phase 1'], tasks: ['task B'] },
  ];

  const dag = generatePhaseDag(phases, 'standard');

  // Phase 1 stages
  assert.ok(dag['DEV:1'], 'DEV:1 存在');
  assert.deepStrictEqual(dag['DEV:1'].deps, []);

  assert.ok(dag['REVIEW:1'], 'REVIEW:1 存在');
  assert.deepStrictEqual(dag['REVIEW:1'].deps, ['DEV:1']);

  assert.ok(dag['TEST:1'], 'TEST:1 存在');
  assert.deepStrictEqual(dag['TEST:1'].deps, ['DEV:1']);

  // Phase 2 deps on Phase 1 quality stages
  assert.ok(dag['DEV:2'], 'DEV:2 存在');
  assert.ok(dag['DEV:2'].deps.includes('REVIEW:1'), 'DEV:2 deps REVIEW:1');
  assert.ok(dag['DEV:2'].deps.includes('TEST:1'), 'DEV:2 deps TEST:1');

  assert.ok(dag['REVIEW:2'], 'REVIEW:2 存在');
  assert.ok(dag['TEST:2'], 'TEST:2 存在');

  // DOCS deps on final quality stages
  assert.ok(dag['DOCS'], 'DOCS 存在');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS deps REVIEW:2');
  assert.ok(dag['DOCS'].deps.includes('TEST:2'), 'DOCS deps TEST:2');
  // DOCS 不依賴中間 phase 的 quality stages
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS 不 deps REVIEW:1');
});

test('3-phase 含並行（Phase 2+3 都依賴 Phase 1）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
    { name: 'Phase 3', index: 3, deps: ['Phase 1'], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'standard');

  // DEV:2 和 DEV:3 都依賴 REVIEW:1 和 TEST:1
  assert.ok(dag['DEV:2'].deps.includes('REVIEW:1'), 'DEV:2 deps REVIEW:1');
  assert.ok(dag['DEV:2'].deps.includes('TEST:1'), 'DEV:2 deps TEST:1');
  assert.ok(dag['DEV:3'].deps.includes('REVIEW:1'), 'DEV:3 deps REVIEW:1');
  assert.ok(dag['DEV:3'].deps.includes('TEST:1'), 'DEV:3 deps TEST:1');

  // DOCS deps on Phase 2 和 Phase 3 的 final quality stages
  assert.ok(dag['DOCS'], 'DOCS 存在');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS deps REVIEW:2');
  assert.ok(dag['DOCS'].deps.includes('TEST:2'), 'DOCS deps TEST:2');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:3'), 'DOCS deps REVIEW:3');
  assert.ok(dag['DOCS'].deps.includes('TEST:3'), 'DOCS deps TEST:3');

  // Phase 1 quality stages 不在 DOCS deps（有後繼 DEV 依賴它們）
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS 不 deps REVIEW:1');
  assert.ok(!dag['DOCS'].deps.includes('TEST:1'), 'DOCS 不 deps TEST:1');
});

test('barrier 配置正確（standard pipeline）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'standard');

  // REVIEW:1 和 TEST:1 應有 barrier 配置
  const review1 = dag['REVIEW:1'];
  const test1 = dag['TEST:1'];

  assert.ok(review1.barrier, 'REVIEW:1 有 barrier');
  assert.ok(test1.barrier, 'TEST:1 有 barrier');
  assert.strictEqual(review1.barrier.group, 'quality:1', 'barrier group 正確');
  assert.strictEqual(review1.barrier.total, 2, 'barrier total 為 2');
  assert.deepStrictEqual(
    review1.barrier.siblings,
    ['REVIEW:1', 'TEST:1'],
    'barrier siblings 正確'
  );

  // barrier.next 應指向 DEV:2
  assert.strictEqual(review1.barrier.next, 'DEV:2', 'REVIEW:1 barrier.next = DEV:2');
  assert.strictEqual(test1.barrier.next, 'DEV:2', 'TEST:1 barrier.next = DEV:2');
});

test('最終 phase 的 barrier.next 為 null', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'standard');

  // Phase 2 的 REVIEW/TEST barrier.next 應為 null（無後繼 DEV）
  assert.strictEqual(dag['REVIEW:2'].barrier.next, null, 'REVIEW:2 barrier.next = null');
  assert.strictEqual(dag['TEST:2'].barrier.next, null, 'TEST:2 barrier.next = null');
});

test('quick-dev pipeline 無 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'quick-dev');

  // quick-dev 無 DOCS
  assert.ok(!dag['DOCS'], 'quick-dev 無 DOCS');
  // 但有 DEV/REVIEW/TEST
  assert.ok(dag['DEV:1'], 'DEV:1 存在');
  assert.ok(dag['REVIEW:1'], 'REVIEW:1 存在');
  assert.ok(dag['TEST:1'], 'TEST:1 存在');
});

test('獨立 phase（無依賴）各自為根節點', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: [], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'standard');

  // 兩個 phase 都無依賴，DEV:1 和 DEV:2 都是根節點
  assert.deepStrictEqual(dag['DEV:1'].deps, []);
  assert.deepStrictEqual(dag['DEV:2'].deps, []);

  // 兩個 phase 都是最終 phase，DOCS deps 兩者的品質 stages
  assert.ok(dag['DOCS'].deps.includes('REVIEW:1'), 'DOCS deps REVIEW:1');
  assert.ok(dag['DOCS'].deps.includes('TEST:1'), 'DOCS deps TEST:1');
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'), 'DOCS deps REVIEW:2');
  assert.ok(dag['DOCS'].deps.includes('TEST:2'), 'DOCS deps TEST:2');
});

test('DAG 節點集合正確（2-phase standard）', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: [] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: [] },
  ];

  const dag = generatePhaseDag(phases, 'standard');
  const stageIds = Object.keys(dag).sort();

  const expected = ['DEV:1', 'DEV:2', 'DOCS', 'REVIEW:1', 'REVIEW:2', 'TEST:1', 'TEST:2'].sort();
  assert.deepStrictEqual(stageIds, expected);
});

// ─── 整合驗證：parsePhasesFromTasks + generatePhaseDag ────

console.log('\n📋 Section 4: 整合驗證');

test('從完整 tasks.md 生成正確 DAG', () => {
  const tasksContent = `
# 實作任務

## Phase 1: Auth Login
deps: []
- [ ] 建立 login API endpoint（src/routes/auth.js）
- [ ] 加入 JWT token 生成（src/lib/jwt.js）

## Phase 2: Auth Register
deps: [Phase 1]
- [ ] 建立 register API endpoint（src/routes/auth.js）
- [ ] email 驗證流程（src/lib/email.js）

## Phase 3: Auth Middleware
deps: [Phase 1]
- [ ] JWT 驗證 middleware（src/middleware/auth.js）
- [ ] route 保護（src/routes/index.js）
`;

  const phases = parsePhasesFromTasks(tasksContent);
  assert.strictEqual(phases.length, 3);

  const dag = generatePhaseDag(phases, 'standard');

  // Phase 2 和 Phase 3 都依賴 Phase 1
  assert.ok(dag['DEV:2'].deps.includes('REVIEW:1'));
  assert.ok(dag['DEV:3'].deps.includes('REVIEW:1'));

  // DEV:2 和 DEV:3 互相獨立（可並行）
  assert.ok(!dag['DEV:2'].deps.includes('DEV:3'));
  assert.ok(!dag['DEV:3'].deps.includes('DEV:2'));

  // DOCS 只依賴最終 phase 的品質 stages
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'));
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'));
  assert.ok(dag['DOCS'].deps.includes('REVIEW:3'));
});

test('pure 1-phase tasks.md → generatePhaseDag 退化', () => {
  const tasksContent = `
## Phase 1: 單一功能
deps: []
- [ ] task A
- [ ] task B
`;

  const phases = parsePhasesFromTasks(tasksContent);
  assert.strictEqual(phases.length, 1);

  // 單 phase → 退化
  const dag = generatePhaseDag(phases, 'standard');
  assert.deepStrictEqual(dag, {});
});

// ─── 結果輸出 ────────────────────────────────────────────

console.log(`\n結果：${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
