// Agent 狀態面板組件
import { html, useRef } from '../lib/preact.js';
import { fmtSec } from '../lib/utils.js';
import { getStageStatus } from '../state/pipeline.js';

/**
 * Agent 狀態面板 — 三態簡化版（—/委派中/運行中）+ 累積運行時間
 * Stage agent：從 pipeline-state 的 startedAt/completedAt 讀取（重整不歸零）
 * 非 stage agent：client-side 累積計時，session 內不歸零（重整會歸零）
 * @param {{ state: object, tick: number, registry: object, alive: boolean, sessionId: string }} props
 */
export function AgentStatus({ state, tick, registry, alive, sessionId }) {
  // 累積計時器：{ [agentId]: { startedAt: number|null, accumulated: number } }
  const timers = useRef({});
  const prevSessionRef = useRef(sessionId);

  // Session 切換時清除計時器（用 sessionId 而非 state reference）
  if (prevSessionRef.current !== sessionId) {
    prevSessionRef.current = sessionId;
    timers.current = {};
  }

  // 從 registry 動態建立 agent 清單（3 群組）
  const systemAgents = [
    { id: 'main', name: 'Main Agent', emoji: '🎯', group: 'system' },
    { id: 'explore', name: 'Explore', emoji: '🔭', group: 'system' },
    { id: 'plan', name: 'Plan', emoji: '📐', group: 'system' },
  ];
  const pipelineAgents = registry?.stages
    ? Object.entries(registry.stages).map(([stageId, cfg]) => ({
        id: cfg.agent, name: cfg.agent, emoji: cfg.emoji, stage: stageId, group: 'pipeline',
      }))
    : [];
  const supportAgents = [
    { id: 'security-reviewer', name: 'security', emoji: '🛡️', group: 'support' },
    { id: 'build-error-resolver', name: 'build-err', emoji: '🔧', group: 'support' },
    { id: 'pipeline-architect', name: 'pipeline-architect', emoji: '📐', group: 'support' },
  ];
  const allAgents = [...systemAgents, ...pipelineAgents, ...supportAgents];

  // 統一 activeAgents map（server-side 追蹤所有被委派的 agent）
  const activeAgents = state?.activeAgents || {};

  // 三態判斷：idle / delegating / running
  function getStatus(agent) {
    // Main Agent: prompt 驅動（UserPromptSubmit → running，Stop → idle，委派 → delegating）
    if (agent.id === 'main') {
      if (Object.keys(activeAgents).length > 0) return 'delegating';
      if (state?.mainAgentActive) return 'running';
      return 'idle';
    }

    // 統一檢查：activeAgents 有記錄 → running（適用所有 agent）
    if (activeAgents[agent.id]) return 'running';

    // Stage agent 額外 fallback：從 DAG status 判斷（處理 activeAgents 被清理後的狀態）
    if (agent.stage) {
      const dagKeys = Object.keys(state?.dag || {});
      const matched = dagKeys.filter(k => k === agent.stage || k.split(':')[0] === agent.stage);
      for (const k of matched) {
        if (getStageStatus(k, state) === 'active') return 'running';
      }
    }

    return 'idle';
  }

  // 從 pipeline-state 計算 stage agent 的累積運行時間（秒）
  // 支援 suffixed stages（DEV:1, DEV:2...）累加，重整不歸零
  function getStageDuration(agent) {
    if (!agent.stage || !state?.stages) return 0;
    let totalSecs = 0;
    for (const [k, info] of Object.entries(state.stages)) {
      if (k !== agent.stage && k.split(':')[0] !== agent.stage) continue;
      if (!info?.startedAt) continue;
      const start = new Date(info.startedAt).getTime();
      if (!start || isNaN(start)) continue;
      const end = info.completedAt ? new Date(info.completedAt).getTime() : Date.now();
      const diff = Math.round((end - start) / 1000);
      if (diff > 0) totalSecs += diff;
    }
    return totalSecs;
  }

  const enriched = allAgents.map(a => ({ ...a, status: getStatus(a) }));

  // 非 stage agent 的累積計時器（session 內不歸零）
  enriched.forEach(a => {
    if (a.stage) return;
    if (!timers.current[a.id]) {
      timers.current[a.id] = { startedAt: null, accumulated: 0 };
    }
    const t = timers.current[a.id];
    if ((a.status === 'running' || a.status === 'delegating') && !t.startedAt) {
      // 開始計時
      t.startedAt = Date.now();
    } else if (a.status === 'idle' && t.startedAt) {
      // 結算累積，停止計時（不歸零）
      t.accumulated += Math.round((Date.now() - t.startedAt) / 1000);
      t.startedAt = null;
    }
  });

  // 計算顯示時間（stage agent 讀 server-side，非 stage agent 讀累積計時器）
  function getDuration(a) {
    if (a.stage) return getStageDuration(a);
    const t = timers.current[a.id];
    if (!t) return 0;
    const running = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0;
    return t.accumulated + running;
  }

  const activeCount = enriched.filter(a => a.status === 'running' || a.status === 'delegating').length;
  const statusLabel = (s) => s === 'running' ? '運行中' : s === 'delegating' ? '委派中' : '—';

  const groups = [
    { label: '系統', agents: enriched.filter(a => a.group === 'system') },
    { label: 'PIPELINE', agents: enriched.filter(a => a.group === 'pipeline') },
    { label: '輔助', agents: enriched.filter(a => a.group === 'support') },
  ];

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
          ${g.agents.map(a => {
            const secs = getDuration(a);
            return html`
              <div key=${a.id + (a.stage || '')} class="agent-row">
                <span class="al ${a.status}"></span>
                <span class="agent-name">${a.emoji} ${a.name}</span>
                <span class="agent-status-text ${a.status}">${statusLabel(a.status)}</span>
                <span class="agent-dur">${fmtSec(secs)}</span>
              </div>
            `;
          })}
        </div>
      `)}
    </div>
  `;
}
