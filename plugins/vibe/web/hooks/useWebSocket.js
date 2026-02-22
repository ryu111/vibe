// useWebSocket — WebSocket 連線管理（含指數退避重連 + 心跳）
import { useState, useEffect } from '../lib/preact.js';

/**
 * WebSocket 連線 hook
 * 管理連線建立、指數退避重連、心跳、訊息分發
 * @returns {{ sessions: object, alive: object, timelineEvents: object, barrierStates: object, memory: object|null, sessionMetrics: object, conn: boolean }}
 */
export function useWebSocket() {
  const [sessions, setSessions] = useState({});
  const [alive, setAlive] = useState({});
  const [timelineEvents, setTimelineEvents] = useState({});
  const [barrierStates, setBarrierStates] = useState({});
  const [memory, setMemory] = useState(null);
  const [sessionMetrics, setSessionMetrics] = useState({});
  const [conn, setConn] = useState(false);

  useEffect(() => {
    let ws, rt, hb, retries = 0;

    function connect() {
      const p = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${p}://${location.host}/ws`);

      ws.onopen = () => {
        setConn(true);
        retries = 0;
        clearInterval(hb);
        hb = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000);
      };

      ws.onclose = () => {
        setConn(false);
        clearInterval(hb);
        rt = setTimeout(connect, Math.min(300 * Math.pow(2, retries++), 5000));
      };

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

  return { sessions, alive, timelineEvents, barrierStates, memory, sessionMetrics, conn };
}
