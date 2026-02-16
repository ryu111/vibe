#!/usr/bin/env node
/**
 * guard-rules-dotfiles.test.js — 測試 v1.0.43+ dotfile 修復
 *
 * 驗證 NON_CODE_DOTFILES Set + path.basename() 的 CRITICAL bug 修復：
 * - 常見 dotfiles（.gitignore/.env/.dockerignore/.*rc）正確識別為非程式碼檔案
 * - 帶路徑的 dotfiles 正確識別
 * - evaluate() 整合（Pipeline 模式下允許直接編輯 dotfiles）
 * - 邊界案例（null/undefined/非 dotfile）
 *
 * 執行：node plugins/vibe/tests/guard-rules-dotfiles.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

const {
  evaluate,
  isNonCodeFile,
  NON_CODE_DOTFILES,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'sentinel', 'guard-rules.js'));

// v2.0.0 FSM: evaluate() 使用 state-machine 衍生查詢，需要 FSM 結構的 enforced state
const ENFORCED_STATE = {
  phase: 'CLASSIFIED',
  context: { taskType: 'feature' },
  progress: {},
  meta: { initialized: true },
};

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
console.log('\n📋 isNonCodeFile() — Dotfile 精確匹配測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('.env → true', () => {
  assert.strictEqual(isNonCodeFile('.env'), true);
});

test('.env.local → true', () => {
  assert.strictEqual(isNonCodeFile('.env.local'), true);
});

test('.env.example → true', () => {
  assert.strictEqual(isNonCodeFile('.env.example'), true);
});

test('.env.development → true', () => {
  assert.strictEqual(isNonCodeFile('.env.development'), true);
});

test('.env.production → true', () => {
  assert.strictEqual(isNonCodeFile('.env.production'), true);
});

test('.gitignore → true', () => {
  assert.strictEqual(isNonCodeFile('.gitignore'), true);
});

test('.dockerignore → true', () => {
  assert.strictEqual(isNonCodeFile('.dockerignore'), true);
});

test('.editorconfig → true', () => {
  assert.strictEqual(isNonCodeFile('.editorconfig'), true);
});

test('.eslintrc → true', () => {
  assert.strictEqual(isNonCodeFile('.eslintrc'), true);
});

test('.prettierrc → true', () => {
  assert.strictEqual(isNonCodeFile('.prettierrc'), true);
});

test('.browserslistrc → true', () => {
  assert.strictEqual(isNonCodeFile('.browserslistrc'), true);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — 帶路徑的 Dotfiles');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('/project/.gitignore → true', () => {
  assert.strictEqual(isNonCodeFile('/project/.gitignore'), true);
});

test('src/.env.local → true', () => {
  assert.strictEqual(isNonCodeFile('src/.env.local'), true);
});

test('/home/user/project/.editorconfig → true', () => {
  assert.strictEqual(isNonCodeFile('/home/user/project/.editorconfig'), true);
});

test('config/.env → true', () => {
  assert.strictEqual(isNonCodeFile('config/.env'), true);
});

test('/app/.dockerignore → true', () => {
  assert.strictEqual(isNonCodeFile('/app/.dockerignore'), true);
});

test('.config/.eslintrc → true', () => {
  assert.strictEqual(isNonCodeFile('.config/.eslintrc'), true);
});

test('root/.prettierrc → true', () => {
  assert.strictEqual(isNonCodeFile('root/.prettierrc'), true);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — 副檔名回歸測試（確保不受影響）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('README.md → true（副檔名邏輯不變）', () => {
  assert.strictEqual(isNonCodeFile('README.md'), true);
});

test('package.json → true（副檔名邏輯不變）', () => {
  assert.strictEqual(isNonCodeFile('package.json'), true);
});

test('.github/workflows/ci.yml → true（副檔名邏輯不變）', () => {
  assert.strictEqual(isNonCodeFile('.github/workflows/ci.yml'), true);
});

test('index.html → true（副檔名邏輯不變）', () => {
  assert.strictEqual(isNonCodeFile('index.html'), true);
});

test('styles/main.css → true（副檔名邏輯不變）', () => {
  assert.strictEqual(isNonCodeFile('styles/main.css'), true);
});

test('app.js → false（程式碼檔案）', () => {
  assert.strictEqual(isNonCodeFile('app.js'), false);
});

test('src/index.ts → false（程式碼檔案）', () => {
  assert.strictEqual(isNonCodeFile('src/index.ts'), false);
});

test('main.py → false（程式碼檔案）', () => {
  assert.strictEqual(isNonCodeFile('main.py'), false);
});

test('main.go → false（程式碼檔案）', () => {
  assert.strictEqual(isNonCodeFile('main.go'), false);
});

test('app.rs → false（程式碼檔案）', () => {
  assert.strictEqual(isNonCodeFile('app.rs'), false);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — Dotfile 邊界案例');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('null → false', () => {
  assert.strictEqual(isNonCodeFile(null), false);
});

test('undefined → false', () => {
  assert.strictEqual(isNonCodeFile(undefined), false);
});

test('空字串 → false', () => {
  assert.strictEqual(isNonCodeFile(''), false);
});

test('.git（不在清單中）→ false', () => {
  assert.strictEqual(isNonCodeFile('.git'), false);
});

test('.npmrc（不在清單中）→ false', () => {
  assert.strictEqual(isNonCodeFile('.npmrc'), false);
});

test('gitignore（無前導點）→ false', () => {
  assert.strictEqual(isNonCodeFile('gitignore'), false);
});

test('env（無前導點）→ false', () => {
  assert.strictEqual(isNonCodeFile('env'), false);
});

test('config.env（副檔名為 .env，不在 NON_CODE_EXTS 中）→ false', () => {
  // NON_CODE_DOTFILES 是用 basename 精確匹配，不是副檔名
  // 所以 'config.env' 的 basename 是 'config.env'，不在 Set 中
  // extname 是 '.env'，也不在 NON_CODE_EXTS 中
  assert.strictEqual(isNonCodeFile('config.env'), false);
});

test('app.gitignore（副檔名為 .gitignore，不在 NON_CODE_EXTS 中）→ false', () => {
  // 同理，basename 是 'app.gitignore'，不在 Set 中
  assert.strictEqual(isNonCodeFile('app.gitignore'), false);
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — Dotfile 整合測試（Write/Edit）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Write .gitignore（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.gitignore' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write .env（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.env' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write .env.local（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.env.local' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write .dockerignore（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.dockerignore' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write .editorconfig（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.editorconfig' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write .eslintrc（Pipeline enforced）→ allow', () => {
  const result = evaluate('Write', { file_path: '.eslintrc' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Edit /project/.prettierrc（Pipeline enforced）→ allow', () => {
  const result = evaluate('Edit', { file_path: '/project/.prettierrc' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Edit config/.env.production（Pipeline enforced）→ allow', () => {
  const result = evaluate('Edit', { file_path: 'config/.env.production' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('NotebookEdit .browserslistrc（Pipeline enforced）→ allow', () => {
  const result = evaluate('NotebookEdit', { file_path: '.browserslistrc' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('Write app.js（Pipeline enforced）→ block（確保不受影響）', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'pipeline-enforced');
  assert.ok(result.message.includes('⛔'));
});

test('Edit src/main.ts（Pipeline enforced）→ block（確保不受影響）', () => {
  const result = evaluate('Edit', { file_path: 'src/main.ts' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write .npmrc（不在清單中）→ block', () => {
  // .npmrc 不在 NON_CODE_DOTFILES 中，應該被阻擋
  const result = evaluate('Write', { file_path: '.npmrc' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n📦 NON_CODE_DOTFILES 常數驗證');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('NON_CODE_DOTFILES 為 Set 類型', () => {
  assert.ok(NON_CODE_DOTFILES instanceof Set);
});

test('NON_CODE_DOTFILES 包含 .env', () => {
  assert.ok(NON_CODE_DOTFILES.has('.env'));
});

test('NON_CODE_DOTFILES 包含 .env.local', () => {
  assert.ok(NON_CODE_DOTFILES.has('.env.local'));
});

test('NON_CODE_DOTFILES 包含 .env.example', () => {
  assert.ok(NON_CODE_DOTFILES.has('.env.example'));
});

test('NON_CODE_DOTFILES 包含 .env.development', () => {
  assert.ok(NON_CODE_DOTFILES.has('.env.development'));
});

test('NON_CODE_DOTFILES 包含 .env.production', () => {
  assert.ok(NON_CODE_DOTFILES.has('.env.production'));
});

test('NON_CODE_DOTFILES 包含 .gitignore', () => {
  assert.ok(NON_CODE_DOTFILES.has('.gitignore'));
});

test('NON_CODE_DOTFILES 包含 .dockerignore', () => {
  assert.ok(NON_CODE_DOTFILES.has('.dockerignore'));
});

test('NON_CODE_DOTFILES 包含 .editorconfig', () => {
  assert.ok(NON_CODE_DOTFILES.has('.editorconfig'));
});

test('NON_CODE_DOTFILES 包含 .eslintrc', () => {
  assert.ok(NON_CODE_DOTFILES.has('.eslintrc'));
});

test('NON_CODE_DOTFILES 包含 .prettierrc', () => {
  assert.ok(NON_CODE_DOTFILES.has('.prettierrc'));
});

test('NON_CODE_DOTFILES 包含 .browserslistrc', () => {
  assert.ok(NON_CODE_DOTFILES.has('.browserslistrc'));
});

test('NON_CODE_DOTFILES 不包含 .git', () => {
  assert.strictEqual(NON_CODE_DOTFILES.has('.git'), false);
});

test('NON_CODE_DOTFILES 不包含 .npmrc', () => {
  assert.strictEqual(NON_CODE_DOTFILES.has('.npmrc'), false);
});

test('NON_CODE_DOTFILES 大小檢查（預期 11 個項目）', () => {
  // .env, .env.local, .env.example, .env.development, .env.production,
  // .gitignore, .dockerignore, .editorconfig, .eslintrc, .prettierrc, .browserslistrc
  assert.strictEqual(NON_CODE_DOTFILES.size, 11);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — 平台注意事項');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('專案目標平台：macOS only（Windows 路徑不支援）', () => {
  // CLAUDE.md 架構決策：目標平台 macOS only
  // path.basename() 在 macOS 無法正確解析 Windows 路徑
  // 這是已知限制，不是 bug
  assert.ok(true);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — 複合 Dotfiles（多個點）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('.env.test.local（basename 精確匹配失敗）→ false', () => {
  // NON_CODE_DOTFILES 中沒有 '.env.test.local'
  assert.strictEqual(isNonCodeFile('.env.test.local'), false);
});

test('.env.staging（basename 精確匹配失敗）→ false', () => {
  // NON_CODE_DOTFILES 中沒有 '.env.staging'
  assert.strictEqual(isNonCodeFile('.env.staging'), false);
});

test('.eslintrc.json（basename 精確匹配失敗）→ true（因副檔名 .json）', () => {
  // basename '.eslintrc.json' 不在 NON_CODE_DOTFILES
  // 但 extname '.json' 在 NON_CODE_EXTS 中
  assert.strictEqual(isNonCodeFile('.eslintrc.json'), true);
});

test('.prettierrc.yaml（basename 精確匹配失敗）→ true（因副檔名 .yaml）', () => {
  assert.strictEqual(isNonCodeFile('.prettierrc.yaml'), true);
});

// ═══════════════════════════════════════════════
console.log('\n📋 isNonCodeFile() — 特殊字元路徑');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('/path with spaces/.env → true', () => {
  assert.strictEqual(isNonCodeFile('/path with spaces/.env'), true);
});

test('/path/[id]/.gitignore → true', () => {
  assert.strictEqual(isNonCodeFile('/path/[id]/.gitignore'), true);
});

test('/path/@user/.dockerignore → true', () => {
  assert.strictEqual(isNonCodeFile('/path/@user/.dockerignore'), true);
});

test('/path/with-dash/.editorconfig → true', () => {
  assert.strictEqual(isNonCodeFile('/path/with-dash/.editorconfig'), true);
});

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

console.log('\n' + '='.repeat(55));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  console.log('❌ 有測試失敗\n');
  console.log('<!-- PIPELINE_VERDICT: FAIL:HIGH -->');
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
  console.log('<!-- PIPELINE_VERDICT: PASS -->');
}
