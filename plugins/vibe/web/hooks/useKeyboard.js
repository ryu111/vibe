// useKeyboard — 鍵盤快捷鍵 + 縮放控制
import { useState, useEffect, useMemo } from '../lib/preact.js';

/**
 * 縮放與鍵盤快捷鍵 hook
 * @param {{ liveSessions: [string, object][], doneSessions: [string, object][], staleSessions: [string, object][], active: string, s: object, tlAll: object[], registry: object, selectSession: function, setSideOpen: function, setFullscreen: function, setMainTab: function, showToast: function, exportReport: function }} deps
 * @returns {{ zoom: number, zoomStyle: string, setZoom: function }}
 */
export function useKeyboard({
  liveSessions,
  doneSessions,
  staleSessions,
  active,
  s,
  tlAll,
  registry,
  selectSession,
  setSideOpen,
  setFullscreen,
  setMainTab,
  showToast,
  exportReport,
}) {
  const [zoom, setZoom] = useState(100);

  // 縮放控制（⌘+/-/0）
  useEffect(() => {
    function onZoom(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopPropagation(); setZoom(z => Math.min(200, z + 10)); return; }
      if (e.key === '-') { e.preventDefault(); e.stopPropagation(); setZoom(z => Math.max(50, z - 10)); return; }
      if (e.key === '0') { e.preventDefault(); e.stopPropagation(); setZoom(100); return; }
    }
    window.addEventListener('keydown', onZoom, true);
    return () => window.removeEventListener('keydown', onZoom, true);
  }, []);

  // 鍵盤快捷鍵（j/k 導航、數字鍵切換 tab、S/F/E 操作）
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.metaKey || e.ctrlKey) return;
      const sids = [...liveSessions, ...doneSessions, ...staleSessions].map(([id]) => id);
      const idx = sids.indexOf(active);
      switch (e.key) {
        case 'ArrowUp': case 'k': e.preventDefault(); if (idx > 0) selectSession(sids[idx - 1]); break;
        case 'ArrowDown': case 'j': e.preventDefault(); if (idx < sids.length - 1) selectSession(sids[idx + 1]); break;
        case 's': case 'S': setSideOpen(p => !p); showToast('S — 側邊欄切換'); break;
        case 'f': case 'F': setFullscreen(p => !p); showToast('F — 全螢幕切換'); break;
        case 't': case 'T': setMainTab('timeline'); showToast('T — Timeline'); break;
        case '1': setMainTab('dashboard'); showToast('1 — Dashboard'); break;
        case '2': setMainTab('pipeline'); showToast('2 — Pipeline'); break;
        case '3': setMainTab('timeline'); showToast('3 — Timeline'); break;
        case '?': showToast('1/2/3 Tab · ↑↓ 切換 · S 側邊 · F 全螢幕 · E 導出 · ⌘± 縮放'); break;
        case 'e': case 'E': if (s) { exportReport(s, active, tlAll, 'md', registry); showToast('E — 導出 Markdown'); } break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, liveSessions, doneSessions, staleSessions, s, tlAll, registry]);

  const zoomStyle = useMemo(() => {
    if (zoom === 100) return '';
    const sc = zoom / 100;
    return `transform:scale(${sc});transform-origin:0 0;width:${100 / sc}vw;height:${100 / sc}vh;`;
  }, [zoom]);

  return { zoom, zoomStyle, setZoom };
}
