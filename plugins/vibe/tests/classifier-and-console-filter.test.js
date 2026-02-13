#!/usr/bin/env node
/**
 * classifier-and-console-filter.test.js — 單元測試
 *
 * Part 1: task-classifier classify() 函數邏輯
 * Part 2: check-console-log 檔案過濾 regex
 *
 * 執行：bun test plugins/vibe/tests/classifier-and-console-filter.test.js
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

// ═══════════════════════════════════════════════
// Part 1: task-classifier classify() 函數
// ═══════════════════════════════════════════════

/**
 * 從 task-classifier.js 提取的分類邏輯（直接複製函式）
 */
function classify(prompt) {
  if (!prompt) return 'quickfix';
  const p = prompt.toLowerCase();

  // 研究型：問題、探索、理解
  if (/[?？]$|^(what|how|why|where|explain|show|list|find|search)\b|看看|查看|找找|說明|解釋|什麼|怎麼|為什麼|哪裡|告訴|描述|列出|做什麼|是什麼|有哪些|出問題|是不是/.test(p)) {
    return 'research';
  }
  // Trivial/Demo 任務：明確的簡單任務不需要完整 pipeline
  if (/hello.?world|boilerplate|scaffold|skeleton|poc|proof.?of.?concept|概念驗證|prototype|原型|試做|試作|簡單的?\s*(?:範例|demo|example|試試)|練習用|練習一下|tutorial|學習用|playground|scratch/.test(p)) {
    return 'quickfix';
  }
  // TDD：明確要求
  if (/tdd|test.?first|測試驅動|先寫測試/.test(p)) {
    return 'tdd';
  }
  // 純測試
  if (/^(write|add|create|fix).*test|^(寫|加|新增|修).*測試|^test\b/.test(p)) {
    return 'test';
  }
  // 重構
  if (/refactor|restructure|重構|重寫|重新設計|改架構/.test(p)) {
    return 'refactor';
  }
  // 功能開發：明確的功能建設意圖（正向匹配）
  if (/implement|develop|build.*feature|新增功能|建立.*(?:功能|api|rest|endpoint|server|service|database|服務|系統|模組|元件|頁面|app|應用|專案|component|module)|實作|開發.*功能|加入.*功能|新的.*(api|endpoint|component|頁面|模組|plugin)|整合.*系統/.test(p)) {
    return 'feature';
  }
  // 快速修復：簡單改動
  if (/fix.*typo|rename|change.*name|update.*text|改名|修.*typo|換.*名|改.*顏色|改.*文字/.test(p)) {
    return 'quickfix';
  }
  // Bug 修復
  if (/fix|bug|修(復|正)|debug|壞了|出錯|不work|不能/.test(p)) {
    return 'bugfix';
  }
  // 預設：quickfix（保守 — 僅 DEV 階段，不鎖定 pipeline 模式）
  return 'quickfix';
}

console.log('\n🧪 Part 1: task-classifier classify() 函數');
console.log('═'.repeat(50));

// ─── Trivial → quickfix ─────────────────────────

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

// ─── Feature → feature（不被 trivial 誤分類）─────────────────────────

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

// ─── Research ─────────────────────────

test('hello world 是什麼？ → research', () => {
  assert.strictEqual(classify('hello world 是什麼？'), 'research');
});

test('這個 server 怎麼用？ → research', () => {
  assert.strictEqual(classify('這個 server 怎麼用？'), 'research');
});

test('解釋 pipeline 架構 → research', () => {
  assert.strictEqual(classify('解釋 pipeline 架構'), 'research');
});

test('what is this function doing? → research', () => {
  assert.strictEqual(classify('what is this function doing?'), 'research');
});

test('查看現有的測試 → research', () => {
  assert.strictEqual(classify('查看現有的測試'), 'research');
});

test('說明一下這段程式碼 → research', () => {
  assert.strictEqual(classify('說明一下這段程式碼'), 'research');
});

// ─── Other types ─────────────────────────

test('修復登入失敗問題 → bugfix', () => {
  assert.strictEqual(classify('修復登入失敗問題'), 'bugfix');
});

test('重構認證模組 → refactor', () => {
  assert.strictEqual(classify('重構認證模組'), 'refactor');
});

test('寫測試 → test', () => {
  assert.strictEqual(classify('寫測試'), 'test');
});

test('tdd 開發流程 → tdd', () => {
  assert.strictEqual(classify('tdd 開發流程'), 'tdd');
});

test('改名 userId 為 user_id → quickfix', () => {
  assert.strictEqual(classify('改名 userId 為 user_id'), 'quickfix');
});

test('空字串 → quickfix', () => {
  assert.strictEqual(classify(''), 'quickfix');
});

test('做點什麼 → research（含「做什麼」關鍵字）', () => {
  assert.strictEqual(classify('做點什麼'), 'research');
});

test('隨便改改 → quickfix (default)', () => {
  assert.strictEqual(classify('隨便改改'), 'quickfix');
});

test('fix the broken button → bugfix', () => {
  assert.strictEqual(classify('fix the broken button'), 'bugfix');
});

test('測試驅動開發新功能 → tdd', () => {
  assert.strictEqual(classify('測試驅動開發新功能'), 'tdd');
});

test('add unit test for login → test', () => {
  assert.strictEqual(classify('add unit test for login'), 'test');
});

test('restructure the entire app → refactor', () => {
  assert.strictEqual(classify('restructure the entire app'), 'refactor');
});

// ─── 邊界案例和複合情境 ─────────────────────────

test('簡單試試看這個 API → quickfix（簡單的試試）', () => {
  assert.strictEqual(classify('簡單試試看這個 API'), 'quickfix');
});

test('建立簡單 demo 展示功能 → quickfix（demo 優先於功能）', () => {
  assert.strictEqual(classify('建立簡單 demo 展示功能'), 'quickfix');
});

test('開發新的使用者模組 → feature（開發+模組）', () => {
  assert.strictEqual(classify('開發新的使用者模組'), 'feature');
});

test('fix typo in variable name → quickfix（typo 修復）', () => {
  assert.strictEqual(classify('fix typo in variable name'), 'quickfix');
});

test('update button text → quickfix（更新文字）', () => {
  assert.strictEqual(classify('update button text'), 'quickfix');
});

test('create test for API endpoint → test（建立測試）', () => {
  assert.strictEqual(classify('create test for API endpoint'), 'test');
});

test('先寫測試再寫程式 → tdd（測試驅動）', () => {
  assert.strictEqual(classify('先寫測試再寫程式'), 'tdd');
});

test('重新設計整個架構 → refactor（重新設計）', () => {
  assert.strictEqual(classify('重新設計整個架構'), 'refactor');
});

test('建立完整的專案 → feature（完整專案）', () => {
  assert.strictEqual(classify('建立完整的專案'), 'feature');
});

test('有哪些可用的 hooks？ → research（列表查詢）', () => {
  assert.strictEqual(classify('有哪些可用的 hooks？'), 'research');
});

test('這段程式碼是不是有問題？ → research（是不是）', () => {
  assert.strictEqual(classify('這段程式碼是不是有問題？'), 'research');
});

// ═══════════════════════════════════════════════
// Part 2: check-console-log 檔案過濾邏輯
// ═══════════════════════════════════════════════

console.log('\n🧪 Part 2: check-console-log 檔案過濾邏輯');
console.log('═'.repeat(50));

/**
 * 從 check-console-log.js 提取的過濾邏輯（第 39 行）
 */
const filterFn = (f) => !/(^|\/)scripts\/hooks\//.test(f) && !/hook-logger\.js$/.test(f);

// ─── 應排除（filterFn 返回 false）─────────────────────────

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

// ─── 不應排除（filterFn 返回 true）─────────────────────────

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

/**
 * 執行 hook 腳本，回傳 { stdout, stderr, exitCode }
 */
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

// ─── auto-lint：未知語言靜默退出 ──────────────

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

// ─── auto-format：未知語言靜默退出 ─────────────

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
  // 不論 ruff 是否安裝，都不應崩潰
});

// ─── danger-guard：stdin 解析 + exit code 驗證 ──

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

// ─── check-console-log：stop_hook_active 防迴圈 ──

test('check-console-log：stop_hook_active=true → 靜默退出', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: true });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.stdout, '');
});

test('check-console-log：stop_hook_active=false → 正常執行（非 git 或無變更）', () => {
  const r = runSentinelHook('check-console-log', { stop_hook_active: false });
  assert.strictEqual(r.exitCode, 0);
  // 在測試環境中，git diff 可能無結果，所以靜默退出是正常的
});

// ─── auto-lint：有 lint 輸出時 JSON 格式驗證 ──

test('auto-lint：.ts 檔案 → stdout 為空或合法 JSON（systemMessage）', () => {
  const r = runSentinelHook('auto-lint', { tool_input: { file_path: '/tmp/nonexistent.ts' } });
  assert.strictEqual(r.exitCode, 0);
  if (r.stdout) {
    // 有輸出時必須是合法 JSON，且含 continue + systemMessage
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.continue, true, 'continue 應為 true');
    assert.ok(parsed.systemMessage, '應有 systemMessage');
  }
});

// ═══════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════

console.log('\n' + '='.repeat(50));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
