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

function genFlowDiagram() {
  return `
  <div class="flow">
    <div class="flow-box endpoint"><span class="flow-label" style="color:var(--text-muted)">開始</span>開發者啟動 Claude Code</div>
    <div class="flow-arrow">▼</div>
    <div class="flow-box core">
      <span class="flow-label">FLOW</span>
      <div class="flow-desc">① 載入前次 context + 環境偵測 <span class="badge badge-auto">auto</span></div>
      <div class="flow-desc">② 規劃 → 架構 → context 管理 <span class="badge badge-manual">manual</span></div>
      <div class="flow-steps">
        <span class="flow-step auto">SessionStart: load-context</span>
        <span class="flow-step manual">/flow:plan</span>
        <span class="flow-step manual">/flow:architect</span>
        <span class="flow-step manual">/flow:compact</span>
        <span class="flow-step auto">suggest-compact (50 calls)</span>
      </div>
    </div>
    <div class="flow-arrow">▼</div>
    <div class="flow-box knowledge">
      <span class="flow-label">PATTERNS</span>
      <div class="flow-desc">Claude 寫碼時自動參考 — 8 個純知識 skills</div>
      <div class="flow-steps">
        <span class="flow-step manual">coding-standards</span>
        <span class="flow-step manual">frontend</span>
        <span class="flow-step manual">backend</span>
        <span class="flow-step manual">typescript</span>
        <span class="flow-step manual">python</span>
        <span class="flow-step manual">go</span>
        <span class="flow-step manual">db</span>
        <span class="flow-step manual">testing</span>
      </div>
    </div>
    <div class="flow-arrow">▼ Write / Edit</div>
    <div class="flow-box core">
      <span class="flow-label">SENTINEL</span>
      <div class="flow-desc">③ 自動品質守衛 <span class="badge badge-auto">auto</span></div>
      <div class="flow-steps">
        <span class="flow-step auto">auto-lint</span>
        <span class="flow-step auto">auto-format</span>
        <span class="flow-step auto">test-check</span>
        <span class="flow-step auto">danger-guard</span>
        <span class="flow-step auto">console-log-check</span>
      </div>
      <div class="flow-desc" style="margin-top:0.5rem">④ 測試 + 審查 <span class="badge badge-manual">manual</span></div>
      <div class="flow-steps">
        <span class="flow-step manual">/sentinel:tdd</span>
        <span class="flow-step manual">/sentinel:verify</span>
        <span class="flow-step manual">/sentinel:review</span>
        <span class="flow-step manual">/sentinel:security</span>
        <span class="flow-step manual">/sentinel:e2e</span>
        <span class="flow-step manual">/sentinel:coverage</span>
      </div>
    </div>
    <div class="flow-arrow">▼</div>
    <div class="flow-box advanced">
      <span class="flow-label">EVOLVE</span>
      <div class="flow-desc">⑤ 文件同步 + 知識提取</div>
      <div class="flow-steps">
        <span class="flow-step manual">/evolve:doc-gen</span>
        <span class="flow-step manual">/evolve:doc-sync</span>
        <span class="flow-step auto">evaluate-session</span>
        <span class="flow-step manual">/evolve:learn</span>
        <span class="flow-step manual">/evolve:evolve</span>
      </div>
    </div>
    <div class="flow-arrow">▼</div>
    <div class="flow-box core">
      <span class="flow-label">FLOW</span>
      <div class="flow-desc">⑥ 儲存 session context <span class="badge badge-auto">auto</span></div>
      <div class="flow-steps">
        <span class="flow-step auto">SessionEnd: save-context</span>
        <span class="flow-step manual">/flow:checkpoint</span>
      </div>
    </div>
    <div class="flow-arrow">▼</div>
    <div class="flow-box endpoint"><span class="flow-label" style="color:var(--text-muted)">結束</span>Session 結束</div>
  </div>
  <div class="flow-box external" style="max-width:720px;margin:1rem auto">
    <span class="flow-label">COLLAB</span>
    <div class="flow-desc">任意階段可插入 — Agent Teams 驅動的多視角對抗式分析</div>
    <div class="flow-steps">
      <span class="flow-step manual">/collab:adversarial-plan</span>
      <span class="flow-step manual">/collab:adversarial-review</span>
      <span class="flow-step manual">/collab:adversarial-refactor</span>
    </div>
  </div>`;
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

// ─── 主流程 ────────────────────────────────────

function main() {
  for (const p of [SPECS_PATH, PROGRESS_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`找不到 ${path.basename(p)}`);
      process.exit(1);
    }
  }
  const specs = loadJSON(SPECS_PATH);
  const progress = loadJSON(PROGRESS_PATH);
  fs.writeFileSync(OUTPUT_PATH, generate(specs, progress));
  console.log(`Dashboard 已更新：docs/dashboard.html`);
}

main();
