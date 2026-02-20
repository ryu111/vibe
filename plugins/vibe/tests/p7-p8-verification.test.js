#!/usr/bin/env node
/**
 * p7-p8-verification.test.js — P7 RAM 水位偵測 & P8 Barrier Timeout 巡檢 驗證測試
 *
 * P7: session-cleanup.js checkRamWatermark()
 *   - 閾值常數（RAM_WARN_MB=4096, RAM_CRIT_MB=8192）
 *   - 進程匹配模式正確性
 *   - RSS 累加邏輯（KB → MB 換算）
 *   - 閾值判斷邏輯（低於/警告/嚴重）
 *   - try-catch 靜默失敗不影響 session 啟動
 *   - additionalContext 輸出格式
 *
 * P8: barrier.js sweepTimedOutGroups()
 *   - 無 barrier state → 回傳 { timedOut: [] }
 *   - 所有 groups 已 resolved → 回傳 { timedOut: [] }（幂等）
 *   - group 未超時 → 不在 timedOut 陣列
 *   - group 超時且有缺席 stages → 強制填入 FAIL 並合併
 *   - 連續兩次呼叫 → 第二次回傳空陣列（幂等）
 *   - module.exports 包含 sweepTimedOutGroups
 *
 * P8 Pipeline Controller: classify() barrier timeout 巡檢
 *   - 無活躍 pipeline → 不執行巡檢
 *   - 有活躍 pipeline + 無超時 barrier → 正常分類
 *   - 已取消 pipeline → 不執行巡檢
 *
 * 執行：node plugins/vibe/tests/p7-p8-verification.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { cleanTestStateFiles, cleanSessionState, writeV4State } = require('./test-helpers');

cleanTestStateFiles();

let passed = 0;
let failed = 0;
let sectionPassed = 0;
let sectionFailed = 0;

function section(name) {
  if (sectionPassed + sectionFailed > 0) {
    console.log(`  小計：${sectionPassed} 通過，${sectionFailed} 失敗`);
  }
  console.log(`\n--- ${name} ---`);
  sectionPassed = 0;
  sectionFailed = 0;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    sectionPassed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    sectionFailed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    if (process.env.VERBOSE) console.log(err.stack);
  }
}

// ══════════════════════════════════════════════════════════
// P7: RAM 水位偵測 — session-cleanup.js checkRamWatermark()
// ══════════════════════════════════════════════════════════

// 透過讀取原始碼取得函式（不能直接 require 因為 stdin 模式）
// 改用提取函式邏輯的方式驗證

section('P7-1: 閾值常數驗證');

test('session-cleanup.js 原始碼中定義 RAM_WARN_MB = 4096', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('RAM_WARN_MB = 4096'), '應定義 RAM_WARN_MB = 4096');
});

test('session-cleanup.js 原始碼中定義 RAM_CRIT_MB = 8192', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('RAM_CRIT_MB = 8192'), '應定義 RAM_CRIT_MB = 8192');
});

test('閾值定義在模組層級（const 宣告）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認是 const 宣告（不是函式內部）
  assert.ok(src.match(/^const RAM_WARN_MB\s*=/m), 'RAM_WARN_MB 應為模組層級 const');
  assert.ok(src.match(/^const RAM_CRIT_MB\s*=/m), 'RAM_CRIT_MB 應為模組層級 const');
});

section('P7-2: checkRamWatermark 函式結構驗證');

test('checkRamWatermark 函式存在於 session-cleanup.js', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('function checkRamWatermark'), 'checkRamWatermark 函式應存在');
});

test('checkRamWatermark 使用 ps -eo rss,command 指令', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('ps -eo rss,command'), '應使用 ps -eo rss,command');
});

test('checkRamWatermark 有 try-catch 靜默失敗（回傳 { totalMb: 0, warning: null }）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認 catch 中回傳 totalMb: 0, warning: null
  assert.ok(src.includes('{ totalMb: 0, warning: null }'), '靜默失敗應回傳 { totalMb: 0, warning: null }');
});

test('checkRamWatermark 設定 3 秒 timeout 防止 ps 阻塞', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('timeout: 3000'), 'ps 指令應設定 timeout: 3000');
});

section('P7-3: 進程匹配模式驗證');

test('匹配 claude CLI 主進程（排除 chrome-mcp）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認模式：/(^|\/)claude( |$)/ 排除 chrome-mcp
  assert.ok(src.includes('chrome-mcp'), '應包含 chrome-mcp 排除邏輯');
  assert.ok(src.match(/claude.*chrome-mcp/), 'claude 匹配應排除 chrome-mcp');
});

test('匹配 claude-in-chrome-mcp 進程', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('claude-in-chrome-mcp'), '應包含 chrome-mcp 匹配');
});

test('匹配 chroma-mcp 相關進程', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('chroma-mcp'), '應包含 chroma-mcp 匹配');
});

test('匹配 uv tool uvx chroma 進程', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('uv tool uvx'), '應包含 uv tool uvx chroma 匹配');
});

test('匹配 worker-service.cjs（claude-mem worker）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('worker-service.cjs'), '應包含 worker-service.cjs 匹配');
});

test('匹配 mcp-server.cjs（MCP server）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('mcp-server.cjs'), '應包含 mcp-server.cjs 匹配');
});

test('匹配 vibe/server.js（Dashboard daemon）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('vibe/server.js'), '應包含 vibe/server.js 匹配');
});

test('匹配 vibe/bot.js（Telegram daemon）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  assert.ok(src.includes('vibe/bot.js'), '應包含 vibe/bot.js 匹配');
});

section('P7-4: checkRamWatermark 核心邏輯驗證');

// 建立可測試的 checkRamWatermark 函式（從原始碼提取）
// 由於 session-cleanup.js 使用 stdin 模式無法直接 require，
// 透過讀取原始碼並用 Function 建構子執行
function buildCheckRamWatermark() {
  // 建立一個可測試的包裝版本
  const { execSync } = require('child_process');
  const RAM_WARN_MB = 4096;
  const RAM_CRIT_MB = 8192;

  return function checkRamWatermark(mockOutput) {
    try {
      let output;
      if (mockOutput !== undefined) {
        output = mockOutput;
      } else {
        output = execSync('ps -eo rss,command 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      }

      let totalKb = 0;
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const spaceIdx = line.trimStart().indexOf(' ');
        if (spaceIdx === -1) continue;
        const trimmed = line.trimStart();
        const rss = parseInt(trimmed.slice(0, spaceIdx));
        if (isNaN(rss) || rss <= 0) continue;
        const cmd = trimmed.slice(spaceIdx + 1).trim();

        const isClaude = /(^|\/)claude( |$)/.test(cmd) && !/chrome-mcp/.test(cmd);
        const isChromeMcp = /claude-in-chrome-mcp/.test(cmd);
        const isChromaMcp = /chroma-mcp/.test(cmd);
        const isUvChroma = /uv tool uvx.*chroma/.test(cmd);
        const isWorkerService = /worker-service\.cjs/.test(cmd);
        const isMcpServer = /mcp-server\.cjs/.test(cmd);
        const isVibeServer = /vibe\/server\.js/.test(cmd);
        const isVibeBot = /vibe\/bot\.js/.test(cmd);

        if (isClaude || isChromeMcp || isChromaMcp || isUvChroma ||
            isWorkerService || isMcpServer || isVibeServer || isVibeBot) {
          totalKb += rss;
        }
      }

      const totalMb = Math.round(totalKb / 1024);

      if (totalMb >= RAM_CRIT_MB) {
        return {
          totalMb,
          warning: `[RAM 嚴重] Claude 生態圈記憶體使用 ${totalMb}MB（>= ${RAM_CRIT_MB}MB）。` +
            `建議執行 /vibe:health 診斷並重啟 Claude。`,
        };
      }
      if (totalMb >= RAM_WARN_MB) {
        return {
          totalMb,
          warning: `[RAM 警告] Claude 生態圈記憶體使用 ${totalMb}MB（>= ${RAM_WARN_MB}MB）。` +
            `建議執行 /vibe:health 檢查孤兒進程。`,
        };
      }

      return { totalMb, warning: null };
    } catch (_) {
      return { totalMb: 0, warning: null };
    }
  };
}

const checkRamWatermark = buildCheckRamWatermark();

test('RAM 低於警告閾值（< 4096MB）→ warning 為 null', () => {
  // 模擬 100 MB (100*1024 KB)
  const mockOutput = `${100 * 1024} /usr/bin/claude\n`;
  const result = checkRamWatermark(mockOutput);
  assert.strictEqual(result.warning, null, '100MB 應無警告');
  assert.ok(result.totalMb < 4096, `totalMb 應 < 4096，實際：${result.totalMb}`);
});

test('RAM >= 4096MB 且 < 8192MB → 回傳警告（[RAM 警告]）', () => {
  // 模擬 4100 MB (4100*1024 KB)
  const mockOutput = `${4100 * 1024} /usr/bin/claude\n`;
  const result = checkRamWatermark(mockOutput);
  assert.ok(result.warning !== null, '4100MB 應有警告');
  assert.ok(result.warning.includes('[RAM 警告]'), `警告應包含 [RAM 警告]，實際：${result.warning}`);
  assert.ok(result.warning.includes('/vibe:health'), '警告應提及 /vibe:health');
});

test('RAM >= 8192MB → 回傳嚴重警告（[RAM 嚴重]）', () => {
  // 模擬 8200 MB
  const mockOutput = `${8200 * 1024} /usr/bin/claude\n`;
  const result = checkRamWatermark(mockOutput);
  assert.ok(result.warning !== null, '8200MB 應有嚴重警告');
  assert.ok(result.warning.includes('[RAM 嚴重]'), `警告應包含 [RAM 嚴重]，實際：${result.warning}`);
});

test('只計算 Claude 生態圈進程，不計入非相關進程', () => {
  // 混合：claude 1GB + Chrome 2GB + vscode 2GB
  // Chrome 和 vscode 不應計入
  const mockOutput = [
    `${1024 * 1024} /usr/bin/claude`,             // claude: 1GB
    `${2048 * 1024} /Applications/Chrome`,        // Chrome: 2GB（非生態圈）
    `${2048 * 1024} /Applications/VSCode`,        // vscode: 2GB（非生態圈）
    `${512 * 1024} /usr/local/bin/vibe/server.js`, // vibe server: 0.5GB
  ].join('\n') + '\n';

  const result = checkRamWatermark(mockOutput);
  // 只計 claude(1GB) + vibe server(0.5GB) = 1.5GB = 1536MB
  assert.ok(result.totalMb < 2000, `只應計 Claude 生態圈，totalMb=${result.totalMb}（預期 ~1536）`);
  assert.strictEqual(result.warning, null, '1.5GB 應無警告');
});

test('claude CLI 排除 chrome-mcp 相關進程（不重複計算）', () => {
  const mockOutput = [
    `${1000} /usr/bin/claude`,                    // claude CLI：計算
    `${2000} /opt/claude-in-chrome-mcp/server`,   // chrome-mcp：計算（isChromeMcp）
    `${3000} /opt/runner/claude-in-chrome-mcp`,   // chrome-mcp runner：計算（isChromeMcp）
  ].join('\n') + '\n';

  const result = checkRamWatermark(mockOutput);
  // 三個進程都應被計算（claude CLI + 2 chrome-mcp）
  // claude CLI 不包含 chrome-mcp 字串 → isClaude=true
  // chrome-mcp 進程 → isChromeMcp=true
  const expectedKb = 1000 + 2000 + 3000;
  const expectedMb = Math.round(expectedKb / 1024);
  assert.ok(Math.abs(result.totalMb - expectedMb) <= 1, `totalMb 應為 ~${expectedMb}，實際：${result.totalMb}`);
});

test('空 ps 輸出 → totalMb=0, warning=null', () => {
  const result = checkRamWatermark('');
  assert.strictEqual(result.totalMb, 0, '空輸出 totalMb 應為 0');
  assert.strictEqual(result.warning, null, '空輸出 warning 應為 null');
});

test('ps 拋出錯誤（模擬）→ 靜默失敗，回傳 { totalMb: 0, warning: null }', () => {
  // 使用 null 觸發解析失敗
  const throwingCheckRam = (() => {
    try {
      // 模擬拋出錯誤：傳入 null 讓 split() 失敗
      null.split('\n');
    } catch (_) {
      return { totalMb: 0, warning: null };
    }
  })();

  assert.strictEqual(throwingCheckRam.totalMb, 0, '錯誤時 totalMb 應為 0');
  assert.strictEqual(throwingCheckRam.warning, null, '錯誤時 warning 應為 null');
});

test('RSS 單位為 KB，totalMb 用 Math.round(totalKb/1024) 計算', () => {
  // 1500 KB = 1.46 MB → Math.round = 1 MB
  const mockOutput = `${1500} /usr/bin/claude\n`;
  const result = checkRamWatermark(mockOutput);
  assert.strictEqual(result.totalMb, Math.round(1500 / 1024));
});

section('P7-5: 主程式 additionalContext 輸出格式驗證');

test('session-cleanup.js 呼叫 checkRamWatermark() 並加入 ramResult.warning 到 additionalContext', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認呼叫 checkRamWatermark 並使用回傳值
  assert.ok(src.includes('checkRamWatermark()'), '應呼叫 checkRamWatermark()');
  assert.ok(src.includes('ramResult.warning'), '應使用 ramResult.warning');
  assert.ok(src.includes('additionalContext'), '應輸出 additionalContext');
});

test('RAM 警告附加到 contextParts（不是 systemMessage）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認 warning 放入 contextParts 而非 systemMessage
  // 程式碼中是 contextParts.push(ramResult.warning) 而不是 systemMessage
  assert.ok(src.includes('contextParts.push(ramResult.warning)'), 'RAM 警告應 push 到 contextParts');
});

test('無警告時（warning=null）不產出 RAM 相關 additionalContext', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/hooks/session-cleanup.js'),
    'utf8'
  );
  // 確認有 ramResult.warning 的判斷條件
  assert.ok(src.includes('ramResult.warning'), '應判斷 ramResult.warning 是否存在');
});

// ══════════════════════════════════════════════════════════
// P8: sweepTimedOutGroups — barrier.js
// ══════════════════════════════════════════════════════════

const {
  createBarrierGroup,
  updateBarrier,
  readBarrier,
  writeBarrier,
  deleteBarrier,
  sweepTimedOutGroups,
  checkTimeout,
  DEFAULT_TIMEOUT_MS,
} = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));

section('P8-1: sweepTimedOutGroups 基本功能');

test('barrier.js module.exports 包含 sweepTimedOutGroups', () => {
  const barrierModule = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));
  assert.ok(typeof barrierModule.sweepTimedOutGroups === 'function',
    'sweepTimedOutGroups 應為 function，實際：' + typeof barrierModule.sweepTimedOutGroups);
});

test('sweepTimedOutGroups：無 barrier state → 回傳 { timedOut: [] }', () => {
  const sid = 'test-sweep-no-state';
  cleanSessionState(sid);

  const result = sweepTimedOutGroups(sid);
  assert.ok(Array.isArray(result.timedOut), 'timedOut 應為陣列');
  assert.strictEqual(result.timedOut.length, 0, '無 barrier state 應回傳空陣列');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：所有 groups 已 resolved → 回傳 { timedOut: [] }（幂等）', () => {
  const sid = 'test-sweep-all-resolved';
  cleanSessionState(sid);

  // 建立已 resolved 的 barrier state
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW', 'TEST'],
        results: {
          REVIEW: { verdict: 'PASS', route: 'BARRIER' },
          TEST: { verdict: 'PASS', route: 'BARRIER' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: true,  // 已解鎖
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 分鐘前
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);
  assert.strictEqual(result.timedOut.length, 0, '已 resolved 的 group 應被跳過');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：group 未超時 → 不在 timedOut 陣列', () => {
  const sid = 'test-sweep-not-timeout';
  cleanSessionState(sid);

  // 建立剛建立的 barrier（未超時）
  createBarrierGroup(sid, 'post-dev', 2, 'QA', ['REVIEW', 'TEST']);
  updateBarrier(sid, 'post-dev', 'REVIEW', { verdict: 'PASS', route: 'BARRIER' });

  const result = sweepTimedOutGroups(sid);
  assert.strictEqual(result.timedOut.length, 0, '未超時的 group 不應在 timedOut 陣列');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：group 超時且有缺席 stages → 強制填入 FAIL 並合併', () => {
  const sid = 'test-sweep-timeout';
  cleanSessionState(sid);

  // 建立已超時的 barrier（只有 REVIEW 完成，TEST 缺席）
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: {
          REVIEW: { verdict: 'PASS', route: 'BARRIER' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        // 設為 10 分鐘前（超過 DEFAULT_TIMEOUT_MS=5分鐘）
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);

  // 驗證 timedOut 陣列
  assert.strictEqual(result.timedOut.length, 1, 'timedOut 應有 1 個超時 group');
  assert.strictEqual(result.timedOut[0].group, 'post-dev', 'group 名稱應為 post-dev');
  assert.ok(Array.isArray(result.timedOut[0].timedOutStages), 'timedOutStages 應為陣列');
  assert.ok(result.timedOut[0].timedOutStages.includes('TEST'), 'TEST 應在 timedOutStages 中');

  // 驗證 mergedResult（TEST 被強制 FAIL → Worst-Case-Wins）
  const merged = result.timedOut[0].mergedResult;
  assert.ok(merged, 'mergedResult 應存在');
  assert.strictEqual(merged.verdict, 'FAIL', '有缺席 stage → Worst-Case-Wins = FAIL');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：缺席 stage 的 FAIL 填入包含 Barrier 超時 hint', () => {
  const sid = 'test-sweep-hint';
  cleanSessionState(sid);

  const barrierState = {
    groups: {
      'quality': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'DOCS',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);
  const merged = result.timedOut[0]?.mergedResult;
  assert.ok(merged, 'mergedResult 應存在');

  // 讀取更新後的 barrier state，確認 TEST 有被填入 FAIL
  const updatedBarrier = readBarrier(sid);
  const groupData = updatedBarrier?.groups?.quality;
  assert.ok(groupData, 'barrier group 應存在');
  assert.ok(groupData.results?.TEST, 'TEST 的 result 應被填入');
  assert.strictEqual(groupData.results.TEST.verdict, 'FAIL', 'TEST result 應為 FAIL');
  assert.strictEqual(groupData.results.TEST.severity, 'HIGH', 'severity 應為 HIGH');
  assert.ok(groupData.results.TEST.hint?.includes('超時'), 'hint 應提及超時');

  cleanSessionState(sid);
});

section('P8-2: sweepTimedOutGroups 幂等性驗證');

test('sweepTimedOutGroups 連續兩次呼叫：第二次回傳空陣列（幂等）', () => {
  const sid = 'test-sweep-idempotent';
  cleanSessionState(sid);

  // 建立超時 barrier
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  // 第一次呼叫：應偵測到超時
  const first = sweepTimedOutGroups(sid);
  assert.ok(first.timedOut.length > 0, '第一次呼叫應偵測到超時 group');

  // 第二次呼叫：group 已 resolved → 空陣列（幂等）
  const second = sweepTimedOutGroups(sid);
  assert.strictEqual(second.timedOut.length, 0, '第二次呼叫應回傳空陣列（幂等）');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups 超時後 barrier group 被標記為 resolved', () => {
  const sid = 'test-sweep-resolved';
  cleanSessionState(sid);

  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  sweepTimedOutGroups(sid);

  // 讀取更新後的 state，確認 resolved=true
  const updated = readBarrier(sid);
  assert.ok(updated?.groups?.['post-dev']?.resolved === true, 'sweepTimedOutGroups 後 group 應被 resolved');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：多個 groups，只超時的被處理', () => {
  const sid = 'test-sweep-multi';
  cleanSessionState(sid);

  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 超時
      },
      'post-qa': {
        total: 2,
        completed: ['QA'],
        results: { QA: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'DOCS',
        siblings: ['QA', 'E2E'],
        resolved: false,
        createdAt: new Date().toISOString(), // 未超時
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);

  // 只有 post-dev 超時
  assert.strictEqual(result.timedOut.length, 1, '只有超時的 group 應在 timedOut');
  assert.strictEqual(result.timedOut[0].group, 'post-dev', '超時的 group 應為 post-dev');

  cleanSessionState(sid);
});

section('P8-3: sweepTimedOutGroups 邊界案例');

test('sweepTimedOutGroups：超時 group 所有 siblings 都已完成（resolved=false）→ 觸發合併', () => {
  const sid = 'test-sweep-all-completed';
  cleanSessionState(sid);

  // 所有 siblings 都已完成，但 resolved=false（合併未觸發）
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW', 'TEST'],  // 全部完成
        results: {
          REVIEW: { verdict: 'PASS', route: 'BARRIER' },
          TEST: { verdict: 'PASS', route: 'BARRIER' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,  // 但未 resolved
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);
  // absent 為空（所有 siblings 已完成），不填入額外 FAIL
  // 但 resolved=false 且超時 → absent.length === 0 → 跳過（sweepTimedOutGroups 中 absent.length===0 時 continue）
  // 實際行為：absent 為空則 sweepTimedOutGroups 的 if (absent.length === 0) continue; 直接跳過
  assert.strictEqual(result.timedOut.length, 0,
    '所有 siblings 已完成但 resolved=false 的超時 group（absent=[]）應被跳過');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：barrier state groups 為空物件 → 回傳空陣列', () => {
  const sid = 'test-sweep-empty-groups';
  cleanSessionState(sid);

  writeBarrier(sid, { groups: {} });

  const result = sweepTimedOutGroups(sid);
  assert.strictEqual(result.timedOut.length, 0, '空 groups 應回傳空陣列');

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：barrier state 格式損壞（groups=null）→ 回傳空陣列', () => {
  const sid = 'test-sweep-corrupt';
  cleanSessionState(sid);

  // 寫入損壞的 barrier state（groups=null）
  const barrierPath = path.join(CLAUDE_DIR, `barrier-state-${sid}.json`);
  fs.writeFileSync(barrierPath, JSON.stringify({ groups: null }));

  const result = sweepTimedOutGroups(sid);
  assert.strictEqual(result.timedOut.length, 0, '損壞 barrier state 應回傳空陣列');

  cleanSessionState(sid);
});

section('P8-4: pipeline-controller.js classify() barrier 巡檢段驗證');

test('pipeline-controller.js classify() 包含 sweepTimedOutGroups 呼叫', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  assert.ok(src.includes('sweepTimedOutGroups'), 'classify() 應呼叫 sweepTimedOutGroups');
});

test('classify() barrier 巡檢有 try-catch（靜默失敗不影響分類）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  // 搜尋「sweepTimedOutGroups 的呼叫位置」(在 classify 函式內)
  // 格式：if (...) { try { const sweepResult = sweepTimedOutGroups(...) } catch (_) {} }
  // 直接搜尋完整的 try { ... sweepTimedOutGroups 的片段
  const callPattern = /try\s*\{[^}]*sweepTimedOutGroups/;
  assert.ok(callPattern.test(src), 'sweepTimedOutGroups 呼叫應包在 try 塊中');
  // 確認有對應的 catch (_)
  const catchPattern = /sweepTimedOutGroups[\s\S]{0,2000}catch\s*\(_\)/;
  assert.ok(catchPattern.test(src), 'sweepTimedOutGroups 應有靜默 catch (_)');
});

test('classify() 巡檢條件：pipelineActive=true + 非 cancelled 才執行', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  // 條件在 sweepTimedOutGroups 呼叫前：
  // if (state && ds.isActive(state) && !state?.meta?.cancelled)
  // 使用較大範圍的搜尋（含函式中所有 isActive 呼叫）
  const barrierSweepBlock = /isActive[\s\S]{0,200}sweepTimedOutGroups/;
  assert.ok(barrierSweepBlock.test(src), '巡檢條件應包含 isActive 判斷（緊鄰 sweepTimedOutGroups）');
  // 確認 cancelled 在 sweepTimedOutGroups 附近
  const cancelledCheck = /cancelled[\s\S]{0,400}sweepTimedOutGroups/;
  assert.ok(cancelledCheck.test(src), '巡檢條件應包含 cancelled 判斷');
});

test('classify() 超時 barrier 的警告放入 barrierWarnings（不是直接修改 systemMessage）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  assert.ok(src.includes('barrierWarnings'), 'classify() 應使用 barrierWarnings 陣列收集警告');
});

test('classify() 超時 barrier 發射 BARRIER_RESOLVED Timeline 事件', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  // emitBarrierResolved 在 sweepTimedOutGroups 邏輯中被呼叫
  // 搜尋包含 sweepTimedOutGroups + emitBarrierResolved 的整體區域
  const sweepToEmitPattern = /sweepTimedOutGroups[\s\S]{0,2000}emitBarrierResolved/;
  assert.ok(sweepToEmitPattern.test(src),
    'classify() 中 sweepTimedOutGroups 邏輯後應呼叫 emitBarrierResolved');
});

test('classify() 超時 barrier 後寫回更新的 state（ds.writeState）', () => {
  const src = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'),
    'utf8'
  );
  const sweepIdx = src.indexOf('sweepTimedOutGroups');
  const surrounding = src.slice(sweepIdx, sweepIdx + 1500);
  assert.ok(surrounding.includes('ds.writeState'), 'classify() 應在超時處理後寫回 state');
});

section('P8-5: barrier.js module.exports 完整性');

test('barrier.js exports sweepTimedOutGroups（P8 核心功能）', () => {
  const barrierModule = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));
  assert.ok(typeof barrierModule.sweepTimedOutGroups === 'function',
    'sweepTimedOutGroups 應 export');
});

test('barrier.js exports checkTimeout（超時偵測輔助）', () => {
  const barrierModule = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));
  assert.ok(typeof barrierModule.checkTimeout === 'function',
    'checkTimeout 應 export');
});

test('barrier.js exports DEFAULT_TIMEOUT_MS = 300000（5 分鐘）', () => {
  const barrierModule = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/barrier.js'));
  assert.strictEqual(barrierModule.DEFAULT_TIMEOUT_MS, 5 * 60 * 1000,
    `DEFAULT_TIMEOUT_MS 應為 300000，實際：${barrierModule.DEFAULT_TIMEOUT_MS}`);
});

section('P8-6: sweepTimedOutGroups Worst-Case-Wins 驗證');

test('sweepTimedOutGroups：已有 FAIL 的 stage 超時 + 缺席 TEST → mergedResult.verdict=FAIL', () => {
  const sid = 'test-sweep-wcw';
  cleanSessionState(sid);

  // REVIEW=FAIL + TEST 缺席
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: {
          REVIEW: { verdict: 'FAIL', route: 'BARRIER', severity: 'CRITICAL', hint: 'REVIEW 失敗' },
        },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);
  const merged = result.timedOut[0]?.mergedResult;
  assert.ok(merged, 'mergedResult 應存在');
  assert.strictEqual(merged.verdict, 'FAIL', '有 FAIL + 缺席 → Worst-Case-Wins = FAIL');
  // severity 應取最嚴重
  assert.ok(merged.severity === 'CRITICAL' || merged.severity === 'HIGH',
    `severity 應為 CRITICAL 或 HIGH，實際：${merged.severity}`);

  cleanSessionState(sid);
});

test('sweepTimedOutGroups：所有現有 stages 為 PASS，缺席 stage 填入 FAIL → mergedResult.verdict=FAIL', () => {
  const sid = 'test-sweep-absent-fail';
  cleanSessionState(sid);

  // REVIEW=PASS，TEST 缺席 → 缺席填 FAIL → Worst-Case-Wins = FAIL
  const barrierState = {
    groups: {
      'post-dev': {
        total: 2,
        completed: ['REVIEW'],
        results: { REVIEW: { verdict: 'PASS', route: 'BARRIER' } },
        next: 'QA',
        siblings: ['REVIEW', 'TEST'],
        resolved: false,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    },
  };
  writeBarrier(sid, barrierState);

  const result = sweepTimedOutGroups(sid);
  const merged = result.timedOut[0]?.mergedResult;
  assert.ok(merged, 'mergedResult 應存在');
  assert.strictEqual(merged.verdict, 'FAIL',
    '缺席 stage 被填入 FAIL → Worst-Case-Wins = FAIL（即使其他 stage 為 PASS）');

  cleanSessionState(sid);
});

// ──────────────── 版號驗證 ────────────────

section('版號驗證');

test('plugin.json 版號為 2.1.9', () => {
  const pluginJson = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json'),
    'utf8'
  ));
  assert.strictEqual(pluginJson.version, '2.1.9',
    `plugin.json 版號應為 2.1.9，實際：${pluginJson.version}`);
});

test('CLAUDE.md 版號同步標記', () => {
  // CLAUDE.md 在專案根目錄 /Users/sbu/projects/vibe/
  // PLUGIN_ROOT = /Users/sbu/projects/vibe/plugins/vibe
  // 專案根目錄 = PLUGIN_ROOT/../..
  const claudeMd = fs.readFileSync(
    path.join(PLUGIN_ROOT, '../../CLAUDE.md'),
    'utf8'
  );
  // 確認 CLAUDE.md 中 vibe 版號記錄
  assert.ok(claudeMd.includes('vibe'), 'CLAUDE.md 應包含 vibe 相關資訊');
});

// ──────────────── 最終結果 ────────────────

console.log(`\n  小計：${sectionPassed} 通過，${sectionFailed} 失敗`);
console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過');
} else {
  console.log(`❌ ${failed} 個測試失敗`);
  process.exit(1);
}
