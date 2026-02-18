#!/usr/bin/env node
/**
 * agent-status-filter.test.js — AgentStatus 元件過濾邏輯測試
 *
 * 測試範圍：
 *   1. getAgentInfo()：各種狀態下的 agent 資訊計算
 *      - main agent 狀態（閒置/等待/委派中/運行中）
 *      - sub-agent 狀態（running/completed/error/standby/pending/skipped）
 *      - isActive / skillsLit 旗標
 *   2. AgentStatus 過濾邏輯（HIDDEN_STATUSES 排除法）
 *      - 無活躍 agent → 回傳 null（面板隱藏）
 *      - 隱藏 idle / completed / standby / pending / skipped
 *      - 其他狀態（running / delegating / waiting / error）全部顯示
 *      - 多個活躍 agent 全部顯示
 *   3. 狀態轉換：
 *      - idle → running → completed（面板出現→消失）
 *      - 最後一個活躍 agent 完成後面板隱藏
 *   4. 邊界案例：
 *      - null / undefined state
 *      - 空事件陣列
 *      - askPending 旗標
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
function getAgentInfo(agent, s, askPending, events) {
  let status = 'idle', statusLabel = '閒置', dur = null, tools = null, retries = 0;

  if (agent.id === 'main') {
    if (!s || !s.taskType) { /* 尚未分類 → 閒置 */ }
    else if (askPending) { status = 'waiting'; statusLabel = '等待回覆'; }
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
    // 4. Pipeline 排程：待命/等待/跳過
    if (status === 'idle' && agent.stage && s?.expectedStages?.includes(agent.stage)) {
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
 * 模擬 AgentStatus 的過濾邏輯（不含 DOM 渲染）
 * 回傳：activeAgents 陣列（或 null 代表面板隱藏）
 *
 * 使用排除法（HIDDEN_STATUSES）而非白名單（ACTIVE_STATUSES）
 * 確保新增狀態（如 error）不會被意外隱藏
 */
function simulateAgentStatusFilter(allAgents) {
  const HIDDEN_STATUSES = ['idle', 'completed', 'standby', 'pending', 'skipped'];
  const activeAgents = allAgents.filter(a => !HIDDEN_STATUSES.includes(a.status));
  if (activeAgents.length === 0) return null;
  return activeAgents;
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
  const result = getAgentInfo(agent, null, false, []);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.statusLabel, '閒置');
});

test('應該回傳 idle 當 state 無 taskType', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: null });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'idle');
});

test('應該回傳 waiting 當 askPending 為 true', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature' });
  const result = getAgentInfo(agent, s, true, []);
  assert.strictEqual(result.status, 'waiting');
  assert.strictEqual(result.statusLabel, '等待回覆');
});

test('應該回傳 delegating 當 delegationActive 為 true', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'delegating');
  assert.strictEqual(result.statusLabel, '委派中');
});

test('應該回傳 running 當有 taskType 且 delegationActive 為 false', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.status, 'running');
  assert.strictEqual(result.statusLabel, '運行中');
});

test('應該 askPending 優先於 delegationActive（waiting 覆蓋 delegating）', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: true });
  const result = getAgentInfo(agent, s, true, []);
  assert.strictEqual(result.status, 'waiting');
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
  const result = getAgentInfo(agent, s, false, []);
  assert.strictEqual(result.isActive, true);
});

test('應該 isActive = false 當 status = waiting', () => {
  const agent = makeAgent('main');
  const s = makeState({ taskType: 'feature' });
  const result = getAgentInfo(agent, s, true, []);
  assert.strictEqual(result.status, 'waiting');
  assert.strictEqual(result.isActive, false);
  assert.strictEqual(result.skillsLit, false);
});

test('應該 isActive = false 當 status = idle', () => {
  const agent = makeAgent('main');
  const result = getAgentInfo(agent, null, false, []);
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

section('AgentStatus 過濾邏輯：HIDDEN_STATUSES 排除法');

test('應該回傳 null 當無任何活躍 agent', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'completed' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result, null);
});

test('應該回傳 null 當所有 agent 為 idle', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('planner', { stage: 'PLAN' }), status: 'idle' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result, null);
});

test('應該回傳 null 當 agents 陣列為空', () => {
  const result = simulateAgentStatusFilter([]);
  assert.strictEqual(result, null);
});

test('應該回傳包含 running agent 的陣列', () => {
  const agents = [
    { ...makeAgent('main'), status: 'idle' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.ok(result !== null, '有 running agent 時面板應顯示');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'developer');
});

test('應該回傳包含 delegating agent 的陣列', () => {
  const agents = [
    { ...makeAgent('main'), status: 'delegating' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'idle' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.ok(result !== null, '有 delegating agent 時面板應顯示');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'main');
});

test('應該回傳包含 waiting agent 的陣列', () => {
  const agents = [
    { ...makeAgent('main'), status: 'waiting' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'idle' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.ok(result !== null, 'waiting agent 時面板應顯示');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].status, 'waiting');
});

test('應該包含全部活躍 agent 當多個 agent 活躍', () => {
  const agents = [
    { ...makeAgent('main'), status: 'delegating' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
    { ...makeAgent('code-reviewer', { stage: 'REVIEW' }), status: 'completed' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.ok(result !== null);
  assert.strictEqual(result.length, 2);
  const ids = result.map(a => a.id);
  assert.ok(ids.includes('main'));
  assert.ok(ids.includes('developer'));
});

test('應該過濾掉 completed 狀態的 agent', () => {
  const agents = [
    { ...makeAgent('planner', { stage: 'PLAN' }), status: 'completed' },
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'running' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'developer');
});

test('應該顯示 error 狀態的 agent（排除法不隱藏 error）', () => {
  const agents = [
    { ...makeAgent('code-reviewer', { stage: 'REVIEW' }), status: 'error' },
    { ...makeAgent('main'), status: 'running' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result.length, 2, 'error + running 都應顯示');
  const ids = result.map(a => a.id);
  assert.ok(ids.includes('code-reviewer'), 'error agent 應被顯示');
  assert.ok(ids.includes('main'), 'running agent 應被顯示');
});

test('應該過濾掉 standby 狀態的 agent', () => {
  const agents = [
    { ...makeAgent('developer', { stage: 'DEV' }), status: 'standby' },
    { ...makeAgent('tester', { stage: 'TEST' }), status: 'pending' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result, null);
});

test('應該過濾掉 skipped 狀態的 agent', () => {
  const agents = [
    { ...makeAgent('designer', { stage: 'DESIGN' }), status: 'skipped' },
  ];
  const result = simulateAgentStatusFilter(agents);
  assert.strictEqual(result, null);
});

// ═══════════════════════════════════════════════════════════════
// Section 8：狀態轉換模擬
// ═══════════════════════════════════════════════════════════════

section('狀態轉換模擬（idle → running → completed → 面板隱藏）');

test('應該面板出現 當 agent 從 idle 變為 running', () => {
  const agentDef = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  // 狀態 1：idle（尚未委派）
  const s1 = makeState({ taskType: 'feature', delegationActive: false });
  const info1 = getAgentInfo(agentDef, s1, false, []);
  const panel1 = simulateAgentStatusFilter([info1]);
  assert.strictEqual(panel1, null, 'idle 時面板應隱藏');

  // 狀態 2：running（委派中）
  const s2 = makeState({ taskType: 'feature', delegationActive: true });
  const events2 = [makeDelegationEvent('developer')];
  const info2 = getAgentInfo(agentDef, s2, false, events2);
  const panel2 = simulateAgentStatusFilter([info2]);
  assert.ok(panel2 !== null, 'running 時面板應顯示');
  assert.strictEqual(panel2[0].status, 'running');
});

test('應該面板消失 當 agent 從 running 變為 completed', () => {
  const agentDef = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  // 狀態 1：running（正在執行）
  const s1 = makeState({ taskType: 'feature', delegationActive: true });
  const events1 = [makeDelegationEvent('developer')];
  const info1 = getAgentInfo(agentDef, s1, false, events1);
  const panel1 = simulateAgentStatusFilter([info1]);
  assert.ok(panel1 !== null, 'running 時面板應顯示');

  // 狀態 2：completed（DEV 完成，無委派）
  const s2 = makeState({
    taskType: 'feature',
    delegationActive: false,
    stageResults: { DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const info2 = getAgentInfo(agentDef, s2, false, []);
  const panel2 = simulateAgentStatusFilter([info2]);
  assert.strictEqual(panel2, null, 'completed 後面板應隱藏');
});

test('應該面板隱藏 當最後一個活躍 agent 完成', () => {
  // main agent 委派中（delegating），developer running
  const mainAgent = makeAgent('main');
  const devAgent = makeAgent('developer', { stage: 'DEV', group: 'pipeline' });

  const sActive = makeState({ taskType: 'feature', delegationActive: true });
  const eventsActive = [makeDelegationEvent('developer')];
  const mainInfo1 = getAgentInfo(mainAgent, sActive, false, eventsActive);
  const devInfo1 = getAgentInfo(devAgent, sActive, false, eventsActive);
  const panel1 = simulateAgentStatusFilter([mainInfo1, devInfo1]);
  assert.ok(panel1 !== null, 'active 時面板應顯示');
  assert.strictEqual(panel1.length, 2, '應有 main(delegating) + developer(running)');

  // DEV 完成，main 回到 running（無委派）
  const sComplete = makeState({
    taskType: 'feature',
    delegationActive: false,
    stageResults: { DEV: { verdict: 'PASS', completedAt: '2026-02-18T10:00:00Z' } },
  });
  const mainInfo2 = getAgentInfo(mainAgent, sComplete, false, []);
  const devInfo2 = getAgentInfo(devAgent, sComplete, false, []);
  // main 現在是 running，developer 是 completed
  const panel2 = simulateAgentStatusFilter([mainInfo2, devInfo2]);
  assert.ok(panel2 !== null, 'main 仍 running 時面板應顯示');
  assert.strictEqual(panel2.length, 1, '只有 main running，developer 已 completed');

  // pipeline 完成，taskType 清空（或 delegationActive 永久 false）
  const sIdle = makeState({ taskType: null, delegationActive: false });
  const mainInfo3 = getAgentInfo(mainAgent, sIdle, false, []);
  const devInfo3 = getAgentInfo(devAgent, sIdle, false, []);
  const panel3 = simulateAgentStatusFilter([mainInfo3, devInfo3]);
  assert.strictEqual(panel3, null, 'pipeline 結束後面板應隱藏');
});

test('應該面板出現 當 main agent 進入 waiting（askPending）', () => {
  const mainAgent = makeAgent('main');
  const s = makeState({ taskType: 'feature', delegationActive: false });
  const mainInfo = getAgentInfo(mainAgent, s, true, []);
  const panel = simulateAgentStatusFilter([mainInfo]);
  assert.ok(panel !== null, 'waiting 時面板應顯示');
  assert.strictEqual(panel[0].status, 'waiting');
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
// 結果輸出
// ═══════════════════════════════════════════════════════════════

console.log(`\n=== agent-status-filter.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
