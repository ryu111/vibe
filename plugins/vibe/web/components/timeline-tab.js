// TimelineTab 組件 — Timeline 完整檢視（tabs + filter + 事件列表）
import { html } from '../lib/preact.js';

// Tab 選項定義
const TL_TABS = [
  ['all', '全部'],
  ['agent', '🔧 工具'],
  ['pipeline', '🔄 Pipeline'],
  ['quality', '✅ 品質'],
  ['task', '📋 任務'],
];

// 時間過濾選項（分鐘，0 = 全部）
const TL_FILTERS = [
  [0, '全部'],
  [10, '10m'],
  [30, '30m'],
  [60, '1h'],
];

/**
 * Timeline 完整檢視 tab
 * @param {{ tlFiltered: object[], tlTab: string, tlFilter: number, hasFilter: boolean, onTabChange: function, onFilterChange: function }} props
 */
export function TimelineTab({
  tlFiltered,
  tlTab,
  tlFilter,
  hasFilter,
  onTabChange,
  onFilterChange,
}) {
  return html`
    <div class="tl-full">
      <div class="tl-tabs">
        ${TL_TABS.map(([v, label]) => html`
          <button key=${v} class="tl-tab ${tlTab === v ? 'active' : ''}" onClick=${() => onTabChange(v)}>${label}</button>
        `)}
      </div>
      <div class="tl-filter">
        ${TL_FILTERS.map(([v, label]) => html`
          <button key=${v} class="tl-chip ${tlFilter === v ? 'active' : ''}" onClick=${() => onFilterChange(v)}>${label}</button>
        `)}
      </div>
      <div class="tl-items">
        ${tlFiltered.length
          ? tlFiltered.map((ev, i) => html`
              <div key=${i} class="tl-item ${ev.type}">
                <span class="time">${ev.time}</span>
                <span class="msg">${ev.emoji} ${ev.text}</span>
              </div>
            `)
          : html`<div style="color:var(--subtext0);font-size:11px;padding:6px 0">${hasFilter ? '此篩選條件下無事件' : '等待事件流…'}</div>`
        }
      </div>
    </div>
  `;
}
