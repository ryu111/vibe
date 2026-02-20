#!/usr/bin/env node
/**
 * none-pipeline-protection.test.js — none pipeline 寫入防護完整測試
 *
 * 測試範圍：
 * A. canProceed() none-write-limit 硬阻擋（pipeline-controller.js）
 * B. runNonePipelineCheck() 軟提醒（post-edit.js）
 * C. classify 後計數器重設（pipeline-controller.js classify()）
 * D. 邊界案例與錯誤路徑
 *
 * 執行：node plugins/vibe/tests/none-pipeline-protection.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ── 被測模組 ──────────────────────────────────────────────

const { canProceed } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

const {
  runNonePipelineCheck,
} = require(path.join(PLUGIN_ROOT, 'scripts/hooks/post-edit.js'));

// ── 測試計數器 ─────────────────────────────────────────────

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

// ── 共用工具函式 ───────────────────────────────────────────

/** 建立 none pipeline state 檔案 */
function writeNoneState(sessionId) {
  const state = {
    version: 4,
    sessionId,
    classification: { taskType: 'chat', pipelineId: 'none', source: 'test' },
    dag: {},
    dagStages: [],
    stages: {},
    pipelineActive: false,
    activeStages: [],
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const stateFilePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  return stateFilePath;
}

/** 建立 quick-dev pipeline state 檔案 */
function writeQuickDevState(sessionId) {
  const state = {
    version: 4,
    sessionId,
    classification: { taskType: 'quickfix', pipelineId: 'quick-dev', source: 'test' },
    dag: {
      DEV: { deps: [] },
      REVIEW: { deps: ['DEV'] },
    },
    dagStages: ['DEV', 'REVIEW'],
    stages: {
      DEV: { status: 'pending', agent: null, verdict: null },
      REVIEW: { status: 'pending', agent: null, verdict: null },
    },
    pipelineActive: true,
    activeStages: [],
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const stateFilePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  return stateFilePath;
}

/** 寫入計數器檔案 */
function writeCounter(sessionId, count) {
  const counterPath = path.join(CLAUDE_DIR, `none-writes-${sessionId}.json`);
  fs.writeFileSync(counterPath, JSON.stringify({ count }), 'utf8');
  return counterPath;
}

/** 讀取計數器數值 */
function readCounter(sessionId) {
  const counterPath = path.join(CLAUDE_DIR, `none-writes-${sessionId}.json`);
  try {
    const raw = fs.readFileSync(counterPath, 'utf8');
    return JSON.parse(raw).count || 0;
  } catch (_) {
    return null;
  }
}

/** 清理測試暫存檔 */
function cleanup(sessionId) {
  const counterPath = path.join(CLAUDE_DIR, `none-writes-${sessionId}.json`);
  const stateFilePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try { fs.unlinkSync(counterPath); } catch (_) {}
  try { fs.unlinkSync(stateFilePath); } catch (_) {}
}

// 唯一 session ID 前綴（避免測試間汙染）
const TS = Date.now();

// ═══════════════════════════════════════════════════════
console.log('\n🔒 A. canProceed() none-write-limit 硬阻擋');
console.log('═'.repeat(60));
// ═══════════════════════════════════════════════════════

test('A1: none pipeline + Write 程式碼檔案 + count >= 3 → block', () => {
  const sid = `test-a1-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 3);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'block', 'count=3 應被硬阻擋');
    assert.strictEqual(r.reason, 'none-pipeline-write-limit', '原因應為 none-pipeline-write-limit');
    assert.ok(r.message.includes('⛔'), 'message 應包含 ⛔ 警示符號');
    assert.ok(r.message.includes('3 次'), `message 應包含累計次數：${r.message}`);
    assert.ok(r.message.includes('/vibe:pipeline'), 'message 應提示使用 /vibe:pipeline');
  } finally {
    cleanup(sid);
  }
});

test('A2: none pipeline + Write 程式碼檔案 + count < 3 → allow', () => {
  const sid = `test-a2-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 2);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'allow', 'count=2 < 3 應放行');
  } finally {
    cleanup(sid);
  }
});

test('A3: none pipeline + Write .md 檔案 → allow（isNonCodeFile）', () => {
  const sid = `test-a3-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 10); // 超高計數也不阻擋非程式碼
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/docs/README.md' });
    assert.strictEqual(r.decision, 'allow', 'Markdown 檔案不受 none 防護影響');
  } finally {
    cleanup(sid);
  }
});

test('A4: none pipeline + Read 工具 → allow（工具型別過濾）', () => {
  const sid = `test-a4-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 10); // 超高計數，但 Read 不觸發防護
  try {
    const r = canProceed(sid, 'Read', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'allow', 'Read 工具不受 none-write-limit 影響');
  } finally {
    cleanup(sid);
  }
});

test('A5: quick-dev pipeline + Write 程式碼檔案 → 不走 none 邏輯（reason 不是 none-pipeline-write-limit）', () => {
  const sid = `test-a5-${TS}`;
  writeQuickDevState(sid);
  writeCounter(sid, 10); // 即使有計數器也不觸發
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.notStrictEqual(r.reason, 'none-pipeline-write-limit', 'quick-dev pipeline 不應觸發 none 防護');
  } finally {
    cleanup(sid);
  }
});

test('A6: none pipeline + Edit 程式碼檔案 + count >= 3 → block', () => {
  const sid = `test-a6-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 4);
  try {
    const r = canProceed(sid, 'Edit', { file_path: '/Users/test/src/utils.py' });
    assert.strictEqual(r.decision, 'block', 'Edit 工具也應被 none 防護阻擋');
    assert.strictEqual(r.reason, 'none-pipeline-write-limit');
    assert.ok(r.message.includes('4 次'), `message 應包含 4 次：${r.message}`);
  } finally {
    cleanup(sid);
  }
});

test('A7: 計數器不存在 → count=0 → allow', () => {
  const sid = `test-a7-${TS}`;
  writeNoneState(sid);
  // 不寫計數器
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'allow', '計數器不存在（count=0）應放行');
  } finally {
    cleanup(sid);
  }
});

test('A8: none pipeline + Write 程式碼檔案 + count = 3（剛好等於閾值）→ block', () => {
  const sid = `test-a8-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 3);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/index.ts' });
    assert.strictEqual(r.decision, 'block', 'count 剛好等於 NONE_WRITE_LIMIT(3) 應阻擋');
    assert.strictEqual(r.reason, 'none-pipeline-write-limit');
  } finally {
    cleanup(sid);
  }
});

test('A9: none pipeline + Write 程式碼檔案 + count = 2（剛好低於閾值）→ allow', () => {
  const sid = `test-a9-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 2);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/index.ts' });
    assert.strictEqual(r.decision, 'allow', 'count=2 剛好低於 NONE_WRITE_LIMIT(3) 應放行');
  } finally {
    cleanup(sid);
  }
});

test('A10: 計數器為無效 JSON → 降級為 count=0 → allow', () => {
  const sid = `test-a10-${TS}`;
  writeNoneState(sid);
  // 寫入無效 JSON
  const counterPath = path.join(CLAUDE_DIR, `none-writes-${sid}.json`);
  fs.writeFileSync(counterPath, 'invalid json {{{', 'utf8');
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'allow', '無效計數器應降級為 0，放行');
  } finally {
    cleanup(sid);
  }
});

test('A11: none pipeline + Write .json 檔案 → allow（isNonCodeFile）', () => {
  const sid = `test-a11-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 10);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/config/settings.json' });
    assert.strictEqual(r.decision, 'allow', 'JSON 設定檔不受 none 防護影響');
  } finally {
    cleanup(sid);
  }
});

test('A12: 無 pipeline state（sessionId 不存在）→ allow', () => {
  const sid = `test-a12-nonexistent-${TS}`;
  // 不建立任何 state 或計數器
  const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
  assert.strictEqual(r.decision, 'allow', '無 state 應放行（loadState 返回 null）');
});

test('A13: none pipeline + Write .ts 檔案 + count 大數值 → block', () => {
  const sid = `test-a13-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 999);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/component.ts' });
    assert.strictEqual(r.decision, 'block', 'count=999 遠超閾值應阻擋');
    assert.ok(r.message.includes('999 次'), `message 應包含 999 次：${r.message}`);
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n📝 B. runNonePipelineCheck() 軟提醒（post-edit.js）');
console.log('═'.repeat(60));
// ═══════════════════════════════════════════════════════

test('B1: none pipeline + 程式碼檔案 → 遞增計數器 + 回傳提醒訊息', () => {
  const sid = `test-b1-${TS}`;
  writeNoneState(sid);
  try {
    const msg = runNonePipelineCheck(sid, '/Users/test/src/app.js');
    assert.ok(typeof msg === 'string', '應回傳字串提醒訊息');
    assert.ok(msg.includes('⚠️'), 'message 應包含 ⚠️ 警示符號');
    assert.ok(msg.includes('1 次'), `第一次呼叫應顯示累計 1 次：${msg}`);
    assert.ok(msg.includes('/vibe:pipeline'), 'message 應提示使用 /vibe:pipeline');

    // 確認計數器已遞增
    const count = readCounter(sid);
    assert.strictEqual(count, 1, '計數器應被遞增為 1');
  } finally {
    cleanup(sid);
  }
});

test('B2: none pipeline + .md 檔案 → 不遞增，回傳 null', () => {
  const sid = `test-b2-${TS}`;
  writeNoneState(sid);
  try {
    const msg = runNonePipelineCheck(sid, '/Users/test/docs/README.md');
    assert.strictEqual(msg, null, 'Markdown 檔案應回傳 null');
    // 計數器不應被建立
    const count = readCounter(sid);
    assert.strictEqual(count, null, '計數器不應被建立');
  } finally {
    cleanup(sid);
  }
});

test('B3: quick-dev pipeline → 不遞增，回傳 null', () => {
  const sid = `test-b3-${TS}`;
  writeQuickDevState(sid);
  try {
    const msg = runNonePipelineCheck(sid, '/Users/test/src/app.js');
    assert.strictEqual(msg, null, 'quick-dev pipeline 應回傳 null');
    const count = readCounter(sid);
    assert.strictEqual(count, null, '計數器不應被建立');
  } finally {
    cleanup(sid);
  }
});

test('B4: 無 pipeline state → 不遞增，回傳 null', () => {
  const sid = `test-b4-nonexistent-${TS}`;
  // 不建立任何 state
  const msg = runNonePipelineCheck(sid, '/Users/test/src/app.js');
  assert.strictEqual(msg, null, '無 state 應回傳 null');
  const count = readCounter(sid);
  assert.strictEqual(count, null, '計數器不應被建立');
});

test('B5: none pipeline + 程式碼檔案 + 連續三次呼叫 → 計數累積', () => {
  const sid = `test-b5-${TS}`;
  writeNoneState(sid);
  try {
    const msg1 = runNonePipelineCheck(sid, '/Users/test/src/app.js');
    const msg2 = runNonePipelineCheck(sid, '/Users/test/src/utils.js');
    const msg3 = runNonePipelineCheck(sid, '/Users/test/src/service.ts');

    assert.ok(msg1.includes('1 次'), `第一次應顯示 1 次：${msg1}`);
    assert.ok(msg2.includes('2 次'), `第二次應顯示 2 次：${msg2}`);
    assert.ok(msg3.includes('3 次'), `第三次應顯示 3 次：${msg3}`);

    // 計數器最終值應為 3
    const count = readCounter(sid);
    assert.strictEqual(count, 3, '三次呼叫後計數器應為 3');
  } finally {
    cleanup(sid);
  }
});

test('B6: none pipeline + .json 設定檔 → 不遞增，回傳 null', () => {
  const sid = `test-b6-${TS}`;
  writeNoneState(sid);
  try {
    const msg = runNonePipelineCheck(sid, '/Users/test/config.json');
    assert.strictEqual(msg, null, 'JSON 設定檔應回傳 null（isNonCodeFile）');
    const count = readCounter(sid);
    assert.strictEqual(count, null, '計數器不應被建立');
  } finally {
    cleanup(sid);
  }
});

test('B7: filePath 為 null → 回傳 null（不崩潰）', () => {
  const sid = `test-b7-${TS}`;
  const msg = runNonePipelineCheck(sid, null);
  assert.strictEqual(msg, null, 'filePath=null 應回傳 null');
});

test('B8: sessionId 為 null → 回傳 null（不崩潰）', () => {
  const msg = runNonePipelineCheck(null, '/Users/test/src/app.js');
  assert.strictEqual(msg, null, 'sessionId=null 應回傳 null');
});

test('B9: none pipeline + 程式碼檔案 + 已有計數器 3 → 累積為 4', () => {
  const sid = `test-b9-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 3);
  try {
    const msg = runNonePipelineCheck(sid, '/Users/test/src/app.js');
    assert.ok(typeof msg === 'string', '應回傳字串訊息');
    assert.ok(msg.includes('4 次'), `應顯示累計 4 次：${msg}`);

    const count = readCounter(sid);
    assert.strictEqual(count, 4, '計數器應從 3 遞增至 4');
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════
// async 測試收集器（section C 是 async）
// ═══════════════════════════════════════════════════════

const asyncTests = [];

function testAsync(name, asyncFn) {
  asyncTests.push({ name, asyncFn });
}

// ═══════════════════════════════════════════════════════
console.log('\n🔄 C. classify 後計數器重設');
console.log('═'.repeat(60));
// ═══════════════════════════════════════════════════════

// classify() 是 async 函式（包裝 classifyWithConfidence）
// 使用顯式 [pipeline:xxx] 語法：Layer 1 純同步，Promise 立即 resolve

const { classify } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

testAsync('C1: classify 顯式 [pipeline:quick-dev] → 計數器被刪除', async () => {
  const sid = `test-c1-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 2);

  // 確認計數器存在
  assert.strictEqual(readCounter(sid), 2, '計數器初始值應為 2');

  try {
    await classify(sid, '[pipeline:quick-dev] 修復 bug', {});

    // classify 後計數器應被刪除
    const countAfter = readCounter(sid);
    assert.strictEqual(countAfter, null, 'classify 後 none-writes 計數器應被刪除');
  } finally {
    cleanup(sid);
  }
});

testAsync('C2: classify none pipeline → 計數器被重設（新分類清零）', async () => {
  const sid = `test-c2-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 5);

  try {
    await classify(sid, '[pipeline:none] 只是問一個問題', {});

    const countAfter = readCounter(sid);
    assert.strictEqual(countAfter, null, 'classify none 後計數器應被重設（刪除）');
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════
console.log('\n🔍 D. 邊界案例與錯誤路徑');
console.log('═'.repeat(60));
// ═══════════════════════════════════════════════════════

test('D1: canProceed 接受空字串 file_path → 不觸發 none 防護', () => {
  const sid = `test-d1-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 10);
  try {
    // 空字串 file_path 不觸發防護（guardIsNonCodeFile 過濾前的 filePath 檢查）
    const r = canProceed(sid, 'Write', { file_path: '' });
    // 空 file_path → filePath falsy → 不走 none 防護 → 進 guardEvaluate
    // none pipeline pipelineActive=false → guardEvaluate allow
    assert.strictEqual(r.decision, 'allow', '空字串 file_path 應放行（不觸發 none 防護）');
  } finally {
    cleanup(sid);
  }
});

test('D2: canProceed 接受 toolInput 為 undefined → 不崩潰', () => {
  const sid = `test-d2-${TS}`;
  writeNoneState(sid);
  try {
    const r = canProceed(sid, 'Write', undefined);
    // toolInput?.file_path 為 undefined → filePath='' → 不觸發防護
    assert.ok(['allow', 'block'].includes(r.decision), '應回傳合法 decision');
  } finally {
    cleanup(sid);
  }
});

test('D3: runNonePipelineCheck 接受空字串 filePath → 回傳 null（不崩潰）', () => {
  const sid = `test-d3-${TS}`;
  writeNoneState(sid);
  try {
    const msg = runNonePipelineCheck(sid, '');
    assert.strictEqual(msg, null, '空字串 filePath 應回傳 null');
  } finally {
    cleanup(sid);
  }
});

test('D4: none pipeline + Write .py 檔案 + count = 0 → allow（零計數）', () => {
  const sid = `test-d4-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 0);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/main.py' });
    assert.strictEqual(r.decision, 'allow', 'count=0 應放行');
  } finally {
    cleanup(sid);
  }
});

test('D5: canProceed none pipeline + Bash 工具 → 不走 none 防護（只檢查 Write/Edit）', () => {
  const sid = `test-d5-${TS}`;
  writeNoneState(sid);
  writeCounter(sid, 10);
  try {
    const r = canProceed(sid, 'Bash', { command: 'npm test' });
    // Bash 不是 Write/Edit → 不走 none 防護 → 進 guardEvaluate
    // none pipeline pipelineActive=false → guardEvaluate allow（Bash 安全指令）
    assert.strictEqual(r.decision, 'allow', 'Bash 工具不受 none-write-limit 影響');
  } finally {
    cleanup(sid);
  }
});

test('D6: none pipeline + 計數器 JSON 格式正確但缺少 count 欄位 → 降級為 0 → allow', () => {
  const sid = `test-d6-${TS}`;
  writeNoneState(sid);
  const counterPath = path.join(CLAUDE_DIR, `none-writes-${sid}.json`);
  fs.writeFileSync(counterPath, JSON.stringify({ other: 'value' }), 'utf8');
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    assert.strictEqual(r.decision, 'allow', '缺少 count 欄位應降級為 0，放行');
  } finally {
    cleanup(sid);
  }
});

test('D7: none pipeline active 狀態（activeStages=[DEV]）→ 不走 none 防護', () => {
  // none pipeline 下理論上 activeStages 為空，但防禦性測試確保 isActive() 為 true 時不觸發
  const sid = `test-d7-${TS}`;
  // 手動建立一個 none pipelineId 但有 active stages 的異常 state
  const state = {
    version: 4,
    sessionId: sid,
    classification: { taskType: 'chat', pipelineId: 'none', source: 'test' },
    dag: { DEV: { deps: [] } },
    dagStages: ['DEV'],
    stages: {
      DEV: { status: 'active', agent: 'developer', verdict: null },
    },
    pipelineActive: true, // active
    activeStages: ['DEV'],
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const stateFilePath = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  const counterPath = writeCounter(sid, 10);
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    // isActive()=true（activeStages 有值）→ none 防護條件不滿足（!ds.isActive(state)）→ 不走 none 邏輯
    // 走正常 guardEvaluate，none 但 pipelineActive=true 且 activeStages=[DEV] → allow（Rule 4）
    assert.notStrictEqual(r.reason, 'none-pipeline-write-limit', 'active 狀態的 none pipeline 不應觸發 none-write-limit');
  } finally {
    try { fs.unlinkSync(stateFilePath); } catch (_) {}
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════
// 執行 async 測試（Section C）並輸出結果
// ═══════════════════════════════════════════════════════

async function runAsyncTests() {
  for (const { name, asyncFn } of asyncTests) {
    try {
      await asyncFn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${name}`);
      console.log(`     ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  const total = passed + failed;
  console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${total} 總計`);
  if (failed > 0) {
    console.log('❌ 有測試失敗\n');
    process.exit(1);
  } else {
    console.log('✅ 全部通過\n');
  }
}

runAsyncTests().catch(err => {
  console.error('runAsyncTests 崩潰：', err);
  process.exit(1);
});
