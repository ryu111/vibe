// App 主組件 — 組合 hooks + 路由 tab 渲染
import { html, render, useState, useEffect, useRef, useMemo } from './lib/preact.js';
import { getPipelineProgress, hasPipeline } from './state/pipeline.js';
import { exportReport } from './components/export-report.js';
import { Sidebar } from './components/sidebar.js';
import { DagView } from './components/dag-view.js';
import { BarrierDisplay } from './components/barrier-display.js';
import { Confetti } from './components/confetti.js';
import { Header } from './components/header.js';
import { DashboardTab } from './components/dashboard-tab.js';
import { TimelineTab } from './components/timeline-tab.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useSessionManager } from './hooks/useSessionManager.js';

function App() {
  const [sideOpen, setSideOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState(null);
  const [tick, setTick] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);
  const [tlFilter, setTlFilter] = useState(0);
  const [tlTab, setTlTab] = useState('all');
  const [mainTab, setMainTab] = useState('dashboard');
  const [registry, setRegistry] = useState(null);
  const [showStale, setShowStale] = useState(false);
  const confettiShown = useRef(new Set());

  // 載入 registry
  useEffect(() => {
    fetch('/api/registry')
      .then(r => r.json())
      .then(setRegistry)
      .catch(() => {});
  }, []);

  // WebSocket 連線管理
  const { sessions, alive, timelineEvents, barrierStates, memory, sessionMetrics, conn } = useWebSocket();

  // Session 分組排序與自動選擇
  const { mergedSessions, liveSessions, doneSessions, staleSessions, active, selectSession } = useSessionManager({ sessions, alive });

  // toast 輔助函式
  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 2000); }

  // 鍵盤快捷鍵 + 縮放控制
  const { zoom, zoomStyle, setZoom } = useKeyboard({
    liveSessions,
    doneSessions,
    staleSessions,
    active,
    s: active ? mergedSessions[active] : null,
    tlAll: timelineEvents[active] || [],
    registry,
    selectSession,
    setSideOpen,
    setFullscreen,
    setMainTab,
    showToast,
    exportReport,
  });

  // 每秒 tick
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

  const s = active ? mergedSessions[active] : null;
  const activeBarrier = active ? barrierStates[active] : null;
  const progress = s ? getPipelineProgress(s) : 0;
  const isComplete = progress === 100 && hasPipeline(s);

  const tlAll = timelineEvents[active] || [];
  const tlFiltered = useMemo(() => {
    let list = tlAll;
    if (tlTab !== 'all') list = list.filter(ev => ev.cat === tlTab);
    if (tlFilter !== 0) { const cutoff = Date.now() - tlFilter * 60000; list = list.filter(ev => ev.ts && ev.ts >= cutoff); }
    return list;
  }, [tlAll, tlFilter, tlTab, tick]);

  // Confetti 觸發
  useEffect(() => {
    if (isComplete && active && !confettiShown.current.has(active)) {
      confettiShown.current.add(active);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    }
  }, [isComplete, active]);

  // registry typeLabel 函式
  const typeLabel = (t) => {
    if (!registry) return t || '—';
    const p = registry.pipelines?.[t];
    return p?.label || t || '—';
  };

  return html`
    <div class="layout ${sideOpen && !fullscreen ? '' : fullscreen ? 'fullscreen' : 'collapsed'}" style="${zoomStyle}">
      ${showConfetti && html`<${Confetti} />`}
      ${toast && html`<div class="kbd-toast">${toast}</div>`}

      <!-- Sidebar -->
      <${Sidebar}
        liveSessions=${liveSessions}
        doneSessions=${doneSessions}
        staleSessions=${staleSessions}
        active=${active}
        sideOpen=${sideOpen}
        showStale=${showStale}
        registry=${registry}
        onSelect=${selectSession}
        onToggleSide=${() => setSideOpen(!sideOpen)}
        onToggleStale=${() => setShowStale(p => !p)}
      />

      <!-- Main -->
      <div class="main">
        ${s ? html`
          <${Header}
            activeId=${active}
            isComplete=${isComplete}
            fullscreen=${fullscreen}
            zoom=${zoom}
            conn=${conn}
            tlAll=${tlAll}
            s=${s}
            registry=${registry}
            onToggleFullscreen=${() => setFullscreen(p => !p)}
            onZoomIn=${() => setZoom(z => Math.min(200, z + 10))}
            onZoomOut=${() => setZoom(z => Math.max(50, z - 10))}
            onZoomReset=${() => setZoom(100)}
            onExport=${(fmt) => exportReport(s, active, tlAll, fmt, registry)}
          />

          <!-- Main Tabs -->
          <div class="main-tabs">
            <button class="main-tab ${mainTab === 'dashboard' ? 'active' : ''}" onClick=${() => setMainTab('dashboard')}>📊 Dashboard</button>
            <button class="main-tab ${mainTab === 'pipeline' ? 'active' : ''}" onClick=${() => setMainTab('pipeline')}>🔄 Pipeline</button>
            <button class="main-tab ${mainTab === 'timeline' ? 'active' : ''}" onClick=${() => setMainTab('timeline')}>📋 Timeline${tlAll.length ? html`<span class="tab-count">(${tlAll.length})</span>` : ''}</button>
          </div>

          <!-- Tab: Dashboard -->
          ${mainTab === 'dashboard' && html`
            <${DashboardTab}
              s=${s}
              tick=${tick}
              tlAll=${tlAll}
              registry=${registry}
              alive=${active ? !!alive[active] : false}
              memory=${memory}
              sessionId=${active}
              sessionMetrics=${active ? sessionMetrics[active] : null}
              isComplete=${isComplete}
              typeLabel=${typeLabel}
            />
          `}

          <!-- Tab: Pipeline（DAG 流程圖） -->
          ${mainTab === 'pipeline' && html`
            <${BarrierDisplay} barrierState=${activeBarrier} />
            <${DagView} state=${s} registry=${registry} />
          `}

          <!-- Tab: Timeline -->
          ${mainTab === 'timeline' && html`
            <${TimelineTab}
              tlFiltered=${tlFiltered}
              tlTab=${tlTab}
              tlFilter=${tlFilter}
              hasFilter=${!!(tlFilter || tlTab !== 'all')}
              onTabChange=${setTlTab}
              onFilterChange=${setTlFilter}
            />
          `}
        ` : html`
          <div class="empty">
            <div style="position:absolute;top:12px;right:16px;display:flex;align-items:center;gap:8px">
              <button class="tool-btn" onClick=${() => setZoom(z => Math.max(50, z - 10))}>−</button>
              <button class="tool-btn" style="min-width:48px;justify-content:center;font-variant-numeric:tabular-nums" onClick=${() => setZoom(100)}>${zoom}%</button>
              <button class="tool-btn" onClick=${() => setZoom(z => Math.min(200, z + 10))}>+</button>
              <div class="conn-indicator"><span class="dot ${conn ? 'on' : 'off'}"></span><span>${conn ? '已連線' : '連線中…'}</span></div>
            </div>
            <div class="icon">🎯</div>
            <div style="font-size:18px;font-weight:600">Vibe Pipeline Dashboard</div>
            <div class="hint">
              無活躍的 pipeline session<br/><br/>
              使用 Claude Code + vibe plugin 開始任務<br/>
              Pipeline 會自動顯示在此
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
