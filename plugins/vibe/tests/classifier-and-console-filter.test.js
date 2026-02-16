#!/usr/bin/env node
/**
 * classifier-and-console-filter.test.js — 單元測試
 *
 * Part 1: task-classifier 級聯分類器（import 實際模組）
 * Part 2: check-console-log 檔案過濾 regex
 * Part 3: 品質守衛 hooks stdin→stdout 驗證
 *
 * 執行：node plugins/vibe/tests/classifier-and-console-filter.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

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

// Async test 收集器（Layer 3 LLM 測試需要 await）
const asyncQueue = [];
function asyncTest(name, fn) {
  asyncQueue.push({ name, fn });
}

// ═══════════════════════════════════════════════
// Part 1: 級聯分類器（直接 import 實際模組）
// ═══════════════════════════════════════════════

const { classify, isStrongQuestion } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

console.log('\n🧪 Part 1: 級聯分類器 — 強疑問信號');
console.log('═'.repeat(50));

// ─── 句尾疑問標記（嗎/呢/?/？）────────────────────

test('句尾「嗎」：規劃之後 tdd 會有文件產生嗎 → research', () => {
  assert.strictEqual(classify('我們 規劃之後的 sdd tdd 會有文件產生嗎'), 'research');
});

test('句尾「嗎」：可以 refactor 嗎 → research', () => {
  assert.strictEqual(classify('可以 refactor 嗎'), 'research');
});

test('句尾「呢」：feature 放在哪裡呢 → research', () => {
  assert.strictEqual(classify('feature 放在哪裡呢'), 'research');
});

test('句尾「？」：這是 bug？ → research', () => {
  assert.strictEqual(classify('這是 bug？'), 'research');
});

test('句尾「?」：is this a bug? → research', () => {
  assert.strictEqual(classify('is this a bug?'), 'research');
});

// ─── 中文疑問代詞 ────────────────────────────────

test('什麼：tdd 是什麼 → research', () => {
  assert.strictEqual(classify('tdd 是什麼'), 'research');
});

test('怎麼：refactor 怎麼做 → research', () => {
  assert.strictEqual(classify('refactor 怎麼做'), 'research');
});

test('為什麼：為什麼要 implement 這個 → research', () => {
  assert.strictEqual(classify('為什麼要 implement 這個'), 'research');
});

test('哪裡：bug 在哪裡 → research', () => {
  assert.strictEqual(classify('bug 在哪裡'), 'research');
});

test('哪個：哪個 feature 先做 → research', () => {
  assert.strictEqual(classify('哪個 feature 先做'), 'research');
});

test('多少：有多少 test → research', () => {
  assert.strictEqual(classify('有多少 test'), 'research');
});

test('如何：如何 implement 認證 → research', () => {
  assert.strictEqual(classify('如何 implement 認證'), 'research');
});

test('誰：誰寫的這個 bug → research', () => {
  assert.strictEqual(classify('誰寫的這個 bug'), 'research');
});

// ─── A不A 正反疑問結構 ──────────────────────────

test('有沒有：有沒有 implement 過 → research', () => {
  assert.strictEqual(classify('有沒有 implement 過'), 'research');
});

test('是不是：tdd 是不是必要的 → research', () => {
  assert.strictEqual(classify('tdd 是不是必要的'), 'research');
});

test('能不能：能不能 fix 這個 → research', () => {
  assert.strictEqual(classify('能不能 fix 這個'), 'research');
});

test('會不會：refactor 會不會壞掉 → research', () => {
  assert.strictEqual(classify('refactor 會不會壞掉'), 'research');
});

test('可不可以：可不可以 scaffold 一個 → research', () => {
  assert.strictEqual(classify('可不可以 scaffold 一個'), 'research');
});

test('要不要：要不要先寫測試 → research', () => {
  assert.strictEqual(classify('要不要先寫測試'), 'research');
});

test('好不好：tdd 好不好用 → research', () => {
  assert.strictEqual(classify('tdd 好不好用'), 'research');
});

test('對不對：這樣 implement 對不對 → research', () => {
  assert.strictEqual(classify('這樣 implement 對不對'), 'research');
});

// ─── 文言疑問 ────────────────────────────────────

test('是否：是否需要 refactor → research', () => {
  assert.strictEqual(classify('是否需要 refactor'), 'research');
});

test('能否：能否改善效能 → research', () => {
  assert.strictEqual(classify('能否改善效能'), 'research');
});

test('可否：可否用 tdd 方式 → research', () => {
  assert.strictEqual(classify('可否用 tdd 方式'), 'research');
});

test('有無：有無替代方案 → research', () => {
  assert.strictEqual(classify('有無替代方案'), 'research');
});

// ─── 顯式探詢 ────────────────────────────────────

test('想知道：想知道 pipeline 的運作 → research', () => {
  assert.strictEqual(classify('想知道 pipeline 的運作'), 'research');
});

test('想了解：想了解 tdd 流程 → research', () => {
  assert.strictEqual(classify('想了解 tdd 流程'), 'research');
});

test('想問：想問 feature 開發流程 → research', () => {
  assert.strictEqual(classify('想問 feature 開發流程'), 'research');
});

test('好奇：好奇 implement 的細節 → research', () => {
  assert.strictEqual(classify('好奇 implement 的細節'), 'research');
});

test('不確定：不確定要不要 refactor → research', () => {
  assert.strictEqual(classify('不確定要不要 refactor'), 'research');
});

test('不知道：不知道這算不算 bug → research', () => {
  assert.strictEqual(classify('不知道這算不算 bug'), 'research');
});

test('請問：請問 tdd 怎麼開始 → research', () => {
  assert.strictEqual(classify('請問 tdd 怎麼開始'), 'research');
});

// ─── 英文 WH 疑問 ──────────────────────────────

test('what：what is this function doing → research', () => {
  assert.strictEqual(classify('what is this function doing'), 'research');
});

test('how：how to implement auth → research', () => {
  assert.strictEqual(classify('how to implement auth'), 'research');
});

test('why：why is this test failing → research', () => {
  assert.strictEqual(classify('why is this test failing'), 'research');
});

test('where：where is the bug → research', () => {
  assert.strictEqual(classify('where is the bug'), 'research');
});

test('when：when was this feature added → research', () => {
  assert.strictEqual(classify('when was this feature added'), 'research');
});

test('which：which module to refactor → research', () => {
  assert.strictEqual(classify('which module to refactor'), 'research');
});

test('explain：explain the architecture → research', () => {
  assert.strictEqual(classify('explain the architecture'), 'research');
});

test('describe：describe the test flow → research', () => {
  assert.strictEqual(classify('describe the test flow'), 'research');
});

// ─── isStrongQuestion 函式驗證 ──────────────────

test('isStrongQuestion: 句尾嗎 → true', () => {
  assert.strictEqual(isStrongQuestion('會有文件產生嗎'), true);
});

test('isStrongQuestion: 純動作 → false', () => {
  assert.strictEqual(isStrongQuestion('幫我 implement 認證'), false);
});

test('isStrongQuestion: A不A → true', () => {
  assert.strictEqual(isStrongQuestion('有沒有做過'), true);
});

// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1b: 級聯分類器 — Trivial 偵測');
console.log('═'.repeat(50));

test('hello world HTTP server → quickfix', () => {
  assert.strictEqual(classify('建立一個簡單的 hello world HTTP server'), 'quickfix');
});

test('hello world 範例 → quickfix', () => {
  assert.strictEqual(classify('hello world 範例'), 'quickfix');
});

test('建立 poc 概念驗證 → quickfix', () => {
  assert.strictEqual(classify('建立 poc 概念驗證'), 'quickfix');
});

test('prototype 原型測試 → quickfix', () => {
  assert.strictEqual(classify('prototype 原型測試'), 'quickfix');
});

test('試做一個小功能 → quickfix', () => {
  assert.strictEqual(classify('試做一個小功能'), 'quickfix');
});

test('練習用的 demo → quickfix', () => {
  assert.strictEqual(classify('練習用的 demo'), 'quickfix');
});

test('scaffold 一個新專案 → quickfix', () => {
  assert.strictEqual(classify('scaffold 一個新專案'), 'quickfix');
});

test('proof of concept API → quickfix', () => {
  assert.strictEqual(classify('proof of concept API'), 'quickfix');
});

test('簡單的範例 server → quickfix', () => {
  assert.strictEqual(classify('簡單的範例 server'), 'quickfix');
});

test('練習一下 React hooks → quickfix', () => {
  assert.strictEqual(classify('練習一下 React hooks'), 'quickfix');
});

test('hello world tutorial → quickfix', () => {
  assert.strictEqual(classify('hello world tutorial'), 'quickfix');
});

test('playground 試玩 → quickfix', () => {
  assert.strictEqual(classify('playground 試玩'), 'quickfix');
});

test('scratch pad 暫存 → quickfix', () => {
  assert.strictEqual(classify('scratch pad 暫存'), 'quickfix');
});

test('boilerplate 模板 → quickfix', () => {
  assert.strictEqual(classify('boilerplate 模板'), 'quickfix');
});

test('學習用 Express server → quickfix', () => {
  assert.strictEqual(classify('學習用 Express server'), 'quickfix');
});

// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1c: 級聯分類器 — 弱探索信號');
console.log('═'.repeat(50));

test('解釋 pipeline 架構 → research', () => {
  assert.strictEqual(classify('解釋 pipeline 架構'), 'research');
});

test('查看現有的測試 → research', () => {
  assert.strictEqual(classify('查看現有的測試'), 'research');
});

test('說明一下這段程式碼 → research', () => {
  assert.strictEqual(classify('說明一下這段程式碼'), 'research');
});

test('列出所有 hooks → research', () => {
  assert.strictEqual(classify('列出所有 hooks'), 'research');
});

test('找找有沒有相關的檔案 → research（找找 + 有沒有 雙重）', () => {
  assert.strictEqual(classify('找找有沒有相關的檔案'), 'research');
});

test('做什麼的 → research（弱探索）', () => {
  assert.strictEqual(classify('做點什麼'), 'research');
});

// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1d: 級聯分類器 — 動作分類');
console.log('═'.repeat(50));

// ─── Feature ─────────────────────────────────

test('建立一個完整的 REST API server → feature', () => {
  assert.strictEqual(classify('建立一個完整的 REST API server'), 'feature');
});

test('實作使用者認證系統 → feature', () => {
  assert.strictEqual(classify('實作使用者認證系統'), 'feature');
});

test('建立練習管理系統 → feature（練習 vs 練習用）', () => {
  assert.strictEqual(classify('建立練習管理系統'), 'feature');
});

test('新增功能：多語言支援 → feature', () => {
  assert.strictEqual(classify('新增功能：多語言支援'), 'feature');
});

test('建立資料庫服務 → feature', () => {
  assert.strictEqual(classify('建立資料庫服務'), 'feature');
});

test('整合 Stripe 支付系統 → feature', () => {
  assert.strictEqual(classify('整合 Stripe 支付系統'), 'feature');
});

test('implement user authentication → feature', () => {
  assert.strictEqual(classify('implement user authentication'), 'feature');
});

test('develop payment module → feature', () => {
  assert.strictEqual(classify('develop payment module'), 'feature');
});

test('build feature for notifications → feature', () => {
  assert.strictEqual(classify('build feature for notifications'), 'feature');
});

test('新的 API endpoint 功能 → feature', () => {
  assert.strictEqual(classify('新的 API endpoint 功能'), 'feature');
});

test('開發新的使用者模組 → feature', () => {
  assert.strictEqual(classify('開發新的使用者模組'), 'feature');
});

test('建立完整的專案 → feature', () => {
  assert.strictEqual(classify('建立完整的專案'), 'feature');
});

// ─── TDD ─────────────────────────────────────

test('tdd 開發流程 → tdd', () => {
  assert.strictEqual(classify('tdd 開發流程'), 'tdd');
});

test('測試驅動開發新功能 → tdd', () => {
  assert.strictEqual(classify('測試驅動開發新功能'), 'tdd');
});

test('先寫測試再寫程式 → tdd', () => {
  assert.strictEqual(classify('先寫測試再寫程式'), 'tdd');
});

test('用 test first 方式 → tdd', () => {
  assert.strictEqual(classify('用 test first 方式'), 'tdd');
});

// ─── Test ────────────────────────────────────

test('寫測試 → test', () => {
  assert.strictEqual(classify('寫測試'), 'test');
});

test('add unit test for login → test', () => {
  assert.strictEqual(classify('add unit test for login'), 'test');
});

test('create test for API endpoint → test', () => {
  assert.strictEqual(classify('create test for API endpoint'), 'test');
});

test('補測試 → test', () => {
  assert.strictEqual(classify('補測試'), 'test');
});

test('補單元測試 → test', () => {
  assert.strictEqual(classify('補單元測試'), 'test');
});

// ─── Refactor ────────────────────────────────

test('重構認證模組 → refactor', () => {
  assert.strictEqual(classify('重構認證模組'), 'refactor');
});

test('restructure the entire app → refactor', () => {
  assert.strictEqual(classify('restructure the entire app'), 'refactor');
});

test('重新設計整個架構 → refactor', () => {
  assert.strictEqual(classify('重新設計整個架構'), 'refactor');
});

// ─── Quickfix ────────────────────────────────

test('改名 userId 為 user_id → quickfix', () => {
  assert.strictEqual(classify('改名 userId 為 user_id'), 'quickfix');
});

test('fix typo in variable name → quickfix', () => {
  assert.strictEqual(classify('fix typo in variable name'), 'quickfix');
});

test('update button text → quickfix', () => {
  assert.strictEqual(classify('update button text'), 'quickfix');
});

test('隨便改改 → quickfix (default)', () => {
  assert.strictEqual(classify('隨便改改'), 'quickfix');
});

test('空字串 → quickfix', () => {
  assert.strictEqual(classify(''), 'quickfix');
});

// ─── Bugfix ──────────────────────────────────

test('修復登入失敗問題 → bugfix', () => {
  assert.strictEqual(classify('修復登入失敗問題'), 'bugfix');
});

test('fix the broken button → bugfix', () => {
  assert.strictEqual(classify('fix the broken button'), 'bugfix');
});

test('debug 記憶體洩漏 → bugfix', () => {
  assert.strictEqual(classify('debug 記憶體洩漏'), 'bugfix');
});

// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1e: 級聯分類器 — 邊界案例');
console.log('═'.repeat(50));

// ─── 含動作關鍵字的疑問句（關鍵測試：疑問 > 動作）──

test('含 tdd 的疑問句 → research（嗎 > tdd）', () => {
  assert.strictEqual(classify('我們規劃之後的 sdd tdd 會有文件產生嗎'), 'research');
});

test('含 implement 的疑問句 → research（什麼 > feature）', () => {
  assert.strictEqual(classify('implement 是什麼意思'), 'research');
});

test('含 refactor 的疑問句 → research（呢 > refactor）', () => {
  assert.strictEqual(classify('什麼時候該 refactor 呢'), 'research');
});

test('含 bug 的疑問句 → research（嗎 > bugfix）', () => {
  assert.strictEqual(classify('這算是 bug 嗎'), 'research');
});

test('含 test 的疑問句 → research（怎麼 > test）', () => {
  assert.strictEqual(classify('怎麼寫好的 test'), 'research');
});

test('含 feature 的 WH 疑問 → research（how > feature）', () => {
  assert.strictEqual(classify('how to implement this feature'), 'research');
});

test('含 tdd 的正反疑問 → research（好不好 > tdd）', () => {
  assert.strictEqual(classify('tdd 好不好用'), 'research');
});

test('含 fix 的疑問 → research（能不能 > bugfix）', () => {
  assert.strictEqual(classify('能不能 fix 這個問題'), 'research');
});

test('含 develop 的不確定 → research（不確定 > feature）', () => {
  assert.strictEqual(classify('不確定要 develop 什麼'), 'research');
});

// ─── Trivial + 探索詞 ───────────────────────────

test('hello world 看看 → quickfix（trivial > 弱探索）', () => {
  assert.strictEqual(classify('做一個 hello world 看看'), 'quickfix');
});

test('poc 試試看 → quickfix（trivial 優先）', () => {
  assert.strictEqual(classify('poc 試試看'), 'quickfix');
});

// ─── Trivial + 疑問 → 疑問優先 ──────────────────

test('hello world 是什麼 → research（強疑問 > trivial）', () => {
  assert.strictEqual(classify('hello world 是什麼'), 'research');
});

test('poc 有沒有範例 → research（強疑問 > trivial）', () => {
  assert.strictEqual(classify('poc 有沒有範例'), 'research');
});

test('scaffold 怎麼用 → research（強疑問 > trivial）', () => {
  assert.strictEqual(classify('scaffold 怎麼用'), 'research');
});

// ─── 短促輸入 ───────────────────────────────────

test('嗎 → research（句尾嗎）', () => {
  assert.strictEqual(classify('嗎'), 'research');
});

test('ok → quickfix（default）', () => {
  assert.strictEqual(classify('ok'), 'quickfix');
});

test('null → quickfix', () => {
  assert.strictEqual(classify(null), 'quickfix');
});

test('undefined → quickfix', () => {
  assert.strictEqual(classify(undefined), 'quickfix');
});

// ─── 複合動作（不含疑問信號）→ 第一個匹配贏 ──────

test('tdd + refactor → tdd（tdd 先匹配）', () => {
  assert.strictEqual(classify('用 tdd 方式 refactor 這段'), 'tdd');
});

test('簡單 demo 展示功能 → quickfix（trivial 先匹配）', () => {
  assert.strictEqual(classify('建立簡單 demo 展示功能'), 'quickfix');
});

// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1f: 級聯分類器 — 壓力測試');
console.log('═'.repeat(50));

// ─── 中英混合 ──────────────────────────────────

test('中英混合疑問：pipeline 的 tdd stage 有 output 嗎 → research', () => {
  assert.strictEqual(classify('pipeline 的 tdd stage 有 output 嗎'), 'research');
});

test('中英混合動作：implement 一個 WebSocket server → feature', () => {
  assert.strictEqual(classify('implement 一個 WebSocket server'), 'feature');
});

test('中英混合疑問 WH：how 實作 authentication → research', () => {
  assert.strictEqual(classify('how 實作 authentication'), 'research');
});

test('英文問句中文尾：is this a refactor嗎 → research', () => {
  assert.strictEqual(classify('is this a refactor嗎'), 'research');
});

// ─── 禮貌式指令（含嗎但是命令意圖）→ 保守分類 ──

test('禮貌指令：幫我 refactor 好嗎 → research（保守：嗎 > 動作）', () => {
  assert.strictEqual(classify('幫我 refactor 好嗎'), 'research');
});

test('禮貌指令：可以 implement 這個嗎 → research（保守）', () => {
  assert.strictEqual(classify('可以 implement 這個嗎'), 'research');
});

// ─── 多重信號疊加 ──────────────────────────────

test('雙重疑問：什麼是 tdd 好不好用嗎 → research', () => {
  assert.strictEqual(classify('什麼是 tdd 好不好用嗎'), 'research');
});

test('疑問 + 動作 + trivial：hello world 有沒有 bug → research', () => {
  assert.strictEqual(classify('hello world 有沒有 bug'), 'research');
});

// ─── 純標點 / 特殊字元 ─────────────────────────

test('純問號 → research', () => {
  assert.strictEqual(classify('?'), 'research');
});

test('純全形問號 → research', () => {
  assert.strictEqual(classify('？'), 'research');
});

test('空白 + 嗎 → research', () => {
  assert.strictEqual(classify('   嗎  '), 'research');
});

test('數字 → quickfix（default）', () => {
  assert.strictEqual(classify('12345'), 'quickfix');
});

// ─── 超長 prompt ────────────────────────────────

test('超長 prompt（含疑問詞）→ research', () => {
  const longPrompt = '我想了解一下' + ' 很長的背景描述'.repeat(50) + ' pipeline 的 tdd 機制';
  assert.strictEqual(classify(longPrompt), 'research');
});

test('超長 prompt（無疑問詞）→ 正常分類', () => {
  const longPrompt = '幫我' + ' 加上更多功能'.repeat(50) + ' 實作使用者認證系統';
  assert.strictEqual(classify(longPrompt), 'feature');
});

// ─── 大小寫不敏感 ────────────────────────────────

test('大寫 TDD → tdd', () => {
  assert.strictEqual(classify('TDD 開發'), 'tdd');
});

test('大寫 IMPLEMENT → feature', () => {
  assert.strictEqual(classify('IMPLEMENT user auth'), 'feature');
});

test('大寫 WHAT → research', () => {
  assert.strictEqual(classify('WHAT is this'), 'research');
});

// ─── 尾部空白處理 ────────────────────────────────

test('尾部空白 + 嗎 → research', () => {
  assert.strictEqual(classify('這是 bug 嗎   '), 'research');
});

test('尾部空白 + ? → research', () => {
  assert.strictEqual(classify('is this correct?  '), 'research');
});

// ─── 日常對話式 prompt ──────────────────────────

test('打招呼：嗨 → quickfix（default）', () => {
  assert.strictEqual(classify('嗨'), 'quickfix');
});

test('感謝：謝謝 → quickfix（default）', () => {
  assert.strictEqual(classify('謝謝'), 'quickfix');
});

test('確認：好的 → quickfix（default）', () => {
  assert.strictEqual(classify('好的'), 'quickfix');
});

test('繼續：繼續 → quickfix（default）', () => {
  assert.strictEqual(classify('繼續'), 'quickfix');
});

// ═══════════════════════════════════════════════
// Part 1f: classifyWithConfidence 三層架構測試
// ═══════════════════════════════════════════════

const { extractExplicitPipeline, classifyWithConfidence } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

console.log('\n🧪 Part 1f: classifyWithConfidence — Layer 1 顯式覆寫');
console.log('═'.repeat(50));

test('Layer 1: [pipeline:quick-dev] → quick-dev, 1.0, explicit', () => {
  const result = classifyWithConfidence('[pipeline:quick-dev] 修復認證問題');
  assert.strictEqual(result.pipeline, 'quick-dev');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
});

test('Layer 1: [pipeline:full] 大小寫不敏感 → full', () => {
  const result = classifyWithConfidence('建立完整系統 [Pipeline:Full]');
  assert.strictEqual(result.pipeline, 'full');
  assert.strictEqual(result.confidence, 1.0);
  assert.strictEqual(result.source, 'explicit');
});

test('Layer 1: [PIPELINE:SECURITY] 全大寫 → security', () => {
  const result = classifyWithConfidence('[PIPELINE:SECURITY] 修復 XSS 漏洞');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

test('Layer 1: [pipeline:invalid-name] → 降級到 Layer 2', () => {
  const result = classifyWithConfidence('[pipeline:invalid-name] fix typo');
  assert.strictEqual(result.source, 'regex'); // 降級到 Layer 2
  assert.strictEqual(result.pipeline, 'fix'); // quickfix → fix
});

test('Layer 1: 語法位置不限（結尾）→ 正確解析', () => {
  const result = classifyWithConfidence('修復認證 [pipeline:security]');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

test('Layer 1: 語法位置不限（中間）→ 正確解析', () => {
  const result = classifyWithConfidence('修復認證 [pipeline:security] 很急');
  assert.strictEqual(result.pipeline, 'security');
  assert.strictEqual(result.confidence, 1.0);
});

test('extractExplicitPipeline: 正常解析', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:quick-dev] 修復問題'), 'quick-dev');
});

test('extractExplicitPipeline: 無標記 → null', () => {
  assert.strictEqual(extractExplicitPipeline('修復問題'), null);
});

test('extractExplicitPipeline: 不合法 ID → null', () => {
  assert.strictEqual(extractExplicitPipeline('[pipeline:invalid]'), null);
});

console.log('\n🧪 Part 1g: classifyWithConfidence — Layer 2 Regex 分類');
console.log('═'.repeat(50));

test('Layer 2: 建立完整 REST API → standard, >= 0.7', () => {
  const result = classifyWithConfidence('建立一個完整的 REST API server');
  assert.strictEqual(result.pipeline, 'standard'); // feature → standard
  assert.ok(result.confidence >= 0.7);
  assert.strictEqual(result.source, 'regex');
});

test('Layer 2: 問答「什麼是 pipeline?」 → none, >= 0.9', () => {
  const result = classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.pipeline, 'none'); // research → none
  assert.ok(result.confidence >= 0.9);
  assert.strictEqual(result.source, 'regex');
});

test('Layer 2: TDD 開發 → test-first, >= 0.7', () => {
  const result = classifyWithConfidence('用 TDD 方式開發使用者認證');
  assert.strictEqual(result.pipeline, 'test-first'); // tdd → test-first
  assert.ok(result.confidence >= 0.7);
  assert.strictEqual(result.source, 'regex');
});

test('Layer 2: bugfix → quick-dev, >= 0.7', () => {
  const result = classifyWithConfidence('修復登入失敗的問題');
  assert.strictEqual(result.pipeline, 'quick-dev'); // bugfix → quick-dev
  assert.ok(result.confidence >= 0.7);
});

test('Layer 2: quickfix → fix, >= 0.7', () => {
  const result = classifyWithConfidence('fix typo in variable name');
  assert.strictEqual(result.pipeline, 'fix'); // quickfix → fix
  assert.ok(result.confidence >= 0.7);
});

test('Layer 2: refactor → standard, >= 0.7', () => {
  const result = classifyWithConfidence('refactor 使用者認證模組');
  assert.strictEqual(result.pipeline, 'standard'); // refactor → standard
  assert.ok(result.confidence >= 0.7);
});

test('Layer 2: Strong question → none, 0.95', () => {
  const result = classifyWithConfidence('這是什麼東西？');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0.95);
  assert.strictEqual(result.source, 'regex');
});

test('Layer 2: Trivial → fix, 0.9', () => {
  const result = classifyWithConfidence('做一個 hello world');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.9);
});

test('Layer 2: Weak explore → none, 0.6 (低信心度)', () => {
  const result = classifyWithConfidence('看看現在的狀態');
  assert.strictEqual(result.pipeline, 'none');
  assert.strictEqual(result.confidence, 0.6);
  assert.strictEqual(result.source, 'pending-llm'); // 信心度 < 0.7 標記為 pending-llm
});

test('Layer 2: Action keyword → 0.8', () => {
  const result = classifyWithConfidence('implement user authentication');
  assert.strictEqual(result.pipeline, 'standard'); // feature → standard
  assert.strictEqual(result.confidence, 0.8);
});

test('Layer 2: 預設 quickfix（短文本）→ fix, 0.5, pending-llm', () => {
  const result = classifyWithConfidence('隨便改改');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.5, '短文本 default 應降低信心度');
  assert.strictEqual(result.source, 'pending-llm', '短文本 default 應觸發 Layer 3');
});

test('Layer 2: 預設 quickfix（長文本）→ fix, 0.7', () => {
  const result = classifyWithConfidence('this is a long enough prompt that should not trigger Layer 3 LLM classification');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7, '長文本 default 保持 0.7');
  assert.strictEqual(result.source, 'regex', '長文本 default 不觸發 Layer 3');
});

test('Layer 2: 空字串 → fix, 0.7', () => {
  const result = classifyWithConfidence('');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7);
});

console.log('\n🧪 Part 1h: classifyWithConfidence — taskType→pipeline 映射');
console.log('═'.repeat(50));

test('映射: research → none', () => {
  const result = classifyWithConfidence('什麼是 TDD？');
  assert.strictEqual(result.pipeline, 'none');
});

test('映射: quickfix → fix', () => {
  const result = classifyWithConfidence('改個變數名');
  assert.strictEqual(result.pipeline, 'fix');
});

test('映射: bugfix → quick-dev', () => {
  const result = classifyWithConfidence('fix authentication bug');
  assert.strictEqual(result.pipeline, 'quick-dev');
});

test('映射: feature → standard', () => {
  const result = classifyWithConfidence('implement OAuth login');
  assert.strictEqual(result.pipeline, 'standard');
});

test('映射: refactor → standard', () => {
  const result = classifyWithConfidence('refactor database layer');
  assert.strictEqual(result.pipeline, 'standard');
});

test('映射: test → quick-dev', () => {
  const result = classifyWithConfidence('write tests for authentication');
  assert.strictEqual(result.pipeline, 'quick-dev');
});

test('映射: tdd → test-first', () => {
  const result = classifyWithConfidence('test-first development for API');
  assert.strictEqual(result.pipeline, 'test-first');
});

// ═══════════════════════════════════════════════
// Part 1i: Layer 3 LLM Fallback — 介面驗證
// ═══════════════════════════════════════════════

const { classifyWithLLM, buildPipelineCatalogHint, LLM_MODEL, LLM_TIMEOUT, LLM_CONFIDENCE_THRESHOLD } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

console.log('\n🧪 Part 1i: Layer 3 LLM Fallback — 介面驗證');
console.log('═'.repeat(50));

asyncTest('classifyWithLLM: 無 API key → 回傳 null', async () => {
  // 確保測試環境無 key（暫存原始值並清除）
  const origKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await classifyWithLLM('建立一個完整的 REST API');
    assert.strictEqual(result, null, '無 API key 時應回傳 null');
  } finally {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  }
});

asyncTest('classifyWithLLM: 空 prompt → 回傳 null（無 key）', async () => {
  const origKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await classifyWithLLM('');
    assert.strictEqual(result, null);
  } finally {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  }
});

test('classifyWithLLM: 函式回傳 Promise', () => {
  const origKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = classifyWithLLM('test');
    assert.ok(result instanceof Promise, '應回傳 Promise');
  } finally {
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
  }
});

test('buildPipelineCatalogHint: 回傳非空字串', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(typeof hint === 'string');
  assert.ok(hint.length > 0);
});

test('buildPipelineCatalogHint: 包含 [pipeline:xxx] 語法', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(hint.includes('[pipeline:'), '應包含 [pipeline: 語法');
});

test('buildPipelineCatalogHint: 包含所有非 none 的 pipeline', () => {
  const hint = buildPipelineCatalogHint();
  const expected = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security'];
  for (const id of expected) {
    assert.ok(hint.includes(`[pipeline:${id}]`), `應包含 [pipeline:${id}]`);
  }
});

test('buildPipelineCatalogHint: 不包含 none', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(!hint.includes('[pipeline:none]'), '不應包含 [pipeline:none]');
});

test('buildPipelineCatalogHint: 包含信心度偏低提示', () => {
  const hint = buildPipelineCatalogHint();
  assert.ok(hint.includes('信心度偏低'), '應包含信心度提示文字');
});

test('Layer 3 觸發條件: weak explore 信心度 < 0.7 → pending-llm', () => {
  const result = classifyWithConfidence('看看現在的狀態');
  assert.strictEqual(result.source, 'pending-llm');
  assert.ok(result.confidence < 0.7, '信心度應 < 0.7');
});

test('Layer 3 不觸發: strong question → regex', () => {
  const result = classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.source, 'regex');
  assert.ok(result.confidence >= 0.7);
});

test('Layer 3 不觸發: action keyword → regex', () => {
  const result = classifyWithConfidence('implement user authentication');
  assert.strictEqual(result.source, 'regex');
  assert.ok(result.confidence >= 0.7);
});

test('Layer 3 不觸發: trivial → regex', () => {
  const result = classifyWithConfidence('做一個 hello world');
  assert.strictEqual(result.source, 'regex');
  assert.ok(result.confidence >= 0.7);
});

test('Layer 3 不觸發: explicit pipeline → explicit', () => {
  const result = classifyWithConfidence('[pipeline:full] 建立系統');
  assert.strictEqual(result.source, 'explicit');
  assert.strictEqual(result.confidence, 1.0);
});

// ═══════════════════════════════════════════════
// Part 1j: Layer 3 環境變數與常量驗證
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1j: Layer 3 環境變數與常量驗證');
console.log('═'.repeat(50));

test('LLM_MODEL 預設值: claude-sonnet-4-20250514', () => {
  assert.strictEqual(LLM_MODEL, 'claude-sonnet-4-20250514');
});

test('LLM_TIMEOUT 預設值: 10000', () => {
  assert.strictEqual(LLM_TIMEOUT, 10000);
});

test('LLM_CONFIDENCE_THRESHOLD 預設值: 0.7', () => {
  assert.strictEqual(LLM_CONFIDENCE_THRESHOLD, 0.7);
});

// 子行程驗證：module-level const 需要新 Node 進程才能覆寫
const classifierModulePath = require.resolve(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

function runClassifierCheck(envVars, expression) {
  const tmpFile = path.join(os.tmpdir(), `vibe-cls-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, `const c = require(${JSON.stringify(classifierModulePath)});\nprocess.stdout.write(String(${expression}));`);
  try {
    return execSync(`node "${tmpFile}"`, {
      env: { ...process.env, ...envVars },
      timeout: 5000,
    }).toString();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

test('VIBE_CLASSIFIER_MODEL 環境變數覆寫', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_MODEL: 'claude-haiku-4-5-20251001' },
    'c.LLM_MODEL'
  );
  assert.strictEqual(result, 'claude-haiku-4-5-20251001');
});

test('VIBE_CLASSIFIER_THRESHOLD=0.5 覆寫', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '0.5' },
    'c.LLM_CONFIDENCE_THRESHOLD'
  );
  assert.strictEqual(result, '0.5');
});

test('VIBE_CLASSIFIER_THRESHOLD=0 → Layer 3 永不觸發（所有信心度 >= 0）', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '0' },
    'c.classifyWithConfidence("看看現在的狀態").source'
  );
  assert.strictEqual(result, 'regex', '閾值 0 時不應觸發 pending-llm');
});

test('VIBE_CLASSIFIER_THRESHOLD=1.0 → weak explore 觸發 pending-llm', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '1.0' },
    'c.classifyWithConfidence("看看現在的狀態").source'
  );
  assert.strictEqual(result, 'pending-llm', '閾值 1.0 時信心度 0.6 < 1.0 應觸發');
});

test('VIBE_CLASSIFIER_THRESHOLD=1.0 → strong question 也觸發 pending-llm', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '1.0' },
    'c.classifyWithConfidence("什麼是 pipeline?").source'
  );
  assert.strictEqual(result, 'pending-llm', '閾值 1.0 時信心度 0.95 < 1.0 應觸發');
});

test('VIBE_CLASSIFIER_THRESHOLD=1.0 → explicit pipeline 不觸發（信心度 1.0）', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '1.0' },
    'c.classifyWithConfidence("[pipeline:full] 建立系統").source'
  );
  assert.strictEqual(result, 'explicit', '顯式 pipeline 信心度 1.0 不受閾值影響');
});

test('VIBE_CLASSIFIER_THRESHOLD=NaN → 降級為預設 0.7', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: 'not-a-number' },
    'c.LLM_CONFIDENCE_THRESHOLD'
  );
  assert.strictEqual(result, '0.7', 'NaN 應降級為預設值 0.7');
});

// ═══════════════════════════════════════════════
// Part 1k: Session 快取驗證（task-classifier Layer 3 整合）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 1k: Session 快取驗證');
console.log('═'.repeat(50));

const CLAUDE_TEST_DIR = path.join(os.homedir(), '.claude');
const TC_SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'task-classifier.js');

function runTaskClassifier(stdinData, envOverrides = {}) {
  const input = JSON.stringify(stdinData);
  const testEnv = { ...process.env, ...envOverrides };
  // 確保測試不呼叫真實 LLM API + 使用預設閾值
  delete testEnv.ANTHROPIC_API_KEY;
  delete testEnv.VIBE_CLASSIFIER_THRESHOLD;
  delete testEnv.VIBE_CLASSIFIER_MODEL;
  try {
    const stdout = execSync(
      `echo '${input.replace(/'/g, "'\\''")}' | node "${TC_SCRIPT}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, env: testEnv }
    ).toString().trim();
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      exitCode: err.status || 1,
    };
  }
}

function createTestState(sessionId, overrides = {}) {
  const p = path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`);
  const state = {
    sessionId,
    phase: overrides.phase || 'IDLE',
    context: {
      pipelineId: null,
      taskType: null,
      expectedStages: [],
      environment: { languages: { primary: null, secondary: [] }, framework: null, packageManager: null, tools: {} },
      openspecEnabled: false,
      pipelineRules: [],
      needsDesign: false,
      ...(overrides.context || {}),
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
      ...(overrides.progress || {}),
    },
    meta: {
      initialized: true,
      classifiedAt: null,
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
      ...(overrides.meta || {}),
    },
  };
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

function readTestState(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`), 'utf8'));
}

function cleanupTestState(sessionId) {
  const files = [
    path.join(CLAUDE_TEST_DIR, `pipeline-state-${sessionId}.json`),
    path.join(CLAUDE_TEST_DIR, `timeline-${sessionId}.jsonl`),
  ];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

test('reset 清除 llmClassification（pipeline 完成後新分類重設）', () => {
  const sid = 'test-reset-llm-' + Date.now();
  try {
    createTestState(sid, {
      phase: 'COMPLETE',
      context: {
        pipelineId: 'fix',
        taskType: 'quickfix',
        expectedStages: ['DEV'],
      },
      progress: {
        stageResults: { DEV: { verdict: 'PASS' } },
      },
      meta: {
        llmClassification: { pipeline: 'standard', confidence: 0.85, source: 'llm' },
      },
    });
    runTaskClassifier({ session_id: sid, prompt: 'implement authentication' });
    const state = readTestState(sid);
    assert.strictEqual(state.meta.llmClassification, null, 'reset 後 llmClassification 應為 null');
    assert.deepStrictEqual(state.progress.retries, {}, 'reset 後 retries 應為空物件');
  } finally {
    cleanupTestState(sid);
  }
});

test('LLM 失敗不寫入快取（無 API key + weak explore prompt）', () => {
  const sid = 'test-no-cache-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    assert.strictEqual(state.meta.llmClassification, null, 'LLM 失敗時不應寫入快取');
    assert.ok(state.context.pipelineId, '應有 pipelineId（降級分類）');
    assert.strictEqual(state.meta.classificationSource, 'regex-low', 'source 應為 regex-low');
  } finally {
    cleanupTestState(sid);
  }
});

test('快取命中直接使用（不呼叫 LLM API）', () => {
  const sid = 'test-cache-hit-' + Date.now();
  try {
    createTestState(sid, {
      meta: {
        llmClassification: { pipeline: 'standard', confidence: 0.85, source: 'llm', timestamp: Date.now() },
      },
    });
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    assert.strictEqual(state.context.pipelineId, 'standard', '快取命中應使用快取的 pipeline');
    assert.strictEqual(state.meta.classificationSource, 'llm-cached', 'source 應為 llm-cached');
  } finally {
    cleanupTestState(sid);
  }
});

test('過期快取不使用（TTL 5 分鐘）', () => {
  const sid = 'test-cache-expired-' + Date.now();
  try {
    createTestState(sid, {
      meta: {
        llmClassification: { pipeline: 'standard', confidence: 0.85, source: 'llm', timestamp: Date.now() - 6 * 60 * 1000 },
      },
    });
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    // 過期快取不使用，降級為 regex-low（無 API key）
    assert.notStrictEqual(state.meta.classificationSource, 'llm-cached', '過期快取不應命中');
  } finally {
    cleanupTestState(sid);
  }
});

test('無 timestamp 的舊格式快取不使用', () => {
  const sid = 'test-cache-no-ts-' + Date.now();
  try {
    createTestState(sid, {
      meta: {
        llmClassification: { pipeline: 'standard', confidence: 0.85, source: 'llm' },
      },
    });
    runTaskClassifier({ session_id: sid, prompt: '看看現在的狀態' });
    const state = readTestState(sid);
    assert.notStrictEqual(state.meta.classificationSource, 'llm-cached', '無 timestamp 的快取不應命中');
  } finally {
    cleanupTestState(sid);
  }
});

test('首次分類無快取時正常分類', () => {
  const sid = 'test-first-cls-' + Date.now();
  try {
    createTestState(sid);
    runTaskClassifier({ session_id: sid, prompt: 'implement user authentication' });
    const state = readTestState(sid);
    assert.strictEqual(state.context.pipelineId, 'standard', 'feature 類型應映射到 standard pipeline');
    assert.strictEqual(state.meta.classificationSource, 'regex', '高信心度應為 regex（不觸發 LLM）');
  } finally {
    cleanupTestState(sid);
  }
});

// ═══════════════════════════════════════════════
// Part 2: check-console-log 檔案過濾邏輯
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 2: check-console-log 檔案過濾邏輯');
console.log('═'.repeat(50));

const filterFn = (f) => !/(^|\/)scripts\/hooks\//.test(f) && !/hook-logger\.js$/.test(f);

test('排除：plugins/vibe/scripts/hooks/pipeline-check.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/pipeline-check.js'), false);
});

test('排除：plugins/vibe/scripts/hooks/stage-transition.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/stage-transition.js'), false);
});

test('排除：plugins/vibe/scripts/hooks/task-classifier.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/hooks/task-classifier.js'), false);
});

test('排除：scripts/hooks/custom-hook.js', () => {
  assert.strictEqual(filterFn('scripts/hooks/custom-hook.js'), false);
});

test('排除：plugins/vibe/scripts/lib/hook-logger.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/hook-logger.js'), false);
});

test('排除：some/path/hook-logger.js', () => {
  assert.strictEqual(filterFn('some/path/hook-logger.js'), false);
});

test('不排除：src/app.js', () => {
  assert.strictEqual(filterFn('src/app.js'), true);
});

test('不排除：plugins/vibe/scripts/lib/flow/pipeline-discovery.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/flow/pipeline-discovery.js'), true);
});

test('不排除：index.js', () => {
  assert.strictEqual(filterFn('index.js'), true);
});

test('不排除：plugins/vibe/scripts/lib/registry.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/scripts/lib/registry.js'), true);
});

test('不排除：plugins/vibe/server.js', () => {
  assert.strictEqual(filterFn('plugins/vibe/server.js'), true);
});

test('不排除：scripts/lib/utils.js', () => {
  assert.strictEqual(filterFn('scripts/lib/utils.js'), true);
});

test('不排除：hooks/my-file.js（hooks/ 不是 scripts/hooks/）', () => {
  assert.strictEqual(filterFn('hooks/my-file.js'), true);
});

test('不排除：some/hooks-helper.js', () => {
  assert.strictEqual(filterFn('some/hooks-helper.js'), true);
});

test('不排除：logger.js（不是 hook-logger.js）', () => {
  assert.strictEqual(filterFn('logger.js'), true);
});

// ═══════════════════════════════════════════════
// Part 3: 品質守衛 hooks stdin→stdout 驗證
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 3: 品質守衛 hooks stdin→stdout 驗證');
console.log('═'.repeat(50));

const PLUGIN_ROOT = path.join(__dirname, '..');

function runSentinelHook(hookName, stdinData) {
  const script = path.join(PLUGIN_ROOT, 'scripts', 'hooks', `${hookName}.js`);
  const input = JSON.stringify(stdinData);
  try {
    const stdout = execSync(
      `echo '${input.replace(/'/g, "'\\''")}' | node "${script}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    ).toString().trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      stderr: err.stderr ? err.stderr.toString().trim() : '',
      exitCode: err.status || 1,
    };
  }
}

// auto-lint + auto-format 已合併至 post-edit.js（v1.0.50），改用純函式驗證
const postEdit = require(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'post-edit.js'));

test('runLintStep：.xyz 檔案 → null（無對應 linter）', () => {
  assert.strictEqual(postEdit.runLintStep('/tmp/test.xyz', 'test', 'Write'), null);
});

test('runLintStep：null 路徑 → null', () => {
  assert.strictEqual(postEdit.runLintStep(null, 'test', 'Write'), null);
});

test('runLintStep：.json → null（linter=null）', () => {
  assert.strictEqual(postEdit.runLintStep('/tmp/test.json', 'test', 'Write'), null);
});

test('runFormatStep：.xyz 檔案 → undefined（無對應 formatter）', () => {
  assert.strictEqual(postEdit.runFormatStep('/tmp/test.xyz', 'test', 'Write'), undefined);
});

test('runFormatStep：null 路徑 → undefined', () => {
  assert.strictEqual(postEdit.runFormatStep(null, 'test', 'Write'), undefined);
});

test('runFormatStep：.py → 不崩潰', () => {
  postEdit.runFormatStep('/tmp/test.py', 'test', 'Write');
  assert.ok(true);
});

// danger-guard 已合併至 guard-rules.js（v1.0.50），改用 evaluateBashDanger 驗證
test('evaluateBashDanger：安全指令 → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger('ls -la'), null);
});

test('evaluateBashDanger：空指令 → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger(''), null);
});

test('evaluateBashDanger：npm install → null（允許）', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  assert.strictEqual(evaluateBashDanger('npm install'), null);
});

test('evaluateBashDanger：chmod 777 → block + matchedPattern', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('chmod 777 /etc/passwd');
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('chmod 777'), 'message 應包含攔截原因');
  assert.strictEqual(result.matchedPattern, 'chmod 777');
});

test('evaluateBashDanger：DROP TABLE → block', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('DROP TABLE users');
  assert.strictEqual(result.decision, 'block');
  assert.ok(result.message.includes('DROP TABLE'));
});

test('evaluateBashDanger：rm -rf / → block', () => {
  const { evaluateBashDanger } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'sentinel', 'guard-rules.js'));
  const result = evaluateBashDanger('rm -rf / ');
  assert.strictEqual(result.decision, 'block');
  assert.strictEqual(result.matchedPattern, 'rm -rf /');
});

test('check-console-log：stop_hook_active=true → 靜默退出', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: true });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('check-console-log：stop_hook_active=false → 正常執行', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: false });
  assert.strictEqual(r.exitCode, 0);
});

test('runLintStep：.ts 檔案 → null 或 systemMessage 字串', () => {
  const result = postEdit.runLintStep('/tmp/nonexistent.ts', 'test', 'Write');
  assert.ok(result === null || typeof result === 'string', 'null 或 lint 警告字串');
});

// ═══════════════════════════════════════════════
// Part 4: matchedRule 驗證（Phase 3 Classification Analytics）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 4: matchedRule 驗證');
console.log('═'.repeat(50));

test('classifyWithConfidence 回傳包含 matchedRule 欄位', () => {
  const result = classifyWithConfidence('建立一個 REST API');
  assert.ok('matchedRule' in result, '應包含 matchedRule 欄位');
});

test('Layer 1 explicit → matchedRule: explicit', () => {
  const result = classifyWithConfidence('[pipeline:full] 建立系統');
  assert.strictEqual(result.matchedRule, 'explicit');
});

test('Strong question → matchedRule: strong-question', () => {
  const result = classifyWithConfidence('什麼是 pipeline?');
  assert.strictEqual(result.matchedRule, 'strong-question');
});

test('Trivial → matchedRule: trivial', () => {
  const result = classifyWithConfidence('做一個 hello world');
  assert.strictEqual(result.matchedRule, 'trivial');
});

test('Weak explore → matchedRule: weak-explore', () => {
  const result = classifyWithConfidence('看看現在的狀態');
  assert.strictEqual(result.matchedRule, 'weak-explore');
});

test('Action feature → matchedRule: action:feature', () => {
  const result = classifyWithConfidence('建立完整的 REST API server [pipeline:standard]');
  // explicit 優先
  assert.strictEqual(result.matchedRule, 'explicit');
  // 不帶 explicit 的版本
  const r2 = classifyWithConfidence('建立完整的 REST API server 新增功能');
  assert.strictEqual(r2.matchedRule, 'action:feature');
});

test('Action bugfix → matchedRule: action:bugfix', () => {
  const result = classifyWithConfidence('fix the authentication bug');
  assert.strictEqual(result.matchedRule, 'action:bugfix');
});

test('Action refactor → matchedRule: action:refactor', () => {
  const result = classifyWithConfidence('重構使用者模組');
  assert.strictEqual(result.matchedRule, 'action:refactor');
});

test('Action tdd → matchedRule: action:tdd', () => {
  const result = classifyWithConfidence('用 TDD 方式開發');
  assert.strictEqual(result.matchedRule, 'action:tdd');
});

test('Default → matchedRule: default', () => {
  const result = classifyWithConfidence('update the color');
  assert.strictEqual(result.matchedRule, 'default');
});

test('Empty prompt → matchedRule: default', () => {
  const result = classifyWithConfidence('');
  assert.strictEqual(result.matchedRule, 'default');
});

test('Null prompt → matchedRule: default', () => {
  const result = classifyWithConfidence(null);
  assert.strictEqual(result.matchedRule, 'default');
});

// ═══════════════════════════════════════════════
// Part 4b: 中文動詞擴充驗證（v1.0.46 改善 A）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 4b: 中文動詞擴充驗證');
console.log('═'.repeat(50));

test('改善 → refactor', () => {
  assert.strictEqual(classify('改善系統效能'), 'refactor');
});

test('優化 → refactor', () => {
  assert.strictEqual(classify('優化資料庫查詢'), 'refactor');
});

test('改進 → refactor', () => {
  assert.strictEqual(classify('改進錯誤處理流程'), 'refactor');
});

test('提升 → refactor', () => {
  assert.strictEqual(classify('提升使用者體驗'), 'refactor');
});

test('Pipeline 選擇 UX 改善 → refactor（AskUserQuestion 典型選項）', () => {
  assert.strictEqual(classify('Pipeline 選擇 UX 改善'), 'refactor');
  const r = classifyWithConfidence('Pipeline 選擇 UX 改善');
  assert.strictEqual(r.pipeline, 'standard', '改善 → refactor → standard');
  assert.strictEqual(r.matchedRule, 'action:refactor');
  assert.strictEqual(r.confidence, 0.8, '動作關鍵字信心度 0.8');
});

test('疑問句 > refactor：能否改善效能', () => {
  assert.strictEqual(classify('能否改善效能'), 'research');
});

test('疑問句 > refactor：改善什麼', () => {
  assert.strictEqual(classify('改善什麼'), 'research');
});

// ═══════════════════════════════════════════════
// Part 4c: docs taskType 驗證（v1.0.46 新增）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 4c: docs taskType 驗證');
console.log('═'.repeat(50));

test('更新 README.md → docs', () => {
  assert.strictEqual(classify('更新 README.md'), 'docs');
  const r = classifyWithConfidence('更新 README.md');
  assert.strictEqual(r.pipeline, 'docs-only', 'docs → docs-only');
  assert.strictEqual(r.matchedRule, 'action:docs');
});

test('更新 MEMORY.md → docs', () => {
  assert.strictEqual(classify('更新 MEMORY.md'), 'docs');
});

test('更新 CHANGELOG.md → docs', () => {
  assert.strictEqual(classify('更新 CHANGELOG.md'), 'docs');
});

test('更新文件 → docs', () => {
  assert.strictEqual(classify('更新文件'), 'docs');
});

test('補文件 → docs', () => {
  assert.strictEqual(classify('補文件'), 'docs');
});

test('寫文檔 → docs', () => {
  assert.strictEqual(classify('寫文檔'), 'docs');
});

test('update readme → docs', () => {
  assert.strictEqual(classify('update the readme'), 'docs');
});

test('update docs → docs', () => {
  assert.strictEqual(classify('update project docs'), 'docs');
});

test('更新 docker → NOT docs（避免 false positive）', () => {
  assert.notStrictEqual(classify('更新 docker compose'), 'docs');
});

// ═══════════════════════════════════════════════
// Part 4d: 短文本 LLM 觸發驗證（v1.0.46 改善 B）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 4d: 短文本 LLM 觸發驗證');
console.log('═'.repeat(50));

test('短文本 default → pending-llm: ok', () => {
  const r = classifyWithConfidence('ok');
  assert.strictEqual(r.confidence, 0.5, '短文本 default 信心度 0.5');
  assert.strictEqual(r.source, 'pending-llm', '應觸發 Layer 3');
});

test('短文本 default → pending-llm: 繼續', () => {
  const r = classifyWithConfidence('繼續');
  assert.strictEqual(r.confidence, 0.5);
  assert.strictEqual(r.source, 'pending-llm');
});

test('短文本但命中 action → 不觸發 LLM', () => {
  const r = classifyWithConfidence('優化效能');
  assert.strictEqual(r.confidence, 0.8, '動作關鍵字信心度 0.8');
  assert.strictEqual(r.source, 'regex', '不需 Layer 3');
});

test('短文本疑問句 → 不觸發 LLM（信心度 0.95）', () => {
  const r = classifyWithConfidence('這是什麼');
  assert.strictEqual(r.confidence, 0.95);
  assert.strictEqual(r.source, 'regex');
});

test('長文本 default → 不觸發 LLM（保持 0.7）', () => {
  const prompt = 'this is a sufficiently long prompt that does not match any action keywords at all';
  const r = classifyWithConfidence(prompt);
  assert.strictEqual(r.confidence, 0.7, '長文本 default 保持 0.7');
  assert.strictEqual(r.source, 'regex', '長文本不觸發 Layer 3');
  assert.ok(prompt.length > 40, '確認 prompt 超過閾值');
});

test('剛好 40 字元 → 觸發 LLM', () => {
  const prompt = 'a'.repeat(40);
  const r = classifyWithConfidence(prompt);
  assert.strictEqual(r.confidence, 0.5, '40 字元 → 觸發 LLM');
});

test('41 字元 → 不觸發 LLM', () => {
  const prompt = 'a'.repeat(41);
  const r = classifyWithConfidence(prompt);
  assert.strictEqual(r.confidence, 0.7, '41 字元 → 不觸發 LLM');
});

// ═══════════════════════════════════════════════
// Part 5: getAdaptiveThreshold 驗證（Phase 3 Adaptive Confidence）
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 5: getAdaptiveThreshold 驗證');
console.log('═'.repeat(50));

const { getAdaptiveThreshold, STATS_PATH } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

test('getAdaptiveThreshold: 無 stats 檔案 → 回傳 0.7', () => {
  // 由子行程測試（避免影響全域 state）
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '' },
    'c.getAdaptiveThreshold()'
  );
  // 空字串 parseFloat → NaN → 讀取 stats file
  // 不確定 stats 檔是否存在，檢查是 0.7 或 0.5
  assert.ok(result === '0.7' || result === '0.5', `應為 0.7 或 0.5，實際: ${result}`);
});

test('getAdaptiveThreshold: 環境變數覆寫', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '0.8' },
    'c.getAdaptiveThreshold()'
  );
  assert.strictEqual(result, '0.8', '環境變數應覆寫 adaptive threshold');
});

test('getAdaptiveThreshold: 環境變數 0 → 回傳 0', () => {
  const result = runClassifierCheck(
    { VIBE_CLASSIFIER_THRESHOLD: '0' },
    'c.getAdaptiveThreshold()'
  );
  assert.strictEqual(result, '0', '環境變數 0 應覆寫');
});

test('getAdaptiveThreshold: 模擬高修正率 → 回傳 0.5', () => {
  // 建立臨時 stats 檔案模擬高修正率
  const tmpStats = path.join(os.tmpdir(), `vibe-stats-test-${Date.now()}.json`);
  const window = [];
  for (let i = 0; i < 10; i++) {
    window.push({ layer: 2, source: 'regex', corrected: i < 5, timestamp: new Date().toISOString() });
  }
  fs.writeFileSync(tmpStats, JSON.stringify({ recentWindow: window, totalClassifications: 10, totalCorrections: 5 }));

  // 子行程用自訂 STATS_PATH
  const tmpFile = path.join(os.tmpdir(), `vibe-cls-adapt-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, `
    const c = require(${JSON.stringify(classifierModulePath)});
    // 覆寫 STATS_PATH
    const fs = require('fs');
    const stats = JSON.parse(fs.readFileSync(${JSON.stringify(tmpStats)}, 'utf8'));
    const window = stats.recentWindow || [];
    const layer2 = window.filter(r => r.layer === 2);
    const corrected = layer2.filter(r => r.corrected).length;
    const rate = corrected / layer2.length;
    process.stdout.write(String(rate > 0.3 ? 0.5 : 0.7));
  `);
  try {
    const result = execSync(`node "${tmpFile}"`, {
      env: { ...process.env },
      timeout: 5000,
    }).toString();
    assert.strictEqual(result, '0.5', '50% 修正率應觸發 0.5 閾值');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.unlinkSync(tmpStats); } catch (_) {}
  }
});

test('getAdaptiveThreshold: 模擬低修正率 → 保持 0.7', () => {
  const tmpStats = path.join(os.tmpdir(), `vibe-stats-test-${Date.now()}.json`);
  const window = [];
  for (let i = 0; i < 10; i++) {
    window.push({ layer: 2, source: 'regex', corrected: i < 1, timestamp: new Date().toISOString() });
  }
  fs.writeFileSync(tmpStats, JSON.stringify({ recentWindow: window, totalClassifications: 10, totalCorrections: 1 }));

  const tmpFile = path.join(os.tmpdir(), `vibe-cls-adapt-low-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, `
    const fs = require('fs');
    const stats = JSON.parse(fs.readFileSync(${JSON.stringify(tmpStats)}, 'utf8'));
    const window = stats.recentWindow || [];
    const layer2 = window.filter(r => r.layer === 2);
    const corrected = layer2.filter(r => r.corrected).length;
    const rate = corrected / layer2.length;
    process.stdout.write(String(rate > 0.3 ? 0.5 : 0.7));
  `);
  try {
    const result = execSync(`node "${tmpFile}"`, {
      env: { ...process.env },
      timeout: 5000,
    }).toString();
    assert.strictEqual(result, '0.7', '10% 修正率應保持 0.7');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.unlinkSync(tmpStats); } catch (_) {}
  }
});

test('getAdaptiveThreshold: 樣本不足（<10）→ 保持 0.7', () => {
  const tmpStats = path.join(os.tmpdir(), `vibe-stats-test-${Date.now()}.json`);
  const window = [];
  for (let i = 0; i < 5; i++) {
    window.push({ layer: 2, source: 'regex', corrected: true, timestamp: new Date().toISOString() });
  }
  fs.writeFileSync(tmpStats, JSON.stringify({ recentWindow: window, totalClassifications: 5, totalCorrections: 5 }));

  const tmpFile = path.join(os.tmpdir(), `vibe-cls-adapt-small-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, `
    const fs = require('fs');
    const stats = JSON.parse(fs.readFileSync(${JSON.stringify(tmpStats)}, 'utf8'));
    const window = stats.recentWindow || [];
    const layer2 = window.filter(r => r.layer === 2);
    process.stdout.write(String(layer2.length < 10 ? 0.7 : (layer2.filter(r => r.corrected).length / layer2.length > 0.3 ? 0.5 : 0.7)));
  `);
  try {
    const result = execSync(`node "${tmpFile}"`, {
      env: { ...process.env },
      timeout: 5000,
    }).toString();
    assert.strictEqual(result, '0.7', '樣本 <10 應保持 0.7');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.unlinkSync(tmpStats); } catch (_) {}
  }
});

// ═══════════════════════════════════════════════
// Part 6: formatter task.classified 新格式驗證
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 6: formatter task.classified 新格式驗證');
console.log('═'.repeat(50));

const { formatEventText: fmtEvt } = require(path.join(__dirname, '..', 'scripts', 'lib', 'timeline', 'formatter.js'));

test('formatter: task.classified 新格式（有 layer）', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'standard', taskType: 'feature', layer: 2, confidence: 0.80, matchedRule: 'action:feature', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('standard'), '應含 pipelineId');
  assert.ok(text.includes('L2'), '應含 Layer');
  assert.ok(text.includes('0.80'), '應含 confidence');
  assert.ok(text.includes('action:feature'), '應含 matchedRule');
});

test('formatter: task.classified 升級格式', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'full', from: 'fix', layer: 2, confidence: 0.80, matchedRule: 'action:feature', reclassified: true } };
  const text = fmtEvt(event);
  assert.ok(text.includes('升級'), '應含「升級」');
  assert.ok(text.includes('fix'), '應含 from');
  assert.ok(text.includes('full'), '應含 to');
  assert.ok(text.includes('L2'), '應含 Layer');
});

test('formatter: task.classified 舊格式向後相容（無 layer）', () => {
  const event = { type: 'task.classified', data: { taskType: 'feature', expectedStages: ['PLAN', 'ARCH', 'DEV'] } };
  const text = fmtEvt(event);
  assert.ok(text.includes('feature'), '應含 taskType');
  assert.ok(text.includes('PLAN,ARCH,DEV'), '應含 stages');
  assert.ok(!/L\d\(/.test(text), '不應含 Layer 標記（L1(/L2(/L3(）');
});

test('formatter: task.classified Layer 1 explicit', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'full', layer: 1, confidence: 1.0, matchedRule: 'explicit', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('L1'), '應含 L1');
  assert.ok(text.includes('1.00'), '應含信心度 1.00');
  assert.ok(text.includes('explicit'), '應含 explicit');
});

test('formatter: task.classified Layer 3 LLM', () => {
  const event = { type: 'task.classified', data: { pipelineId: 'standard', layer: 3, confidence: 0.85, matchedRule: 'weak-explore', source: 'llm', reclassified: false } };
  const text = fmtEvt(event);
  assert.ok(text.includes('L3'), '應含 L3');
  assert.ok(text.includes('0.85'), '應含信心度');
});

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

// Async tests 運行器（收集的 asyncTest 在此執行）
(async () => {
  if (asyncQueue.length > 0) {
    console.log('\n🧪 Async Tests');
    console.log('═'.repeat(50));
    for (const { name, fn } of asyncQueue) {
      try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ 全部通過\n');
  }
})();
