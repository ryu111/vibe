/**
 * _base.css.js — 基礎 CSS（去除色彩值，使用 var() 引用）
 *
 * 此檔案從 generate.js 提取基礎 CSS，將所有 Tokyo Night 色彩硬編碼值
 * 替換為 CSS 變數引用（var(--xxx)），使主題可替換。
 */
'use strict';

/**
 * 取得基礎 CSS（不含 :root 色彩定義）
 * @returns {string} 基礎 CSS 字串
 */
function getBaseCSS() {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.5; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1.3rem; color: var(--accent); margin: 2.5rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  .subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.8rem; }
  .timestamp { color: var(--text-muted); font-size: 0.75rem; margin-bottom: 1.5rem; }

  /* 整體進度條 */
  .overall-progress { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem 1.5rem; margin-bottom: 1.5rem; box-shadow: var(--card-shadow); }
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
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.8rem 1.2rem; flex: 1; min-width: 100px; box-shadow: var(--card-shadow); }
  .stat-value { font-size: 1.5rem; font-weight: 700; }
  .stat-expected { font-size: 0.85rem; color: var(--text-muted); }
  .stat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

  /* 建構順序 */
  .build-order { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; margin: 1rem 0; }
  .build-phase { flex: 1; min-width: 120px; padding: 0.8rem; border: 2px solid var(--border); background: var(--surface); text-align: center; position: relative; }
  .build-phase:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  .build-phase:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
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
  .flow-box { width: 100%; max-width: 720px; border: 2px solid var(--border); border-radius: var(--radius); padding: 1rem 1.2rem; background: var(--surface); position: relative; box-shadow: var(--card-shadow); }
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
  .flow-step { font-size: 0.78rem; padding: 0.15rem 0.55rem; border-radius: 4px; background: var(--text-05); }
  .flow-step.auto { border-left: 3px solid var(--green); }
  .flow-step.manual { border-left: 3px solid var(--accent); }
  .badge { display: inline-block; font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 3px; margin-left: 0.5rem; vertical-align: middle; }
  .badge-auto { background: var(--green-15); color: var(--green); }
  .badge-manual { background: var(--accent-15); color: var(--accent); }

  /* Plugin 卡片 */
  .plugins { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.2rem; margin-top: 1rem; }
  .plugin-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem; transition: border-color 0.2s; box-shadow: var(--card-shadow); }
  .plugin-card:hover { border-color: var(--border-highlight); }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; }
  .card-header h3 { font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem; }
  .card-desc { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.8rem; }
  .status-badge { font-size: 0.7rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600; }
  .status-complete { background: var(--green-15); color: var(--green); }
  .status-in-progress { background: var(--yellow-10); color: var(--yellow); }
  .status-planned { background: var(--text-muted-12); color: var(--text-muted); }

  /* 組件格 */
  .comp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-bottom: 0.8rem; }
  .comp-cell { text-align: center; padding: 0.5rem 0.2rem; border-radius: 6px; background: var(--text-03); }
  .comp-val { font-size: 0.85rem; font-weight: 700; }
  .comp-lbl { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .comp-bar { height: 3px; background: var(--bg); border-radius: 2px; margin-top: 0.3rem; overflow: hidden; }
  .comp-bar-fill { height: 100%; border-radius: 2px; }

  /* 組件標籤 */
  .tag-list { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; padding: 0.12rem 0.5rem; border-radius: 4px; }
  .tag-skill { background: var(--accent-10); color: var(--accent); }
  .tag-agent { background: var(--purple-10); color: var(--purple); }
  .tag-hook { background: var(--yellow-10); color: var(--yellow); }
  .tag .check { color: var(--green); font-weight: 700; }
  .tag .pending { color: var(--text-muted); opacity: 0.5; }

  /* Agent 工作流 */
  .agent-workflow { display: flex; flex-direction: column; align-items: center; gap: 0; margin: 1rem 0; }
  .agent-phase { width: 100%; max-width: 900px; margin-bottom: 0; }
  .agent-phase-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
  .agent-phase-name { font-size: 0.95rem; font-weight: 700; }
  .agent-phase-desc { font-size: 0.78rem; color: var(--text-muted); }
  .agent-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 0.8rem; }
  .agent-card { background: var(--surface); border: 2px solid var(--border); border-radius: var(--radius); padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; box-shadow: var(--card-shadow); }
  .agent-card-head { display: flex; justify-content: space-between; align-items: center; }
  .agent-card-head h4 { font-size: 0.95rem; display: flex; align-items: center; gap: 0.4rem; }
  .agent-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .agent-perm { font-size: 0.65rem; padding: 0.1rem 0.45rem; border-radius: 3px; font-weight: 600; }
  .agent-perm.readonly { background: var(--accent-12); color: var(--accent); }
  .agent-perm.writable { background: var(--red-12); color: var(--red); }
  .agent-trigger { font-size: 0.78rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.3rem; }
  .agent-trigger code { background: var(--text-06); padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; color: var(--accent); }
  .agent-flow { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; font-size: 0.72rem; color: var(--text-muted); }
  .agent-flow-step { padding: 0.1rem 0.4rem; border-radius: 3px; background: var(--text-04); }
  .agent-flow .arrow { color: var(--text-muted); opacity: 0.5; }
  .agent-tools { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .agent-tool { font-size: 0.65rem; padding: 0.08rem 0.35rem; border-radius: 3px; background: var(--text-05); color: var(--text-muted); }
  .agent-model { font-size: 0.65rem; color: var(--text-muted); opacity: 0.7; }
  .agent-connector { display: flex; flex-direction: column; align-items: center; padding: 0.6rem 0; color: var(--text-muted); }
  .agent-connector-arrow { font-size: 1.3rem; line-height: 1; }
  .agent-connector-label { font-size: 0.75rem; padding: 0.15rem 0.7rem; border-radius: 4px; background: var(--text-04); border: 1px dashed var(--border); }
  .agent-human { width: 100%; max-width: 900px; margin: 0.3rem 0; padding: 0.7rem 1rem; border: 2px solid var(--yellow); border-radius: var(--radius); background: var(--yellow-06); display: flex; align-items: center; gap: 0.8rem; }
  .agent-human-icon { font-size: 1.3rem; flex-shrink: 0; }
  .agent-human-text { font-size: 0.85rem; }
  .agent-human-text strong { color: var(--yellow); }
  .agent-human-detail { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem; }

  /* Agent 詳細流程 Pipeline */
  .pipe { display: flex; flex-direction: column; gap: 0; margin: 1rem 0; }
  .pipe-header { display: flex; align-items: center; gap: 0; flex-wrap: wrap; margin-bottom: 1.5rem; justify-content: center; }
  .pipe-hstage { padding: 0.4rem 1rem; font-size: 0.8rem; font-weight: 700; border-radius: 6px; background: var(--surface); border: 2px solid var(--border); text-transform: uppercase; letter-spacing: 0.06em; }
  .pipe-harrow { color: var(--text-muted); font-size: 1.2rem; padding: 0 0.3rem; }
  .pipe-stage { width: 100%; max-width: 780px; margin: 0 auto 0.5rem; display: flex; gap: 1.2rem; align-items: flex-start; border: 2px solid var(--border); border-radius: var(--radius); padding: 1.2rem; background: var(--surface); box-shadow: var(--card-shadow); }
  .pipe-stage-side { flex-shrink: 0; width: 64px; text-align: center; padding-top: 0.2rem; }
  .pipe-stage-num { display: block; font-size: 1.5rem; font-weight: 800; opacity: 0.15; line-height: 1; }
  .pipe-stage-label { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 0.2rem; }
  .pipe-stage-body { flex: 1; min-width: 0; }
  .pipe-agents { display: flex; flex-direction: column; gap: 0.6rem; }
  .pipe-agents-parallel { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.6rem; }
  .pipe-agents-seq-arrow { display: flex; justify-content: center; padding: 0.15rem 0; color: var(--text-muted); font-size: 0.7rem; opacity: 0.6; }
  .pipe-agents-par-label { text-align: center; font-size: 0.65rem; color: var(--purple); font-weight: 600; padding: 0.15rem 0; opacity: 0.7; }
  .pipe-agent { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.8rem; background: var(--text-02); }
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
  .pipe-main-agent { width: 100%; max-width: 780px; margin: 0 auto 0.5rem; display: flex; gap: 1rem; align-items: center; border: 2px solid var(--accent); border-radius: var(--radius); padding: 0.8rem 1.2rem; background: var(--accent-06); box-shadow: var(--card-shadow); }
  .pipe-main-agent-icon { font-size: 1.3rem; flex-shrink: 0; }
  .pipe-main-agent-title { font-weight: 700; color: var(--accent); font-size: 0.9rem; }
  .pipe-main-agent-detail { font-size: 0.75rem; color: var(--text-muted); }

  /* Stop Hook 防護層 */
  .guard-section-title { font-size: 0.82rem; font-weight: 700; color: var(--text-muted); text-align: center; margin: 1.2rem 0 0.6rem; text-transform: uppercase; letter-spacing: 0.1em; }
  .guard-layer { display: flex; gap: 1rem; max-width: 720px; margin: 0 auto; }
  .guard-card { flex: 1; border-radius: var(--radius); padding: 0.9rem 1rem; box-shadow: var(--card-shadow); }
  .guard-card.guide { border: 2px solid var(--cyan); background: var(--cyan-06); }
  .guard-card.block { border: 2px solid var(--red); background: var(--red-06); }
  .guard-title { font-size: 0.88rem; font-weight: 700; margin-bottom: 0.3rem; display: flex; align-items: center; gap: 0.4rem; }
  .guard-card.guide .guard-title { color: var(--cyan); }
  .guard-card.block .guard-title { color: var(--red); }
  .guard-hook { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 0.4rem; }
  .guard-hook code { background: var(--text-06); padding: 0.08rem 0.35rem; border-radius: 3px; font-size: 0.7rem; }
  .guard-desc { font-size: 0.78rem; color: var(--text-muted); }
  .guard-mechanism { display: inline-block; font-size: 0.68rem; padding: 0.12rem 0.45rem; border-radius: 3px; font-weight: 600; margin-top: 0.4rem; }
  .guard-card.guide .guard-mechanism { background: var(--cyan-15); color: var(--cyan); }
  .guard-card.block .guard-mechanism { background: var(--red-15); color: var(--red); }
  .guard-wrapper { border: 2px dashed var(--border); border-radius: calc(var(--radius) + 4px); padding: 1rem 1.2rem; margin: 0.5rem auto; max-width: 780px; position: relative; }
  .guard-wrapper-label { position: absolute; top: -0.7rem; right: 1rem; background: var(--bg); padding: 0 0.5rem; font-size: 0.72rem; font-weight: 700; color: var(--text-muted); letter-spacing: 0.05em; }

  /* 折疊面板 */
  details { margin: 2rem 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); box-shadow: var(--card-shadow); }
  summary { cursor: pointer; padding: 1rem 1.5rem; font-size: 1.3rem; font-weight: 600; color: var(--accent); background: var(--surface2); border-bottom: 1px solid var(--border); transition: background 0.2s, border-color 0.2s; user-select: none; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▸ '; display: inline-block; transition: transform 0.2s; margin-right: 0.5rem; }
  details[open] summary::before { transform: rotate(90deg); }
  summary:hover { background: var(--surface); border-bottom-color: var(--border-highlight); }
  details > div { padding: 1.5rem; }

  /* 精簡進度列 */
  .compact-progress { display: flex; align-items: center; gap: 1rem; padding: 0.8rem 1.2rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1.5rem; box-shadow: var(--card-shadow); }
  .compact-progress-label { font-size: 0.85rem; font-weight: 600; white-space: nowrap; }
  .compact-progress-bar { flex: 1; min-width: 200px; height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; }
  .compact-progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .compact-progress-pct { font-size: 1.2rem; font-weight: 700; color: var(--accent); min-width: 60px; text-align: right; }
  .compact-progress-count { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; }

  /* TOC 導航 */
  .toc { position: fixed; top: 6rem; left: 2rem; width: 220px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; box-shadow: var(--card-shadow); z-index: 10; max-height: calc(100vh - 8rem); overflow-y: auto; }
  .toc-title { font-size: 0.85rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.8rem; }
  .toc a { display: block; padding: 0.4rem 0.6rem; font-size: 0.82rem; color: var(--text); text-decoration: none; border-radius: 4px; transition: background 0.2s, color 0.2s; }
  .toc a:hover { background: var(--surface2); color: var(--accent); }
  .toc a.active { background: var(--surface2); color: var(--accent); border-left: 3px solid var(--accent); }

  /* 色板 */
  .color-palette { display: flex; flex-wrap: wrap; gap: 0.8rem; margin: 1rem 0; }
  .color-swatch { text-align: center; min-width: 80px; }
  .color-swatch-box { width: 80px; height: 50px; border-radius: var(--radius); margin-bottom: 0.4rem; border: 1px solid var(--border); box-shadow: var(--card-shadow); }
  .color-swatch-name { font-size: 0.7rem; color: var(--text-muted); font-weight: 600; }
  .color-swatch-hex { font-size: 0.65rem; color: var(--text-muted); font-family: monospace; margin-top: 0.2rem; }

  /* 響應式 */
  @media (max-width: 639px) {
    body { padding: 1rem; }
    .toc { display: none; }
    .pipe-header { flex-direction: column; align-items: stretch; gap: 0.5rem; }
    .pipe-hstage { text-align: center; }
    .pipe-harrow { transform: rotate(90deg); text-align: center; }
    .agent-cards { grid-template-columns: 1fr; }
    .guard-layer { flex-direction: column; }
  }
  @media (min-width: 640px) and (max-width: 1023px) {
    .toc { display: none; }
    .agent-cards { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  }
  @media (min-width: 1024px) {
    body { padding-left: 280px; }
    .agent-cards { grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
  }

  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.78rem; text-align: center; }
`;
}

module.exports = { getBaseCSS };
