/**
 * signals.test.js — S6 三信號驗證測試
 *
 * 測試範圍：
 * 1. collectSignals — 無 env 回傳 { lint: null, test: null }
 * 2. collectSignals — 有 env.tools.test 回傳 test.available
 * 3. collectSignals — 有 env.tools.linter 但執行失敗回傳 lint: null
 * 4. buildNodeContext — REVIEW stage 含 signals 欄位
 * 5. buildNodeContext — DEV stage 不含 signals 欄位（signals=null）
 * 6. formatNodeContext — signals 格式正確
 * 7. formatNodeContext — signals 為 null 時不輸出
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 暫時 mock HOME 目錄避免污染真實 ~/.claude ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-test-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = TMP_HOME;

// 確保 CLAUDE_DIR 存在
const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  collectSignals,
  buildNodeContext,
  formatNodeContext,
  SIGNAL_STAGES,
} = require('../scripts/lib/flow/node-context.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

const SESSION_ID = 'test-signals-' + process.pid;

// ── 基礎建構工具 ──

function makeLinearDag(stages) {
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = {
      deps: i > 0 ? [stages[i - 1]] : [],
    };
  }
  return dag;
}

function makeState(dag, overrides = {}) {
  const stages = {};
  for (const stageId of Object.keys(dag)) {
    stages[stageId] = {
      status: 'pending',
      agent: null,
      verdict: null,
      contextFile: null,
    };
  }
  return {
    version: 3,
    sessionId: SESSION_ID,
    dag,
    stages,
    retries: {},
    environment: {},
    ...overrides,
  };
}

// ============================================================
// 1. collectSignals：無 env 回傳 { lint: null, test: null }
// ============================================================

console.log('\n--- 1. collectSignals 無 env ---');

test('collectSignals: env 為 null → { lint: null, test: null }', () => {
  const signals = collectSignals(null);
  assert.strictEqual(signals.lint, null, 'lint 應為 null');
  assert.strictEqual(signals.test, null, 'test 應為 null');
});

test('collectSignals: env 為 undefined → { lint: null, test: null }', () => {
  const signals = collectSignals(undefined);
  assert.strictEqual(signals.lint, null, 'lint 應為 null');
  assert.strictEqual(signals.test, null, 'test 應為 null');
});

test('collectSignals: env 無 tools 欄位 → { lint: null, test: null }', () => {
  const signals = collectSignals({ languages: { primary: 'JavaScript' } });
  assert.strictEqual(signals.lint, null, 'lint 應為 null（無 tools.linter）');
  assert.strictEqual(signals.test, null, 'test 應為 null（無 tools.test）');
});

test('collectSignals: env.tools 為空物件 → { lint: null, test: null }', () => {
  const signals = collectSignals({ tools: {} });
  assert.strictEqual(signals.lint, null, 'lint 應為 null（tools.linter 不存在）');
  assert.strictEqual(signals.test, null, 'test 應為 null（tools.test 不存在）');
});

// ============================================================
// 2. collectSignals：有 env.tools.test 回傳 test.available
// ============================================================

console.log('\n--- 2. collectSignals test 信號 ---');

test('collectSignals: env.tools.test=jest → test.available=true', () => {
  const signals = collectSignals({ tools: { test: 'jest' } });
  assert.ok(signals.test, 'test 應有值');
  assert.strictEqual(signals.test.runner, 'jest', 'runner 為 jest');
  assert.strictEqual(signals.test.available, true, 'available 為 true');
});

test('collectSignals: env.tools.test=mocha → test.runner=mocha', () => {
  const signals = collectSignals({ tools: { test: 'mocha' } });
  assert.ok(signals.test, 'test 應有值');
  assert.strictEqual(signals.test.runner, 'mocha', 'runner 為 mocha');
  assert.strictEqual(signals.test.available, true, 'available 為 true');
});

test('collectSignals: env.tools.test=pytest → test.runner=pytest', () => {
  const signals = collectSignals({ tools: { test: 'pytest' } });
  assert.strictEqual(signals.test.runner, 'pytest', 'runner 為 pytest');
  assert.strictEqual(signals.test.available, true, 'available 為 true');
});

// ============================================================
// 3. collectSignals：有 env.tools.linter 但執行失敗 → lint: null
// ============================================================

console.log('\n--- 3. collectSignals lint 信號（執行失敗）---');

test('collectSignals: linter=eslint 但 cwd 無 eslint config → lint: null（不阻擋）', () => {
  // 在 /tmp 目錄下執行 eslint，通常會失敗或無法解析（但不應拋例外）
  const origCwd = process.cwd();
  try {
    process.chdir(TMP_HOME); // 切換到無 eslint 設定的目錄
    const signals = collectSignals({ tools: { linter: 'eslint' } });
    // 不管成功或失敗，都不應拋例外；lint 可能是 null 或有值
    assert.ok(signals.lint === null || typeof signals.lint === 'object',
      'lint 應為 null 或物件（不拋例外）');
    assert.ok(signals.lint === null || typeof signals.lint.errors === 'number',
      'lint.errors 若非 null 應為數字');
  } finally {
    process.chdir(origCwd);
  }
});

test('collectSignals: linter=unknown-linter → lint: null（不支援的 linter）', () => {
  // 不支援的 linter 不執行，信號保持 null
  const signals = collectSignals({ tools: { linter: 'stylelint' } });
  assert.strictEqual(signals.lint, null, '不支援的 linter 應回傳 null');
});

test('collectSignals: 同時有 linter 和 test → 兩者都有各自結果', () => {
  const signals = collectSignals({ tools: { linter: 'stylelint', test: 'jest' } });
  // stylelint 不支援，lint=null；test 有值
  assert.strictEqual(signals.lint, null, '不支援的 linter 應為 null');
  assert.ok(signals.test, 'test 應有值');
  assert.strictEqual(signals.test.runner, 'jest', 'test.runner 為 jest');
});

// ============================================================
// 4. buildNodeContext — REVIEW stage 含 signals 欄位
// ============================================================

console.log('\n--- 4. buildNodeContext REVIEW stage signals ---');

test('buildNodeContext: REVIEW stage → signals 欄位存在', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest' } },
  });

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);

  // signals 欄位應存在（值可能是 null 或物件，取決於 lint 是否執行成功）
  assert.ok('signals' in ctx, 'REVIEW stage 應含 signals 欄位');
  // test 信號：有 tools.test 應有值
  if (ctx.signals !== null) {
    assert.ok(ctx.signals.test, 'REVIEW signals.test 應有值（有 tools.test）');
    assert.strictEqual(ctx.signals.test.runner, 'jest', 'test.runner 為 jest');
  }
});

test('buildNodeContext: TEST stage → signals 欄位存在', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag, {
    environment: { tools: { test: 'mocha' } },
  });

  const ctx = buildNodeContext(dag, state, 'TEST', SESSION_ID);

  assert.ok('signals' in ctx, 'TEST stage 應含 signals 欄位');
});

test('buildNodeContext: QA stage → signals 欄位存在', () => {
  const dag = makeLinearDag(['DEV', 'QA']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'QA', SESSION_ID);

  assert.ok('signals' in ctx, 'QA stage 應含 signals 欄位');
});

test('buildNodeContext: SIGNAL_STAGES 包含正確的 stage', () => {
  assert.ok(SIGNAL_STAGES.has('REVIEW'), 'SIGNAL_STAGES 含 REVIEW');
  assert.ok(SIGNAL_STAGES.has('TEST'), 'SIGNAL_STAGES 含 TEST');
  assert.ok(SIGNAL_STAGES.has('QA'), 'SIGNAL_STAGES 含 QA');
  assert.ok(SIGNAL_STAGES.has('SECURITY'), 'SIGNAL_STAGES 含 SECURITY');
  assert.ok(!SIGNAL_STAGES.has('DEV'), 'SIGNAL_STAGES 不含 DEV');
  assert.ok(!SIGNAL_STAGES.has('PLAN'), 'SIGNAL_STAGES 不含 PLAN');
  assert.ok(!SIGNAL_STAGES.has('DOCS'), 'SIGNAL_STAGES 不含 DOCS');
});

// ============================================================
// 5. buildNodeContext — DEV stage 不含 signals（signals=null）
// ============================================================

console.log('\n--- 5. buildNodeContext DEV stage 不含 signals ---');

test('buildNodeContext: DEV stage → signals 為 null', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest', linter: 'eslint' } },
  });

  const ctx = buildNodeContext(dag, state, 'DEV', SESSION_ID);

  assert.strictEqual(ctx.signals, null, 'DEV stage signals 應為 null');
});

test('buildNodeContext: PLAN stage → signals 為 null', () => {
  const dag = makeLinearDag(['PLAN', 'ARCH', 'DEV']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest' } },
  });

  const ctx = buildNodeContext(dag, state, 'PLAN', SESSION_ID);

  assert.strictEqual(ctx.signals, null, 'PLAN stage signals 應為 null');
});

test('buildNodeContext: ARCH stage → signals 為 null', () => {
  const dag = makeLinearDag(['PLAN', 'ARCH', 'DEV']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest' } },
  });

  const ctx = buildNodeContext(dag, state, 'ARCH', SESSION_ID);

  assert.strictEqual(ctx.signals, null, 'ARCH stage signals 應為 null');
});

test('buildNodeContext: DOCS stage → signals 為 null', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'DOCS']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest' } },
  });

  const ctx = buildNodeContext(dag, state, 'DOCS', SESSION_ID);

  assert.strictEqual(ctx.signals, null, 'DOCS stage signals 應為 null');
});

// ============================================================
// 6. formatNodeContext — signals 格式正確
// ============================================================

console.log('\n--- 6. formatNodeContext signals 格式 ---');

test('formatNodeContext: lint + test signals → 格式正確', () => {
  const ctx = {
    node: { stage: 'REVIEW', prev: ['DEV'], next: ['TEST'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    signals: {
      lint: { errors: 0, warnings: 3 },
      test: { runner: 'jest', available: true },
    },
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.includes('signals='), 'formatNodeContext 應含 signals= 欄位');
  assert.ok(formatted.includes('lint:0err/3warn'), 'lint 信號格式正確（0err/3warn）');
  assert.ok(formatted.includes('test:jest'), 'test 信號格式正確（test:jest）');
});

test('formatNodeContext: lint errors > 0 → 正確格式', () => {
  const ctx = {
    node: { stage: 'REVIEW', prev: ['DEV'], next: ['TEST'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    signals: {
      lint: { errors: 5, warnings: 12 },
      test: null,
    },
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.includes('lint:5err/12warn'), 'lint 錯誤數正確');
  assert.ok(!formatted.includes('test:'), 'test 為 null 時不輸出 test 信號');
});

test('formatNodeContext: 只有 test signal → 格式正確', () => {
  const ctx = {
    node: { stage: 'TEST', prev: ['REVIEW'], next: ['DOCS'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    signals: {
      lint: null,
      test: { runner: 'pytest', available: true },
    },
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.includes('signals='), '應含 signals= 欄位');
  assert.ok(formatted.includes('test:pytest'), 'test 信號格式正確（test:pytest）');
  assert.ok(!formatted.includes('lint:'), 'lint 為 null 時不輸出 lint 信號');
});

test('formatNodeContext: signals 物件但 lint/test 都 null → 不輸出 signals=', () => {
  const ctx = {
    node: { stage: 'REVIEW', prev: ['DEV'], next: ['TEST'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    signals: {
      lint: null,
      test: null,
    },
  };

  const formatted = formatNodeContext(ctx);

  // lint 和 test 都 null，signalParts 為空，不應輸出 signals= 欄位
  assert.ok(!formatted.includes('signals='), '兩者都 null 時不輸出 signals=');
});

// ============================================================
// 7. formatNodeContext — signals 為 null 時不輸出
// ============================================================

console.log('\n--- 7. formatNodeContext signals=null 省略 ---');

test('formatNodeContext: signals=null → 不含 signals= 欄位', () => {
  const ctx = {
    node: { stage: 'DEV', prev: [], next: ['REVIEW'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    signals: null,
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(!formatted.includes('signals='), 'signals=null 時應省略 signals 欄位');
});

test('formatNodeContext: signals 不存在（undefined）→ 不含 signals= 欄位', () => {
  const ctx = {
    node: { stage: 'DEV', prev: [], next: ['REVIEW'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
    // signals 欄位不存在
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(!formatted.includes('signals='), 'signals 不存在時應省略 signals 欄位');
});

test('formatNodeContext: DEV stage buildNodeContext → signals=null 不輸出', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag, {
    environment: { tools: { test: 'jest' } },
  });

  const ctx = buildNodeContext(dag, state, 'DEV', SESSION_ID);
  const formatted = formatNodeContext(ctx);

  assert.strictEqual(ctx.signals, null, 'DEV context.signals 應為 null');
  assert.ok(!formatted.includes('signals='), 'DEV stage 格式化輸出不應含 signals=');
});

// ============================================================
// 清理
// ============================================================

function cleanup() {
  try {
    process.env.HOME = ORIG_HOME;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (_) {}
}

cleanup();

// ============================================================
// 結果
// ============================================================

console.log(`\n=== signals.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
