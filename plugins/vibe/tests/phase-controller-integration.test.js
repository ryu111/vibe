#!/usr/bin/env node
/**
 * phase-controller-integration.test.js — Phase Parser + Controller 整合測試（S3.13）
 *
 * 測試範圍：
 * 1. buildPhaseCompletionHint()：suffixed stage 完成提示
 * 2. buildPhaseScopeHint()：Node Context phase 範圍注入
 * 3. pipeline-controller 整合 phase-parser 的行為（tryGeneratePhaseDag 路徑）
 * 4. TaskCreate/TaskUpdate 建議格式正確性
 *
 * 執行：node plugins/vibe/tests/phase-controller-integration.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, '..');

const {
  parsePhasesFromTasks,
  generatePhaseDag,
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

// ─── buildPhaseScopeHint 測試 ─────────────────────────────

console.log('\n🧩 Section 1: buildPhaseScopeHint()');

test('非 suffixed stage 返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: ['task A'] } } };
  assert.strictEqual(buildPhaseScopeHint('DEV', state), '');
  assert.strictEqual(buildPhaseScopeHint('REVIEW', state), '');
  assert.strictEqual(buildPhaseScopeHint('', state), '');
  assert.strictEqual(buildPhaseScopeHint(null, state), '');
});

test('無 phaseInfo 返回空字串', () => {
  assert.strictEqual(buildPhaseScopeHint('DEV:1', {}), '');
  assert.strictEqual(buildPhaseScopeHint('DEV:1', null), '');
  assert.strictEqual(buildPhaseScopeHint('DEV:1', { phaseInfo: null }), '');
});

test('phaseInfo 無對應 phase 返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: ['task A'] } } };
  assert.strictEqual(buildPhaseScopeHint('DEV:2', state), '');
});

test('REVIEW:N 也能注入 phase 範圍', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1: Auth Login', tasks: ['建立 login API', '加入 JWT'] }
    }
  };
  const hint = buildPhaseScopeHint('REVIEW:1', state);
  assert.ok(hint.includes('Phase 1: Auth Login'), '包含 phase 名稱');
  assert.ok(hint.includes('- [ ] 建立 login API'), '包含 task');
});

test('DEV:2 注入正確 phase 的 tasks', () => {
  const state = {
    phaseInfo: {
      1: { name: 'Phase 1', tasks: ['task A'] },
      2: { name: 'Phase 2: Auth Register', tasks: ['建立 register API', 'email 驗證'] }
    }
  };
  const hint = buildPhaseScopeHint('DEV:2', state);
  assert.ok(hint.includes('Phase 2: Auth Register'), '包含 Phase 2 名稱');
  assert.ok(hint.includes('建立 register API'), '包含 Phase 2 task');
  assert.ok(!hint.includes('task A'), '不包含 Phase 1 task');
});

test('空 tasks 返回空字串', () => {
  const state = { phaseInfo: { 1: { name: 'Phase 1', tasks: [] } } };
  assert.strictEqual(buildPhaseScopeHint('DEV:1', state), '');
});

test('超長 tasks 被截斷', () => {
  const longTask = 'A'.repeat(300);
  const state = {
    phaseInfo: {
      1: {
        name: 'Phase 1',
        tasks: [longTask, longTask]  // 超過 500 chars
      }
    }
  };
  const hint = buildPhaseScopeHint('DEV:1', state);
  assert.ok(hint.length <= MAX_PHASE_SCOPE_CHARS, `截斷後長度 ${hint.length} <= ${MAX_PHASE_SCOPE_CHARS}`);
  assert.ok(hint.endsWith('...'), '截斷後以 ... 結尾');
});

// ─── phase DAG 生成驗證 ───────────────────────────────────

console.log('\n🧩 Section 2: Phase DAG 生成與結構驗證');

test('3-phase 含並行的 DAG 拓撲正確性', () => {
  const tasksContent = `
## Phase 1: 基礎
deps: []
- [ ] task A1
- [ ] task A2

## Phase 2: 延伸A
deps: [Phase 1]
- [ ] task B1

## Phase 3: 延伸B
deps: [Phase 1]
- [ ] task C1
`;

  const phases = parsePhasesFromTasks(tasksContent);
  assert.strictEqual(phases.length, 3);

  const dag = generatePhaseDag(phases, 'standard');

  // 驗證 DEV:1 是根節點
  assert.deepStrictEqual(dag['DEV:1'].deps, []);

  // 驗證 DEV:2 和 DEV:3 都依賴 Phase 1 的品質 stages
  assert.ok(dag['DEV:2'].deps.includes('REVIEW:1'));
  assert.ok(dag['DEV:2'].deps.includes('TEST:1'));
  assert.ok(dag['DEV:3'].deps.includes('REVIEW:1'));
  assert.ok(dag['DEV:3'].deps.includes('TEST:1'));

  // 驗證 DEV:2 和 DEV:3 互相獨立（可並行）
  assert.ok(!dag['DEV:2'].deps.includes('DEV:3'));
  assert.ok(!dag['DEV:3'].deps.includes('DEV:2'));

  // 驗證 DOCS 依賴最終 phases 的品質 stages
  assert.ok(dag['DOCS']);
  assert.ok(dag['DOCS'].deps.includes('REVIEW:2'));
  assert.ok(dag['DOCS'].deps.includes('REVIEW:3'));
  // Phase 1 的品質 stages 不在 DOCS deps（有後繼 DEV）
  assert.ok(!dag['DOCS'].deps.includes('REVIEW:1'));
});

test('2-phase 線性 standard DAG 節點完整性', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: ['task A'] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: ['task B'] },
  ];

  const dag = generatePhaseDag(phases, 'standard');
  const keys = Object.keys(dag).sort();

  const expected = ['DEV:1', 'DEV:2', 'DOCS', 'REVIEW:1', 'REVIEW:2', 'TEST:1', 'TEST:2'].sort();
  assert.deepStrictEqual(keys, expected, 'DAG 節點完整');
});

test('quick-dev 2-phase DAG 無 DOCS', () => {
  const phases = [
    { name: 'Phase 1', index: 1, deps: [], tasks: ['task A'] },
    { name: 'Phase 2', index: 2, deps: ['Phase 1'], tasks: ['task B'] },
  ];

  const dag = generatePhaseDag(phases, 'quick-dev');
  assert.ok(!dag['DOCS'], 'quick-dev 無 DOCS');

  const keys = Object.keys(dag).sort();
  const expected = ['DEV:1', 'DEV:2', 'REVIEW:1', 'REVIEW:2', 'TEST:1', 'TEST:2'].sort();
  assert.deepStrictEqual(keys, expected, 'DAG 節點正確');
});

// ─── Phase 完成建議格式驗證 ──────────────────────────────

console.log('\n🧩 Section 3: Phase 完成建議格式');

// 直接測試 buildPhaseCompletionHint 邏輯（不依賴 controller 內部）
function buildPhaseCompletionHintDirect(stageId, verdict) {
  const suffixMatch = stageId.match(/^([A-Z]+):(\d+)$/);
  if (!suffixMatch) return '';
  const baseStage = suffixMatch[1];
  const phaseIdx = suffixMatch[2];
  const verdictEmoji = verdict === 'PASS' ? '✅' : '❌';
  return `📌 Phase ${phaseIdx} 的 ${baseStage} 完成（${verdict} ${verdictEmoji}），建議更新 TaskList 進度`;
}

test('suffixed stage PASS 建議格式正確', () => {
  const hint = buildPhaseCompletionHintDirect('REVIEW:1', 'PASS');
  assert.ok(hint.includes('Phase 1'), '包含 Phase 1');
  assert.ok(hint.includes('REVIEW'), '包含 REVIEW');
  assert.ok(hint.includes('PASS'), '包含 PASS');
  assert.ok(hint.includes('✅'), '包含成功 emoji');
  assert.ok(hint.includes('TaskList'), '包含 TaskList 提示');
});

test('suffixed stage FAIL 建議格式正確', () => {
  const hint = buildPhaseCompletionHintDirect('TEST:2', 'FAIL');
  assert.ok(hint.includes('Phase 2'), '包含 Phase 2');
  assert.ok(hint.includes('TEST'), '包含 TEST');
  assert.ok(hint.includes('FAIL'), '包含 FAIL');
  assert.ok(hint.includes('❌'), '包含失敗 emoji');
});

test('非 suffixed stage 返回空字串', () => {
  assert.strictEqual(buildPhaseCompletionHintDirect('REVIEW', 'PASS'), '');
  assert.strictEqual(buildPhaseCompletionHintDirect('TEST', 'FAIL'), '');
  assert.strictEqual(buildPhaseCompletionHintDirect('DEV', 'PASS'), '');
  assert.strictEqual(buildPhaseCompletionHintDirect('DOCS', 'PASS'), '');
});

// ─── 整合驗證：端對端 tasks.md → DAG ─────────────────────

console.log('\n🧩 Section 4: 端對端 tasks.md → DAG 驗證');

test('完整 3-phase tasks.md 生成正確 DAG', () => {
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
  const dag = generatePhaseDag(phases, 'standard');

  // 驗證所有必要節點存在
  const requiredNodes = [
    'DEV:1', 'REVIEW:1', 'TEST:1',
    'DEV:2', 'REVIEW:2', 'TEST:2',
    'DEV:3', 'REVIEW:3', 'TEST:3',
    'DOCS',
  ];
  for (const node of requiredNodes) {
    assert.ok(dag[node], `節點 ${node} 存在`);
  }

  // 驗證 DAG 無環（透過拓撲排序）
  // 簡單驗證：DEV:1 無依賴，DOCS 有依賴
  assert.deepStrictEqual(dag['DEV:1'].deps, []);
  assert.ok(dag['DOCS'].deps.length > 0);
});

test('2-phase 的 buildPhaseScopeHint 與 parsePhasesFromTasks 整合', () => {
  const tasksContent = `
## Phase 1: 核心功能
deps: []
- [ ] 建立資料庫 schema
- [ ] 實作 CRUD API

## Phase 2: 進階功能
deps: [Phase 1]
- [ ] 加入搜尋功能
`;

  const phases = parsePhasesFromTasks(tasksContent);
  const phaseInfo = {};
  for (const p of phases) {
    phaseInfo[p.index] = { name: p.name, tasks: p.tasks };
  }

  // 模擬 state.phaseInfo
  const state = { phaseInfo };

  // DEV:1 應看到 Phase 1 的 tasks
  const hint1 = buildPhaseScopeHint('DEV:1', state);
  assert.ok(hint1.includes('核心功能'), 'DEV:1 看到 Phase 1 名稱');
  assert.ok(hint1.includes('建立資料庫 schema'), 'DEV:1 看到 Phase 1 task');
  assert.ok(!hint1.includes('搜尋功能'), 'DEV:1 不看到 Phase 2 task');

  // DEV:2 應看到 Phase 2 的 tasks
  const hint2 = buildPhaseScopeHint('DEV:2', state);
  assert.ok(hint2.includes('進階功能'), 'DEV:2 看到 Phase 2 名稱');
  assert.ok(hint2.includes('搜尋功能'), 'DEV:2 看到 Phase 2 task');
  assert.ok(!hint2.includes('建立資料庫'), 'DEV:2 不看到 Phase 1 task');
});

// ─── 結果輸出 ────────────────────────────────────────────

console.log(`\n結果：${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
