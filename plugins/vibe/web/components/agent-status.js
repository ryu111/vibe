// Agent 狀態面板組件
import { html, useRef } from '../lib/preact.js';
import { fmtSec } from '../lib/utils.js';
import { getStageStatus, getStageVerdict, getStageSeverity, getStageDuration, hasPipeline, getPipelineProgress, getActiveStages } from '../state/pipeline.js';

/**
 * 簡化版 Agent 狀態面板
 * @param {{ state: object, tick: number, events: object[], registry: object, alive: boolean, memory: object }} props
 */
export function AgentStatus({ state, tick, events, registry, alive, memory }) {
  const timers = useRef({});

  // 從 registry 動態建立 agent 清單（3 群組）
  const systemAgents = [
    { id: 'main', name: 'Main Agent', emoji: '🎯', group: 'system' },
    { id: 'explore', name: 'Explore', emoji: '🔭', group: 'system' },
    { id: 'plan', name: 'Plan', emoji: '📐', group: 'system' },
  ];
  const pipelineAgents = registry?.stages
    ? Object.entries(registry.stages).map(([stageId, cfg]) => ({
        id: cfg.agent, name: cfg.agent, emoji: cfg.emoji, stage: stageId, group: 'pipeline', color: cfg.color,
      }))
    : [];
  const supportAgents = [
    { id: 'security-reviewer', name: 'security', emoji: '🛡️', group: 'support' },
    { id: 'build-error-resolver', name: 'build-err', emoji: '🔧', group: 'support' },
    { id: 'pipeline-architect', name: 'pipeline-architect', emoji: '📐', group: 'support' },
  ];
  const allAgents = [...systemAgents, ...pipelineAgents, ...supportAgents];

  // Pipeline 是否不活躍（完成 / 取消 / 重設 → 無 activeStages 且 pipelineActive=false）
  const pipelineInactive = !state?.pipelineActive && (state?.activeStages || []).length === 0;
  // Pipeline 是否已完成 100%（燈號全滅用）
  const pipelineDone = pipelineInactive && hasPipeline(state) && getPipelineProgress(state) >= 100;

  // session 切換時清除所有計時器，避免跨 session 殘留
  const prevStateRef = useRef(state);
  if (prevStateRef.current !== state) {
    prevStateRef.current = state;
    timers.current = {};
  }

  // 取得每個 agent 的簡化狀態
  function getAgentStatus(agent) {
    // Pipeline 不活躍且無 pipeline → idle
    if (pipelineInactive && !hasPipeline(state)) return { status: 'idle', label: '—', dur: null };
    // Pipeline 已完全完成 → 所有燈號熄滅
    if (pipelineDone) return { status: 'idle', label: '—', dur: null };

    // 主 agent
    if (agent.id === 'main') {
      if (alive === false) return { status: 'idle', label: '—', dur: null };
      const activeCount = getActiveStages(state).length;
      if (activeCount > 0) return { status: 'delegating', label: '委派中', dur: null };
      if (state?.pipelineActive) return { status: 'running', label: '執行中', dur: null };
      return { status: 'idle', label: '—', dur: null };
    }
    // Pipeline stage agents — 同時檢查 DAG stages 和 activeStages
    if (agent.stage) {
      // 優先檢查 activeStages（delegation-tracker 追蹤的實際運行 agent）
      const isInActiveStages = (state?.activeStages || []).some(s => s === agent.stage || s.split(':')[0] === agent.stage);
      if (isInActiveStages) return { status: 'running', label: '執行中', dur: null };

      const dagKeys = Object.keys(state?.dag || {});
      const matchedStages = dagKeys.filter(k => k === agent.stage || k.split(':')[0] === agent.stage);
      for (const stageSid of matchedStages) {
        const status = getStageStatus(stageSid, state);
        if (status === 'active') return { status: 'running', label: '執行中', dur: null };
      }
      // 找已完成的最近一個
      const completedStages = matchedStages.filter(k => getStageStatus(k, state) === 'completed' || getStageStatus(k, state) === 'failed');
      if (completedStages.length > 0) {
        const last = completedStages[completedStages.length - 1];
        const verdict = getStageVerdict(last, state);
        const dur = getStageDuration(last, state);
        if (verdict === 'FAIL') return { status: 'error', label: getStageSeverity(last, state) || 'FAIL', dur };
        return { status: 'pass', label: verdict || 'PASS', dur };
      }
      // 在 DAG 中但還沒開始
      if (matchedStages.length > 0) {
        // pipeline 已不活躍（取消/重設）→ 不會再執行，顯示 idle
        if (pipelineInactive) return { status: 'idle', label: '—', dur: null };
        return { status: 'idle', label: '等待', dur: null };
      }
      return { status: 'idle', label: '—', dur: null };
    }
    // 從事件串流偵測 support/system agents（僅 pipeline 存在時顯示）
    if (events?.length && hasPipeline(state)) {
      const lastDel = events.find(e => e.eventType === 'delegation.start' && e.text?.includes(agent.id));
      if (lastDel) return { status: 'idle', label: '完成', dur: null };
    }
    return { status: 'idle', label: '—', dur: null };
  }

  const enriched = allAgents.map(a => {
    const s = getAgentStatus(a);
    // running 狀態時，從 timeline events 取最新 delegation.start 描述作為 label
    if (s.status === 'running' && events?.length) {
      const lastActivity = [...events].reverse().find(e =>
        e.eventType === 'delegation.start' &&
        e.text?.toLowerCase().includes(a.id)
      );
      if (lastActivity?.text) {
        const t = lastActivity.text;
        s.label = t.length > 20 ? t.slice(0, 20) + '…' : t;
      }
    }
    return { ...a, ...s };
  });

  // 同步計時器
  enriched.forEach(a => {
    if (a.status === 'running' && !timers.current[a.id]) timers.current[a.id] = Date.now();
    else if (a.status !== 'running') delete timers.current[a.id];
  });

  const activeCount = enriched.filter(a => a.status === 'running' || a.status === 'delegating').length;

  const groups = [
    { label: '系統', agents: enriched.filter(a => a.group === 'system') },
    { label: 'PIPELINE', agents: enriched.filter(a => a.group === 'pipeline') },
    { label: '輔助', agents: enriched.filter(a => a.group === 'support') },
  ];

  const renderRow = (a) => {
    let durText = '';
    if ((a.status === 'running' || a.status === 'delegating') && timers.current[a.id]) {
      durText = fmtSec(Math.round((Date.now() - timers.current[a.id]) / 1000));
    } else if (a.dur) {
      durText = fmtSec(a.dur);
    }
    return html`
      <div key=${a.id + (a.stage || '')} class="agent-row">
        <span class="al ${a.status === 'running' || a.status === 'delegating' ? a.status : a.status === 'completed' ? 'completed' : a.status === 'error' ? 'error' : a.status === 'pass' ? 'pass' : 'idle'}"></span>
        <span class="agent-name" style="${(a.status === 'running' || a.status === 'delegating') && a.color ? 'color:' + a.color : a.status === 'pass' ? 'color:var(--green)' : a.status === 'error' ? 'color:var(--red)' : ''}">${a.emoji} ${a.name}</span>
        <span class="agent-status-text ${a.status}">${a.label}</span>
        <span class="agent-dur">${durText}</span>
      </div>
    `;
  };

  return html`
    <div class="agent-panel">
      <div class="agent-panel-hdr">
        <h3>🤖 Agents 當前狀態</h3>
        <div class="agent-panel-stats">
          <span class="agent-panel-stat">活躍 <span class="num">${activeCount}</span></span>
        </div>
      </div>
      ${groups.map((g, gi) => g.agents.length > 0 && html`
        <div key=${g.label}>
          ${gi > 0 && html`<div class="agent-sep"></div>`}
          <div class="agent-group-label">${g.label}</div>
          ${g.agents.map(renderRow)}
        </div>
      `)}
    </div>
  `;
}
