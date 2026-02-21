// 統計卡片組件（8 張）
import { html, useMemo } from '../lib/preact.js';
import { fmtSize, fmtDuration } from '../lib/utils.js';

/**
 * 8 張統計卡片
 * @param {{ state: object, events: object[], tick: number, metrics: object }} props
 */
export function StatsCards({ state, events, tick, metrics }) {
  const mt = metrics || {};
  const contextPct = mt.contextPct || 0;
  const transcriptSize = mt.transcriptSize || 0;
  const toolCallCount = mt.toolCallCount || 0;

  // 從 events 計算 compact 次數（與 server metrics 互補，取較大值確保不漏計）
  const compactCountFromEvents = useMemo(() =>
    events.filter(e => e.eventType === 'compact.executed').length,
    [events]
  );
  // 優先使用 server 端直接從 timeline JSONL 計算的 compactCount（WS replay 後較準確），
  // 取兩者較大值以防止計數歸零
  const compactCount = Math.max(mt.compactCount || 0, compactCountFromEvents);

  const guardCount = useMemo(() =>
    events.filter(e => e.eventType === 'tool.blocked').length,
    [events]
  );
  const crashCount = useMemo(() =>
    Object.values(state?.crashes || {}).reduce((a, b) => a + (b || 0), 0),
    [state]
  );
  const retryCount = useMemo(() =>
    Object.values(state?.retries || {}).reduce((a, b) => a + (b || 0), 0),
    [state]
  );
  const delegateCount = useMemo(() =>
    events.filter(e => e.eventType === 'delegation.start').length,
    [events]
  );
  const startedAt = state?.classification?.classifiedAt || state?.meta?.lastTransition || mt.sessionStartedAt;
  const sessionDur = startedAt ? fmtDuration(startedAt) : '—';

  const cards = [
    { key: 'context', emoji: '📊', label: 'Context 使用率', value: contextPct + '%', sub: toolCallCount + ' / 200 tool calls',
      level: contextPct > 80 ? 'danger' : contextPct > 50 ? 'warn' : '',
      hint: contextPct > 80 ? '建議 /compact 壓縮' : contextPct > 50 ? 'context 偏高' : null,
      tip: 'Tool call 次數佔閾值比例，反映 context 使用程度' },
    { key: 'filesize', emoji: '💾', label: 'Session 大小', value: fmtSize(transcriptSize), sub: 'transcript 檔案',
      level: transcriptSize > 50*1024*1024 ? 'danger' : transcriptSize > 20*1024*1024 ? 'warn' : '',
      hint: transcriptSize > 50*1024*1024 ? '建議重開 session' : transcriptSize > 20*1024*1024 ? 'session 較大' : null,
      tip: 'Session 對話記錄檔案大小，過大時建議開新 session' },
    { key: 'crash', emoji: '💥', label: 'Crash', value: '' + crashCount, sub: 'agent crash 次數',
      level: crashCount > 2 ? 'danger' : crashCount > 0 ? 'warn' : '',
      hint: crashCount > 2 ? '頻繁 crash，檢查穩定性' : null,
      tip: 'Agent 非正常中斷的次數，系統會自動回收重試' },
    { key: 'guard', emoji: '🛡️', label: 'Guard 攔截', value: '' + guardCount, sub: 'pipeline-guard 阻擋',
      level: guardCount > 10 ? 'warn' : '',
      hint: guardCount > 10 ? '提示詞可能需要優化' : null,
      tip: 'Pipeline 模式下寫入被攔截次數，過多代表提示詞引導不足' },
    { key: 'compact', emoji: '📦', label: 'Compact', value: '' + compactCount, sub: 'context 壓縮次數',
      level: compactCount > 5 ? 'warn' : '',
      hint: compactCount > 5 ? '頻繁壓縮，考慮重開' : null,
      tip: '壓縮 context window 的次數，每次壓縮會遺失部分上下文' },
    { key: 'retry', emoji: '🔁', label: 'Retry 回退', value: '' + retryCount, sub: '各 stage 重試總和',
      level: retryCount > 3 ? 'warn' : '',
      hint: retryCount > 3 ? '品質門多次回退' : null,
      tip: '品質 stage FAIL 觸發 DEV 回退的次數' },
    { key: 'delegate', emoji: '🤖', label: '委派次數', value: '' + delegateCount, sub: 'sub-agent 委派',
      level: '', hint: null,
      tip: 'Sub-agent 委派的總次數，反映 pipeline 執行密度' },
    { key: 'duration', emoji: '⏱', label: 'Session 時長', value: sessionDur, sub: startedAt ? new Date(startedAt).toLocaleTimeString('zh-TW', { hour12: false }) : '未開始',
      level: '', hint: null,
      tip: '從 session 開始到現在的經過時間' },
  ];

  return html`
    <div class="stats-grid">
      ${cards.map(c => html`
        <div key=${c.key} class="stat-card ${c.level}" data-tip=${c.tip}>
          <span class="stat-label">${c.emoji} ${c.label}</span>
          <span class="stat-value">${c.value}</span>
          <span class="stat-sub">${c.sub}</span>
          ${c.hint && html`<span class="stat-hint ${c.level}">${c.hint}</span>`}
        </div>
      `)}
    </div>
  `;
}
