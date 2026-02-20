/**
 * route-parser-edge.test.js — route-parser.js 邊界案例補充測試
 *
 * 補充覆蓋範圍（現有 route-parser.test.js 未覆蓋的部分）：
 * 1. extractIssueCount — 三種匹配模式（count-after、count-before、section-header）及邊界值
 * 2. extractTextFromEntry — content 字串型別、entry.text 直接字串、JSON 巢狀搜尋
 * 3. inferRouteFromContent — 強 FAIL 信號（CRITICAL:2, HIGH:3 計數）
 * 4. validateRoute — hint 包含 --> 的 sanitize 邏輯
 * 5. enforcePolicy — Rule 4 barrier active siblings 強制 BARRIER route
 * 6. parseRoute — content-inference 路徑（無 PIPELINE_ROUTE 也無 PIPELINE_VERDICT）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseRoute,
  validateRoute,
  enforcePolicy,
  inferRouteFromContent,
  extractIssueCount,
  extractTextFromEntry,
  hasFAILSignal,
} = require('../scripts/lib/flow/route-parser.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

// ── 暫存 transcript 工具 ──

const TMP_DIR = path.join(os.tmpdir(), `route-parser-edge-${process.pid}`);
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

// ════════════════════════════════════════════════════════════
// 1. extractIssueCount — 三種匹配模式
// ════════════════════════════════════════════════════════════

console.log('\n--- 1. extractIssueCount ---');

test('extractIssueCount: 模式 1 - "CRITICAL: 2" 格式', () => {
  const count = extractIssueCount('審查發現 CRITICAL: 2 個嚴重問題', 'CRITICAL');
  assert.strictEqual(count, 2, '應解析 CRITICAL: 2 → 2');
});

test('extractIssueCount: 模式 1 - "HIGH：3" 全形冒號', () => {
  const count = extractIssueCount('HIGH：3 個高嚴重度問題', 'HIGH');
  assert.strictEqual(count, 3, '應支援全形冒號');
});

test('extractIssueCount: 模式 1 - "CRITICAL: 0" 回傳 0', () => {
  const count = extractIssueCount('CRITICAL: 0 個問題，程式碼品質良好', 'CRITICAL');
  assert.strictEqual(count, 0, 'CRITICAL: 0 應回傳 0');
});

test('extractIssueCount: 模式 2 - "3 個 CRITICAL"', () => {
  const count = extractIssueCount('共發現 3 個 CRITICAL 問題', 'CRITICAL');
  assert.strictEqual(count, 3, '應解析 "N 個 SEVERITY"');
});

test('extractIssueCount: 模式 2 - "5 HIGH" 無 "個"', () => {
  const count = extractIssueCount('共有 5 HIGH 問題待修', 'HIGH');
  assert.strictEqual(count, 5, '應解析 "N SEVERITY" 無個字');
});

test('extractIssueCount: 模式 2 - "0 CRITICAL" 回傳 0', () => {
  const count = extractIssueCount('發現 0 CRITICAL 問題', 'CRITICAL');
  assert.strictEqual(count, 0, '"0 CRITICAL" 應回傳 0');
});

test('extractIssueCount: 模式 3 - section header "### 🔴 CRITICAL" → 1', () => {
  const text = '## 審查結果\n### 🔴 CRITICAL\n- 有一個嚴重安全漏洞\n';
  const count = extractIssueCount(text, 'CRITICAL');
  assert.strictEqual(count, 1, 'section header 存在應回傳 1');
});

test('extractIssueCount: 模式 3 - section header "### 🟠 HIGH" → 1', () => {
  const text = '## 審查結果\n### 🟠 HIGH\n- 效能問題\n';
  const count = extractIssueCount(text, 'HIGH');
  assert.strictEqual(count, 1, 'HIGH section header 應回傳 1');
});

test('extractIssueCount: 無匹配 → 0', () => {
  const text = '程式碼品質良好，無問題。';
  const count = extractIssueCount(text, 'CRITICAL');
  assert.strictEqual(count, 0, '無匹配應回傳 0');
});

test('extractIssueCount: 空字串 → 0', () => {
  assert.strictEqual(extractIssueCount('', 'CRITICAL'), 0);
});

test('extractIssueCount: HIGH 與 CRITICAL 互不干擾', () => {
  const text = 'CRITICAL: 0, HIGH: 5';
  assert.strictEqual(extractIssueCount(text, 'CRITICAL'), 0, 'CRITICAL 應為 0');
  assert.strictEqual(extractIssueCount(text, 'HIGH'), 5, 'HIGH 應為 5');
});

// ════════════════════════════════════════════════════════════
// 2. extractTextFromEntry — 各種 entry 格式
// ════════════════════════════════════════════════════════════

console.log('\n--- 2. extractTextFromEntry ---');

test('extractTextFromEntry: null → null', () => {
  assert.strictEqual(extractTextFromEntry(null), null);
});

test('extractTextFromEntry: 非物件 → null', () => {
  assert.strictEqual(extractTextFromEntry('string'), null);
  assert.strictEqual(extractTextFromEntry(42), null);
});

test('extractTextFromEntry: 標準 SubagentStop JSONL 結構', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '審查完成。' },
        { type: 'text', text: '品質良好。' },
      ],
    },
  };
  const text = extractTextFromEntry(entry);
  assert.ok(text, '應提取到文字');
  assert.ok(text.includes('審查完成'), '應包含第一段');
  assert.ok(text.includes('品質良好'), '應包含第二段');
});

test('extractTextFromEntry: content 過濾非 text block', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool1' },
        { type: 'text', text: '操作完成。' },
      ],
    },
  };
  const text = extractTextFromEntry(entry);
  assert.ok(text && text.includes('操作完成'), '應只提取 text block');
});

test('extractTextFromEntry: content 是字串（非陣列）', () => {
  const entry = {
    type: 'assistant',
    message: { content: '直接字串內容' },
  };
  const text = extractTextFromEntry(entry);
  assert.strictEqual(text, '直接字串內容', '應支援 content 為字串的格式');
});

test('extractTextFromEntry: entry.text 直接字串', () => {
  const entry = { text: '直接的 text 欄位', role: 'assistant' };
  const text = extractTextFromEntry(entry);
  assert.strictEqual(text, '直接的 text 欄位', '應支援 entry.text');
});

test('extractTextFromEntry: entry.message.content 全為非 text block → null', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool1' },
        { type: 'tool_result', id: 'tool1' },
      ],
    },
  };
  // 無 text block，fallback 到 JSON 搜尋（無 PIPELINE_ROUTE），最終回 null
  const text = extractTextFromEntry(entry);
  // 因無任何文字內容，且 JSON 也沒有 PIPELINE_ROUTE，應回傳 null
  assert.strictEqual(text, null, '無文字內容應回傳 null');
});

test('extractTextFromEntry: JSON 巢狀搜尋（content 含 PIPELINE_ROUTE 標記）', () => {
  // 模擬 PIPELINE_ROUTE 嵌在複雜 JSON 結構中
  const entry = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: '<!-- PIPELINE_ROUTE: { "verdict": "PASS", "route": "NEXT" } -->',
        },
      ],
    },
  };
  const text = extractTextFromEntry(entry);
  assert.ok(text, '應提取到 PIPELINE_ROUTE 標記');
  assert.ok(text.includes('PIPELINE_ROUTE'), '提取文字應含 PIPELINE_ROUTE');
});

// ════════════════════════════════════════════════════════════
// 3. inferRouteFromContent — 強 FAIL 信號測試
// ════════════════════════════════════════════════════════════

console.log('\n--- 3. inferRouteFromContent 強 FAIL 信號 ---');

test('inferRouteFromContent: CRITICAL:2 計數 → FAIL:CRITICAL', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '審查結果：CRITICAL: 2 個嚴重問題需立即修復。' }] },
  })];
  const result = inferRouteFromContent(lines);
  assert.ok(result, '應偵測到 FAIL 信號');
  assert.strictEqual(result.verdict, 'FAIL', 'verdict 應為 FAIL');
  assert.strictEqual(result.severity, 'CRITICAL', 'severity 應為 CRITICAL');
  assert.strictEqual(result.route, 'DEV', 'route 應為 DEV');
  assert.ok(result._inferred, '_inferred 應為 true');
  assert.ok(result.hint.includes('2'), 'hint 應包含計數 2');
});

test('inferRouteFromContent: HIGH:3 計數 → FAIL:HIGH', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '共有 3 HIGH 問題，需要修復後再審查。' }] },
  })];
  const result = inferRouteFromContent(lines);
  assert.ok(result, '應偵測到 FAIL 信號');
  assert.strictEqual(result.verdict, 'FAIL');
  assert.strictEqual(result.severity, 'HIGH');
  assert.ok(result.hint.includes('3'), 'hint 應包含計數 3');
});

test('inferRouteFromContent: CRITICAL 優先於 HIGH（CRITICAL 排第一）', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'CRITICAL: 1 個嚴重問題，HIGH: 3 個高嚴重度問題。' }] },
  })];
  const result = inferRouteFromContent(lines);
  assert.strictEqual(result.severity, 'CRITICAL', 'CRITICAL 應優先於 HIGH');
});

test('inferRouteFromContent: section header 也觸發 FAIL', () => {
  const lines = [JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '## 審查結果\n\n### 🔴 CRITICAL\n- SQL injection 漏洞' }],
    },
  })];
  const result = inferRouteFromContent(lines);
  assert.ok(result, 'section header 應觸發 FAIL');
  assert.strictEqual(result.severity, 'CRITICAL');
});

test('inferRouteFromContent: 空陣列 → null', () => {
  assert.strictEqual(inferRouteFromContent([]), null);
});

test('inferRouteFromContent: null → null', () => {
  assert.strictEqual(inferRouteFromContent(null), null);
});

test('inferRouteFromContent: 無 assistant message → null', () => {
  // 只有 tool_use 沒有 assistant text
  const lines = [JSON.stringify({
    type: 'tool_use',
    name: 'Read',
    input: { file_path: '/tmp/test.txt' },
  })];
  const result = inferRouteFromContent(lines);
  assert.strictEqual(result, null, '無 assistant 輸出應回傳 null');
});

// ════════════════════════════════════════════════════════════
// 4. validateRoute — hint 包含 --> 的 sanitize 邏輯
// ════════════════════════════════════════════════════════════

console.log('\n--- 4. validateRoute hint sanitize ---');

test('validateRoute: hint 含 --> 被替換為 →', () => {
  const { route, warnings } = validateRoute({
    verdict: 'FAIL',
    route: 'DEV',
    severity: 'HIGH',
    hint: 'auth 驗證失敗 --> 需要修復 --> 再測試',
  });
  assert.ok(!route.hint.includes('-->'), 'hint 不應含 -->');
  assert.ok(route.hint.includes('→'), 'hint 應含替換後的 →');
  assert.ok(warnings.some(w => w.includes('-->')), '應有 --> 替換警告');
});

test('validateRoute: hint 無 --> → 不觸發 sanitize', () => {
  const { route, warnings } = validateRoute({
    verdict: 'FAIL',
    route: 'DEV',
    severity: 'HIGH',
    hint: '沒有箭頭的 hint',
  });
  assert.strictEqual(route.hint, '沒有箭頭的 hint', 'hint 應保持不變');
  assert.ok(!warnings.some(w => w.includes('-->')), '不應有 --> 警告');
});

test('validateRoute: hint 同時超長又含 --> → 先截斷後替換（按順序執行）', () => {
  const longHint = '--> '.repeat(60); // 240 chars，含多個 -->
  const { route } = validateRoute({
    verdict: 'FAIL',
    route: 'DEV',
    severity: 'HIGH',
    hint: longHint,
  });
  // 先截斷到 200，再替換 -->
  assert.ok(route.hint.length <= 200, '截斷後長度應 <= 200');
  assert.ok(!route.hint.includes('-->'), '截斷後不應含 -->');
});

test('validateRoute: hint 為空字串 → 保持不變', () => {
  const { route } = validateRoute({
    verdict: 'FAIL',
    route: 'DEV',
    severity: 'HIGH',
    hint: '',
  });
  assert.strictEqual(route.hint, '', '空 hint 應保持為空字串');
});

// ════════════════════════════════════════════════════════════
// 5. enforcePolicy — Rule 4 barrier active siblings
// ════════════════════════════════════════════════════════════

console.log('\n--- 5. enforcePolicy Rule 4 barrier siblings ---');

test('enforcePolicy: REVIEW 有 barrier 配置 + TEST active → 強制 BARRIER route', () => {
  const route = { verdict: 'PASS', route: 'NEXT' };
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      TEST: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      QA: { deps: ['REVIEW', 'TEST'] },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'active' },
      TEST: { status: 'active' },  // TEST 也在 active → 確實是並行場景
      QA: { status: 'pending' },
    },
    retries: {},
    retryHistory: {},
  };

  const { route: r, enforced, reason } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'BARRIER', '應強制為 BARRIER');
  assert.strictEqual(enforced, true, 'enforced 應為 true');
  assert.ok(reason && reason.includes('barrier'), 'reason 應提及 barrier');
});

test('enforcePolicy: REVIEW 有 barrier 配置 + TEST pending（非 active）→ 不強制', () => {
  // TEST 是 pending（尚未開始），不是 active，不算並行執行
  const route = { verdict: 'PASS', route: 'NEXT' };
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      TEST: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'active' },
      TEST: { status: 'pending' },  // TEST 仍是 pending（未開始）
    },
    retries: {},
    retryHistory: {},
  };

  const { route: r, enforced } = enforcePolicy(route, state, 'REVIEW');
  assert.strictEqual(r.route, 'NEXT', 'sibling pending 時不應強制 BARRIER');
  assert.strictEqual(enforced, false, 'enforced 應為 false');
});

test('enforcePolicy: REVIEW 有 barrier 配置 + TEST completed → 不強制', () => {
  // TEST 已 completed，只剩 REVIEW，不算並行
  const route = { verdict: 'PASS', route: 'NEXT' };
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
      TEST: {
        deps: ['DEV'],
        barrier: { group: 'post-dev', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'active' },
      TEST: { status: 'completed' },  // TEST 已完成
    },
    retries: {},
    retryHistory: {},
  };

  const { route: r, enforced } = enforcePolicy(route, state, 'REVIEW');
  // TEST completed，不算 active sibling → 不強制 BARRIER
  assert.strictEqual(enforced, false, 'sibling completed 時不應強制 BARRIER');
  assert.strictEqual(r.route, 'NEXT', 'route 應保持 NEXT');
});

test('enforcePolicy: barrier route 且 barrierGroup 未設 → 從 barrier 配置取得', () => {
  const route = { verdict: 'PASS', route: 'NEXT' };
  const state = {
    dag: {
      DEV: { deps: [] },
      REVIEW: {
        deps: ['DEV'],
        barrier: { group: 'my-group', total: 2, next: 'QA', siblings: ['REVIEW', 'TEST'] },
      },
    },
    stages: {
      DEV: { status: 'completed' },
      REVIEW: { status: 'active' },
      TEST: { status: 'active' },
    },
    retries: {},
    retryHistory: {},
  };

  const { route: r } = enforcePolicy(route, state, 'REVIEW');
  if (r.route === 'BARRIER') {
    assert.strictEqual(r.barrierGroup, 'my-group', 'barrierGroup 應從 barrier 配置取得');
  }
});

// ════════════════════════════════════════════════════════════
// 6. parseRoute — content-inference 路徑
// ════════════════════════════════════════════════════════════

console.log('\n--- 6. parseRoute content-inference 路徑 ---');

test('parseRoute: 無 PIPELINE_ROUTE 也無 VERDICT + 有 CRITICAL 計數 → content-inference FAIL', () => {
  const transcriptPath = writeTranscript('ci1.jsonl', [
    makeAssistantEntry('審查發現 CRITICAL: 2 個嚴重問題，需要立即修復。不能進入下一階段。'),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'content-inference', '應走 content-inference 路徑');
  assert.ok(parsed, '應有解析結果');
  assert.strictEqual(parsed.verdict, 'FAIL', 'verdict 應為 FAIL');
  assert.strictEqual(parsed.severity, 'CRITICAL', 'severity 應為 CRITICAL');
});

test('parseRoute: 無標記 + 長輸出（弱 PASS）→ content-inference PASS', () => {
  const longText = '整個程式碼審查已完成，各模組品質良好，無明顯問題，建議可以進入下一階段。' + 'x'.repeat(200);
  const transcriptPath = writeTranscript('ci2.jsonl', [
    makeAssistantEntry(longText),
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'content-inference', '應走 content-inference 路徑');
  assert.strictEqual(parsed.verdict, 'PASS', 'verdict 應為 PASS');
  assert.ok(parsed._inferred, '_inferred 應為 true');
});

test('parseRoute: 無標記 + 短輸出 + 無 FAIL 信號 → source=none', () => {
  const transcriptPath = writeTranscript('ci3.jsonl', [
    makeAssistantEntry('短輸出'),  // 少於 200 字元
  ]);
  const { parsed, source } = parseRoute(transcriptPath);
  assert.strictEqual(source, 'none', '短輸出無法推斷應回 none');
  assert.strictEqual(parsed, null, 'parsed 應為 null');
});

// ════════════════════════════════════════════════════════════
// 7. hasFAILSignal — 各種 false-positive 排除
// ════════════════════════════════════════════════════════════

console.log('\n--- 7. hasFAILSignal false-positive 排除 ---');

test('hasFAILSignal: "測試失敗" → true（FAIL 信號）', () => {
  assert.strictEqual(hasFAILSignal('測試失敗，3 個測試未通過'), true);
});

test('hasFAILSignal: "嚴重問題" → true', () => {
  assert.strictEqual(hasFAILSignal('發現嚴重問題'), true);
});

test('hasFAILSignal: "安全漏洞" → true', () => {
  assert.strictEqual(hasFAILSignal('存在安全漏洞'), true);
});

test('hasFAILSignal: "failed" 英文 → true', () => {
  assert.strictEqual(hasFAILSignal('test failed: assertion error'), true);
});

test('hasFAILSignal: "onFail" 不觸發 FAIL 信號', () => {
  // onFail 是 pipeline 術語，不是問題信號
  assert.strictEqual(hasFAILSignal('請設定 onFail 欄位'), false);
});

test('hasFAILSignal: "failover" 不觸發 FAIL 信號', () => {
  assert.strictEqual(hasFAILSignal('系統有 failover 機制'), false);
});

test('hasFAILSignal: "failsafe" 不觸發 FAIL 信號', () => {
  assert.strictEqual(hasFAILSignal('已啟用 failsafe 機制'), false);
});

test('hasFAILSignal: "CRITICAL: 0" 不觸發 FAIL 信號', () => {
  assert.strictEqual(hasFAILSignal('CRITICAL: 0 個問題'), false);
});

test('hasFAILSignal: "0 個 CRITICAL" 不觸發 FAIL 信號', () => {
  assert.strictEqual(hasFAILSignal('發現 0 個 CRITICAL 問題'), false);
});

test('hasFAILSignal: 純 CRITICAL（非 0）→ true', () => {
  // 有 CRITICAL 關鍵字但不是 "0 CRITICAL" 格式
  assert.strictEqual(hasFAILSignal('嚴重 CRITICAL 問題'), true);
});

test('hasFAILSignal: 空字串 → false', () => {
  assert.strictEqual(hasFAILSignal(''), false);
});

// ════════════════════════════════════════════════════════════
// 清理
// ════════════════════════════════════════════════════════════

cleanup();

// ════════════════════════════════════════════════════════════
// 結果
// ════════════════════════════════════════════════════════════

console.log(`\n=== route-parser-edge.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
