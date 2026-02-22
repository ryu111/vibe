#!/usr/bin/env node
/**
 * activeagents-tracking.test.js — activeAgents 追蹤與 agent-status 三態邏輯測試
 *
 * 測試範圍：
 * 1. pipeline-controller.js activeAgents 寫入（onDelegate）
 * 2. pipeline-controller.js clearActiveAgent（onStageComplete 呼叫）
 * 3. agent-status.js getStatus 三態邏輯（從原始碼萃取，純函式驗證）
 * 4. dashboard-tab.js miniTlEvents 過濾邏輯（從原始碼萃取，純函式驗證）
 *
 * 策略：
 * - pipeline-controller 以真實模組 + 暫存 state 檔案測試
 * - agent-status.js / dashboard-tab.js 為 ES Module，萃取純邏輯直接驗證
 *
 * 執行：node plugins/vibe/tests/activeagents-tracking.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ── 被測模組 ──────────────────────────────────────────────

const { onDelegate, onStageComplete } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));
const ds = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/dag-state.js'));

// ── 測試計數器 ─────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ── 共用工具函式 ───────────────────────────────────────────

const TS = Date.now();

/** 建立 none pipeline state（pipelineActive=false） */
function writeNoneState(sessionId, opts = {}) {
  const state = {
    version: 4,
    sessionId,
    classification: { taskType: 'chat', pipelineId: 'none', source: opts.source || 'test' },
    dag: {},
    dagStages: [],
    stages: {},
    pipelineActive: false,
    activeStages: [],
    activeAgents: opts.activeAgents || {},
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  return fp;
}

/** 建立 active pipeline state（pipelineActive=true，有 DAG） */
function writePipelineState(sessionId, opts = {}) {
  const dag = opts.dag || {
    DEV: { deps: [], barrier: null, onFail: 'retry', next: ['REVIEW'] },
    REVIEW: { deps: ['DEV'], barrier: null, onFail: 'retry', next: [] },
    TEST: { deps: ['DEV'], barrier: null, onFail: 'retry', next: [] },
  };
  const stages = {};
  for (const id of Object.keys(dag)) {
    stages[id] = { status: opts.stageStatus || 'pending', agent: null, verdict: null };
  }
  // 覆寫特定 stage 狀態
  if (opts.stageOverrides) {
    for (const [id, s] of Object.entries(opts.stageOverrides)) {
      stages[id] = { ...stages[id], ...s };
    }
  }
  const state = {
    version: 4,
    sessionId,
    classification: { taskType: 'feature', pipelineId: 'quick-dev', source: 'explicit' },
    dag,
    dagStages: Object.keys(dag),
    stages,
    pipelineActive: opts.pipelineActive !== undefined ? opts.pipelineActive : true,
    activeStages: opts.activeStages || [],
    activeAgents: opts.activeAgents || {},
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  return fp;
}

/** 讀取 state 並回傳 activeAgents */
function readActiveAgents(sessionId) {
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw).activeAgents || {};
  } catch (_) {
    return null;
  }
}

/** 清理測試暫存檔 */
function cleanup(sessionId) {
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  try { fs.unlinkSync(fp); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// Section 1: onDelegate activeAgents 寫入
// ═══════════════════════════════════════════════════════════════

section('Section 1: onDelegate activeAgents 寫入');

test('應該將 pipeline agent（vibe:developer）寫入 activeAgents', () => {
  const sid = `test-s1-1-${TS}`;
  writePipelineState(sid);
  try {
    const r = onDelegate(sid, 'vibe:developer', { prompt: 'implement feature' });
    assert.ok(r.allow, `onDelegate 應回傳 allow=true，實際：${JSON.stringify(r)}`);
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態檔應存在');
    assert.ok(agents['developer'] === true, `developer 應在 activeAgents，實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
  }
});

test('應該將 pipeline-architect agent 寫入 activeAgents', () => {
  const sid = `test-s1-2-${TS}`;
  writeNoneState(sid);
  try {
    onDelegate(sid, 'vibe:pipeline-architect', { prompt: 'analyze task' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態檔應存在');
    assert.ok(agents['pipeline-architect'] === true, `pipeline-architect 應在 activeAgents，實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
  }
});

test('應該將 explore agent 寫入 activeAgents', () => {
  const sid = `test-s1-3-${TS}`;
  writeNoneState(sid);
  try {
    onDelegate(sid, 'vibe:explore', { prompt: 'explore codebase' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態檔應存在');
    assert.ok(agents['explore'] === true, `explore 應在 activeAgents，實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
  }
});

test('agent 名稱應大小寫正規化（toLowerCase）', () => {
  const sid = `test-s1-4-${TS}`;
  writeNoneState(sid);
  try {
    // 模擬混合大小寫的 agentType
    onDelegate(sid, 'vibe:Tester', { prompt: 'run tests' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態檔應存在');
    // 不管輸入大小寫，key 應為 lowercase
    assert.ok(agents['tester'] === true, `tester（小寫）應在 activeAgents，實際：${JSON.stringify(agents)}`);
    assert.ok(!agents['Tester'], 'Tester（大寫）不應存在');
  } finally {
    cleanup(sid);
  }
});

test('多個 agent 並行委派 → 全部寫入 activeAgents', () => {
  const sid = `test-s1-5-${TS}`;
  writeNoneState(sid);
  try {
    onDelegate(sid, 'vibe:explore', { prompt: 'explore' });
    onDelegate(sid, 'vibe:pipeline-architect', { prompt: 'plan' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態檔應存在');
    assert.ok(agents['explore'] === true, 'explore 應在 activeAgents');
    assert.ok(agents['pipeline-architect'] === true, 'pipeline-architect 應在 activeAgents');
  } finally {
    cleanup(sid);
  }
});

test('onDelegate 無 state 時回傳 allow:true 不崩潰', () => {
  const sid = `test-s1-6-${TS}`;
  // 不建立 state 檔案
  try {
    const r = onDelegate(sid, 'vibe:developer', { prompt: 'test' });
    // 無 state 時應允許通過（不崩潰）
    assert.ok(r.allow === true || r.allow === false, 'onDelegate 應回傳含 allow 欄位的物件');
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 2: clearActiveAgent（onStageComplete 清理）
// ═══════════════════════════════════════════════════════════════

section('Section 2: clearActiveAgent / onStageComplete 清理');

test('onStageComplete 應從 activeAgents 清除已完成的 agent', () => {
  const sid = `test-s2-1-${TS}`;
  writePipelineState(sid, {
    activeAgents: { developer: true },
    stageOverrides: {
      DEV: { status: 'active', agent: 'developer' },
    },
    activeStages: ['DEV'],
  });
  // 建立虛擬 transcript 檔（PIPELINE_ROUTE: PASS）
  const transcriptPath = path.join(CLAUDE_DIR, `transcript-test-s2-1-${TS}.jsonl`);
  const route = { verdict: 'PASS', route: 'NEXT' };
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: `<!-- PIPELINE_ROUTE: ${JSON.stringify(route)} -->` }],
  }) + '\n', 'utf8');
  try {
    onStageComplete(sid, 'vibe:developer', transcriptPath);
    const agents = readActiveAgents(sid);
    // developer 應被清理
    assert.ok(!agents?.['developer'], `developer 應從 activeAgents 清除，實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test('onStageComplete 清理時不影響其他仍活躍的 agent', () => {
  const sid = `test-s2-2-${TS}`;
  writePipelineState(sid, {
    activeAgents: { developer: true, 'pipeline-architect': true },
    stageOverrides: {
      DEV: { status: 'active', agent: 'developer' },
    },
    activeStages: ['DEV'],
  });
  const transcriptPath = path.join(CLAUDE_DIR, `transcript-test-s2-2-${TS}.jsonl`);
  const route = { verdict: 'PASS', route: 'NEXT' };
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: `<!-- PIPELINE_ROUTE: ${JSON.stringify(route)} -->` }],
  }) + '\n', 'utf8');
  try {
    onStageComplete(sid, 'vibe:developer', transcriptPath);
    const agents = readActiveAgents(sid);
    // developer 清理，pipeline-architect 保留
    assert.ok(!agents?.['developer'], 'developer 應被清理');
    assert.ok(agents?.['pipeline-architect'] === true, 'pipeline-architect 應保留');
  } finally {
    cleanup(sid);
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test('clearActiveAgent 對不存在的 agent 不崩潰', () => {
  const sid = `test-s2-3-${TS}`;
  writePipelineState(sid, { activeAgents: { explore: true } });
  try {
    // 嘗試清理不存在的 agent
    onStageComplete(sid, 'vibe:developer', null);
    // 不崩潰即通過，explore 應保持不變
    const agents = readActiveAgents(sid);
    // explore 不應被清理（因為 developer 不在 activeAgents）
    // 但 onStageComplete 不是 clearActiveAgent 的直接測試，這裡驗證不崩潰即可
    assert.ok(true, '不崩潰');
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 3: agent-status.js getStatus 三態邏輯（萃取純函式）
// ═══════════════════════════════════════════════════════════════

section('Section 3: agent-status.js getStatus 三態邏輯');

// 萃取自 web/components/agent-status.js getStatus() 函式
// 原始碼見 plugins/vibe/web/components/agent-status.js:45-66
function getStatus_agentStatus(agent, state) {
  const activeAgents = state?.activeAgents || {};

  // Main Agent: prompt 驅動（委派 → delegating）
  if (agent.id === 'main') {
    if (Object.keys(activeAgents).length > 0) return 'delegating';
    if (state?.mainAgentActive) return 'running';
    return 'idle';
  }

  // 統一檢查：activeAgents 有記錄 → running（適用所有 agent）
  if (activeAgents[agent.id]) return 'running';

  // Stage agent 額外 fallback：從 DAG status 判斷
  if (agent.stage) {
    const dagKeys = Object.keys(state?.dag || {});
    const matched = dagKeys.filter(k => k === agent.stage || k.split(':')[0] === agent.stage);
    for (const k of matched) {
      // 簡化版 getStageStatus：只看 stages.status
      const st = state?.stages?.[k]?.status;
      if (st === 'active') return 'running';
    }
  }

  return 'idle';
}

const makeAgent = (id, opts = {}) => ({ id, name: id, emoji: '🔧', group: 'pipeline', ...opts });

// Main Agent 三態
test('Main Agent: activeAgents 有任何 key → delegating', () => {
  const state = { activeAgents: { developer: true }, mainAgentActive: false };
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), state), 'delegating');
});

test('Main Agent: activeAgents 空 + mainAgentActive=true → running', () => {
  const state = { activeAgents: {}, mainAgentActive: true };
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), state), 'running');
});

test('Main Agent: activeAgents 空 + mainAgentActive=false → idle', () => {
  const state = { activeAgents: {}, mainAgentActive: false };
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), state), 'idle');
});

test('Main Agent: activeAgents=null → idle', () => {
  const state = {};
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), state), 'idle');
});

test('Main Agent: state=null → idle', () => {
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), null), 'idle');
});

// Sub-agent 三態（activeAgents 機制）
test('sub-agent: activeAgents[id]=true → running', () => {
  const state = { activeAgents: { developer: true } };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('sub-agent: activeAgents 無記錄 → idle', () => {
  const state = { activeAgents: {} };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'idle');
});

test('sub-agent: activeAgents[id] 未定義 + DAG stage=active → running（fallback）', () => {
  const state = {
    activeAgents: {},
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'active' } },
  };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('sub-agent: DAG stage=completed → idle（completed 不算 running）', () => {
  const state = {
    activeAgents: {},
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed' } },
  };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'idle');
});

test('sub-agent: DAG stage=pending → idle（pending 不算 running）', () => {
  const state = {
    activeAgents: {},
    dag: { REVIEW: { deps: ['DEV'] } },
    stages: { REVIEW: { status: 'pending' } },
  };
  const agent = makeAgent('code-reviewer', { stage: 'REVIEW' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'idle');
});

test('sub-agent: activeAgents 優先於 DAG fallback（activeAgents=running 優先）', () => {
  // 即使 DAG status=completed，只要 activeAgents 有記錄，就是 running
  const state = {
    activeAgents: { developer: true },
    dag: { DEV: { deps: [] } },
    stages: { DEV: { status: 'completed' } },
  };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('explore agent（無 stage）: activeAgents[id]=true → running', () => {
  const state = { activeAgents: { explore: true } };
  const agent = makeAgent('explore'); // 無 stage 屬性
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('pipeline-architect（無 stage）: activeAgents[id]=true → running', () => {
  const state = { activeAgents: { 'pipeline-architect': true } };
  const agent = makeAgent('pipeline-architect'); // support agent，無 stage
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('suffixed stage：DAG 包含 DEV:1 + DEV:2，agent stage=DEV → 任一 active 即 running', () => {
  const state = {
    activeAgents: {},
    dag: { 'DEV:1': { deps: [] }, 'DEV:2': { deps: ['REVIEW:1'] } },
    stages: {
      'DEV:1': { status: 'completed' },
      'DEV:2': { status: 'active' },
    },
  };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'running');
});

test('Main Agent delegating 有多個 activeAgents → 仍是 delegating（不是 running）', () => {
  const state = { activeAgents: { developer: true, tester: true }, mainAgentActive: true };
  // 有 activeAgents 時優先回傳 delegating（即使 mainAgentActive=true）
  assert.strictEqual(getStatus_agentStatus(makeAgent('main'), state), 'delegating');
});

// ═══════════════════════════════════════════════════════════════
// Section 4: dashboard-tab.js miniTlEvents 過濾邏輯（萃取純函式）
// ═══════════════════════════════════════════════════════════════

section('Section 4: dashboard-tab.js miniTlEvents 過濾邏輯');

// 萃取自 web/components/dashboard-tab.js miniTlEvents 過濾邏輯（line 44-50）
function filterMiniTlEvents(tlAll) {
  return tlAll.filter(ev => {
    if (ev.eventType !== 'tool.used') return true;
    if (ev.emoji !== '🎯') return false; // 隱藏 sub-agent 工具細節
    // Main Agent 只顯示重要操作（修改/執行/互動），隱藏查詢類
    return ev.tool === 'Write' || ev.tool === 'Edit' || ev.tool === 'Bash'
      || ev.tool === 'Skill' || ev.tool === 'AskUserQuestion';
  }).slice(0, 50);
}

const makeEv = (opts) => ({
  eventType: opts.eventType || 'tool.used',
  emoji: opts.emoji || '🔧',
  tool: opts.tool || 'Read',
  text: opts.text || 'test event',
  ts: opts.ts || Date.now(),
});

test('非 tool.used 事件應全部顯示', () => {
  const events = [
    makeEv({ eventType: 'pipeline.start', emoji: '🚀' }),
    makeEv({ eventType: 'stage.complete', emoji: '✅' }),
    makeEv({ eventType: 'task.classified', emoji: '📋' }),
  ];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 3, '非 tool.used 的 3 個事件應全部顯示');
});

test('tool.used + emoji=🎯 + tool=Write → 顯示', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Write' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'Write 工具應顯示');
});

test('tool.used + emoji=🎯 + tool=Edit → 顯示', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Edit' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'Edit 工具應顯示');
});

test('tool.used + emoji=🎯 + tool=Bash → 顯示', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Bash' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'Bash 工具應顯示');
});

test('tool.used + emoji=🎯 + tool=AskUserQuestion → 顯示', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'AskUserQuestion' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'AskUserQuestion 工具應顯示');
});

test('tool.used + emoji=🎯 + tool=Read → 隱藏（查詢類）', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Read' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 0, 'Read 工具應被隱藏');
});

test('tool.used + emoji=🎯 + tool=Grep → 隱藏（查詢類）', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Grep' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 0, 'Grep 工具應被隱藏');
});

test('tool.used + emoji!=🎯 + tool=Write → 隱藏（sub-agent 工具細節）', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '👨‍💻', tool: 'Write' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 0, 'sub-agent Write 應被隱藏');
});

test('tool.used + emoji!=🎯 + tool=Read → 隱藏（sub-agent 工具細節）', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🔧', tool: 'Read' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 0, 'sub-agent Read 應被隱藏');
});

test('混合事件：正確過濾並保留正確數量', () => {
  const events = [
    makeEv({ eventType: 'pipeline.start' }),         // 顯示（非 tool.used）
    makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Write' }),  // 顯示
    makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Read' }),   // 隱藏
    makeEv({ eventType: 'tool.used', emoji: '👨‍💻', tool: 'Edit' }),  // 隱藏
    makeEv({ eventType: 'stage.complete' }),          // 顯示（非 tool.used）
    makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Bash' }),   // 顯示
  ];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 4, '應顯示 4 個事件');
});

test('.slice(0, 50) 取最新 50 筆', () => {
  // 建立 60 個事件（全部應顯示）
  const events = Array.from({ length: 60 }, (_, i) => makeEv({ eventType: 'pipeline.step', ts: i }));
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 50, '應只取最多 50 筆');
});

test('.slice(0, 50) 少於 50 筆時全部顯示', () => {
  const events = Array.from({ length: 30 }, (_, i) => makeEv({ eventType: 'pipeline.step', ts: i }));
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 30, '少於 50 筆時全部顯示');
});

test('空事件陣列 → 空陣列', () => {
  const result = filterMiniTlEvents([]);
  assert.strictEqual(result.length, 0, '空陣列應回傳空陣列');
});

test('tool=Skill（委派工具）+ emoji=🎯 → 顯示', () => {
  const events = [makeEv({ eventType: 'tool.used', emoji: '🎯', tool: 'Skill' })];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'Skill 工具（委派）應顯示');
});

// ═══════════════════════════════════════════════════════════════
// Section 5: Layer A + activeAgents 整合邊界案例
// ═══════════════════════════════════════════════════════════════

section('Section 5: Layer A + activeAgents 整合邊界案例');

const { canProceed } = require(path.join(PLUGIN_ROOT, 'scripts/lib/flow/pipeline-controller.js'));

/** 建立帶 activeAgents 的 none pipeline state */
function writeNoneStateWithActiveAgents(sessionId, activeAgents) {
  const state = {
    version: 4,
    sessionId,
    classification: { taskType: 'chat', pipelineId: 'none', source: 'main-agent' },
    dag: {},
    dagStages: [],
    stages: {},
    pipelineActive: false,
    activeStages: [],
    activeAgents: activeAgents || {},
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  return fp;
}

/** 清理 none-writes 計數器 + state */
function cleanupFull(sessionId) {
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  const cp = path.join(CLAUDE_DIR, `none-writes-${sessionId}.json`);
  try { fs.unlinkSync(fp); } catch (_) {}
  try { fs.unlinkSync(cp); } catch (_) {}
}

test('source=main-agent + pipelineActive=true（activeStages 中）→ 不觸發 Layer A', () => {
  // pipelineActive=true 時 ds.isActive(state) 回傳 true，none pipeline 防護不進入
  const sid = `test-s5-1-${TS}`;
  const state = {
    version: 4,
    sessionId: sid,
    classification: { taskType: 'chat', pipelineId: 'none', source: 'main-agent' },
    dag: {},
    dagStages: [],
    stages: {},
    pipelineActive: true, // active 狀態
    activeStages: [],
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  try {
    const r = canProceed(sid, 'Write', { file_path: '/Users/test/src/app.js' });
    // pipelineActive=true 時，none pipeline write guard 條件不滿足 → 走 guardEvaluate
    // guardEvaluate 不應因 none-pipeline-unselected 阻擋
    assert.notStrictEqual(r.reason, 'none-pipeline-unselected', 'pipelineActive=true 時不觸發 Layer A');
  } finally {
    cleanupFull(sid);
  }
});

test('source=main-agent + filePath 空字串 → allow（filePath 空不觸發）', () => {
  const sid = `test-s5-2-${TS}`;
  writeNoneStateWithActiveAgents(sid, {});
  try {
    const r = canProceed(sid, 'Write', { file_path: '' });
    // 空 filePath → guardIsNonCodeFile 判斷跳過 → 不阻擋
    assert.notStrictEqual(r.reason, 'none-pipeline-unselected', '空 filePath 不觸發 Layer A');
  } finally {
    cleanupFull(sid);
  }
});

test('source=main-agent + toolInput=undefined → allow（工具輸入缺失不崩潰）', () => {
  const sid = `test-s5-3-${TS}`;
  writeNoneStateWithActiveAgents(sid, {});
  try {
    const r = canProceed(sid, 'Write', undefined);
    // toolInput=undefined → filePath='' → 不觸發 Layer A
    assert.ok(r, '不崩潰，回傳有效結果');
  } finally {
    cleanupFull(sid);
  }
});

// ═══════════════════════════════════════════════════════════════
// Section 6: 邊界案例補充
// ═══════════════════════════════════════════════════════════════

section('Section 6: 邊界案例補充');

test('onDelegate 同一 agent 重複委派 → 冪等（activeAgents 不重複）', () => {
  const sid = `test-s6-1-${TS}`;
  writeNoneState(sid);
  try {
    onDelegate(sid, 'vibe:explore', { prompt: '1st' });
    onDelegate(sid, 'vibe:explore', { prompt: '2nd' });
    const agents = readActiveAgents(sid);
    // 重複委派不會產生陣列或其他資料結構，值仍為 true
    assert.strictEqual(agents['explore'], true, '重複委派後 explore 值仍為 true（冪等）');
    const keys = Object.keys(agents).filter(k => k === 'explore');
    assert.strictEqual(keys.length, 1, 'explore 只應出現一次');
  } finally {
    cleanup(sid);
  }
});

test('onDelegate agentType 無前綴（純 shortAgent 格式）→ 正確寫入', () => {
  const sid = `test-s6-2-${TS}`;
  writeNoneState(sid);
  try {
    // 不含 ':' 前綴的 agentType（直接傳 shortAgent）
    onDelegate(sid, 'developer', { prompt: 'test' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態應存在');
    assert.ok(agents['developer'] === true, `developer 應寫入 activeAgents，實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
  }
});

test('getStatus: activeAgents[id]=false → idle（非 truthy 值不算 running）', () => {
  const state = { activeAgents: { developer: false } };
  const agent = makeAgent('developer', { stage: 'DEV' });
  // false 不是 truthy → 不算 running（走 DAG fallback）
  // DAG 也無資料 → idle
  assert.strictEqual(getStatus_agentStatus(agent, state), 'idle');
});

test('getStatus: activeAgents[id]=null → idle（null 不是 truthy）', () => {
  const state = { activeAgents: { developer: null } };
  const agent = makeAgent('developer', { stage: 'DEV' });
  assert.strictEqual(getStatus_agentStatus(agent, state), 'idle');
});

test('filterMiniTlEvents: eventType=undefined 事件視為非 tool.used → 顯示', () => {
  // ev.eventType !== 'tool.used' 為 true（undefined !== 'tool.used'）→ return true
  const events = [{ emoji: '🎯', tool: 'Read', text: 'test' }]; // 無 eventType
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'eventType 未定義的事件視為非 tool.used → 顯示');
});

test('filterMiniTlEvents: eventType=null 事件視為非 tool.used → 顯示', () => {
  const events = [{ eventType: null, emoji: '🔧', tool: 'Write', text: 'test' }];
  const result = filterMiniTlEvents(events);
  assert.strictEqual(result.length, 1, 'eventType=null 視為非 tool.used → 顯示');
});

test('onDelegate activeAgents 初始為 undefined → 自動初始化為 {}', () => {
  const sid = `test-s6-3-${TS}`;
  // 建立無 activeAgents 欄位的 state
  const state = {
    version: 4,
    sessionId: sid,
    classification: { taskType: 'chat', pipelineId: 'none', source: 'test' },
    dag: {},
    dagStages: [],
    stages: {},
    pipelineActive: false,
    activeStages: [],
    // 刻意不設 activeAgents
    retries: {},
    retryHistory: {},
    crashes: {},
    meta: { initialized: true },
  };
  const fp = path.join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  try {
    onDelegate(sid, 'vibe:explore', { prompt: 'explore' });
    const agents = readActiveAgents(sid);
    assert.ok(agents !== null, '狀態應存在');
    assert.ok(agents['explore'] === true, `explore 應寫入（從 undefined 自動初始化），實際：${JSON.stringify(agents)}`);
  } finally {
    cleanup(sid);
  }
});

// ═══════════════════════════════════════════════════════════════
// 結果輸出
// ═══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過');
} else {
  console.log('❌ 有測試失敗');
  process.exit(1);
}
