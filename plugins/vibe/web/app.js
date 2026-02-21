// App 主組件 — WebSocket + keyboard + tabs + zoom 邏輯
import { html, render, useState, useEffect, useRef, useMemo } from './lib/preact.js';
import { sid, elapsed, fmtSec } from './lib/utils.js';
import { getPipelineProgress, hasPipeline, isLive, sessionCategory, getStageStatus, getStageVerdict, getStageDuration } from './state/pipeline.js';
import { Sidebar } from './components/sidebar.js';
import { DagView } from './components/dag-view.js';
import { BarrierDisplay } from './components/barrier-display.js';
import { AgentStatus } from './components/agent-status.js';
import { MCPStats } from './components/mcp-stats.js';
import { StatsCards } from './components/stats-cards.js';
import { PipelineProgressBar } from './components/pipeline-progress.js';
import { Confetti } from './components/confetti.js';
import { exportReport } from './components/export-report.js';

function App() {
  const [sessions, setSessions] = useState({});
  const [active, setActive] = useState(null);
  const [conn, setConn] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [tlOpen, setTlOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState(null);
  const [tick, setTick] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [timelineEvents, setTimelineEvents] = useState({});
  const [alive, setAlive] = useState({});
  const [barrierStates, setBarrierStates] = useState({});
  const [memory, setMemory] = useState(null);
  const [tlFilter, setTlFilter] = useState(0);
  const [tlTab, setTlTab] = useState('all');
  const [mainTab, setMainTab] = useState('dashboard');
  const [registry, setRegistry] = useState(null);
  const [sessionMetrics, setSessionMetrics] = useState({});
  const [showStale, setShowStale] = useState(false);
  const confettiShown = useRef(new Set());

  // 載入 registry
  useEffect(() => {
    fetch('/api/registry')
      .then(r => r.json())
      .then(setRegistry)
      .catch(() => {});
  }, []);

  // registry typeLabel 函式
  const typeLabel = (t) => {
    if (!registry) return t || '—';
    const p = registry.pipelines?.[t];
    return p?.label || t || '—';
  };

  // 合併 alive 狀態
  const mergedSessions = useMemo(() => {
    const out = {};
    for (const [id, s] of Object.entries(sessions)) {
      out[id] = alive[id] ? { ...s, _alive: true } : s;
    }
    for (const id of Object.keys(alive)) {
      if (alive[id] && !out[id]) out[id] = { _alive: true, _heartbeatOnly: true };
    }
    return out;
  }, [sessions, alive]);

  // 分組（活躍優先 → 最近活動）自動排序
  const { liveSessions, doneSessions, staleSessions } = useMemo(() => {
    const live = [], done = [], stale = [];
    for (const [id, s] of Object.entries(mergedSessions)) {
      const cat = sessionCategory(s);
      if (cat === 'live' || cat === 'active') live.push([id, s]);
      else if (cat === 'done') done.push([id, s]);
      else stale.push([id, s]);
    }
    // 活躍優先 → 最近活動時間排序
    const byRecent = (a, b) => {
      const aAlive = a[1]._alive ? 1 : 0, bAlive = b[1]._alive ? 1 : 0;
      if (aAlive !== bAlive) return bAlive - aAlive;
      return new Date(b[1].meta?.lastTransition || 0) - new Date(a[1].meta?.lastTransition || 0);
    };
    live.sort(byRecent);
    done.sort((a, b) => new Date(b[1].meta?.lastTransition || 0) - new Date(a[1].meta?.lastTransition || 0));
    stale.sort((a, b) => new Date(b[1].meta?.lastTransition || 0) - new Date(a[1].meta?.lastTransition || 0));
    return { liveSessions: live, doneSessions: done, staleSessions: stale };
  }, [mergedSessions]);

  const s = active ? mergedSessions[active] : null;
  const activeBarrier = active ? barrierStates[active] : null;
  const progress = s ? getPipelineProgress(s) : 0;
  const isComplete = progress === 100 && hasPipeline(s);
  const selectSession = id => { setActive(id); };

  const tlAll = timelineEvents[active] || [];
  const tlFiltered = useMemo(() => {
    let list = tlAll;
    if (tlTab !== 'all') list = list.filter(ev => ev.cat === tlTab);
    if (tlFilter !== 0) { const cutoff = Date.now() - tlFilter * 60000; list = list.filter(ev => ev.ts && ev.ts >= cutoff); }
    return list;
  }, [tlAll, tlFilter, tlTab, tick]);

  // 每秒 tick
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

  // Confetti 觸發
  useEffect(() => {
    if (isComplete && active && !confettiShown.current.has(active)) {
      confettiShown.current.add(active);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 4000);
    }
  }, [isComplete, active]);

  // WebSocket（指數退避 + 心跳）
  useEffect(() => {
    let ws, rt, hb, retries = 0;
    function connect() {
      const p = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${p}://${location.host}/ws`);
      ws.onopen = () => { setConn(true); retries = 0; clearInterval(hb); hb = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000); };
      ws.onclose = () => { setConn(false); clearInterval(hb); rt = setTimeout(connect, Math.min(300 * Math.pow(2, retries++), 5000)); };
      ws.onerror = () => {};
      ws.onmessage = e => {
        if (e.data === 'pong') return;
        const m = JSON.parse(e.data);
        // 直接存原始 v4 state（不 adaptState）
        if (m.sessions) setSessions(m.sessions);
        if (m.alive) setAlive(prev => ({ ...prev, ...m.alive }));
        if (m.memory) setMemory(m.memory);
        if (m.metrics) setSessionMetrics(prev => ({ ...prev, ...m.metrics }));
        if (m.type === 'timeline' && m.sessionId && m.event) {
          setTimelineEvents(prev => {
            const list = prev[m.sessionId] || [];
            return { ...prev, [m.sessionId]: [m.event, ...list].slice(0, 200) };
          });
        }
        if (m.type === 'barrier' && m.sessionId) {
          setBarrierStates(prev => ({ ...prev, [m.sessionId]: m.barrierState }));
        }
      };
    }
    connect();
    return () => { ws?.close(); clearTimeout(rt); clearInterval(hb); };
  }, []);

  // 縮放控制
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

  const zoomStyle = useMemo(() => {
    if (zoom === 100) return '';
    const sc = zoom / 100;
    return `transform:scale(${sc});transform-origin:0 0;width:${100/sc}vw;height:${100/sc}vh;`;
  }, [zoom]);

  // 鍵盤快捷鍵
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.metaKey || e.ctrlKey) return;
      const sids = [...liveSessions, ...doneSessions, ...staleSessions].map(([id]) => id);
      const idx = sids.indexOf(active);
      switch(e.key) {
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

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(null), 2000); }

  // 自動選擇 + 跟隨活躍 session
  useEffect(() => {
    const sids = Object.keys(mergedSessions);
    if (!sids.length) return;
    const liveSid = liveSessions.find(([, ss]) => ss._alive || isLive(ss))?.[0];
    if (liveSid && liveSid !== active) { selectSession(liveSid); return; }
    if (!active || !mergedSessions[active]) {
      setActive(liveSessions[0]?.[0] || doneSessions[0]?.[0] || sids[sids.length - 1]);
    }
  }, [mergedSessions, liveSessions]);

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
          <h1>
            🎯 Pipeline — ${sid(active)}
            ${isComplete && html`<span style="margin-left:4px">🎉</span>`}
            <div class="toolbar">
              <button class="tool-btn ${fullscreen ? 'active' : ''}" onClick=${() => setFullscreen(!fullscreen)} title="全螢幕 (F)">${fullscreen ? '⊡' : '⊞'} 全螢幕</button>
              <div class="toolbar-sep"></div>
              <button class="tool-btn" onClick=${() => exportReport(s, active, tlAll, 'md', registry)} title="導出 Markdown (E)">📄 MD</button>
              <button class="tool-btn" onClick=${() => exportReport(s, active, tlAll, 'json', registry)} title="導出 JSON">{ } JSON</button>
              <div class="toolbar-sep"></div>
              <button class="tool-btn" onClick=${() => setZoom(z => Math.max(50, z - 10))} title="縮小 (⌘-)">−</button>
              <button class="tool-btn" style="min-width:48px;justify-content:center;font-variant-numeric:tabular-nums" onClick=${() => setZoom(100)} title="重設縮放 (⌘0)">${zoom}%</button>
              <button class="tool-btn" onClick=${() => setZoom(z => Math.min(200, z + 10))} title="放大 (⌘+)">+</button>
              <div class="toolbar-sep"></div>
              <div class="conn-indicator"><span class="dot ${conn ? 'on' : 'off'}"></span><span>${conn ? '已連線' : '連線中…'}</span></div>
            </div>
          </h1>

          <!-- Main Tabs -->
          <div class="main-tabs">
            <button class="main-tab ${mainTab === 'dashboard' ? 'active' : ''}" onClick=${() => setMainTab('dashboard')}>📊 Dashboard</button>
            <button class="main-tab ${mainTab === 'pipeline' ? 'active' : ''}" onClick=${() => setMainTab('pipeline')}>🔄 Pipeline</button>
            <button class="main-tab ${mainTab === 'timeline' ? 'active' : ''}" onClick=${() => setMainTab('timeline')}>📋 Timeline${tlAll.length ? html`<span class="tab-count">(${tlAll.length})</span>` : ''}</button>
          </div>

          <!-- Tab: Dashboard -->
          ${mainTab === 'dashboard' && html`
          <div class="dash-grid">
              <${AgentStatus} state=${s} tick=${tick} events=${tlAll} registry=${registry} alive=${active ? !!alive[active] : false} memory=${memory} />
              <div class="mini-tl">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <h4>📋 里程碑事件</h4>
                </div>
                <div class="tl-items-wrap">
                  ${(() => {
                    const MILESTONE_TYPES = ['delegation.start', 'stage.start', 'stage.complete', 'stage.retry', 'stage.crash-recovery', 'pipeline.complete', 'pipeline.incomplete', 'pipeline.cancelled', 'task.classified', 'ask.question', 'ask.answered', 'session.start'];
                    const milestones = tlAll.filter(ev => MILESTONE_TYPES.includes(ev.eventType));
                    return milestones.length ? milestones.map((ev, i) => html`
                      <div key=${i} class="tl-item ${ev.type}"><span class="time">${ev.time}</span><span class="msg">${ev.emoji} ${ev.text}</span></div>
                    `) : html`<div style="color:var(--subtext0);font-size:10px">等待事件流…</div>`;
                  })()}
                </div>
              </div>
              <${MCPStats} events=${tlAll} />
              <${StatsCards} state=${s} events=${tlAll} tick=${tick} metrics=${active ? sessionMetrics[active] : null} />
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
                    ${Object.keys(s.dag || {}).map(id => {
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
                      return html`<div key=${id} class="row"><span class="label">${meta?.emoji || ''} ${id}</span><span class="value" style="${verdictColor ? 'color:' + verdictColor : ''}">${durText}${verdict ? ' · ' + verdict : ''}</span></div>`;
                    })}
                  </div>
                </div>
              `}
          </div>
          `}

          <!-- Tab: Pipeline（DAG 流程圖） -->
          ${mainTab === 'pipeline' && html`
            <${BarrierDisplay} barrierState=${activeBarrier} />
            <${DagView} state=${s} registry=${registry} />
          `}

          <!-- Tab: Timeline -->
          ${mainTab === 'timeline' && html`
          <div class="tl-full">
            <div class="tl-tabs">
              ${[['all', '全部'], ['agent', '🔧 工具'], ['pipeline', '🔄 Pipeline'], ['quality', '✅ 品質'], ['task', '📋 任務']].map(([v, label]) => html`
                <button key=${v} class="tl-tab ${tlTab === v ? 'active' : ''}" onClick=${() => setTlTab(v)}>${label}</button>
              `)}
            </div>
            <div class="tl-filter">
              ${[[0, '全部'], [10, '10m'], [30, '30m'], [60, '1h']].map(([v, label]) => html`
                <button key=${v} class="tl-chip ${tlFilter === v ? 'active' : ''}" onClick=${() => setTlFilter(v)}>${label}</button>
              `)}
            </div>
            <div class="tl-items">
              ${tlFiltered.length ? tlFiltered.map((ev, i) => html`
                <div key=${i} class="tl-item ${ev.type}"><span class="time">${ev.time}</span><span class="msg">${ev.emoji} ${ev.text}</span></div>
              `) : html`<div style="color:var(--subtext0);font-size:11px;padding:6px 0">${(tlFilter || tlTab !== 'all') ? '此篩選條件下無事件' : '等待事件流…'}</div>`}
            </div>
          </div>
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
