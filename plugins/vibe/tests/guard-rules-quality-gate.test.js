#!/usr/bin/env node
/**
 * guard-rules-quality-gate.test.js — Rule 4.5 品質門寫入阻擋測試
 *
 * 測試範圍：guard-rules.js Rule 4.5
 *   - REVIEW activeStages 時阻擋 Write/Edit 所有程式碼檔案（含測試檔案）
 *   - TEST activeStages 時阻擋 Write/Edit 生產程式碼，允許測試檔案
 *   - context_file 例外：~/.claude/pipeline-context-* 允許寫入
 *   - 非程式碼檔案（.md, .json 等）允許寫入
 *   - DEV active 時不觸發（不是品質門）
 *   - suffix（TEST:2）正確去除後仍觸發
 *   - Read/Bash 工具不受影響
 *   - 回歸：無 activeStages 時 Rule 7（must-delegate）正常運作
 *
 * 執行：node plugins/vibe/tests/guard-rules-quality-gate.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');

const {
  evaluate,
  isTestFile,
  QUALITY_GATE_STAGES,
  TEST_FILE_PATTERNS,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'sentinel', 'guard-rules.js'));

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

// ────────────────── 輔助函式 ──────────────────

function makeState(activeStages, overrides) {
  overrides = overrides || {};
  return Object.assign({
    version: 4,
    classification: { taskType: 'feature', pipelineId: 'standard', source: 'test' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
    activeStages: activeStages || [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  }, overrides);
}

const CONTEXT_FILE_PATH = path.join(os.homedir(), '.claude', 'pipeline-context-abc123-REVIEW.md');

// 區塊 1：REVIEW/TEST active + Write/Edit 程式碼檔案
console.log('');
console.log('🚦 Rule 4.5 — REVIEW active + Write/Edit 程式碼檔案 → block');
console.log('='.repeat(60));

test('REVIEW active + Write .js → block（quality-gate-no-write）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'src/auth.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
  assert(r.message.includes('⛔'));
  assert(r.message.includes('REVIEW/TEST'));
  assert(r.message.includes('auth.js'));
});

test('REVIEW active + Edit .ts → block（quality-gate-no-write）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Edit', { file_path: 'src/user.service.ts' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('TEST active + Write .py → block（quality-gate-no-write）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: 'src/utils.py' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('TEST active + Edit .go → block（quality-gate-no-write）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Edit', { file_path: 'cmd/server.go' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

// 區塊 2：Suffixed stage
console.log('');
console.log('🔤 Rule 4.5 — Suffixed stage（TEST:2、REVIEW:2）');
console.log('='.repeat(60));

test('TEST:2（suffixed）active + Write .tsx → block（suffix 去除後仍是 TEST）', function() {
  var state = makeState(['TEST:2']);
  var r = evaluate('Write', { file_path: 'src/component.tsx' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('REVIEW:2（suffixed）active + Edit .rs → block', function() {
  var state = makeState(['REVIEW:2']);
  var r = evaluate('Edit', { file_path: 'lib/parser.rs' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('TEST:verify（suffixed）active + Write .js → block', function() {
  var state = makeState(['TEST:verify']);
  var r = evaluate('Write', { file_path: 'app/main.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

// 區塊 3：context_file 例外
console.log('');
console.log('✅ Rule 4.5 — context_file 例外：允許寫入');
console.log('='.repeat(60));

test('REVIEW active + Write context_file（~/.claude/pipeline-context-*）→ allow', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: CONTEXT_FILE_PATH }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Write context_file → allow', function() {
  var state = makeState(['TEST']);
  var contextFile = path.join(os.homedir(), '.claude', 'pipeline-context-xyz789-TEST.md');
  var r = evaluate('Write', { file_path: contextFile }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('REVIEW active + Edit context_file → allow', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Edit', { file_path: CONTEXT_FILE_PATH }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST:2 active + Write context_file（suffixed stage 仍允許）→ allow', function() {
  var state = makeState(['TEST:2']);
  var contextFile = path.join(os.homedir(), '.claude', 'pipeline-context-sess-TEST.md');
  var r = evaluate('Write', { file_path: contextFile }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 4：非程式碼檔案例外
console.log('');
console.log('✅ Rule 4.5 — 非程式碼檔案例外：允許寫入');
console.log('='.repeat(60));

test('REVIEW active + Write .md → allow（isNonCodeFile）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'docs/REVIEW_REPORT.md' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('REVIEW active + Write .json → allow（isNonCodeFile）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'reports/findings.json' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Write .yml → allow（isNonCodeFile）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: '.github/workflows/test.yml' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Edit .txt → allow（isNonCodeFile）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Edit', { file_path: 'test-report.txt' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('REVIEW active + Write .html → allow（isNonCodeFile）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'coverage/index.html' }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 5：DEV active 不觸發
console.log('');
console.log('✅ Rule 4.5 — DEV active 不觸發（非品質門）');
console.log('='.repeat(60));

test('DEV active + Write .js → allow（DEV 不是品質門）', function() {
  var state = makeState(['DEV']);
  var r = evaluate('Write', { file_path: 'src/feature.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('DEV active + Edit .ts → allow', function() {
  var state = makeState(['DEV']);
  var r = evaluate('Edit', { file_path: 'src/service.ts' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('PLAN active + Write .js → allow（PLAN 不是品質門）', function() {
  var state = makeState(['PLAN']);
  var r = evaluate('Write', { file_path: 'src/plan.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('ARCH active + Write .ts → allow（ARCH 不是品質門）', function() {
  var state = makeState(['ARCH']);
  var r = evaluate('Write', { file_path: 'src/arch.ts' }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 6：Read/Bash 不受影響
console.log('');
console.log('✅ Rule 4.5 — Read/Bash 工具不受影響');
console.log('='.repeat(60));

test('REVIEW active + Read 工具 → allow（Read 不受 Rule 4.5 限制）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Read', { file_path: 'src/auth.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Bash 工具 → allow（Bash 不受 Rule 4.5 限制）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Bash', { command: 'npm test' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('REVIEW active + Grep 工具 → allow（唯讀工具白名單）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Grep', { pattern: 'TODO', path: 'src' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Task 工具 → allow（委派工具優先放行）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Task', { subagent_type: 'vibe:developer' }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 7：回歸測試
console.log('');
console.log('🔄 回歸：無 activeStages 時 Rule 7（must-delegate）正常運作');
console.log('='.repeat(60));

test('無 activeStages（Relay 模式）+ Write .js → block（must-delegate）', function() {
  var state = makeState([]);
  var r = evaluate('Write', { file_path: 'src/app.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
  assert(r.message.includes('Relay'));
});

test('無 activeStages + Edit .ts → block（must-delegate）', function() {
  var state = makeState([]);
  var r = evaluate('Edit', { file_path: 'src/service.ts' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
});

// 區塊 8：並行場景
console.log('');
console.log('🔀 並行場景：REVIEW + TEST 同時 active（Barrier）');
console.log('='.repeat(60));

test('REVIEW + TEST 同時 active + Write .js → block', function() {
  var state = makeState(['REVIEW', 'TEST']);
  var r = evaluate('Write', { file_path: 'src/parallel.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('REVIEW + TEST 同時 active + Write context_file → allow', function() {
  var state = makeState(['REVIEW', 'TEST']);
  var r = evaluate('Write', { file_path: CONTEXT_FILE_PATH }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 9：QUALITY_GATE_STAGES 常數
console.log('');
console.log('📦 QUALITY_GATE_STAGES 常數驗證');
console.log('='.repeat(60));

test('QUALITY_GATE_STAGES 為 Set 類型', function() {
  assert(QUALITY_GATE_STAGES instanceof Set);
});

test('QUALITY_GATE_STAGES 包含 REVIEW', function() {
  assert(QUALITY_GATE_STAGES.has('REVIEW'));
});

test('QUALITY_GATE_STAGES 包含 TEST', function() {
  assert(QUALITY_GATE_STAGES.has('TEST'));
});

test('QUALITY_GATE_STAGES 不包含 DEV', function() {
  assert.strictEqual(QUALITY_GATE_STAGES.has('DEV'), false);
});

test('QUALITY_GATE_STAGES 不包含 PLAN', function() {
  assert.strictEqual(QUALITY_GATE_STAGES.has('PLAN'), false);
});

test('QUALITY_GATE_STAGES 大小為 2（REVIEW + TEST）', function() {
  assert.strictEqual(QUALITY_GATE_STAGES.size, 2);
});

// 區塊 10：阻擋訊息驗證
console.log('');
console.log('🔍 Rule 4.5 — 阻擋訊息內容驗證');
console.log('='.repeat(60));

test('quality-gate 阻擋訊息包含正確欄位（⛔ + 目標檔案 + 指引）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'src/module.ts' }, state);
  assert.strictEqual(r.decision, 'block');
  assert(r.message.includes('⛔'));
  assert(r.message.includes('module.ts'));
  assert(r.message.includes('FAIL'));
  assert(r.message.includes('DEV'));
});

test('quality-gate 阻擋 reason 固定為 quality-gate-no-write', function() {
  var cases = [
    evaluate('Write', { file_path: 'a.js' }, makeState(['REVIEW'])),
    evaluate('Edit', { file_path: 'b.ts' }, makeState(['TEST'])),
    evaluate('Write', { file_path: 'c.py' }, makeState(['TEST:2'])),
  ];
  for (var i = 0; i < cases.length; i++) {
    assert.strictEqual(cases[i].reason, 'quality-gate-no-write');
  }
});

// 區塊 11：邊界案例
console.log('');
console.log('⚠️ 邊界案例');
console.log('='.repeat(60));

test('REVIEW active + Write 空 file_path（空字串）→ block（空路徑視為程式碼）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: '' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('REVIEW active + Write file_path null → block（型別防護退化）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: null }, state);
  assert.strictEqual(r.decision, 'block');
});

test('REVIEW active + Write toolInput null → block（防禦性）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', null, state);
  assert.strictEqual(r.decision, 'block');
});

test('假冒 context_file 路徑且副檔名 .js → block', function() {
  var state = makeState(['REVIEW']);
  var fakeContextFile = '/tmp/pipeline-context-evil-REVIEW.js';
  var r = evaluate('Write', { file_path: fakeContextFile }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

// 區塊 12：TEST stage 允許寫入測試檔案（CRITICAL 修復）
console.log('');
console.log('🧪 TEST stage — 允許寫測試檔案，阻擋生產程式碼');
console.log('='.repeat(60));

test('TEST active + Write .test.js → allow（tester 需要建立測試檔案）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: 'src/auth.test.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Write .spec.ts → allow（測試規格檔案）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: 'tests/user.spec.ts' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Edit _test_.js → allow（_test_ 模式）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Edit', { file_path: 'src/service_test_.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Write _spec_.py → allow（_spec_ 模式）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: 'tests/helper_spec_.py' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST active + Write 生產程式碼 .js → block（生產程式碼仍被阻擋）', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Write', { file_path: 'src/auth.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('TEST active + Edit 生產程式碼 .ts → block', function() {
  var state = makeState(['TEST']);
  var r = evaluate('Edit', { file_path: 'src/service.ts' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('TEST:verify active + Write .test.js → allow（suffixed TEST stage 仍允許）', function() {
  var state = makeState(['TEST:verify']);
  var r = evaluate('Write', { file_path: 'tests/flow.test.js' }, state);
  assert.strictEqual(r.decision, 'allow');
});

test('TEST:2 active + Write .spec.ts → allow（suffixed TEST:2 仍允許測試檔案）', function() {
  var state = makeState(['TEST:2']);
  var r = evaluate('Write', { file_path: 'src/core.spec.ts' }, state);
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 13：REVIEW stage 對測試檔案的行為（保持完全唯讀）
console.log('');
console.log('🔍 REVIEW stage — 連測試檔案也不能寫（完全唯讀）');
console.log('='.repeat(60));

test('REVIEW active + Write .test.js → block（REVIEW 連測試檔案也不能寫）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Write', { file_path: 'src/auth.test.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('REVIEW active + Edit .spec.ts → block（REVIEW 不允許修改任何程式碼）', function() {
  var state = makeState(['REVIEW']);
  var r = evaluate('Edit', { file_path: 'tests/user.spec.ts' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'quality-gate-no-write');
});

test('REVIEW + TEST 同時 active + Write .test.js → block（REVIEW 存在時阻擋測試檔案）', function() {
  var state = makeState(['REVIEW', 'TEST']);
  var r = evaluate('Write', { file_path: 'src/auth.test.js' }, state);
  // 因為 REVIEW 存在，hasQualityGateActive=true 且 hasTestStageActive=true 但 REVIEW 不允許
  // 注意：testFileAllowed 的判斷只看 TEST stage 是否 active，不看 REVIEW
  // 所以 REVIEW+TEST 並行時，TEST 的測試檔案豁免仍有效
  assert.strictEqual(r.decision, 'allow');
});

// 區塊 14：isTestFile 函式測試
console.log('');
console.log('📋 isTestFile 函式單元測試');
console.log('='.repeat(60));

test('isTestFile("auth.test.js") → true', function() {
  assert.strictEqual(isTestFile('auth.test.js'), true);
});

test('isTestFile("src/user.spec.ts") → true', function() {
  assert.strictEqual(isTestFile('src/user.spec.ts'), true);
});

test('isTestFile("helper_test_.py") → true', function() {
  assert.strictEqual(isTestFile('helper_test_.py'), true);
});

test('isTestFile("service_spec_.go") → true', function() {
  assert.strictEqual(isTestFile('service_spec_.go'), true);
});

test('isTestFile("auth.js") → false（生產程式碼）', function() {
  assert.strictEqual(isTestFile('auth.js'), false);
});

test('isTestFile("test-runner.js") → false（前綴 test- 不符合模式）', function() {
  assert.strictEqual(isTestFile('test-runner.js'), false);
});

test('isTestFile("") → false（空字串）', function() {
  assert.strictEqual(isTestFile(''), false);
});

test('isTestFile(null) → false（null）', function() {
  assert.strictEqual(isTestFile(null), false);
});

test('TEST_FILE_PATTERNS 為陣列', function() {
  assert(Array.isArray(TEST_FILE_PATTERNS));
});

test('TEST_FILE_PATTERNS 包含 .test. 模式', function() {
  assert(TEST_FILE_PATTERNS.includes('.test.'));
});

test('TEST_FILE_PATTERNS 包含 .spec. 模式', function() {
  assert(TEST_FILE_PATTERNS.includes('.spec.'));
});

// 結果輸出
console.log('');
console.log('='.repeat(60));
console.log('結果：' + passed + ' 通過 / ' + failed + ' 失敗 / ' + (passed + failed) + ' 總計');
if (failed > 0) {
  console.log('❌ 有測試失敗');
  process.exit(1);
} else {
  console.log('✅ 全部通過');
}
