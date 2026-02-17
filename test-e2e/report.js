#!/usr/bin/env node
/**
 * report.js — Pipeline E2E 測試報告產生器
 *
 * 匯總 results/ 目錄下的 JSON 結果，產出終端彩色表格。
 *
 * 用法：node report.js [resultsDir]
 *   預設 resultsDir = test-e2e/results/latest/
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ────────────────── ANSI 顏色 ──────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

// ────────────────── 結果目錄解析 ──────────────────

const resultsDir = process.argv[2] || path.join(__dirname, 'results', 'latest');

if (!fs.existsSync(resultsDir)) {
  console.error(`${C.red}結果目錄不存在: ${resultsDir}${C.reset}`);
  process.exit(1);
}

// 讀取所有 JSON 結果檔案
const resultFiles = fs.readdirSync(resultsDir)
  .filter(f => f.endsWith('.json') && f !== 'summary.json')
  .sort();

if (resultFiles.length === 0) {
  console.error(`${C.yellow}結果目錄為空: ${resultsDir}${C.reset}`);
  process.exit(0);
}

const results = resultFiles.map(f => {
  try {
    return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
  } catch {
    return null;
  }
}).filter(Boolean);

// ────────────────── 分類統計 ──────────────────

const CATEGORY_LABELS = {
  A: 'Pipeline 正路徑',
  B: '自然語言分類',
  C: '回復路徑',
  D: '環境適配',
};

const categories = {};
for (const r of results) {
  const cat = r.category || 'unknown';
  if (!categories[cat]) {
    categories[cat] = { total: 0, passed: 0, failed: [], timedOut: [] };
  }
  categories[cat].total++;
  if (r.status === '通過' || r.status === 'PASS') {
    categories[cat].passed++;
  } else if (r.status === '逾時' || r.status === 'TIMEOUT') {
    categories[cat].timedOut.push(r);
  } else {
    categories[cat].failed.push(r);
  }
}

const totalScenarios = results.length;
const totalPassed = results.filter(r => r.status === '通過' || r.status === 'PASS').length;
const totalFailed = results.filter(r => r.status === '失敗' || r.status === 'FAIL').length;
const totalTimeout = results.filter(r => r.status === '逾時' || r.status === 'TIMEOUT').length;

// ────────────────── 計算耗時 ──────────────────

let totalDuration = 0;
for (const r of results) {
  if (r.duration) totalDuration += r.duration;
}
const durationMin = Math.round(totalDuration / 60);

// ────────────────── 輸出報告 ──────────────────

const W = 52; // 表格寬度
const line = '═'.repeat(W);
const thinLine = '─'.repeat(W);

console.log('');
console.log(`${C.cyan}╔${line}╗${C.reset}`);
console.log(`${C.cyan}║${C.bold}  Pipeline E2E 測試報告${C.reset}${C.cyan}${' '.repeat(W - 22)}║${C.reset}`);

// 時間戳
const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
const tsLine = `  ${ts}`;
console.log(`${C.cyan}║${C.dim}${tsLine}${' '.repeat(W - tsLine.length)}${C.reset}${C.cyan}║${C.reset}`);

console.log(`${C.cyan}╠${line}╣${C.reset}`);

// 各分類統計
for (const cat of ['A', 'B', 'C', 'D']) {
  const data = categories[cat];
  if (!data) continue;

  const label = CATEGORY_LABELS[cat] || cat;
  const passStr = `${data.passed}/${data.total}`;
  const statusStr = data.passed === data.total
    ? `${C.green}通過${C.reset}`
    : `${C.red}通過${C.reset}`;

  const failNames = [...data.failed, ...data.timedOut].map(r => r.scenarioId).join(', ');
  const failSuffix = failNames ? `  ${C.dim}(${failNames})${C.reset}` : '';

  const statusIcon = data.passed === data.total ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;

  const content = `  ${cat}. ${label}:  ${passStr} ${statusIcon}${failSuffix}`;
  // 計算不含 ANSI 的實際長度
  const plainContent = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, W - plainContent.length);

  console.log(`${C.cyan}║${C.reset}${content}${' '.repeat(pad)}${C.cyan}║${C.reset}`);
}

console.log(`${C.cyan}╠${line}╣${C.reset}`);

// 總計
const passRate = totalScenarios > 0 ? Math.round((totalPassed / totalScenarios) * 100) : 0;
const passColor = passRate === 100 ? C.green : passRate >= 80 ? C.yellow : C.red;

const summaryLine = `  總計: ${totalPassed}/${totalScenarios} 通過  (${passRate}%)`;
const durationSuffix = durationMin > 0 ? `  耗時 ${durationMin}m` : '';
const summaryFull = summaryLine + durationSuffix;
const summaryPad = Math.max(0, W - summaryFull.length);

console.log(`${C.cyan}║${C.reset}${passColor}${C.bold}${summaryFull}${C.reset}${' '.repeat(summaryPad)}${C.cyan}║${C.reset}`);

console.log(`${C.cyan}╚${line}╝${C.reset}`);

// ────────────────── 失敗詳情 ──────────────────

const allFailed = results.filter(r => r.status !== '通過' && r.status !== 'PASS');
if (allFailed.length > 0) {
  console.log('');
  console.log(`${C.red}${C.bold}失敗詳情：${C.reset}`);

  for (const r of allFailed) {
    if (r.status === '逾時') {
      console.log(`  ${C.yellow}${r.scenarioId}${C.reset}: 逾時 (${r.timeout || '?'}s) — 閒置超過時限`);
      continue;
    }

    const failedChecks = (r.checks || []).filter(c => !c.passed && c.required);
    if (failedChecks.length > 0) {
      for (const fc of failedChecks) {
        const detail = fc.error ? ` — ${fc.error}` : '';
        // 嘗試取得實際值
        let actualHint = '';
        if (fc.name === 'pipelineId' && r.state) {
          actualHint = ` (實際=${r.state.pipelineId})`;
        } else if (fc.name === 'phase' && r.state) {
          actualHint = ` (實際=${r.state.phase})`;
        } else if (fc.name === 'stageCount' && r.state) {
          const actual = r.state.expectedStages ? r.state.expectedStages.length : '?';
          actualHint = ` (實際=${actual})`;
        }
        console.log(`  ${C.red}${r.scenarioId}${C.reset}: ${fc.name} 失敗${actualHint}${detail}`);
      }
    } else {
      console.log(`  ${C.red}${r.scenarioId}${C.reset}: ${r.status}`);
    }
  }
}

// ────────────────── 警告（非必要檢查失敗）──────────────────

const withWarnings = results.filter(r =>
  r.checks && r.checks.some(c => !c.passed && !c.required)
);
if (withWarnings.length > 0) {
  console.log('');
  console.log(`${C.yellow}${C.bold}警告：${C.reset}`);

  for (const r of withWarnings) {
    const warnChecks = r.checks.filter(c => !c.passed && !c.required);
    for (const wc of warnChecks) {
      console.log(`  ${C.yellow}${r.scenarioId}${C.reset}: ${wc.name} (非必要)${wc.error ? ` — ${wc.error}` : ''}`);
    }
  }
}

console.log('');

// ────────────────── 產出 summary.json ──────────────────

const summary = {
  timestamp: now.toISOString(),
  resultsDir,
  totalScenarios,
  passed: totalPassed,
  failed: totalFailed,
  timedOut: totalTimeout,
  passRate,
  durationSeconds: totalDuration,
  categories: Object.fromEntries(
    Object.entries(categories).map(([cat, data]) => [
      cat,
      {
        label: CATEGORY_LABELS[cat],
        total: data.total,
        passed: data.passed,
        failed: data.failed.map(r => r.scenarioId),
        timedOut: data.timedOut.map(r => r.scenarioId),
      },
    ])
  ),
  scenarios: results.map(r => ({
    id: r.scenarioId,
    name: r.scenarioName,
    status: r.status,
    duration: r.duration || null,
    checks: r.summary,
  })),
};

const summaryPath = path.join(resultsDir, 'summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`${C.dim}摘要寫入: ${summaryPath}${C.reset}`);

// exit code
process.exit(totalFailed + totalTimeout > 0 ? 1 : 0);
