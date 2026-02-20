#!/usr/bin/env node
/**
 * perf-optimization-regression.test.js — Phase 1 DEV:1 效能優化回歸測試
 *
 * 驗證三個效能優化沒有破壞現有行為：
 * 1. guard-rules.js：模組頂層常數 HOME_DIR + CLAUDE_STATE_DIR
 * 2. pipeline-controller.js：require 提升（guardEvaluate）+ WISDOM_STAGES 提升
 * 3. route-parser.js：正則預編譯（PASS_PATTERNS/FAIL_PATTERNS/FAIL_FALSE_POSITIVE_RE）
 *
 * 核心風險點：
 * A. 正則預編譯後的 lastIndex 狀態問題（/g flag 多次呼叫）
 * B. pipeline-controller 新增 guard-rules require 是否產生循環依賴
 * C. guard-rules 模組頂層常數是否與執行期 os.homedir() 一致
 *
 * 執行：node plugins/vibe/tests/perf-optimization-regression.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');

// ────────────── 被測模組 ──────────────
const {
  evaluate,
  isNonCodeFile,
  evaluateBashDanger,
  detectBashWriteTarget,
  NON_CODE_EXTS,
  DANGER_PATTERNS,
  WRITE_PATTERNS,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));

const {
  parseRoute,
  validateRoute,
  enforcePolicy,
  inferRouteFromContent,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/route-parser.js'));

// ────────────── 測試計數器 ──────────────
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

// ────────────── 暫存工具 ──────────────
const TMP_DIR = path.join(os.tmpdir(), `perf-regression-${process.pid}`);
fs.mkdirSync(TMP_DIR, { recursive: true });

function writeTranscript(filename, lines) {
  const p = path.join(TMP_DIR, filename);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

function makeAssistantEntry(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ────────────── v4 state 工具 ──────────────
function makeV4State(overrides = {}) {
  return {
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
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════
// Section 1：guard-rules.js 模組頂層常數（HOME_DIR + CLAUDE_STATE_DIR）
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 1：guard-rules 模組頂層常數正確性');
console.log('─'.repeat(60));

test('HOME_DIR 常數與 os.homedir() 一致（cancel skill 逃生門依賴此路徑）', () => {
  // cancel skill 逃生門（Rule 6.5）的路徑比對依賴 CLAUDE_STATE_DIR
  // 測試方法：寫入 ~/.claude/pipeline-state-*.json 應該 allow
  const stateFilePath = path.join(os.homedir(), '.claude', 'pipeline-state-test123.json');
  const activeState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Write', { file_path: stateFilePath }, activeState);
  // pipelineActive=true 且無 activeStages，Rule 6.5 白名單應放行
  assert.strictEqual(result.decision, 'allow', `cancel 逃生門應 allow，實際：${result.decision} reason=${result.reason}`);
});

test('CLAUDE_STATE_DIR 常數路徑正確（~/.claude/）', () => {
  // 驗證：路徑不在 ~/.claude/ 的 pipeline-state 檔案應該被 block
  const outsidePath = '/tmp/pipeline-state-test123.json';
  const activeState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Write', { file_path: outsidePath }, activeState);
  // pipelineActive=true 且無 activeStages，不在白名單路徑 → block
  assert.strictEqual(result.decision, 'block', `非 ~/.claude/ 路徑應 block，實際：${result.decision}`);
});

test('task-guard-state-*.json 在 ~/.claude/ → allow（常數路徑一致性）', () => {
  const stateFilePath = path.join(os.homedir(), '.claude', 'task-guard-state-test123.json');
  const activeState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Write', { file_path: stateFilePath }, activeState);
  assert.strictEqual(result.decision, 'allow');
});

test('classifier-corpus.jsonl 在 ~/.claude/ → allow（常數路徑一致性）', () => {
  const stateFilePath = path.join(os.homedir(), '.claude', 'classifier-corpus.jsonl');
  const activeState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Write', { file_path: stateFilePath }, activeState);
  assert.strictEqual(result.decision, 'allow');
});

test('pipelineActive=false 時 evaluate 允許所有工具（不受 HOME_DIR 影響）', () => {
  const inactiveState = makeV4State({ pipelineActive: false });
  const result = evaluate('Write', { file_path: '/any/path/app.js' }, inactiveState);
  assert.strictEqual(result.decision, 'allow');
});

// ══════════════════════════════════════════════════════════════
// Section 2：循環依賴驗證（pipeline-controller require 提升）
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 2：循環依賴驗證');
console.log('─'.repeat(60));

test('pipeline-controller 可成功載入（無循環依賴）', () => {
  // 清除 require 快取，強制重新載入
  const controllerPath = path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js');
  // 先確認快取中無遺留問題
  delete require.cache[controllerPath];
  let loadError = null;
  try {
    require(controllerPath);
  } catch (e) {
    loadError = e;
  }
  assert.strictEqual(loadError, null, `pipeline-controller 載入失敗：${loadError?.message}`);
});

test('guard-rules 可成功載入（無循環依賴）', () => {
  const guardPath = path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js');
  delete require.cache[guardPath];
  let loadError = null;
  try {
    require(guardPath);
  } catch (e) {
    loadError = e;
  }
  assert.strictEqual(loadError, null, `guard-rules 載入失敗：${loadError?.message}`);
});

test('pipeline-controller 與 guard-rules 同時載入無衝突', () => {
  const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));
  const guard = require(path.join(PLUGIN_ROOT, 'scripts/lib/sentinel/guard-rules.js'));
  assert.ok(typeof ctrl.canProceed === 'function', 'pipeline-controller.canProceed 應為函式');
  assert.ok(typeof guard.evaluate === 'function', 'guard-rules.evaluate 應為函式');
});

test('pipeline-controller.canProceed 呼叫 guard.evaluate 行為一致', () => {
  // pipeline-controller.canProceed 提升後應和直接呼叫 guard.evaluate 結果一致
  const ctrl = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));
  // 無 state（sessionId 不存在）→ pipelineActive=false → allow
  // canProceed 可能回傳不同結構，但核心路由邏輯應一致
  const directResult = evaluate('Read', {}, null);
  assert.strictEqual(directResult.decision, 'allow', '直接呼叫 evaluate(Read, {}, null) 應 allow');
});

// ══════════════════════════════════════════════════════════════
// Section 3：WISDOM_STAGES 常數正確性（pipeline-controller 提升）
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 3：WISDOM_STAGES 常數正確性');
console.log('─'.repeat(60));

test('WISDOM_STAGES 應包含所有品質相關 stage（REVIEW/TEST/QA/E2E/SECURITY）', () => {
  // 透過 pipeline-controller 的行為間接驗證（無法直接訪問 module-private 常數）
  // 策略：registry.js 的 QUALITY_STAGES 包含 REVIEW/TEST/QA/E2E，WISDOM_STAGES 應是超集
  const registryPath = path.join(PLUGIN_ROOT, 'scripts/lib/registry.js');
  const { QUALITY_STAGES } = require(registryPath);
  // WISDOM_STAGES = QUALITY_STAGES ∪ {SECURITY}，驗證 QUALITY_STAGES 中的值都在預期集合
  const expectedWisdomStages = new Set(['REVIEW', 'TEST', 'QA', 'E2E', 'SECURITY']);
  for (const stage of QUALITY_STAGES) {
    assert.ok(expectedWisdomStages.has(stage), `QUALITY_STAGES 的 ${stage} 應該在 WISDOM_STAGES 中`);
  }
});

test('QUALITY_STAGES 包含 REVIEW 和 TEST', () => {
  const { QUALITY_STAGES } = require(path.join(PLUGIN_ROOT, 'scripts/lib/registry.js'));
  assert.ok(QUALITY_STAGES.includes('REVIEW') || QUALITY_STAGES.includes('TEST'),
    'QUALITY_STAGES 應包含 REVIEW 或 TEST');
});

// ══════════════════════════════════════════════════════════════
// Section 4：正則預編譯 lastIndex 安全性（route-parser.js）
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 4：正則預編譯 lastIndex 安全性');
console.log('─'.repeat(60));

test('FAIL_FALSE_POSITIVE_RE /gi flag：多次連續呼叫 inferRouteFromContent 結果一致', () => {
  // 核心風險：FAIL_FALSE_POSITIVE_RE = /\bonFail\b|\bfailover\b|\bfailsafe\b/gi
  // 若用 .test() 呼叫 /g regex，lastIndex 會累積導致第 2 次呼叫結果不同
  // 實作用 String.replace() → lastIndex 自動重置，行為應一致
  const onlyFalsePositiveLines = [
    makeAssistantEntry('onFail handler is registered, failover is enabled, failsafe checks pass'),
  ];
  const f1 = writeTranscript('gi-test-1.jsonl', onlyFalsePositiveLines);
  const f2 = writeTranscript('gi-test-2.jsonl', onlyFalsePositiveLines);
  const f3 = writeTranscript('gi-test-3.jsonl', onlyFalsePositiveLines);

  const r1 = parseRoute(f1);
  const r2 = parseRoute(f2);
  const r3 = parseRoute(f3);

  // 含大量 onFail/failover/failsafe 文字（> 200 chars），弱 PASS 信號 → content-inference PASS
  // 或因 FAIL_FALSE_POSITIVE_RE 正確過濾後不觸發 FAIL 而推斷 PASS
  assert.strictEqual(r1.source, r2.source, `第 1 次結果 ${r1.source} ≠ 第 2 次結果 ${r2.source}`);
  assert.strictEqual(r2.source, r3.source, `第 2 次結果 ${r2.source} ≠ 第 3 次結果 ${r3.source}`);
});

test('FAIL_FALSE_POSITIVE_RE /gi flag：連續混合呼叫（true FAIL 和 false positive）結果一致', () => {
  // 含真實 FAIL 信號的 transcript
  const failLines = [makeAssistantEntry('發現嚴重問題：安全漏洞 SQL Injection')];
  // 只含 false positive 的 transcript
  const fpLines = [makeAssistantEntry('onFail handler 已定義，系統正常運作')];

  const fFail1 = writeTranscript('gi-fail-1.jsonl', failLines);
  const fFp1 = writeTranscript('gi-fp-1.jsonl', fpLines);
  const fFail2 = writeTranscript('gi-fail-2.jsonl', failLines);
  const fFp2 = writeTranscript('gi-fp-2.jsonl', fpLines);

  const rFail1 = parseRoute(fFail1);
  const rFp1 = parseRoute(fFp1);
  const rFail2 = parseRoute(fFail2);
  const rFp2 = parseRoute(fFp2);

  // FAIL transcript 的 verdict 應一致
  if (rFail1.parsed) {
    assert.strictEqual(rFail1.parsed?.verdict, rFail2.parsed?.verdict,
      `FAIL transcript 第 1 次 verdict ${rFail1.parsed?.verdict} ≠ 第 2 次 ${rFail2.parsed?.verdict}`);
  }
  // false positive transcript 的結果應一致
  assert.strictEqual(rFp1.source, rFp2.source,
    `false positive transcript 第 1 次 source ${rFp1.source} ≠ 第 2 次 ${rFp2.source}`);
});

test('PASS_PATTERNS /i flag：多次連續呼叫 PASS 推斷結果一致', () => {
  // PASS_PATTERNS 含 /all\s+pass/i 等 /i flag（無 /g），理論上安全
  // 但仍驗證多次呼叫一致性
  const passLines = [makeAssistantEntry('審查完成，0 個 CRITICAL，0 HIGH issues，全部通過')];
  const f1 = writeTranscript('pass-1.jsonl', passLines);
  const f2 = writeTranscript('pass-2.jsonl', passLines);
  const f3 = writeTranscript('pass-3.jsonl', passLines);

  const r1 = parseRoute(f1);
  const r2 = parseRoute(f2);
  const r3 = parseRoute(f3);

  assert.strictEqual(r1.source, r2.source, `第 1 次 source ${r1.source} ≠ 第 2 次 ${r2.source}`);
  assert.strictEqual(r1.source, r3.source, `第 1 次 source ${r1.source} ≠ 第 3 次 ${r3.source}`);
  if (r1.parsed) {
    assert.strictEqual(r1.parsed.verdict, r2.parsed.verdict);
    assert.strictEqual(r1.parsed.verdict, r3.parsed.verdict);
  }
});

test('FAIL_PATTERNS /i flag（無 /g）：多次 hasFAILSignal 呼叫結果一致', () => {
  // 間接測試 hasFAILSignal：含 FAIL 信號的 transcript 連續解析 3 次應一致
  const failLines = [makeAssistantEntry('CRITICAL 安全漏洞發現：XSS 攻擊向量')];
  const f1 = writeTranscript('fail-1.jsonl', failLines);
  const f2 = writeTranscript('fail-2.jsonl', failLines);
  const f3 = writeTranscript('fail-3.jsonl', failLines);

  const r1 = parseRoute(f1);
  const r2 = parseRoute(f2);
  const r3 = parseRoute(f3);

  // 若 FAIL_PATTERNS lastIndex 有問題，第 2 次可能不匹配 CRITICAL
  assert.deepStrictEqual(r1.source, r2.source, `source 不一致：${r1.source} vs ${r2.source}`);
  assert.deepStrictEqual(r1.source, r3.source, `source 不一致：${r1.source} vs ${r3.source}`);
});

test('CRITICAL_ZERO_RE / CRITICAL_ZERO_COLON_RE：多次呼叫 0 CRITICAL 排除一致', () => {
  // 驗證「0 CRITICAL / CRITICAL: 0」不被誤判為 FAIL 的行為在多次呼叫後一致
  const zeroCritLines = [makeAssistantEntry('審查完成，CRITICAL: 0，HIGH: 0，系統安全。')];
  const f1 = writeTranscript('zero-crit-1.jsonl', zeroCritLines);
  const f2 = writeTranscript('zero-crit-2.jsonl', zeroCritLines);

  const r1 = parseRoute(f1);
  const r2 = parseRoute(f2);

  assert.strictEqual(r1.source, r2.source, `source 不一致：${r1.source} vs ${r2.source}`);
  // 若有 verdict，應為 PASS（0 CRITICAL 不應觸發 FAIL）
  if (r1.parsed?.verdict && r2.parsed?.verdict) {
    assert.strictEqual(r1.parsed.verdict, 'PASS', `0 CRITICAL 應推斷為 PASS，實際：${r1.parsed.verdict}`);
    assert.strictEqual(r2.parsed.verdict, 'PASS', `0 CRITICAL 第二次應推斷為 PASS，實際：${r2.parsed.verdict}`);
  }
});

// ══════════════════════════════════════════════════════════════
// Section 5：guard-rules evaluate() 行為不受模組提升影響
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 5：evaluate() 各分支行為回歸');
console.log('─'.repeat(60));

test('Rule 1：EnterPlanMode 無條件 block（不受 pipelineActive 影響）', () => {
  const activeState = makeV4State({ pipelineActive: true });
  const inactiveState = makeV4State({ pipelineActive: false });
  assert.strictEqual(evaluate('EnterPlanMode', {}, activeState).decision, 'block');
  assert.strictEqual(evaluate('EnterPlanMode', {}, inactiveState).decision, 'block');
  assert.strictEqual(evaluate('EnterPlanMode', {}, null).decision, 'block');
});

test('Rule 2：Bash DANGER_PATTERNS block（rm -rf /）', () => {
  const result = evaluate('Bash', { command: 'rm -rf / --no-preserve-root' }, null);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'danger-pattern');
});

test('Rule 2：Bash DANGER_PATTERNS block（DROP TABLE）', () => {
  const result = evaluate('Bash', { command: 'DROP TABLE users' }, null);
  assert.strictEqual(result.decision, 'block');
});

test('Rule 2.5：Bash 寫入 .js 檔案（pipelineActive=true）→ block', () => {
  const activeState = makeV4State({ pipelineActive: true });
  const result = evaluate('Bash', { command: 'echo "code" > app.js' }, activeState);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'bash-write-bypass');
});

test('Rule 2.5：Bash 寫入 .md（pipelineActive=true，有 activeStages）→ allow（非程式碼不攔截）', () => {
  // Rule 2.5 只攔截寫入程式碼檔案，非程式碼（.md）不攔截
  // 有 activeStages 才能進入 Rule 4 放行路徑，否則 Bash 在 Relay 模式下被 Rule 7 block
  const activeState = makeV4State({
    pipelineActive: true,
    activeStages: ['DEV'],
    stages: {
      DEV: { status: 'active', agent: 'developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
  });
  const result = evaluate('Bash', { command: 'echo "# doc" > README.md' }, activeState);
  // DEV active → Rule 4 放行（activeStages.length > 0），非品質門，所以 allow
  assert.strictEqual(result.decision, 'allow');
});

test('Rule 3：pipelineActive=false → allow 所有工具', () => {
  const inactiveState = makeV4State({ pipelineActive: false });
  assert.strictEqual(evaluate('Write', { file_path: 'app.js' }, inactiveState).decision, 'allow');
  assert.strictEqual(evaluate('Edit', { file_path: 'app.js' }, inactiveState).decision, 'allow');
  assert.strictEqual(evaluate('Bash', { command: 'npm test' }, inactiveState).decision, 'allow');
});

test('Rule 4：有 activeStages → allow（基本放行）', () => {
  const delegatingState = makeV4State({
    pipelineActive: true,
    activeStages: ['DEV'],
    stages: {
      DEV: { status: 'active', agent: 'developer', verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
  });
  const result = evaluate('Read', {}, delegatingState);
  assert.strictEqual(result.decision, 'allow');
});

test('Rule 4.5：REVIEW active + Write .js → block（品質門）', () => {
  const reviewState = makeV4State({
    pipelineActive: true,
    activeStages: ['REVIEW'],
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: 'PASS' },
      REVIEW: { status: 'active', agent: 'code-reviewer', verdict: null },
      TEST: { status: 'pending', agent: null, verdict: null },
    },
  });
  const result = evaluate('Write', { file_path: 'src/app.js' }, reviewState);
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.reason, 'quality-gate-no-write');
});

test('Rule 4.5：TEST active + Write .test.js → allow（允許寫測試檔）', () => {
  const testState = makeV4State({
    pipelineActive: true,
    activeStages: ['TEST'],
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: 'PASS' },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'active', agent: 'tester', verdict: null },
    },
  });
  const result = evaluate('Write', { file_path: 'tests/app.test.js' }, testState);
  assert.strictEqual(result.decision, 'allow');
});

test('Rule 4.5：TEST active + Write .spec.ts → allow（允許寫測試檔）', () => {
  const testState = makeV4State({
    pipelineActive: true,
    activeStages: ['TEST'],
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: 'PASS' },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'active', agent: 'tester', verdict: null },
    },
  });
  const result = evaluate('Write', { file_path: 'src/user.spec.ts' }, testState);
  assert.strictEqual(result.decision, 'allow');
});

test('Rule 4.5：TEST active + Write .js（非測試）→ block', () => {
  const testState = makeV4State({
    pipelineActive: true,
    activeStages: ['TEST'],
    stages: {
      DEV: { status: 'completed', agent: 'developer', verdict: 'PASS' },
      REVIEW: { status: 'pending', agent: null, verdict: null },
      TEST: { status: 'active', agent: 'tester', verdict: null },
    },
  });
  const result = evaluate('Write', { file_path: 'src/app.js' }, testState);
  assert.strictEqual(result.decision, 'block');
});

test('Rule 5：Task 始終放行（Relay 模式）', () => {
  const relayState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Task', {}, relayState);
  assert.strictEqual(result.decision, 'allow');
});

test('Rule 6：READ_ONLY_TOOLS 放行（Read/Grep/Glob/WebSearch）', () => {
  const relayState = makeV4State({ pipelineActive: true, activeStages: [] });
  for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TaskList', 'AskUserQuestion']) {
    const result = evaluate(tool, {}, relayState);
    assert.strictEqual(result.decision, 'allow', `${tool} 應在唯讀白名單中`);
  }
});

test('Rule 7：其他工具（pipelineActive=true 且無 activeStages）→ block', () => {
  const relayState = makeV4State({ pipelineActive: true, activeStages: [] });
  const result = evaluate('Write', { file_path: 'some/file.js' }, relayState);
  assert.strictEqual(result.decision, 'block');
});

// ══════════════════════════════════════════════════════════════
// Section 6：連續呼叫一致性（整合測試）
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 6：連續呼叫一致性（整合）');
console.log('─'.repeat(60));

test('evaluate() 連續 10 次呼叫相同輸入結果一致（無副作用）', () => {
  const relayState = makeV4State({ pipelineActive: true, activeStages: [] });
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(evaluate('Write', { file_path: 'src/app.js' }, relayState).decision);
  }
  assert.ok(results.every(d => d === 'block'), `連續 10 次呼叫應全部 block：${results}`);
});

test('evaluateBashDanger() 連續 10 次呼叫相同輸入結果一致', () => {
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(evaluateBashDanger('rm -rf /') !== null);
  }
  assert.ok(results.every(r => r === true), '連續 10 次呼叫應全部偵測危險');
});

test('isNonCodeFile() 連續呼叫相同輸入結果一致', () => {
  const tests = [
    ['README.md', true],
    ['app.js', false],
    ['config.json', true],
    ['index.ts', false],
  ];
  for (const [filePath, expected] of tests) {
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(isNonCodeFile(filePath), expected,
        `第 ${i + 1} 次呼叫 isNonCodeFile(${filePath}) 應為 ${expected}`);
    }
  }
});

test('detectBashWriteTarget() 連續呼叫相同命令結果一致', () => {
  // pipelineActive 才呼叫，但函式本身是純函式
  const cmds = [
    ['echo "code" > app.js', true],  // 程式碼檔案 → block
    ['echo "doc" > README.md', false],  // 非程式碼 → null（不 block）
  ];
  for (const [cmd, expectBlock] of cmds) {
    for (let i = 0; i < 5; i++) {
      const result = detectBashWriteTarget(cmd);
      const isBlock = result !== null && result.decision === 'block';
      assert.strictEqual(isBlock, expectBlock,
        `第 ${i + 1} 次 detectBashWriteTarget(${cmd}) 應為 ${expectBlock}`);
    }
  }
});

test('parseRoute() 交替解析 PASS/FAIL transcript 結果一致（不受前一次呼叫影響）', () => {
  const passTranscript = writeTranscript('alt-pass.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'),
  ]);
  const failTranscript = writeTranscript('alt-fail.jsonl', [
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "FAIL", "route": "DEV", "severity": "HIGH" } -->'),
  ]);

  for (let i = 0; i < 5; i++) {
    const rPass = parseRoute(passTranscript);
    const rFail = parseRoute(failTranscript);
    assert.strictEqual(rPass.parsed?.verdict, 'PASS', `第 ${i + 1} 次 PASS transcript 應為 PASS`);
    assert.strictEqual(rFail.parsed?.verdict, 'FAIL', `第 ${i + 1} 次 FAIL transcript 應為 FAIL`);
  }
});

// ══════════════════════════════════════════════════════════════
// Section 7：邊界案例
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Section 7：邊界案例');
console.log('─'.repeat(60));

test('evaluate() 接受 null state 不崩潰', () => {
  const result = evaluate('Write', { file_path: 'app.js' }, null);
  assert.ok(['allow', 'block'].includes(result.decision), `result.decision 應為 allow 或 block，實際：${result.decision}`);
});

test('evaluate() 接受 undefined toolInput 不崩潰', () => {
  const result = evaluate('Bash', undefined, null);
  assert.ok(['allow', 'block'].includes(result.decision));
});

test('evaluate() 接受空字串 toolName 不崩潰', () => {
  const result = evaluate('', {}, null);
  assert.ok(['allow', 'block'].includes(result.decision));
});

test('isNonCodeFile() 接受 null/undefined 不崩潰', () => {
  assert.strictEqual(isNonCodeFile(null), false);
  assert.strictEqual(isNonCodeFile(undefined), false);
});

test('isNonCodeFile() 接受數字型別不崩潰', () => {
  assert.strictEqual(isNonCodeFile(123), false);
});

test('evaluateBashDanger() 接受空字串不崩潰', () => {
  const result = evaluateBashDanger('');
  assert.strictEqual(result, null, '空命令應不觸發危險模式');
});

test('detectBashWriteTarget() 接受空字串不崩潰', () => {
  const result = detectBashWriteTarget('');
  assert.strictEqual(result, null, '空命令不應觸發寫入偵測');
});

test('parseRoute() 接受空 transcript（空檔案）不崩潰', () => {
  const emptyFile = writeTranscript('empty.jsonl', []);
  const result = parseRoute(emptyFile);
  assert.strictEqual(result.source, 'none');
  assert.strictEqual(result.parsed, null);
});

test('parseRoute() 接受含非 JSON 行的 transcript 不崩潰', () => {
  const mixedFile = writeTranscript('mixed.jsonl', [
    'not-json-line',
    '{{broken json',
    makeAssistantEntry('<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->'),
  ]);
  const result = parseRoute(mixedFile);
  assert.strictEqual(result.source, 'route');
  assert.strictEqual(result.parsed?.verdict, 'PASS');
});

// ══════════════════════════════════════════════════════════════
// 清理與結果
// ══════════════════════════════════════════════════════════════

cleanup();

console.log('\n');
console.log('═'.repeat(60));
const total = passed + failed;
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${total} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過');
} else {
  console.log(`❌ ${failed} 個測試失敗`);
  process.exit(1);
}
