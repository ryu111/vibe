// Barrier 並行進度顯示組件
import { html } from '../lib/preact.js';

/**
 * 顯示 Barrier 並行進度
 * @param {{ barrierState: object|null }} props
 */
export function BarrierDisplay({ barrierState }) {
  if (!barrierState || !Object.keys(barrierState.groups || {}).length) return null;
  return html`
    <div style="padding:8px 12px;background:var(--surface0);border-radius:8px;border:1px solid var(--surface1)">
      <div style="font-size:10px;color:var(--subtext0);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Barrier 並行進度</div>
      ${Object.entries(barrierState.groups || {}).map(([group, g]) => html`
        <div key=${group} style="display:flex;align-items:center;gap:10px;font-size:11px;margin-bottom:4px">
          <span style="color:var(--blue);min-width:80px">${group}</span>
          <span style="color:${g.resolved ? (Object.values(g.results || {}).some(r => r.verdict === 'FAIL') ? 'var(--red)' : 'var(--green)') : 'var(--yellow)'}">${g.completed.length}/${g.total}</span>
          <span style="color:var(--subtext0)">${g.siblings.map(st => g.completed.includes(st) ? (g.results?.[st]?.verdict === 'FAIL' ? '❌' : '✅') : '⏳').join(' ')} ${g.siblings.join(' + ')}</span>
          ${g.resolved && html`<span style="font-size:9px;padding:1px 6px;border-radius:4px;background:${Object.values(g.results || {}).some(r => r.verdict === 'FAIL') ? 'var(--red)' : 'var(--green)'};color:var(--bg)">${g.next ? '→ ' + g.next : '完成'}</span>`}
          ${!g.resolved && html`<span style="font-size:9px;color:var(--yellow);animation:blink 1s infinite">等待中...</span>`}
        </div>
      `)}
    </div>
  `;
}
