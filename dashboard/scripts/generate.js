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
const VIBE_DOC_PATH = path.join(ROOT, 'docs', 'ref', 'vibe.md');
const THEMES_DIR = path.join(ROOT, 'dashboard', 'themes');

const { generateVibeDoc } = require('./generate-vibe-doc');
const { loadTheme, buildColorToRgba, buildRootCSS } = require(path.join(THEMES_DIR, '_utils'));
const { getBaseCSS } = require(path.join(THEMES_DIR, '_base.css'));

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ─── 主題系統 ─────────────────────────────────

/**
 * 建構最終 CSS（主題化）
 * @param {string} themeName - 主題名稱（預設 tokyo-night）
 * @returns {string} 完整 CSS 字串
 */
function buildFinalCSS(themeName = 'tokyo-night') {
  const theme = loadTheme(themeName, THEMES_DIR);
  const baseCSS = getBaseCSS();
  const rootCSS = buildRootCSS(theme.colors, theme.tokens, theme.tweaks);
  const layoutCSS = theme.layoutCSS || '';
  return `${rootCSS}\n${baseCSS}\n${layoutCSS}`;
}

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

// 動態 colorToRgba — 從主題 colors 自動計算（在 generate() 函式內部初始化）
let colorToRgba = {};

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
    <div class="agent-human" style="border-color:var(--text-muted);background:var(--text-02)">
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
    <div class="agent-human" style="border-color:var(--purple);background:var(--accent-06)">
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
      const bg = colorToRgba[insertLayer.color] || 'var(--text-02)';
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
    <div class="agent-human" style="border-color:var(--green);background:var(--green-06)">
      <div class="agent-human-icon">🚀</div>
      <div>
        <div class="agent-human-text"><strong style="color:var(--green)">完成</strong>程式碼就緒 · 文件同步 · 準備發布</div>
        <div class="agent-human-detail">所有品質檢查通過，文件已更新，task-guard 放行</div>
      </div>
    </div>`);

  // 底部補充層（從 config 讀取）
  const bottomLayers = config.supplementaryLayers.filter(l => l.position === 'bottom');
  bottomLayers.forEach((layer, idx) => {
    const bg = colorToRgba[layer.color] || 'var(--text-02)';
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
  parts.push(`<div style="border:1px dashed var(--purple);border-radius:var(--radius);padding:0.6rem 0.8rem;background:var(--purple-10)">
    <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.4rem">
      <span style="font-size:0.8rem">🏷️</span>
      <span style="font-weight:700;font-size:0.82rem;color:var(--purple)">task-classifier</span>
      <span style="font-size:0.65rem;opacity:0.5">haiku · UserPromptSubmit · 自動</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:0.3rem">${routeChips}</div>
  </div>`);

  // ①②③ 正常渲染（PLAN、ARCH、DESIGN）
  stages.slice(0, 3).forEach((stage, i) => {
    parts.push(`<div class="pipe-connector"><div class="pipe-connector-arrow">▼</div></div>`);
    parts.push(renderStage(stage));
  });

  // ④-⑨ 包在 return zone 裡
  const returnStages = stages.slice(3); // ④ DEV, ⑤ REVIEW, ⑥ TEST, ⑦ QA, ⑧ E2E, ⑨ DOCS
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
  parts.push(`<div class="pipe-main-agent" style="border-color:var(--green);background:var(--green-06)">
    <div class="pipe-main-agent-icon">${pc.icon}</div>
    <div>
      <div class="pipe-main-agent-title" style="color:var(--green)">${pc.title}</div>
      <div class="pipe-main-agent-detail">${pc.detail}</div>
    </div>
  </div>`);

  return `<div class="pipe">${parts.join('')}</div>`;
}

// ─── 輔助函式：折疊面板與導航 ────────────────────

/**
 * 包裹區塊為一致的 section 結構
 * @param {string} id - 區塊 ID（用於 TOC 錨點）
 * @param {string} title - 區塊標題
 * @param {string} content - HTML 內容
 * @param {object} opts - { collapsible: boolean, open: boolean }
 * @returns {string} HTML 字串
 */
function wrapSection(id, title, content, opts = {}) {
  const { collapsible = false, open = false } = opts;
  if (collapsible) {
    return `<details id="${id}"${open ? ' open' : ''}>
  <summary>${title}</summary>
  <div>${content}</div>
</details>`;
  }
  return `<h2 id="${id}">${title}</h2>\n${content}`;
}

/**
 * 生成一行式精簡進度
 * @param {number} pct - 完成百分比
 * @param {object} progress - progress.json 資料
 * @returns {string} HTML 字串
 */
function genCompactProgress(pct, progress) {
  const color = progressColor(pct);
  const fillCls = fillClass(pct);
  return `<div class="compact-progress">
  <span class="compact-progress-label">整體進度</span>
  <div class="compact-progress-bar">
    <div class="compact-progress-fill ${fillCls}" style="width:${pct}%"></div>
  </div>
  <span class="compact-progress-pct" style="color:${color}">${pct}%</span>
  <span class="compact-progress-count">${progress.overall.totalActual} / ${progress.overall.totalExpected}</span>
</div>`;
}

/**
 * 生成 TOC 導航
 * @param {{ id: string, title: string }[]} sections
 * @returns {string} HTML 字串
 */
function genTOC(sections) {
  const links = sections.map(s => `    <a href="#${s.id}">${s.title}</a>`).join('\n');
  return `<nav class="toc">
  <div class="toc-title">目錄</div>
${links}
</nav>`;
}

/**
 * 生成色板預覽（動態從主題 colors 產生）
 * @param {object} themeColors - 主題 colors 物件
 * @returns {string} HTML 字串
 */
function genColorPalette(themeColors) {
  // 色板顯示順序：8 個語意色 + 3 個背景色
  const order = ['accent', 'green', 'yellow', 'red', 'purple', 'orange', 'cyan', 'pink', 'bg', 'surface', 'border'];
  const colors = order
    .filter(name => themeColors[`--${name}`])
    .map(name => ({ name, hex: themeColors[`--${name}`] }));
  return `<div class="color-palette">
${colors.map(c => `  <div class="color-swatch">
    <div class="color-swatch-box" style="background:var(--${c.name})"></div>
    <div class="color-swatch-name">${c.name}</div>
    <div class="color-swatch-hex">${c.hex}</div>
  </div>`).join('\n')}
</div>`;
}

// ─── 組合 HTML ─────────────────────────────────

function generate(specs, progress, themeName = 'tokyo-night') {
  const config = fs.existsSync(CONFIG_PATH) ? loadJSON(CONFIG_PATH) : null;
  const meta = fs.existsSync(META_PATH) ? loadJSON(META_PATH) : null;

  // 載入主題並初始化全域 colorToRgba
  const theme = loadTheme(themeName, THEMES_DIR);
  colorToRgba = buildColorToRgba(theme.colors);
  const finalCSS = buildFinalCSS(themeName);

  // 動態版號：從 vibe plugin.json 讀取
  const VIBE_PLUGIN_JSON = path.join(ROOT, 'plugins', 'vibe', '.claude-plugin', 'plugin.json');
  const vibeVersion = fs.existsSync(VIBE_PLUGIN_JSON) ? loadJSON(VIBE_PLUGIN_JSON).version : '0.0.0';

  const ts = new Date(progress.timestamp).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const pct = progress.overall.completion;

  // 定義 sections（用於 TOC）
  const sections = [
    { id: 'progress', title: '整體進度' },
    { id: 'pipeline-flow', title: '開發流程' },
    { id: 'agent-details', title: 'Agent 詳細流程' },
    { id: 'build-order', title: '建構順序' },
    { id: 'stats', title: '組件統計' },
    { id: 'plugins', title: 'Plugin 詳情' },
    { id: 'color-palette', title: '色板' },
  ];

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vibe Marketplace — Dashboard</title>
<style>${finalCSS}</style>
</head>
<body>

${genTOC(sections)}

<h1>Vibe Marketplace</h1>
<p class="subtitle">Claude Code Plugin Marketplace — 全端開發者的 AI 工具箱</p>
<p class="timestamp">最後更新：${ts}</p>

<!-- 精簡進度 -->
<div id="progress">
${genCompactProgress(pct, progress)}
</div>

<!-- 開發流程 -->
${wrapSection('pipeline-flow', '開發流程', genFlowDiagram(config, meta))}

<!-- Agent 詳細流程 -->
${wrapSection('agent-details', 'Agent 詳細流程', genAgentDetails(config, meta), { collapsible: true })}

<!-- 建構順序 -->
${wrapSection('build-order', '建構順序', `<div class="build-order">${genBuildOrder(specs, progress)}</div>`, { collapsible: true })}

<!-- 統計 -->
${wrapSection('stats', '組件統計', `<div class="stats">${genStats(specs, progress)}</div>`, { collapsible: true })}

<!-- Plugin 詳情 -->
${wrapSection('plugins', 'Plugin 詳情', `<div class="plugins">${genPluginCards(specs, progress)}</div>`, { collapsible: true })}

<!-- 色板 -->
${wrapSection('color-palette', '色板', genColorPalette(theme.colors), { collapsible: true })}

<div class="footer">
  Vibe Marketplace v${vibeVersion} — ${progress.overall.totalActual}/${progress.overall.totalExpected} 組件完成
  · 由 <code>dashboard/scripts/generate.js</code> 自動產生
</div>

<script>
// TOC active 高亮：IntersectionObserver 追蹤各 section 可見性
(function() {
  const tocLinks = document.querySelectorAll('.toc a');
  if (!tocLinks.length) return;
  const ids = Array.from(tocLinks).map(a => a.getAttribute('href').slice(1));
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        tocLinks.forEach(a => a.classList.remove('active'));
        const active = document.querySelector('.toc a[href="#' + entry.target.id + '"]');
        if (active) active.classList.add('active');
      }
    });
  }, { rootMargin: '-10% 0px -80% 0px' });
  ids.forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el); });
})();
</script>
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
PreToolUse(W|E|Ask|EPM): pipeline-guard  /vibe:cancel      取消鎖定
PreToolUse(*): suggest-compact          /vibe:security    安全掃描
PreToolUse(Bash): danger-guard          /vibe:tdd         TDD 工作流
PreToolUse(AskUserQuestion): remote-ask /vibe:e2e         E2E 測試
PostToolUse(Write|Edit): auto-lint      /vibe:qa          行為測試
PostToolUse(Write|Edit): auto-format    /vibe:coverage    覆蓋率
PostToolUse(Write|Edit): test-check     /vibe:lint        手動 lint
PreCompact: log-compact                 /vibe:format      手動格式化
SubagentStop: stage-transition          /vibe:verify      綜合驗證
SubagentStop: remote-sender             /vibe:evolve      知識進化
Stop: pipeline-check                    /vibe:doc-sync    文件同步
Stop: task-guard                        /vibe:dashboard   儀表板控管
Stop: check-console-log                 /remote           遠端控管
Stop: dashboard-refresh                 /remote-config    遠端設定
Stop: remote-receipt                    /vibe:hook-diag   Hook 診斷
UserPromptSubmit: remote-prompt-forward

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
| **Hooks** | ${totalHooks} | 自動觸發 |
| **Scripts** | ${totalScripts} | hook 腳本 + 共用函式庫 |
| **合計** | ${totalAll} | 跨 ${pluginCount} 個 plugins |
`;
}

// ─── CLI 參數解析 ──────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { theme: 'tokyo-night', output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--theme' && args[i + 1]) {
      opts.theme = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.output = args[i + 1];
      i++;
    }
  }
  return opts;
}

// ─── 主流程 ────────────────────────────────────

function main() {
  const { theme: themeName, output: customOutput } = parseArgs();

  // index.md 只需要 specs（不需要 progress）
  if (fs.existsSync(SPECS_PATH)) {
    const specs = loadJSON(SPECS_PATH);
    fs.writeFileSync(INDEX_PATH, generateIndex(specs));

    // vibe.md 需要 specs + meta
    if (fs.existsSync(META_PATH)) {
      fs.writeFileSync(VIBE_DOC_PATH, generateVibeDoc(specs, META_PATH));
    }
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
  const outputPath = customOutput ? path.resolve(customOutput) : OUTPUT_PATH;
  fs.writeFileSync(outputPath, generate(specs, progress, themeName));
  console.log(`✅ Dashboard 已產生（主題：${themeName}）：${outputPath}`);
}

main();
