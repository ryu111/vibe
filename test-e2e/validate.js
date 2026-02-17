#!/usr/bin/env node
/**
 * validate.js — Pipeline E2E 驗證模組
 *
 * 驗證模型基於 FSM 語意：
 *   phase=COMPLETE → FSM 保證所有品質閘門通過，驗證重點是一致性
 *   phase=IDLE + none → 分類正確即成功
 *   其他 phase → 非預期終態，驗證失敗
 *
 * 驗證分五層：
 *   L1 結構層 — state/timeline 存在
 *   L2 分類層 — pipelineId、expectedStages 匹配
 *   L3 完成層 — 基於 phase 的一致性檢查（FSM 衍生，非獨立判斷）
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
  try {
    return JSON.parse(fs.readFileSync(
      path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`), 'utf8'));
  } catch { return null; }
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

  // ═══ L2 分類層 ═══
  if (expected.pipelineId) {
    const actual = state.context && state.context.pipelineId;
    add('L2:pipelineId', actual === expected.pipelineId,
      true, `expected=${expected.pipelineId} actual=${actual}`);
  }

  if (expected.phase) {
    add('L2:phase', state.phase === expected.phase,
      true, `expected=${expected.phase} actual=${state.phase}`);
  }

  if (expected.stages) {
    const actual = state.context && state.context.expectedStages;
    add('L2:stages', deepEqual(actual, expected.stages),
      true, `expected=${JSON.stringify(expected.stages)} actual=${JSON.stringify(actual)}`);
  }

  if (expected.stageCount !== undefined) {
    const actual = (state.context && state.context.expectedStages) || [];
    add('L2:stageCount', actual.length === expected.stageCount,
      true, `expected=${expected.stageCount} actual=${actual.length}`);
  }

  if (expected.source !== undefined && expected.source !== null) {
    const actual = state.meta && state.meta.classificationSource;
    add('L2:source', actual === expected.source,
      false, `expected=${expected.source} actual=${actual}`);
  }

  // ═══ L3 完成層（基於 phase 的 FSM 一致性）═══
  const isComplete = state.phase === 'COMPLETE';
  const isNone = (state.context && state.context.pipelineId) === 'none';

  if (isComplete) {
    // COMPLETE → FSM 已保證品質閘門通過，這裡只驗一致性

    // 3a. completedAgents 數量 ≥ 非跳過階段數
    const stages = (state.context && state.context.expectedStages) || [];
    const skipped = (state.progress && state.progress.skippedStages) || [];
    const agents = (state.progress && state.progress.completedAgents) || [];
    const expectedAgentCount = stages.length - skipped.length;
    add('L3:completedAgents', agents.length >= expectedAgentCount,
      false, `expected>=${expectedAgentCount} actual=${agents.length}`);

    // 3b. pendingRetry 已消費（不應殘留）
    const pending = state.progress && state.progress.pendingRetry;
    add('L3:noPendingRetry', pending === null || pending === undefined);

    // 3c. 品質階段 verdict 一致性（COMPLETE 保證 PASS，這裡是 double-check）
    const results = (state.progress && state.progress.stageResults) || {};
    const qualityResults = Object.entries(results)
      .filter(([stage]) => QUALITY_STAGES.includes(stage));
    if (qualityResults.length > 0) {
      const allQualityPass = qualityResults.every(([, r]) => {
        const v = typeof r === 'string' ? r : (r && r.verdict);
        return v === 'PASS';
      });
      add('L3:qualityVerdicts', allQualityPass,
        false, `quality stages: ${qualityResults.map(([s, r]) => `${s}=${typeof r === 'string' ? r : r.verdict}`).join(', ')}`);
    }
  }

  // retries 在限制內（任何 phase 都檢查）
  const retries = (state.progress && state.progress.retries) || {};
  const maxRetry = Math.max(0, ...Object.values(retries));
  add('L3:retriesWithinLimit', maxRetry <= 3,
    true, `max=${maxRetry}`);

  // ═══ L4 Timeline 層 ═══
  add('L4:hasClassified', timeline.some(e => e.type === 'task.classified'));

  if (isComplete) {
    add('L4:hasPipelineComplete', timeline.some(e => e.type === 'pipeline.complete'),
      false);
  }

  if (!isNone && (isComplete || state.phase === 'DELEGATING' || state.phase === 'RETRYING')) {
    add('L4:hasDelegation', timeline.some(e => e.type === 'delegation.start'),
      false);
  }

  // ═══ L5 場景特化層 ═══

  if (expected.cancelled) {
    add('L5:cancelled', state.meta && state.meta.cancelled === true);
  }

  if (expected.hasRetries) {
    const hasAny = Object.values(retries).some(c => c > 0);
    add('L5:hasRetries', hasAny);
  }

  if (expected.hasReclassification) {
    const reclasses = state.meta && state.meta.reclassifications;
    add('L5:hasReclassification', reclasses && reclasses.length > 0);
  }

  if (expected.hasDesignStage) {
    const stages = (state.context && state.context.expectedStages) || [];
    const skipped = (state.progress && state.progress.skippedStages) || [];
    add('L5:designIncluded', stages.includes('DESIGN') && !skipped.includes('DESIGN'));
  }

  if (expected.designSkipped) {
    const skipped = (state.progress && state.progress.skippedStages) || [];
    add('L5:designSkipped', skipped.includes('DESIGN'));
  }

  if (expected.openspecEnabled) {
    add('L5:openspecEnabled', state.context && state.context.openspecEnabled === true);
  }

  if (expected.dashboardEvents) {
    add('L5:dashboardEvents', timeline.some(e => e.type === 'tool.used'));
  }

  if (expected.noCrash) {
    // 最低標準：系統活著（state + timeline 都存在）— L1 已覆蓋
    add('L5:noCrash', true);
  }

  if (expected.sequentialClean) {
    add('L5:sequentialClean', state.phase === 'COMPLETE' || state.phase === 'IDLE');
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

const result = {
  scenarioId: scenario.id,
  scenarioName: scenario.name,
  category: scenario.category,
  sessionId,
  timestamp: new Date().toISOString(),
  status: failed === 0 ? 'PASS' : 'FAIL',
  summary: { passed, failed, warnings, total: checks.length },
  checks,
  state: state ? {
    phase: state.phase,
    pipelineId: state.context && state.context.pipelineId,
    expectedStages: state.context && state.context.expectedStages,
    completedAgents: state.progress && state.progress.completedAgents,
    skippedStages: state.progress && state.progress.skippedStages,
    stageResults: state.progress && state.progress.stageResults,
    retries: state.progress && state.progress.retries,
    pendingRetry: state.progress && state.progress.pendingRetry,
    cancelled: state.meta && state.meta.cancelled,
    source: state.meta && state.meta.classificationSource,
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
