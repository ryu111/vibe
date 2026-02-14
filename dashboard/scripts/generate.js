#!/usr/bin/env node
/**
 * generate-dashboard.js — 從 plugin-specs.json + progress.json 產生 dashboard.html
 *
 * 用途：SessionEnd hook 在 scan-progress.js 之後執行
 * 產出：dashboard/dashboard.html（自包含、深色主題、進度視覺化）
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SPECS_PATH = path.join(ROOT, 'docs', 'plugin-specs.json');
const PROGRESS_PATH = path.join(ROOT, 'dashboard', 'data', 'progress.json');
const CONFIG_PATH = path.join(ROOT, 'dashboard', 'config.json');
const META_PATH = path.join(ROOT, 'dashboard', 'data', 'meta.json');
const OUTPUT_PATH = path.join(ROOT, 'dashboard', 'dashboard.html');
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
    --red: #f85149; --purple: #bc8cff; --orange: #f0883e; --cyan: #39d2c0; --pink: #f778ba;
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

// ─── 資料驅動輔助函式 ────────────────────────

// agent color name（meta.json）→ CSS variable 映射
const COLOR_MAP = {
  red: 'var(--red)', blue: 'var(--accent)', green: 'var(--green)',
  yellow: 'var(--yellow)', purple: 'var(--purple)', orange: 'var(--orange)',
  pink: 'var(--pink)', cyan: 'var(--cyan)',
};

function agentColor(name, meta) {
  const ag = meta && meta.agents && meta.agents[name];
  if (ag && ag.color && COLOR_MAP[ag.color]) return COLOR_MAP[ag.color];
  return 'var(--border)';
}

function agentEmoji(name, meta) {
  const ag = meta && meta.agents && meta.agents[name];
  return (ag && ag.emoji) || '';
}

// stage → 主 agent → agent color
function stageColor(stage, meta) {
  const prov = meta && meta.pipeline && meta.pipeline.stageProviders && meta.pipeline.stageProviders[stage];
  if (prov && prov.agent) return agentColor(prov.agent, meta);
  return 'var(--border)';
}

const colorToRgba = {
  'var(--yellow)': 'rgba(210,153,34,0.04)',
  'var(--cyan)': 'rgba(57,210,192,0.04)',
  'var(--green)': 'rgba(63,185,80,0.04)',
  'var(--accent)': 'rgba(88,166,255,0.04)',
  'var(--purple)': 'rgba(137,87,229,0.06)',
  'var(--red)': 'rgba(248,81,73,0.04)',
  'var(--orange)': 'rgba(240,136,62,0.04)',
  'var(--pink)': 'rgba(247,120,186,0.04)',
  'var(--text-muted)': 'rgba(255,255,255,0.02)',
};

function buildFlowAgent(name, config, meta) {
  const wf = config.agentWorkflows[name];
  const ag = meta.agents[name];
  if (!wf || !ag) return null;
  const isPlan = ag.permissionMode === 'plan' || ag.permissionMode === 'default';
  let trigger = wf.trigger;
  if (!trigger) {
    for (const [, prov] of Object.entries(meta.pipeline.stageProviders)) {
      if (prov.agent === name && prov.skill) { trigger = prov.skill; break; }
    }
  }
  if (!trigger) trigger = '自動（Main Agent 委派）';
  return {
    name,
    color: agentColor(name, meta),
    emoji: agentEmoji(name, meta),
    perm: isPlan ? 'readonly' : 'writable',
    permLabel: isPlan ? '唯讀' : '可寫',
    trigger,
    model: isPlan ? `${ag.model} · plan mode` : `${ag.model} · ${ag.permissionMode} · ${ag.maxTurns}t`,
    tools: ag.tools,
    flow: wf.flowSteps,
  };
}

function buildDetailAgent(name, config, meta) {
  const wf = config.agentWorkflows[name];
  const ag = meta.agents[name];
  if (!wf || !ag) return null;
  const isPlan = ag.permissionMode === 'plan' || ag.permissionMode === 'default';
  return {
    name,
    color: agentColor(name, meta),
    emoji: agentEmoji(name, meta),
    perm: isPlan ? '唯讀' : '可寫',
    permClass: isPlan ? 'readonly' : 'writable',
    model: ag.model,
    mode: ag.permissionMode,
    maxTurns: isPlan ? undefined : ag.maxTurns,
    nodes: wf.detailedNodes,
  };
}

function genFlowDiagram(config, meta) {
  // 從 config + meta 建構階段資料
  const phases = config.flowPhases.map(phase => ({
    name: phase.name,
    color: phase.color,
    desc: phase.desc,
    agents: phase.agentNames.map(n => buildFlowAgent(n, config, meta)).filter(Boolean),
    extraSteps: phase.extraSteps,
  }));

  const transitions = config.flowTransitions.map(t => ({
    type: 'connector',
    arrow: t.arrow,
    label: t.label,
  }));

  function renderAgent(a) {
    const flowSteps = a.flow.map((s, i) =>
      (i < a.flow.length - 1)
        ? `<span class="agent-flow-step">${s}</span><span class="arrow">→</span>`
        : `<span class="agent-flow-step">${s}</span>`
    ).join('');
    const toolTags = a.tools.map(t => `<span class="agent-tool">${t}</span>`).join('');
    const emojiPrefix = a.emoji ? `${a.emoji} ` : '';
    return `
        <div class="agent-card" style="border-color:${a.color}">
          <div class="agent-card-head">
            <h4><span class="agent-dot" style="background:${a.color}"></span>${emojiPrefix}${a.name}</h4>
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

  // 任務類型路由表（從 config 讀取）
  const taskRoutes = config.taskRoutes;

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

    // 補充層：insertAfter 或過渡箭頭
    const insertLayer = config.supplementaryLayers.find(l => l.insertAfter === phase.name);
    if (insertLayer) {
      const bg = colorToRgba[insertLayer.color] || 'rgba(255,255,255,0.02)';
      parts.push(`
    <div class="agent-connector">
      <div class="agent-connector-arrow">▼</div>
      <div class="agent-connector-label">${insertLayer.connectorLabel}</div>
    </div>`);
      parts.push(`
    <div class="agent-human" style="border-color:${insertLayer.color};border-style:${insertLayer.borderStyle};background:${bg}">
      <div class="agent-human-icon">${insertLayer.icon}</div>
      <div>
        <div class="agent-human-text"><strong style="color:${insertLayer.color}">${insertLayer.title}</strong> <span style="opacity:0.6;font-size:0.75rem">${insertLayer.subtitle}</span></div>
        <div class="agent-human-detail">${insertLayer.detail}</div>
      </div>
    </div>`);
    } else if (i < phases.length - 1) {
      parts.push(renderTransition(transitions[i]));
    }
  });

  // 守衛層（從 config 讀取）
  parts.push(`<div class="agent-connector"><div class="agent-connector-arrow">▼</div></div>`);
  const guardCards = Object.entries(config.guards).map(([, g]) => {
    const hookHtml = g.hooks.map(h => {
      const hp = h.split(' ');
      return `<code>${hp[0]}</code> ${hp.slice(1).join(' ')}`;
    }).join(' · ');
    return `
      <div class="guard-card ${g.type}">
        <div class="guard-title">${g.icon} ${g.title}</div>
        <div class="guard-hook">${hookHtml}</div>
        <div class="guard-desc">${g.desc}</div>
        <div class="guard-mechanism">${g.mechanism}</div>
      </div>`;
  }).join('');
  parts.push(`
    <div class="guard-section-title">Stop 事件防護 — 全程監控</div>
    <div class="guard-layer">${guardCards}
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

  // 底部補充層（從 config 讀取）
  const bottomLayers = config.supplementaryLayers.filter(l => l.position === 'bottom');
  bottomLayers.forEach((layer, idx) => {
    const bg = colorToRgba[layer.color] || 'rgba(255,255,255,0.02)';
    const margin = idx === 0 ? 'margin-top:1rem' : 'margin-top:0.5rem';
    const opacity = layer.opacity ? `;opacity:${layer.opacity}` : '';
    parts.push(`
    <div class="agent-human" style="border-color:${layer.color};border-style:${layer.borderStyle};background:${bg};${margin}${opacity}">
      <div class="agent-human-icon">${layer.icon}</div>
      <div>
        <div class="agent-human-text"><strong style="color:${layer.color}">${layer.title}</strong> <span style="opacity:0.6;font-size:0.75rem">${layer.subtitle}</span></div>
        <div class="agent-human-detail">${layer.detail}</div>
      </div>
    </div>`);
  });

  return `<div class="agent-workflow">${parts.join('')}</div>`;
}

function genAgentDetails(config, meta) {
  // 從 config + meta 建構 pipeline 階段資料
  const nums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  const stages = meta.pipeline.stages.map((stage, i) => {
    const sc = config.stageConfig[stage] || {};
    const provider = meta.pipeline.stageProviders[stage];
    const agents = [];
    if (provider) agents.push(buildDetailAgent(provider.agent, config, meta));
    if (sc.additionalAgents) {
      for (const name of sc.additionalAgents) {
        agents.push(buildDetailAgent(name, config, meta));
      }
    }
    return {
      num: nums[i],
      label: stage,
      color: stageColor(stage, meta),
      parallel: sc.parallel || false,
      fallback: sc.fallback || null,
      agents: agents.filter(Boolean),
    };
  });

  // 渲染單一節點
  function renderNode(n) {
    if (n.t === 'loop') {
      const inner = n.nodes.map(renderNode).join('');
      return `<div class="pipe-loop"><div class="pipe-loop-label">🔄 ${n.label}</div>${inner}</div>`;
    }
    if (n.t === 'block') {
      return `<div class="pipe-node" style="color:var(--red)"><div class="pipe-node-dot" style="background:var(--red)"></div>
        <div><span class="pipe-node-text" style="color:var(--red)">${n.text}</span> <span class="pipe-node-sub">${n.sub}</span></div></div>`;
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
    const emojiPrefix = a.emoji ? `${a.emoji} ` : '';
    return `<div class="pipe-agent" style="border-color:${a.color}">
      <div class="pipe-agent-head">
        <h5><span class="agent-dot" style="background:${a.color}"></span>${emojiPrefix}${a.name}</h5>
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

  // 任務分類器（從 config 讀取）
  const routeData = config.taskRoutesCompact;
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

  // Stop Hook 雙層防護（從 config 讀取）
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  const gdCards = Object.entries(config.guardsDetailed).map(([key, gd]) => {
    const nodesHtml = gd.nodes.map(n => {
      if (n.t === 'block') {
        return `<div class="pipe-node" style="color:var(--red)"><div class="pipe-node-dot" style="background:var(--red)"></div>
            <div><span class="pipe-node-text" style="color:var(--red)">${n.text}</span> <span class="pipe-node-sub">${n.sub}</span></div></div>`;
      }
      return `<div class="pipe-node ${n.t}"><div class="pipe-node-dot ${n.t}"></div>
            <div><span class="pipe-node-text">${n.text}</span>${n.sub ? ` <span class="pipe-node-sub">${n.sub}</span>` : ''}</div></div>`;
    }).join('\n          ');
    return `
      <div class="guard-card ${key}">
        <div class="guard-title">${gd.title}</div>
        <div class="guard-hook">${gd.hookLabel}</div>
        <div style="margin:0.5rem 0">
          ${nodesHtml}
        </div>
        <div class="guard-mechanism">${gd.mechanism}</div>
      </div>`;
  }).join('');
  parts.push(`<div class="guard-wrapper">
    <div class="guard-wrapper-label">🔒 STOP 事件防護</div>
    <div style="font-size:0.78rem;color:var(--text-muted);text-align:center;margin-bottom:0.8rem">
      Claude 每次嘗試結束回合時觸發 — 兩層機制，意義不同
    </div>
    <div class="guard-layer" style="max-width:none">${gdCards}
    </div>
  </div>`);

  // 完成（從 config 讀取）
  const pc = config.pipelineCompletion;
  parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
  parts.push(`<div class="pipe-main-agent" style="border-color:var(--green);background:rgba(63,185,80,0.04)">
    <div class="pipe-main-agent-icon">${pc.icon}</div>
    <div>
      <div class="pipe-main-agent-title" style="color:var(--green)">${pc.title}</div>
      <div class="pipe-main-agent-detail">${pc.detail}</div>
    </div>
  </div>`);

  return `<div class="pipe">${parts.join('')}</div>`;
}

// ─── 組合 HTML ─────────────────────────────────

function generate(specs, progress) {
  const config = fs.existsSync(CONFIG_PATH) ? loadJSON(CONFIG_PATH) : null;
  const meta = fs.existsSync(META_PATH) ? loadJSON(META_PATH) : null;

  // 動態版號：從 vibe plugin.json 讀取
  const VIBE_PLUGIN_JSON = path.join(ROOT, 'plugins', 'vibe', '.claude-plugin', 'plugin.json');
  const vibeVersion = fs.existsSync(VIBE_PLUGIN_JSON) ? loadJSON(VIBE_PLUGIN_JSON).version : '0.0.0';

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
${genFlowDiagram(config, meta)}

<!-- Agent 詳細流程 -->
<h2>Agent 詳細流程</h2>
${genAgentDetails(config, meta)}

<!-- Plugin 詳情 -->
<h2>Plugin 詳情</h2>
<div class="plugins">
  ${genPluginCards(specs, progress)}
</div>

<div class="footer">
  Vibe Marketplace v${vibeVersion} — ${progress.overall.totalActual}/${progress.overall.totalExpected} 組件完成
  · 由 <code>dashboard/scripts/generate.js</code> 自動產生
</div>

</body>
</html>
`;
}

// ─── index.md 自動生成 ────────────────────────

function generateIndex(specs) {
  const pluginEntries = Object.entries(specs.plugins)
    .sort((a, b) => a[1].buildOrder - b[1].buildOrder);

  let totalSkills = 0, totalAgents = 0, totalHooks = 0, totalScripts = 0;
  for (const [, spec] of pluginEntries) {
    totalSkills += spec.expected.skills.length;
    totalAgents += spec.expected.agents.length;
    totalHooks += spec.expected.hooks;
    totalScripts += spec.expected.scripts;
  }
  const totalAll = totalSkills + totalAgents + totalHooks + totalScripts;
  const pluginCount = pluginEntries.length;

  // 知識庫 skills 計算（vibe 的 8 個 *-patterns + coding-standards）
  const knowledgeSkills = ['coding-standards','frontend-patterns','backend-patterns','db-patterns','typescript-patterns','python-patterns','go-patterns','testing-patterns'];
  const knowledgeCount = knowledgeSkills.length;
  const dynamicSkills = totalSkills - knowledgeCount;

  // §3 建構順序
  const buildRows = pluginEntries.map(([name, spec]) => {
    const e = spec.expected;
    const parts = [];
    if (e.skills.length) parts.push(`${e.skills.length}S`);
    if (e.agents.length) parts.push(`${e.agents.length}A`);
    if (e.hooks) parts.push(`${e.hooks}H`);
    if (e.scripts) parts.push(`${e.scripts}Sc`);
    return `| ${spec.buildOrder + 1} | **${name}** | ${spec.description} | ${parts.join(' + ')} |`;
  }).join('\n');

  // §4 文件索引
  const fileRows = pluginEntries.map(([name, spec], i) => {
    const e = spec.expected;
    return `| ${i + 1} | ${name} | [${name}.md](${name}.md) | ${e.skills.length} | ${e.agents.length} | ${e.hooks} | ${e.scripts} |`;
  }).join('\n');

  return `# Vibe Marketplace — Plugin 設計總覽

> ${pluginCount} 個 plugin（forge + vibe）的總流程、模組架構，以及各文件索引。
>
> **此檔案由 \`dashboard/scripts/generate.js\` 自動產生，請勿手動編輯。**
> 修改來源：\`docs/plugin-specs.json\`（數量）+ \`dashboard/scripts/generate.js\`（結構）

---

## 1. 開發全流程圖

完整視覺化流程圖請見 [dashboard.html](../dashboard.html)。

\`\`\`
使用者提出需求
    │
    ▼
┌─ task-classifier（haiku · UserPromptSubmit）──┐
│  自動分類任務類型 → 建議 pipeline 啟動階段     │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 規劃模組 ────────────────────────────────────┐
│  PLAN: planner（/vibe:scope）                 │
│  ARCH: architect（/vibe:architect）            │
│  pipeline-init · suggest-compact · cancel     │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 知識模組 ────────────────────────────────────┐
│  8 個純知識 skills（coding-standards + 7 語言） │
│  無 hooks/agents — 按需載入                    │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 品質模組 ────────────────────────────────────┐
│  DEV: developer（寫碼 + 自動 lint/format）     │
│  REVIEW: code-reviewer + security-reviewer    │
│  TEST: tester + build-error-resolver          │
│  QA: qa · E2E: e2e-runner                     │
│  danger-guard · check-console-log             │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 進化模組 ────────────────────────────────────┐
│  DOCS: doc-updater（/vibe:doc-sync）          │
│  /vibe:evolve（知識進化）                     │
└─────────────────────┬────────────────────────┘
                      ▼
                   完成

  ┌─ 監控模組 ─ WebSocket 即時儀表板 ────────────┐
  │  SessionStart: 自動啟動 · /vibe:dashboard    │
  └─────────────────────────────────────────────┘

  ┌─ 遠端模組 ─ Telegram 雙向控制 ──────────────┐
  │  進度推播 · 狀態查詢 · 遠端指令 · tmux 控制  │
  └─────────────────────────────────────────────┘
\`\`\`

---

## 2. 自動 vs 手動

\`\`\`
自動觸發（Hooks，使用者無感）              手動觸發（Skills，使用者主動）
──────────────────────────              ──────────────────────────────
SessionStart: pipeline-init             /vibe:scope       功能規劃
SessionStart: dashboard-autostart       /vibe:architect   架構設計
SessionStart: remote-autostart          /vibe:context-status  Context 狀態
UserPromptSubmit: task-classifier       /vibe:checkpoint  建立檢查點
PreToolUse(Task): delegation-tracker    /vibe:env-detect  環境偵測
PreToolUse(Write|Edit): dev-gate        /vibe:cancel      取消鎖定
PreToolUse(*): suggest-compact          /vibe:review      深度審查
PreToolUse(Bash): danger-guard          /vibe:security    安全掃描
PreToolUse(AskUserQuestion): remote-ask /vibe:tdd         TDD 工作流
PostToolUse(Write|Edit): auto-lint      /vibe:e2e         E2E 測試
PostToolUse(Write|Edit): auto-format    /vibe:qa          行為測試
PostToolUse(Write|Edit): test-check     /vibe:coverage    覆蓋率
PreCompact: log-compact                 /vibe:lint        手動 lint
SubagentStop: stage-transition          /vibe:format      手動格式化
SubagentStop: remote-sender             /vibe:verify      綜合驗證
Stop: pipeline-check                    /vibe:evolve      知識進化
Stop: task-guard                        /vibe:doc-sync    文件同步
Stop: check-console-log                 /vibe:dashboard   儀表板控管
Stop: dashboard-refresh                 /remote           遠端控管
Stop: remote-receipt                    /remote-config    遠端設定
UserPromptSubmit: remote-prompt-forward /vibe:hook-diag   Hook 診斷

自動: ${totalHooks} hooks                           手動: ${dynamicSkills} skills（+ ${knowledgeCount} 知識 skills）
跨 session 記憶：claude-mem（獨立 plugin，推薦搭配）
\`\`\`

---

## 3. 建構順序

| Phase | Plugin | 描述 | 組件數 |
|:-----:|--------|------|:------:|
${buildRows}

---

## 4. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
${fileRows}

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 5. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | ${pluginCount} | forge + vibe |
| **Skills** | ${totalSkills} | ${dynamicSkills} 動態能力 + ${knowledgeCount} 知識庫 |
| **Agents** | ${totalAgents} | 全部在 vibe plugin |
| **Hooks** | ${totalHooks} | 自動觸發（21 條規則） |
| **Scripts** | ${totalScripts} | hook 腳本 + 共用函式庫 |
| **合計** | ${totalAll} | 跨 ${pluginCount} 個 plugins |
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
  console.log(`Dashboard 已更新：dashboard/dashboard.html`);
}

main();
