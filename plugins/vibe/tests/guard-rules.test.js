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
  evaluateBashDanger,
  detectBashWriteTarget,
  NON_CODE_EXTS,
  DANGER_PATTERNS,
  WRITE_PATTERNS,
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

test('Write 程式碼檔案 → 阻擋（CLASSIFIED must-delegate）', () => {
  const result = evaluate('Write', { file_path: 'src/app.js' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  // CLASSIFIED 階段：must-delegate 統一阻擋（在工具特定檢查之前）
  assert.strictEqual(result.reason, 'must-delegate');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('等待委派'));
});

test('Edit 程式碼檔案 → 阻擋（CLASSIFIED must-delegate）', () => {
  const result = evaluate('Edit', { file_path: 'src/component.tsx' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('等待委派'));
});

test('NotebookEdit 程式碼檔案 → 阻擋（CLASSIFIED must-delegate）', () => {
  const result = evaluate('NotebookEdit', { file_path: 'notebook.ipynb' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('等待委派'));
});

test('Write 無 file_path → 阻擋', () => {
  const result = evaluate('Write', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

test('Write file_path 為空字串 → 阻擋', () => {
  const result = evaluate('Write', { file_path: '' }, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — AskUserQuestion 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('AskUserQuestion → 阻擋（CLASSIFIED must-delegate）', () => {
  const result = evaluate('AskUserQuestion', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  // CLASSIFIED 階段：must-delegate 統一阻擋（在 AskUserQuestion 特定檢查之前）
  assert.strictEqual(result.reason, 'must-delegate');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('等待委派'));
});

test('AskUserQuestion — PLAN 階段放行（需 DELEGATING phase）', () => {
  // CLASSIFIED 階段 must-delegate 會先阻擋，PLAN 放行只在 DELEGATING 有效
  const planDelegatingState = {
    phase: 'DELEGATING',
    context: { taskType: 'feature' },
    progress: { currentStage: 'PLAN' },
    meta: { initialized: true },
  };
  const result = evaluate('AskUserQuestion', {}, planDelegatingState);
  assert.strictEqual(result.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n🛡️ evaluate() — EnterPlanMode 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('EnterPlanMode → 無條件阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
  assert.ok(result.message.includes('⛔'));
  assert.ok(result.message.includes('EnterPlanMode'));
  assert.ok(result.message.includes('/vibe:scope'));
});

test('EnterPlanMode → 無 state 也阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, null);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

test('EnterPlanMode → phase=IDLE 也阻擋', () => {
  const result = evaluate('EnterPlanMode', {}, {
    phase: 'IDLE',
    context: { taskType: 'quickfix' },
    progress: {},
    meta: { initialized: true },
  });
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'plan-mode-disabled');
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
console.log('\n💣 evaluateBashDanger() — 危險指令偵測');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('DANGER_PATTERNS 匯出 8 個模式', () => {
  assert.strictEqual(DANGER_PATTERNS.length, 8);
});

test('rm -rf / → block', () => {
  const r = evaluateBashDanger('rm -rf / ');
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.matchedPattern, 'rm -rf /');
});

test('rm -fr / → block', () => {
  const r = evaluateBashDanger('rm -fr / ');
  assert.strictEqual(r.decision, 'block');
});

test('DROP TABLE users → block', () => {
  const r = evaluateBashDanger('DROP TABLE users');
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.matchedPattern, 'DROP TABLE/DATABASE');
});

test('DROP DATABASE → block', () => {
  const r = evaluateBashDanger('DROP DATABASE mydb');
  assert.strictEqual(r.decision, 'block');
});

test('git push --force main → block', () => {
  const r = evaluateBashDanger('git push --force main');
  assert.strictEqual(r.decision, 'block');
});

test('git push -f master → block', () => {
  const r = evaluateBashDanger('git push -f master');
  assert.strictEqual(r.decision, 'block');
});

test('chmod 777 → block', () => {
  const r = evaluateBashDanger('chmod 777 /etc/passwd');
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.matchedPattern, 'chmod 777');
});

test('mkfs → block', () => {
  const r = evaluateBashDanger('mkfs /dev/sda1');
  assert.strictEqual(r.decision, 'block');
});

test('dd of=/dev/sda → block', () => {
  const r = evaluateBashDanger('dd if=/dev/zero of=/dev/sda');
  assert.strictEqual(r.decision, 'block');
});

test('> /dev/sda → block', () => {
  const r = evaluateBashDanger('cat file > /dev/sda');
  assert.strictEqual(r.decision, 'block');
});

test('安全指令 ls -la → null', () => {
  assert.strictEqual(evaluateBashDanger('ls -la'), null);
});

test('安全指令 npm install → null', () => {
  assert.strictEqual(evaluateBashDanger('npm install'), null);
});

test('安全指令 git push origin feature → null', () => {
  assert.strictEqual(evaluateBashDanger('git push origin feature'), null);
});

test('空指令 → null', () => {
  assert.strictEqual(evaluateBashDanger(''), null);
});

// ═══════════════════════════════════════════════
console.log('\n📝 detectBashWriteTarget() — 寫檔繞過偵測');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('WRITE_PATTERNS 匯出 3 個模式', () => {
  assert.strictEqual(WRITE_PATTERNS.length, 3);
});

test('echo > src/app.js → block（程式碼檔案）', () => {
  const r = detectBashWriteTarget("echo 'x' > src/app.js");
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'bash-write-bypass');
  assert.ok(r.message.includes('src/app.js'));
});

test('cat > utils.py → block', () => {
  const r = detectBashWriteTarget('cat something > utils.py');
  assert.strictEqual(r.decision, 'block');
});

test('printf >> server.go → block', () => {
  const r = detectBashWriteTarget('printf "package main" >> server.go');
  assert.strictEqual(r.decision, 'block');
});

test('echo > README.md → null（非程式碼檔案）', () => {
  assert.strictEqual(detectBashWriteTarget('echo "# title" > README.md'), null);
});

test('echo > config.json → null（非程式碼檔案）', () => {
  assert.strictEqual(detectBashWriteTarget('echo "{}" > config.json'), null);
});

test('tee src/index.ts → block', () => {
  const r = detectBashWriteTarget('npm list | tee src/index.ts');
  assert.strictEqual(r.decision, 'block');
});

test('tee -a output.md → null（非程式碼檔案）', () => {
  assert.strictEqual(detectBashWriteTarget('echo "log" | tee -a output.md'), null);
});

test('sed -i src/file.js → block', () => {
  const r = detectBashWriteTarget("sed -i '' 's/foo/bar/' src/file.js");
  assert.strictEqual(r.decision, 'block');
});

test('npm run build > output.log → null（非寫入指令）', () => {
  assert.strictEqual(detectBashWriteTarget('npm run build > output.log'), null);
});

test('git diff → null', () => {
  assert.strictEqual(detectBashWriteTarget('git diff'), null);
});

test('空指令 → null', () => {
  assert.strictEqual(detectBashWriteTarget(''), null);
});

// ═══════════════════════════════════════════════
console.log('\n🔗 evaluate() — Bash 整合測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

test('Bash danger — 無 pipeline state 也阻擋（無條件）', () => {
  const r = evaluate('Bash', { command: 'rm -rf / ' }, null);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'danger-pattern');
});

test('Bash danger — 空 state 也阻擋', () => {
  const r = evaluate('Bash', { command: 'DROP TABLE x' }, {});
  assert.strictEqual(r.decision, 'block');
});

test('Bash 安全指令 — CLASSIFIED → must-delegate 阻擋', () => {
  // CLASSIFIED 階段：must-delegate 統一阻擋所有非 Task/Skill 工具
  const r = evaluate('Bash', { command: 'npm test' }, ENFORCED_STATE);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
});

test('Bash 安全指令 — DELEGATING → allow', () => {
  const delegatingState = {
    phase: 'DELEGATING',
    context: { taskType: 'feature' },
    progress: {},
    meta: { initialized: true },
  };
  const r = evaluate('Bash', { command: 'npm test' }, delegatingState);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash 寫入程式碼 — CLASSIFIED → must-delegate（優先於 bash-write-bypass）', () => {
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, ENFORCED_STATE);
  assert.strictEqual(r.decision, 'block');
  // must-delegate 在 bash-write-bypass 之前觸發
  assert.strictEqual(r.reason, 'must-delegate');
});

test('Bash 寫入非程式碼 — CLASSIFIED → must-delegate 阻擋', () => {
  // CLASSIFIED 階段：所有 Bash 操作都被 must-delegate 阻擋
  const r = evaluate('Bash', { command: 'echo "log" > notes.md' }, ENFORCED_STATE);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
});

test('Bash 寫入 — 委派中（DELEGATING）→ allow', () => {
  const delegatingState = {
    phase: 'DELEGATING',
    context: { taskType: 'feature' },
    progress: {},
    meta: { initialized: true },
  };
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, delegatingState);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash 寫入 — 無 taskType → allow（未分類）', () => {
  const noTask = { phase: 'IDLE', context: {}, progress: {}, meta: { initialized: true } };
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, noTask);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash danger — 委派中也阻擋（無條件）', () => {
  const delegatingState = {
    phase: 'DELEGATING',
    context: { taskType: 'feature' },
    progress: {},
    meta: { initialized: true },
  };
  const r = evaluate('Bash', { command: 'chmod 777 /' }, delegatingState);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'danger-pattern');
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
