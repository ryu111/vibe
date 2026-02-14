#!/usr/bin/env node
/**
 * guard-rules.test.js — 測試 guard-rules.js 純函式邏輯
 *
 * 測試範圍：
 * - evaluate() 的所有決策分支
 * - isNonCodeFile() 的邊界案例
 * - ORCHESTRATOR_TOOLS / NON_CODE_EXTS 常數
 *
 * 執行：node plugins/vibe/tests/guard-rules.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

const {
  evaluate,
  isNonCodeFile,
  ORCHESTRATOR_TOOLS,
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
console.log('\n📋 isNonCodeFile() 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('非程式碼檔案：.md', () => {
  assert.strictEqual(isNonCodeFile('README.md'), true);
});

test('非程式碼檔案：.json', () => {
  assert.strictEqual(isNonCodeFile('package.json'), true);
});

test('非程式碼檔案：.yml', () => {
  assert.strictEqual(isNonCodeFile('.github/workflows/ci.yml'), true);
});

test('非程式碼檔案：.yaml', () => {
  assert.strictEqual(isNonCodeFile('docker-compose.yaml'), true);
});

test('非程式碼檔案：.html', () => {
  assert.strictEqual(isNonCodeFile('index.html'), true);
});

test('非程式碼檔案：.css', () => {
  assert.strictEqual(isNonCodeFile('styles/main.css'), true);
});

test('非程式碼檔案：.svg', () => {
  assert.strictEqual(isNonCodeFile('icon.svg'), true);
});

test('程式碼檔案：.js', () => {
  assert.strictEqual(isNonCodeFile('src/app.js'), false);
});

test('程式碼檔案：.ts', () => {
  assert.strictEqual(isNonCodeFile('src/index.ts'), false);
});

test('程式碼檔案：.tsx', () => {
  assert.strictEqual(isNonCodeFile('src/App.tsx'), false);
});

test('程式碼檔案：.py', () => {
  assert.strictEqual(isNonCodeFile('main.py'), false);
});

test('程式碼檔案：.go', () => {
  assert.strictEqual(isNonCodeFile('main.go'), false);
});

test('空字串路徑', () => {
  assert.strictEqual(isNonCodeFile(''), false);
});

test('無副檔名', () => {
  assert.strictEqual(isNonCodeFile('Makefile'), false);
});

test('大小寫不敏感', () => {
  assert.strictEqual(isNonCodeFile('README.MD'), true);
  assert.strictEqual(isNonCodeFile('config.JSON'), true);
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — Write/Edit/NotebookEdit 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write 非程式碼檔案 → 放行', () => {
  const result = evaluate('Write', { file_path: 'README.md' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('Edit 非程式碼檔案 → 放行', () => {
  const result = evaluate('Edit', { file_path: 'package.json' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('NotebookEdit 非程式碼檔案 → 放行', () => {
  const result = evaluate('NotebookEdit', { file_path: 'config.toml' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('Write 程式碼檔案 → 阻擋', () => {
  const result = evaluate('Write', { file_path: 'src/app.js' }, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-enforced');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('Write'));
  assert.ok(result.message.includes('vibe:developer'));
});

test('Edit 程式碼檔案 → 阻擋', () => {
  const result = evaluate('Edit', { file_path: 'src/component.tsx' }, {});
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('Edit'));
});

test('NotebookEdit 程式碼檔案 → 阻擋', () => {
  const result = evaluate('NotebookEdit', { file_path: 'notebook.ipynb' }, {});
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('NotebookEdit'));
});

test('Write 無 file_path → 阻擋', () => {
  const result = evaluate('Write', {}, {});
  assert.strictEqual(result.decision, 'block');
});

test('Write file_path 為空字串 → 阻擋', () => {
  const result = evaluate('Write', { file_path: '' }, {});
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — AskUserQuestion 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('AskUserQuestion → 阻擋', () => {
  const result = evaluate('AskUserQuestion', {}, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-auto-mode');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('自動'));
  assert.ok(result.message.includes('/vibe:cancel'));
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — EnterPlanMode 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('EnterPlanMode → 阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, {});
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-active');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('EnterPlanMode'));
  assert.ok(result.message.includes('vibe:planner'));
  assert.ok(result.message.includes('/vibe:scope'));
  assert.ok(result.message.includes('/cancel'));
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — 未知工具測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('未知工具 → 放行', () => {
  const result = evaluate('UnknownTool', {}, {});
  assert.strictEqual(result.decision, 'allow');
});

test('Read（orchestrator 工具）→ 放行', () => {
  const result = evaluate('Read', { file_path: 'src/app.js' }, {});
  assert.strictEqual(result.decision, 'allow');
});

test('Task（orchestrator 工具）→ 放行', () => {
  const result = evaluate('Task', { subagent_type: 'vibe:developer' }, {});
  assert.strictEqual(result.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n📦 常數驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('ORCHESTRATOR_TOOLS 包含必要工具', () => {
  assert.ok(ORCHESTRATOR_TOOLS.has('Task'));
  assert.ok(ORCHESTRATOR_TOOLS.has('Read'));
  assert.ok(ORCHESTRATOR_TOOLS.has('Grep'));
  assert.ok(ORCHESTRATOR_TOOLS.has('Skill'));
  assert.ok(ORCHESTRATOR_TOOLS.has('TaskCreate'));
});

test('NON_CODE_EXTS 包含常見副檔名', () => {
  assert.ok(NON_CODE_EXTS.has('.md'));
  assert.ok(NON_CODE_EXTS.has('.json'));
  assert.ok(NON_CODE_EXTS.has('.yml'));
  assert.ok(NON_CODE_EXTS.has('.yaml'));
  assert.ok(NON_CODE_EXTS.has('.html'));
  assert.ok(NON_CODE_EXTS.has('.css'));
});

test('NON_CODE_EXTS 不包含程式碼副檔名', () => {
  assert.strictEqual(NON_CODE_EXTS.has('.js'), false);
  assert.strictEqual(NON_CODE_EXTS.has('.ts'), false);
  assert.strictEqual(NON_CODE_EXTS.has('.py'), false);
  assert.strictEqual(NON_CODE_EXTS.has('.go'), false);
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
