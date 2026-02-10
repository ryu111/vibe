#!/usr/bin/env node
/**
 * generate-dashboard.js — 從 plugin-specs.json + progress.json 產生 dashboard.html
 *
 * 用途：SessionEnd hook 在 scan-progress.js 之後執行
 * 產出：docs/dashboard.html（自包含、深色主題、進度視覺化）
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SPECS_PATH = path.join(ROOT, 'docs', 'plugin-specs.json');
const PROGRESS_PATH = path.join(ROOT, 'docs', 'progress.json');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'dashboard.html');
const INDEX_PATH = path.join(ROOT, 'docs', 'ref', 'index.md');

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ─── CSS ───────────────────────────────────────

const CSS = `
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #1c2129;
    --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
    --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --purple: #bc8cff; --orange: #f0883e; --cyan: #39d2c0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.5; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1.3rem; color: var(--accent); margin: 2.5rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  .subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.8rem; }
  .timestamp { color: var(--text-muted); font-size: 0.75rem; margin-bottom: 1.5rem; }

  /* 整體進度條 */
  .overall-progress { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.2rem 1.5rem; margin-bottom: 1.5rem; }
  .overall-label { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; }
  .overall-label span:first-child { font-size: 1rem; font-weight: 600; }
  .overall-label span:last-child { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
  .progress-bar { background: var(--bg); border-radius: 6px; height: 12px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 6px; transition: width 0.3s; }
  .fill-green { background: var(--green); }
  .fill-blue { background: var(--accent); }
  .fill-yellow { background: var(--yellow); }
  .fill-grey { background: var(--text-muted); }

  /* Stats */
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem 1.2rem; flex: 1; min-width: 100px; }
  .stat-value { font-size: 1.5rem; font-weight: 700; }
  .stat-expected { font-size: 0.85rem; color: var(--text-muted); }
  .stat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

  /* 建構順序 */
  .build-order { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; margin: 1rem 0; }
  .build-phase { flex: 1; min-width: 120px; padding: 0.8rem; border: 2px solid var(--border); background: var(--surface); text-align: center; position: relative; }
  .build-phase:first-child { border-radius: 10px 0 0 10px; }
  .build-phase:last-child { border-radius: 0 10px 10px 0; }
  .build-phase + .build-phase { border-left: none; }
  .build-name { font-weight: 700; font-size: 0.95rem; }
  .build-pct { font-size: 1.4rem; font-weight: 700; margin: 0.3rem 0; }
  .build-status { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .build-phase.done { border-color: var(--green); }
  .build-phase.done .build-name { color: var(--green); }
  .build-phase.done .build-pct { color: var(--green); }
  .build-phase.next { border-color: var(--accent); border-style: dashed; }
  .build-phase.next .build-name { color: var(--accent); }
  .build-phase.progress { border-color: var(--yellow); }
  .build-phase.progress .build-name { color: var(--yellow); }
  .phase-bar { height: 4px; background: var(--bg); border-radius: 2px; margin-top: 0.5rem; overflow: hidden; }
  .phase-bar-fill { height: 100%; border-radius: 2px; }

  /* 流程圖 */
  .flow { display: flex; flex-direction: column; gap: 0; align-items: center; margin: 1rem 0 2rem; }
  .flow-arrow { color: var(--text-muted); font-size: 1.5rem; line-height: 1; padding: 0.3rem 0; }
  .flow-box { width: 100%; max-width: 720px; border: 2px solid var(--border); border-radius: 12px; padding: 1rem 1.2rem; background: var(--surface); position: relative; }
  .flow-box.core { border-color: var(--accent); }
  .flow-box.knowledge { border-color: var(--yellow); border-style: dashed; }
  .flow-box.advanced { border-color: var(--purple); }
  .flow-box.external { border-color: var(--orange); border-style: dotted; }
  .flow-box.endpoint { border-color: var(--text-muted); border-style: dashed; text-align: center; color: var(--text-muted); }
  .flow-label { position: absolute; top: -0.7rem; left: 1rem; background: var(--surface); padding: 0 0.5rem; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
  .flow-box.core .flow-label { color: var(--accent); }
  .flow-box.knowledge .flow-label { color: var(--yellow); }
  .flow-box.advanced .flow-label { color: var(--purple); }
  .flow-box.external .flow-label { color: var(--orange); }
  .flow-desc { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.3rem; }
  .flow-steps { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.5rem; }
  .flow-step { font-size: 0.78rem; padding: 0.15rem 0.55rem; border-radius: 4px; background: rgba(255,255,255,0.05); }
  .flow-step.auto { border-left: 3px solid var(--green); }
  .flow-step.manual { border-left: 3px solid var(--accent); }
  .badge { display: inline-block; font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 3px; margin-left: 0.5rem; vertical-align: middle; }
  .badge-auto { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-manual { background: rgba(88,166,255,0.15); color: var(--accent); }

  /* Plugin 卡片 */
  .plugins { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.2rem; margin-top: 1rem; }
  .plugin-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem; transition: border-color 0.2s; }
  .plugin-card:hover { border-color: var(--accent); }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; }
  .card-header h3 { font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }
  .card-desc { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.8rem; }
  .status-badge { font-size: 0.7rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600; }
  .status-complete { background: rgba(63,185,80,0.15); color: var(--green); }
  .status-in-progress { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .status-planned { background: rgba(139,148,158,0.12); color: var(--text-muted); }

  /* 組件格 */
  .comp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-bottom: 0.8rem; }
  .comp-cell { text-align: center; padding: 0.5rem 0.2rem; border-radius: 6px; background: rgba(255,255,255,0.03); }
  .comp-val { font-size: 0.85rem; font-weight: 700; }
  .comp-lbl { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .comp-bar { height: 3px; background: var(--bg); border-radius: 2px; margin-top: 0.3rem; overflow: hidden; }
  .comp-bar-fill { height: 100%; border-radius: 2px; }

  /* 組件標籤 */
  .tag-list { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; padding: 0.12rem 0.5rem; border-radius: 4px; }
  .tag-skill { background: rgba(88,166,255,0.1); color: var(--accent); }
  .tag-agent { background: rgba(188,140,255,0.1); color: var(--purple); }
  .tag-hook { background: rgba(210,153,34,0.1); color: var(--yellow); }
  .tag .check { color: var(--green); font-weight: 700; }
  .tag .pending { color: var(--text-muted); opacity: 0.5; }

  /* 依賴圖 */
  .dep-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .dep-box { border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; background: var(--surface); }
  .dep-box h4 { font-size: 0.85rem; margin-bottom: 0.3rem; }
  .dep-box p { font-size: 0.78rem; color: var(--text-muted); }
  .dep-box.dep-independent { border-color: var(--yellow); }
  .dep-box.dep-core { border-color: var(--accent); }
  .dep-box.dep-advanced { border-color: var(--purple); }
  .dep-box.dep-external { border-color: var(--orange); }

  /* Agent 工作流 */
  .agent-workflow { display: flex; flex-direction: column; align-items: center; gap: 0; margin: 1rem 0; }
  .agent-phase { width: 100%; max-width: 900px; margin-bottom: 0; }
  .agent-phase-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
  .agent-phase-name { font-size: 0.95rem; font-weight: 700; }
  .agent-phase-desc { font-size: 0.78rem; color: var(--text-muted); }
  .agent-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 0.8rem; }
  .agent-card { background: var(--surface); border: 2px solid var(--border); border-radius: 10px; padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .agent-card-head { display: flex; justify-content: space-between; align-items: center; }
  .agent-card-head h4 { font-size: 0.95rem; display: flex; align-items: center; gap: 0.4rem; }
  .agent-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .agent-perm { font-size: 0.65rem; padding: 0.1rem 0.45rem; border-radius: 3px; font-weight: 600; }
  .agent-perm.readonly { background: rgba(88,166,255,0.12); color: var(--accent); }
  .agent-perm.writable { background: rgba(248,81,73,0.12); color: var(--red); }
  .agent-trigger { font-size: 0.78rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.3rem; }
  .agent-trigger code { background: rgba(255,255,255,0.06); padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; color: var(--accent); }
  .agent-flow { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; font-size: 0.72rem; color: var(--text-muted); }
  .agent-flow-step { padding: 0.1rem 0.4rem; border-radius: 3px; background: rgba(255,255,255,0.04); }
  .agent-flow .arrow { color: var(--text-muted); opacity: 0.5; }
  .agent-tools { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .agent-tool { font-size: 0.65rem; padding: 0.08rem 0.35rem; border-radius: 3px; background: rgba(255,255,255,0.05); color: var(--text-muted); }
  .agent-model { font-size: 0.65rem; color: var(--text-muted); opacity: 0.7; }
  .agent-connector { display: flex; flex-direction: column; align-items: center; padding: 0.6rem 0; color: var(--text-muted); }
  .agent-connector-arrow { font-size: 1.3rem; line-height: 1; }
  .agent-connector-label { font-size: 0.75rem; padding: 0.15rem 0.7rem; border-radius: 4px; background: rgba(255,255,255,0.04); border: 1px dashed var(--border); }
  .agent-human { width: 100%; max-width: 900px; margin: 0.3rem 0; padding: 0.7rem 1rem; border: 2px solid var(--yellow); border-radius: 10px; background: rgba(210,153,34,0.06); display: flex; align-items: center; gap: 0.8rem; }
  .agent-human-icon { font-size: 1.3rem; flex-shrink: 0; }
  .agent-human-text { font-size: 0.85rem; }
  .agent-human-text strong { color: var(--yellow); }
  .agent-human-detail { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem; }

  /* Agent 詳細流程 Pipeline */
  .pipe { display: flex; flex-direction: column; gap: 0; margin: 1rem 0; }
  .pipe-header { display: flex; align-items: center; gap: 0; flex-wrap: wrap; margin-bottom: 1.5rem; justify-content: center; }
  .pipe-hstage { padding: 0.4rem 1rem; font-size: 0.8rem; font-weight: 700; border-radius: 6px; background: var(--surface); border: 2px solid var(--border); text-transform: uppercase; letter-spacing: 0.06em; }
  .pipe-harrow { color: var(--text-muted); font-size: 1.2rem; padding: 0 0.3rem; }
  .pipe-stage { width: 100%; max-width: 780px; margin: 0 auto 0.5rem; display: flex; gap: 1.2rem; align-items: flex-start; border: 2px solid var(--border); border-radius: 12px; padding: 1.2rem; background: var(--surface); }
  .pipe-stage-side { flex-shrink: 0; width: 64px; text-align: center; padding-top: 0.2rem; }
  .pipe-stage-num { display: block; font-size: 1.5rem; font-weight: 800; opacity: 0.15; line-height: 1; }
  .pipe-stage-label { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 0.2rem; }
  .pipe-stage-body { flex: 1; min-width: 0; }
  .pipe-agents { display: flex; flex-direction: column; gap: 0.6rem; }
  .pipe-agents-parallel { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.6rem; }
  .pipe-agents-seq-arrow { display: flex; justify-content: center; padding: 0.15rem 0; color: var(--text-muted); font-size: 0.7rem; opacity: 0.6; }
  .pipe-agents-par-label { text-align: center; font-size: 0.65rem; color: var(--purple); font-weight: 600; padding: 0.15rem 0; opacity: 0.7; }
  .pipe-agent { border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; background: rgba(255,255,255,0.02); }
  .pipe-agent-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .pipe-agent-head h5 { font-size: 0.88rem; display: flex; align-items: center; gap: 0.35rem; margin: 0; }
  .pipe-agent-model { font-size: 0.62rem; font-weight: 600; opacity: 0.8; white-space: nowrap; }
  .pipe-flow { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
  .pipe-node { display: flex; align-items: baseline; gap: 0.4rem; padding: 0.25rem 0; }
  .pipe-node-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 0.35rem; }
  .pipe-node-dot.input { background: var(--green); }
  .pipe-node-dot.step { background: var(--text-muted); opacity: 0.4; }
  .pipe-node-dot.output { background: var(--accent); }
  .pipe-node-dot.decision { background: var(--yellow); }
  .pipe-node-text { font-size: 0.78rem; font-weight: 600; }
  .pipe-node-sub { font-size: 0.7rem; color: var(--text-muted); }
  .pipe-node.input .pipe-node-text { color: var(--green); }
  .pipe-node.output .pipe-node-text { color: var(--accent); }
  .pipe-node.decision .pipe-node-text { color: var(--yellow); }
  .pipe-loop { border: 1px dashed var(--orange); border-radius: 6px; padding: 0.3rem 0.5rem; margin: 0.2rem 0; position: relative; }
  .pipe-loop-label { position: absolute; top: -0.5rem; right: 0.5rem; background: var(--surface); padding: 0 0.3rem; font-size: 0.6rem; color: var(--orange); font-weight: 600; }
  .pipe-branch { display: flex; gap: 0.6rem; margin: 0.2rem 0; }
  .pipe-branch-side { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.5rem; text-align: center; }
  .pipe-branch-label { font-size: 0.65rem; font-weight: 600; margin-bottom: 0.15rem; }
  .pipe-branch-detail { font-size: 0.65rem; color: var(--text-muted); }
  .pipe-connector { display: flex; justify-content: center; padding: 0.3rem 0; }
  .pipe-connector-arrow { color: var(--text-muted); font-size: 1.3rem; line-height: 1; }
  .pipe-stage-human { border-style: dashed; border-color: var(--yellow); }
  .pipe-human-content { display: flex; align-items: center; gap: 0.8rem; }
  .pipe-human-icon { font-size: 1.3rem; flex-shrink: 0; }
  /* Return Rail — 回退軌道 */
  .pipe-return-zone { display: flex; gap: 0; width: 100%; max-width: 840px; margin: 0 auto; }
  .pipe-return-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0; }
  .pipe-return-main .pipe-stage { max-width: none; margin: 0 0 0.5rem; }
  .pipe-return-main .pipe-connector { margin: 0; }
  .pipe-return-rail { width: 48px; flex-shrink: 0; position: relative; display: flex; flex-direction: column; align-items: center; }
  .pipe-rail-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 0; border-left: 2px dashed var(--red); opacity: 0.5; }
  .pipe-rail-arrow { position: relative; z-index: 1; color: var(--red); font-size: 1rem; font-weight: 700; margin-top: 0.5rem; background: var(--bg); padding: 0.2rem 0; }
  .pipe-rail-label { position: relative; z-index: 1; writing-mode: vertical-rl; text-orientation: mixed; font-size: 0.6rem; color: var(--red); opacity: 0.5; letter-spacing: 0.15em; margin-top: auto; margin-bottom: 1rem; background: var(--bg); padding: 0.3rem 0; }
  /* Fork — 分叉連接器（含水平虛線到 rail） */
  .pipe-fork { display: flex; align-items: center; padding: 0.15rem 0; }
  .pipe-fork-pass { color: var(--green); font-size: 0.72rem; font-weight: 600; }
  .pipe-fork-line { flex: 1; border-bottom: 1px dashed var(--red); opacity: 0.4; margin: 0 0.5rem; }
  .pipe-fork-fail { color: var(--red); font-size: 0.68rem; font-weight: 600; opacity: 0.7; white-space: nowrap; }
  /* Main Agent */
  .pipe-main-agent { width: 100%; max-width: 780px; margin: 0 auto 0.5rem; display: flex; gap: 1rem; align-items: center; border: 2px solid var(--accent); border-radius: 12px; padding: 0.8rem 1.2rem; background: rgba(88,166,255,0.04); }
  .pipe-main-agent-icon { font-size: 1.3rem; flex-shrink: 0; }
  .pipe-main-agent-title { font-weight: 700; color: var(--accent); font-size: 0.9rem; }
  .pipe-main-agent-detail { font-size: 0.75rem; color: var(--text-muted); }

  /* Stop Hook 防護層 */
  .guard-section-title { font-size: 0.82rem; font-weight: 700; color: var(--text-muted); text-align: center; margin: 1.2rem 0 0.6rem; text-transform: uppercase; letter-spacing: 0.1em; }
  .guard-layer { display: flex; gap: 1rem; max-width: 720px; margin: 0 auto; }
  .guard-card { flex: 1; border-radius: 10px; padding: 0.9rem 1rem; }
  .guard-card.guide { border: 2px solid var(--cyan); background: rgba(57,210,192,0.04); }
  .guard-card.block { border: 2px solid var(--red); background: rgba(248,81,73,0.04); }
  .guard-title { font-size: 0.88rem; font-weight: 700; margin-bottom: 0.3rem; display: flex; align-items: center; gap: 0.4rem; }
  .guard-card.guide .guard-title { color: var(--cyan); }
  .guard-card.block .guard-title { color: var(--red); }
  .guard-hook { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 0.4rem; }
  .guard-hook code { background: rgba(255,255,255,0.06); padding: 0.08rem 0.35rem; border-radius: 3px; font-size: 0.7rem; }
  .guard-desc { font-size: 0.78rem; color: var(--text-muted); }
  .guard-mechanism { display: inline-block; font-size: 0.68rem; padding: 0.12rem 0.45rem; border-radius: 3px; font-weight: 600; margin-top: 0.4rem; }
  .guard-card.guide .guard-mechanism { background: rgba(57,210,192,0.15); color: var(--cyan); }
  .guard-card.block .guard-mechanism { background: rgba(248,81,73,0.15); color: var(--red); }
  .guard-wrapper { border: 2px dashed var(--border); border-radius: 14px; padding: 1rem 1.2rem; margin: 0.5rem auto; max-width: 780px; position: relative; }
  .guard-wrapper-label { position: absolute; top: -0.7rem; right: 1rem; background: var(--bg); padding: 0 0.5rem; font-size: 0.72rem; font-weight: 700; color: var(--text-muted); letter-spacing: 0.05em; }

  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.78rem; text-align: center; }
`;

// ─── HTML 區塊生成 ──────────────────────────────

function progressColor(pct) {
  if (pct >= 100) return 'var(--green)';
  if (pct >= 50) return 'var(--yellow)';
  if (pct > 0) return 'var(--accent)';
  return 'var(--text-muted)';
}

function fillClass(pct) {
  if (pct >= 100) return 'fill-green';
  if (pct >= 50) return 'fill-yellow';
  if (pct > 0) return 'fill-blue';
  return 'fill-grey';
}

function statusLabel(status) {
  const map = { complete: '完成', 'in-progress': '進行中', planned: '規劃中' };
  return map[status] || status;
}

function genStats(specs, progress) {
  const s = { skills: 0, agents: 0, hooks: 0, scripts: 0 };
  const e = { skills: 0, agents: 0, hooks: 0, scripts: 0 };
  for (const [name, p] of Object.entries(progress.plugins)) {
    s.skills += p.actual.skills.length;
    s.agents += p.actual.agents.length;
    s.hooks += p.actual.hooks;
    s.scripts += p.actual.scripts;
    e.skills += p.expected.skills.length;
    e.agents += p.expected.agents.length;
    e.hooks += p.expected.hooks;
    e.scripts += p.expected.scripts;
  }
  const pluginsDone = Object.values(progress.plugins).filter(p => p.status === 'complete').length;
  const pluginsTotal = Object.keys(progress.plugins).length;
  const items = [
    { actual: pluginsDone, expected: pluginsTotal, label: 'Plugins', color: 'var(--green)' },
    { actual: s.skills, expected: e.skills, label: 'Skills', color: 'var(--accent)' },
    { actual: s.agents, expected: e.agents, label: 'Agents', color: 'var(--purple)' },
    { actual: s.hooks, expected: e.hooks, label: 'Hooks', color: 'var(--yellow)' },
    { actual: s.scripts, expected: e.scripts, label: 'Scripts', color: 'var(--cyan)' },
  ];
  return items.map(i => `
    <div class="stat">
      <div class="stat-value" style="color:${i.color}">${i.actual}</div>
      <div class="stat-expected">/ ${i.expected}</div>
      <div class="stat-label">${i.label}</div>
    </div>`).join('');
}

function genBuildOrder(specs, progress) {
  const ordered = Object.entries(specs.plugins)
    .sort((a, b) => a[1].buildOrder - b[1].buildOrder);

  return ordered.map(([name, spec]) => {
    const p = progress.plugins[name];
    const pct = p.completion.overall;
    let cls = '';
    if (pct >= 100) cls = 'done';
    else if (pct > 0) cls = 'progress';
    else {
      const prevIdx = spec.buildOrder - 1;
      const prevDone = ordered.find(([, s]) => s.buildOrder === prevIdx);
      if (!prevDone || progress.plugins[prevDone[0]].completion.overall >= 100) {
        cls = 'next';
      }
    }
    return `
    <div class="build-phase ${cls}">
      <div class="build-name">${name}</div>
      <div class="build-pct" style="color:${progressColor(pct)}">${pct}%</div>
      <div class="build-status">${statusLabel(p.status)}</div>
      <div class="phase-bar"><div class="phase-bar-fill ${fillClass(pct)}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}


function genPluginCards(specs, progress) {
  return Object.entries(specs.plugins)
    .sort((a, b) => a[1].buildOrder - b[1].buildOrder)
    .map(([name, spec]) => {
      const p = progress.plugins[name];
      const pct = p.completion.overall;
      const actualSkills = new Set(p.actual.skills);
      const actualAgents = new Set(p.actual.agents);

      // 組件數量格
      const compCells = [
        { label: 'Skills', val: p.completion.skills, color: 'var(--accent)' },
        { label: 'Agents', val: p.completion.agents, color: 'var(--purple)' },
        { label: 'Hooks', val: p.completion.hooks, color: 'var(--yellow)' },
        { label: 'Scripts', val: p.completion.scripts, color: 'var(--cyan)' },
      ];
      const compGrid = compCells.map(c => {
        const [act, exp] = c.val.split('/').map(Number);
        const cellPct = exp > 0 ? Math.round((act / exp) * 100) : 100;
        return `
          <div class="comp-cell">
            <div class="comp-val" style="color:${c.color}">${c.val}</div>
            <div class="comp-lbl">${c.label}</div>
            <div class="comp-bar"><div class="comp-bar-fill ${fillClass(cellPct)}" style="width:${cellPct}%"></div></div>
          </div>`;
      }).join('');

      // 組件標籤
      const skillTags = spec.expected.skills.map(s => {
        const done = actualSkills.has(s);
        return `<span class="tag tag-skill"><span class="${done ? 'check' : 'pending'}">${done ? '✓' : '○'}</span> ${s}</span>`;
      }).join('');
      const agentTags = spec.expected.agents.map(a => {
        const done = actualAgents.has(a);
        return `<span class="tag tag-agent"><span class="${done ? 'check' : 'pending'}">${done ? '✓' : '○'}</span> ${a}</span>`;
      }).join('');

      return `
      <div class="plugin-card">
        <div class="card-header">
          <h3>${name}</h3>
          <span class="status-badge status-${p.status}">${statusLabel(p.status)}</span>
        </div>
        <div class="card-desc">${spec.description}</div>
        <div class="progress-bar" style="margin-bottom:0.8rem">
          <div class="progress-fill ${fillClass(pct)}" style="width:${pct}%"></div>
        </div>
        <div class="comp-grid">${compGrid}</div>
        <div class="tag-list">${skillTags}${agentTags}</div>
      </div>`;
    }).join('');
}

function genDependencyGraph() {
  return `
  <div class="dep-grid">
    <div class="dep-box dep-independent">
      <h4 style="color:var(--yellow)">獨立安裝</h4>
      <p><strong>patterns</strong> — 純知識庫，8 skills，無 hooks/agents</p>
    </div>
    <div class="dep-box dep-core">
      <h4 style="color:var(--accent)">核心雙引擎</h4>
      <p><strong>flow</strong> + <strong>sentinel</strong> — 建議一起安裝<br>規劃 → 寫碼 → 品質檢查</p>
    </div>
    <div class="dep-box dep-advanced">
      <h4 style="color:var(--purple)">可選增強</h4>
      <p><strong>evolve</strong> — 知識進化 + 文件<br>依賴 flow（可選）</p>
    </div>
    <div class="dep-box dep-external">
      <h4 style="color:var(--orange)">進階（需 Agent Teams）</h4>
      <p><strong>collab</strong> — 多視角競爭分析<br>需 Agent Teams 環境變數</p>
    </div>
  </div>`;
}

function genFlowDiagram() {
  // 階段定義
  const phases = [
    {
      name: 'FLOW',
      color: 'var(--accent)',
      desc: '規劃階段 — 唯讀分析，產出計畫與架構方案',
      agents: [
        {
          name: 'planner',
          color: 'var(--purple)',
          perm: 'readonly',
          permLabel: '唯讀',
          trigger: '/flow:plan',
          model: 'opus · plan mode',
          tools: ['Read', 'Grep', 'Glob'],
          flow: ['理解需求', '掃描專案', '識別影響', '拆解階段', '評估風險', '產出計畫'],
        },
        {
          name: 'architect',
          color: 'var(--cyan)',
          perm: 'readonly',
          permLabel: '唯讀',
          trigger: '/flow:architect',
          model: 'opus · plan mode',
          tools: ['Read', 'Grep', 'Glob'],
          flow: ['掃描結構', '分析慣例', '識別邊界', '設計 2-3 方案', '目錄樹+介面+資料流'],
        },
      ],
      extraSteps: [
        { label: 'SessionStart: pipeline-init', auto: true },
        { label: 'PreToolUse: suggest-compact', auto: true },
        { label: '/flow:compact', auto: false },
        { label: '/flow:checkpoint', auto: false },
        { label: '/flow:env-detect', auto: false },
      ],
    },
    {
      name: 'DEV',
      color: 'var(--yellow)',
      desc: '實作階段 — 按計畫寫碼，自動 lint/format',
      agents: [
        {
          name: 'developer',
          color: 'var(--yellow)',
          perm: 'writable',
          permLabel: '可寫',
          trigger: '自動（Main Agent 委派）',
          model: 'sonnet · acceptEdits · 60t',
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          flow: ['載入 PATTERNS', '按階段實作', '寫測試', '自動 hooks', '產出可運行程式碼'],
        },
      ],
      extraSteps: [
        { label: 'PostToolUse: auto-lint', auto: true },
        { label: 'PostToolUse: auto-format', auto: true },
        { label: 'PostToolUse: test-check', auto: true },
      ],
    },
    {
      name: 'SENTINEL',
      color: 'var(--accent)',
      desc: '品質階段 — 審查、安全、修復、測試',
      agents: [
        {
          name: 'code-reviewer',
          color: 'var(--accent)',
          perm: 'readonly',
          permLabel: '唯讀',
          trigger: '/sentinel:review',
          model: 'opus · plan mode',
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          flow: ['收集變更', '理解上下文', '逐項分析', 'CRITICAL→LOW 報告'],
        },
        {
          name: 'security-reviewer',
          color: 'var(--red)',
          perm: 'readonly',
          permLabel: '唯讀',
          trigger: '/sentinel:security',
          model: 'opus · plan mode',
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          flow: ['識別攻擊面', '追蹤資料流', 'OWASP Top 10', '修復建議'],
        },
        {
          name: 'tester',
          color: 'var(--lime)',
          perm: 'writable',
          permLabel: '可寫',
          trigger: '/sentinel:tdd',
          model: 'sonnet · acceptEdits · 30t',
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          flow: ['分析程式碼', '邊界案例', '整合測試', '覆蓋率檢查'],
        },
        {
          name: 'build-error-resolver',
          color: 'var(--orange)',
          perm: 'writable',
          permLabel: '可寫',
          trigger: '/sentinel:verify',
          model: 'haiku · acceptEdits · 15t',
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          flow: ['解析錯誤', '最小修復', '驗證', '≤3 輪'],
        },
        {
          name: 'e2e-runner',
          color: 'var(--green)',
          perm: 'writable',
          permLabel: '可寫',
          trigger: '/sentinel:e2e',
          model: 'sonnet · acceptEdits · 30t',
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          flow: ['分析頁面', '建 Page Objects', '撰寫測試', '執行', '除錯 ≤3 輪'],
        },
      ],
      extraSteps: [
        { label: 'PreToolUse: danger-guard', auto: true },
        { label: 'Stop: console-log-check', auto: true },
        { label: '/sentinel:lint', auto: false },
        { label: '/sentinel:format', auto: false },
        { label: '/sentinel:coverage', auto: false },
        { label: '/sentinel:verify', auto: false },
      ],
    },
    {
      name: 'EVOLVE',
      color: 'var(--purple)',
      desc: '文件階段 — 自動更新對應文件',
      agents: [
        {
          name: 'doc-updater',
          color: 'var(--green)',
          perm: 'writable',
          permLabel: '可寫',
          trigger: '/evolve:doc-sync',
          model: 'haiku · acceptEdits · 30t',
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          flow: ['分析 git diff', '識別受影響文件', '機械變更自動更新', '語意變更產出建議'],
        },
      ],
      extraSteps: [
        { label: '/evolve:evolve', auto: false },
        { label: '/evolve:doc-sync', auto: false },
      ],
    },
  ];

  // 階段之間的過渡元素（phases 之間依序對應）
  const transitions = [
    // FLOW → DEV
    {
      type: 'connector',
      arrow: '▼',
      label: '計畫 + 架構方案 → 開始實作',
    },
    // DEV → SENTINEL
    {
      type: 'connector',
      arrow: '▼',
      label: '程式碼就緒 → 品質檢查',
    },
    // SENTINEL → EVOLVE
    {
      type: 'connector',
      arrow: '▼',
      label: '品質通過 → 同步更新文件',
    },
  ];

  function renderAgent(a) {
    const flowSteps = a.flow.map((s, i) =>
      (i < a.flow.length - 1)
        ? `<span class="agent-flow-step">${s}</span><span class="arrow">→</span>`
        : `<span class="agent-flow-step">${s}</span>`
    ).join('');
    const toolTags = a.tools.map(t => `<span class="agent-tool">${t}</span>`).join('');
    return `
        <div class="agent-card" style="border-color:${a.color}">
          <div class="agent-card-head">
            <h4><span class="agent-dot" style="background:${a.color}"></span>${a.name}</h4>
            <span class="agent-perm ${a.perm}">${a.permLabel}</span>
          </div>
          <div class="agent-trigger">觸發：<code>${a.trigger}</code></div>
          <div class="agent-flow">${flowSteps}</div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="agent-tools">${toolTags}</div>
            <span class="agent-model">${a.model}</span>
          </div>
        </div>`;
  }

  function renderTransition(t) {
    if (t.type === 'human') {
      return `
    <div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>
    <div class="agent-human">
      <div class="agent-human-icon">${t.icon}</div>
      <div>
        <div class="agent-human-text">${t.text}</div>
        <div class="agent-human-detail">${t.detail}</div>
      </div>
    </div>`;
    }
    return `
    <div class="agent-connector">
      <div class="agent-connector-arrow">${t.arrow}</div>
      <div class="agent-connector-label">${t.label}</div>
    </div>`;
  }

  // 組合：起點 → phase → transition → phase → transition → phase → 終點
  const parts = [];

  // 任務類型路由表
  const taskRoutes = [
    { type: 'research', label: '研究探索', stages: '—', color: 'var(--text-muted)' },
    { type: 'quickfix', label: '小改動', stages: 'DEV', color: 'var(--yellow)' },
    { type: 'bugfix', label: '修 Bug', stages: 'DEV → TEST', color: 'var(--orange)' },
    { type: 'feature', label: '新功能', stages: 'PLAN → ARCH → DEV → REVIEW → TEST → DOCS', color: 'var(--green)' },
    { type: 'refactor', label: '重構', stages: 'ARCH → DEV → REVIEW', color: 'var(--cyan)' },
    { type: 'test', label: '補測試', stages: 'TEST', color: 'var(--lime)' },
    { type: 'docs', label: '寫文件', stages: 'DOCS', color: 'var(--green)' },
    { type: 'tdd', label: 'TDD', stages: 'TEST → DEV → REVIEW', color: 'var(--purple)' },
  ];

  // 起點
  parts.push(`
    <div class="agent-human" style="border-color:var(--text-muted);background:rgba(255,255,255,0.02)">
      <div class="agent-human-icon">💬</div>
      <div>
        <div class="agent-human-text"><strong style="color:var(--text)">使用者</strong>提出需求</div>
        <div class="agent-human-detail">自然語言描述功能、修復、重構等任務</div>
      </div>
    </div>`);

  // 分類器
  parts.push(`<div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>`);
  const routeRows = taskRoutes.map(r =>
    `<tr><td style="color:${r.color};font-weight:600">${r.label}</td><td style="opacity:0.7;font-size:0.75rem">${r.stages}</td></tr>`
  ).join('');
  parts.push(`
    <div class="agent-human" style="border-color:var(--purple);background:rgba(137,87,229,0.06)">
      <div class="agent-human-icon">🏷️</div>
      <div style="flex:1">
        <div class="agent-human-text"><strong style="color:var(--purple)">task-classifier</strong> <span style="opacity:0.6;font-size:0.75rem">haiku · UserPromptSubmit hook</span></div>
        <div class="agent-human-detail">自動分類任務類型 → 建議啟動的 pipeline 階段（建議而非強制）</div>
        <table style="margin-top:0.4rem;font-size:0.72rem;border-collapse:collapse;width:100%">
          <tr style="opacity:0.5"><th style="text-align:left;padding:0.15rem 0.5rem 0.15rem 0;font-weight:500">類型</th><th style="text-align:left;padding:0.15rem 0;font-weight:500">啟動階段</th></tr>
          ${routeRows}
        </table>
      </div>
    </div>`);

  phases.forEach((phase, i) => {
    // 箭頭
    parts.push(`<div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>`);

    // Phase 區塊
    const agentCards = phase.agents.map(renderAgent).join('');
    const extraHtml = (phase.extraSteps || []).map(s =>
      `<span class="flow-step ${s.auto ? 'auto' : 'manual'}">${s.label}</span>`
    ).join('');
    const extraBlock = extraHtml
      ? `\n      <div class="flow-steps" style="margin-top:0.6rem">${extraHtml}</div>`
      : '';
    parts.push(`
    <div class="agent-phase">
      <div class="agent-phase-header">
        <span class="agent-phase-name" style="color:${phase.color}">${phase.name}</span>
        <span class="agent-phase-desc">${phase.desc}</span>
      </div>
      <div class="agent-cards">${agentCards}</div>${extraBlock}
    </div>`);

    // PATTERNS 知識層 — 插在 FLOW 和 DEV 之間
    if (phase.name === 'FLOW') {
      parts.push(`
    <div class="agent-connector">
      <div class="agent-connector-arrow">▼</div>
      <div class="agent-connector-label">計畫 + 架構方案就緒</div>
    </div>`);
      parts.push(`
    <div class="agent-human" style="border-color:var(--yellow);border-style:dashed;background:rgba(210,153,34,0.04)">
      <div class="agent-human-icon">📚</div>
      <div>
        <div class="agent-human-text"><strong style="color:var(--yellow)">PATTERNS</strong> <span style="opacity:0.6;font-size:0.75rem">純知識庫 · 8 skills · 無 hooks/agents</span></div>
        <div class="agent-human-detail">coding-standards · frontend · backend · typescript · python · go · db · testing</div>
      </div>
    </div>`);
    } else if (i < phases.length - 1) {
      parts.push(renderTransition(transitions[i]));
    }
  });

  // 守衛層 — 導引 + 守衛
  parts.push(`<div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>`);
  parts.push(`
    <div class="guard-section-title">Stop 事件防護 — 全程監控</div>
    <div class="guard-layer">
      <div class="guard-card guide">
        <div class="guard-title">🧭 導引</div>
        <div class="guard-hook"><code>pipeline-check</code> Stop · <code>stage-transition</code> SubagentStop</div>
        <div class="guard-desc">確保走在正確的路上 — 遺漏 pipeline 階段時注入 systemMessage 建議下一步</div>
        <div class="guard-mechanism">systemMessage → 強建議</div>
      </div>
      <div class="guard-card block">
        <div class="guard-title">🛡️ 守衛</div>
        <div class="guard-hook"><code>task-guard</code> Stop hook</div>
        <div class="guard-desc">不讓正確的路中斷 — TodoWrite 有未完成項目時，以 decision: "block" 絕對阻止結束</div>
        <div class="guard-mechanism">decision: "block" → 絕對阻擋（≤5 次）</div>
      </div>
    </div>`);

  // 終點
  parts.push(`
    <div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>
    <div class="agent-human" style="border-color:var(--green);background:rgba(63,185,80,0.06)">
      <div class="agent-human-icon">🚀</div>
      <div>
        <div class="agent-human-text"><strong style="color:var(--green)">完成</strong>程式碼就緒 · 文件同步 · 準備發布</div>
        <div class="agent-human-detail">所有品質檢查通過，文件已更新，task-guard 放行</div>
      </div>
    </div>`);

  // COLLAB — 任意階段可插入
  parts.push(`
    <div class="agent-human" style="border-color:var(--orange);border-style:dotted;background:rgba(240,136,62,0.04);margin-top:1rem">
      <div class="agent-human-icon">⚔️</div>
      <div>
        <div class="agent-human-text"><strong style="color:var(--orange)">COLLAB</strong> <span style="opacity:0.6;font-size:0.75rem">Agent Teams · 任意階段可插入</span></div>
        <div class="agent-human-detail">/collab:adversarial-plan · /collab:adversarial-review · /collab:adversarial-refactor</div>
      </div>
    </div>`);

  return `<div class="agent-workflow">${parts.join('')}</div>`;
}

function genAgentDetails() {
  // Pipeline 階段定義
  const stages = [
    {
      num: '①', label: 'PLAN', color: 'var(--purple)',
      agents: [{
        name: 'planner', color: 'var(--purple)', perm: '唯讀', permClass: 'readonly',
        model: 'opus', mode: 'plan',
        nodes: [
          { t: 'input', text: '使用者需求', sub: '自然語言 · /flow:plan 觸發' },
          { t: 'step', text: '解析意圖', sub: '釐清目標、範圍邊界、成功條件' },
          { t: 'step', text: '掃描專案', sub: 'Glob + Read → 目錄結構、關鍵檔案' },
          { t: 'step', text: '識別影響', sub: 'Grep → 依賴關係、匯入鏈、副作用' },
          { t: 'step', text: '拆解階段', sub: '獨立階段 + 依賴順序 + 驗收條件' },
          { t: 'step', text: '評估風險', sub: '技術風險 · 外部依賴 · 破壞範圍' },
          { t: 'output', text: '分階段實作計畫', sub: '摘要 · 階段分解 · 風險 · 依賴圖' },
        ],
      }],
    },
    {
      num: '②', label: 'ARCH', color: 'var(--cyan)',
      agents: [{
        name: 'architect', color: 'var(--cyan)', perm: '唯讀', permClass: 'readonly',
        model: 'opus', mode: 'plan',
        nodes: [
          { t: 'input', text: '計畫 + 需求', sub: '/flow:architect 觸發' },
          { t: 'step', text: '掃描結構', sub: 'Glob → 目錄樹、檔案組織模式' },
          { t: 'step', text: '分析慣例', sub: 'Read + Grep → 命名、模式、框架用法' },
          { t: 'step', text: '識別邊界', sub: '模組界限 · API 邊界 · 資料流向' },
          { t: 'step', text: '設計 2-3 方案', sub: '每方案：優點 / 缺點 / 適用場景' },
          { t: 'output', text: '架構方案比較', sub: '目錄樹 · 介面定義 · 資料流 · 取捨分析' },
        ],
      }],
    },
    {
      num: '③', label: 'DEV', color: 'var(--yellow)',
      agents: [{
        name: 'developer', color: 'var(--yellow)', perm: '可寫', permClass: 'writable',
        model: 'sonnet', mode: 'acceptEdits', maxTurns: 60,
        nodes: [
          { t: 'input', text: '計畫 + 架構方案', sub: 'planner + architect 產出' },
          { t: 'step', text: '載入 PATTERNS', sub: '語言/框架模式庫 · coding-standards' },
          { t: 'step', text: '按階段實作', sub: '依計畫逐階段寫碼 · 遵循架構慣例' },
          { t: 'step', text: '寫測試', sub: '單元測試 + 整合測試 · TDD 可選' },
          { t: 'step', text: '自動 hooks 介入', sub: 'PostToolUse: auto-lint · auto-format' },
          { t: 'decision', text: '階段完成？', sub: 'Yes → 下一階段 · No → 繼續實作' },
          { t: 'output', text: '可運行的程式碼', sub: '通過 lint + format · 含測試 · 準備審查' },
        ],
      }],
    },
    {
      num: '④', label: 'REVIEW', color: 'var(--accent)',
      parallel: true,
      fallback: { icon: '↩', text: 'CRITICAL / HIGH 問題', target: '③ DEV', detail: '開發者修復後重新審查' },
      agents: [
        {
          name: 'code-reviewer', color: 'var(--accent)', perm: '唯讀', permClass: 'readonly',
          model: 'opus', mode: 'plan',
          nodes: [
            { t: 'input', text: '程式碼變更', sub: 'git diff · /sentinel:review' },
            { t: 'step', text: '收集變更範圍', sub: 'Bash: git diff · Glob: 目標檔案' },
            { t: 'step', text: '理解上下文', sub: 'Read: 完整檔案 · Grep: 引用關係' },
            { t: 'step', text: '逐項分析', sub: '正確性 · 安全性 · 效能 · 可維護性' },
            { t: 'step', text: '嚴重程度排序', sub: 'CRITICAL → HIGH → MEDIUM → LOW' },
            { t: 'output', text: '結構化審查報告', sub: '每項：嚴重度 · 位置 · 問題 · 建議' },
          ],
        },
        {
          name: 'security-reviewer', color: 'var(--red)', perm: '唯讀', permClass: 'readonly',
          model: 'opus', mode: 'plan',
          nodes: [
            { t: 'input', text: '程式碼 / API', sub: '/sentinel:security' },
            { t: 'step', text: '識別攻擊面', sub: 'API · 表單 · 外部輸入 · 檔案上傳' },
            { t: 'step', text: '追蹤資料流', sub: '輸入 → 處理 → 輸出 完整路徑' },
            { t: 'step', text: 'OWASP Top 10', sub: '注入 · 認證 · XSS · SSRF · 設定...' },
            { t: 'step', text: '檢查 Secrets', sub: '硬編碼 credentials · API keys · JWT' },
            { t: 'output', text: '安全報告', sub: '漏洞 · 攻擊場景 · 嚴重度 · 修復方案' },
          ],
        },
      ],
    },
    {
      num: '⑤', label: 'TEST', color: 'var(--orange)',
      fallback: { icon: '↩', text: '≤3 輪自動修復仍失敗', target: '③ DEV', detail: '需人工修復後重新測試' },
      agents: [
        {
          name: 'tester', color: 'var(--lime)', perm: '可寫', permClass: 'writable',
          model: 'sonnet', mode: 'acceptEdits', maxTurns: 30,
          nodes: [
            { t: 'input', text: '程式碼 + 規格', sub: '/sentinel:tdd 觸發' },
            { t: 'step', text: '分析程式碼行為', sub: 'Read + Grep → 公開介面、邊界條件' },
            { t: 'step', text: '設計測試案例', sub: '邊界值 · 異常路徑 · 整合場景' },
            { t: 'step', text: '撰寫測試', sub: '獨立視角 — 不看 developer 的測試邏輯' },
            { t: 'step', text: '執行 + 覆蓋率', sub: '目標 80% · 關鍵路徑 100%' },
            { t: 'output', text: '獨立測試套件', sub: '邊界案例 · 整合測試 · 覆蓋率報告' },
          ],
        },
        {
          name: 'build-error-resolver', color: 'var(--orange)', perm: '可寫', permClass: 'writable',
          model: 'haiku', mode: 'acceptEdits', maxTurns: 15,
          nodes: [
            { t: 'input', text: 'Build 錯誤', sub: '/sentinel:verify 觸發' },
            { t: 'step', text: '解析錯誤', sub: '分類：型別 · 語法 · 模組 · 設定' },
            { t: 'step', text: '定位問題', sub: 'Grep + Read → 錯誤來源' },
            { t: 'loop', label: '≤3 輪', nodes: [
              { t: 'step', text: '最小修復', sub: '只修錯誤，不重構不優化' },
              { t: 'step', text: '重新 Build', sub: 'Bash → 驗證修復結果' },
              { t: 'decision', text: '通過？', sub: 'Yes → 完成 · No → 下一輪' },
            ]},
            { t: 'output', text: '修復完成', sub: '成功：已修檔案 · 失敗：需人工介入' },
          ],
        },
        {
          name: 'e2e-runner', color: 'var(--green)', perm: '可寫', permClass: 'writable',
          model: 'sonnet', mode: 'acceptEdits', maxTurns: 30,
          nodes: [
            { t: 'input', text: '測試目標', sub: '/sentinel:e2e 觸發' },
            { t: 'step', text: '分析頁面', sub: 'Read HTML/JSX · 識別互動元素' },
            { t: 'step', text: '建 Page Objects', sub: '每頁一 class：Locators + Actions' },
            { t: 'step', text: '撰寫測試 Spec', sub: '依 Page Object 模式組織' },
            { t: 'loop', label: '≤3 輪', nodes: [
              { t: 'step', text: '執行測試', sub: 'npx playwright test' },
              { t: 'decision', text: '通過？', sub: 'Yes → 完成 · No → 除錯' },
            ]},
            { t: 'output', text: '通過的 E2E 測試', sub: 'Page Objects · Specs · 結果報告' },
          ],
        },
      ],
    },
    {
      num: '⑥', label: 'DOCS', color: 'var(--green)',
      fallback: { icon: '⚠', text: '語意變更需人工確認', target: '開發者', detail: '審查建議後手動調整文件' },
      agents: [{
        name: 'doc-updater', color: 'var(--green)', perm: '可寫', permClass: 'writable',
        model: 'haiku', mode: 'acceptEdits', maxTurns: 30,
        nodes: [
          { t: 'input', text: 'Git diff', sub: '/evolve:doc-sync 觸發' },
          { t: 'step', text: '分析變更', sub: 'Bash: git diff · 識別變更類型' },
          { t: 'step', text: '識別受影響文件', sub: 'Grep → 對應 .md / README / API docs' },
          { t: 'decision', text: '變更類型？', sub: '機械性 vs 語意性' },
          { t: 'branch', left: { label: '機械性', detail: '重命名 · 移動 · 參數' },
                          right: { label: '語意性', detail: '邏輯 · 行為 · 新功能' } },
          { t: 'step', text: '機械性 → 自動更新', sub: 'Write/Edit 直接修改文件' },
          { t: 'step', text: '語意性 → 產出建議', sub: '列出需人工確認的變更' },
          { t: 'output', text: '更新文件 + 建議', sub: '已更新 · 待確認清單' },
        ],
      }],
    },
  ];

  // 渲染單一節點
  function renderNode(n) {
    if (n.t === 'loop') {
      const inner = n.nodes.map(renderNode).join('');
      return `<div class="pipe-loop"><div class="pipe-loop-label">🔄 ${n.label}</div>${inner}</div>`;
    }
    if (n.t === 'branch') {
      return `<div class="pipe-branch">
        <div class="pipe-branch-side" style="border-color:var(--green)">
          <div class="pipe-branch-label" style="color:var(--green)">${n.left.label}</div>
          <div class="pipe-branch-detail">${n.left.detail}</div>
        </div>
        <div class="pipe-branch-side" style="border-color:var(--yellow)">
          <div class="pipe-branch-label" style="color:var(--yellow)">${n.right.label}</div>
          <div class="pipe-branch-detail">${n.right.detail}</div>
        </div>
      </div>`;
    }
    return `<div class="pipe-node ${n.t}">
      <div class="pipe-node-dot ${n.t}"></div>
      <div><span class="pipe-node-text">${n.text}</span> <span class="pipe-node-sub">${n.sub}</span></div>
    </div>`;
  }

  // 渲染單一 agent 流程
  function renderAgent(a) {
    const flow = a.nodes.map(renderNode).join('');
    // model 標籤
    const modelColor = a.model === 'opus' ? 'var(--purple)' : a.model === 'sonnet' ? 'var(--accent)' : 'var(--green)';
    const turnsInfo = a.maxTurns ? ` · ${a.maxTurns}t` : '';
    const modelTag = `<span class="pipe-agent-model" style="color:${modelColor}">${a.model} · ${a.mode}${turnsInfo}</span>`;
    return `<div class="pipe-agent" style="border-color:${a.color}">
      <div class="pipe-agent-head">
        <h5><span class="agent-dot" style="background:${a.color}"></span>${a.name}</h5>
        <div style="display:flex;align-items:center;gap:0.4rem">
          ${modelTag}
          <span class="agent-perm ${a.permClass}">${a.perm}</span>
        </div>
      </div>
      <div class="pipe-flow">${flow}</div>
    </div>`;
  }

  // 渲染一個 stage box（共用）
  function renderStage(stage) {
    if (stage.human) {
      const h = stage.humanContent;
      return `<div class="pipe-stage pipe-stage-human" style="border-color:${stage.color}">
        <div class="pipe-stage-side">
          <span class="pipe-stage-num">${stage.num}</span>
          <div class="pipe-stage-label" style="color:${stage.color}">${stage.label}</div>
        </div>
        <div class="pipe-stage-body">
          <div class="pipe-human-content">
            <div class="pipe-human-icon">${h.icon}</div>
            <div>
              <div style="font-weight:600;color:var(--yellow)">${h.title}</div>
              <div style="font-size:0.78rem;color:var(--text-muted)">${h.detail}</div>
            </div>
          </div>
        </div>
      </div>`;
    }
    let agentsHtml;
    if (stage.parallel && stage.agents.length > 1) {
      // 並行：雙欄 grid + ∥ 標記
      const cards = stage.agents.map(renderAgent).join('');
      agentsHtml = `<div class="pipe-agents-par-label">∥ 可並行</div>
        <div class="pipe-agents-parallel">${cards}</div>`;
    } else if (stage.agents.length > 1) {
      // 順序：垂直堆疊 + ▼ 箭頭
      agentsHtml = stage.agents.map((a, idx) => {
        const card = renderAgent(a);
        return idx < stage.agents.length - 1
          ? `${card}<div class="pipe-agents-seq-arrow">▼</div>`
          : card;
      }).join('');
      agentsHtml = `<div class="pipe-agents">${agentsHtml}</div>`;
    } else {
      agentsHtml = `<div class="pipe-agents">${stage.agents.map(renderAgent).join('')}</div>`;
    }
    return `<div class="pipe-stage" style="border-color:${stage.color}">
      <div class="pipe-stage-side">
        <span class="pipe-stage-num">${stage.num}</span>
        <div class="pipe-stage-label" style="color:${stage.color}">${stage.label}</div>
      </div>
      <div class="pipe-stage-body">
        ${agentsHtml}
      </div>
    </div>`;
  }

  // 組合
  const parts = [];

  // Pipeline 總覽橫條
  const classifyTag = `<span class="pipe-hstage" style="border-color:var(--purple);color:var(--purple)">🏷️</span>`;
  const headerStages = stages.map(s =>
    `<span class="pipe-hstage" style="border-color:${s.color};color:${s.color}">${s.label}</span>`
  ).join('<span class="pipe-harrow">→</span>');
  parts.push(`<div class="pipe-header">${classifyTag}<span class="pipe-harrow">→</span>${headerStages}</div>`);

  // Main Agent — Claude 主管
  parts.push(`<div class="pipe-main-agent">
    <div class="pipe-main-agent-icon">🤖</div>
    <div>
      <div class="pipe-main-agent-title">Main Agent（Claude）</div>
      <div class="pipe-main-agent-detail">接收使用者需求 → 判讀語意 → 決定執行策略 → 委派 sub-agents → 綜合結果回報</div>
    </div>
  </div>`);

  // 任務分類器
  const routeData = [
    { label: '研究探索', stages: '—', color: 'var(--text-muted)' },
    { label: '小改動', stages: 'DEV', color: 'var(--yellow)' },
    { label: '修 Bug', stages: 'DEV → TEST', color: 'var(--orange)' },
    { label: '新功能', stages: '全流程', color: 'var(--green)' },
    { label: '重構', stages: 'ARCH → DEV → REVIEW', color: 'var(--cyan)' },
    { label: 'TDD', stages: 'TEST → DEV → REVIEW', color: 'var(--purple)' },
  ];
  const routeChips = routeData.map(r =>
    `<span style="display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;font-size:0.68rem;font-weight:600;color:${r.color};border:1px solid ${r.color};opacity:0.8;white-space:nowrap">${r.label} → ${r.stages}</span>`
  ).join(' ');
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  parts.push(`<div style="border:1px dashed var(--purple);border-radius:10px;padding:0.6rem 0.8rem;background:rgba(137,87,229,0.04)">
    <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.4rem">
      <span style="font-size:0.8rem">🏷️</span>
      <span style="font-weight:700;font-size:0.82rem;color:var(--purple)">task-classifier</span>
      <span style="font-size:0.65rem;opacity:0.5">haiku · UserPromptSubmit · 自動</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:0.3rem">${routeChips}</div>
  </div>`);

  // ①② 正常渲染（PLAN、ARCH）
  stages.slice(0, 2).forEach((stage, i) => {
    parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
    parts.push(renderStage(stage));
  });

  // ③-⑥ 包在 return zone 裡
  const returnStages = stages.slice(2); // ③ DEV, ④ REVIEW, ⑤ TEST, ⑥ DOCS
  const returnParts = [];

  returnStages.forEach((stage, i) => {
    // 階段間連接器
    if (i > 0) {
      const prevStage = returnStages[i - 1];
      if (prevStage.fallback) {
        // fork 連接器：前一階段可能失敗 → 左通過 / 中間虛線 / 右回退到 rail
        returnParts.push(`<div class="pipe-fork">
          <span class="pipe-fork-pass">▼ 通過</span>
          <div class="pipe-fork-line"></div>
          <span class="pipe-fork-fail">✗ ${prevStage.fallback.text}</span>
        </div>`);
      } else {
        returnParts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
      }
    }
    returnParts.push(renderStage(stage));
  });

  // 最後一個 stage 若有 fallback，也加 fork 提示
  const lastReturn = returnStages[returnStages.length - 1];
  if (lastReturn.fallback) {
    returnParts.push(`<div class="pipe-fork">
      <span class="pipe-fork-pass">▼ 完成</span>
      <div class="pipe-fork-line"></div>
      <span class="pipe-fork-fail">⚠ ${lastReturn.fallback.text}</span>
    </div>`);
  }

  // 組合 return zone = main column + rail
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  parts.push(`<div class="pipe-return-zone">
    <div class="pipe-return-main">${returnParts.join('')}</div>
    <div class="pipe-return-rail">
      <div class="pipe-rail-line"></div>
      <div class="pipe-rail-arrow">↰</div>
      <div class="pipe-rail-label">失敗回退</div>
    </div>
  </div>`);

  // Stop Hook 雙層防護
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  parts.push(`<div class="guard-wrapper">
    <div class="guard-wrapper-label">🔒 STOP 事件防護</div>
    <div style="font-size:0.78rem;color:var(--text-muted);text-align:center;margin-bottom:0.8rem">
      Claude 每次嘗試結束回合時觸發 — 兩層機制，意義不同
    </div>
    <div class="guard-layer" style="max-width:none">
      <div class="guard-card guide">
        <div class="guard-title">🧭 導引 — 走在正確的路上</div>
        <div class="guard-hook"><code>stage-transition</code> SubagentStop · <code>pipeline-check</code> Stop</div>
        <div style="margin:0.5rem 0">
          <div class="pipe-node input"><div class="pipe-node-dot input"></div>
            <div><span class="pipe-node-text">Stop / SubagentStop 觸發</span></div></div>
          <div class="pipe-node step"><div class="pipe-node-dot step"></div>
            <div><span class="pipe-node-text">檢查 pipeline 狀態</span> <span class="pipe-node-sub">有遺漏階段？下一步是什麼？</span></div></div>
          <div class="pipe-node output"><div class="pipe-node-dot output"></div>
            <div><span class="pipe-node-text">注入 systemMessage</span> <span class="pipe-node-sub">建議下一步 → Claude 自行決定是否遵循</span></div></div>
        </div>
        <div class="guard-mechanism">目的：控制流程方向</div>
      </div>
      <div class="guard-card block">
        <div class="guard-title">🛡️ 守衛 — 不讓路中斷</div>
        <div class="guard-hook"><code>task-guard</code> Stop hook · 絕對阻擋</div>
        <div style="margin:0.5rem 0">
          <div class="pipe-node input"><div class="pipe-node-dot input"></div>
            <div><span class="pipe-node-text">Claude 嘗試結束回合</span></div></div>
          <div class="pipe-node decision"><div class="pipe-node-dot decision"></div>
            <div><span class="pipe-node-text">TodoWrite 全部完成？</span> <span class="pipe-node-sub">已取消？超過 5 次？</span></div></div>
          <div class="pipe-node" style="color:var(--red)"><div class="pipe-node-dot" style="background:var(--red)"></div>
            <div><span class="pipe-node-text" style="color:var(--red)">decision: "block"</span> <span class="pipe-node-sub">絕對阻止結束 → 強制繼續完成任務</span></div></div>
        </div>
        <div class="guard-mechanism">目的：阻止流程中斷</div>
      </div>
    </div>
  </div>`);

  // 完成
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  parts.push(`<div class="pipe-main-agent" style="border-color:var(--green);background:rgba(63,185,80,0.04)">
    <div class="pipe-main-agent-icon">✅</div>
    <div>
      <div class="pipe-main-agent-title" style="color:var(--green)">Pipeline 完成</div>
      <div class="pipe-main-agent-detail">所有任務完成 · task-guard 放行 · pipeline 狀態清除 · /flow:cancel 可手動取消</div>
    </div>
  </div>`);

  return `<div class="pipe">${parts.join('')}</div>`;
}

// ─── 組合 HTML ─────────────────────────────────

function generate(specs, progress) {
  const ts = new Date(progress.timestamp).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const pct = progress.overall.completion;

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vibe Marketplace — Dashboard</title>
<style>${CSS}</style>
</head>
<body>

<h1>Vibe Marketplace</h1>
<p class="subtitle">Claude Code Plugin Marketplace — 全端開發者的 AI 工具箱</p>
<p class="timestamp">最後更新：${ts}</p>

<!-- 整體進度 -->
<div class="overall-progress">
  <div class="overall-label">
    <span>整體建構進度</span>
    <span style="color:${progressColor(pct)}">${pct}%</span>
  </div>
  <div class="progress-bar">
    <div class="progress-fill ${fillClass(pct)}" style="width:${pct}%"></div>
  </div>
</div>

<!-- 統計 -->
<div class="stats">
  ${genStats(specs, progress)}
</div>

<!-- 建構順序 -->
<h2>建構順序</h2>
<div class="build-order">
  ${genBuildOrder(specs, progress)}
</div>

<!-- 開發流程 -->
<h2>開發流程</h2>
${genFlowDiagram()}

<!-- 依賴關係 -->
<h2>依賴關係</h2>
${genDependencyGraph()}



<!-- Agent 詳細流程 -->
<h2>Agent 詳細流程</h2>
${genAgentDetails()}

<!-- Plugin 詳情 -->
<h2>Plugin 詳情</h2>
<div class="plugins">
  ${genPluginCards(specs, progress)}
</div>

<div class="footer">
  Vibe Marketplace v0.2.0 — ${progress.overall.totalActual}/${progress.overall.totalExpected} 組件完成
  · 由 <code>scripts/generate-dashboard.js</code> 自動產生
</div>

</body>
</html>
`;
}

// ─── index.md 自動生成 ────────────────────────

function generateIndex(specs) {
  const pluginEntries = Object.entries(specs.plugins)
    .sort((a, b) => a[1].buildOrder - b[1].buildOrder);
  const buildPlugins = pluginEntries.filter(([name]) => name !== 'forge');

  let totalSkills = 0, totalAgents = 0, totalHooks = 0, totalScripts = 0;
  for (const [, spec] of pluginEntries) {
    totalSkills += spec.expected.skills.length;
    totalAgents += spec.expected.agents.length;
    totalHooks += spec.expected.hooks;
    totalScripts += spec.expected.scripts;
  }
  const totalAll = totalSkills + totalAgents + totalHooks + totalScripts;
  const pluginCount = pluginEntries.length;
  const doneCount = pluginEntries.filter(([, s]) => s.priority === 'done').length;
  const newCount = pluginCount - doneCount;
  const patternsSkills = (specs.plugins.patterns || { expected: { skills: [] } }).expected.skills.length;
  const dynamicSkills = totalSkills - patternsSkills;

  // §4 建構順序
  const buildRows = buildPlugins.map(([name, spec]) => {
    const e = spec.expected;
    const parts = [];
    if (e.skills.length) parts.push(`${e.skills.length}S`);
    if (e.agents.length) parts.push(`${e.agents.length}A`);
    if (e.hooks) parts.push(`${e.hooks}H`);
    if (e.scripts) parts.push(`${e.scripts}Sc`);
    const phase = spec.buildOrder + 2;
    let prereq = 'forge ✅';
    if (name === 'patterns') prereq = '無';
    else if (name === 'collab') prereq = 'Agent Teams';
    else if (name === 'evolve') prereq = 'flow 可選';
    return `| ${phase} | **${name}** | ${prereq} | ${parts.join(' + ')} |`;
  }).join('\n');

  // §5 文件索引
  const fileRows = buildPlugins.map(([name, spec], i) => {
    const e = spec.expected;
    return `| ${i + 1} | ${name} | [${name}.md](${name}.md) | ${e.skills.length} | ${e.agents.length} | ${e.hooks} | ${e.scripts} |`;
  }).join('\n');

  return `# Vibe Marketplace — Plugin 設計總覽

> ${pluginCount} 個 plugin（forge + ${newCount} 新）的總流程、依賴關係，以及各文件索引。
>
> **此檔案由 \`scripts/generate-dashboard.js\` 自動產生，請勿手動編輯。**
> 修改來源：\`docs/plugin-specs.json\`（數量）+ \`scripts/generate-dashboard.js\`（結構）

---

## 1. 開發全流程圖

完整視覺化流程圖請見 [dashboard.html](../dashboard.html)。

\`\`\`
開發者啟動 Claude Code
    │
    ▼
┌─ FLOW ─────────────────────────────────────┐
│  SessionStart: pipeline-init（環境偵測+規則）│
│  /flow:plan → /flow:architect → developer   │
│  suggest-compact · checkpoint · cancel      │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ PATTERNS ──────────────────────────────────┐
│  8 個純知識 skills（無 hooks/agents）         │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ SENTINEL ──────────────────────────────────┐
│  自動: auto-lint · auto-format · test-check │
│  手動: review · security · tdd · e2e · verify│
│  攔截: danger-guard · console-log-check     │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ EVOLVE ────────────────────────────────────┐
│  /evolve:evolve（知識進化）                   │
│  /evolve:doc-sync（文件同步）                 │
│  agent: doc-updater                         │
└─────────────────────┬───────────────────────┘
                      ▼
                   完成

  ┌─ COLLAB ──── 任意階段可插入（需 Agent Teams）┐
  │  adversarial-plan · review · refactor       │
  └─────────────────────────────────────────────┘

  ┌─ claude-mem ──── 獨立 plugin，推薦搭配 ─────┐
  │  自動: 觀察捕獲 · session 摘要 · context 注入│
  └─────────────────────────────────────────────┘
\`\`\`

---

## 2. 自動 vs 手動

\`\`\`
自動觸發（Hooks，使用者無感）            手動觸發（Skills，使用者主動）
─────────────────────────            ─────────────────────────────
FLOW     SessionStart: pipeline-init  /flow:plan       功能規劃
FLOW     PreToolUse: suggest-compact  /flow:architect  架構設計
FLOW     PreCompact: log-compact      /flow:compact    手動壓縮
FLOW     SubagentStop: stage-trans.   /flow:checkpoint 建立檢查點
FLOW     Stop: pipeline-check         /flow:env-detect 環境偵測
FLOW     Stop: task-guard             /flow:cancel     取消鎖定
SENTINEL PostToolUse: auto-lint       /sentinel:review  深度審查
SENTINEL PostToolUse: auto-format     /sentinel:security 安全掃描
SENTINEL PostToolUse: test-check      /sentinel:tdd     TDD 工作流
SENTINEL PreToolUse: danger-guard     /sentinel:e2e     E2E 測試
SENTINEL Stop: console-log-check      /sentinel:coverage 覆蓋率
COLLAB   SessionStart: team-init      /sentinel:lint    手動 lint
                                      /sentinel:format  手動格式化
                                      /sentinel:verify  綜合驗證
                                      /evolve:evolve    知識進化
                                      /evolve:doc-sync  文件同步
                                      /collab:adversarial-plan  競爭規劃
                                      /collab:adversarial-review 對抗審查
                                      /collab:adversarial-refactor 競爭重構

自動: ${totalHooks} hooks                         手動: ${dynamicSkills} skills（+ patterns ${patternsSkills} 知識 skills）
跨 session 記憶：claude-mem（獨立 plugin，非依賴）
\`\`\`

---

## 3. 依賴關係圖

\`\`\`
┌─────────────────────────────────────────────────────────┐
│                    獨立（可單獨安裝）                      │
│    ┌────────────┐    ┌────────────┐                     │
│    │  patterns  │    │ claude-mem │                     │
│    │  純知識庫   │    │  記憶持久化 │                     │
│    └────────────┘    └────────────┘                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 核心雙引擎（建議一起安裝）                  │
│    ┌────────────┐    ┌────────────┐                     │
│    │    flow    │    │  sentinel  │                     │
│    └────────────┘    └────────────┘                     │
│          │                  │                           │
│          └──────┬───────────┘                           │
│                 │ 可選增強                               │
│          ┌──────▼───────┐                               │
│          │   evolve     │                               │
│          └──────────────┘                               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 進階（需 Agent Teams）                    │
│    ┌────────────┐                                       │
│    │   collab   │  需 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS │
│    └────────────┘                                       │
└─────────────────────────────────────────────────────────┘
\`\`\`

---

## 4. 建構順序

| Phase | Plugin | 前置條件 | 組件數 |
|:-----:|--------|---------|:------:|
${buildRows}

> **flow 先於 sentinel**：規劃 → 寫碼 → 品質檢查，符合自然開發流程。

---

## 5. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
${fileRows}

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 6. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | ${pluginCount} | forge ✅ + ${newCount} 新 |
| **Skills** | ${totalSkills} | ${dynamicSkills} 動態能力 + ${patternsSkills} 知識庫（patterns） |
| **Agents** | ${totalAgents} | 跨 ${pluginEntries.filter(([, s]) => s.expected.agents.length > 0).length} 個 plugins |
| **Hooks** | ${totalHooks} | 自動觸發 |
| **Scripts** | ${totalScripts} | hook 腳本 + 共用函式庫 |
| **合計** | ${totalAll} | 跨 ${pluginCount} 個獨立安裝的 plugins |
`;
}

// ─── 主流程 ────────────────────────────────────

function main() {
  // index.md 只需要 specs（不需要 progress）
  if (fs.existsSync(SPECS_PATH)) {
    const specs = loadJSON(SPECS_PATH);
    fs.writeFileSync(INDEX_PATH, generateIndex(specs));
    console.log(`Index 已更新：docs/ref/index.md`);
  }

  // dashboard 需要 specs + progress
  for (const p of [SPECS_PATH, PROGRESS_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`找不到 ${path.basename(p)}（跳過 dashboard）`);
      return;
    }
  }
  const specs = loadJSON(SPECS_PATH);
  const progress = loadJSON(PROGRESS_PATH);
  fs.writeFileSync(OUTPUT_PATH, generate(specs, progress));
  console.log(`Dashboard 已更新：docs/dashboard.html`);
}

main();
