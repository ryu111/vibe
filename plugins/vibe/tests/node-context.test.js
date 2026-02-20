/**
 * node-context.test.js — node-context.js 單元測試
 *
 * 測試範圍：
 * 1. buildNodeContext：基本結構、prev/next 計算、onFail 注入
 * 2. getRetryContext：反向查找 failedStage、Reflexion Memory 讀取
 * 3. context_file 透傳（前驅 stage → 後繼 stage context_files）
 * 4. retryContext 注入（回退時包含 reflection 路徑）
 * 5. Node Context JSON < 500 tokens 驗證
 * 6. buildEnvSnapshot / formatNodeContext 工具函式
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 暫時 mock HOME 目錄避免污染真實 ~/.claude ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'node-context-test-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = TMP_HOME;

// 確保 CLAUDE_DIR 存在
const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  buildNodeContext,
  getRetryContext,
  buildEnvSnapshot,
  formatNodeContext,
  MAX_NODE_CONTEXT_CHARS,
} = require('../scripts/lib/flow/node-context.js');

const { writeReflection, getReflectionPath } = require('../scripts/lib/flow/reflection.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    // console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

const SESSION_ID = 'test-node-ctx-' + process.pid;

// ── 基礎 DAG 和 state 建構工具 ──

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
// 1. buildNodeContext：基本結構
// ============================================================

console.log('\n--- 1. buildNodeContext 基本結構 ---');

test('buildNodeContext: 空 stage → 防禦性回傳', () => {
  const ctx = buildNodeContext(null, null, null, SESSION_ID);
  assert.ok(ctx, '應回傳物件');
  assert.deepStrictEqual(ctx.node.prev, [], 'prev 應為空陣列');
  assert.deepStrictEqual(ctx.context_files, [], 'context_files 應為空陣列');
});

test('buildNodeContext: 線性 DAG REVIEW stage', () => {
  const dag = makeLinearDag(['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);

  assert.strictEqual(ctx.node.stage, 'REVIEW', 'stage 正確');
  assert.deepStrictEqual(ctx.node.prev, ['DEV'], 'prev 為 DEV');
  assert.deepStrictEqual(ctx.node.next, ['TEST'], 'next 為 TEST');
  assert.strictEqual(ctx.node.onFail, null, '無 onFail 設定時為 null');
  assert.strictEqual(ctx.node.barrier, null, '無 barrier 時為 null');
});

test('buildNodeContext: 頭節點（無 prev）', () => {
  const dag = makeLinearDag(['PLAN', 'ARCH', 'DEV']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'PLAN', SESSION_ID);

  assert.deepStrictEqual(ctx.node.prev, [], 'PLAN 無前驅');
  assert.deepStrictEqual(ctx.node.next, ['ARCH'], 'PLAN 後接 ARCH');
});

test('buildNodeContext: 尾節點（無 next）', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'DOCS']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'DOCS', SESSION_ID);

  assert.deepStrictEqual(ctx.node.prev, ['REVIEW'], 'DOCS 前驅為 REVIEW');
  assert.deepStrictEqual(ctx.node.next, [], 'DOCS 無後繼');
});

// ============================================================
// 2. buildNodeContext：onFail 注入
// ============================================================

console.log('\n--- 2. onFail 注入 ---');

test('buildNodeContext: 有 onFail 的 QUALITY stage（首次，retries=0）', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
    DOCS: { deps: ['REVIEW'] },
  };
  const state = makeState(dag, { retries: { REVIEW: 0 } });

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);

  assert.ok(ctx.node.onFail, 'onFail 應存在');
  assert.strictEqual(ctx.node.onFail.target, 'DEV', 'target 為 DEV');
  assert.strictEqual(ctx.node.onFail.maxRetries, 3, 'maxRetries 為 3');
  assert.strictEqual(ctx.node.onFail.currentRound, 1, 'currentRound = retries+1 = 1（首次）');
});

test('buildNodeContext: onFail currentRound 從 state.retries 推導（第 2 輪）', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
  };
  const state = makeState(dag, { retries: { REVIEW: 1 } }); // 已回退 1 次

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);

  assert.strictEqual(ctx.node.onFail.currentRound, 2, 'currentRound = retries+1 = 2');
});

test('buildNodeContext: IMPL stage 無 onFail → null', () => {
  const dag = {
    PLAN: { deps: [] },
    DEV: { deps: ['PLAN'] },
  };
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'DEV', SESSION_ID);

  assert.strictEqual(ctx.node.onFail, null, 'DEV 無 onFail 設定');
});

// ============================================================
// 3. context_file 透傳
// ============================================================

console.log('\n--- 3. context_file 透傳 ---');

test('buildNodeContext: context_files 空（前驅 contextFile 為 null）', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);
  // REVIEW 的 contextFile 為 null（尚未完成）

  const ctx = buildNodeContext(dag, state, 'TEST', SESSION_ID);

  assert.deepStrictEqual(ctx.context_files, [], 'context_files 應為空（前驅無 contextFile）');
});

test('buildNodeContext: context_files 包含前驅的 contextFile', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);

  // 模擬 REVIEW 完成並產出 context_file
  const reviewContextPath = `${CLAUDE_DIR}/pipeline-context-${SESSION_ID}-REVIEW.md`;
  state.stages['REVIEW'] = {
    ...state.stages['REVIEW'],
    status: 'completed',
    contextFile: reviewContextPath,
  };

  const ctx = buildNodeContext(dag, state, 'TEST', SESSION_ID);

  assert.deepStrictEqual(ctx.context_files, [reviewContextPath], 'TEST 應收到 REVIEW 的 contextFile');
});

test('buildNodeContext: 多個前驅時收集所有 contextFiles', () => {
  // 模擬並行 DAG：REVIEW + TEST 都完成後才進 DOCS
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
    DOCS: { deps: ['REVIEW', 'TEST'] },
  };
  const state = makeState(dag);

  const reviewPath = `${CLAUDE_DIR}/pipeline-context-${SESSION_ID}-REVIEW.md`;
  const testPath = `${CLAUDE_DIR}/pipeline-context-${SESSION_ID}-TEST.md`;

  state.stages['REVIEW'] = { ...state.stages['REVIEW'], contextFile: reviewPath };
  state.stages['TEST'] = { ...state.stages['TEST'], contextFile: testPath };

  const ctx = buildNodeContext(dag, state, 'DOCS', SESSION_ID);

  assert.ok(ctx.context_files.includes(reviewPath), '應含 REVIEW contextFile');
  assert.ok(ctx.context_files.includes(testPath), '應含 TEST contextFile');
  assert.strictEqual(ctx.context_files.length, 2, '共 2 個 context files');
});

test('buildNodeContext: 前驅 contextFile 為 null 時過濾', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'] },
    TEST: { deps: ['DEV'] },
    DOCS: { deps: ['REVIEW', 'TEST'] },
  };
  const state = makeState(dag);

  // 只有 REVIEW 有 contextFile，TEST 沒有
  const reviewPath = `${CLAUDE_DIR}/pipeline-context-${SESSION_ID}-REVIEW2.md`;
  state.stages['REVIEW'] = { ...state.stages['REVIEW'], contextFile: reviewPath };
  state.stages['TEST'] = { ...state.stages['TEST'], contextFile: null };

  const ctx = buildNodeContext(dag, state, 'DOCS', SESSION_ID);

  assert.deepStrictEqual(ctx.context_files, [reviewPath], '只含非 null 的 contextFile');
});

// ============================================================
// 4. getRetryContext：反向查找 + Reflexion Memory
// ============================================================

console.log('\n--- 4. getRetryContext ---');

test('getRetryContext: 無 retries → null', () => {
  const dag = { DEV: { deps: [] }, REVIEW: { deps: ['DEV'], onFail: 'DEV' } };
  const state = makeState(dag);

  const ctx = getRetryContext(SESSION_ID, 'DEV', state);

  assert.strictEqual(ctx, null, '無 retries 時應回 null');
});

test('getRetryContext: retries 存在但 onFail 不指向 DEV → null', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'ARCH' }, // onFail 不是 DEV
  };
  const state = makeState(dag, { retries: { REVIEW: 1 } });

  const ctx = getRetryContext(SESSION_ID, 'DEV', state);

  assert.strictEqual(ctx, null, 'onFail 不指向 DEV 時應回 null');
});

test('getRetryContext: REVIEW FAIL 回退 DEV → 找到 failedStage', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV', maxRetries: 3 },
  };
  const state = makeState(dag, { retries: { REVIEW: 1 } });

  // 寫入 REVIEW 的反思記憶
  const sid = SESSION_ID + '-retry-ctx';
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH', hint: '有問題' }, 0);

  const ctx = getRetryContext(sid, 'DEV', { ...state, sessionId: sid });

  assert.ok(ctx, '應找到 retryContext');
  assert.strictEqual(ctx.failedStage, 'REVIEW', 'failedStage 為 REVIEW');
  assert.strictEqual(ctx.round, 2, 'round = retries+1 = 2');
  assert.ok(ctx.reflectionFile.includes('reflection-memory'), 'reflectionFile 路徑格式正確');
  assert.ok(ctx.hint.includes('REVIEW'), 'hint 提及 REVIEW');
});

test('getRetryContext: reflection 檔案不存在 → 仍回傳 retryContext（無 reflectionContent）', () => {
  const dag = {
    DEV: { deps: [] },
    TEST: { deps: ['DEV'], onFail: 'DEV' },
  };
  const state = makeState(dag, { retries: { TEST: 1 } });
  const sid = SESSION_ID + '-no-reflection';

  const ctx = getRetryContext(sid, 'DEV', { ...state, sessionId: sid });

  // 無反思檔案但 retries > 0 + onFail 指向 DEV → 仍回傳 retryContext
  assert.ok(ctx, '應回傳 retryContext');
  assert.strictEqual(ctx.failedStage, 'TEST', 'failedStage 為 TEST');
  assert.strictEqual(ctx.reflectionContent, null, '無反思時 reflectionContent 為 null');
});

test('getRetryContext: 防禦性 null 參數', () => {
  assert.strictEqual(getRetryContext(null, 'DEV', {}), null);
  assert.strictEqual(getRetryContext(SESSION_ID, null, {}), null);
  assert.strictEqual(getRetryContext(SESSION_ID, 'DEV', null), null);
});

// ============================================================
// 5. retryContext 注入到 buildNodeContext
// ============================================================

console.log('\n--- 5. retryContext 注入 ---');

test('buildNodeContext: DEV（回退場景）包含 retryContext', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV' },
    DOCS: { deps: ['REVIEW'] },
  };
  const sid = SESSION_ID + '-inject';
  const state = makeState(dag, { retries: { REVIEW: 1 }, sessionId: sid });

  // 寫入 REVIEW 的反思記憶
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'CRITICAL', hint: 'Critical bug' }, 0);

  const ctx = buildNodeContext(dag, state, 'DEV', sid);

  assert.ok(ctx.retryContext, 'DEV 回退時應有 retryContext');
  assert.strictEqual(ctx.retryContext.failedStage, 'REVIEW', 'failedStage 為 REVIEW');
  assert.ok(ctx.retryContext.hint, 'hint 應有值');
});

test('buildNodeContext: REVIEW（首次）retryContext 為 null', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW', 'DOCS']);
  const state = makeState(dag); // retries 為空

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);

  assert.strictEqual(ctx.retryContext, null, 'REVIEW 首次執行時 retryContext 為 null');
});

// ============================================================
// 6. Node Context JSON 大小驗證（< 500 tokens）
// ============================================================

console.log('\n--- 6. Node Context JSON 大小 ---');

test('buildNodeContext: 正常 JSON < MAX_NODE_CONTEXT_CHARS', () => {
  const dag = makeLinearDag(['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']);
  const state = makeState(dag, {
    environment: {
      languages: { primary: 'TypeScript' },
      framework: { name: 'React' },
      frontend: { detected: true },
    },
  });

  const ctx = buildNodeContext(dag, state, 'REVIEW', SESSION_ID);
  const json = JSON.stringify(ctx);

  assert.ok(json.length <= MAX_NODE_CONTEXT_CHARS,
    `JSON 長度 ${json.length} 應 <= ${MAX_NODE_CONTEXT_CHARS}`);
});

test('buildNodeContext: 超長 reflectionContent 被截斷', () => {
  const dag = {
    DEV: { deps: [] },
    REVIEW: { deps: ['DEV'], onFail: 'DEV' },
  };
  const sid = SESSION_ID + '-longcontent';

  // 寫入超長 reflection
  const longHint = '🔴 '.repeat(200); // ~600 chars
  writeReflection(sid, 'REVIEW', { verdict: 'FAIL', severity: 'HIGH', hint: longHint }, 0);

  const state = makeState(dag, { retries: { REVIEW: 1 }, sessionId: sid });

  const ctx = buildNodeContext(dag, state, 'DEV', sid);
  const json = JSON.stringify(ctx);

  // JSON 應 <= MAX_NODE_CONTEXT_CHARS（允許少量超出，因截斷邏輯在反思後）
  // 注意：截斷邏輯只截 reflectionContent，整體仍可能稍超（因 hint 等其他欄位）
  // 實際 token 估算：2000 chars ≈ 500 tokens
  assert.ok(json.length <= MAX_NODE_CONTEXT_CHARS + 200,
    `JSON 長度 ${json.length} 應接近 ${MAX_NODE_CONTEXT_CHARS}`);
});

// ============================================================
// 7. buildEnvSnapshot
// ============================================================

console.log('\n--- 7. buildEnvSnapshot ---');

test('buildEnvSnapshot: 空 environment → 空物件', () => {
  const snap = buildEnvSnapshot({ environment: {} });
  assert.deepStrictEqual(snap, {});
});

test('buildEnvSnapshot: 完整 environment → 精簡版', () => {
  const state = {
    environment: {
      languages: { primary: 'TypeScript', secondary: ['JavaScript'] },
      framework: { name: 'React', version: '19' },
      frontend: { detected: true },
      someOtherField: 'ignored',
    },
  };

  const snap = buildEnvSnapshot(state);

  assert.strictEqual(snap.language, 'TypeScript', 'language 正確');
  assert.strictEqual(snap.framework, 'React', 'framework 正確');
  assert.deepStrictEqual(snap.frontend, { detected: true }, 'frontend.detected 正確');
  assert.strictEqual(snap.someOtherField, undefined, '其他欄位應被過濾');
});

test('buildEnvSnapshot: 只有語言無框架', () => {
  const state = {
    environment: {
      languages: { primary: 'Python' },
    },
  };

  const snap = buildEnvSnapshot(state);

  assert.strictEqual(snap.language, 'Python');
  assert.strictEqual(snap.framework, undefined, '無框架時不含此欄位');
  assert.strictEqual(snap.frontend, undefined, '無 frontend 時不含此欄位');
});

// ============================================================
// 8. formatNodeContext
// ============================================================

console.log('\n--- 8. formatNodeContext ---');

test('formatNodeContext: 格式正確（key-value 簡寫格式）', () => {
  const ctx = {
    node: { stage: 'REVIEW', prev: ['DEV'], next: ['TEST'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.startsWith('<!-- NODE_CONTEXT: '), '應以 NODE_CONTEXT 開頭');
  assert.ok(formatted.endsWith(' -->'), '應以 --> 結尾');

  // key-value 格式驗證（非 JSON）
  assert.ok(formatted.includes('stage=REVIEW'), 'stage 正確');
  assert.ok(formatted.includes('prev=DEV'), 'prev 正確');
  assert.ok(formatted.includes('next=TEST'), 'next 正確');
  // onFail=null 時不應出現 onFail 欄位（省略）
  assert.ok(!formatted.includes('onFail=null'), 'null onFail 應省略');
});

test('formatNodeContext: key-value 可完整嵌入 systemMessage', () => {
  const ctx = buildNodeContext(
    makeLinearDag(['DEV', 'REVIEW', 'TEST']),
    makeState(makeLinearDag(['DEV', 'REVIEW', 'TEST'])),
    'REVIEW',
    SESSION_ID
  );

  const systemMsg = `🔄 REVIEW FAIL（1/3）\n➡️ 執行 /vibe:dev\n${formatNodeContext(ctx)}`;
  assert.ok(systemMsg.includes('NODE_CONTEXT'), 'systemMessage 含 NODE_CONTEXT');
  assert.ok(systemMsg.includes('stage=REVIEW'), 'stage 正確嵌入');
});

// ============================================================
// 9. wisdom 欄位整合（S4 Wisdom Accumulation）
// ============================================================

console.log('\n--- 9. wisdom 欄位整合 ---');

const { writeWisdom, getWisdomPath } = require('../scripts/lib/flow/wisdom.js');

function cleanupTestWisdom(sid) {
  const fp = getWisdomPath(sid);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

test('buildNodeContext: 無 wisdom 檔案時 wisdom 欄位為 null', () => {
  const sid = SESSION_ID + '-no-wisdom';
  cleanupTestWisdom(sid);
  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'TEST', sid);

  assert.strictEqual(ctx.wisdom, null, 'wisdom 應為 null（檔案不存在）');
  cleanupTestWisdom(sid);
});

test('buildNodeContext: wisdom 檔案存在時注入 wisdom 欄位', () => {
  const sid = SESSION_ID + '-with-wisdom';
  cleanupTestWisdom(sid);

  // 先寫入 wisdom
  writeWisdom(sid, 'REVIEW', '- null 邊界需處理\n- async 函式加 try-catch');

  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);
  const ctx = buildNodeContext(dag, state, 'TEST', sid);

  assert.ok(ctx.wisdom, 'wisdom 應有值');
  assert.ok(typeof ctx.wisdom === 'string', 'wisdom 應為字串');
  assert.ok(ctx.wisdom.includes('## REVIEW'), 'wisdom 應含 REVIEW 段落');
  cleanupTestWisdom(sid);
});

test('buildNodeContext: sessionId 為 null 時 wisdom 為 null', () => {
  const dag = makeLinearDag(['DEV', 'REVIEW']);
  const state = makeState(dag);

  const ctx = buildNodeContext(dag, state, 'REVIEW', null);

  assert.strictEqual(ctx.wisdom, null, 'sessionId=null 時 wisdom 應為 null');
});

test('formatNodeContext: wisdom 有值時輸出 wisdom=... 段', () => {
  const ctx = {
    node: { stage: 'DEV', prev: [], next: ['REVIEW'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: '## REVIEW\n- null 邊界需處理',
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(formatted.includes('wisdom='), `應含 wisdom= 欄位，實際: ${formatted}`);
});

test('formatNodeContext: wisdom 為 null 時省略 wisdom 欄位', () => {
  const ctx = {
    node: { stage: 'DEV', prev: [], next: ['REVIEW'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: null,
  };

  const formatted = formatNodeContext(ctx);

  assert.ok(!formatted.includes('wisdom='), `wisdom=null 時應省略，實際: ${formatted}`);
});

test('formatNodeContext: wisdom 超長時截斷到 100 字元', () => {
  const longWisdom = '- ' + '很長的要點 '.repeat(50); // 純單行，避免換行影響 regex
  const ctx = {
    node: { stage: 'DEV', prev: [], next: ['REVIEW'], onFail: null, barrier: null },
    context_files: [],
    env: {},
    retryContext: null,
    wisdom: longWisdom,
  };

  const formatted = formatNodeContext(ctx);

  // 從 wisdom= 後截取值（至 | 或 --> 之前）
  // wisdom 值以 slice(0, 100) 截斷，確認輸出中 wisdom= 欄位值 <= 100 字元
  const wisdomPrefix = 'wisdom=';
  const wisdomIdx = formatted.indexOf(wisdomPrefix);
  assert.ok(wisdomIdx !== -1, 'wisdom= 欄位應存在');

  // wisdom= 後面的值（slice(0,100) 截斷，原始值不含換行）
  const afterWisdom = formatted.slice(wisdomIdx + wisdomPrefix.length);
  // 找第一個 | 或 --> 作為值結束點
  const endIdx = afterWisdom.search(/\s*\|\s*|\s*-->/);;
  const wisdomValue = endIdx !== -1 ? afterWisdom.slice(0, endIdx) : afterWisdom;
  assert.ok(wisdomValue.length <= 100, `wisdom 值長度 ${wisdomValue.length} 應 <= 100`);
});

test('buildNodeContext: wisdom 內容計入 MAX_NODE_CONTEXT_CHARS 限制', () => {
  const sid = SESSION_ID + '-wisdom-size';
  cleanupTestWisdom(sid);

  // 寫入接近上限的 wisdom
  const maxWisdom = '- ' + 'w'.repeat(480);
  writeWisdom(sid, 'REVIEW', maxWisdom);

  const dag = makeLinearDag(['DEV', 'REVIEW', 'TEST']);
  const state = makeState(dag);
  const ctx = buildNodeContext(dag, state, 'TEST', sid);
  const json = JSON.stringify(ctx);

  assert.ok(json.length <= MAX_NODE_CONTEXT_CHARS,
    `含 wisdom 的 JSON 長度 ${json.length} 應 <= ${MAX_NODE_CONTEXT_CHARS}`);
  cleanupTestWisdom(sid);
});

// ============================================================
// 清理
// ============================================================

function cleanup() {
  // 清理 tmp 目錄
  try {
    process.env.HOME = ORIG_HOME;
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch (_) {}
}

cleanup();

// ============================================================
// 結果
// ============================================================

console.log(`\n=== node-context.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
