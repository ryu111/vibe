// DashboardTab 組件 — Dashboard grid 內容（Mosaic 佈局）
import { html, useEffect, useRef } from '../lib/preact.js';
import { elapsed, fmtSec } from '../lib/utils.js';
import { getStageDuration, getStageVerdict, getStageStatus, getAllStageKeys } from '../state/pipeline.js';
import { AgentStatus } from './agent-status.js';
import { MCPStats } from './mcp-stats.js';
import { StatsCards } from './stats-cards.js';
import { PipelineProgressBar } from './pipeline-progress.js';

/**
 * Dashboard tab 內容（Mosaic grid 佈局）
 * 包含 AgentStatus、mini-tl、MCPStats、StatsCards、PipelineProgressBar 及完成摘要
 * @param {{ s: object, tick: number, tlAll: object[], registry: object, alive: boolean, memory: object, sessionId: string, sessionMetrics: object, isComplete: boolean, typeLabel: function }} props
 */
export function DashboardTab({
  s,
  tick,
  tlAll,
  registry,
  alive,
  memory,
  sessionId,
  sessionMetrics,
  isComplete,
  typeLabel,
}) {
  const dashGridRef = useRef(null);

  // Agent panel 與活動記錄高度同步
  useEffect(() => {
    const grid = dashGridRef.current;
    if (!grid) return;
    const ap = grid.querySelector('.agent-panel');
    const tl = grid.querySelector('.mini-tl');
    if (!ap || !tl) return;
    const sync = () => { tl.style.maxHeight = ap.offsetHeight + 'px'; };
    const ro = new ResizeObserver(sync);
    ro.observe(ap);
    sync();
    return () => ro.disconnect();
  }, [sessionId]);

  // mini-tl：里程碑 + Main Agent 重要操作，隱藏 sub-agent 工具細節和 Main Agent 查詢
  const miniTlEvents = tlAll.filter(ev => {
    if (ev.eventType !== 'tool.used') return true;
    if (ev.emoji !== '🎯') return false; // 隱藏 sub-agent 工具細節
    // Main Agent 只顯示重要操作（修改/執行/互動），隱藏查詢類
    return ev.tool === 'Write' || ev.tool === 'Edit' || ev.tool === 'Bash'
      || ev.tool === 'Skill' || ev.tool === 'AskUserQuestion';
  }).slice(0, 50);

  return html`
    <div class="dash-grid layout-mosaic" ref=${dashGridRef}>
      <${AgentStatus}
        state=${s}
        tick=${tick}
        events=${tlAll}
        registry=${registry}
        alive=${alive}
        memory=${memory}
        sessionId=${sessionId}
      />

      <div class="mini-tl">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h4>📋 活動記錄</h4>
        </div>
        <div class="tl-items-wrap">
          ${miniTlEvents.length
            ? miniTlEvents.map((ev, i) => html`
                <div key=${i} class="tl-item ${ev.type}">
                  <span class="time">${ev.time}</span>
                  <span class="msg">${ev.emoji} ${ev.text}</span>
                </div>
              `)
            : html`<div style="color:var(--subtext0);font-size:10px">等待事件流…</div>`
          }
        </div>
      </div>

      <${MCPStats} events=${tlAll} />
      <${StatsCards} state=${s} events=${tlAll} tick=${tick} metrics=${sessionId ? sessionMetrics : null} />
      <${PipelineProgressBar} state=${s} registry=${registry} />

      ${isComplete && html`
        <div class="cards">
          <div class="card">
            <h3>🎉 完成摘要</h3>
            <div class="row"><span class="label">Pipeline</span><span class="value">${typeLabel(s.classification?.pipelineId)}</span></div>
            <div class="row"><span class="label">進度</span><span class="value" style="color:var(--green)">100% 完成</span></div>
            <div class="row"><span class="label">總重試</span><span class="value">${Object.values(s.retries || {}).reduce((a, b) => a + b, 0) || '無'}</span></div>
            <div class="row"><span class="label">時長</span><span class="value">${elapsed(s.classification?.classifiedAt || s.meta?.lastTransition)}</span></div>
          </div>
          <div class="card">
            <h3>⏱ 各階段耗時</h3>
            ${getAllStageKeys(s).map(id => {
              const dur = getStageDuration(id, s);
              const stageData = s.stages?.[id];
              const meta = registry?.stages?.[id.split(':')[0]];
              const verdict = getStageVerdict(id, s);
              const status = getStageStatus(id, s);
              let durText = '—';
              if (dur) durText = fmtSec(dur);
              else if (status === 'completed' && stageData?.verdict?._crashRecovered) durText = '⚡ 回收';
              else if (status === 'completed') durText = '< 1s';
              else if (status === 'skipped') durText = '跳過';
              else if (status === 'active') durText = '進行中...';
              const verdictColor = verdict === 'PASS' ? 'var(--green)' : verdict === 'FAIL' ? 'var(--red)' : '';
              return html`
                <div key=${id} class="row">
                  <span class="label">${meta?.emoji || ''} ${id}</span>
                  <span class="value" style="${verdictColor ? 'color:' + verdictColor : ''}">${durText}${verdict ? ' · ' + verdict : ''}</span>
                </div>
              `;
            })}
          </div>
        </div>
      `}
    </div>
  `;
}
