// DAG 流程圖組件（含佈局演算法和邊線計算）
import { html, useState, useMemo } from '../lib/preact.js';
import { fmtSec } from '../lib/utils.js';
import { getStageStatus, getStageVerdict, getStageSeverity, getStageDuration } from '../state/pipeline.js';
import { BarrierDisplay } from './barrier-display.js';

// DAG 節點佈局常數
const NODE_W = 88;
const NODE_H = 72;
const H_GAP = 40;
const V_GAP = 20;
const PADDING = 24;

/**
 * 根據 deps 計算拓撲排序深度，同深度垂直排列
 * @param {object} dag DAG 結構
 * @param {number} containerWidth 容器寬度
 * @returns {{ nodes: object[], width: number, height: number }}
 */
export function computeDagLayout(dag, containerWidth) {
  if (!dag || !Object.keys(dag).length) return { nodes: [], width: 0, height: 0 };
  const stages = Object.keys(dag);
  // 計算每個 stage 的深度（最長路徑）
  const depth = {};
  function getDepth(id) {
    if (depth[id] !== undefined) return depth[id];
    const deps = dag[id]?.deps || [];
    if (!deps.length) { depth[id] = 0; return 0; }
    const d = Math.max(...deps.map(getDepth)) + 1;
    depth[id] = d;
    return d;
  }
  stages.forEach(id => getDepth(id));

  // 按深度分組
  const byDepth = {};
  stages.forEach(id => {
    const d = depth[id];
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(id);
  });

  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));
  const totalW = (maxDepth + 1) * (NODE_W + H_GAP) - H_GAP;

  const nodes = [];
  Object.entries(byDepth).forEach(([d, ids]) => {
    ids.forEach((id, i) => {
      const x = Number(d) * (NODE_W + H_GAP);
      const y = i * (NODE_H + V_GAP);
      nodes.push({ id, x, y, w: NODE_W, h: NODE_H, depth: Number(d) });
    });
  });

  const totalH = Math.max(...Object.values(byDepth).map(ids => ids.length)) * (NODE_H + V_GAP) - V_GAP;
  return { nodes, width: totalW, height: totalH };
}

/**
 * 計算 SVG 連線路徑（貝茲曲線）
 * @param {object} dag
 * @param {object[]} nodes
 * @returns {object[]}
 */
export function buildEdges(dag, nodes) {
  if (!dag || !nodes.length) return [];
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const edges = [];
  for (const [id, cfg] of Object.entries(dag)) {
    const target = nodeMap[id];
    if (!target) continue;
    for (const dep of (cfg?.deps || [])) {
      const source = nodeMap[dep];
      if (!source) continue;
      const x1 = source.x + source.w;
      const y1 = source.y + source.h / 2;
      const x2 = target.x;
      const y2 = target.y + target.h / 2;
      const cx = (x1 + x2) / 2;
      edges.push({ id: `${dep}->${id}`, path: `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`, from: dep, to: id });
    }
  }
  return edges;
}

/**
 * 偵測 phase 分組（suffixed stages: DEV:1, REVIEW:1 → phase 1）
 * @param {object} dag
 * @returns {object} phase ID → stage ID 清單的映射
 */
export function detectPhases(dag) {
  if (!dag) return {};
  const phases = {};
  for (const id of Object.keys(dag)) {
    const m = id.match(/:(\d+)$/);
    if (m) {
      const n = m[1];
      if (!phases[n]) phases[n] = [];
      phases[n].push(id);
    }
  }
  return Object.keys(phases).length >= 2 ? phases : {};
}

/**
 * DAG 流程圖組件
 * @param {{ state: object, registry: object }} props
 */
export function DagView({ state, registry }) {
  const [selected, setSelected] = useState(null);
  const dag = state?.dag || {};
  const stages = state?.stages || {};

  const { nodes, width, height } = useMemo(() => computeDagLayout(dag, 800), [dag]);
  const edges = useMemo(() => buildEdges(dag, nodes), [dag, nodes]);
  const phases = useMemo(() => detectPhases(dag), [dag]);

  if (!nodes.length) {
    return html`<div style="color:var(--subtext0);font-size:11px;padding:20px;text-align:center">無 Pipeline DAG 資料</div>`;
  }

  const svgW = width + PADDING * 2;
  const svgH = height + PADDING * 2;

  // 取邊線狀態 CSS class
  const edgeClass = (from, to) => {
    const fromStatus = getStageStatus(from, state);
    if (fromStatus === 'completed') return 'completed';
    if (fromStatus === 'active') return 'active';
    return 'pending';
  };

  // 取 stage metadata（支援 suffixed stage）
  const getStageMeta = (id) => {
    const base = id.split(':')[0];
    return registry?.stages?.[base] || { emoji: '📌', label: base, color: null };
  };

  const selectedStage = selected ? stages[selected] : null;
  const selectedMeta = selected ? getStageMeta(selected) : null;
  const selectedVerdict = selected ? getStageVerdict(selected, state) : null;
  const selectedSeverity = selected ? getStageSeverity(selected, state) : null;
  const selectedDur = selected ? getStageDuration(selected, state) : null;
  const selectedRetries = selected ? (state?.retries?.[selected] || 0) : 0;
  const selectedCrashes = selected ? (state?.crashes?.[selected] || 0) : 0;
  const selectedHistory = selected ? (state?.retryHistory?.[selected] || []) : [];

  return html`
    <div style="display:flex;flex-direction:column;gap:12px">
      <!-- Barrier 並行進度（若有） -->
      ${selected === null && html`<${BarrierDisplay} barrierState=${null} />`}

      <!-- DAG 視圖 -->
      <div class="dag-container" style="min-height:${svgH + 20}px">
        <svg class="dag-svg" width=${svgW} height=${svgH} style="position:absolute;top:0;left:0">
          ${edges.map(e => html`
            <path key=${e.id}
              class="dag-edge ${edgeClass(e.from, e.to)}"
              d=${e.path}
              transform="translate(${PADDING},${PADDING})"
            />
          `)}
        </svg>
        ${nodes.map(n => {
          const status = getStageStatus(n.id, state);
          const verdict = getStageVerdict(n.id, state);
          const severity = getStageSeverity(n.id, state);
          const meta = getStageMeta(n.id);
          const isSelected = selected === n.id;
          let statusText = '';
          if (status === 'completed') statusText = verdict || 'PASS';
          else if (status === 'failed') statusText = severity || verdict || 'FAIL';
          else if (status === 'active') statusText = '進行中';
          else if (status === 'skipped') statusText = '跳過';
          else statusText = '等待';

          return html`
            <div key=${n.id}
              class="dag-node ${status} ${isSelected ? 'selected' : ''}"
              style="left:${n.x + PADDING}px;top:${n.y + PADDING}px;width:${n.w}px;height:${n.h}px;"
              onClick=${() => setSelected(isSelected ? null : n.id)}
            >
              <span class="dag-emoji">${meta.emoji}</span>
              <span class="dag-label">${n.id}</span>
              <span class="dag-status">${statusText}</span>
            </div>
          `;
        })}
        <!-- Phase 分組框 -->
        ${Object.entries(phases).map(([phaseN, phaseIds]) => {
          const phaseNodes = nodes.filter(n => phaseIds.includes(n.id));
          if (!phaseNodes.length) return null;
          const xs = phaseNodes.map(n => n.x + PADDING);
          const ys = phaseNodes.map(n => n.y + PADDING);
          const x2s = phaseNodes.map(n => n.x + n.w + PADDING);
          const y2s = phaseNodes.map(n => n.y + n.h + PADDING);
          const bx = Math.min(...xs) - 8;
          const by = Math.min(...ys) - 14;
          const bw = Math.max(...x2s) - bx + 8;
          const bh = Math.max(...y2s) - by + 8;
          return html`
            <div key=${'phase' + phaseN} class="dag-phase" style="left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px">
              <span class="dag-phase-title">Phase ${phaseN}</span>
            </div>
          `;
        })}
      </div>

      <!-- 點擊展開詳情 -->
      ${selected && html`
        <div class="dag-detail">
          <h4>${selectedMeta?.emoji} ${selected} — ${selectedMeta?.label}</h4>
          ${selectedVerdict ? html`
            <div class="dag-detail-row">
              <span class="label">Verdict</span>
              <span class="value" style="color:var(--${selectedVerdict === 'PASS' ? 'green' : 'red'})">${selectedVerdict}${selectedSeverity ? ' (' + selectedSeverity + ')' : ''}</span>
            </div>
          ` : html`
            <div class="dag-detail-row"><span class="label">狀態</span><span class="value">${getStageStatus(selected, state)}</span></div>
          `}
          ${selectedDur !== null && html`
            <div class="dag-detail-row"><span class="label">耗時</span><span class="value">${fmtSec(selectedDur)}</span></div>
          `}
          ${selectedRetries > 0 && html`
            <div class="dag-detail-row"><span class="label">重試</span><span class="value" style="color:var(--orange)">${selectedRetries} 次</span></div>
          `}
          ${selectedCrashes > 0 && html`
            <div class="dag-detail-row"><span class="label">Crash</span><span class="value" style="color:var(--red)">${selectedCrashes} 次</span></div>
          `}
          ${selectedHistory.length > 0 && html`
            <div style="margin-top:6px;font-size:9px;color:var(--subtext0)">重試歷史</div>
            ${selectedHistory.map(h => html`
              <div class="rh-round ${h.verdict?.toLowerCase()}">R${h.round}: ${h.verdict} <span style="opacity:0.6">${h.severity || ''}</span></div>
            `)}
          `}
        </div>
      `}
    </div>
  `;
}
