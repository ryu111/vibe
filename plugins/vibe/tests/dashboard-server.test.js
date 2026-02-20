#!/usr/bin/env node
/**
 * dashboard-server.test.js — Dashboard Server 邏輯測試
 *
 * 測試範圍：
 *   1. /api/registry endpoint 資料結構（stages/pipelines/agents）
 *   2. AGENT_EMOJI 從 STAGES 動態建構邏輯
 *   3. EVENT_TYPE_TO_CAT 從 CATEGORIES 建構邏輯（含向後相容覆寫）
 *   4. STALE_THRESHOLD_MS 常數值
 *   5. isDisplayWorthy / isStaleSession / pct100 邏輯（純函式萃取驗證）
 *   6. eventCat 映射邏輯
 *   7. 邊界案例
 *
 * 策略：
 *   - server.js 使用 ESM（Bun），無法直接 require
 *   - registry.js 和 schema.js 是 CJS，可直接 require
 *   - 針對 server.js 的邏輯，直接測試其 import 來源（registry.js / schema.js）
 *   - server.js 中的純函式邏輯在測試中複製並驗證
 *
 * 執行：node plugins/vibe/tests/dashboard-server.test.js
 */
'use strict';

const assert = require('assert');
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
// 載入模組
// ═══════════════════════════════════════════════════════════════

const PLUGIN_DIR = path.join(__dirname, '..');
const {
  STAGES,
  REFERENCE_PIPELINES,
  STAGE_ORDER,
  AGENT_TO_STAGE,
} = require(`${PLUGIN_DIR}/scripts/lib/registry.js`);

const { CATEGORIES } = require(`${PLUGIN_DIR}/scripts/lib/timeline/schema.js`);

// ═══════════════════════════════════════════════════════════════
// 複製自 server.js 的核心邏輯（供測試使用）
// 若 server.js 修改，此處需同步更新
// ═══════════════════════════════════════════════════════════════

/**
 * 複製自 server.js：從 STAGES 動態建立 agent→emoji 映射
 */
const AGENT_EMOJI = {
  ...Object.fromEntries(
    Object.values(STAGES).map(cfg => [cfg.agent, cfg.emoji])
  ),
  'pipeline-architect': '📐',
};

/**
 * 複製自 server.js：從 CATEGORIES 動態建立 eventType→category 映射
 */
const CAT_PRIORITY = ['pipeline', 'quality', 'agent', 'remote', 'safety', 'task', 'session'];
const EVENT_TYPE_TO_CAT = {};
for (const catName of [...CAT_PRIORITY].reverse()) {
  const types = CATEGORIES[catName] || [];
  for (const t of types) {
    EVENT_TYPE_TO_CAT[t] = catName;
  }
}
// 向後相容覆寫
for (const t of ['session.start', 'task.classified', 'prompt.received', 'task.incomplete']) {
  EVENT_TYPE_TO_CAT[t] = 'pipeline';
}

/**
 * 複製自 server.js：eventCat
 */
function eventCat(type) {
  return EVENT_TYPE_TO_CAT[type] || 'task';
}

/**
 * 複製自 server.js：STALE_THRESHOLD_MS
 */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * 複製自 server.js：isDisplayWorthy
 */
function isDisplayWorthy(state) {
  if (!state) return false;
  if (state.dag && Object.keys(state.dag).length > 0) return true;
  if (state.classification?.pipelineId && state.classification.pipelineId !== 'none') return true;
  if (state.expectedStages?.length > 0) return true;
  return false;
}

/**
 * 複製自 server.js：isStaleSession
 */
function isStaleSession(state) {
  if (!state) return true;
  const last = state.meta?.lastTransition || state.lastTransition;
  if (!last) return true;
  return (Date.now() - new Date(last).getTime()) > STALE_THRESHOLD_MS;
}

/**
 * 複製自 server.js：pct100
 */
function pct100(state) {
  if (!state?.dag) return false;
  const dagKeys = Object.keys(state.dag);
  if (!dagKeys.length) return false;
  const stages = state.stages || {};
  return dagKeys.every(id => stages[id]?.status === 'completed' || stages[id]?.status === 'skipped');
}

/**
 * 模擬 /api/registry endpoint 回應
 */
function buildRegistryResponse() {
  const stages = Object.fromEntries(
    Object.entries(STAGES).map(([id, cfg]) => [id, {
      agent: cfg.agent,
      emoji: cfg.emoji,
      label: cfg.label,
      color: cfg.color,
    }])
  );
  const pipelines = Object.fromEntries(
    Object.entries(REFERENCE_PIPELINES).map(([id, cfg]) => [id, {
      label: cfg.label,
      stages: cfg.stages,
      description: cfg.description,
      enforced: cfg.enforced,
    }])
  );
  const agentsFromStages = Object.values(STAGES).map(cfg => cfg.agent);
  const agents = [...agentsFromStages, 'pipeline-architect'];
  return { stages, pipelines, agents };
}

// ═══════════════════════════════════════════════════════════════
// Section 1：/api/registry — 資料結構驗證
// ═══════════════════════════════════════════════════════════════

section('/api/registry：資料結構驗證');

test('應該回傳包含 stages/pipelines/agents 三個頂層欄位的物件', () => {
  const resp = buildRegistryResponse();
  assert.ok(typeof resp.stages === 'object' && resp.stages !== null, 'stages 應為物件');
  assert.ok(typeof resp.pipelines === 'object' && resp.pipelines !== null, 'pipelines 應為物件');
  assert.ok(Array.isArray(resp.agents), 'agents 應為陣列');
});

test('應該 stages 包含 9 個 stage', () => {
  const resp = buildRegistryResponse();
  const stageKeys = Object.keys(resp.stages);
  assert.strictEqual(stageKeys.length, 9, `應有 9 個 stage，實際有 ${stageKeys.length}`);
});

test('應該 stages 包含所有 9 個預期 stage ID', () => {
  const resp = buildRegistryResponse();
  const expected = ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];
  for (const id of expected) {
    assert.ok(resp.stages[id], `stages 應包含 ${id}`);
  }
});

test('應該每個 stage 有 agent/emoji/label/color 四個欄位', () => {
  const resp = buildRegistryResponse();
  for (const [id, cfg] of Object.entries(resp.stages)) {
    assert.ok(typeof cfg.agent === 'string' && cfg.agent, `${id}.agent 應為非空字串`);
    assert.ok(typeof cfg.emoji === 'string' && cfg.emoji, `${id}.emoji 應為非空字串`);
    assert.ok(typeof cfg.label === 'string' && cfg.label, `${id}.label 應為非空字串`);
    assert.ok(typeof cfg.color === 'string' && cfg.color, `${id}.color 應為非空字串`);
  }
});

test('應該 PLAN stage 有正確的 agent=planner', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.stages.PLAN.agent, 'planner');
});

test('應該 REVIEW stage 有正確的 color=blue', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.stages.REVIEW.color, 'blue');
});

test('應該 TEST stage 有正確的 color=pink', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.stages.TEST.color, 'pink');
});

test('應該 DEV stage 有正確的 color=yellow', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.stages.DEV.color, 'yellow');
});

// ═══════════════════════════════════════════════════════════════
// Section 2：/api/registry — pipelines 資料
// ═══════════════════════════════════════════════════════════════

section('/api/registry：pipelines 資料驗證');

test('應該 pipelines 包含 10 個參考模板', () => {
  const resp = buildRegistryResponse();
  const pipelineIds = Object.keys(resp.pipelines);
  assert.strictEqual(pipelineIds.length, 10, `應有 10 個 pipeline，實際有 ${pipelineIds.length}`);
});

test('應該 pipelines 包含所有 10 個預期 pipeline ID', () => {
  const resp = buildRegistryResponse();
  const expected = ['full', 'standard', 'quick-dev', 'fix', 'test-first', 'ui-only', 'review-only', 'docs-only', 'security', 'none'];
  for (const id of expected) {
    assert.ok(resp.pipelines[id], `pipelines 應包含 ${id}`);
  }
});

test('應該每個 pipeline 有 label/stages/description/enforced 四個欄位', () => {
  const resp = buildRegistryResponse();
  for (const [id, cfg] of Object.entries(resp.pipelines)) {
    assert.ok(typeof cfg.label === 'string' && cfg.label, `${id}.label 應為非空字串`);
    assert.ok(Array.isArray(cfg.stages), `${id}.stages 應為陣列`);
    assert.ok(typeof cfg.description === 'string' && cfg.description, `${id}.description 應為非空字串`);
    assert.ok(typeof cfg.enforced === 'boolean', `${id}.enforced 應為布林值`);
  }
});

test('應該 full pipeline 包含 9 個 stages', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.pipelines.full.stages.length, 9, 'full pipeline 應有 9 個 stages');
});

test('應該 standard pipeline 包含 6 個 stages', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.pipelines.standard.stages.length, 6);
});

test('應該 quick-dev pipeline 包含 3 個 stages', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.pipelines['quick-dev'].stages.length, 3);
});

test('應該 fix pipeline 包含 1 個 stage', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.pipelines.fix.stages.length, 1);
  assert.deepStrictEqual(resp.pipelines.fix.stages, ['DEV']);
});

test('應該 none pipeline 的 stages 為空陣列', () => {
  const resp = buildRegistryResponse();
  assert.deepStrictEqual(resp.pipelines.none.stages, []);
});

test('應該 none pipeline 的 enforced 為 false', () => {
  const resp = buildRegistryResponse();
  assert.strictEqual(resp.pipelines.none.enforced, false);
});

test('應該所有非 none pipeline 的 enforced 為 true', () => {
  const resp = buildRegistryResponse();
  for (const [id, cfg] of Object.entries(resp.pipelines)) {
    if (id === 'none') continue;
    assert.strictEqual(cfg.enforced, true, `${id}.enforced 應為 true`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 3：/api/registry — agents 列表
// ═══════════════════════════════════════════════════════════════

section('/api/registry：agents 列表驗證');

test('應該 agents 包含 10 個 agent（9 pipeline stages + pipeline-architect）', () => {
  const resp = buildRegistryResponse();
  // 9 個 pipeline stage agents + pipeline-architect = 10
  assert.strictEqual(resp.agents.length, 10, `應有 10 個 agents，實際有 ${resp.agents.length}`);
});

test('應該 agents 包含 pipeline-architect', () => {
  const resp = buildRegistryResponse();
  assert.ok(resp.agents.includes('pipeline-architect'), 'agents 應包含 pipeline-architect');
});

test('應該 agents 包含所有 9 個 pipeline stage agents', () => {
  const resp = buildRegistryResponse();
  const expectedAgents = ['planner', 'architect', 'designer', 'developer', 'code-reviewer', 'tester', 'qa', 'e2e-runner', 'doc-updater'];
  for (const agent of expectedAgents) {
    assert.ok(resp.agents.includes(agent), `agents 應包含 ${agent}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 4：AGENT_EMOJI 動態建構
// ═══════════════════════════════════════════════════════════════

section('AGENT_EMOJI：從 STAGES 動態建構');

test('應該 AGENT_EMOJI 包含 10 個 agent（9 stage agents + pipeline-architect）', () => {
  const count = Object.keys(AGENT_EMOJI).length;
  assert.strictEqual(count, 10, `AGENT_EMOJI 應有 10 個條目，實際有 ${count}`);
});

test('應該 AGENT_EMOJI 包含 pipeline-architect 且值為 📐', () => {
  assert.ok('pipeline-architect' in AGENT_EMOJI, 'AGENT_EMOJI 應有 pipeline-architect');
  assert.strictEqual(AGENT_EMOJI['pipeline-architect'], '📐');
});

test('應該 AGENT_EMOJI 中每個 pipeline stage agent 都有對應的 emoji', () => {
  const expectedAgents = ['planner', 'architect', 'designer', 'developer', 'code-reviewer', 'tester', 'qa', 'e2e-runner', 'doc-updater'];
  for (const agent of expectedAgents) {
    assert.ok(AGENT_EMOJI[agent], `AGENT_EMOJI 應包含 ${agent} 的 emoji`);
    assert.ok(typeof AGENT_EMOJI[agent] === 'string' && AGENT_EMOJI[agent].length > 0, `${agent} 的 emoji 應為非空字串`);
  }
});

test('應該 AGENT_EMOJI 中的 emoji 與 STAGES 定義一致', () => {
  for (const [stageId, cfg] of Object.entries(STAGES)) {
    assert.strictEqual(AGENT_EMOJI[cfg.agent], cfg.emoji, `${stageId} stage 的 agent ${cfg.agent} emoji 應與 STAGES 定義一致`);
  }
});

test('應該 AGENT_EMOJI 不包含不存在的 agent', () => {
  assert.strictEqual(AGENT_EMOJI['non-existent-agent'], undefined);
  assert.strictEqual(AGENT_EMOJI['main-agent'], undefined);
});

// ═══════════════════════════════════════════════════════════════
// Section 5：EVENT_TYPE_TO_CAT 建構邏輯
// ═══════════════════════════════════════════════════════════════

section('EVENT_TYPE_TO_CAT：從 CATEGORIES 建構');

test('應該 EVENT_TYPE_TO_CAT 包含 CATEGORIES 中的所有事件類型', () => {
  const allTypes = new Set(Object.values(CATEGORIES).flat());
  for (const t of allTypes) {
    assert.ok(t in EVENT_TYPE_TO_CAT, `${t} 應在 EVENT_TYPE_TO_CAT 中`);
  }
});

test('應該向後相容覆寫：session.start → pipeline', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['session.start'], 'pipeline');
});

test('應該向後相容覆寫：task.classified → pipeline', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['task.classified'], 'pipeline');
});

test('應該向後相容覆寫：prompt.received → pipeline', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['prompt.received'], 'pipeline');
});

test('應該向後相容覆寫：task.incomplete → pipeline', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['task.incomplete'], 'pipeline');
});

test('應該 stage.start → pipeline 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['stage.start'], 'pipeline');
});

test('應該 stage.complete → pipeline 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['stage.complete'], 'pipeline');
});

test('應該 quality.lint → quality 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['quality.lint'], 'quality');
});

test('應該 quality.format → quality 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['quality.format'], 'quality');
});

test('應該 tool.blocked → quality 分類（safety 優先於 task，但 quality 覆蓋）', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['tool.blocked'], 'quality');
});

test('應該 ask.question → remote 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['ask.question'], 'remote');
});

test('應該 turn.summary → remote 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['turn.summary'], 'remote');
});

test('應該 tool.used → agent 分類（pipeline 優先覆蓋 task）', () => {
  // tool.used 在 agent 分類中，根據 CAT_PRIORITY，agent 優先於 task
  assert.strictEqual(EVENT_TYPE_TO_CAT['tool.used'], 'agent');
});

test('應該 delegation.start → agent 分類（agent 優先於 task）', () => {
  // delegation.start 同時在 task 和 agent 分類
  // reverse() 後 pipeline 最後處理 → 若 agent 在 pipeline 前，agent 被 pipeline 覆蓋
  // 實際 CAT_PRIORITY = ['pipeline', 'quality', 'agent', 'remote', 'safety', 'task', 'session']
  // reverse 後 = ['session', 'task', 'safety', 'remote', 'agent', 'quality', 'pipeline']
  // pipeline 最後寫入，優先序最高。delegation.start 不在 pipeline，所以保留 agent
  const cat = EVENT_TYPE_TO_CAT['delegation.start'];
  // delegation.start 在 task 和 agent 兩個分類，agent 在 task 之後寫入（reverse 後），所以是 agent
  assert.strictEqual(cat, 'agent', `delegation.start 應為 agent 分類，實際為 ${cat}`);
});

test('應該未知事件類型的 eventCat 回傳 task（fallback）', () => {
  assert.strictEqual(eventCat('unknown.event'), 'task');
  assert.strictEqual(eventCat(''), 'task');
  assert.strictEqual(eventCat('not-a-real-event'), 'task');
});

test('應該 barrier.waiting → pipeline 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['barrier.waiting'], 'pipeline');
});

test('應該 barrier.resolved → pipeline 分類', () => {
  assert.strictEqual(EVENT_TYPE_TO_CAT['barrier.resolved'], 'pipeline');
});

test('應該 agent.crash → pipeline 分類（pipeline 優先於 safety）', () => {
  // agent.crash 在 pipeline 和 safety 兩個分類
  // pipeline 在 CAT_PRIORITY 中排最前，但 reverse 後最後寫入（優先級最高）
  assert.strictEqual(EVENT_TYPE_TO_CAT['agent.crash'], 'pipeline');
});

// ═══════════════════════════════════════════════════════════════
// Section 6：STALE_THRESHOLD_MS 常數驗證
// ═══════════════════════════════════════════════════════════════

section('STALE_THRESHOLD_MS：常數值驗證');

test('應該 STALE_THRESHOLD_MS 等於 30 分鐘（1800000 毫秒）', () => {
  assert.strictEqual(STALE_THRESHOLD_MS, 1800000, `STALE_THRESHOLD_MS 應為 1800000，實際為 ${STALE_THRESHOLD_MS}`);
});

test('應該 STALE_THRESHOLD_MS 等於 30 * 60 * 1000', () => {
  assert.strictEqual(STALE_THRESHOLD_MS, 30 * 60 * 1000);
});

// ═══════════════════════════════════════════════════════════════
// Section 7：isDisplayWorthy — 判斷 session 是否值得顯示
// ═══════════════════════════════════════════════════════════════

section('isDisplayWorthy：session 顯示判斷');

test('應該回傳 false 當 state 為 null', () => {
  assert.strictEqual(isDisplayWorthy(null), false);
});

test('應該回傳 false 當 state 為 undefined', () => {
  assert.strictEqual(isDisplayWorthy(undefined), false);
});

test('應該回傳 true 當 state 有非空 DAG', () => {
  const state = { dag: { PLAN: { deps: [] }, DEV: { deps: ['PLAN'] } }, stages: {} };
  assert.strictEqual(isDisplayWorthy(state), true);
});

test('應該回傳 false 當 state 有空 DAG 且無 classification', () => {
  const state = { dag: {}, stages: {}, classification: null };
  assert.strictEqual(isDisplayWorthy(state), false);
});

test('應該回傳 true 當 state 有非 none pipelineId', () => {
  const state = { dag: null, classification: { pipelineId: 'standard' } };
  assert.strictEqual(isDisplayWorthy(state), true);
});

test('應該回傳 false 當 state 的 pipelineId 為 none', () => {
  const state = { dag: null, classification: { pipelineId: 'none' } };
  assert.strictEqual(isDisplayWorthy(state), false);
});

test('應該回傳 true 當 state 有 expectedStages（v2 相容）', () => {
  const state = { dag: null, expectedStages: ['DEV', 'TEST'] };
  assert.strictEqual(isDisplayWorthy(state), true);
});

test('應該回傳 false 當 state 有 expectedStages 為空陣列', () => {
  const state = { dag: null, expectedStages: [], classification: null };
  assert.strictEqual(isDisplayWorthy(state), false);
});

test('應該回傳 false 當 state 無 dag 且無 classification 且無 expectedStages', () => {
  const state = { version: 3 };
  assert.strictEqual(isDisplayWorthy(state), false);
});

// ═══════════════════════════════════════════════════════════════
// Section 8：isStaleSession — 過期 session 判斷
// ═══════════════════════════════════════════════════════════════

section('isStaleSession：過期 session 判斷');

test('應該回傳 true 當 state 為 null', () => {
  assert.strictEqual(isStaleSession(null), true);
});

test('應該回傳 true 當 state 無 lastTransition', () => {
  const state = { dag: {}, meta: {} };
  assert.strictEqual(isStaleSession(state), true);
});

test('應該回傳 true 當 lastTransition 超過 30 分鐘前', () => {
  const oldTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const state = { meta: { lastTransition: oldTime } };
  assert.strictEqual(isStaleSession(state), true);
});

test('應該回傳 false 當 lastTransition 在 30 分鐘內', () => {
  const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const state = { meta: { lastTransition: recentTime } };
  assert.strictEqual(isStaleSession(state), false);
});

test('應該回傳 false 當 lastTransition 剛好是現在', () => {
  const now = new Date().toISOString();
  const state = { meta: { lastTransition: now } };
  assert.strictEqual(isStaleSession(state), false);
});

test('應該支援頂層 lastTransition（v2 相容）', () => {
  const recentTime = new Date(Date.now() - 1000).toISOString();
  const state = { lastTransition: recentTime }; // 無 meta，直接放頂層
  assert.strictEqual(isStaleSession(state), false);
});

test('應該 meta.lastTransition 優先於頂層 lastTransition', () => {
  const oldTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  const recentTime = new Date(Date.now() - 1000).toISOString();
  const state = {
    meta: { lastTransition: oldTime },
    lastTransition: recentTime, // 頂層是新的，但 meta 是舊的
  };
  // meta.lastTransition 優先 → 應判斷為 stale
  assert.strictEqual(isStaleSession(state), true);
});

// ═══════════════════════════════════════════════════════════════
// Section 9：pct100 — Pipeline 100% 完成判斷
// ═══════════════════════════════════════════════════════════════

section('pct100：Pipeline 完成判斷');

test('應該回傳 false 當 state 無 dag', () => {
  assert.strictEqual(pct100({ dag: null, stages: {} }), false);
  assert.strictEqual(pct100(null), false);
  assert.strictEqual(pct100(undefined), false);
});

test('應該回傳 false 當 dag 為空物件', () => {
  assert.strictEqual(pct100({ dag: {}, stages: {} }), false);
});

test('應該回傳 true 當所有 stages 都是 completed', () => {
  const state = {
    dag: { PLAN: {}, DEV: {} },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'completed' },
    },
  };
  assert.strictEqual(pct100(state), true);
});

test('應該回傳 true 當所有 stages 都是 skipped', () => {
  const state = {
    dag: { PLAN: {}, DEV: {} },
    stages: {
      PLAN: { status: 'skipped' },
      DEV: { status: 'skipped' },
    },
  };
  assert.strictEqual(pct100(state), true);
});

test('應該回傳 true 當 stages 混合 completed 和 skipped', () => {
  const state = {
    dag: { PLAN: {}, DEV: {}, REVIEW: {} },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'skipped' },
      REVIEW: { status: 'completed' },
    },
  };
  assert.strictEqual(pct100(state), true);
});

test('應該回傳 false 當有 pending stage', () => {
  const state = {
    dag: { PLAN: {}, DEV: {} },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'pending' },
    },
  };
  assert.strictEqual(pct100(state), false);
});

test('應該回傳 false 當有 active stage', () => {
  const state = {
    dag: { PLAN: {}, DEV: {} },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'active' },
    },
  };
  assert.strictEqual(pct100(state), false);
});

test('應該回傳 false 當有 failed stage', () => {
  // pct100 只考慮 completed 和 skipped，failed 不算完成
  const state = {
    dag: { PLAN: {}, DEV: {} },
    stages: {
      PLAN: { status: 'completed' },
      DEV: { status: 'failed' },
    },
  };
  assert.strictEqual(pct100(state), false);
});

test('應該回傳 false 當 stages 為空物件（dag 有但 stages 無資料）', () => {
  const state = {
    dag: { PLAN: {} },
    stages: {},
  };
  // stages.PLAN === undefined → undefined?.status === 'completed' = false
  // 不符合 every 條件
  assert.strictEqual(pct100(state), false);
});

// ═══════════════════════════════════════════════════════════════
// Section 10：STAGES 與 registry.js 一致性
// ═══════════════════════════════════════════════════════════════

section('STAGES：registry.js 一致性驗證');

test('應該 STAGES 包含 9 個 stage', () => {
  assert.strictEqual(Object.keys(STAGES).length, 9);
});

test('應該 STAGE_ORDER 長度為 9', () => {
  assert.strictEqual(STAGE_ORDER.length, 9);
});

test('應該 STAGE_ORDER 的第一個 stage 為 PLAN', () => {
  assert.strictEqual(STAGE_ORDER[0], 'PLAN');
});

test('應該 STAGE_ORDER 的最後一個 stage 為 DOCS', () => {
  assert.strictEqual(STAGE_ORDER[STAGE_ORDER.length - 1], 'DOCS');
});

test('應該所有 STAGES 的 color 都是合法色彩值', () => {
  const validColors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
  for (const [id, cfg] of Object.entries(STAGES)) {
    assert.ok(validColors.includes(cfg.color), `${id} 的 color "${cfg.color}" 不在合法色彩列表`);
  }
});

test('應該 AGENT_TO_STAGE 可以從 agent 名反查 stage', () => {
  assert.strictEqual(AGENT_TO_STAGE['planner'], 'PLAN');
  assert.strictEqual(AGENT_TO_STAGE['developer'], 'DEV');
  assert.strictEqual(AGENT_TO_STAGE['tester'], 'TEST');
  assert.strictEqual(AGENT_TO_STAGE['doc-updater'], 'DOCS');
});

// ═══════════════════════════════════════════════════════════════
// Section 11：REFERENCE_PIPELINES — 結構一致性
// ═══════════════════════════════════════════════════════════════

section('REFERENCE_PIPELINES：結構一致性');

test('應該 REFERENCE_PIPELINES 包含 10 個 pipeline', () => {
  assert.strictEqual(Object.keys(REFERENCE_PIPELINES).length, 10);
});

test('應該 standard pipeline stages 包含 PLAN/ARCH/DEV/REVIEW/TEST/DOCS', () => {
  const stages = REFERENCE_PIPELINES['standard'].stages;
  const expected = ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'];
  assert.deepStrictEqual(stages, expected);
});

test('應該 quick-dev pipeline stages 包含 DEV/REVIEW/TEST', () => {
  const stages = REFERENCE_PIPELINES['quick-dev'].stages;
  assert.deepStrictEqual(stages, ['DEV', 'REVIEW', 'TEST']);
});

test('應該 full pipeline 包含 DESIGN 和 QA 和 E2E', () => {
  const stages = REFERENCE_PIPELINES['full'].stages;
  assert.ok(stages.includes('DESIGN'));
  assert.ok(stages.includes('QA'));
  assert.ok(stages.includes('E2E'));
});

test('應該每個 REFERENCE_PIPELINES 的 stages 中每個 stage ID 都在 STAGES 中（test-first 的 TEST:verify 除外）', () => {
  const validStageIds = new Set(Object.keys(STAGES));
  for (const [pipelineId, cfg] of Object.entries(REFERENCE_PIPELINES)) {
    for (const stageId of cfg.stages) {
      // test-first 有 TEST:verify（suffixed stage）
      const baseId = stageId.split(':')[0];
      assert.ok(validStageIds.has(baseId), `pipeline ${pipelineId} 的 stage "${stageId}"（基礎 ID: ${baseId}）不在 STAGES`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 12：eventCat 邊界案例
// ═══════════════════════════════════════════════════════════════

section('eventCat：邊界案例');

test('應該 null 輸入回傳 task（fallback）', () => {
  assert.strictEqual(eventCat(null), 'task');
});

test('應該 undefined 輸入回傳 task（fallback）', () => {
  assert.strictEqual(eventCat(undefined), 'task');
});

test('應該 pipeline.complete → pipeline 分類', () => {
  assert.strictEqual(eventCat('pipeline.complete'), 'pipeline');
});

test('應該 pipeline.incomplete → pipeline 分類', () => {
  assert.strictEqual(eventCat('pipeline.incomplete'), 'pipeline');
});

test('應該 stage.retry → pipeline 分類', () => {
  assert.strictEqual(eventCat('stage.retry'), 'pipeline');
});

test('應該 compact.suggested → remote 分類', () => {
  assert.strictEqual(eventCat('compact.suggested'), 'remote');
});

test('應該 compact.executed → remote 分類', () => {
  assert.strictEqual(eventCat('compact.executed'), 'remote');
});

test('應該 safety.transcript-leak → safety 分類', () => {
  // safety.transcript-leak 只在 safety 分類，非 pipeline
  assert.strictEqual(eventCat('safety.transcript-leak'), 'safety');
});

// ═══════════════════════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════════════════════

console.log(`\n=== dashboard-server.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
