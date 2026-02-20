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

// v4 state：pipelineActive=true，pipeline 執行中
const ENFORCED_STATE = {
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
  activeStages: [],
  retries: {},
  pendingRetry: null,
  retryHistory: {},
  crashes: {},
  meta: { initialized: true },
};

// DELEGATING 狀態（有 active stage）
function makeDelegatingState(currentStage = 'DEV') {
  const s = JSON.parse(JSON.stringify(ENFORCED_STATE));
  if (s.stages[currentStage]) s.stages[currentStage].status = 'active';
  s.activeStages = [currentStage];
  return s;
}

// PLAN + DELEGATING（用於 AskUserQuestion PLAN 放行測試）
const PLAN_DELEGATING_STATE = {
  version: 4,
  classification: { taskType: 'feature', pipelineId: 'standard', source: 'test' },
  dag: {
    PLAN: { deps: [] },
    ARCH: { deps: ['PLAN'] },
    DEV: { deps: ['ARCH'] },
  },
  stages: {
    PLAN: { status: 'active', agent: 'planner' },
    ARCH: { status: 'pending', agent: null, verdict: null },
    DEV: { status: 'pending', agent: null, verdict: null },
  },
  pipelineActive: true,
  activeStages: ['PLAN'],
  retries: {},
  pendingRetry: null,
  retryHistory: {},
  crashes: {},
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

test('AskUserQuestion → 放行（S1: READ_ONLY_TOOLS 白名單）', () => {
  // S1 任務 3.1：AskUserQuestion 加入 READ_ONLY_TOOLS，在 pipeline relay 模式下放行
  // 這讓 Main Agent 不確定 pipeline 時可以詢問使用者（不被 must-delegate 阻擋）
  const result = evaluate('AskUserQuestion', {}, ENFORCED_STATE);
  assert.strictEqual(result.decision, 'allow');
});

test('AskUserQuestion — PLAN 階段放行（需 DELEGATING phase）', () => {
  // CLASSIFIED 階段 must-delegate 會先阻擋，PLAN 放行只在 DELEGATING 有效
  const result = evaluate('AskUserQuestion', {}, PLAN_DELEGATING_STATE);
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

test('DANGER_PATTERNS 匯出 10 個模式', () => {
  assert.strictEqual(DANGER_PATTERNS.length, 10);
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

test('WRITE_PATTERNS 匯出 5 個模式', () => {
  assert.strictEqual(WRITE_PATTERNS.length, 5);
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
  const delegatingState = makeDelegatingState();
  const r = evaluate('Bash', { command: 'npm test' }, delegatingState);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash 寫入程式碼 — CLASSIFIED → bash-write-bypass（步驟 2.5 攔截）', () => {
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, ENFORCED_STATE);
  assert.strictEqual(r.decision, 'block');
  // 步驟 2.5：pipelineActive=true 時 detectBashWriteTarget 在 must-delegate 之前觸發
  assert.strictEqual(r.reason, 'bash-write-bypass');
  assert.ok(r.message.includes('src/app.js'));
});

test('Bash 寫入非程式碼 — CLASSIFIED → must-delegate 阻擋', () => {
  // CLASSIFIED 階段：所有 Bash 操作都被 must-delegate 阻擋
  const r = evaluate('Bash', { command: 'echo "log" > notes.md' }, ENFORCED_STATE);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
});

test('Bash 寫入程式碼 — 委派中（DELEGATING）→ bash-write-bypass（步驟 2.5 攔截）', () => {
  const delegatingState = makeDelegatingState();
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, delegatingState);
  assert.strictEqual(r.decision, 'block');
  // 步驟 2.5 在步驟 4（activeStages 放行）之前：pipelineActive 時一律攔截 Bash 寫入
  assert.strictEqual(r.reason, 'bash-write-bypass');
});

test('Bash 寫入 — 無 taskType → allow（未分類）', () => {
  const noTask = { phase: 'IDLE', context: {}, progress: {}, meta: { initialized: true } };
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, noTask);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash danger — 委派中也阻擋（無條件）', () => {
  const delegatingState = makeDelegatingState();
  const r = evaluate('Bash', { command: 'chmod 777 /' }, delegatingState);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'danger-pattern');
});

test('Bash 寫入非程式碼 — 委派中（DELEGATING）→ allow（步驟 2.5 不攔截非程式碼）', () => {
  const delegatingState = makeDelegatingState();
  const r = evaluate('Bash', { command: 'echo "log" > notes.md' }, delegatingState);
  assert.strictEqual(r.decision, 'allow');
});

test('Bash 寫入程式碼 — pipelineActive=false → allow（步驟 2.5 不觸發）', () => {
  const inactiveState = { ...ENFORCED_STATE, pipelineActive: false };
  const r = evaluate('Bash', { command: "echo 'x' > src/app.js" }, inactiveState);
  assert.strictEqual(r.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n🆕 v4 pipelineActive 邏輯測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// v4 state 工廠
function makeGuardTestState(overrides = {}) {
  return {
    version: 4,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    stages: {
      DEV: { status: 'pending' },
      REVIEW: { status: 'pending' },
    },
    pipelineActive: true,
    activeStages: [],
    retryHistory: {},
    crashes: {},
    enforced: true,
    retries: {},
    pendingRetry: null,
    meta: { initialized: true, cancelled: false },
    ...overrides,
  };
}

test('v4：pipelineActive=false → allow（核心放行）', () => {
  const state = makeGuardTestState({ pipelineActive: false });
  assert.strictEqual(evaluate('Write', { file_path: 'src/app.js' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Edit', { file_path: 'src/app.ts' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Bash', { command: 'npm test' }, state).decision, 'allow');
});

test('v4：pipelineActive=true + activeStages=[] → block（Relay 模式）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Write', { file_path: 'src/app.js' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'must-delegate');
  assert.ok(r.message.includes('Relay'), 'Relay 模式訊息');
});

test('v4：pipelineActive=true + activeStages=[DEV] → allow（委派中）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: ['DEV'] });
  assert.strictEqual(evaluate('Write', { file_path: 'src/app.js' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Edit', { file_path: 'src/app.ts' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Bash', { command: 'npm test' }, state).decision, 'allow');
});

test('v4：pipelineActive=true + Task → allow（委派工具放行）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  assert.strictEqual(evaluate('Task', { subagent_type: 'vibe:developer' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Skill', { name: '/vibe:review' }, state).decision, 'allow');
});

test('v4：pipelineActive=true + 唯讀工具 → allow', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  assert.strictEqual(evaluate('Read', { file_path: 'src/app.js' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Grep', { pattern: 'TODO' }, state).decision, 'allow');
  assert.strictEqual(evaluate('Glob', { pattern: '**/*.js' }, state).decision, 'allow');
  assert.strictEqual(evaluate('WebSearch', { query: 'test' }, state).decision, 'allow');
});

test('v4：EnterPlanMode → block（無論 pipelineActive）', () => {
  assert.strictEqual(evaluate('EnterPlanMode', {}, makeGuardTestState({ pipelineActive: false })).decision, 'block');
  assert.strictEqual(evaluate('EnterPlanMode', {}, makeGuardTestState({ pipelineActive: true })).decision, 'block');
  assert.strictEqual(evaluate('EnterPlanMode', {}, null).decision, 'block');
});

test('v4：Bash 危險指令 → block（無論 pipelineActive）', () => {
  const safe = makeGuardTestState({ pipelineActive: false });
  assert.strictEqual(evaluate('Bash', { command: 'rm -rf / ' }, safe).decision, 'block');
  assert.strictEqual(evaluate('Bash', { command: 'DROP TABLE x' }, safe).decision, 'block');
});

test('v4：AskUserQuestion + pipelineActive=true + activeStages=[] → allow（S1 白名單）', () => {
  // S1 任務 3.1：AskUserQuestion 加入 READ_ONLY_TOOLS，pipeline relay 模式下放行
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('AskUserQuestion', {}, state);
  assert.strictEqual(r.decision, 'allow');
});

test('v4：AskUserQuestion + activeStages=[PLAN]（PLAN 委派中）→ allow', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: ['PLAN'] });
  assert.strictEqual(evaluate('AskUserQuestion', {}, state).decision, 'allow');
});

test('v4：TaskCreate → allow（Pipeline 進度追蹤白名單）', () => {
  // TaskCreate 加入 READ_ONLY_TOOLS，Main Agent 可在 relay 模式下建立進度條目
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('TaskCreate', {}, state);
  assert.strictEqual(r.decision, 'allow', 'TaskCreate 應在白名單中');
});

test('v4：TaskUpdate → allow（Pipeline 進度追蹤白名單）', () => {
  // TaskUpdate 加入 READ_ONLY_TOOLS，Main Agent 可在委派時更新進度
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('TaskUpdate', {}, state);
  assert.strictEqual(r.decision, 'allow', 'TaskUpdate 應在白名單中');
});

test('v4：TaskCreate + activeStages=[DEV]（委派中）→ allow', () => {
  // 委派中（activeStages 有值）時 TaskCreate 應放行（Rule 4 + Rule 4.5 品質門不適用）
  const state = makeGuardTestState({ pipelineActive: true, activeStages: ['DEV'] });
  const r = evaluate('TaskCreate', {}, state);
  assert.strictEqual(r.decision, 'allow', 'TaskCreate 委派中應放行');
});

test('v4：TaskUpdate + pipelineActive=false → allow（不活躍時放行）', () => {
  const state = makeGuardTestState({ pipelineActive: false });
  const r = evaluate('TaskUpdate', {}, state);
  assert.strictEqual(r.decision, 'allow', 'pipelineActive=false 時 TaskUpdate 應放行');
});

test('v4：state=null → allow', () => {
  assert.strictEqual(evaluate('Write', { file_path: 'src/app.js' }, null).decision, 'allow');
  assert.strictEqual(evaluate('Edit', { file_path: 'src/app.ts' }, null).decision, 'allow');
});

test('v4：pipelineActive 未定義（無欄位）→ 放行（hook 層面已透過 ensureCurrentSchema 遷移）', () => {
  // guard-rules 直接評估舊格式 state（無 pipelineActive）→ isActive()=false → allow
  // 注意：真實場景中 pipeline-guard hook 的 loadState() 已透過 ensureCurrentSchema 驗證，
  // 所以 evaluate() 永遠收到當前 schema state，此測試只驗證 API 的邊界行為。
  const v3state = {
    version: 3,
    classification: { pipelineId: 'standard', taskType: 'feature' },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    enforced: true,
    retries: {},
    pendingRetry: null,
    meta: { initialized: true, cancelled: false },
  };
  // v4 guard-rules：pipelineActive 未定義 → isActive()=false → allow
  const r = evaluate('Write', { file_path: 'src/app.js' }, v3state);
  assert.strictEqual(r.decision, 'allow');
});

// ═══════════════════════════════════════════════
console.log('\n🔗 目標 2：detectBashWriteTarget 整合 evaluate() 測試');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// 目標 2.1：pipelineActive=true + Bash + 寫入 .js 檔 → bash-write-bypass 攔截
test('目標 2.1：pipelineActive=true + Bash 寫入 .js → bash-write-bypass', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Bash', { command: "echo 'const x = 1;' > src/main.js" }, state);
  assert.strictEqual(r.decision, 'block', '應被攔截');
  assert.strictEqual(r.reason, 'bash-write-bypass', '攔截原因應為 bash-write-bypass');
  assert.ok(r.message.includes('src/main.js'), '訊息應包含目標檔案路徑');
});

// 目標 2.2：pipelineActive=true + Bash + 寫入 .md 檔 → must-delegate（非程式碼放行步驟 2.5，但仍被 must-delegate 攔截）
test('目標 2.2：pipelineActive=true + Bash 寫入 .md → must-delegate（非程式碼不觸發 bash-write-bypass）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Bash', { command: 'echo "# Doc" > docs/README.md' }, state);
  assert.strictEqual(r.decision, 'block', '應被阻擋');
  // 非程式碼 → 步驟 2.5 不觸發 → 繼續到步驟 7 must-delegate
  assert.strictEqual(r.reason, 'must-delegate', '.md 不觸發 bash-write-bypass，但仍被 must-delegate 阻擋');
});

// 目標 2.3：pipelineActive=false + Bash + 寫入 .js 檔 → 放行（步驟 3 核心放行）
test('目標 2.3：pipelineActive=false + Bash 寫入 .js → allow（步驟 3 放行）', () => {
  const state = makeGuardTestState({ pipelineActive: false });
  const r = evaluate('Bash', { command: "echo 'export default fn;' > src/fn.js" }, state);
  assert.strictEqual(r.decision, 'allow', 'pipelineActive=false 時應放行');
});

// 目標 2.4：pipelineActive=true + Bash + 一般指令 ls → must-delegate 阻擋（非寫入 → 步驟 2.5 不觸發）
test('目標 2.4：pipelineActive=true + Bash ls → must-delegate（一般指令不觸發 bash-write-bypass）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Bash', { command: 'ls -la' }, state);
  assert.strictEqual(r.decision, 'block', 'ls 應被 must-delegate 阻擋');
  assert.strictEqual(r.reason, 'must-delegate', '一般指令不觸發 bash-write-bypass');
});

// 額外邊界案例：pipelineActive=true + activeStages 有值 + Bash 寫入 .ts 檔 → bash-write-bypass（步驟 2.5 優先於步驟 4）
test('步驟 2.5 在步驟 4（activeStages 放行）之前：委派中也攔截 Bash 寫 .ts', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: ['REVIEW'] });
  const r = evaluate('Bash', { command: 'cat template.ts > src/component.ts' }, state);
  assert.strictEqual(r.decision, 'block', '即使委派中，Bash 寫入 .ts 也應被攔截');
  assert.strictEqual(r.reason, 'bash-write-bypass');
});

// 邊界：pipelineActive=true + Bash + printf >> 寫入 .py → bash-write-bypass
test('pipelineActive=true + printf >> .py → bash-write-bypass', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Bash', { command: 'printf "def fn():\\n    pass\\n" >> src/utils.py' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'bash-write-bypass');
});

// 邊界：pipelineActive=true + Bash + tee 寫入 .go → bash-write-bypass
test('pipelineActive=true + tee .go → bash-write-bypass', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Bash', { command: 'go generate | tee pkg/gen.go' }, state);
  assert.strictEqual(r.decision, 'block');
  assert.strictEqual(r.reason, 'bash-write-bypass');
});

// ═══════════════════════════════════════════════
console.log('\n🔓 目標 3：Rule 6.5 Pipeline state file 寫入白名單（cancel 逃生門）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

const os = require('os');

// 目標 3.1：pipelineActive=true + Write pipeline-state-*.json → allow
test('目標 3.1：Write pipeline-state-*.json → allow（cancel 逃生門）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const stateFilePath = path.join(os.homedir(), '.claude', 'pipeline-state-test-session.json');
  const r = evaluate('Write', { file_path: stateFilePath }, state);
  assert.strictEqual(r.decision, 'allow', 'pipeline state file 寫入應被放行');
});

// 目標 3.2：pipelineActive=true + Edit pipeline-state-*.json → allow
test('目標 3.2：Edit pipeline-state-*.json → allow（cancel 逃生門）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const stateFilePath = path.join(os.homedir(), '.claude', 'pipeline-state-abc123.json');
  const r = evaluate('Edit', { file_path: stateFilePath }, state);
  assert.strictEqual(r.decision, 'allow', 'pipeline state file 編輯應被放行');
});

// 目標 3.3：pipelineActive=true + Write 其他 .json → block（非 state file）
test('目標 3.3：Write 其他 .json 檔案 → block（非 pipeline state）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Write', { file_path: '/some/path/config.json' }, state);
  assert.strictEqual(r.decision, 'block', '非 pipeline state 的 JSON 應被阻擋');
});

// 目標 3.4：pipelineActive=true + Write pipeline-state 但路徑不在 ~/.claude/ → block
test('目標 3.4：Write pipeline-state-*.json 但路徑不在 ~/.claude/ → block', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Write', { file_path: '/tmp/pipeline-state-evil.json' }, state);
  assert.strictEqual(r.decision, 'block', '非 ~/.claude/ 路徑應被阻擋');
});

// ═══════════════════════════════════════════════
console.log('\n🔓 目標 3.5-3.10：Rule 6.5 擴展白名單（task-guard + classifier-corpus）');
console.log('═'.repeat(55));
// ═══════════════════════════════════════════════

// 目標 3.5：Write classifier-corpus.jsonl → allow
test('目標 3.5：Write classifier-corpus.jsonl → allow', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const corpusPath = path.join(os.homedir(), '.claude', 'classifier-corpus.jsonl');
  const r = evaluate('Write', { file_path: corpusPath }, state);
  assert.strictEqual(r.decision, 'allow', 'classifier-corpus.jsonl 寫入應被放行');
});

// 目標 3.6：Write task-guard-state-*.json → allow
test('目標 3.6：Write task-guard-state-*.json → allow', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const taskGuardPath = path.join(os.homedir(), '.claude', 'task-guard-state-abc123.json');
  const r = evaluate('Write', { file_path: taskGuardPath }, state);
  assert.strictEqual(r.decision, 'allow', 'task-guard-state 寫入應被放行');
});

// 目標 3.7：Edit task-guard-state-*.json → allow
test('目標 3.7：Edit task-guard-state-*.json → allow', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const taskGuardPath = path.join(os.homedir(), '.claude', 'task-guard-state-session-xyz.json');
  const r = evaluate('Edit', { file_path: taskGuardPath }, state);
  assert.strictEqual(r.decision, 'allow', 'task-guard-state 編輯應被放行');
});

// 目標 3.8：Write classifier-corpus.jsonl 但路徑不在 ~/.claude/ → block
test('目標 3.8：Write classifier-corpus.jsonl 但路徑不在 ~/.claude/ → block', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Write', { file_path: '/tmp/classifier-corpus.jsonl' }, state);
  assert.strictEqual(r.decision, 'block', '非 ~/.claude/ 路徑的 classifier-corpus 應被阻擋');
});

// 目標 3.9：Write task-guard-state-*.json 但路徑不在 ~/.claude/ → block
test('目標 3.9：Write task-guard-state-*.json 但路徑不在 ~/.claude/ → block', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const r = evaluate('Write', { file_path: '/var/tmp/task-guard-state-evil.json' }, state);
  assert.strictEqual(r.decision, 'block', '非 ~/.claude/ 路徑的 task-guard-state 應被阻擋');
});

// 目標 3.10：Write 其他 .jsonl 檔案 → block（防止白名單過寬）
test('目標 3.10：Write 其他 .jsonl 檔案 → block（防止白名單過寬）', () => {
  const state = makeGuardTestState({ pipelineActive: true, activeStages: [] });
  const otherJsonlPath = path.join(os.homedir(), '.claude', 'timeline-session.jsonl');
  const r = evaluate('Write', { file_path: otherJsonlPath }, state);
  assert.strictEqual(r.decision, 'block', '非白名單的 .jsonl 檔案應被阻擋');
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
