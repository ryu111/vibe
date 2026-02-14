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

test('數字輸入 → 拋出錯誤（path.extname 不接受非字串）', () => {
  assert.throws(() => isNonCodeFile(123), /path.*string/);
});

test('物件輸入 → 拋出錯誤（path.extname 不接受非字串）', () => {
  assert.throws(() => isNonCodeFile({}), /path.*string/);
});

test('只有點沒有副檔名 (.gitignore) → false', () => {
  // path.extname('.gitignore') 返回空字串（整個是檔名不是副檔名）
  // 所以 isNonCodeFile 返回 false
  assert.strictEqual(isNonCodeFile('.gitignore'), false);
  // NON_CODE_EXTS 中的 '.gitignore' 適用於 'app.gitignore' 等情況
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
  // path.extname('.env') 返回空字串（沒有副檔名），
  // 但 NON_CODE_EXTS 包含 '.env' 作為副檔名
  // 實際上 '.env' 應該作為檔名，副檔名是空的
  // 所以這個測試原本的假設不正確
  assert.strictEqual(isNonCodeFile('.env'), false);
  // 正確用法應該是 'config.env' 或 'app/.env'
  assert.strictEqual(isNonCodeFile('config.env'), true);
});

test('點開頭的檔案 — .dockerignore（整個檔名）', () => {
  // 同上，path.extname('.dockerignore') 返回空字串
  assert.strictEqual(isNonCodeFile('.dockerignore'), false);
  // 正確用法應該是 'app.dockerignore'
  assert.strictEqual(isNonCodeFile('app.dockerignore'), true);
});

test('Windows 路徑分隔符', () => {
  assert.strictEqual(isNonCodeFile('C:\\Users\\test\\config.json'), true);
  assert.strictEqual(isNonCodeFile('C:\\Users\\test\\app.js'), false);
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
  const result = evaluate('Write', null, {});
  // null?.file_path 返回 undefined，傳給 isNonCodeFile 返回 false
  assert.strictEqual(result.decision, 'block');
});

test('Write — toolInput 為 undefined', () => {
  const result = evaluate('Write', undefined, {});
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為 null', () => {
  const result = evaluate('Write', { file_path: null }, {});
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為 undefined', () => {
  const result = evaluate('Write', { file_path: undefined }, {});
  assert.strictEqual(result.decision, 'block');
});

test('Write — file_path 為數字（拋出錯誤）', () => {
  // isNonCodeFile 內部 path.extname 會拋錯
  assert.throws(() => evaluate('Write', { file_path: 123 }, {}), /path.*string/);
});

test('Write — file_path 為物件（拋出錯誤）', () => {
  assert.throws(() => evaluate('Write', { file_path: {} }, {}), /path.*string/);
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — NotebookEdit 完整測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NotebookEdit — .ipynb (Jupyter Notebook) → 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: 'notebook.ipynb' }, {});
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('NotebookEdit'));
});

test('NotebookEdit — 空 file_path → 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: '' }, {});
  assert.strictEqual(result.decision, 'block');
});

test('NotebookEdit — 無 file_path → 阻擋', () => {
  const result = evaluate('NotebookEdit', {}, {});
  assert.strictEqual(result.decision, 'block');
});

test('NotebookEdit — .md 檔案 → 放行', () => {
  const result = evaluate('NotebookEdit', { file_path: 'notes.md' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('NotebookEdit — .json 檔案 → 放行', () => {
  const result = evaluate('NotebookEdit', { file_path: 'data.json' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('NotebookEdit — null toolInput', () => {
  const result = evaluate('NotebookEdit', null, {});
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — 邊界狀態測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('AskUserQuestion — toolInput 為空物件', () => {
  const result = evaluate('AskUserQuestion', {}, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-auto-mode');
});

test('AskUserQuestion — toolInput 為 null', () => {
  const result = evaluate('AskUserQuestion', null, {});
  assert.strictEqual(result.decision, 'block');
});

test('EnterPlanMode — toolInput 為空物件', () => {
  const result = evaluate('EnterPlanMode', {}, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-active');
});

test('EnterPlanMode — toolInput 為 null', () => {
  const result = evaluate('EnterPlanMode', null, {});
  assert.strictEqual(result.decision, 'block');
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

test('Write 程式碼檔案 — message 包含工具名稱', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, {});
  assert.ok(result.message.includes('Write'));
  assert.ok(!result.message.includes('Edit'));
  assert.ok(!result.message.includes('NotebookEdit'));
});

test('Edit 程式碼檔案 — message 包含工具名稱', () => {
  const result = evaluate('Edit', { file_path: 'app.ts' }, {});
  assert.ok(result.message.includes('Edit'));
  assert.ok(!result.message.includes('Write'));
});

test('NotebookEdit 程式碼檔案 — message 包含工具名稱', () => {
  const result = evaluate('NotebookEdit', { file_path: 'main.py' }, {});
  assert.ok(result.message.includes('NotebookEdit'));
  assert.ok(!result.message.includes('Write'), '訊息不應包含 Write');
  // 注意：錯誤訊息可能同時提到 Write|Edit|NotebookEdit 作為範例
  // 所以只驗證主要工具名稱出現
});

test('所有阻擋訊息包含 ⛔ 符號', () => {
  const cases = [
    evaluate('Write', { file_path: 'app.js' }, {}),
    evaluate('AskUserQuestion', {}, {}),
    evaluate('EnterPlanMode', {}, {}),
  ];
  cases.forEach(result => {
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.message.includes('⛔'), `訊息應包含 ⛔: ${result.message}`);
  });
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — state 參數測試（不影響決策）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write 程式碼檔案 — state 為空物件', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, {});
  assert.strictEqual(result.decision, 'block');
});

test('Write 程式碼檔案 — state 為 null', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, null);
  assert.strictEqual(result.decision, 'block');
});

test('Write 程式碼檔案 — state 為 undefined', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, undefined);
  assert.strictEqual(result.decision, 'block');
});

test('Write 程式碼檔案 — state 有複雜屬性（不影響）', () => {
  const state = {
    initialized: true,
    taskType: 'feature',
    pipelineEnforced: true,
    completed: ['PLAN', 'ARCH'],
  };
  const result = evaluate('Write', { file_path: 'app.js' }, state);
  // evaluate() 不讀取 state，純粹根據工具和檔案路徑決策
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n📦 NON_CODE_EXTS 完整性驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NON_CODE_EXTS 包含 .txt', () => {
  assert.ok(NON_CODE_EXTS.has('.txt'));
});

test('NON_CODE_EXTS 包含 .env', () => {
  assert.ok(NON_CODE_EXTS.has('.env'));
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

test('NON_CODE_EXTS 包含 .gitignore', () => {
  assert.ok(NON_CODE_EXTS.has('.gitignore'));
});

test('NON_CODE_EXTS 包含 .dockerignore', () => {
  assert.ok(NON_CODE_EXTS.has('.dockerignore'));
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
