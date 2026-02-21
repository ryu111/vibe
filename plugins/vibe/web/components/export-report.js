// 報告導出函式
import { getStageStatus, getStageVerdict, getPipelineProgress } from '../state/pipeline.js';

/**
 * 導出 Pipeline 報告（Markdown 或 JSON）
 * @param {object} state pipeline state
 * @param {string} sessionId session ID
 * @param {object[]} events timeline 事件清單
 * @param {'md'|'json'} format 輸出格式
 * @param {object} registry registry 資料
 */
export function exportReport(state, sessionId, events, format, registry) {
  if (!state) return;
  const dag = state.dag || {};
  const stages = Object.keys(dag).map(id => {
    const status = getStageStatus(id, state);
    const verdict = getStageVerdict(id, state);
    const meta = registry?.stages?.[id.split(':')[0]];
    return {
      stage: id,
      agent: meta?.agent || '—',
      label: meta?.label || id,
      status,
      verdict: verdict || (status === 'skipped' ? 'SKIP' : '—'),
      retries: state.retries?.[id] || 0,
    };
  });
  const pid = state.classification?.pipelineId;
  const pLabel = (registry?.pipelines?.[pid]?.label) || pid || '—';

  if (format === 'json') {
    const report = {
      sessionId,
      pipelineId: pid,
      progress: getPipelineProgress(state) + '%',
      stages,
      timeline: events.slice(0, 50).map(e => ({ time: e.time, text: e.text, type: e.type })),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pipeline-${sessionId?.slice(0, 8) || 'report'}.json`;
    a.click();
  } else {
    const lines = [
      `# Pipeline Report\n`,
      `- **Session**: ${sessionId}`,
      `- **Pipeline**: ${pLabel}`,
      `- **Progress**: ${getPipelineProgress(state)}%`,
      `- **Exported**: ${new Date().toISOString()}\n`,
      `## Stages\n`,
      `| Stage | Agent | Verdict | Retries |`,
      `|-------|-------|---------|---------|`,
    ];
    for (const st of stages) lines.push(`| ${st.stage} | ${st.agent} | ${st.verdict} | ${st.retries} |`);
    if (events.length) {
      lines.push(`\n## Timeline\n`);
      for (const ev of events.slice(0, 30)) lines.push(`- \`${ev.time}\` ${ev.text}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pipeline-${sessionId?.slice(0, 8) || 'report'}.md`;
    a.click();
  }
}
