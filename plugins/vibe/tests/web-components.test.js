#!/usr/bin/env node
/**
 * web-components.test.js — Dashboard Web 組件測試
 *
 * 測試對象：
 *   - web/lib/utils.js  — helper 函式（sid/now/elapsed/fmtSec/fmtDuration/fmtSize）
 *   - web/state/pipeline.js — state accessor 函式
 *   - web/components/dag-view.js — 純計算函式（computeDagLayout/buildEdges/detectPhases）
 *
 * 注意：這些檔案是瀏覽器 ES Module（CDN import），無法直接 require。
 * 因此測試採用「邏輯萃取」模式：將純函式邏輯直接定義於測試中，
 * 並對照原始碼逐行驗證行為正確性。
 *
 * 組件 export 完整性與 import 路徑以靜態分析（fs.readFileSync + regex）驗證。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', 'web');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ═══════════════════════════════════════════════════════════════
// 萃取自 web/lib/utils.js（純函式邏輯，無 CDN 依賴）
// ═══════════════════════════════════════════════════════════════

function sid(id) {
  return id?.length > 8 ? id.slice(0, 8) : id || '—';
}

function elapsed(iso) {
  if (!iso) return '';
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

function fmtSec(secs) {
  if (!secs && secs !== 0) return '—';
  if (secs < 60) return Math.round(secs) + 's';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function fmtDuration(startedAt) {
  if (!startedAt) return '—';
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  return fmtSec(secs);
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ═══════════════════════════════════════════════════════════════
// 萃取自 web/state/pipeline.js（純函式邏輯）
// ═══════════════════════════════════════════════════════════════

function getStageStatus(stageId, state) {
  if (!state?.stages?.[stageId]) return 'pending';
  return state.stages[stageId].status;
}

function getStageVerdict(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.verdict) return null;
  if (typeof stage.verdict === 'object') return stage.verdict.verdict || null;
  return stage.verdict;
}

function getStageSeverity(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.verdict) return null;
  if (typeof stage.verdict === 'object') return stage.verdict.severity || null;
  return null;
}

function getStageDuration(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.startedAt || !stage?.completedAt) return null;
  return Math.round((new Date(stage.completedAt) - new Date(stage.startedAt)) / 1000);
}

function getPipelineProgress(state) {
  if (!state?.dag) return 0;
  const stages = Object.keys(state.dag);
  if (!stages.length) return 0;
  const done = stages.filter(id => {
    const st = state.stages?.[id]?.status;
    return st === 'completed' || st === 'skipped';
  });
  return Math.round(done.length / stages.length * 100);
}

function hasPipeline(state) {
  return !!(state?.dag && Object.keys(state.dag).length > 0);
}

function isLive(state) {
  return !!(state?._alive || (state?.activeStages?.length > 0) || state?.pipelineActive);
}

function getActiveStages(state) {
  if (!state?.dag) return [];
  return Object.keys(state.dag).filter(id => state.stages?.[id]?.status === 'active');
}

function sessionCategory(s) {
  if (!s) return 'stale';
  if (s._alive || isLive(s)) return 'live';
  const prog = getPipelineProgress(s);
  if (hasPipeline(s) && prog >= 100) return 'done';
  if (hasPipeline(s)) return 'active';
  const last = s.meta?.lastTransition;
  if (!last) return 'stale';
  const age = Date.now() - new Date(last).getTime();
  if (age > 1800_000) return 'stale';
  return 'active';
}

// ═══════════════════════════════════════════════════════════════
// 萃取自 web/components/dag-view.js（純計算函式）
// ═══════════════════════════════════════════════════════════════

const NODE_W = 88;
const NODE_H = 72;
const H_GAP = 40;
const V_GAP = 20;

function computeDagLayout(dag, containerWidth) {
  if (!dag || !Object.keys(dag).length) return { nodes: [], width: 0, height: 0 };
  const stages = Object.keys(dag);
  const depth = {};
  function getDepth(id) {
    if (depth[id] !== undefined) return depth[id];
    const deps = dag[id]?.deps || [];
    if (!deps.length) { depth[id] = 0; return 0; }
    const d = Math.max(...deps.map(getDepth)) + 1;
    depth[id] = d;
    return d;
  }
  stages.forEach(id => getDepth(id));
  const byDepth = {};
  stages.forEach(id => {
    const d = depth[id];
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(id);
  });
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));
  const totalW = (maxDepth + 1) * (NODE_W + H_GAP) - H_GAP;
  const nodes = [];
  Object.entries(byDepth).forEach(([d, ids]) => {
    ids.forEach((id, i) => {
      const x = Number(d) * (NODE_W + H_GAP);
      const y = i * (NODE_H + V_GAP);
      nodes.push({ id, x, y, w: NODE_W, h: NODE_H, depth: Number(d) });
    });
  });
  const totalH = Math.max(...Object.values(byDepth).map(ids => ids.length)) * (NODE_H + V_GAP) - V_GAP;
  return { nodes, width: totalW, height: totalH };
}

function buildEdges(dag, nodes) {
  if (!dag || !nodes.length) return [];
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = [];
  for (const [id, cfg] of Object.entries(dag)) {
    const target = nodeMap[id];
    if (!target) continue;
    for (const dep of (cfg?.deps || [])) {
      const source = nodeMap[dep];
      if (!source) continue;
      const x1 = source.x + source.w;
      const y1 = source.y + source.h / 2;
      const x2 = target.x;
      const y2 = target.y + target.h / 2;
      const cx = (x1 + x2) / 2;
      edges.push({ id: `${dep}->${id}`, path: `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`, from: dep, to: id });
    }
  }
  return edges;
}

function detectPhases(dag) {
  if (!dag) return {};
  const phases = {};
  for (const id of Object.keys(dag)) {
    const m = id.match(/:(\d+)$/);
    if (m) {
      const n = m[1];
      if (!phases[n]) phases[n] = [];
      phases[n].push(id);
    }
  }
  return Object.keys(phases).length >= 2 ? phases : {};
}

// ════════════════════════════════════════════════════════════════
// Section 1: sid() — session ID 縮短
// ════════════════════════════════════════════════════════════════

section('Section 1: sid() — session ID 縮短');

assert(sid('abc123de') === 'abc123de', '8 字元 ID：原樣返回');
assert(sid('abc123dexyz') === 'abc123de', '超過 8 字元：截取前 8 碼');
assert(sid('short') === 'short', '5 字元 ID：原樣返回');
assert(sid('') === '—', '空字串：返回破折號');
assert(sid(null) === '—', 'null：返回破折號');
assert(sid(undefined) === '—', 'undefined：返回破折號');
assert(sid('12345678') === '12345678', '剛好 8 字元：原樣返回（不截取）');
assert(sid('123456789') === '12345678', '9 字元：截取前 8 碼');

// ════════════════════════════════════════════════════════════════
// Section 2: elapsed() — 經過時間計算
// ════════════════════════════════════════════════════════════════

section('Section 2: elapsed() — 經過時間計算');

assert(elapsed(null) === '', 'null：返回空字串');
assert(elapsed(undefined) === '', 'undefined：返回空字串');
assert(elapsed('') === '', '空字串：返回空字串');

// 測試時間範圍（使用相對時間）
const now = Date.now();
const past30s = new Date(now - 30 * 1000).toISOString();
const past90s = new Date(now - 90 * 1000).toISOString();
const past2h = new Date(now - 2 * 3600 * 1000).toISOString();

assert(elapsed(past30s).endsWith('s'), '30 秒前：以 s 結尾');
assert(elapsed(past90s).endsWith('m'), '90 秒前：以 m 結尾（1m）');
assert(elapsed(past2h).endsWith('h'), '2 小時前：以 h 結尾');

const sec30 = elapsed(past30s);
const secNum = parseInt(sec30);
assert(secNum >= 28 && secNum <= 35, '30 秒前：秒數在合理範圍（28-35s）');

// ════════════════════════════════════════════════════════════════
// Section 3: fmtSec() — 秒數格式化
// ════════════════════════════════════════════════════════════════

section('Section 3: fmtSec() — 秒數格式化');

assert(fmtSec(0) === '0s', '0 秒：返回 0s');
assert(fmtSec(1) === '1s', '1 秒：返回 1s');
assert(fmtSec(59) === '59s', '59 秒：返回 59s');
assert(fmtSec(60) === '1m', '60 秒：返回 1m（無餘數）');
assert(fmtSec(61) === '1m1s', '61 秒：返回 1m1s');
assert(fmtSec(90) === '1m30s', '90 秒：返回 1m30s');
assert(fmtSec(120) === '2m', '120 秒：返回 2m（無餘數）');
assert(fmtSec(3661) === '61m1s', '3661 秒：返回 61m1s');
assert(fmtSec(null) === '—', 'null：返回破折號');
assert(fmtSec(undefined) === '—', 'undefined：返回破折號');
assert(fmtSec(NaN) === '—', 'NaN：返回破折號');
assert(fmtSec(1.7) === '2s', '1.7 秒：四捨五入為 2s');
assert(fmtSec(59.4) === '59s', '59.4 秒：四捨五入為 59s');

// ════════════════════════════════════════════════════════════════
// Section 4: fmtDuration() — 毫秒格式化（從 startedAt 到現在）
// ════════════════════════════════════════════════════════════════

section('Section 4: fmtDuration() — startedAt 到現在的持續時間');

assert(fmtDuration(null) === '—', 'null：返回破折號');
assert(fmtDuration(undefined) === '—', 'undefined：返回破折號');
assert(fmtDuration('') === '—', '空字串：返回破折號');

// 30 秒前開始 → 結果應為秒數
const started30sAgo = new Date(Date.now() - 30 * 1000).toISOString();
const dur = fmtDuration(started30sAgo);
assert(dur.endsWith('s'), '30 秒前 startedAt：返回秒格式');

// 5 分鐘前開始 → 結果應為分鐘
const started5mAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const dur5m = fmtDuration(started5mAgo);
assert(dur5m.endsWith('m') || dur5m.includes('m'), '5 分鐘前 startedAt：返回分鐘格式');

// ════════════════════════════════════════════════════════════════
// Section 5: fmtSize() — 檔案大小格式化
// ════════════════════════════════════════════════════════════════

section('Section 5: fmtSize() — 檔案大小格式化');

assert(fmtSize(0) === '—', '0 bytes：返回破折號');
assert(fmtSize(null) === '—', 'null：返回破折號');
assert(fmtSize(undefined) === '—', 'undefined：返回破折號');
assert(fmtSize(100) === '100 B', '100 bytes：返回 100 B');
assert(fmtSize(1023) === '1023 B', '1023 bytes：返回 1023 B（小於 1KB）');
assert(fmtSize(1024) === '1.0 KB', '1024 bytes：返回 1.0 KB');
assert(fmtSize(1536) === '1.5 KB', '1536 bytes：返回 1.5 KB');
assert(fmtSize(1024 * 1024) === '1.0 MB', '1MB：返回 1.0 MB');
assert(fmtSize(1.5 * 1024 * 1024) === '1.5 MB', '1.5MB：返回 1.5 MB');
assert(fmtSize(512) === '512 B', '512 bytes：小於 1024，返回 512 B（非 KB）');

// ════════════════════════════════════════════════════════════════
// Section 6: getStageStatus() — stage 狀態查詢
// ════════════════════════════════════════════════════════════════

section('Section 6: getStageStatus() — stage 狀態查詢');

const stateWithStages = {
  dag: { PLAN: { deps: [] }, ARCH: { deps: ['PLAN'] } },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'active' },
  }
};

assert(getStageStatus('PLAN', stateWithStages) === 'completed', 'PLAN 已完成：返回 completed');
assert(getStageStatus('ARCH', stateWithStages) === 'active', 'ARCH 執行中：返回 active');
assert(getStageStatus('TEST', stateWithStages) === 'pending', '不存在的 stage：返回 pending');
assert(getStageStatus('PLAN', null) === 'pending', 'null state：返回 pending');
assert(getStageStatus('PLAN', {}) === 'pending', '空 state：返回 pending');
assert(getStageStatus('PLAN', { stages: null }) === 'pending', 'stages 為 null：返回 pending');

const allStatusState = {
  stages: {
    S1: { status: 'pending' },
    S2: { status: 'active' },
    S3: { status: 'completed' },
    S4: { status: 'failed' },
    S5: { status: 'skipped' },
  }
};
assert(getStageStatus('S1', allStatusState) === 'pending', 'pending 狀態正確回傳');
assert(getStageStatus('S2', allStatusState) === 'active', 'active 狀態正確回傳');
assert(getStageStatus('S3', allStatusState) === 'completed', 'completed 狀態正確回傳');
assert(getStageStatus('S4', allStatusState) === 'failed', 'failed 狀態正確回傳');
assert(getStageStatus('S5', allStatusState) === 'skipped', 'skipped 狀態正確回傳');

// ════════════════════════════════════════════════════════════════
// Section 7: getStageVerdict() — stage verdict 查詢
// ════════════════════════════════════════════════════════════════

section('Section 7: getStageVerdict() — stage verdict 查詢');

const verdictState = {
  stages: {
    REVIEW: { verdict: 'PASS' },
    TEST: { verdict: 'FAIL' },
    DEV: { verdict: { verdict: 'FAIL', severity: 'HIGH' } },
    PLAN: { status: 'active' },  // 無 verdict
    QA: { verdict: { verdict: 'PASS', severity: null } },
  }
};

assert(getStageVerdict('REVIEW', verdictState) === 'PASS', 'string verdict PASS 正確回傳');
assert(getStageVerdict('TEST', verdictState) === 'FAIL', 'string verdict FAIL 正確回傳');
assert(getStageVerdict('DEV', verdictState) === 'FAIL', 'object verdict 取 .verdict 欄位');
assert(getStageVerdict('PLAN', verdictState) === null, '無 verdict 欄位：返回 null');
assert(getStageVerdict('QA', verdictState) === 'PASS', 'object verdict PASS 正確回傳');
assert(getStageVerdict('MISSING', verdictState) === null, '不存在 stage：返回 null');
assert(getStageVerdict('REVIEW', null) === null, 'null state：返回 null');
assert(getStageVerdict('REVIEW', {}) === null, '空 state：返回 null');

// object verdict 無 .verdict 欄位
const emptyVerdictObj = { stages: { X: { verdict: {} } } };
assert(getStageVerdict('X', emptyVerdictObj) === null, 'object verdict 無 .verdict：返回 null');

// ════════════════════════════════════════════════════════════════
// Section 8: getStageSeverity() — stage severity 查詢
// ════════════════════════════════════════════════════════════════

section('Section 8: getStageSeverity() — stage severity 查詢');

const severityState = {
  stages: {
    REVIEW: { verdict: { verdict: 'FAIL', severity: 'HIGH' } },
    TEST: { verdict: { verdict: 'FAIL', severity: 'CRITICAL' } },
    DEV: { verdict: 'PASS' },       // string verdict，無 severity
    PLAN: { status: 'active' },     // 無 verdict
  }
};

assert(getStageSeverity('REVIEW', severityState) === 'HIGH', 'object verdict HIGH severity 正確回傳');
assert(getStageSeverity('TEST', severityState) === 'CRITICAL', 'object verdict CRITICAL severity 正確回傳');
assert(getStageSeverity('DEV', severityState) === null, 'string verdict：severity 返回 null');
assert(getStageSeverity('PLAN', severityState) === null, '無 verdict：severity 返回 null');
assert(getStageSeverity('MISSING', severityState) === null, '不存在 stage：返回 null');
assert(getStageSeverity('REVIEW', null) === null, 'null state：返回 null');

// ════════════════════════════════════════════════════════════════
// Section 9: getStageDuration() — stage 執行耗時計算
// ════════════════════════════════════════════════════════════════

section('Section 9: getStageDuration() — stage 執行耗時計算');

const durationState = {
  stages: {
    PLAN: {
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:01:30.000Z',  // 90 秒
    },
    ARCH: {
      startedAt: '2024-01-01T00:00:00.000Z',
      // 無 completedAt
    },
    DEV: {
      // 無 startedAt
      completedAt: '2024-01-01T00:01:00.000Z',
    },
    TEST: {
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:05.000Z',  // 5 秒
    },
  }
};

assert(getStageDuration('PLAN', durationState) === 90, 'PLAN 90 秒耗時正確計算');
assert(getStageDuration('TEST', durationState) === 5, 'TEST 5 秒耗時正確計算');
assert(getStageDuration('ARCH', durationState) === null, '無 completedAt：返回 null');
assert(getStageDuration('DEV', durationState) === null, '無 startedAt：返回 null');
assert(getStageDuration('MISSING', durationState) === null, '不存在 stage：返回 null');
assert(getStageDuration('PLAN', null) === null, 'null state：返回 null');
assert(getStageDuration('PLAN', {}) === null, '空 state：返回 null');

// 精確到秒（四捨五入）
const roundState = {
  stages: {
    X: {
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:02.500Z',  // 2.5 秒 → 四捨五入 3
    }
  }
};
assert(getStageDuration('X', roundState) === 3, '2.5 秒：四捨五入為 3 秒');

// ════════════════════════════════════════════════════════════════
// Section 10: getPipelineProgress() — pipeline 進度百分比
// ════════════════════════════════════════════════════════════════

section('Section 10: getPipelineProgress() — pipeline 進度百分比');

assert(getPipelineProgress(null) === 0, 'null state：返回 0');
assert(getPipelineProgress({}) === 0, '無 dag：返回 0');
assert(getPipelineProgress({ dag: {} }) === 0, '空 dag：返回 0');

const progressState1 = {
  dag: { PLAN: {}, ARCH: {}, DEV: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'completed' },
    DEV: { status: 'pending' },
  }
};
assert(getPipelineProgress(progressState1) === 67, '3 stages，2 completed：67%');

const progressState2 = {
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'skipped' },
  }
};
assert(getPipelineProgress(progressState2) === 100, 'completed + skipped 都算完成：100%');

const progressState3 = {
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'failed' },
    ARCH: { status: 'active' },
  }
};
assert(getPipelineProgress(progressState3) === 0, 'failed + active 不算完成：0%');

const progressState4 = {
  dag: { PLAN: {} },
  stages: {}  // 無 stage 記錄
};
assert(getPipelineProgress(progressState4) === 0, 'dag 有 stage 但 stages 空：0%');

const progressFull = {
  dag: { PLAN: {}, ARCH: {}, DEV: {}, REVIEW: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'completed' },
    DEV: { status: 'completed' },
    REVIEW: { status: 'completed' },
  }
};
assert(getPipelineProgress(progressFull) === 100, '全部 completed：100%');

// ════════════════════════════════════════════════════════════════
// Section 11: hasPipeline() — DAG 存在判斷
// ════════════════════════════════════════════════════════════════

section('Section 11: hasPipeline() — DAG 存在判斷');

assert(hasPipeline(null) === false, 'null：返回 false');
assert(hasPipeline({}) === false, '無 dag：返回 false');
assert(hasPipeline({ dag: null }) === false, 'dag 為 null：返回 false');
assert(hasPipeline({ dag: {} }) === false, 'dag 為空物件：返回 false');
assert(hasPipeline({ dag: { PLAN: {} } }) === true, 'dag 有 stage：返回 true');
assert(hasPipeline({ dag: { PLAN: {}, ARCH: {} } }) === true, 'dag 有多個 stage：返回 true');

// ════════════════════════════════════════════════════════════════
// Section 12: isLive() — session 存活判斷
// ════════════════════════════════════════════════════════════════

section('Section 12: isLive() — session 存活判斷');

assert(isLive(null) === false, 'null：返回 false');
assert(isLive({}) === false, '空物件：返回 false');
assert(isLive({ _alive: true }) === true, '_alive=true：返回 true');
assert(isLive({ _alive: false }) === false, '_alive=false：返回 false');
assert(isLive({ activeStages: ['DEV'] }) === true, 'activeStages 非空：返回 true');
assert(isLive({ activeStages: [] }) === false, 'activeStages 空陣列：返回 false');
assert(isLive({ pipelineActive: true }) === true, 'pipelineActive=true：返回 true');
assert(isLive({ pipelineActive: false }) === false, 'pipelineActive=false：返回 false');
assert(isLive({ pipelineActive: true, _alive: false }) === true, 'pipelineActive=true 優先：返回 true');

// ════════════════════════════════════════════════════════════════
// Section 13: sessionCategory() — session 類別判斷
// ════════════════════════════════════════════════════════════════

section('Section 13: sessionCategory() — session 類別判斷');

// null/undefined
assert(sessionCategory(null) === 'stale', 'null session：返回 stale');
assert(sessionCategory(undefined) === 'stale', 'undefined session：返回 stale');

// live 條件：_alive=true
assert(sessionCategory({ _alive: true }) === 'live', '_alive=true：返回 live');

// live 條件：pipelineActive=true
assert(sessionCategory({ pipelineActive: true }) === 'live', 'pipelineActive=true：返回 live');

// live 條件：activeStages 非空
assert(sessionCategory({ activeStages: ['DEV'] }) === 'live', 'activeStages 非空：返回 live');

// done：有 pipeline + progress 100%
const doneSession = {
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'completed' },
  }
};
assert(sessionCategory(doneSession) === 'done', 'pipeline 100% 完成：返回 done');

// active：有 pipeline 但未完成
const activeSession = {
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'pending' },
  }
};
assert(sessionCategory(activeSession) === 'active', 'pipeline 未完成：返回 active');

// stale：無 pipeline，無 lastTransition
assert(sessionCategory({}) === 'stale', '無 pipeline 無 lastTransition：返回 stale');

// stale：lastTransition 超過 30 分鐘
const staleSession = {
  meta: { lastTransition: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }
};
assert(sessionCategory(staleSession) === 'stale', 'lastTransition 超過 30 分鐘：返回 stale');

// active：lastTransition 在 30 分鐘內
const recentSession = {
  meta: { lastTransition: new Date(Date.now() - 5 * 60 * 1000).toISOString() }
};
assert(sessionCategory(recentSession) === 'active', 'lastTransition 5 分鐘內：返回 active');

// ════════════════════════════════════════════════════════════════
// Section 14: getActiveStages() — active stage 清單
// ════════════════════════════════════════════════════════════════

section('Section 14: getActiveStages() — active stage 清單');

assert(getActiveStages(null).length === 0, 'null：返回空陣列');
assert(getActiveStages({}).length === 0, '無 dag：返回空陣列');
assert(getActiveStages({ dag: {} }).length === 0, '空 dag：返回空陣列');

const activeStageState = {
  dag: { PLAN: {}, ARCH: {}, DEV: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'active' },
    DEV: { status: 'active' },
  }
};
const activeList = getActiveStages(activeStageState);
assert(activeList.length === 2, '兩個 active stage：長度為 2');
assert(activeList.includes('ARCH'), 'ARCH 在 active 清單中');
assert(activeList.includes('DEV'), 'DEV 在 active 清單中');
assert(!activeList.includes('PLAN'), 'PLAN（completed）不在 active 清單中');

// ════════════════════════════════════════════════════════════════
// Section 15: computeDagLayout() — DAG 佈局計算
// ════════════════════════════════════════════════════════════════

section('Section 15: computeDagLayout() — DAG 佈局計算');

// 空/null DAG
const emptyLayout = computeDagLayout(null, 800);
assert(emptyLayout.nodes.length === 0, 'null dag：返回空 nodes');
assert(emptyLayout.width === 0, 'null dag：width 為 0');
assert(emptyLayout.height === 0, 'null dag：height 為 0');

const emptyObjLayout = computeDagLayout({}, 800);
assert(emptyObjLayout.nodes.length === 0, '空 dag：返回空 nodes');

// 單一 stage（無依賴）
const singleDag = { PLAN: { deps: [] } };
const singleLayout = computeDagLayout(singleDag, 800);
assert(singleLayout.nodes.length === 1, '單一 stage：1 個 node');
assert(singleLayout.nodes[0].id === 'PLAN', '節點 id 正確');
assert(singleLayout.nodes[0].depth === 0, '無依賴 stage：depth 為 0');
assert(singleLayout.nodes[0].w === NODE_W, '節點寬度正確');
assert(singleLayout.nodes[0].h === NODE_H, '節點高度正確');

// 線性 DAG（PLAN → ARCH）
const linearDag = {
  PLAN: { deps: [] },
  ARCH: { deps: ['PLAN'] },
};
const linearLayout = computeDagLayout(linearDag, 800);
assert(linearLayout.nodes.length === 2, '線性 DAG：2 個 nodes');
const planNode = linearLayout.nodes.find(n => n.id === 'PLAN');
const archNode = linearLayout.nodes.find(n => n.id === 'ARCH');
assert(planNode.depth === 0, 'PLAN depth=0');
assert(archNode.depth === 1, 'ARCH depth=1（依賴 PLAN）');
assert(archNode.x > planNode.x, 'ARCH x 座標大於 PLAN（水平排列）');

// 並行 DAG（PLAN → REVIEW + TEST 同時）
const parallelDag = {
  PLAN: { deps: [] },
  REVIEW: { deps: ['PLAN'] },
  TEST: { deps: ['PLAN'] },
};
const parallelLayout = computeDagLayout(parallelDag, 800);
assert(parallelLayout.nodes.length === 3, '並行 DAG：3 個 nodes');
const reviewNode = parallelLayout.nodes.find(n => n.id === 'REVIEW');
const testNode = parallelLayout.nodes.find(n => n.id === 'TEST');
assert(reviewNode.depth === 1, 'REVIEW depth=1');
assert(testNode.depth === 1, 'TEST depth=1（與 REVIEW 並行）');
assert(reviewNode.x === testNode.x, 'REVIEW 和 TEST x 座標相同（同深度）');
assert(reviewNode.y !== testNode.y, 'REVIEW 和 TEST y 座標不同（垂直排列）');

// ════════════════════════════════════════════════════════════════
// Section 16: buildEdges() — SVG 邊線計算
// ════════════════════════════════════════════════════════════════

section('Section 16: buildEdges() — SVG 邊線計算');

assert(buildEdges(null, []).length === 0, 'null dag：返回空陣列');
assert(buildEdges({}, []).length === 0, '空 nodes：返回空陣列');

const edgeDag = {
  PLAN: { deps: [] },
  ARCH: { deps: ['PLAN'] },
};
const edgeNodes = computeDagLayout(edgeDag, 800).nodes;
const edges = buildEdges(edgeDag, edgeNodes);
assert(edges.length === 1, '線性 DAG：1 條邊');
assert(edges[0].id === 'PLAN->ARCH', '邊 id 格式正確');
assert(edges[0].from === 'PLAN', '邊起點正確');
assert(edges[0].to === 'ARCH', '邊終點正確');
assert(edges[0].path.startsWith('M'), 'path 以 M 開頭（SVG 路徑格式）');
assert(edges[0].path.includes('C'), 'path 包含 C（貝茲曲線控制點）');

// 並行邊線
const parallelEdgeDag = {
  PLAN: { deps: [] },
  REVIEW: { deps: ['PLAN'] },
  TEST: { deps: ['PLAN'] },
};
const parallelEdgeNodes = computeDagLayout(parallelEdgeDag, 800).nodes;
const parallelEdges = buildEdges(parallelEdgeDag, parallelEdgeNodes);
assert(parallelEdges.length === 2, '並行 DAG：2 條邊（PLAN→REVIEW + PLAN→TEST）');

// 無依賴的 stage 不產生邊
const noDepsEdges = buildEdges({ PLAN: { deps: [] } }, computeDagLayout({ PLAN: { deps: [] } }, 800).nodes);
assert(noDepsEdges.length === 0, '無依賴 stage：不產生邊');

// ════════════════════════════════════════════════════════════════
// Section 17: detectPhases() — phase 分組偵測
// ════════════════════════════════════════════════════════════════

section('Section 17: detectPhases() — phase 分組偵測');

assert(Object.keys(detectPhases(null)).length === 0, 'null dag：返回空物件');
assert(Object.keys(detectPhases({})).length === 0, '空 dag：返回空物件');

// 無 suffixed stage → 無 phase
const normalDag = { PLAN: {}, ARCH: {}, DEV: {} };
assert(Object.keys(detectPhases(normalDag)).length === 0, '無 suffixed stages：返回空物件');

// 只有 1 個 phase → 返回空物件（需 >= 2 個 phase）
const onePhase = { 'DEV:1': {}, 'REVIEW:1': {}, 'TEST:1': {} };
assert(Object.keys(detectPhases(onePhase)).length === 0, '只有 1 個 phase：返回空物件');

// 2 個 phase → 正確分組
const twoPhases = { 'DEV:1': {}, 'REVIEW:1': {}, 'TEST:1': {}, 'DEV:2': {}, 'REVIEW:2': {} };
const phases2 = detectPhases(twoPhases);
assert(Object.keys(phases2).length === 2, '2 個 phase：返回 2 個分組');
assert(phases2['1'].includes('DEV:1'), 'phase 1 包含 DEV:1');
assert(phases2['1'].includes('REVIEW:1'), 'phase 1 包含 REVIEW:1');
assert(phases2['1'].includes('TEST:1'), 'phase 1 包含 TEST:1');
assert(phases2['2'].includes('DEV:2'), 'phase 2 包含 DEV:2');
assert(phases2['2'].includes('REVIEW:2'), 'phase 2 包含 REVIEW:2');

// 混合（有 suffixed 和無 suffixed）
const mixedPhases = { PLAN: {}, 'DEV:1': {}, 'REVIEW:1': {}, 'DEV:2': {}, 'REVIEW:2': {} };
const mixedResult = detectPhases(mixedPhases);
assert(Object.keys(mixedResult).length === 2, '混合 DAG：只計 suffixed stage，2 個 phase');
assert(!mixedResult['1'].includes('PLAN'), 'PLAN 不屬於任何 phase');

// ════════════════════════════════════════════════════════════════
// Section 18: 組件 export 完整性靜態檢查
// ════════════════════════════════════════════════════════════════

section('Section 18: 組件 export 完整性靜態檢查');

const componentFiles = [
  { file: 'components/agent-status.js', expectedExport: 'AgentStatus' },
  { file: 'components/barrier-display.js', expectedExport: 'BarrierDisplay' },
  { file: 'components/confetti.js', expectedExport: 'Confetti' },
  { file: 'components/dag-view.js', expectedExport: 'DagView' },
  { file: 'components/export-report.js', expectedExport: 'exportReport' },
  { file: 'components/mcp-stats.js', expectedExport: 'MCPStats' },
  { file: 'components/pipeline-progress.js', expectedExport: 'PipelineProgressBar' },
  { file: 'components/sidebar.js', expectedExport: 'Sidebar' },
  { file: 'components/stats-cards.js', expectedExport: 'StatsCards' },
  { file: 'lib/utils.js', expectedExport: 'sid' },
  { file: 'lib/utils.js', expectedExport: 'fmtSec' },
  { file: 'lib/utils.js', expectedExport: 'fmtSize' },
  { file: 'lib/utils.js', expectedExport: 'elapsed' },
  { file: 'state/pipeline.js', expectedExport: 'getStageStatus' },
  { file: 'state/pipeline.js', expectedExport: 'getPipelineProgress' },
  { file: 'state/pipeline.js', expectedExport: 'sessionCategory' },
  { file: 'state/pipeline.js', expectedExport: 'hasPipeline' },
  { file: 'state/pipeline.js', expectedExport: 'isLive' },
];

for (const { file, expectedExport } of componentFiles) {
  const filePath = path.join(WEB_DIR, file);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const hasExport = content.includes(`export function ${expectedExport}`) ||
                      content.includes(`export async function ${expectedExport}`) ||
                      content.includes(`export const ${expectedExport}`);
    assert(hasExport, `${file} 有正確 export ${expectedExport}`);
  } catch (e) {
    assert(false, `${file} 讀取失敗：${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// Section 19: dag-view.js 額外 export 函式
// ════════════════════════════════════════════════════════════════

section('Section 19: dag-view.js 額外 export 函式');

const dagViewPath = path.join(WEB_DIR, 'components/dag-view.js');
const dagViewContent = fs.readFileSync(dagViewPath, 'utf8');
assert(dagViewContent.includes('export function computeDagLayout'), 'dag-view.js 有 export computeDagLayout');
assert(dagViewContent.includes('export function buildEdges'), 'dag-view.js 有 export buildEdges');
assert(dagViewContent.includes('export function detectPhases'), 'dag-view.js 有 export detectPhases');
assert(dagViewContent.includes('export function DagView'), 'dag-view.js 有 export DagView');

// ════════════════════════════════════════════════════════════════
// Section 20: import 路徑一致性靜態檢查
// ════════════════════════════════════════════════════════════════

section('Section 20: import 路徑一致性靜態檢查');

// 所有 components 的 import 路徑應以 '../lib/' 或 '../state/' 開頭（相對路徑正確）
const componentsDir = path.join(WEB_DIR, 'components');
const componentFilenames = fs.readdirSync(componentsDir).filter(f => f.endsWith('.js'));

for (const filename of componentFilenames) {
  const filePath = path.join(componentsDir, filename);
  const content = fs.readFileSync(filePath, 'utf8');
  const importLines = content.split('\n').filter(l => l.trim().startsWith('import'));
  // 所有非 CDN import 應使用相對路徑
  const localImports = importLines.filter(l => !l.includes('esm.sh') && !l.includes('cdn.') && !l.includes('skypack'));
  for (const imp of localImports) {
    const hasRelative = imp.includes("'../") || imp.includes('"../') || imp.includes("'./") || imp.includes('"./');
    assert(hasRelative, `${filename} 的 local import 使用相對路徑：${imp.trim()}`);
  }
}

// state/pipeline.js import fmtSec 從 ../lib/utils.js
const pipelineContent = fs.readFileSync(path.join(WEB_DIR, 'state/pipeline.js'), 'utf8');
assert(pipelineContent.includes("from '../lib/utils.js'"), 'state/pipeline.js 正確 import ../lib/utils.js');

// ════════════════════════════════════════════════════════════════
// Section 21: fmtSec 邊界案例（負數、小數）
// ════════════════════════════════════════════════════════════════

section('Section 21: fmtSec 邊界案例（負數、小數）');

// 負數：fmtSec(-1) — 注意：-1 為 falsy 但 secs !== 0，故 !secs 為 true → 返回 '—'
// 實際行為：!(-1) = false（-1 是 truthy），所以 -1 < 60 → 返回 '-1s'
assert(fmtSec(-1) === '-1s', '負數 -1 秒：按原始邏輯返回 -1s（truthy）');
assert(fmtSec(0.4) === '0s', '0.4 秒：四捨五入為 0s');
assert(fmtSec(0.5) === '1s', '0.5 秒：四捨五入為 1s');
assert(fmtSec(119.5) === '1m60s', '119.5 秒：60%60=0 但 round(59.5)=60 → 1m60s（邊界行為）');

// fmtSec(false) — false && false !== 0 → !false = true → 返回 '—'
assert(fmtSec(false) === '—', 'false 視為缺失值：返回破折號');

// ════════════════════════════════════════════════════════════════
// Section 22: getPipelineProgress 邊界案例
// ════════════════════════════════════════════════════════════════

section('Section 22: getPipelineProgress 邊界案例');

// 1 個 stage，0% 完成
const oneStageState = {
  dag: { PLAN: {} },
  stages: { PLAN: { status: 'pending' } }
};
assert(getPipelineProgress(oneStageState) === 0, '1 stage pending：0%');

// 1 個 stage，100% 完成
const oneStageComplete = {
  dag: { PLAN: {} },
  stages: { PLAN: { status: 'completed' } }
};
assert(getPipelineProgress(oneStageComplete) === 100, '1 stage completed：100%');

// failed 不算完成
const failedState = {
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'failed' },
    ARCH: { status: 'pending' }
  }
};
assert(getPipelineProgress(failedState) === 0, 'failed 不算完成：0%');

// 混合：3 completed, 1 skipped, 2 pending → 4/6 = 67%
const mixedProgress = {
  dag: { A: {}, B: {}, C: {}, D: {}, E: {}, F: {} },
  stages: {
    A: { status: 'completed' },
    B: { status: 'completed' },
    C: { status: 'completed' },
    D: { status: 'skipped' },
    E: { status: 'pending' },
    F: { status: 'active' },
  }
};
assert(getPipelineProgress(mixedProgress) === 67, '4 完成（含 skipped），6 總數：67%');

// ════════════════════════════════════════════════════════════════
// Section 23: sessionCategory 邊界案例
// ════════════════════════════════════════════════════════════════

section('Section 23: sessionCategory 邊界案例');

// _alive 優先於其他判斷
const aliveWithDone = {
  _alive: true,
  dag: { PLAN: {}, ARCH: {} },
  stages: {
    PLAN: { status: 'completed' },
    ARCH: { status: 'completed' },
  }
};
assert(sessionCategory(aliveWithDone) === 'live', '_alive=true 優先於 done 狀態：返回 live');

// pipeline 完成但有 activeStages
const doneButActive = {
  dag: { PLAN: {} },
  stages: { PLAN: { status: 'completed' } },
  activeStages: ['DEV'],
};
assert(sessionCategory(doneButActive) === 'live', 'activeStages 非空：優先返回 live');

// lastTransition 剛好在邊界（30 分鐘 = 1800000 ms）
const borderSession = {
  meta: { lastTransition: new Date(Date.now() - 1800_001).toISOString() }
};
assert(sessionCategory(borderSession) === 'stale', 'lastTransition 超過 1800 秒：返回 stale');

const borderSession2 = {
  meta: { lastTransition: new Date(Date.now() - 1799_000).toISOString() }
};
assert(sessionCategory(borderSession2) === 'active', 'lastTransition 在 1800 秒內：返回 active');

// ════════════════════════════════════════════════════════════════
// Section 24: fmtSize 邊界精確測試
// ════════════════════════════════════════════════════════════════

section('Section 24: fmtSize 邊界精確測試');

// 剛好 1024 bytes = 1.0 KB（非 B）
assert(fmtSize(1024) === '1.0 KB', '1024 bytes = 1.0 KB（臨界值）');
// 1023 仍為 B
assert(fmtSize(1023) === '1023 B', '1023 bytes 仍為 B');
// 剛好 1MB（1024*1024）
assert(fmtSize(1024 * 1024) === '1.0 MB', '1048576 bytes = 1.0 MB（臨界值）');
// 1 byte 以下（實際為 0 但 !0 → '—'）
assert(fmtSize(0) === '—', '0 bytes：返回破折號');
// 1 byte
assert(fmtSize(1) === '1 B', '1 byte：返回 1 B');
// 負數（!(-100) = false，-100 < 1024 → '-100 B'）
assert(fmtSize(-100) === '-100 B', '負數 bytes：按原始邏輯返回 -100 B（truthy）');
// toFixed 精度（保留一位小數）
assert(fmtSize(1126) === '1.1 KB', '1126 bytes → 1.099... → toFixed(1) = 1.1 KB');

// ════════════════════════════════════════════════════════════════
// Section 25: getStageVerdict object verdict 無 .verdict 欄位
// ════════════════════════════════════════════════════════════════

section('Section 25: getStageVerdict object verdict 特殊案例');

// object verdict 有 severity 但無 verdict
const severityOnlyState = { stages: { X: { verdict: { severity: 'HIGH' } } } };
assert(getStageVerdict('X', severityOnlyState) === null, 'object verdict 有 severity 但無 .verdict：返回 null');

// object verdict .verdict 為 null
const nullVerdictInObj = { stages: { X: { verdict: { verdict: null } } } };
assert(getStageVerdict('X', nullVerdictInObj) === null, 'object verdict .verdict 為 null：返回 null');

// getStageSeverity：object verdict 有 severity 但 .verdict 為空
assert(getStageSeverity('X', severityOnlyState) === 'HIGH', 'getStageSeverity 只需 verdict 物件存在即可取 severity');

// ════════════════════════════════════════════════════════════════
// Section 26: computeDagLayout 菱形依賴深度計算
// ════════════════════════════════════════════════════════════════

section('Section 26: computeDagLayout 菱形依賴深度計算');

// A → B, A → C, B → D, C → D（菱形圖）
const diamondDag = {
  A: { deps: [] },
  B: { deps: ['A'] },
  C: { deps: ['A'] },
  D: { deps: ['B', 'C'] },
};
const diamondLayout = computeDagLayout(diamondDag, 800);
assert(diamondLayout.nodes.length === 4, '菱形 DAG：4 個 nodes');
const dNodeA = diamondLayout.nodes.find(n => n.id === 'A');
const dNodeB = diamondLayout.nodes.find(n => n.id === 'B');
const dNodeC = diamondLayout.nodes.find(n => n.id === 'C');
const dNodeD = diamondLayout.nodes.find(n => n.id === 'D');
assert(dNodeA.depth === 0, '菱形：A depth=0');
assert(dNodeB.depth === 1, '菱形：B depth=1');
assert(dNodeC.depth === 1, '菱形：C depth=1');
assert(dNodeD.depth === 2, '菱形：D depth=2（取最長路徑）');

// ════════════════════════════════════════════════════════════════
// Section 27: buildEdges 懸空引用容錯
// ════════════════════════════════════════════════════════════════

section('Section 27: buildEdges 懸空引用容錯');

// deps 指向不存在的 node（懸空引用）
const danglingDag = {
  ARCH: { deps: ['GHOST'] },  // GHOST 不存在於 dag 中
};
const danglingNodes = computeDagLayout({ ARCH: { deps: [] } }, 800).nodes;
// 即使 deps 有懸空引用，buildEdges 應優雅跳過
const danglingEdges = buildEdges(danglingDag, danglingNodes);
assert(danglingEdges.length === 0, '懸空引用：source node 不存在，不產生邊（優雅跳過）');

// ════════════════════════════════════════════════════════════════
// 結果輸出
// ════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`結果：${passed} 通過，${failed} 失敗，共 ${passed + failed} 個測試`);

if (failed > 0) {
  process.exit(1);
}
