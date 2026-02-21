// Sidebar 組件（session 清單）
import { html } from '../lib/preact.js';
import { sid, elapsed, deleteSession, cleanupStale } from '../lib/utils.js';
import { sessionCategory, sessionName, currentStageName, isLive, hasPipeline, getPipelineProgress } from '../state/pipeline.js';

/**
 * Sidebar 組件
 * @param {{ liveSessions: [string, object][], doneSessions: [string, object][], staleSessions: [string, object][], active: string, sideOpen: boolean, showStale: boolean, registry: object, onSelect: function, onToggleSide: function, onToggleStale: function }} props
 */
export function Sidebar({ liveSessions, doneSessions, staleSessions, active, sideOpen, showStale, registry, onSelect, onToggleSide, onToggleStale }) {
  return html`
    <div class="sidebar">
      <div class="sb-top">
        <button class="sb-toggle" onClick=${onToggleSide}>${sideOpen ? '◀' : '▶'}</button>
      </div>
      <div class="sb-body">
        ${liveSessions.length > 0 && html`
          <div class="group-hdr"><h2>進行中</h2><span class="count">${liveSessions.length}</span></div>
          ${liveSessions.map(([id, ss]) => {
            const cat = sessionCategory(ss);
            const p = getPipelineProgress(ss);
            const stage = currentStageName(ss, registry);
            return html`
              <div key=${id} class="sc ${cat} ${id === active ? 'selected' : ''}" data-pct="${p}%" onClick=${() => onSelect(id)} title=${id}>
                <button class="x" onClick=${e => { e.stopPropagation(); deleteSession(id); }}>×</button>
                <div class="sc-title">
                  ${isLive(ss) && html`<span class="live-dot"></span>`}
                  ${sessionName(ss, registry)}
                </div>
                <div class="sc-sub">${sid(id)} · ${elapsed(ss.meta?.lastTransition || ss.classification?.classifiedAt)}</div>
                ${stage && html`<div class="sc-meta">${stage}${p > 0 ? ` · ${p}%` : ''}</div>`}
                ${hasPipeline(ss) && html`<div class="sc-bar"><div class="sc-bar-fill ${p >= 100 ? 'complete' : ''}" style="width:${p}%"></div></div>`}
              </div>
            `;
          })}
        `}

        ${doneSessions.length > 0 && html`
          <div class="group-sep">
            <span>已完成 (${doneSessions.length})</span>
            <button class="cleanup-btn" onClick=${() => doneSessions.forEach(([id]) => deleteSession(id))}>清理</button>
          </div>
          ${doneSessions.map(([id, ss]) => html`
            <div key=${id} class="sc done ${id === active ? 'selected' : ''}" data-pct="✅" onClick=${() => onSelect(id)} title=${id}>
              <button class="x" onClick=${e => { e.stopPropagation(); deleteSession(id); }}>×</button>
              <div class="sc-title">✅ ${sessionName(ss, registry)}</div>
              <div class="sc-sub">${sid(id)} · ${elapsed(ss.meta?.lastTransition)}</div>
            </div>
          `)}
        `}

        ${staleSessions.length > 0 && html`
          <div class="stale-toggle" onClick=${onToggleStale}>
            <span>${showStale ? '▾' : '▸'}</span>
            <span>過期 (${staleSessions.length})</span>
            <button class="cleanup-btn" style="margin-left:auto" onClick=${e => { e.stopPropagation(); cleanupStale(); }}>清理</button>
          </div>
          ${showStale && staleSessions.map(([id, ss]) => html`
            <div key=${id} class="sc stale ${id === active ? 'selected' : ''}" data-pct="—" onClick=${() => onSelect(id)} title=${id}>
              <button class="x" onClick=${e => { e.stopPropagation(); deleteSession(id); }}>×</button>
              <div class="sc-title">${sessionName(ss, registry)}</div>
              <div class="sc-sub">${sid(id)} · ${elapsed(ss.meta?.lastTransition)} 前</div>
            </div>
          `)}
        `}

        ${!liveSessions.length && !doneSessions.length && !staleSessions.length && html`
          <div style="color:var(--subtext0);font-size:11px;padding:8px">無活躍 session</div>
        `}
      </div>
    </div>
  `;
}
