#!/usr/bin/env node
/**
 * barrier.js — Barrier 並行同步模組（v4 Phase 4）
 *
 * 管理並行節點的同步計數器。
 * 原則：Barrier 是計數器，不要求兩個 stage 同時完成，只要求計數滿後才繼續。
 *
 * 架構：
 * - 獨立的 barrier-state-{sessionId}.json 檔案（不混入 pipeline-state）
 * - 使用 atomicWrite 確保寫入安全
 * - Worst-Case-Wins：任一 FAIL → 合併結果為 FAIL，severity 取最高
 *
 * @module flow/barrier
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('./atomic-write.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Barrier 預設超時（5 分鐘）
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// Severity 嚴重度順序（越前面越嚴重）
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// Context file 大小上限（5000 chars）
const MAX_CONTEXT_SIZE = 5000;

// ────────────────── I/O ──────────────────

/**
 * 取得 barrier state 檔案路徑
 * @param {string} sessionId
 * @returns {string}
 */
function getBarrierPath(sessionId) {
  return path.join(CLAUDE_DIR, `barrier-state-${sessionId}.json`);
}

/**
 * 讀取 barrier state
 * @param {string} sessionId
 * @returns {{ groups: Object }|null}
 */
function readBarrier(sessionId) {
  const p = getBarrierPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 寫入 barrier state（使用 atomicWrite）
 * @param {string} sessionId
 * @param {{ groups: Object }} barrierState
 */
function writeBarrier(sessionId, barrierState) {
  atomicWrite(getBarrierPath(sessionId), barrierState);
}

/**
 * 刪除 barrier state 檔案
 * @param {string} sessionId
 */
function deleteBarrier(sessionId) {
  try {
    fs.unlinkSync(getBarrierPath(sessionId));
  } catch (_) {}
}

// ────────────────── Barrier Group 操作 ──────────────────

/**
 * 建立（或確保存在）barrier group
 *
 * @param {string} sessionId
 * @param {string} group - barrier group 名稱（如 "post-dev"）
 * @param {number} total - 需等待的 stage 數量
 * @param {string|null} next - 全部完成後前進的 stage（null = COMPLETE）
 * @param {string[]} siblings - 共享此 barrier 的所有 stage ID
 * @returns {{ groups: Object }} 更新後的 barrier state
 */
function createBarrierGroup(sessionId, group, total, next, siblings) {
  const barrierState = readBarrier(sessionId) || { groups: {} };

  // 只在 group 不存在時建立（避免覆蓋進行中的 barrier）
  if (!barrierState.groups[group]) {
    barrierState.groups[group] = {
      total,
      completed: [],
      results: {},
      next: next || null,
      siblings: siblings || [],
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    writeBarrier(sessionId, barrierState);
  }

  return barrierState;
}

/**
 * 更新 barrier（stage 完成時呼叫）
 *
 * @param {string} sessionId
 * @param {string} group - barrier group 名稱
 * @param {string} stage - 完成的 stage ID
 * @param {Object} routeResult - PIPELINE_ROUTE 解析結果（含 verdict/severity/route/context_file/hint）
 * @returns {{ allComplete: boolean, mergedResult?: Object }}
 */
function updateBarrier(sessionId, group, stage, routeResult) {
  const barrierState = readBarrier(sessionId) || { groups: {} };

  if (!barrierState.groups[group]) {
    // barrier group 不存在 → 無法更新（異常情況）
    return { allComplete: false };
  }

  const groupData = barrierState.groups[group];

  // 幂等：若已完成，直接跳過（避免重複計數）
  if (groupData.completed.includes(stage)) {
    const allComplete = groupData.completed.length >= groupData.total;
    if (allComplete && !groupData.resolved) {
      const mergedResult = mergeBarrierResults(groupData);
      groupData.resolved = true;
      writeBarrier(sessionId, barrierState);
      return { allComplete: true, mergedResult };
    }
    return { allComplete };
  }

  // 加入 completed + results
  groupData.completed.push(stage);
  groupData.results[stage] = routeResult || { verdict: 'PASS', route: 'BARRIER' };

  const allComplete = groupData.completed.length >= groupData.total;

  if (allComplete && !groupData.resolved) {
    // 所有 stage 都到齊 → 合併結果
    const mergedResult = mergeBarrierResults(groupData);
    groupData.resolved = true;
    writeBarrier(sessionId, barrierState);
    return { allComplete: true, mergedResult };
  }

  // 尚未全到齊 → 儲存進度
  writeBarrier(sessionId, barrierState);
  return { allComplete: false };
}

// ────────────────── 結果合併 ──────────────────

/**
 * 合併 barrier 所有 stage 的結果（Worst-Case-Wins）
 *
 * 規則：
 * - 全 PASS → { verdict: 'PASS', route: 'NEXT', target: next }
 * - 任一 FAIL → { verdict: 'FAIL', route: 'DEV', severity: max(severities) }
 *   - FAIL 的 context_files 合併
 *   - FAIL 的 hints 合併
 *
 * @param {{ total, completed, results, next, siblings }} groupData
 * @returns {Object} 合併後的路由結果
 */
function mergeBarrierResults(groupData) {
  const results = Object.values(groupData.results || {});

  // 過濾出 FAIL 結果
  const fails = results.filter(r => r.verdict === 'FAIL');

  if (fails.length === 0) {
    // 全部 PASS → 前進到 barrier.next（若 next 為空則 COMPLETE）
    if (!groupData.next) {
      return { verdict: 'PASS', route: 'COMPLETE' };
    }
    // 收集所有 context_files（PASS 的也要傳遞）
    const contextFiles = results
      .map(r => r.context_file)
      .filter(Boolean);
    return {
      verdict: 'PASS',
      route: 'NEXT',
      target: groupData.next,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
    };
  }

  // 任一 FAIL → Worst-Case-Wins
  // severity 依嚴重度排序：CRITICAL > HIGH > MEDIUM > LOW
  fails.sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a.severity || 'MEDIUM');
    const bi = SEVERITY_ORDER.indexOf(b.severity || 'MEDIUM');
    const aIdx = ai === -1 ? SEVERITY_ORDER.length : ai;
    const bIdx = bi === -1 ? SEVERITY_ORDER.length : bi;
    return aIdx - bIdx;
  });

  const worstSeverity = fails[0].severity || 'HIGH';

  // 合併 context_files（所有結果的報告，含 PASS 和 FAIL）
  const contextFiles = results.map(r => r.context_file).filter(Boolean);

  // 合併 hints
  const hints = fails.map(f => f.hint).filter(Boolean).join('; ');

  return {
    verdict: 'FAIL',
    route: 'DEV',
    severity: worstSeverity,
    ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
    ...(hints ? { hint: hints } : {}),
    // 提供 target 讓 controller 知道是哪個 barrier 解鎖
    _barrierMerged: true,
    _failedStages: fails.map((_, i) => Object.keys(groupData.results || {}).find(k => groupData.results[k] === fails[i])).filter(Boolean),
  };
}

// ────────────────── 合併 Context Files ──────────────────

/**
 * 合併多個 FAIL 的 context files 到一個彙整檔
 *
 * @param {Object[]} fails - FAIL 結果陣列（含 context_file 欄位）
 * @param {string} sessionId
 * @returns {string|null} 合併後的檔案路徑（null = 無可合併）
 */
function mergeContextFiles(fails, sessionId) {
  const hasFiles = fails.some(f => f.context_file && fs.existsSync(f.context_file));
  if (!hasFiles) return null;

  const mergedPath = path.join(CLAUDE_DIR, `pipeline-context-${sessionId}-MERGED.md`);
  const parts = [];

  for (const fail of fails) {
    if (!fail.context_file) continue;
    try {
      const content = fs.readFileSync(fail.context_file, 'utf8');
      // 從路徑推導 stage 名稱（pipeline-context-{sid}-{STAGE}.md）
      const stageMatch = fail.context_file.match(/pipeline-context-[^-]+-([A-Z]+)\.md$/);
      const stageName = stageMatch ? stageMatch[1] : 'UNKNOWN';
      parts.push(`## ${stageName} 結果\n\n${content}`);
    } catch (_) {
      // 讀取失敗時跳過
    }
  }

  if (parts.length === 0) return null;

  // 串接，限制總大小
  let merged = parts.join('\n\n---\n\n');
  if (merged.length > MAX_CONTEXT_SIZE) {
    merged = merged.slice(0, MAX_CONTEXT_SIZE) + '\n\n...（內容截斷）';
  }

  try {
    atomicWrite(mergedPath, merged);
    return mergedPath;
  } catch (_) {
    return null;
  }
}

// ────────────────── 超時偵測 ──────────────────

/**
 * 檢查 barrier group 是否已超時
 *
 * @param {{ groups: Object }} barrierState
 * @param {string} group - barrier group 名稱
 * @param {number} timeoutMs - 超時時間（預設 5 分鐘）
 * @returns {boolean} 是否已超時
 */
function checkTimeout(barrierState, group, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const groupData = barrierState?.groups?.[group];
  if (!groupData) return false;
  if (groupData.resolved) return false;

  const createdAt = new Date(groupData.createdAt).getTime();
  if (isNaN(createdAt)) return false;

  return (Date.now() - createdAt) > timeoutMs;
}

// ────────────────── Timeout 巡檢 ──────────────────

/**
 * 巡檢所有 barrier groups 的超時狀態，對超時 group 強制填入缺席 stages 為 FAIL。
 *
 * 職責邊界：只做「偵測 + 強制解鎖 + 合併結果」。
 * 不做路由決策（回退 DEV / 前進 NEXT 由 pipeline-controller 處理）。
 *
 * 幂等性：對已 resolved 的 group 直接跳過；連續呼叫兩次結果不變。
 *
 * @param {string} sessionId
 * @returns {{ timedOut: Array<{ group: string, mergedResult: Object, timedOutStages: string[] }> }}
 */
function sweepTimedOutGroups(sessionId) {
  const barrierState = readBarrier(sessionId);
  if (!barrierState?.groups) return { timedOut: [] };

  const timedOut = [];

  for (const [group, groupData] of Object.entries(barrierState.groups)) {
    // 已解鎖的 group 略過（幂等）
    if (groupData.resolved) continue;
    // 未超時的 group 略過
    if (!checkTimeout(barrierState, group)) continue;

    // 找出缺席 stages（siblings 中尚未回報結果的）
    const absent = (groupData.siblings || [])
      .filter(s => !groupData.completed.includes(s));
    if (absent.length === 0) continue;

    // 對缺席 stages 填入 FAIL（模擬 agent 超時未回應）
    for (const s of absent) {
      updateBarrier(sessionId, group, s, {
        verdict: 'FAIL',
        route: 'BARRIER',
        severity: 'HIGH',
        hint: `Barrier 超時 — agent 未回應（group: ${group}，stage: ${s}）`,
      });
    }

    // 觸發合併：使用已完成 stage 的結果（或缺席 stage）再次呼叫，讓 updateBarrier 完成合併
    // 因為 absent stage 剛填入，此時 completed.length 已等於 total，合併會自動觸發
    // 讀取最新的 barrier state（updateBarrier 已寫入磁碟）
    const updatedState = readBarrier(sessionId);
    const updatedGroup = updatedState?.groups?.[group];
    let mergedResult = null;
    if (updatedGroup?.resolved) {
      // 重建 mergedResult（updateBarrier 已合併，需從 groupData 重算）
      mergedResult = mergeBarrierResults(updatedGroup);
    } else {
      // 若 updateBarrier 未觸發合併（如 total 計算有偏差），強制合併
      mergedResult = mergeBarrierResults(updatedGroup || groupData);
    }

    timedOut.push({ group, mergedResult, timedOutStages: absent });
  }

  return { timedOut };
}

// ────────────────── 重建工具 ──────────────────

/**
 * 從主 pipeline state 重建損毀的 barrier state
 *
 * 當 barrier-state 檔案丟失但 pipeline-state 存在時，
 * 嘗試從 stages 狀態重建 barrier group 資訊。
 *
 * @param {Object} state - pipeline state（含 dag + stages）
 * @returns {{ groups: Object }} 重建的 barrier state
 */
function rebuildBarrierFromState(state) {
  const groups = {};
  if (!state?.dag) return { groups };

  // 找出 DAG 中有 barrier 欄位的 stages
  for (const [stageId, nodeConfig] of Object.entries(state.dag)) {
    const barrier = nodeConfig.barrier;
    if (!barrier?.group) continue;

    const group = barrier.group;
    if (!groups[group]) {
      groups[group] = {
        total: barrier.total || 2,
        completed: [],
        results: {},
        next: barrier.next || null,
        siblings: barrier.siblings || [],
        resolved: false,
        createdAt: new Date().toISOString(),
        _rebuilt: true,
      };
    }

    // 從 stages 狀態推導已完成的 stages
    const stageStatus = state.stages?.[stageId]?.status;
    if (stageStatus === 'completed' || stageStatus === 'failed') {
      if (!groups[group].completed.includes(stageId)) {
        groups[group].completed.push(stageId);
        groups[group].results[stageId] = state.stages[stageId]?.verdict || {
          verdict: stageStatus === 'completed' ? 'PASS' : 'FAIL',
          route: 'BARRIER',
        };
      }
    }
  }

  return { groups };
}

// ────────────────── Exports ──────────────────

module.exports = {
  // I/O
  getBarrierPath,
  readBarrier,
  writeBarrier,
  deleteBarrier,

  // Barrier Group 操作
  createBarrierGroup,
  updateBarrier,

  // 結果合併
  mergeBarrierResults,
  mergeContextFiles,

  // 超時偵測
  checkTimeout,

  // Timeout 巡檢
  sweepTimedOutGroups,

  // 重建工具
  rebuildBarrierFromState,

  // 常數（供測試用）
  DEFAULT_TIMEOUT_MS,
  SEVERITY_ORDER,
};
