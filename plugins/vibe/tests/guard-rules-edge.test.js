#!/usr/bin/env node
/**
 * guard-rules-edge.test.js — guard-rules 邊界案例測試
 *
 * 補充測試 guard-rules.test.js 未覆蓋的邊界案例：
 * - null/undefined/特殊輸入
 * - 複合副檔名
 * - NotebookEdit 完整場景
 * - 異常 toolInput 結構
 *
 * 執行：node plugins/vibe/tests/guard-rules-edge.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

const {
  evaluate,
  isNonCodeFile,
  NON_CODE_EXTS,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'sentinel', 'guard-rules.js'));

// v4 state: evaluate() 使用 isActive(state) = state?.pipelineActive === true
const ENFORCED_STATE = {
  version: 4,
  pipelineActive: true,
  activeStages: [],
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
  retries: {},
  retryHistory: {},
  crashes: {},
  pendingRetry: null,
  meta: { initialized: true },
};

// DELEGATING 狀態（有 active stage + activeStages 更新）
function makeDelegatingState(currentStage = 'DEV') {
  const s = JSON.parse(JSON.stringify(ENFORCED_STATE));
  if (s.stages[currentStage]) s.stages[currentStage].status = 'active';
  s.activeStages = [currentStage];
  return s;
}

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

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() 邊界案例');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('null 輸入 → false', () => {
  assert.strictEqual(isNonCodeFile(null), false);
});

test('undefined 輸入 → false', () => {
  assert.strictEqual(isNonCodeFile(undefined), false);
});

test('數字輸入 → false（型別防護）', () => {
  assert.strictEqual(isNonCodeFile(123), false);
});

test('物件輸入 → false（型別防護）', () => {
  assert.strictEqual(isNonCodeFile({}), false);
});

test('只有點沒有副檔名 (.gitignore) → true', () => {
  // v1.0.43+: NON_CODE_DOTFILES 用 path.basename() 精確匹配
  assert.strictEqual(isNonCodeFile('.gitignore'), true);
});

test('複合副檔名 — 第二個是非程式碼 (.js.map) → false', () => {
  // extname() 只返回最後一個副檔名
  assert.strictEqual(isNonCodeFile('bundle.js.map'), false);
});

test('複合副檔名 — 第二個是非程式碼 (.spec.md) → true', () => {
  assert.strictEqual(isNonCodeFile('test.spec.md'), true);
});

test('路徑含空格 → 正確判斷', () => {
  assert.strictEqual(isNonCodeFile('/path with spaces/README.md'), true);
  assert.strictEqual(isNonCodeFile('/path with spaces/app.js'), false);
});

test('路徑含特殊字元 → 正確判斷', () => {
  assert.strictEqual(isNonCodeFile('/path/[id]/config.json'), true);
  assert.strictEqual(isNonCodeFile('/path/@user/main.ts'), false);
});

test('大小寫混合 — .YML', () => {
  assert.strictEqual(isNonCodeFile('config.YML'), true);
});

test('大小寫混合 — .Md', () => {
  assert.strictEqual(isNonCodeFile('README.Md'), true);
});

test('點開頭的檔案 — .env（整個檔名）', () => {
  // v1.0.43+: NON_CODE_DOTFILES 用 path.basename() 精確匹配
  assert.strictEqual(isNonCodeFile('.env'), true);
  // 'config.env' 的 basename 是 'config.env'，不在 NON_CODE_DOTFILES 中
  // extname 是 '.env'，也不在 NON_CODE_EXTS 中
  assert.strictEqual(isNonCodeFile('config.env'), false);
});

test('點開頭的檔案 — .dockerignore（整個檔名）', () => {
  // v1.0.43+: NON_CODE_DOTFILES 用 path.basename() 精確匹配
  assert.strictEqual(isNonCodeFile('.dockerignore'), true);
  // 'app.dockerignore' 的 basename 是 'app.dockerignore'，不在 NON_CODE_DOTFILES 中
  assert.strictEqual(isNonCodeFile('app.dockerignore'), false);
});

test('Windows 路徑分隔符（macOS only 不支援）', () => {
  // CLAUDE.md 架構決策：目標平台 macOS only
  // path.basename() 在 macOS 無法正確解析 Windows 路徑（已知限制）
  // 保留測試但調整為 Unix 路徑範例
  assert.strictEqual(isNonCodeFile('/Users/test/config.json'), true);
  assert.strictEqual(isNonCodeFile('/Users/test/app.js'), false);
});

test('副檔名全大寫 — .JSON', () => {
  assert.strictEqual(isNonCodeFile('package.JSON'), true);
});

test('副檔名全大寫 — .TOML', () => {
  assert.strictEqual(isNonCodeFile('Cargo.TOML'), true);
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — toolInput 異常邊界');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write — toolInput 為 null', () => {
  const result = evaluate('Write', null, ENFORCED_STATE);
  // null?.file_path 返回 undefined，傳給 isNonCodeFile 返回 false
  assert.strictEqual(result.decision, 'block');
});

test('Write — toolInput 為 undefined', () => {
  const result = evaluate('Write', undefined, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為 null', () => {
  const result = evaluate('Write', { file_path: null }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為 undefined', () => {
  const result = evaluate('Write', { file_path: undefined }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為數字（返回 block）', () => {
  // isNonCodeFile 已移除，enforced pipeline 下直接 block（不讀取 file_path）
  const result = evaluate('Write', { file_path: 123 }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為物件（返回 block）', () => {
  // isNonCodeFile 已移除，enforced pipeline 下直接 block（不讀取 file_path）
  const result = evaluate('Write', { file_path: {} }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — NotebookEdit 完整測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NotebookEdit — .ipynb (Jupyter Notebook) → 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: 'notebook.ipynb' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  // CLASSIFIED 階段：must-delegate 統一阻擋，訊息為「等待委派」
  assert.ok(result.message.includes('等待委派'));
});

test('NotebookEdit — 空 file_path → 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: '' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('NotebookEdit — 無 file_path → 阻擋', () => {
  const result = evaluate('NotebookEdit', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('NotebookEdit — .md 檔案（enforced）→ 阻擋', () => {
  // CLASSIFIED 階段：must-delegate 統一阻擋（在工具特定檢查之前）
  const result = evaluate('NotebookEdit', { file_path: 'notes.md' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'must-delegate');
});

test('NotebookEdit — .json 檔案（enforced）→ 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: 'data.json' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  // CLASSIFIED 階段：must-delegate 統一阻擋
  assert.strictEqual(result.reason, 'must-delegate');
});

test('NotebookEdit — null toolInput', () => {
  const result = evaluate('NotebookEdit', null, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — 邊界狀態測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('AskUserQuestion — toolInput 為空物件', () => {
  const result = evaluate('AskUserQuestion', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  // CLASSIFIED 階段：must-delegate 統一阻擋（在 AskUserQuestion 特定檢查之前）
  assert.strictEqual(result.reason, 'must-delegate');
});

test('AskUserQuestion — toolInput 為 null', () => {
  const result = evaluate('AskUserQuestion', null, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('EnterPlanMode — toolInput 為空物件（無條件阻擋）', () => {
  const result = evaluate('EnterPlanMode', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

test('EnterPlanMode — toolInput 為 null（無條件阻擋）', () => {
  const result = evaluate('EnterPlanMode', null, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

test('EnterPlanMode — 無 pipeline state 也阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, null);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

test('EnterPlanMode — state 為空物件也阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

test('未知工具 — toolInput 為 null', () => {
  const result = evaluate('SomeRandomTool', null, {});
  assert.strictEqual(result.decision, 'allow');
});

test('未知工具 — toolInput 為 undefined', () => {
  const result = evaluate('AnotherTool', undefined, {});
  assert.strictEqual(result.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — 錯誤訊息驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write 程式碼檔案 — CLASSIFIED 階段 must-delegate 統一訊息', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, ENFORCED_STATE);
  // CLASSIFIED 階段：must-delegate 統一阻擋，訊息不含工具名稱
  assert.ok(result.message.includes('等待委派'));
  assert.strictEqual(result.reason, 'must-delegate');
});

test('Edit 程式碼檔案 — CLASSIFIED 階段 must-delegate 統一訊息', () => {
  const result = evaluate('Edit', { file_path: 'app.ts' }, ENFORCED_STATE);
  assert.ok(result.message.includes('等待委派'));
  assert.strictEqual(result.reason, 'must-delegate');
});

test('NotebookEdit 程式碼檔案 — CLASSIFIED 階段 must-delegate 統一訊息', () => {
  const result = evaluate('NotebookEdit', { file_path: 'main.py' }, ENFORCED_STATE);
  assert.ok(result.message.includes('等待委派'));
  assert.strictEqual(result.reason, 'must-delegate');
});

test('所有阻擋訊息包含 ⛔ 符號', () => {
  const cases = [
    evaluate('Write', { file_path: 'app.js' }, ENFORCED_STATE),
    evaluate('AskUserQuestion', {}, ENFORCED_STATE),
    evaluate('EnterPlanMode', {}, ENFORCED_STATE),
  ];
  cases.forEach(result => {
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.message.includes('⛔'), `訊息應包含 ⛔: ${result.message}`);
  });
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — state 前置條件測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write 程式碼檔案 — state 為空物件 → 放行（無 initialized）', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('Write 程式碼檔案 — state 為 null → 放行', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, null);
  assert.strictEqual(result.decision, 'allow');
});

test('Write 程式碼檔案 — state 為 undefined → 放行', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, undefined);
  assert.strictEqual(result.decision, 'allow');
});

test('Write 程式碼檔案 — state 完整 enforced → 阻擋', () => {
  // v3: ENFORCED_STATE 已是 CLASSIFIED（有 DAG + pending stages）
  const result = evaluate('Write', { file_path: 'app.js' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write 程式碼檔案 — phase=DELEGATING → 放行', () => {
  const state = makeDelegatingState();
  const result = evaluate('Write', { file_path: 'app.js' }, state);
  assert.strictEqual(result.decision, 'allow');
});

test('Write 程式碼檔案 — pipelineActive=false（取消）→ 放行', () => {
  // v4: 取消透過 pipelineActive=false 實現（取代 v3 的 meta.cancelled）
  const state = {
    ...ENFORCED_STATE,
    pipelineActive: false,
  };
  const result = evaluate('Write', { file_path: 'app.js' }, state);
  assert.strictEqual(result.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n📦 NON_CODE_EXTS 完整性驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NON_CODE_EXTS 包含 .txt', () => {
  assert.ok(NON_CODE_EXTS.has('.txt'));
});

test('NON_CODE_EXTS 不包含 .env（在 NON_CODE_DOTFILES 中）', () => {
  assert.strictEqual(NON_CODE_EXTS.has('.env'), false);
});

test('NON_CODE_EXTS 包含 .toml', () => {
  assert.ok(NON_CODE_EXTS.has('.toml'));
});

test('NON_CODE_EXTS 包含 .cfg', () => {
  assert.ok(NON_CODE_EXTS.has('.cfg'));
});

test('NON_CODE_EXTS 包含 .ini', () => {
  assert.ok(NON_CODE_EXTS.has('.ini'));
});

test('NON_CODE_EXTS 不包含 .gitignore（在 NON_CODE_DOTFILES 中）', () => {
  assert.strictEqual(NON_CODE_EXTS.has('.gitignore'), false);
});

test('NON_CODE_EXTS 不包含 .dockerignore（在 NON_CODE_DOTFILES 中）', () => {
  assert.strictEqual(NON_CODE_EXTS.has('.dockerignore'), false);
});

test('NON_CODE_EXTS 包含 .csv', () => {
  assert.ok(NON_CODE_EXTS.has('.csv'));
});

test('NON_CODE_EXTS 包含 .xml', () => {
  assert.ok(NON_CODE_EXTS.has('.xml'));
});

test('NON_CODE_EXTS 為 Set 類型', () => {
  assert.ok(NON_CODE_EXTS instanceof Set);
});

test('NON_CODE_EXTS 不可變性（檢查大小）', () => {
  const size = NON_CODE_EXTS.size;
  assert.ok(size > 0);
  // 不應包含程式碼副檔名
  assert.strictEqual(NON_CODE_EXTS.has('.js'), false);
  assert.strictEqual(NON_CODE_EXTS.has('.ts'), false);
});

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

console.log('\n' + '='.repeat(55));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
