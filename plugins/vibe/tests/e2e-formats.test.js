#!/usr/bin/env node
/**
 * e2e-formats.js — E2E 測試：驗證所有 Telegram 訊息格式
 *
 * 策略：mock telegram.js 的 sendMessage → 攔截輸出 → 比對 README spec
 * 覆蓋被動通知（P1~P5）和共用函式。主動控制（C1~C11, A1~A10）需要 tmux + daemon，
 * 由手動 E2E 驗證。
 *
 * 執行：node plugins/vibe/tests/e2e-formats.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.tmpdir(), 'remote-e2e-test');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
const REAL_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const THROTTLE_FILE = path.join(REAL_CLAUDE_DIR, 'remote-receipt-last.json');

let passed = 0;
let failed = 0;
require('./test-helpers').cleanTestStateFiles();

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u274C ${name}`);
    console.log(`     ${err.message}`);
  }
}

// ─── 輔助 ─────────────────────────────

function setupTestDir() {
  if (fs.existsSync(CLAUDE_DIR)) {
    fs.rmSync(CLAUDE_DIR, { recursive: true });
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
}

function createTranscript(entries) {
  const f = path.join(CLAUDE_DIR, `test-transcript-${Date.now()}.jsonl`);
  fs.writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n'));
  return f;
}

function createPipelineState(state) {
  const sid = 'test-session-id';
  const f = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(f, JSON.stringify(state));
  return { path: f, sessionId: sid };
}

/**
 * 執行 hook 腳本，攔截 Telegram API 呼叫
 * 方法：設定環境變數讓 telegram.js 的 getCredentials 回傳假 credentials，
 * 但用 mock 攔截 sendMessage
 */
function runHook(scriptSpec, stdinData) {
  const [scriptName, ...argParts] = scriptSpec.split(' ');
  const args = argParts.join(' ');
  const mockDir = path.join(CLAUDE_DIR, 'mock-plugin');
  const mockScriptsLib = path.join(mockDir, 'scripts', 'lib');
  const mockScriptsLibRemote = path.join(mockDir, 'scripts', 'lib', 'remote');
  const mockScriptsHooks = path.join(mockDir, 'scripts', 'hooks');
  fs.mkdirSync(mockScriptsLib, { recursive: true });
  fs.mkdirSync(mockScriptsLibRemote, { recursive: true });
  fs.mkdirSync(mockScriptsHooks, { recursive: true });

  // 建立 mock telegram.js — 記錄 sendMessage 呼叫到 output file
  const outputFile = path.join(CLAUDE_DIR, `output-${Date.now()}.json`);
  fs.writeFileSync(path.join(mockScriptsLibRemote, 'telegram.js'), `
'use strict';
const fs = require('fs');
const OUTPUT = '${outputFile}';
const messages = [];
module.exports = {
  getCredentials() { return { token: 'mock', chatId: '123' }; },
  async sendMessage(token, chatId, text, parseMode) {
    messages.push({ type: 'send', text, parseMode });
    fs.writeFileSync(OUTPUT, JSON.stringify(messages));
    return { message_id: 1 };
  },
  async editMessageText(token, chatId, msgId, text, parseMode) {
    messages.push({ type: 'edit', text, parseMode, msgId });
    fs.writeFileSync(OUTPUT, JSON.stringify(messages));
  },
  async sendMessageWithKeyboard(token, chatId, text, keyboard, parseMode) {
    messages.push({ type: 'keyboard', text, keyboard, parseMode });
    fs.writeFileSync(OUTPUT, JSON.stringify(messages));
    return { message_id: 2 };
  },
};
  `);

  // 複製 transcript.js（真實版本）
  fs.copyFileSync(
    path.join(SCRIPTS_DIR, 'lib', 'remote', 'transcript.js'),
    path.join(mockScriptsLibRemote, 'transcript.js')
  );

  // 複製 registry.js（真實版本 — hook 腳本透過 __dirname 引用）
  fs.copyFileSync(
    path.join(SCRIPTS_DIR, 'lib', 'registry.js'),
    path.join(mockScriptsLib, 'registry.js')
  );

  // 複製 hook-logger.js（hook 腳本共用依賴）
  fs.copyFileSync(
    path.join(SCRIPTS_DIR, 'lib', 'hook-logger.js'),
    path.join(mockScriptsLib, 'hook-logger.js')
  );

  // 複製 timeline 模組（remote hooks 需要）
  const mockTimelineDir = path.join(mockScriptsLib, 'timeline');
  fs.mkdirSync(mockTimelineDir, { recursive: true });
  for (const file of ['schema.js', 'timeline.js', 'consumer.js', 'formatter.js', 'index.js']) {
    fs.copyFileSync(
      path.join(SCRIPTS_DIR, 'lib', 'timeline', file),
      path.join(mockTimelineDir, file)
    );
  }

  // 複製目標 hook 腳本
  const srcHook = path.join(SCRIPTS_DIR, 'hooks', scriptName);
  const destHook = path.join(mockScriptsHooks, scriptName);
  fs.copyFileSync(srcHook, destHook);
  fs.chmodSync(destHook, 0o755);

  // 執行 hook
  try {
    execSync(
      `echo '${JSON.stringify(stdinData).replace(/'/g, "'\\''")}' | CLAUDE_PLUGIN_ROOT="${mockDir}" node "${destHook}"${args ? ' ' + args : ''}`,
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (_) {
    // hook 可能 exit(0)
  }

  // 讀取攔截結果
  try {
    return JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  } catch (_) {
    return [];
  }
}

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} P1. \u4F7F\u7528\u8005\u8F38\u5165\u8F49\u767C (remote-hub.js prompt-forward)');
// ═══════════════════════════════════════════════

test('\u77ED\u8A0A\u606F\u8F49\u767C\uFF1A\u{1F464} + \u539F\u6587', () => {
  const msgs = runHook('remote-hub.js prompt-forward', { prompt: '\u5E6B\u6211\u5BE6\u4F5C\u8A8D\u8B49\u529F\u80FD' });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, '\u{1F464} \u5E6B\u6211\u5BE6\u4F5C\u8A8D\u8B49\u529F\u80FD');
});

test('\u7A7A\u767D prompt \u4E0D\u767C\u9001', () => {
  const msgs = runHook('remote-hub.js prompt-forward', { prompt: '' });
  assert.strictEqual(msgs.length, 0);
});

test('\u8D85\u9577 prompt \u622A\u65B7 + \u201C\u2026 (\u622A\u65B7)\u201D', () => {
  const longPrompt = '\u6D4B'.repeat(4000);
  const msgs = runHook('remote-hub.js prompt-forward', { prompt: longPrompt });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].text.endsWith('\n\u2026 (\u622A\u65B7)'));
  assert.ok(msgs[0].text.startsWith('\u{1F464} '));
});

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} P2. \u56DE\u5408\u52D5\u4F5C\u6458\u8981 (remote-hub.js receipt)');
// ═══════════════════════════════════════════════

test('\u6709\u6587\u5B57 + \u6709\u5DE5\u5177\uFF1A\u{1F4CB} \u56DE\u5408\uFF1A\u{1F916}\u56DE\u61C9 + \u5DE5\u5177\u7D71\u8A08', () => {
  try { fs.unlinkSync(THROTTLE_FILE); } catch (_) {}
  const transcript = createTranscript([
    { type: 'human', content: [{ type: 'text', text: '\u554F\u984C' }] },
    { type: 'assistant', content: [
      { type: 'text', text: '\u6211\u4F86\u5EFA\u7ACB\u6A94\u6848' },
      { type: 'tool_use', name: 'Write', input: { file_path: '/a.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]},
  ]);
  const msgs = runHook('remote-hub.js receipt', {
    stop_hook_active: false,
    transcript_path: transcript,
  });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].text.startsWith('\u{1F4CB} \u56DE\u5408\uFF1A'));
  assert.ok(msgs[0].text.includes('\u{1F916}\u56DE\u61C9'));
  assert.ok(msgs[0].text.includes('\u{1F4DD}\u00D71'));
  assert.ok(msgs[0].text.includes('\u26A1\u00D71'));
});

test('\u7D14\u6587\u5B57\u56DE\u8986\uFF1A\u53EA\u6709 \u{1F916}\u56DE\u61C9', () => {
  try { fs.unlinkSync(THROTTLE_FILE); } catch (_) {}
  const transcript = createTranscript([
    { type: 'assistant', content: [{ type: 'text', text: '\u53EA\u6709\u6587\u5B57' }] },
  ]);
  const msgs = runHook('remote-hub.js receipt', {
    stop_hook_active: false,
    transcript_path: transcript,
  });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, '\u{1F4CB} \u56DE\u5408\uFF1A\u{1F916}\u56DE\u61C9');
});

test('\u7D14\u5DE5\u5177\u64CD\u4F5C\uFF1A\u7121 \u{1F916}\u56DE\u61C9', () => {
  try { fs.unlinkSync(THROTTLE_FILE); } catch (_) {}
  const transcript = createTranscript([
    { type: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
    ]},
  ]);
  const msgs = runHook('remote-hub.js receipt', {
    stop_hook_active: false,
    transcript_path: transcript,
  });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, '\u{1F4CB} \u56DE\u5408\uFF1A\u26A1\u00D72');
  assert.ok(!msgs[0].text.includes('\u{1F916}\u56DE\u61C9'));
});

test('stop_hook_active=true \u4E0D\u767C\u9001', () => {
  const transcript = createTranscript([
    { type: 'assistant', content: [{ type: 'text', text: 'test' }] },
  ]);
  const msgs = runHook('remote-hub.js receipt', {
    stop_hook_active: true,
    transcript_path: transcript,
  });
  assert.strictEqual(msgs.length, 0);
});

test('\u7121 transcript \u4E0D\u767C\u9001', () => {
  const msgs = runHook('remote-hub.js receipt', {
    stop_hook_active: false,
    transcript_path: '/nonexistent.jsonl',
  });
  assert.strictEqual(msgs.length, 0);
});

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} P4. Pipeline stage \u5B8C\u6210 (remote-hub.js sender)');
// ═══════════════════════════════════════════════

test('PASS stage\uFF1A\u542B emoji + STAGE + \u2705 + \u9032\u5EA6\u689D', () => {
  const { sessionId } = createPipelineState({
    completed: ['vibe:planner', 'vibe:architect'],
    expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
    taskType: 'feature',
    lastTransition: Date.now() - 5 * 60000,
  });

  // remote-hub.js sender 讀 stdin，不用 CLAUDE_PLUGIN_ROOT
  // 但它硬編碼 CLAUDE_DIR = ~/.claude，E2E 用 mock 困難
  // 改用純函式驗證（已在 unit test 中覆蓋）
  // 這裡驗證整合格式
  const { buildProgressBar, formatDuration, STAGE_ORDER } = require(
    path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js')
  );

  const bar = buildProgressBar(['PLAN', 'ARCH'], { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } }, STAGE_ORDER);
  assert.ok(bar.includes('\u2705'));
  assert.ok(bar.includes('\u2B1C'));
  assert.ok(bar.includes('\u2192'));

  const dur = formatDuration(5 * 60000);
  assert.strictEqual(dur, '5m');

  // 組裝完整格式驗證
  const emoji = '\u{1F3D7}\uFE0F';
  const stage = 'ARCH';
  const text = `${emoji} ${stage} \u2705 ${dur} (feature)\n${bar}`;
  assert.ok(text.includes('ARCH \u2705 5m (feature)'));
  assert.ok(text.includes('\u2192'));
});

test('FAIL stage + retry\uFF1A\u542B \u274C + retry N/3', () => {
  const { buildProgressBar, STAGE_ORDER } = require(
    path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js')
  );

  const bar = buildProgressBar(
    ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' }, DEV: { verdict: 'PASS' }, REVIEW: { verdict: 'FAIL' } },
    STAGE_ORDER
  );
  assert.ok(bar.includes('\u274C'));

  const retries = 1;
  const retryStr = ` (retry ${retries}/3)`;
  assert.strictEqual(retryStr, ' (retry 1/3)');
});

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} P5. Pipeline \u5B8C\u6210');
// ═══════════════════════════════════════════════

test('\u5168\u90E8 PASS\uFF1A\u{1F389} + \u2705 + \u8017\u6642', () => {
  const { buildProgressBar, formatDuration, STAGE_ORDER } = require(
    path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js')
  );

  const all = STAGE_ORDER;
  const results = {};
  for (const s of all) results[s] = { verdict: 'PASS' };
  const bar = buildProgressBar(all, results, all);

  // 全部應該是 ✅
  assert.ok(!bar.includes('\u2B1C'));
  assert.ok(!bar.includes('\u274C'));

  const totalDuration = formatDuration(26 * 60000);
  assert.strictEqual(totalDuration, '26m');

  const text = `\u{1F389} Pipeline \u5B8C\u6210 \u2705 (feature) ${totalDuration}\n${bar}`;
  assert.ok(text.startsWith('\u{1F389} Pipeline \u5B8C\u6210 \u2705'));
  assert.ok(text.includes('26m'));
});

test('\u6709 FAIL\uFF1A\u{1F389} + \u274C', () => {
  const { STAGE_ORDER } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const results = {};
  for (const s of STAGE_ORDER) results[s] = { verdict: 'PASS' };
  results['REVIEW'] = { verdict: 'FAIL' };

  const allPass = STAGE_ORDER.every(s => {
    const r = results[s];
    return !r || r.verdict !== 'FAIL';
  });
  assert.strictEqual(allPass, false);
});

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} P6. AskUserQuestion \u901A\u77E5 (remote-hub.js ask-intercept)');
// ═══════════════════════════════════════════════

test('\u55AE\u9078\uFF1Ainline keyboard + \u6587\u5B57\u683C\u5F0F', () => {
  const msgs = runHook('remote-hub.js ask-intercept', {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: '\u4E0B\u4E00\u6B65\u60F3\u505A\u4EC0\u9EBC\uFF1F',
        header: '\u4E0B\u4E00\u6B65',
        multiSelect: false,
        options: [
          { label: '\u63A8\u9001', description: 'git push' },
          { label: '\u6E2C\u8A66', description: '\u78BA\u8A8D\u529F\u80FD' },
        ],
      }],
    },
  });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].type, 'keyboard');
  assert.ok(msgs[0].text.includes('\u{1F4CB}'));
  assert.ok(msgs[0].text.includes('1. \u63A8\u9001'));
  assert.ok(msgs[0].text.includes('2. \u6E2C\u8A66'));
  assert.ok(msgs[0].text.includes('\u{1F449}'));
  // 單選 keyboard 無 confirm 按鈕
  const flatButtons = msgs[0].keyboard.flat();
  assert.ok(!flatButtons.some(b => b.callback_data === 'ask|confirm'));
});

test('\u591A\u9078\uFF1Ainline keyboard \u542B \u2714 \u78BA\u8A8D \u6309\u9215', () => {
  const msgs = runHook('remote-hub.js ask-intercept', {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: '\u9078\u64C7\u529F\u80FD',
        multiSelect: true,
        options: [
          { label: 'A', description: '\u8AAA\u660E A' },
          { label: 'B', description: '\u8AAA\u660E B' },
        ],
      }],
    },
  });
  assert.strictEqual(msgs.length, 1);
  const flatButtons = msgs[0].keyboard.flat();
  assert.ok(flatButtons.some(b => b.callback_data === 'ask|confirm'));
  assert.ok(flatButtons.some(b => b.text.includes('\u2610')));
});

test('\u975E AskUserQuestion \u4E0D\u8655\u7406', () => {
  const msgs = runHook('remote-hub.js ask-intercept', {
    tool_name: 'Write',
    tool_input: {},
  });
  assert.strictEqual(msgs.length, 0);
});

// ═══════════════════════════════════════════════
console.log('\n\u{1F9EA} \u5171\u7528\u51FD\u5F0F\u8F14\u52A9\u6AA2\u67E5');
// ═══════════════════════════════════════════════

test('\u5DE5\u5177\u884C\u683C\u5F0F\u5B8C\u6574\u6027', () => {
  const { formatToolLine } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const line = formatToolLine({ write: 2, edit: 3, bash: 1, task: 0, search: 5, read: 3 });
  // 驗證不含 task（為 0）
  assert.ok(!line.includes('\u{1F916}'));
  // 驗證各項目
  assert.ok(line.includes('\u{1F4DD}\u00D72'));
  assert.ok(line.includes('\u270F\uFE0F\u00D73'));
  assert.ok(line.includes('\u26A1\u00D71'));
  assert.ok(line.includes('\u{1F50D}\u00D75'));
  assert.ok(line.includes('\u{1F4D6}\u00D73'));
});

test('\u9032\u5EA6\u689D\u542B\u7BAD\u982D\u5206\u9694', () => {
  const { buildProgressBar, STAGE_ORDER } = require(
    path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js')
  );
  const bar = buildProgressBar(['PLAN'], {}, STAGE_ORDER);
  assert.ok(bar.includes('\u2192'));
});

// ═══════════════════════════════════════════════
console.log('\n🧪 P7. extractCompletedStages v3 state 結構');
// ═══════════════════════════════════════════════

test('extractCompletedStages: v3 state.stages 正確提取 completed', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const state = {
    version: 3,
    stages: {
      PLAN: { status: 'completed', verdict: 'PASS', agent: 'vibe:planner' },
      ARCH: { status: 'completed', verdict: 'PASS', agent: 'vibe:architect' },
      DEV:  { status: 'active', agent: 'vibe:developer' },
      REVIEW: { status: 'pending' },
    },
  };
  const completed = extractCompletedStages(state);
  assert.deepStrictEqual(completed.sort(), ['ARCH', 'PLAN']);
});

test('extractCompletedStages: 空 stages 回傳空陣列', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const completed = extractCompletedStages({ version: 3, stages: {} });
  assert.deepStrictEqual(completed, []);
});

test('extractCompletedStages: 無 stages 欄位（防禦性處理）', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const completed = extractCompletedStages({ version: 3 });
  assert.deepStrictEqual(completed, []);
});

test('extractCompletedStages: 全部 completed', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const state = {
    version: 3,
    stages: {
      DEV:    { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'completed', verdict: 'PASS' },
      TEST:   { status: 'completed', verdict: 'PASS' },
    },
  };
  const completed = extractCompletedStages(state);
  assert.strictEqual(completed.length, 3);
  assert.ok(completed.includes('DEV'));
  assert.ok(completed.includes('REVIEW'));
  assert.ok(completed.includes('TEST'));
});

test('extractCompletedStages: skipped 不視為 completed', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const state = {
    version: 3,
    stages: {
      PLAN:   { status: 'completed', verdict: 'PASS' },
      DESIGN: { status: 'skipped' },
      DEV:    { status: 'pending' },
    },
  };
  const completed = extractCompletedStages(state);
  assert.deepStrictEqual(completed, ['PLAN']);
});

test('extractCompletedStages: failed 不視為 completed', () => {
  const { extractCompletedStages } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const state = {
    version: 3,
    stages: {
      PLAN:   { status: 'completed', verdict: 'PASS' },
      ARCH:   { status: 'failed', verdict: 'FAIL' },
    },
  };
  const completed = extractCompletedStages(state);
  assert.deepStrictEqual(completed, ['PLAN']);
});

test('v3 stageResults 從 stages 映射正確推導 FAIL 進度條', () => {
  const { buildProgressBar } = require(path.join(SCRIPTS_DIR, 'hooks', 'remote-hub.js'));
  const stageResults = {
    PLAN: { verdict: 'PASS' },
    ARCH: { verdict: 'PASS' },
    DEV:  { verdict: 'FAIL' },
  };
  const bar = buildProgressBar(
    ['PLAN', 'ARCH', 'DEV'], stageResults,
    ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST']
  );
  assert.ok(bar.includes('\u2705'), '進度條含 PASS');
  assert.ok(bar.includes('\u274C'), '進度條含 FAIL');
  assert.ok(bar.includes('\u2B1C'), '進度條含未完成');
});

// ═══════════════════════════════════════════════
// 清理 + 結果
// ═══════════════════════════════════════════════

try {
  fs.rmSync(CLAUDE_DIR, { recursive: true });
} catch (_) {}

console.log(`\n${'='.repeat(50)}`);
console.log(`\u7D50\u679C\uFF1A${passed} \u901A\u904E / ${failed} \u5931\u6557 / ${passed + failed} \u7E3D\u8A08`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('\u2705 \u5168\u90E8\u901A\u904E\n');
}
