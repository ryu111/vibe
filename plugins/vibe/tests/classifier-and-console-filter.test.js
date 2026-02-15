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

test('Layer 2: 預設 quickfix → fix, 0.7', () => {
  const result = classifyWithConfidence('隨便改改');
  assert.strictEqual(result.pipeline, 'fix');
  assert.strictEqual(result.confidence, 0.7);
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

const { classifyWithLLM, buildPipelineCatalogHint } = require(path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'classifier.js'));

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

const { execSync } = require('child_process');
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

test('auto-lint：.xyz 檔案 → 靜默退出（exit 0, 無 stdout）', () => {
  const r = runSentinelHook('auto-lint', { tool_input: { file_path: '/tmp/test.xyz' } });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('auto-lint：無 file_path → 靜默退出', () => {
  const r = runSentinelHook('auto-lint', { tool_input: {} });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('auto-lint：linter=null 語言（.json）→ 靜默退出', () => {
  const r = runSentinelHook('auto-lint', { tool_input: { file_path: '/tmp/test.json' } });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('auto-format：.xyz 檔案 → 靜默退出', () => {
  const r = runSentinelHook('auto-format', { tool_input: { file_path: '/tmp/test.xyz' } });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('auto-format：無 file_path → 靜默退出', () => {
  const r = runSentinelHook('auto-format', { tool_input: {} });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('auto-format：input.file_path 備選路徑（.py）→ 不崩潰', () => {
  const r = runSentinelHook('auto-format', { input: { file_path: '/tmp/test.py' } });
  assert.strictEqual(r.exitCode, 0);
});

test('danger-guard：安全指令 → exit 0', () => {
  const r = runSentinelHook('danger-guard', { tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stderr, '');
});

test('danger-guard：空指令 → exit 0', () => {
  const r = runSentinelHook('danger-guard', { tool_input: { command: '' } });
  assert.strictEqual(r.exitCode, 0);
});

test('danger-guard：無 command 欄位 → exit 0', () => {
  const r = runSentinelHook('danger-guard', { tool_input: {} });
  assert.strictEqual(r.exitCode, 0);
});

test('danger-guard：chmod 777 → exit 2 + stderr', () => {
  const r = runSentinelHook('danger-guard', { tool_input: { command: 'chmod 777 /etc/passwd' } });
  assert.strictEqual(r.exitCode, 2);
  assert.ok(r.stderr.includes('danger-guard'), 'stderr 應包含 danger-guard 標識');
  assert.ok(r.stderr.includes('chmod 777'), 'stderr 應包含攔截原因');
});

test('danger-guard：DROP TABLE → exit 2 + stderr', () => {
  const r = runSentinelHook('danger-guard', { tool_input: { command: 'DROP TABLE users' } });
  assert.strictEqual(r.exitCode, 2);
  assert.ok(r.stderr.includes('DROP TABLE'));
});

test('danger-guard：input.command 備選路徑 → 正常處理', () => {
  const r = runSentinelHook('danger-guard', { input: { command: 'npm install' } });
  assert.strictEqual(r.exitCode, 0);
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

test('auto-lint：.ts 檔案 → stdout 為空或合法 JSON', () => {
  const r = runSentinelHook('auto-lint', { tool_input: { file_path: '/tmp/nonexistent.ts' } });
  assert.strictEqual(r.exitCode, 0);
  if (r.stdout) {
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.continue, true, 'continue 應為 true');
    assert.ok(parsed.systemMessage, '應有 systemMessage');
  }
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
