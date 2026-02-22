// Header 組件 — 標題列 + toolbar（zoom、全螢幕、導出按鈕、連線燈號）
import { html } from '../lib/preact.js';
import { sid } from '../lib/utils.js';

/**
 * 頁面標題 + 工具列組件
 * @param {{ activeId: string, isComplete: boolean, fullscreen: boolean, zoom: number, conn: boolean, tlAll: object[], s: object, registry: object, onToggleFullscreen: function, onZoomIn: function, onZoomOut: function, onZoomReset: function, onExport: function }} props
 */
export function Header({
  activeId,
  isComplete,
  fullscreen,
  zoom,
  conn,
  tlAll,
  s,
  registry,
  onToggleFullscreen,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onExport,
}) {
  return html`
    <h1>
      🎯 Pipeline — ${sid(activeId)}
      ${isComplete && html`<span style="margin-left:4px">🎉</span>`}
      <div class="toolbar">
        <button class="tool-btn ${fullscreen ? 'active' : ''}" onClick=${onToggleFullscreen} title="全螢幕 (F)">${fullscreen ? '⊡' : '⊞'} 全螢幕</button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn" onClick=${() => onExport('md')} title="導出 Markdown (E)">📄 MD</button>
        <button class="tool-btn" onClick=${() => onExport('json')} title="導出 JSON">{ } JSON</button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn" onClick=${onZoomOut} title="縮小 (⌘-)">−</button>
        <button class="tool-btn" style="min-width:48px;justify-content:center;font-variant-numeric:tabular-nums" onClick=${onZoomReset} title="重設縮放 (⌘0)">${zoom}%</button>
        <button class="tool-btn" onClick=${onZoomIn} title="放大 (⌘+)">+</button>
        <div class="toolbar-sep"></div>
        <div class="conn-indicator"><span class="dot ${conn ? 'on' : 'off'}"></span><span>${conn ? '已連線' : '連線中…'}</span></div>
      </div>
    </h1>
  `;
}
