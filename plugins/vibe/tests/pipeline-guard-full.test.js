#!/usr/bin/env node
/**
 * pipeline-guard-full.test.js — Guard 防護完整測試（C01-C07）
 *
 * 場景：
 *   C01: pipelineActive=false → allow
 *   C02: pipelineActive=true + activeStages → allow（sub-agent 委派中）
 *   C03: pipelineActive=true + 無 activeStages + Write → block
 *   C04: Read 唯讀白名單 → allow
 *   C05: EnterPlanMode → block（無條件）
 *   C06: Bash rm -rf / → block（DANGER_PATTERNS）
 *   C07: Bash echo > src/foo.js → block（pipelineActive 寫檔偵測）
 *
 * 執行：node plugins/vibe/tests/pipeline-guard-full.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState } = require('./test-helpers');
const { evaluate } = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));
const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

let passed = 0;
let failed = 0;

cleanTestStateFiles();

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

// ─── 輔助：建立 v4 state ────────────────────────────────

function makeActiveState(overrides = {}) {
  const base = {
    version: 4,
    sessionId: 'test-guard',
    classification: {
      pipelineId: 'standard',
      taskType: 'feature',
      source: 'test',
      classifiedAt: new Date().toISOString(),
    },
    environment: {},
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST: { deps: ['REVIEW'] },
    },
    stages: {
      DEV: { status: 'pending', agent: null },
      REVIEW: { status: 'pending', agent: null },
      TEST: { status: 'pending', agent: null },
    },
    pipelineActive: true,
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
  };
  return { ...base, ...overrides };
}

function makeIdleState() {
  return {
    version: 4,
    sessionId: 'test-guard-idle',
    classification: null,
    environment: {},
    dag: null,
    stages: {},
    pipelineActive: false,
    activeStages: [],
    retries: {},
    pendingRetry: null,
    retryHistory: {},
    crashes: {},
    meta: { initialized: true, lastTransition: new Date().toISOString(), reclassifications: [], pipelineRules: [] },
  };
}

// ─── 測試 ────────────────────────────────────────────────

console.log('\n🛡️  C01-C07：Guard 防護完整測試');

// C01: pipelineActive=false → allow（v4 核心）
test('C01: pipelineActive=false → allow（v4 核心：放行閒置 pipeline）', () => {
  const state = makeIdleState();
  const result = evaluate('Write', { file_path: '/src/foo.js', content: 'test' }, state);
  assert.strictEqual(result.decision, 'allow', `應為 allow，實際：${result.decision}`);
});

// C02: pipelineActive=true + activeStages → allow（sub-agent 委派中）
test('C02: pipelineActive=true + activeStages → allow（sub-agent 委派中）', () => {
  const state = makeActiveState({ activeStages: ['DEV'] });
  const result = evaluate('Write', { file_path: '/src/foo.js', content: 'test' }, state);
  assert.strictEqual(result.decision, 'allow', `sub-agent 執行中應放行，實際：${result.decision}`);
});

// C03: pipelineActive=true + 無 activeStages + Write → block（must-delegate）
test('C03: pipelineActive=true + 無 activeStages + Write → block（must-delegate）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Write', { file_path: '/src/foo.js', content: 'code' }, state);
  assert.strictEqual(result.decision, 'block', `應為 block，實際：${result.decision}`);
  assert.strictEqual(result.reason, 'must-delegate', `reason 應為 must-delegate，實際：${result.reason}`);
});

// C03b: Edit 也應被阻擋
test('C03b: pipelineActive=true + Edit → block（must-delegate）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Edit', { file_path: '/src/foo.js', old_string: 'a', new_string: 'b' }, state);
  assert.strictEqual(result.decision, 'block', `Edit 應被阻擋，實際：${result.decision}`);
});

// C04: Read 唯讀白名單 → allow
test('C04: Read 唯讀白名單 → allow（pipelineActive=true 下讀取放行）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Read', { file_path: '/src/foo.js' }, state);
  assert.strictEqual(result.decision, 'allow', `Read 應放行，實際：${result.decision}`);
});

// C04b: Grep 也是唯讀工具
test('C04b: Grep → allow（唯讀白名單）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Grep', { pattern: 'foo', path: '/src' }, state);
  assert.strictEqual(result.decision, 'allow', `Grep 應放行，實際：${result.decision}`);
});

// C04c: Task（委派工具）→ allow
test('C04c: Task → allow（委派工具始終放行）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Task', { description: '委派', prompt: '執行' }, state);
  assert.strictEqual(result.decision, 'allow', `Task 應放行，實際：${result.decision}`);
});

// C05: EnterPlanMode → block（無條件）
test('C05: EnterPlanMode → block（無條件，與 pipelineActive 無關）', () => {
  // 即使 pipelineActive=false 也應阻擋
  const state = makeIdleState();
  const result = evaluate('EnterPlanMode', {}, state);
  assert.strictEqual(result.decision, 'block', `EnterPlanMode 應無條件阻擋，實際：${result.decision}`);
  assert.strictEqual(result.reason, 'plan-mode-disabled');
});

// C05b: EnterPlanMode 在 active pipeline 下也阻擋
test('C05b: EnterPlanMode 在 active pipeline 下也阻擋', () => {
  const state = makeActiveState({ activeStages: ['DEV'] });
  const result = evaluate('EnterPlanMode', {}, state);
  assert.strictEqual(result.decision, 'block', `EnterPlanMode 應始終阻擋`);
});

// C06: Bash rm -rf / → block（DANGER_PATTERNS）
// 注意：danger-guard 掃描整個 Bash 字串，含危險模式的測試寫到此處字面值即可
test('C06: Bash rm -rf / → block（DANGER_PATTERNS，無條件）', () => {
  // 使用空 state（pipelineActive=false）驗證無條件阻擋
  const state = makeIdleState();
  const result = evaluate('Bash', { command: 'rm -rf / --no-preserve-root' }, state);
  assert.strictEqual(result.decision, 'block', `危險指令應無條件阻擋，實際：${result.decision}`);
  assert.strictEqual(result.reason, 'danger-pattern');
});

// C06b: git push --force main → block
test('C06b: git push --force main → block（DANGER_PATTERNS）', () => {
  const state = makeIdleState();
  const result = evaluate('Bash', { command: 'git push --force main' }, state);
  assert.strictEqual(result.decision, 'block', `force push main 應阻擋，實際：${result.decision}`);
});

// C07: Bash echo > src/foo.js → block（pipelineActive 寫檔偵測）
test('C07: Bash echo > src/foo.js → block（pipelineActive 寫檔偵測）', () => {
  const state = makeActiveState({ activeStages: [] });
  const result = evaluate('Bash', { command: 'echo "content" > src/foo.js' }, state);
  assert.strictEqual(result.decision, 'block', `Bash 寫入程式碼檔案應阻擋，實際：${result.decision}`);
  assert.strictEqual(result.reason, 'bash-write-bypass');
});

// C07b: Bash echo > .env → 非程式碼偵測放行，但 must-delegate 仍阻擋
// 設計說明：detectBashWriteTarget 對 .env 回傳 null（步驟 2.5 放行），
// 但步驟 7 的 must-delegate 仍會阻擋非白名單的 Bash 工具。
// 本測試驗證 detectBashWriteTarget 本身的正確性。
test('C07b: detectBashWriteTarget .env → null（非程式碼，不被寫檔偵測阻擋）', () => {
  // 直接測試 detectBashWriteTarget 函式（guard-rules 內部函式）
  const { detectBashWriteTarget } = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
  const result = detectBashWriteTarget('echo "KEY=VALUE" > .env');
  assert.strictEqual(result, null, '.env 不應被寫檔偵測阻擋（回傳 null）');
});

// C07c: 非 pipelineActive 時 Bash 寫檔放行
test('C07c: pipelineActive=false 下 Bash 寫檔 → allow', () => {
  const state = makeIdleState();
  const result = evaluate('Bash', { command: 'echo "content" > src/foo.js' }, state);
  // pipelineActive=false → allow（v4 核心，跳過寫檔偵測）
  assert.strictEqual(result.decision, 'allow', `非活躍 pipeline 下 Bash 寫檔應放行，實際：${result.decision}`);
});

// canProceed 整合測試（透過 controller）
test('C08（整合）: canProceed 代理 evaluate() 結果一致', () => {
  const sid = 'test-guard-integrate';
  cleanSessionState(sid);

  // 寫入 active state
  const state = makeActiveState({ activeStages: [] });
  ds.writeState(sid, state);

  // canProceed 應與 evaluate 結果一致
  const result = ctrl.canProceed(sid, 'Write', { file_path: '/src/foo.js' });
  assert.strictEqual(result.decision, 'block', `canProceed 應代理 evaluate 阻擋，實際：${result.decision}`);

  cleanSessionState(sid);
});

console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
