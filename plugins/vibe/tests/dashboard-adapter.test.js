#!/usr/bin/env node
/**
 * dashboard-adapter.test.js — Dashboard State 適配層單元測試
 *
 * 測試範圍：
 *   1. adaptState()：DAG state → Dashboard 相容格式轉換（複製自 web/index.html，可獨立測試）
 *   2. pct()：進度百分比計算（含 skippedStages 排除）
 *   3. bot.js handleStatus / handleStages 欄位讀取邏輯（純邏輯萃取，不依賴 Telegram）
 *   4. remote-hub.js buildProgressBar dagStages 參數（確認已無 expectedStages 殘留）
 *
 * 策略：
 *   - adaptState / pct 在 index.html 中無法 require，故在測試中複製核心邏輯（同 e2e-formats.test.js 的 formatter.js 做法）
 *   - bot.js / remote-hub.js 邏輯以純函式形式萃取驗證
 *
 * 執行：node plugins/vibe/tests/dashboard-adapter.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./test-helpers').cleanTestStateFiles();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`     ${err.message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ═══════════════════════════════════════════════════════════════
// 複製自 web/index.html（adaptState + pct）供測試使用
// 若 index.html 修改，此處需同步更新
// ═══════════════════════════════════════════════════════════════

/**
 * 複製自 web/index.html adaptState 函式
 * 將 DAG state 轉換為 Dashboard 相容格式
 * （含 M-4 修正：isPipelineComplete + cancelled 欄位）
 */
function adaptState(raw) {
  if (!raw || !raw.dag) {
    return {
      ...raw,
      expectedStages: raw?.expectedStages || [],
      stageResults: raw?.stageResults || {},
      currentStage: raw?.currentStage || null,
      delegationActive: raw?.delegationActive || false,
      taskType: raw?.classification?.taskType || raw?.taskType || null,
      pipelineId: raw?.classification?.pipelineId || raw?.pipelineId || null,
      lastTransition: raw?.meta?.lastTransition || raw?.lastTransition || null,
      startedAt: raw?.classification?.classifiedAt || raw?.startedAt || null,
      completed: raw?.completed || [],
      skippedStages: raw?.skippedStages || [],
      retries: raw?.retries || {},
      environment: raw?.environment || {},
      isPipelineComplete: false,
      cancelled: false,
    };
  }

  const stages = raw.stages || {};
  const dagKeys = Object.keys(raw.dag);

  const stageResults = {};
  for (const [id, info] of Object.entries(stages)) {
    if (info?.status === 'completed' || info?.status === 'failed') {
      const v = info.verdict;
      if (!v) continue;
      const verdictStr = (typeof v === 'object' && v !== null) ? (v.verdict || null) : v;
      if (!verdictStr) continue;
      stageResults[id] = {
        verdict: verdictStr,
        severity: (typeof v === 'object' && v !== null) ? v.severity : undefined,
        duration: (info.startedAt && info.completedAt)
          ? Math.round((new Date(info.completedAt) - new Date(info.startedAt)) / 1000)
          : undefined,
        completedAt: info.completedAt,
      };
    }
  }

  const activeStage = dagKeys.find(id => stages[id]?.status === 'active') || null;

  const completed = dagKeys
    .filter(id => stages[id]?.status === 'completed')
    .map(id => stages[id]?.agent)
    .filter(Boolean);

  const skippedStages = dagKeys.filter(id => stages[id]?.status === 'skipped');

  // M-4：Pipeline 完成旗標（所有 stage 都是 completed/skipped/failed）
  const isPipelineComplete = dagKeys.length > 0 && dagKeys.every(id => {
    const st = stages[id]?.status;
    return st === 'completed' || st === 'skipped' || st === 'failed';
  });

  // M-4：偵測 cancelled 狀態
  // cancelled = pipelineActive=false，但有分類且尚未全部完成，且無活躍委派
  const hasActiveClassification = !!(raw.classification?.pipelineId || raw.classification?.taskType);
  const cancelled = !raw.pipelineActive && !isPipelineComplete && hasActiveClassification && !activeStage;

  return {
    ...raw,
    expectedStages: dagKeys,
    isPipelineComplete,
    cancelled,
    stageResults,
    currentStage: activeStage,
    delegationActive: !!activeStage,
    taskType: raw.classification?.taskType || null,
    pipelineId: raw.classification?.pipelineId || null,
    lastTransition: raw.meta?.lastTransition || null,
    startedAt: raw.classification?.classifiedAt || null,
    completed,
    skippedStages,
    retries: raw.retries || {},
    environment: raw.environment || {},
  };
}

/**
 * 複製自 web/index.html pct 函式
 * 計算 pipeline 進度百分比，排除 skippedStages
 */
function pct(s) {
  if (!s?.expectedStages?.length) return 0;
  const active = s.expectedStages.filter(st => !s.skippedStages?.includes(st));
  if (!active.length) return 0;
  return Math.round(active.filter(st => s.stageResults?.[st]?.verdict === 'PASS').length / active.length * 100);
}

// ═══════════════════════════════════════════════════════════════
// 輔助建構函式
// ═══════════════════════════════════════════════════════════════

function makeStage(status, opts = {}) {
  return {
    status,
    agent: opts.agent || null,
    verdict: opts.verdict !== undefined ? opts.verdict : null,
    startedAt: opts.startedAt || null,
    completedAt: opts.completedAt || null,
  };
}

function makeDashboardTestState(opts = {}) {
  const stages = opts.stages || ['PLAN', 'DEV', 'REVIEW', 'TEST'];
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = { deps: i > 0 ? [stages[i - 1]] : [] };
  }

  const stagesObj = {};
  for (const s of stages) {
    stagesObj[s] = makeStage('pending');
  }
  if (opts.stageOverrides) {
    for (const [k, v] of Object.entries(opts.stageOverrides)) {
      stagesObj[k] = v;
    }
  }

  return {
    version: 3,
    sessionId: opts.sessionId || 'test-session-1',
    dag,
    stages: stagesObj,
    classification: opts.classification || null,
    meta: opts.meta || { lastTransition: new Date().toISOString() },
    retries: opts.retries || {},
    environment: opts.environment || {},
  };
}

// ═══════════════════════════════════════════════════════════════
// Section 1：adaptState — 正常轉換
// ═══════════════════════════════════════════════════════════════

section('adaptState：state 正常轉換');

test('應該產出 expectedStages 為 DAG key 陣列', () => {
  const raw = makeDashboardTestState({ stages: ['PLAN', 'DEV', 'TEST'] });
  const result = adaptState(raw);
  assert.deepStrictEqual(result.expectedStages, ['PLAN', 'DEV', 'TEST']);
});

test('應該產出 stageResults 物件', () => {
  const raw = makeDashboardTestState();
  const result = adaptState(raw);
  assert.ok(typeof result.stageResults === 'object', 'stageResults 應為物件');
});

test('應該產出 currentStage 欄位', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      DEV: makeStage('active'),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.currentStage, 'DEV');
});

test('應該產出 delegationActive 布林值 當有 active stage 時為 true', () => {
  const raw = makeDashboardTestState({
    stageOverrides: { DEV: makeStage('active') },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.delegationActive, true);
});

test('應該產出 delegationActive 為 false 當無 active stage', () => {
  const raw = makeDashboardTestState();
  const result = adaptState(raw);
  assert.strictEqual(result.delegationActive, false);
});

// ═══════════════════════════════════════════════════════════════
// Section 2：adaptState — verdict 格式展平
// ═══════════════════════════════════════════════════════════════

section('adaptState：verdict 格式展平');

test('應該展平 verdict 物件格式為 stageResults 條目', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: { verdict: 'PASS', severity: 'LOW' } }),
    },
  });
  const result = adaptState(raw);
  assert.ok(result.stageResults.PLAN, 'PLAN 應在 stageResults');
  assert.strictEqual(result.stageResults.PLAN.verdict, 'PASS');
  assert.strictEqual(result.stageResults.PLAN.severity, 'LOW');
});

test('應該展平 verdict 字串格式 PASS 為 stageResults 條目', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.ok(result.stageResults.PLAN, 'PLAN 應在 stageResults');
  assert.strictEqual(result.stageResults.PLAN.verdict, 'PASS');
});

test('應該展平 verdict 字串格式 FAIL 為 stageResults 條目', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      REVIEW: makeStage('failed', { verdict: 'FAIL' }),
    },
  });
  const result = adaptState(raw);
  assert.ok(result.stageResults.REVIEW, 'REVIEW 應在 stageResults');
  assert.strictEqual(result.stageResults.REVIEW.verdict, 'FAIL');
});

test('應該不在 stageResults 產出 verdict 為 null 的 stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: null }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN, undefined, 'verdict null 的 stage 不應出現在 stageResults');
});

test('應該不在 stageResults 產出 pending stage', () => {
  const raw = makeDashboardTestState();
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.DEV, undefined, 'pending stage 不應出現在 stageResults');
});

test('應該不在 stageResults 產出 active stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: { DEV: makeStage('active') },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.DEV, undefined, 'active stage 不應出現在 stageResults');
});

test('應該展平 verdict 物件的 FAIL + HIGH severity', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      REVIEW: makeStage('failed', { verdict: { verdict: 'FAIL', severity: 'HIGH' } }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.REVIEW.verdict, 'FAIL');
  assert.strictEqual(result.stageResults.REVIEW.severity, 'HIGH');
});

test('應該展平 verdict 物件時 severity undefined 若原始無 severity', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      TEST: makeStage('completed', { verdict: { verdict: 'PASS' } }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.TEST.verdict, 'PASS');
  assert.strictEqual(result.stageResults.TEST.severity, undefined);
});

// ═══════════════════════════════════════════════════════════════
// Section 3：adaptState — duration 計算
// ═══════════════════════════════════════════════════════════════

section('adaptState：duration 計算');

test('應該計算 duration（秒）當 startedAt 和 completedAt 都存在', () => {
  const startedAt = '2026-02-18T10:00:00.000Z';
  const completedAt = '2026-02-18T10:01:30.000Z'; // 90 秒後
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', {
        verdict: 'PASS',
        startedAt,
        completedAt,
      }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN.duration, 90);
});

test('應該計算 duration 為 0 當 startedAt 等於 completedAt', () => {
  const ts = '2026-02-18T10:00:00.000Z';
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', {
        verdict: 'PASS',
        startedAt: ts,
        completedAt: ts,
      }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN.duration, 0);
});

test('應該 duration 為 undefined 當 startedAt 缺失', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', {
        verdict: 'PASS',
        startedAt: null,
        completedAt: '2026-02-18T10:01:30.000Z',
      }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN.duration, undefined);
});

test('應該 duration 為 undefined 當 completedAt 缺失', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', {
        verdict: 'PASS',
        startedAt: '2026-02-18T10:00:00.000Z',
        completedAt: null,
      }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN.duration, undefined);
});

test('應該 duration 為 undefined 當兩者都缺失', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN.duration, undefined);
});

// ═══════════════════════════════════════════════════════════════
// Section 4：adaptState — 無 DAG fallback
// ═══════════════════════════════════════════════════════════════

section('adaptState：無 DAG fallback');

test('應該產出 expectedStages: [] 當 dag 為 null', () => {
  const raw = { version: 3, dag: null, stages: {}, classification: null, meta: {} };
  const result = adaptState(raw);
  assert.deepStrictEqual(result.expectedStages, []);
});

test('應該產出 delegationActive: false 當 dag 為 null', () => {
  const raw = { version: 3, dag: null, stages: {} };
  const result = adaptState(raw);
  assert.strictEqual(result.delegationActive, false);
});

test('應該產出 currentStage: null 當 dag 為 null', () => {
  const raw = { version: 3, dag: null, stages: {} };
  const result = adaptState(raw);
  assert.strictEqual(result.currentStage, null);
});

test('應該提取 taskType 從 classification 即使 dag 為 null', () => {
  const raw = {
    version: 3,
    dag: null,
    stages: {},
    classification: { taskType: 'feature', pipelineId: 'standard' },
  };
  const result = adaptState(raw);
  assert.strictEqual(result.taskType, 'feature');
  assert.strictEqual(result.pipelineId, 'standard');
});

test('應該處理 null input 回傳 fallback 物件', () => {
  const result = adaptState(null);
  assert.deepStrictEqual(result.expectedStages, []);
  assert.deepStrictEqual(result.stageResults, {});
  assert.strictEqual(result.currentStage, null);
  assert.strictEqual(result.delegationActive, false);
});

test('應該處理 undefined input 回傳 fallback 物件', () => {
  const result = adaptState(undefined);
  assert.deepStrictEqual(result.expectedStages, []);
  assert.deepStrictEqual(result.stageResults, {});
  assert.strictEqual(result.currentStage, null);
  assert.strictEqual(result.delegationActive, false);
});

test('應該保留原始欄位當 dag 為 null（展開運算子）', () => {
  const raw = {
    sessionId: 'abc',
    dag: null,
    stages: {},
    customField: 'keep-me',
  };
  const result = adaptState(raw);
  assert.strictEqual(result.sessionId, 'abc');
  assert.strictEqual(result.customField, 'keep-me');
});

// ═══════════════════════════════════════════════════════════════
// Section 5：adaptState — completed agent 列表推導
// ═══════════════════════════════════════════════════════════════

section('adaptState：completed agent 列表推導');

test('應該在 completed 包含已完成 stage 的 agent 名稱', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { agent: 'vibe:planner', verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.ok(result.completed.includes('vibe:planner'), 'completed 應包含 agent');
});

test('應該在 completed 排除 agent 為 null 的已完成 stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { agent: null, verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.completed.length, 0, 'agent 為 null 時 completed 應為空');
});

test('應該在 completed 不包含 skipped 或 pending stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('skipped'),
      DEV: makeStage('pending'),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.completed.length, 0);
});

test('應該正確推導多個已完成 stage 的 agents', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { agent: 'vibe:planner', verdict: 'PASS' }),
      DEV: makeStage('completed', { agent: 'vibe:developer', verdict: 'PASS' }),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.completed.length, 2);
  assert.ok(result.completed.includes('vibe:planner'));
  assert.ok(result.completed.includes('vibe:developer'));
});

// ═══════════════════════════════════════════════════════════════
// Section 6：adaptState — skippedStages 推導
// ═══════════════════════════════════════════════════════════════

section('adaptState：skippedStages 推導');

test('應該在 skippedStages 包含 status === skipped 的 stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      REVIEW: makeStage('skipped'),
    },
  });
  const result = adaptState(raw);
  assert.ok(result.skippedStages.includes('REVIEW'), 'REVIEW 應在 skippedStages');
});

test('應該 skippedStages 為空陣列 當無 skipped stage', () => {
  const raw = makeDashboardTestState();
  const result = adaptState(raw);
  assert.deepStrictEqual(result.skippedStages, []);
});

test('應該正確推導多個 skipped stages', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { agent: 'vibe:planner', verdict: 'PASS' }),
      DEV: makeStage('skipped'),
      REVIEW: makeStage('skipped'),
      TEST: makeStage('pending'),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.skippedStages.length, 2);
  assert.ok(result.skippedStages.includes('DEV'));
  assert.ok(result.skippedStages.includes('REVIEW'));
});

// ═══════════════════════════════════════════════════════════════
// Section 7：adaptState — classification / meta 映射
// ═══════════════════════════════════════════════════════════════

section('adaptState：classification / meta 映射');

test('應該映射 classification.taskType 到頂層 taskType', () => {
  const raw = makeDashboardTestState({
    classification: { taskType: 'feature', pipelineId: 'standard', classifiedAt: '2026-02-18T09:00:00.000Z' },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.taskType, 'feature');
});

test('應該映射 classification.pipelineId 到頂層 pipelineId', () => {
  const raw = makeDashboardTestState({
    classification: { pipelineId: 'quick-dev', taskType: 'bugfix', classifiedAt: '2026-02-18T09:00:00.000Z' },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.pipelineId, 'quick-dev');
});

test('應該映射 meta.lastTransition 到頂層 lastTransition', () => {
  const ts = '2026-02-18T10:30:00.000Z';
  const raw = makeDashboardTestState({ meta: { lastTransition: ts } });
  const result = adaptState(raw);
  assert.strictEqual(result.lastTransition, ts);
});

test('應該映射 classification.classifiedAt 到頂層 startedAt', () => {
  const ts = '2026-02-18T08:00:00.000Z';
  const raw = makeDashboardTestState({
    classification: { pipelineId: 'standard', classifiedAt: ts },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.startedAt, ts);
});

test('應該 taskType 為 null 當 classification 為 null 且有 DAG', () => {
  const raw = makeDashboardTestState({ classification: null });
  const result = adaptState(raw);
  assert.strictEqual(result.taskType, null);
});

test('應該保留 retries 物件', () => {
  const raw = makeDashboardTestState({ retries: { REVIEW: 2, TEST: 1 } });
  const result = adaptState(raw);
  assert.deepStrictEqual(result.retries, { REVIEW: 2, TEST: 1 });
});

test('應該保留 environment 物件', () => {
  const raw = makeDashboardTestState({ environment: { language: 'typescript', framework: { name: 'next' } } });
  const result = adaptState(raw);
  assert.deepStrictEqual(result.environment.language, 'typescript');
});

// ═══════════════════════════════════════════════════════════════
// Section 8：pct() — 進度百分比計算
// ═══════════════════════════════════════════════════════════════

section('pct()：進度百分比計算');

test('應該回傳 0 當 expectedStages 為空', () => {
  const s = { expectedStages: [], stageResults: {}, skippedStages: [] };
  assert.strictEqual(pct(s), 0);
});

test('應該回傳 0 當 input 為 null', () => {
  assert.strictEqual(pct(null), 0);
});

test('應該回傳 100 當所有 non-skipped stages 都是 PASS', () => {
  const adapted = adaptState(makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('completed', { verdict: 'PASS' }),
      REVIEW: makeStage('completed', { verdict: 'PASS' }),
      TEST: makeStage('completed', { verdict: 'PASS' }),
    },
  }));
  assert.strictEqual(pct(adapted), 100);
});

test('應該回傳 50 當一半 stages 為 PASS', () => {
  const adapted = adaptState(makeDashboardTestState({
    stages: ['PLAN', 'DEV'],
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('pending'),
    },
  }));
  assert.strictEqual(pct(adapted), 50);
});

test('應該排除 skippedStages 計算分母 使含 skipped stages 的 pipeline 能達到 100%', () => {
  // full pipeline：PLAN ARCH DESIGN DEV REVIEW TEST QA E2E DOCS
  // DESIGN 被跳過，其餘全 PASS → 應得 100%
  const adapted = adaptState(makeDashboardTestState({
    stages: ['PLAN', 'DEV', 'REVIEW', 'TEST'],
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('skipped'),
      REVIEW: makeStage('completed', { verdict: 'PASS' }),
      TEST: makeStage('completed', { verdict: 'PASS' }),
    },
  }));
  // skippedStages = [DEV]，分母 = 3，pass = 3 → 100%
  assert.strictEqual(pct(adapted), 100);
});

test('應該排除 skippedStages 正確計算部分完成的進度', () => {
  // 4 stages，1 skipped，2 pass，1 pending → 2/3 ≈ 67%
  const adapted = adaptState(makeDashboardTestState({
    stages: ['PLAN', 'DEV', 'REVIEW', 'TEST'],
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('skipped'),
      REVIEW: makeStage('completed', { verdict: 'PASS' }),
      TEST: makeStage('pending'),
    },
  }));
  assert.strictEqual(pct(adapted), 67);
});

test('應該回傳 0 當所有 stages 都被 skipped', () => {
  const adapted = adaptState(makeDashboardTestState({
    stages: ['DEV'],
    stageOverrides: {
      DEV: makeStage('skipped'),
    },
  }));
  // active = []，長度 0 → 回傳 0
  assert.strictEqual(pct(adapted), 0);
});

test('應該忽略 FAIL verdict 不計入 PASS 計數', () => {
  const adapted = adaptState(makeDashboardTestState({
    stages: ['PLAN', 'DEV'],
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('failed', { verdict: 'FAIL' }),
    },
  }));
  assert.strictEqual(pct(adapted), 50);
});

// ═══════════════════════════════════════════════════════════════
// Section 9：bot.js handleStatus 邏輯萃取驗證
// ═══════════════════════════════════════════════════════════════

section('bot.js handleStatus：欄位讀取邏輯');

/**
 * 萃取 handleStatus 的過濾 + 進度計算邏輯（不依賴 Telegram 發送）
 */
function simulateHandleStatus(sessions) {
  // 複製自 bot.js handleStatus 的核心邏輯
  const activeSessions = sessions.filter(s =>
    s.dag && Object.keys(s.dag).length > 0
  );

  const lines = activeSessions.map(s => {
    const stagesMap = s.stages || {};
    const doneStages = Object.keys(stagesMap).filter(id =>
      stagesMap[id]?.status === 'completed' || stagesMap[id]?.status === 'skipped');
    const expected = Object.keys(s.dag || {});
    const progress = expected.length > 0
      ? Math.round((doneStages.length / expected.length) * 100)
      : 0;
    const taskType = s.classification?.taskType || 'unknown';
    return { id: s.id, taskType, progress };
  });

  return { activeSessions, lines };
}

test('應該只列出有 DAG 的 session', () => {
  const sessions = [
    { id: 'session-with-dag', dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] } }, stages: {}, classification: null },
    { id: 'session-no-dag', dag: null, stages: {} },
    { id: 'session-empty-dag', dag: {}, stages: {} },
  ];
  const { activeSessions } = simulateHandleStatus(sessions);
  assert.strictEqual(activeSessions.length, 1);
  assert.strictEqual(activeSessions[0].id, 'session-with-dag');
});

test('應該回傳空 activeSessions 當所有 session 無 DAG', () => {
  const sessions = [
    { id: 'no-dag-1', dag: null, stages: {} },
    { id: 'no-dag-2', dag: {}, stages: {} },
  ];
  const { activeSessions } = simulateHandleStatus(sessions);
  assert.strictEqual(activeSessions.length, 0);
});

test('應該正確計算進度百分比（含 skipped 計入分子）', () => {
  const sessions = [{
    id: 'test-progress',
    dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'skipped' },
      REVIEW: { status: 'pending' },
    },
    classification: { taskType: 'feature' },
  }];
  const { lines } = simulateHandleStatus(sessions);
  // completed=1 + skipped=1 = 2，expected=3 → 67%
  assert.strictEqual(lines[0].progress, 67);
});

test('應該讀取 classification.taskType 取得 taskType', () => {
  const sessions = [{
    id: 'test-tasktype',
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    classification: { taskType: 'bugfix', pipelineId: 'quick-dev' },
  }];
  const { lines } = simulateHandleStatus(sessions);
  assert.strictEqual(lines[0].taskType, 'bugfix');
});

test('應該回傳 unknown 當 classification 為 null', () => {
  const sessions = [{
    id: 'test-no-class',
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
    classification: null,
  }];
  const { lines } = simulateHandleStatus(sessions);
  assert.strictEqual(lines[0].taskType, 'unknown');
});

test('應該計算進度 100% 當所有 stages 完成', () => {
  const sessions = [{
    id: 'test-complete',
    dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] } },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'completed' },
    },
    classification: { taskType: 'feature' },
  }];
  const { lines } = simulateHandleStatus(sessions);
  assert.strictEqual(lines[0].progress, 100);
});

// ═══════════════════════════════════════════════════════════════
// Section 10：bot.js handleStages 邏輯萃取驗證
// ═══════════════════════════════════════════════════════════════

section('bot.js handleStages：欄位讀取邏輯');

/**
 * 萃取 handleStages 的欄位讀取邏輯（不依賴 Telegram 發送）
 */
function simulateHandleStages(target) {
  // 複製自 bot.js handleStages 的核心邏輯
  const stagesMap = target.stages || {};
  const completedStages = Object.keys(stagesMap).filter(id => stagesMap[id]?.status === 'completed');
  const results = {};
  for (const [id, info] of Object.entries(stagesMap)) {
    if (info?.verdict) {
      const rawVerdict = info.verdict;
      const verdictStr = (typeof rawVerdict === 'object' && rawVerdict !== null)
        ? (rawVerdict.verdict || null)
        : rawVerdict;
      if (verdictStr) {
        const sev = (typeof rawVerdict === 'object') ? rawVerdict.severity : undefined;
        results[id] = { verdict: verdictStr, severity: sev };
      }
    }
  }
  const dagStages = Object.keys(target.dag || {});
  return { completedStages, results, dagStages };
}

test('應該正確推導 completedStages 從 stages map', () => {
  const target = {
    dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] }, REVIEW: { deps: ['DEV'] } },
    stages: {
      PLAN: { status: 'completed', verdict: 'PASS' },
      DEV: { status: 'completed', verdict: 'PASS' },
      REVIEW: { status: 'pending', verdict: null },
    },
  };
  const { completedStages } = simulateHandleStages(target);
  assert.strictEqual(completedStages.length, 2);
  assert.ok(completedStages.includes('PLAN'));
  assert.ok(completedStages.includes('DEV'));
});

test('應該展平 verdict 物件 PASS 至 results', () => {
  const target = {
    dag: { PLAN: { deps: [] } },
    stages: {
      PLAN: { status: 'completed', verdict: { verdict: 'PASS', severity: null } },
    },
  };
  const { results } = simulateHandleStages(target);
  assert.strictEqual(results.PLAN?.verdict, 'PASS');
});

test('應該展平 verdict 物件 FAIL + severity 至 results', () => {
  const target = {
    dag: { REVIEW: { deps: [] } },
    stages: {
      REVIEW: { status: 'failed', verdict: { verdict: 'FAIL', severity: 'HIGH' } },
    },
  };
  const { results } = simulateHandleStages(target);
  assert.strictEqual(results.REVIEW?.verdict, 'FAIL');
  assert.strictEqual(results.REVIEW?.severity, 'HIGH');
});

test('應該不在 results 放入 verdict 為 null 的 stage', () => {
  const target = {
    dag: { DEV: { deps: [] } },
    stages: {
      DEV: { status: 'pending', verdict: null },
    },
  };
  const { results } = simulateHandleStages(target);
  assert.strictEqual(results.DEV, undefined);
});

test('應該不在 results 放入 verdict 為空字串的 stage', () => {
  const target = {
    dag: { DEV: { deps: [] } },
    stages: {
      DEV: { status: 'completed', verdict: '' },
    },
  };
  const { results } = simulateHandleStages(target);
  assert.strictEqual(results.DEV, undefined);
});

test('應該讀取 dagStages 從 dag keys', () => {
  const target = {
    dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] }, TEST: { deps: ['DEV'] } },
    stages: {},
  };
  const { dagStages } = simulateHandleStages(target);
  assert.deepStrictEqual(dagStages, ['PLAN', 'DEV', 'TEST']);
});

test('應該回傳空 dagStages 當 dag 為 null', () => {
  const target = {
    dag: null,
    stages: {},
  };
  const { dagStages } = simulateHandleStages(target);
  assert.deepStrictEqual(dagStages, []);
});

test('應該標記 pending stage 顯示白色方塊（非 completedStages 成員）', () => {
  const target = {
    dag: { TEST: { deps: [] } },
    stages: { TEST: { status: 'pending', verdict: null } },
  };
  const { completedStages } = simulateHandleStages(target);
  assert.ok(!completedStages.includes('TEST'), 'pending stage 不應在 completedStages');
});

test('應該標記 active stage 顯示白色方塊（非 completedStages 成員）', () => {
  const target = {
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'active', verdict: null } },
  };
  const { completedStages } = simulateHandleStages(target);
  assert.ok(!completedStages.includes('DEV'), 'active stage 不應在 completedStages');
});

// ═══════════════════════════════════════════════════════════════
// Section 11：remote-hub.js — dagStages 命名一致性
// ═══════════════════════════════════════════════════════════════

section('remote-hub.js：dagStages 命名一致性');

test('應該確認 remote-hub.js 中無 expectedStages 變數名殘留', () => {
  const remoteHubPath = path.join(__dirname, '..', 'scripts', 'hooks', 'remote-hub.js');
  const content = fs.readFileSync(remoteHubPath, 'utf8');

  // 排除函式參數名（buildProgressBar 的 function signature 和呼叫點）
  // 只檢查 const/let/var 宣告不應使用 expectedStages
  const lines = content.split('\n');
  const declarations = lines.filter(line =>
    /^\s*(const|let|var)\s+expectedStages\b/.test(line)
  );
  assert.strictEqual(declarations.length, 0,
    `remote-hub.js 中不應有 expectedStages 變數宣告，找到：${declarations.join('; ')}`);
});

test('應該確認 remote-hub.js 使用 dagStages 變數', () => {
  const remoteHubPath = path.join(__dirname, '..', 'scripts', 'hooks', 'remote-hub.js');
  const content = fs.readFileSync(remoteHubPath, 'utf8');
  assert.ok(content.includes('dagStages'), 'remote-hub.js 應使用 dagStages 變數');
});

test('應該確認 buildProgressBar 呼叫傳入 dagStages', () => {
  const remoteHubPath = path.join(__dirname, '..', 'scripts', 'hooks', 'remote-hub.js');
  const content = fs.readFileSync(remoteHubPath, 'utf8');
  assert.ok(
    content.includes('buildProgressBar(completedStages, stageResults, dagStages)'),
    'buildProgressBar 應傳入 dagStages 作為第三參數'
  );
});

// ═══════════════════════════════════════════════════════════════
// Section 12：remote-hub.js buildProgressBar 邏輯萃取驗證
// ═══════════════════════════════════════════════════════════════

section('remote-hub.js buildProgressBar：邏輯驗證');

/**
 * 萃取自 remote-hub.js buildProgressBar（不依賴 STAGES registry）
 */
function buildProgressBarLogic(completedStages, stageResults, dagStages) {
  const stages = dagStages || [];
  return stages.map(stage => {
    if (completedStages.includes(stage)) {
      const result = stageResults[stage];
      return result && result.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    }
    return 'PENDING';
  });
}

test('應該顯示 PASS 為已完成且有 PASS verdict 的 stage', () => {
  const bar = buildProgressBarLogic(
    ['PLAN'],
    { PLAN: { verdict: 'PASS' } },
    ['PLAN', 'DEV']
  );
  assert.strictEqual(bar[0], 'PASS');
  assert.strictEqual(bar[1], 'PENDING');
});

test('應該顯示 FAIL 為已完成且有 FAIL verdict 的 stage', () => {
  const bar = buildProgressBarLogic(
    ['REVIEW'],
    { REVIEW: { verdict: 'FAIL' } },
    ['REVIEW']
  );
  assert.strictEqual(bar[0], 'FAIL');
});

test('應該顯示 PENDING 為未完成的 stage', () => {
  const bar = buildProgressBarLogic(
    [],
    {},
    ['PLAN', 'DEV', 'TEST']
  );
  assert.ok(bar.every(v => v === 'PENDING'), '全部未完成應全為 PENDING');
});

test('應該用 dagStages 決定 bar 長度', () => {
  const bar = buildProgressBarLogic([], {}, ['A', 'B', 'C', 'D', 'E']);
  assert.strictEqual(bar.length, 5);
});

test('應該回傳空陣列當 dagStages 為空', () => {
  const bar = buildProgressBarLogic([], {}, []);
  assert.deepStrictEqual(bar, []);
});

// ═══════════════════════════════════════════════════════════════
// Section 13：adaptState 邊界案例
// ═══════════════════════════════════════════════════════════════

section('adaptState：邊界案例');

test('應該處理 stages 為空物件的 state', () => {
  const raw = {
    version: 3,
    dag: { PLAN: { deps: [] } },
    stages: {},
    classification: null,
    meta: {},
  };
  const result = adaptState(raw);
  assert.deepStrictEqual(result.expectedStages, ['PLAN']);
  assert.deepStrictEqual(result.stageResults, {});
  assert.strictEqual(result.currentStage, null);
  assert.strictEqual(result.delegationActive, false);
});

test('應該保留原始 raw 物件的所有頂層屬性', () => {
  const raw = makeDashboardTestState({ environment: { language: 'go' } });
  raw.customProp = 'preserved';
  const result = adaptState(raw);
  assert.strictEqual(result.customProp, 'preserved');
  assert.strictEqual(result.version, 3);
});

test('應該處理 verdict 物件無 verdict 欄位（v.verdict === undefined）', () => {
  // verdictStr = undefined → falsy → 不放入 stageResults
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: { severity: 'HIGH' } }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.stageResults.PLAN, undefined, 'verdict 物件無 verdict 欄位 → 不出現在 stageResults');
});

test('應該處理多個 active stage 時取第一個', () => {
  // 理論上不應發生，但防禦性測試
  const raw = makeDashboardTestState({
    stages: ['PLAN', 'DEV', 'REVIEW', 'TEST'],
    stageOverrides: {
      PLAN: makeStage('active'),
      DEV: makeStage('active'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
  });
  const result = adaptState(raw);
  // dagKeys.find 找到第一個 active = PLAN
  assert.strictEqual(result.currentStage, 'PLAN');
  assert.strictEqual(result.delegationActive, true);
});

test('應該 retries 預設為空物件當 raw.retries 未定義', () => {
  const raw = {
    version: 3,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
  };
  const result = adaptState(raw);
  assert.deepStrictEqual(result.retries, {});
});

test('應該 environment 預設為空物件當 raw.environment 未定義', () => {
  const raw = {
    version: 3,
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'pending' } },
  };
  const result = adaptState(raw);
  assert.deepStrictEqual(result.environment, {});
});

// ═══════════════════════════════════════════════════════════════
// Section 14：adaptState — M-4 cancelled + isPipelineComplete 偵測
// ═══════════════════════════════════════════════════════════════

section('adaptState M-4：cancelled + isPipelineComplete 偵測');

test('應該回傳 isPipelineComplete=true 當所有 stages 完成', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('completed', { verdict: 'PASS' }),
      REVIEW: makeStage('completed', { verdict: 'PASS' }),
      TEST: makeStage('completed', { verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.isPipelineComplete, true);
});

test('應該回傳 isPipelineComplete=false 當有 pending stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('pending'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.isPipelineComplete, false);
});

test('應該回傳 isPipelineComplete=true 當有 skipped 和 failed stage', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('skipped'),
      REVIEW: makeStage('failed', { verdict: 'FAIL' }),
      TEST: makeStage('completed', { verdict: 'PASS' }),
    },
  });
  const result = adaptState(raw);
  assert.strictEqual(result.isPipelineComplete, true);
});

test('應該回傳 isPipelineComplete=false 當 dag 為空', () => {
  const raw = {
    version: 3,
    dag: {},
    stages: {},
    classification: { pipelineId: 'standard', taskType: 'feature' },
    meta: {},
  };
  const result = adaptState(raw);
  assert.strictEqual(result.isPipelineComplete, false);
});

test('應該回傳 cancelled=true 當 pipelineActive=false 且有分類且未完成且無 active', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('pending'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
    classification: { pipelineId: 'standard', taskType: 'feature' },
  });
  raw.pipelineActive = false; // 已取消
  const result = adaptState(raw);
  assert.strictEqual(result.cancelled, true, '應偵測到 cancelled 狀態');
});

test('應該回傳 cancelled=false 當 pipelineActive=true（正常執行中）', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('active'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
    classification: { pipelineId: 'standard', taskType: 'feature' },
  });
  raw.pipelineActive = true;
  const result = adaptState(raw);
  assert.strictEqual(result.cancelled, false, '正常執行中不應是 cancelled');
});

test('應該回傳 cancelled=false 當無 classification（未分類）', () => {
  const raw = makeDashboardTestState({
    classification: null,
    stageOverrides: {
      PLAN: makeStage('pending'),
      DEV: makeStage('pending'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
  });
  raw.pipelineActive = false;
  const result = adaptState(raw);
  // hasActiveClassification = false → cancelled = false
  assert.strictEqual(result.cancelled, false, '未分類不應是 cancelled');
});

test('應該回傳 cancelled=false 當 isPipelineComplete=true（已完成不是取消）', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('completed', { verdict: 'PASS' }),
      REVIEW: makeStage('completed', { verdict: 'PASS' }),
      TEST: makeStage('completed', { verdict: 'PASS' }),
    },
    classification: { pipelineId: 'standard', taskType: 'feature' },
  });
  raw.pipelineActive = false; // pipeline 完成後 pipelineActive 也是 false
  const result = adaptState(raw);
  assert.strictEqual(result.cancelled, false, '已完成的 pipeline 不是 cancelled');
  assert.strictEqual(result.isPipelineComplete, true);
});

test('應該回傳 cancelled=false 當有 active stage（仍在執行）', () => {
  const raw = makeDashboardTestState({
    stageOverrides: {
      PLAN: makeStage('completed', { verdict: 'PASS' }),
      DEV: makeStage('active'),
      REVIEW: makeStage('pending'),
      TEST: makeStage('pending'),
    },
    classification: { pipelineId: 'standard', taskType: 'feature' },
  });
  raw.pipelineActive = false; // 即使 pipelineActive=false，有 active stage 不是 cancelled
  const result = adaptState(raw);
  assert.strictEqual(result.cancelled, false, '有 active stage 不是 cancelled');
});

test('adaptState 無 DAG fallback：cancelled 應為 false', () => {
  const raw = {
    version: 3,
    dag: null,
    stages: {},
    classification: { pipelineId: 'standard' },
    pipelineActive: false,
  };
  const result = adaptState(raw);
  assert.strictEqual(result.cancelled, false, '無 DAG fallback 的 cancelled 應為 false');
  assert.strictEqual(result.isPipelineComplete, false, '無 DAG fallback 的 isPipelineComplete 應為 false');
});

// ═══════════════════════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════════════════════

console.log(`\n=== dashboard-adapter.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
