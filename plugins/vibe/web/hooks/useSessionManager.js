// useSessionManager — session 分組排序與自動選擇邏輯
import { useState, useEffect, useMemo } from '../lib/preact.js';
import { sessionCategory, isLive } from '../state/pipeline.js';

/**
 * Session 管理 hook
 * 處理 mergedSessions 計算、分組排序、自動跟隨活躍 session
 * @param {{ sessions: object, alive: object }} params
 * @returns {{ mergedSessions: object, liveSessions: [string, object][], doneSessions: [string, object][], staleSessions: [string, object][], active: string|null, selectSession: function }}
 */
export function useSessionManager({ sessions, alive }) {
  const [active, setActive] = useState(null);

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

  // 自動選擇 + 跟隨活躍 session
  useEffect(() => {
    const sids = Object.keys(mergedSessions);
    if (!sids.length) return;
    const liveSid = liveSessions.find(([, ss]) => ss._alive || isLive(ss))?.[0];
    if (liveSid && liveSid !== active) { setActive(liveSid); return; }
    if (!active || !mergedSessions[active]) {
      setActive(liveSessions[0]?.[0] || doneSessions[0]?.[0] || sids[sids.length - 1]);
    }
  }, [mergedSessions, liveSessions]);

  const selectSession = id => { setActive(id); };

  return { mergedSessions, liveSessions, doneSessions, staleSessions, active, selectSession };
}
