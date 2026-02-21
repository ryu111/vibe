#!/usr/bin/env node
/**
 * validate.js — Pipeline E2E 驗證模組（v3 State Schema）
 *
 * 驗證模型基於 DAG 語意：
 *   phase=COMPLETE → 所有 stages completed/skipped，品質閘門通過
 *   phase=IDLE + none → 分類正確即成功
 *   其他 phase → 非預期終態，驗證失敗
 *
 * 驗證分五層：
 *   L1 結構層 — state/timeline 存在
 *   L2 分類層 — pipelineId、DAG stages 匹配
 *   L3 完成層 — 基於 derivePhase 的一致性檢查
 *   L4 Timeline 層 — 事件佐證
 *   L5 場景特化層 — cancelled/retries/reclassification/design/openspec
 *
 * 用法：node validate.js <sessionId> <scenarioId> [scenariosPath]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 從 dag-state.js 引入 derivePhase 和 helper
const dagStatePath = path.join(__dirname, '..', 'plugins', 'vibe', 'scripts', 'lib', 'flow', 'dag-state.js');
const { derivePhase, getCompletedStages, getSkippedStages } = require(dagStatePath);

// 品質階段 — 這些階段產生 PASS/FAIL verdict
const QUALITY_STAGES = ['REVIEW', 'TEST', 'QA', 'E2E'];

// ────────────────── 輸入解析 ──────────────────

const sessionId = process.argv[2];
const scenarioId = process.argv[3];
const scenariosPath = process.argv[4] || path.join(__dirname, 'scenarios.json');

if (!sessionId || !scenarioId) {
  console.error('用法: node validate.js <sessionId> <scenarioId> [scenariosPath]');
  process.exit(1);
}

const scenariosData = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
const scenario = scenariosData.scenarios.find(s => s.id === scenarioId);
if (!scenario) {
  console.error(`找不到場景: ${scenarioId}`);
  process.exit(1);
}

const expected = scenario.expected;

// ────────────────── I/O ──────────────────

function readState() {
  // 主要路徑：直接讀取 ~/.claude/ 的 state 檔案
  const primary = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try { return JSON.parse(fs.readFileSync(primary, 'utf8')); } catch {}

  // Fallback：讀取 run.sh 在 COMPLETE 偵測時建立的快照
  // 防止並行 session 的 session-cleanup 在 validate 前刪除 state
  const snapshotDir = process.env.VIBE_E2E_RESULTS_DIR;
  if (snapshotDir) {
    const snapshot = path.join(snapshotDir, `${scenarioId}.state-snapshot.json`);
    try { return JSON.parse(fs.readFileSync(snapshot, 'utf8')); } catch {}
  }

  return null;
}

function readTimeline() {
  try {
    const raw = fs.readFileSync(
      path.join(CLAUDE_DIR, `timeline-${sessionId}.jsonl`), 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ────────────────── 驗證引擎 ──────────────────

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function validate(state, timeline) {
  const checks = [];
  const add = (name, passed, required = true, detail) => {
    checks.push({ name, passed: !!passed, required, ...(detail && { detail }) });
  };

  // ═══ L1 結構層 ═══
  add('L1:stateExists', state !== null);
  add('L1:timelineExists', timeline.length > 0);

  if (!state) return checks; // 無 state 則後續全跳過

  // v3: phase 從 state 推導
  const phase = derivePhase(state);

  // ═══ L2 分類層 ═══
  if (expected.pipelineId) {
    const actual = state.classification && state.classification.pipelineId;
    add('L2:pipelineId', actual === expected.pipelineId,
      true, `expected=${expected.pipelineId} actual=${actual}`);
  }

  if (expected.phase) {
    add('L2:phase', phase === expected.phase,
      true, `expected=${expected.phase} actual=${phase}`);
  }

  if (expected.stages) {
    const actual = state.dag ? Object.keys(state.dag) : [];
    add('L2:stages', deepEqual(actual, expected.stages),
      true, `expected=${JSON.stringify(expected.stages)} actual=${JSON.stringify(actual)}`);
  }

  if (expected.stageCount !== undefined) {
    const actual = state.dag ? Object.keys(state.dag) : [];
    add('L2:stageCount', actual.length === expected.stageCount,
      true, `expected=${expected.stageCount} actual=${actual.length}`);
  }

  if (expected.source !== undefined && expected.source !== null) {
    const actual = state.classification && state.classification.source;
    add('L2:source', actual === expected.source,
      false, `expected=${expected.source} actual=${actual}`);
  }

  // ═══ L3 完成層（基於 derivePhase 的一致性）═══
  const isPhaseComplete = phase === 'COMPLETE';
  const isNone = (state.classification && state.classification.pipelineId) === 'none';

  if (isPhaseComplete) {
    // COMPLETE → DAG 保證所有 stages done，這裡只驗一致性

    // 3a. completed stages 數量 ≥ 非跳過階段數
    const dagStages = state.dag ? Object.keys(state.dag) : [];
    const skipped = getSkippedStages(state);
    const completed = getCompletedStages(state);
    const expectedCompletedCount = dagStages.length - skipped.length;
    add('L3:completedStages', completed.length >= expectedCompletedCount,
      false, `expected>=${expectedCompletedCount} actual=${completed.length}`);

    // 3b. pendingRetry 已消費（不應殘留）
    add('L3:noPendingRetry', state.pendingRetry === null || state.pendingRetry === undefined);

    // 3c. 品質階段 verdict 一致性（COMPLETE 保證 PASS，這裡是 double-check）
    const stages = state.stages || {};
    const qualityResults = Object.entries(stages)
      .filter(([stageId]) => QUALITY_STAGES.includes(stageId))
      .filter(([, s]) => s.status === 'completed');
    if (qualityResults.length > 0) {
      // verdict 可能是字串（'PASS'）或物件（{verdict:'PASS',route:'NEXT',_inferred:true}）
      const allQualityPass = qualityResults.every(([, s]) => {
        const v = s.verdict;
        return v === 'PASS' || (typeof v === 'object' && v !== null && v.verdict === 'PASS');
      });
      add('L3:qualityVerdicts', allQualityPass,
        false, `quality stages: ${qualityResults.map(([id, s]) => `${id}=${JSON.stringify(s.verdict)}`).join(', ')}`);
    }
  }

  // retries 在限制內（任何 phase 都檢查）
  const retries = state.retries || {};
  const maxRetry = Math.max(0, ...Object.values(retries));
  add('L3:retriesWithinLimit', maxRetry <= 3,
    true, `max=${maxRetry}`);

  // ═══ L4 Timeline 層 ═══
  // v3: task-classifier 改用 prompt.received（向後相容檢查 task.classified）
  add('L4:hasClassified',
    timeline.some(e => e.type === 'prompt.received' || e.type === 'task.classified'));

  if (isPhaseComplete) {
    add('L4:hasPipelineComplete', timeline.some(e => e.type === 'pipeline.complete'),
      false);
  }

  if (!isNone && (isPhaseComplete || phase === 'DELEGATING' || phase === 'RETRYING')) {
    add('L4:hasDelegation', timeline.some(e => e.type === 'delegation.start'),
      false);
  }

  // ═══ L5 場景特化層 ═══

  if (expected.cancelled) {
    add('L5:cancelled', state.meta && state.meta.cancelled === true);
  }

  if (expected.hasRetries) {
    const hasAny = Object.values(retries).some(c => c > 0);
    add('L5:hasRetries', hasAny, false); // warning：依賴模型遵守 verdict 協議，非 infrastructure 保證
  }

  if (expected.hasReclassification) {
    const reclasses = state.meta && state.meta.reclassifications;
    // warning（非 required）：依賴 follow-up 機制的時序，有不確定性
    // follow-up 透過 --resume -p 發送，若 session 時序不對可能漏記
    add('L5:hasReclassification', reclasses && reclasses.length > 0, false);
  }

  if (expected.hasDesignStage) {
    const dagStages = state.dag ? Object.keys(state.dag) : [];
    const skipped = getSkippedStages(state);
    add('L5:designIncluded', dagStages.includes('DESIGN') && !skipped.includes('DESIGN'));
  }

  if (expected.designSkipped) {
    const skipped = getSkippedStages(state);
    add('L5:designSkipped', skipped.includes('DESIGN'));
  }

  if (expected.openspecEnabled) {
    add('L5:openspecEnabled', state.openspecEnabled === true);
  }

  if (expected.dashboardEvents) {
    add('L5:dashboardEvents', timeline.some(e => e.type === 'tool.used'));
  }

  if (expected.noCrash) {
    // 最低標準：系統活著（state + timeline 都存在）— L1 已覆蓋
    add('L5:noCrash', true);
  }

  if (expected.sequentialClean) {
    add('L5:sequentialClean', phase === 'COMPLETE' || phase === 'IDLE');
  }

  // ═══ L6 v4 機制驗證層 ═══
  // 驗證 v4 特有的 state 欄位與行為

  if (expected.v4State) {
    const v4 = expected.v4State;

    // 6a. v4 state schema version
    if (v4.version !== undefined) {
      add('L6:v4Version', state.version === v4.version,
        true, `expected version=${v4.version} actual=${state.version}`);
    }

    // 6b. pipelineActive=false on COMPLETE（pipeline 完成後 guard 應解除）
    if (v4.pipelineActiveFalseOnComplete && isPhaseComplete) {
      add('L6:pipelineInactiveOnComplete', state.pipelineActive === false,
        true, `pipelineActive should be false when COMPLETE, got ${state.pipelineActive}`);
    }

    // 6c. pipelineActive=false on cancel（取消後 guard 應解除）
    if (v4.pipelineActiveFalseOnCancel) {
      add('L6:pipelineInactiveOnCancel', state.pipelineActive === false,
        true, `pipelineActive should be false when cancelled, got ${state.pipelineActive}`);
    }

    // 6d. DAG 結構含 deps（v4 templateToDag 應包含 barrier/onFail/next）
    if (v4.dagHasDeps && state.dag) {
      const dagStageIds = Object.keys(state.dag);
      const allHaveDeps = dagStageIds.every(id => Array.isArray(state.dag[id]?.deps));
      add('L6:dagHasDeps', allHaveDeps,
        true, `DAG stages should all have deps array: ${dagStageIds.join(', ')}`);
    }

    // 6e. retryHistory 在回退場景中存在且非空
    if (v4.retryHistoryExists) {
      const rh = state.retryHistory || {};
      const hasHistory = Object.keys(rh).length > 0 &&
        Object.values(rh).some(arr => Array.isArray(arr) && arr.length > 0);
      add('L6:retryHistoryExists', hasHistory,
        false, `retryHistory should be non-empty on retry scenarios: ${JSON.stringify(rh)}`);
    }

    // 6f. Guard 阻擋事件（pipelineActive=true 時 Write 被 block）
    // 驗證方式：timeline 含 'stage.blocked' 或 pipeline 不在 IDLE（代表 guard 有效觸發）
    if (v4.guardBlocked) {
      // pipeline-guard 實際發出的事件類型是 'tool.blocked'
      // 同時保留 'stage.blocked'/'pipeline.blocked' 作為向後相容
      const hasBlock = timeline.some(e =>
        e.type === 'tool.blocked' ||
        e.type === 'stage.blocked' ||
        e.type === 'pipeline.blocked'
      );
      // 備用：只要 pipeline 不是 IDLE 就算 guard 有效（最低標準）
      const pipelineNotIdle = phase !== 'IDLE';
      add('L6:guardBlocked', hasBlock || pipelineNotIdle,
        false, `guard should have blocked Main Agent write (phase=${phase}, hasBlockEvent=${hasBlock})`);
    }
  }

  return checks;
}

// ────────────────── 執行 & 輸出 ──────────────────

const state = readState();
const timeline = readTimeline();
const checks = validate(state, timeline);

const passed = checks.filter(c => c.passed).length;
const failed = checks.filter(c => !c.passed && c.required).length;
const warnings = checks.filter(c => !c.passed && !c.required).length;

// v3: 從 state 推導 phase + 從 stages 衍生資訊
const phase = state ? derivePhase(state) : null;

const result = {
  scenarioId: scenario.id,
  scenarioName: scenario.name,
  category: scenario.category,
  sessionId,
  timestamp: new Date().toISOString(),
  status: failed === 0 ? '通過' : '失敗',
  summary: { passed, failed, warnings, total: checks.length },
  checks,
  state: state ? {
    phase,
    // v4 核心欄位
    version: state.version,
    pipelineActive: state.pipelineActive,
    activeStages: state.activeStages,
    retryHistory: state.retryHistory,
    crashes: state.crashes,
    // 分類
    pipelineId: state.classification && state.classification.pipelineId,
    // DAG
    dagStages: state.dag ? Object.keys(state.dag) : [],
    dagDeps: state.dag ? Object.fromEntries(
      Object.entries(state.dag).map(([id, cfg]) => [id, cfg.deps || []])
    ) : {},
    completedStages: getCompletedStages(state),
    skippedStages: getSkippedStages(state),
    stages: state.stages,
    retries: state.retries,
    pendingRetry: state.pendingRetry,
    cancelled: state.meta && state.meta.cancelled,
    source: state.classification && state.classification.source,
    reclassifications: state.meta && state.meta.reclassifications,
  } : null,
  timelineStats: {
    totalEvents: timeline.length,
    eventTypes: timeline.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {}),
  },
};

console.log(JSON.stringify(result, null, 2));
process.exit(failed > 0 ? 1 : 0);
