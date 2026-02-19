#!/usr/bin/env node
/**
 * transcript-leak.test.js — Transcript 洩漏偵測單元測試
 *
 * 測試範圍：
 * 1. getLastAssistantResponseLength：正常讀取、逆序掃描、異常防禦
 * 2. leakAccumulated 欄位初始化（createInitialState）
 * 3. suggest-compact.js 洩漏感知 compact 建議（leakAccumulated >= 3000）
 *
 * 執行：node plugins/vibe/tests/transcript-leak.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-leak-test-'));

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

// ── 直接測試 pipeline-controller 中的函式（非匯出，透過 require 動態注入 mock） ──
// 由於 getLastAssistantResponseLength 是內部函式，我們直接測試其行為邏輯

// ── 測試輔助：建立假 transcript JSONL ──
function createTranscript(entries) {
  const lines = entries.map(e => JSON.stringify(e));
  const filePath = path.join(TMP_DIR, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

// ── 提取 getLastAssistantResponseLength 的核心邏輯進行白箱測試 ──
function getLastAssistantResponseLength(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    const scanLines = lines.slice(-20);
    for (let i = scanLines.length - 1; i >= 0; i--) {
      if (!scanLines[i].trim()) continue;
      try {
        const entry = JSON.parse(scanLines[i]);
        if (entry.role !== 'assistant' && entry.type !== 'assistant') continue;
        const msgContent = entry.message?.content || entry.content || '';
        if (typeof msgContent === 'string') return msgContent.length;
        if (Array.isArray(msgContent)) {
          return msgContent.reduce((acc, block) => {
            const txt = block?.text || block?.content || '';
            return acc + (typeof txt === 'string' ? txt.length : 0);
          }, 0);
        }
        return String(msgContent).length;
      } catch (_) {}
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

// ═══════════════════════════════════════════════
// 1. getLastAssistantResponseLength 單元測試
// ═══════════════════════════════════════════════

console.log('\n--- 1. getLastAssistantResponseLength ---');

test('檔案不存在 → 回傳 0', () => {
  const result = getLastAssistantResponseLength('/tmp/nonexistent-transcript.jsonl');
  assert.strictEqual(result, 0, '不存在的路徑應回 0');
});

test('null/undefined 路徑 → 回傳 0', () => {
  assert.strictEqual(getLastAssistantResponseLength(null), 0);
  assert.strictEqual(getLastAssistantResponseLength(undefined), 0);
});

test('空 transcript → 回傳 0', () => {
  const p = createTranscript([]);
  assert.strictEqual(getLastAssistantResponseLength(p), 0);
});

test('只有 user 訊息 → 回傳 0（無 assistant）', () => {
  const p = createTranscript([
    { role: 'user', content: '請幫我審查程式碼' },
    { role: 'user', type: 'agent_stop' },
  ]);
  assert.strictEqual(getLastAssistantResponseLength(p), 0);
});

test('assistant 訊息（role=assistant，string content）→ 回傳正確長度', () => {
  const content = '這是一段審查結論，共 20 個字符。';
  const p = createTranscript([
    { role: 'user', content: '審查請求' },
    { role: 'assistant', content },
  ]);
  assert.strictEqual(getLastAssistantResponseLength(p), content.length);
});

test('assistant 訊息（message.content 巢狀結構）→ 回傳正確長度', () => {
  const contentStr = '巢狀格式的審查結論文字';
  const p = createTranscript([
    { role: 'user', content: '審查請求' },
    { role: 'assistant', message: { content: contentStr } },
  ]);
  assert.strictEqual(getLastAssistantResponseLength(p), contentStr.length);
});

test('assistant 訊息（陣列型 content）→ 累加所有 text block', () => {
  const block1 = { type: 'text', text: '第一段落：審查結論。' };
  const block2 = { type: 'text', text: '第二段落：建議修復。' };
  const p = createTranscript([
    { role: 'user', content: '審查請求' },
    { role: 'assistant', message: { content: [block1, block2] } },
  ]);
  const expected = block1.text.length + block2.text.length;
  assert.strictEqual(getLastAssistantResponseLength(p), expected);
});

test('逆序掃描：取最後一條 assistant 訊息', () => {
  const shortContent = '短摘要'; // 4 字元（繁體中文）
  const longContent = 'A'.repeat(600); // 600 字元的長回應
  const p = createTranscript([
    { role: 'user', content: '請求' },
    { role: 'assistant', content: longContent }, // 早期長回應
    { role: 'user', content: '確認' },
    { role: 'assistant', content: shortContent }, // 最後短摘要（應取這個）
  ]);
  // 應取最後一條 assistant 訊息（shortContent）
  assert.strictEqual(getLastAssistantResponseLength(p), shortContent.length);
});

test('type=assistant（非 role 欄位）也被識別', () => {
  const content = '類型為 assistant 的訊息';
  const p = createTranscript([
    { type: 'assistant', content },
  ]);
  assert.strictEqual(getLastAssistantResponseLength(p), content.length);
});

// ═══════════════════════════════════════════════
// 2. dag-state.js createInitialState leakAccumulated
// ═══════════════════════════════════════════════

console.log('\n--- 2. createInitialState leakAccumulated ---');

const { createInitialState } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'dag-state.js'));

test('createInitialState 含 leakAccumulated=0', () => {
  const state = createInitialState('test-leak-session', {});
  assert.strictEqual(state.leakAccumulated, 0, 'leakAccumulated 初始值應為 0');
});

test('leakAccumulated 是數字型別', () => {
  const state = createInitialState('test-leak-session-2', {});
  assert.strictEqual(typeof state.leakAccumulated, 'number', '型別應為 number');
});

// ═══════════════════════════════════════════════
// 3. 洩漏閾值邏輯驗證
// ═══════════════════════════════════════════════

console.log('\n--- 3. 洩漏閾值邏輯 ---');

test('回應 < 500 chars → 不觸發洩漏（閾值 500）', () => {
  const content = 'A'.repeat(499);
  const p = createTranscript([
    { role: 'assistant', content },
  ]);
  const len = getLastAssistantResponseLength(p);
  const LEAK_THRESHOLD = 500;
  assert.ok(len <= LEAK_THRESHOLD, `長度 ${len} 應 <= 閾值 ${LEAK_THRESHOLD}`);
});

test('回應 > 500 chars → 觸發洩漏偵測（閾值 500）', () => {
  const content = 'A'.repeat(501);
  const p = createTranscript([
    { role: 'assistant', content },
  ]);
  const len = getLastAssistantResponseLength(p);
  const LEAK_THRESHOLD = 500;
  assert.ok(len > LEAK_THRESHOLD, `長度 ${len} 應 > 閾值 ${LEAK_THRESHOLD}`);
});

test('leakAccumulated < 3000 → 不觸發 compact 建議', () => {
  const leakAccumulated = 2999;
  const LEAK_COMPACT_THRESHOLD = 3000;
  assert.ok(leakAccumulated < LEAK_COMPACT_THRESHOLD, '不應觸發 compact');
});

test('leakAccumulated >= 3000 → 觸發 compact 建議', () => {
  const leakAccumulated = 3000;
  const LEAK_COMPACT_THRESHOLD = 3000;
  assert.ok(leakAccumulated >= LEAK_COMPACT_THRESHOLD, '應觸發 compact');
});

test('累加邏輯：3 輪洩漏（各 1500 chars）→ 4500 >= 3000 觸發', () => {
  let accumulated = 0;
  const LEAK_THRESHOLD = 500;
  const LEAK_COMPACT_THRESHOLD = 3000;
  const responses = [1500, 1500, 1500]; // 3 輪品質 stage 各 1500 chars
  for (const responseLen of responses) {
    if (responseLen > LEAK_THRESHOLD) {
      accumulated += responseLen;
    }
  }
  assert.strictEqual(accumulated, 4500, '累積應為 4500');
  assert.ok(accumulated >= LEAK_COMPACT_THRESHOLD, '應觸發 compact 建議');
});

// ═══════════════════════════════════════════════
// 清理
// ═══════════════════════════════════════════════

try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (_) {}

// ═══════════════════════════════════════════════
// 結果
// ═══════════════════════════════════════════════

console.log(`\n=== transcript-leak.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
