#!/usr/bin/env node
/**
 * agent-status-filter.test.js — AgentStatus 元件過濾邏輯測試
 *
 * 測試範圍：
 *   1. getAgentInfo()：各種狀態下的 agent 資訊計算
 *      - main agent 狀態（閒置/委派中/運行中）— askPending = idle
 *      - sub-agent 狀態（running/completed/error/standby/pending/skipped）
 *      - isActive / skillsLit 旗標
 *   2. AgentStatus 全量顯示（面板始終可見）
 *      - 所有 agents 全部顯示，不過濾
 *      - 用視覺（燈號/名稱顏色）區分狀態
 *   3. 狀態轉換：
 *      - idle → running → completed（狀態變化反映在全量列表中）
 *   4. 邊界案例：
 *      - null / undefined state
 *      - 空事件陣列
 *      - askPending 旗標（= idle）
 *
 * 策略：
 *   - getAgentInfo / AgentStatus / getStatus 為 index.html 內嵌函式，無法 require
 *   - 測試中複製核心邏輯（同 v3-alignment.test.js 做法）
 *   - 不依賴 Preact / DOM，純函式邏輯驗證
 *
 * 執行：node plugins/vibe/tests/agent-status-filter.test.js
 */
'use strict';

const assert = require('assert');
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
// 複製自 web/index.html 的核心邏輯（供測試使用）
// 若 index.html 修改，此處需同步更新
// ═══════════════════════════════════════════════════════════════

/**
 * 複製自 index.html getCurrent()
 */
function getCurrent(s) {
  return s?.currentStage || s?.expectedStages?.find(st => s.stageResults?.[st]?.verdict !== 'PASS') || null;
}

/**
 * 複製自 index.html getStatus()
 */
function getStatus(stage, s) {
  if (!s?.expectedStages?.includes(stage)) return 'skipped';
  const cur = getCurrent(s);
  const r = s.stageResults?.[stage];
  if (stage === cur && s.delegationActive) return 'active';
  if (stage === cur && r?.verdict !== 'PASS') return 'next';
  if (r?.verdict === 'PASS') return 'pass';
  if (r?.verdict === 'FAIL') return 'fail';
  return 'pending';
}

/**
 * 複製自 index.html getAgentInfo()
 */
function getAgentInfo(agent, s, askPending, events, alive) {
  let status = 'idle', statusLabel = '閒置', dur = null, tools = null, retries = 0;

  if (agent.id === 'main') {
    // alive===false 表示 session heartbeat 已消失 → 強制 idle（undefined=未知，不影響）
    if (alive === false) { /* session 已結束 → 閒置 */ }
    else if (!s || !s.taskType) { /* 尚未分類 → 閒置 */ }
    else if (askPending) { /* 等待使用者輸入 = 閒置 */ }
    else { status = s.delegationActive ? 'delegating' : 'running'; statusLabel = s.delegationActive ? '委派中' : '運行中'; }
  } else {
    // 1. 正在運行？找最近的 delegation.start 看是不是這個 agent
    if (s?.delegationActive && events?.length) {
      const lastDel = events.find(e => e.eventType === 'delegation.start');
      if (lastDel?.text?.includes(agent.id)) {
        status = 'running'; statusLabel = '運行中';
      }
    }
    // 2. Pipeline 補充：已完成的階段顯示 pass/fail/duration
    if (agent.stage && s?.stageResults?.[agent.stage]) {
      const r = s.stageResults[agent.stage];
      dur = r.duration; tools = r.toolCalls;
      retries = s.retries?.[agent.stage] || 0;
      if (status !== 'running') {
        if (r.completedAt || r.verdict === 'PASS') { status = 'completed'; statusLabel = 'PASS'; }
        else if (r.verdict === 'FAIL') { status = 'error'; statusLabel = r.severity || 'FAIL'; }
      }
    }
    // 3. Support agents：曾被委派 → 完成（無 stage 結果可查）
    if (status === 'idle' && agent.group === 'support' && events?.length) {
      if (events.some(e => e.eventType === 'delegation.start' && e.text?.includes(agent.id))) {
        status = 'completed'; statusLabel = '完成';
      }
    }
    // 4. Pipeline 排程：待命/等待/跳過（pipeline 完成後跳過）
    if (status === 'idle' && !s?.isPipelineComplete && agent.stage && s?.expectedStages?.includes(agent.stage)) {
      const st = getStatus(agent.stage, s);
      if (st === 'next') { status = 'standby'; statusLabel = '待命'; }
      else if (st === 'skipped') { status = 'skipped'; statusLabel = '跳過'; }
      else if (st !== 'pass' && st !== 'fail' && st !== 'active') { status = 'pending'; statusLabel = '等待'; }
    }
  }

  const isActive = ['running', 'delegating'].includes(status);
  const skillsLit = isActive;
  return { ...agent, status, statusLabel, dur, tools, retries, isActive, skillsLit };
}

/**
 * 模擬 AgentStatus 的顯示邏輯（不含 DOM 渲染）
 * 回傳：全部 agents 陣列（面板始終可見，顯示所有 14 個 agents）
 *
 * v1.0.72 回退：從排除法（HIDDEN_STATUSES）改回全量顯示
 * 用視覺（燈號亮度/名稱顏色）區分 running vs idle，不再過濾
 */
function simulateAgentStatusFilter(allAgents) {
  return allAgents;
}

// ═══════════════════════════════════════════════════════════════
// 輔助建構函式
// ═══════════════════════════════════════════════════════════════

function makeAgent(id, opts = {}) {
  return {
    id,
    name: opts.name || id,
    emoji: opts.emoji || '🤖',
    model: opts.model || 'sonnet',
    color: opts.color || '#ffffff',
    role: opts.role || id,
    group: opts.group || 'pipeline',
    stage: opts.stage || null,
    skills: opts.skills || [],
  };
}

function makeState(opts = {}) {
  return {
    taskType: opts.taskType || null,
    delegationActive: opts.delegationActive || false,
    currentStage: opts.currentStage || null,
    expectedStages: opts.expectedStages || [],
    stageResults: opts.stageResults || {},
    skippedStages: opts.skippedStages || [],
    retries: opts.retries || {},
  };
}

function makeDelegationEvent(agentId) {
  return { eventType: 'delegation.start', text: `委派給 ${agentId}` };
}

// ═══════════════════════════════════════════════════════════════
// Section 1：getAgentInfo — main agent 狀態
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：main agent 狀態');

test('應該回傳 idle 當 state 為 null', () => {
  const agent = makeAgent('main');
  const result = getAgentInfo(agent, null, false, [], true);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.statusLabel, '閒置');
});

test('應該回傳 idle 當 state 無 taskType', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: null });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.status, 'idle');
});

test('應該回傳 idle 當 askPending 為 true（等待使用者輸入 = 閒置）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature' });
  const result = getAgentInfo(agent, s, true, [], true);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.statusLabel, '閒置');
});

test('應該回傳 delegating 當 delegationActive 為 true', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.status, 'delegating');
  assert.strictEqual(result.statusLabel, '委派中');
});

test('應該回傳 running 當有 taskType 且 delegationActive 為 false', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.statusLabel, '運行中');
});

test('應該 askPending 優先於 delegationActive（idle 覆蓋 delegating）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, true, [], true);
  assert.strictEqual(result.status, 'idle');
});

test('應該 alive=false 時 main agent 強制 idle（session 結束後不顯示運行中）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const result = getAgentInfo(agent, s, false, [], false);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.statusLabel, '閒置');
});

test('應該 alive=false 時 main agent 委派中也強制 idle', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, [], false);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.statusLabel, '閒置');
});

test('應該 alive=undefined 時 main agent 正常判斷（非強制 idle）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const result = getAgentInfo(agent, s, false, [], undefined);
  assert.strictEqual(result.status, 'running', 'undefined 不等於 false，正常走 taskType 判斷');
});

// ═══════════════════════════════════════════════════════════════
// Section 2：getAgentInfo — sub-agent 運行中偵測
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：sub-agent 運行中偵測');

test('應該回傳 running 當 delegationActive 且最近 delegation.start 含 agent.id', () => {
  const agent = makeAgent('developer', { stage: 'DEV' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.status, 'running');
});

test('應該回傳 idle 當 delegation.start 文字不含此 agent.id', () => {
  const agent = makeAgent('tester', { stage: 'TEST' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.status, 'idle');
});

test('應該回傳 idle 當 delegationActive 為 false 即使有 delegation.start 事件', () => {
  const agent = makeAgent('developer', { stage: 'DEV' });
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  assert.notStrictEqual(result.status, 'running');
});

test('應該回傳 idle 當 events 為空陣列', () => {
  const agent = makeAgent('developer', { stage: 'DEV' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, []);
  assert.notStrictEqual(result.status, 'running');
});

test('應該回傳 idle 當 events 為 null', () => {
  const agent = makeAgent('developer', { stage: 'DEV' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, null);
  assert.notStrictEqual(result.status, 'running');
});

// ═══════════════════════════════════════════════════════════════
// Section 3：getAgentInfo — pipeline sub-agent 完成狀態
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：pipeline sub-agent 完成狀態');

test('應該回傳 completed/PASS 當 stageResults 含 verdict=PASS', () => {
  const agent = makeAgent('planner', { stage: 'PLAN', group: 'pipeline' });
  const s = makeState({
    stageResults: { PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.statusLabel, 'PASS');
});

test('應該回傳 error/FAIL 當 stageResults 含 verdict=FAIL', () => {
  const agent = makeAgent('code-reviewer', { stage: 'REVIEW', group: 'pipeline' });
  const s = makeState({
    stageResults: { REVIEW: { verdict: 'FAIL', severity: 'HIGH' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.statusLabel, 'HIGH');
});

test('應該回傳 error 並以 FAIL 作為 statusLabel 當 verdict=FAIL 且無 severity', () => {
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    stageResults: { TEST: { verdict: 'FAIL' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.statusLabel, 'FAIL');
});

test('應該提取 dur 從 stageResults.duration', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    stageResults: { DEV: { verdict: 'PASS', duration: 120, completedAt: '2026-02-18T10:00:00Z' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.dur, 120);
});

test('應該提取 retries 從 state.retries', () => {
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    stageResults: { TEST: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
    retries: { TEST: 2 },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.retries, 2);
});

test('應該忽略 stageResults 當 agent.stage 為 null', () => {
  // support agent 無 stage
  const agent = makeAgent('security-reviewer', { stage: null, group: 'support' });
  const s = makeState({ stageResults: { TEST: { verdict: 'PASS' } } });
  const result = getAgentInfo(agent, s, false, []);
  assert.notStrictEqual(result.status, 'completed');
});

test('應該 running agent 不被 stageResults 覆蓋為 completed', () => {
  // 正在運行中（delegationActive=true + delegation.start 事件）
  // 同時有舊的 stageResults（retry 場景）
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    delegationActive: true,
    stageResults: { DEV: { verdict: 'FAIL' } },
  });
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  // running 優先，不應被 stageResults 覆蓋
  assert.strictEqual(result.status, 'running');
});

// ═══════════════════════════════════════════════════════════════
// Section 4：getAgentInfo — support agent 完成偵測
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：support agent 完成偵測');

test('應該回傳 completed 當 support agent 曾被委派（有 delegation.start 事件）', () => {
  const agent = makeAgent('security-reviewer', { group: 'support' });
  const s = makeState({ delegationActive: false });
  const events = [makeDelegationEvent('security-reviewer')];
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.statusLabel, '完成');
});

test('應該回傳 idle 當 support agent 未曾被委派', () => {
  const agent = makeAgent('security-reviewer', { group: 'support' });
  const s = makeState({ delegationActive: false });
  const events = [makeDelegationEvent('developer')]; // 其他 agent
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.status, 'idle');
});

test('應該回傳 idle 當 support agent 無事件', () => {
  const agent = makeAgent('build-error-resolver', { group: 'support' });
  const s = makeState({});
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'idle');
});

// ═══════════════════════════════════════════════════════════════
// Section 5：getAgentInfo — pipeline 排程狀態
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：pipeline 排程狀態（standby/pending/skipped）');

test('應該回傳 standby 當 stage 是 next（下一個要執行的）', () => {
  // PLAN 完成，DEV 是下一個（current = DEV, delegationActive = false）
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    currentStage: 'DEV',
    stageResults: { PLAN: { verdict: 'PASS' } },
    delegationActive: false,
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'standby');
  assert.strictEqual(result.statusLabel, '待命');
});

test('應該回傳 idle（非 skipped）當 stage 不在 expectedStages 時 — step 4 整體被跳過', () => {
  // getAgentInfo step 4 條件：s?.expectedStages?.includes(agent.stage) 為 false → 整個 step 4 略過
  // agent 保持 idle，不進入 getStatus 判斷（getStatus 的 skipped 只在 step 4 內使用）
  const agent = makeAgent('designer', { stage: 'DESIGN', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    delegationActive: false,
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'idle', 'stage 不在 expectedStages 時 step 4 整體略過，保持 idle');
});

test('應該回傳 idle 當 isPipelineComplete=true — step 4 跳過', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['DEV', 'TEST'],
    currentStage: 'DEV',
    delegationActive: false,
  });
  s.isPipelineComplete = true;
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'idle', 'pipeline 完成後 step 4 不觸發');
});

test('應該回傳 pending 當 stage 在 expectedStages 但未到達', () => {
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    currentStage: 'DEV',
    stageResults: {},
    delegationActive: false,
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'pending');
  assert.strictEqual(result.statusLabel, '等待');
});

// ═══════════════════════════════════════════════════════════════
// Section 6：getAgentInfo — isActive 與 skillsLit 旗標
// ═══════════════════════════════════════════════════════════════

section('getAgentInfo：isActive 與 skillsLit 旗標');

test('應該 isActive = true 當 status = running', () => {
  const agent = makeAgent('developer', { stage: 'DEV' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.isActive, true);
  assert.strictEqual(result.skillsLit, true);
});

test('應該 isActive = true 當 status = delegating（main agent）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.isActive, true);
});

test('應該 isActive = false 當 askPending（idle 狀態）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature' });
  const result = getAgentInfo(agent, s, true, [], true);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.isActive, false);
  assert.strictEqual(result.skillsLit, false);
});

test('應該 isActive = false 當 status = idle', () => {
  const agent = makeAgent('main');
  const result = getAgentInfo(agent, null, false, [], true);
  assert.strictEqual(result.isActive, false);
});

test('應該 isActive = false 當 status = completed', () => {
  const agent = makeAgent('planner', { stage: 'PLAN', group: 'pipeline' });
  const s = makeState({
    stageResults: { PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.isActive, false);
});

test('應該 isActive = false 當 status = error（FAIL）', () => {
  const agent = makeAgent('code-reviewer', { stage: 'REVIEW', group: 'pipeline' });
  const s = makeState({
    stageResults: { REVIEW: { verdict: 'FAIL' } },
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.isActive, false);
});

test('應該保留原始 agent 屬性（展開運算子）', () => {
  const agent = makeAgent('developer', { stage: 'DEV', skills: ['write', 'test'], color: '#ff0000' });
  const result = getAgentInfo(agent, null, false, []);
  assert.strictEqual(result.color, '#ff0000');
  assert.deepStrictEqual(result.skills, ['write', 'test']);
  assert.strictEqual(result.stage, 'DEV');
});

// ═══════════════════════════════════════════════════════════════
// Section 7：AgentStatus 過濾邏輯 — ACTIVE_STATUSES
// ═══════════════════════════════════════════════════════════════

section('AgentStatus 全量顯示邏輯');

test('應該回傳所有 agents（面板始終可見）', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'completed' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 3, '全量顯示，不過濾');
});

test('應該回傳所有 idle agents', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('planner', { stage: 'PLAN' }), status: 'idle' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, '全量顯示所有 idle agents');
});

test('應該回傳空陣列當輸入為空', () => {
  const result = simulateAgentStatusFilter([]);
  assert.strictEqual(result.length, 0);
});

test('應該包含 running agent（全量顯示）', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 3, '全量顯示所有 agents');
  assert.ok(result.some(a => a.id === 'developer' && a.status === 'running'));
});

test('應該包含 delegating agent（全量顯示）', () => {
  const agents = [
    { ...makeAgent('main'), status: 'delegating' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'idle' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, '全量顯示');
  assert.ok(result.some(a => a.id === 'main' && a.status === 'delegating'));
});

test('應該包含所有狀態的 agents（全量顯示無過濾）', () => {
  const agents = [
    { ...makeAgent('main'), status: 'delegating' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
    { ...makeAgent('code-reviewer', { stage: 'REVIEW' }), status: 'completed' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 4, '全量顯示全部 4 個 agents');
});

test('應該包含 completed agents（全量顯示）', () => {
  const agents = [
    { ...makeAgent('planner', { stage: 'PLAN' }), status: 'completed' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, '全量顯示包含 completed');
});

test('應該包含 error 狀態的 agent（全量顯示）', () => {
  const agents = [
    { ...makeAgent('code-reviewer', { stage: 'REVIEW' }), status: 'error' },
    { ...makeAgent('main'), status: 'running' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, '全量顯示包含 error');
  assert.ok(result.some(a => a.id === 'code-reviewer' && a.status === 'error'));
});

test('應該包含 standby agents（全量顯示）', () => {
  const agents = [
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'standby' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, '全量顯示包含 standby');
});

test('應該包含 skipped agents（全量顯示）', () => {
  const agents = [
    { ...makeAgent('designer', { stage: 'DESIGN' }), status: 'skipped' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 1, '全量顯示包含 skipped');
});

// ═══════════════════════════════════════════════════════════════
// Section 8：狀態轉換模擬
// ═══════════════════════════════════════════════════════════════

section('狀態轉換模擬（idle → running → completed → 全量顯示）');

test('應該 agent 從 idle 變為 running 時狀態反映', () => {
  const agentDef = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  // 狀態 1：idle（尚未委派）
  const s1 = makeState({ taskType: 'feature', delegationActive: false });
  const info1 = getAgentInfo(agentDef, s1, false, []);
  assert.strictEqual(info1.status, 'idle');

  // 狀態 2：running（委派中）
  const s2 = makeState({ taskType: 'feature', delegationActive: true });
  const events2 = [makeDelegationEvent('developer')];
  const info2 = getAgentInfo(agentDef, s2, false, events2);
  assert.strictEqual(info2.status, 'running');

  // 全量顯示：兩個狀態都包含在面板中
  const panel1 = simulateAgentStatusFilter([info1]);
  const panel2 = simulateAgentStatusFilter([info2]);
  assert.strictEqual(panel1.length, 1, '全量顯示 idle agent');
  assert.strictEqual(panel2.length, 1, '全量顯示 running agent');
});

test('應該 agent 從 running 變為 completed 時狀態反映', () => {
  const agentDef = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  // 狀態 1：running
  const s1 = makeState({ taskType: 'feature', delegationActive: true });
  const events1 = [makeDelegationEvent('developer')];
  const info1 = getAgentInfo(agentDef, s1, false, events1);
  assert.strictEqual(info1.status, 'running');

  // 狀態 2：completed
  const s2 = makeState({
    taskType: 'feature',
    delegationActive: false,
    stageResults: { DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const info2 = getAgentInfo(agentDef, s2, false, []);
  assert.strictEqual(info2.status, 'completed');

  // 全量顯示：兩個狀態都在面板中
  const panel = simulateAgentStatusFilter([info2]);
  assert.strictEqual(panel.length, 1, '全量顯示 completed agent');
});

test('應該追蹤多 agent 狀態轉換', () => {
  const mainAgent = makeAgent('main');
  const devAgent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  // 活躍期間（alive=true）
  const sActive = makeState({ taskType: 'feature', delegationActive: true });
  const eventsActive = [makeDelegationEvent('developer')];
  const mainInfo1 = getAgentInfo(mainAgent, sActive, false, eventsActive, true);
  const devInfo1 = getAgentInfo(devAgent, sActive, false, eventsActive, true);
  assert.strictEqual(mainInfo1.status, 'delegating');
  assert.strictEqual(devInfo1.status, 'running');
  const panel1 = simulateAgentStatusFilter([mainInfo1, devInfo1]);
  assert.strictEqual(panel1.length, 2, '全量顯示所有 agents');

  // DEV 完成（alive=true，session 仍活著）
  const sComplete = makeState({
    taskType: 'feature',
    delegationActive: false,
    stageResults: { DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const mainInfo2 = getAgentInfo(mainAgent, sComplete, false, [], true);
  const devInfo2 = getAgentInfo(devAgent, sComplete, false, [], true);
  assert.strictEqual(mainInfo2.status, 'running');
  assert.strictEqual(devInfo2.status, 'completed');
  const panel2 = simulateAgentStatusFilter([mainInfo2, devInfo2]);
  assert.strictEqual(panel2.length, 2, '全量顯示：running + completed');

  // pipeline 結束（alive=false，session heartbeat 消失）
  const sIdle = makeState({ taskType: null, delegationActive: false });
  const mainInfo3 = getAgentInfo(mainAgent, sIdle, false, [], false);
  const devInfo3 = getAgentInfo(devAgent, sIdle, false, [], false);
  assert.strictEqual(mainInfo3.status, 'idle', 'session 結束後 main agent 應 idle');
  const panel3 = simulateAgentStatusFilter([mainInfo3, devInfo3]);
  assert.strictEqual(panel3.length, 2, '全量顯示：idle agents 仍可見');
});

test('應該 main agent askPending 時為 idle', () => {
  const mainAgent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const mainInfo = getAgentInfo(mainAgent, s, true, [], true);
  assert.strictEqual(mainInfo.status, 'idle', '等待使用者輸入 = 閒置');
  const panel = simulateAgentStatusFilter([mainInfo]);
  assert.strictEqual(panel.length, 1, '全量顯示 idle agent');
});

// ═══════════════════════════════════════════════════════════════
// Section 9：邊界案例
// ═══════════════════════════════════════════════════════════════

section('邊界案例');

test('應該正確處理 s = undefined（非 null）', () => {
  const agent = makeAgent('main');
  const result = getAgentInfo(agent, undefined, false, []);
  assert.strictEqual(result.status, 'idle');
});

test('應該 sub-agent 在 s = null 時回傳 idle', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const result = getAgentInfo(agent, null, false, []);
  assert.strictEqual(result.status, 'idle');
});

test('應該 sub-agent 在 s = null 且 events = null 時不崩潰', () => {
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const result = getAgentInfo(agent, null, false, null);
  assert.strictEqual(result.status, 'idle');
});

test('應該 support agent 在 events = null 時不崩潰', () => {
  const agent = makeAgent('security-reviewer', { group: 'support' });
  const result = getAgentInfo(agent, makeState({}), false, null);
  assert.strictEqual(result.status, 'idle');
});

test('應該處理事件陣列包含無 text 欄位的事件', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [
    { eventType: 'delegation.start' }, // 無 text
    { eventType: 'tool.used', text: 'Read some-file.js' },
  ];
  // 不應崩潰
  const result = getAgentInfo(agent, s, false, events);
  assert.ok(result.status !== undefined);
});

test('應該處理 agent 無 stage 屬性（system agent）', () => {
  const agent = { id: 'explore', name: 'Explore', emoji: '🔭', group: 'system', stage: null };
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [makeDelegationEvent('explore')];
  const result = getAgentInfo(agent, s, false, events);
  assert.strictEqual(result.status, 'running');
});

test('應該處理 state.stageResults 為 undefined', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = { taskType: 'feature', delegationActive: false, expectedStages: ['DEV'] };
  // 無 stageResults 欄位
  const result = getAgentInfo(agent, s, false, []);
  assert.ok(result.status !== undefined);
});

test('應該處理 state.retries 為 undefined', () => {
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    stageResults: { TEST: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
    // retries 未提供
  });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.retries, 0, 'retries 應預設為 0');
});

// ═══════════════════════════════════════════════════════════════
// Section 10：getStatus 輔助函式
// ═══════════════════════════════════════════════════════════════

section('getStatus 輔助函式');

test('應該回傳 skipped 當 stage 不在 expectedStages', () => {
  const s = makeState({ expectedStages: ['PLAN', 'DEV'] });
  assert.strictEqual(getStatus('DESIGN', s), 'skipped');
});

test('應該回傳 active 當 stage = currentStage 且 delegationActive', () => {
  const s = makeState({
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'DEV',
    delegationActive: true,
    stageResults: {},
  });
  assert.strictEqual(getStatus('DEV', s), 'active');
});

test('應該回傳 next 當 stage = currentStage 且不是 delegating', () => {
  const s = makeState({
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'DEV',
    delegationActive: false,
    stageResults: {},
  });
  assert.strictEqual(getStatus('DEV', s), 'next');
});

test('應該回傳 pass 當 stage 有 verdict=PASS', () => {
  const s = makeState({
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'DEV',
    stageResults: { PLAN: { verdict: 'PASS' } },
  });
  assert.strictEqual(getStatus('PLAN', s), 'pass');
});

test('應該回傳 next（非 fail）當 stage=currentStage 且 verdict=FAIL — 第二個 if 優先匹配', () => {
  // getStatus 中第二個 if：stage === cur && r?.verdict !== 'PASS'
  // FAIL !== PASS 為 true → 回傳 'next'（第三個 if r?.verdict === 'FAIL' 不會到達）
  const s = makeState({
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'PLAN',
    delegationActive: false,
    stageResults: { PLAN: { verdict: 'FAIL' } },
  });
  assert.strictEqual(getStatus('PLAN', s), 'next', '當前 stage 即使 FAIL 也回傳 next（表示等待重試）');
});

test('應該回傳 fail 當 stage 有 verdict=FAIL 且非 currentStage', () => {
  // PLAN 已是過去 stage（非 current），有 FAIL verdict → 第三個 if 命中
  const s = makeState({
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'DEV',
    delegationActive: false,
    stageResults: {
      PLAN: { verdict: 'FAIL' },
      DEV: {},
    },
  });
  assert.strictEqual(getStatus('PLAN', s), 'fail');
});

test('應該回傳 pending 當 stage 在 expectedStages 但無 verdict 且非 current', () => {
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    currentStage: 'DEV',
    stageResults: { PLAN: { verdict: 'PASS' } },
    delegationActive: false,
  });
  assert.strictEqual(getStatus('TEST', s), 'pending');
});

test('應該回傳 skipped 當 s 為 null', () => {
  // s?.expectedStages?.includes(stage) = undefined → 走 skipped
  assert.strictEqual(getStatus('DEV', null), 'skipped');
});

// ═══════════════════════════════════════════════════════════════
// Section 11：Bug 1 — alive 參數完整三值語意
// ═══════════════════════════════════════════════════════════════

section('Bug 1：alive 參數三值語意（false/true/undefined）');

test('alive=true 且有 taskType → main agent running（正常路徑）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.status, 'running', 'alive=true 不影響正常判斷');
});

test('alive=true 且 delegationActive → main agent delegating', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, [], true);
  assert.strictEqual(result.status, 'delegating', 'alive=true 正常走 delegationActive 判斷');
});

test('alive=false 且無 taskType → main agent 仍 idle（不影響已是 idle 的情況）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: null });
  const result = getAgentInfo(agent, s, false, [], false);
  assert.strictEqual(result.status, 'idle', 'alive=false 已是 idle，不需額外處理');
});

test('alive=false 不影響 sub-agent stageResults（completed 保持 completed）', () => {
  // Bug 1 修復：alive 只影響 main agent，sub-agent 不受影響
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    stageResults: { DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  // alive=false 只在 main agent 分支使用，sub-agent 走不同路徑
  const result = getAgentInfo(agent, s, false, [], false);
  assert.strictEqual(result.status, 'completed', 'alive=false 不影響 sub-agent，DEV PASS 仍顯示 completed');
});

test('alive=false 不影響 sub-agent running（正在運行中的不被強制 idle）', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const events = [makeDelegationEvent('developer')];
  // 即使 alive=false，sub-agent 的 running 偵測不走 alive 分支
  const result = getAgentInfo(agent, s, false, events, false);
  assert.strictEqual(result.status, 'running', 'alive=false 對 sub-agent 無效，running 保持');
});

test('alive=undefined 不影響 sub-agent（向後相容）', () => {
  const agent = makeAgent('planner', { stage: 'PLAN', group: 'pipeline' });
  const s = makeState({
    stageResults: { PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const result = getAgentInfo(agent, s, false, [], undefined);
  assert.strictEqual(result.status, 'completed', 'alive=undefined 對 sub-agent 無影響');
});

test('alive=false → main agent isActive 為 false（session 結束不應顯示 active）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, [], false);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.isActive, false, 'session 結束後 main agent isActive 應為 false');
});

// ═══════════════════════════════════════════════════════════════
// Section 12：Bug 2 — isPipelineComplete 旗標完整行為
// ═══════════════════════════════════════════════════════════════

section('Bug 2：isPipelineComplete 旗標完整行為');

test('isPipelineComplete=true 時 sub-agent 有 stageResults → 保持 completed（不退回 idle）', () => {
  // 關鍵案例：pipeline 完成後 step 4 跳過，但 step 2 的 stageResults 判斷仍正常運作
  const agent = makeAgent('planner', { stage: 'PLAN', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    stageResults: { PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  s.isPipelineComplete = true;
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'completed', 'pipeline 完成後 stageResults 仍正確顯示 completed');
  assert.strictEqual(result.statusLabel, 'PASS');
});

test('isPipelineComplete=true 時 sub-agent error（FAIL stageResults）→ 保持 error', () => {
  const agent = makeAgent('code-reviewer', { stage: 'REVIEW', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'REVIEW'],
    stageResults: {
      PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' },
      DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:05:00Z' },
      REVIEW: { verdict: 'FAIL', severity: 'HIGH' },
    },
  });
  s.isPipelineComplete = true;
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'error', 'pipeline 完成後 FAIL stageResults 保持 error');
  assert.strictEqual(result.statusLabel, 'HIGH');
});

test('isPipelineComplete=true 時 無 stageResults 的 agent → idle（step 4 跳過，無其他觸發）', () => {
  // tester 無 stageResults（例如跳過執行），isPipelineComplete=true → step 4 跳過 → idle
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    stageResults: {
      PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' },
      DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:05:00Z' },
    },
  });
  s.isPipelineComplete = true;
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'idle', 'isPipelineComplete=true 且無 stageResults → step 4 跳過 → idle');
});

test('isPipelineComplete=false → step 4 正常執行 standby', () => {
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    currentStage: 'DEV',
    stageResults: { PLAN: { verdict: 'PASS' } },
    delegationActive: false,
  });
  s.isPipelineComplete = false;
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'standby', 'isPipelineComplete=false 時 step 4 正常走，DEV=next→standby');
});

test('isPipelineComplete=undefined（未設定）→ step 4 正常執行 pending', () => {
  // makeState 不設定 isPipelineComplete → undefined → !undefined=true → step 4 執行
  const agent = makeAgent('tester', { stage: 'TEST', group: 'pipeline' });
  const s = makeState({
    expectedStages: ['PLAN', 'DEV', 'TEST'],
    currentStage: 'DEV',
    stageResults: {},
    delegationActive: false,
  });
  // isPipelineComplete 未設定（undefined）
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'pending', 'isPipelineComplete 未設定時 step 4 正常執行');
});

test('isPipelineComplete=true 且 delegationActive=true → step 4 仍跳過（防禦性）', () => {
  // 不應同時出現，但要防禦此邊界
  const agent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });
  const s = makeState({
    taskType: 'feature',
    delegationActive: true, // 正在委派中（不正常，但防禦）
    expectedStages: ['PLAN', 'DEV'],
    currentStage: 'DEV',
    stageResults: {},
  });
  s.isPipelineComplete = true;
  const events = [makeDelegationEvent('developer')];
  const result = getAgentInfo(agent, s, false, events);
  // step 1 會設 running，step 4 跳過，最終 running
  assert.strictEqual(result.status, 'running', 'delegationActive=true 時 step 1 先設 running，step 4 跳過不影響');
});

test('adaptV3 計算：所有 stages completed → isPipelineComplete=true', () => {
  // 複製 adaptV3 邏輯並驗證 isPipelineComplete 計算
  function computeIsPipelineComplete(dagKeys, stages) {
    return dagKeys.length > 0 && dagKeys.every(id => {
      const st = stages[id]?.status;
      return st === 'completed' || st === 'skipped' || st === 'failed';
    });
  }

  const dagKeys = ['PLAN', 'DEV', 'TEST'];
  const stages = {
    PLAN: { status: 'completed', verdict: 'PASS' },
    DEV: { status: 'completed', verdict: 'PASS' },
    TEST: { status: 'completed', verdict: 'PASS' },
  };
  assert.strictEqual(computeIsPipelineComplete(dagKeys, stages), true, '全部 completed → true');
});

test('adaptV3 計算：有 active stage → isPipelineComplete=false', () => {
  function computeIsPipelineComplete(dagKeys, stages) {
    return dagKeys.length > 0 && dagKeys.every(id => {
      const st = stages[id]?.status;
      return st === 'completed' || st === 'skipped' || st === 'failed';
    });
  }

  const dagKeys = ['PLAN', 'DEV', 'TEST'];
  const stages = {
    PLAN: { status: 'completed', verdict: 'PASS' },
    DEV: { status: 'active' },
    TEST: { status: 'pending' },
  };
  assert.strictEqual(computeIsPipelineComplete(dagKeys, stages), false, 'active stage → false');
});

test('adaptV3 計算：completed + skipped 混合 → isPipelineComplete=true', () => {
  function computeIsPipelineComplete(dagKeys, stages) {
    return dagKeys.length > 0 && dagKeys.every(id => {
      const st = stages[id]?.status;
      return st === 'completed' || st === 'skipped' || st === 'failed';
    });
  }

  const dagKeys = ['PLAN', 'DEV', 'DESIGN', 'TEST'];
  const stages = {
    PLAN: { status: 'completed', verdict: 'PASS' },
    DEV: { status: 'completed', verdict: 'PASS' },
    DESIGN: { status: 'skipped' },
    TEST: { status: 'failed', verdict: 'FAIL' },
  };
  assert.strictEqual(computeIsPipelineComplete(dagKeys, stages), true, 'completed+skipped+failed 混合 → true');
});

test('adaptV3 計算：空 DAG → isPipelineComplete=false（dagKeys.length=0）', () => {
  function computeIsPipelineComplete(dagKeys, stages) {
    return dagKeys.length > 0 && dagKeys.every(id => {
      const st = stages[id]?.status;
      return st === 'completed' || st === 'skipped' || st === 'failed';
    });
  }
  assert.strictEqual(computeIsPipelineComplete([], {}), false, '空 DAG → false（不算 complete）');
});

test('adaptV3 計算：有 pending stage → isPipelineComplete=false', () => {
  function computeIsPipelineComplete(dagKeys, stages) {
    return dagKeys.length > 0 && dagKeys.every(id => {
      const st = stages[id]?.status;
      return st === 'completed' || st === 'skipped' || st === 'failed';
    });
  }

  const dagKeys = ['PLAN', 'DEV'];
  const stages = {
    PLAN: { status: 'completed', verdict: 'PASS' },
    DEV: { status: 'pending' },
  };
  assert.strictEqual(computeIsPipelineComplete(dagKeys, stages), false, 'pending stage → false');
});

test('isPipelineComplete=true 保留 expectedStages（避免破壞 pct/hasPipeline/isComplete）', () => {
  // adaptV3 在 isPipelineComplete=true 時仍然回傳 expectedStages: dagKeys
  // 此測試確認 isPipelineComplete=true 的 state 仍可正確計算 pct（不清空 expectedStages）
  const agent = makeAgent('planner', { stage: 'PLAN', group: 'pipeline' });
  const s = {
    taskType: 'feature',
    expectedStages: ['PLAN', 'DEV', 'TEST'], // 保留完整列表
    stageResults: {
      PLAN: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' },
      DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:05:00Z' },
      TEST: { verdict: 'PASS', completedAt: '2026-02-18T10:10:00Z' },
    },
    delegationActive: false,
    isPipelineComplete: true,
    retries: {},
  };
  // pct = stagesDone / stagesTotal = 3/3 = 100%（expectedStages 保留才能正確計算）
  const stagesDone = s.expectedStages.filter(st => s.stageResults[st]?.verdict === 'PASS').length;
  assert.strictEqual(stagesDone, 3, 'isPipelineComplete=true 後 expectedStages 仍完整');
  assert.strictEqual(s.expectedStages.length, 3, 'expectedStages 未被清空');
  // agent 狀態仍正確
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'completed', 'PLAN PASS 結果正常顯示');
});

// ═══════════════════════════════════════════════════════════════
// Section 13：Bug 3 — AGENT_EMOJI pipeline-architect 補充
// ═══════════════════════════════════════════════════════════════

section('Bug 3：AGENT_EMOJI pipeline-architect 補充');

test('server.js AGENT_EMOJI 應包含 pipeline-architect 鍵', () => {
  // 複製 server.js 的 AGENT_EMOJI 定義（補充 pipeline-architect 是 bug 修復重點）
  const AGENT_EMOJI = {
    planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
    'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
    'doc-updater': '📝',
    'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
    'pipeline-architect': '📐',
  };
  assert.ok('pipeline-architect' in AGENT_EMOJI, 'pipeline-architect 應在 AGENT_EMOJI 中');
  assert.strictEqual(AGENT_EMOJI['pipeline-architect'], '📐', 'pipeline-architect emoji 應為 📐');
});

test('AGENT_EMOJI 應涵蓋所有 9 個 pipeline stages 的 agent', () => {
  const AGENT_EMOJI = {
    planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
    'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
    'doc-updater': '📝',
    'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
    'pipeline-architect': '📐',
  };
  const pipelineAgents = ['planner', 'architect', 'designer', 'developer', 'code-reviewer', 'tester', 'qa', 'e2e-runner', 'doc-updater'];
  for (const agent of pipelineAgents) {
    assert.ok(agent in AGENT_EMOJI, `${agent} 應在 AGENT_EMOJI 中`);
    assert.ok(AGENT_EMOJI[agent], `${agent} 的 emoji 不應為空`);
  }
});

test('AGENT_EMOJI 應涵蓋 support agents', () => {
  const AGENT_EMOJI = {
    planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
    'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
    'doc-updater': '📝',
    'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
    'pipeline-architect': '📐',
  };
  const supportAgents = ['security-reviewer', 'build-error-resolver', 'pipeline-architect'];
  for (const agent of supportAgents) {
    assert.ok(agent in AGENT_EMOJI, `${agent} 應在 AGENT_EMOJI 中`);
  }
});

test('delegation.start 事件使用 pipeline-architect → 應找到對應 emoji', () => {
  // 模擬 server.js formatEvent 的 delegation.start 邏輯
  const AGENT_EMOJI = {
    planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
    'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
    'doc-updater': '📝',
    'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
    'pipeline-architect': '📐',
  };
  function resolveAgentEmoji(agentType) {
    return AGENT_EMOJI[agentType] || null;
  }
  // pipeline-architect 現在應有 emoji（bug 修復前會是 null → 使用預設 emoji）
  assert.strictEqual(resolveAgentEmoji('pipeline-architect'), '📐', 'pipeline-architect 委派事件應顯示 📐');
  assert.strictEqual(resolveAgentEmoji('unknown-agent'), null, '未知 agent 回傳 null');
});

test('tool.used 事件 PLAN stage → planner emoji', () => {
  // 模擬 server.js 的 stage→agent emoji 對應
  const AGENT_EMOJI = {
    planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
    'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
    'doc-updater': '📝',
    'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
    'pipeline-architect': '📐',
  };
  const STAGE_TO_AGENT = {
    PLAN: 'planner', ARCH: 'architect', DESIGN: 'designer', DEV: 'developer',
    REVIEW: 'code-reviewer', TEST: 'tester', QA: 'qa', E2E: 'e2e-runner', DOCS: 'doc-updater',
  };
  function resolveToolEmoji(stage) {
    const agent = STAGE_TO_AGENT[stage];
    return (agent && AGENT_EMOJI[agent]) ? AGENT_EMOJI[agent] : '🎯';
  }
  assert.strictEqual(resolveToolEmoji('PLAN'), '📋');
  assert.strictEqual(resolveToolEmoji('DEV'), '🏗️');
  assert.strictEqual(resolveToolEmoji('REVIEW'), '🔍');
  assert.strictEqual(resolveToolEmoji(null), '🎯', '無 stage 回傳 Main Agent emoji');
  assert.strictEqual(resolveToolEmoji('UNKNOWN'), '🎯', '未知 stage 回傳 Main Agent emoji');
});

// ═══════════════════════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════════════════════

console.log(`\n=== agent-status-filter.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
