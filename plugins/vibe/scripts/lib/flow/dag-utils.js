#!/usr/bin/env node
/**
 * dag-utils.js — DAG 工具函式（純函式）
 *
 * DAG 驗證、拓撲排序、stage 解析工具。
 * Pipeline v3/v4 的基礎工具模組。
 *
 * v4 Phase 4 新增：
 * - templateToDag()：根據 pipeline 模板自動加入 barrier/onFail/next 欄位
 *
 * @module flow/dag-utils
 */
'use strict';

const { STAGES, REFERENCE_PIPELINES, MAX_RETRIES, QUALITY_STAGES } = require('../registry.js');

// ────────────────── 模板規則常量 ──────────────────

// 需要 barrier 的 pipeline 模板設定
// key: pipelineId, value: barrier group 設定陣列
const BARRIER_CONFIG = {
  // full pipeline：DEV 後的 REVIEW + TEST 共享 barrier（post-dev group），QA 是 next
  // QA + E2E 共享 barrier（post-qa group），DOCS 是 next
  'full': [
    { stages: ['REVIEW', 'TEST'], group: 'post-dev', next: 'QA' },
    { stages: ['QA', 'E2E'], group: 'post-qa', next: 'DOCS' },
  ],
  // standard pipeline：REVIEW + TEST 共享 barrier（若兩者都存在）
  'standard': [
    { stages: ['REVIEW', 'TEST'], group: 'post-plan', next: 'DOCS' },
  ],
  // quick-dev pipeline：REVIEW + TEST 共享 barrier
  'quick-dev': [
    { stages: ['REVIEW', 'TEST'], group: 'post-dev', next: null },
  ],
};

// IMPL stages（不設 onFail）
const IMPL_STAGE_NAMES = new Set(['PLAN', 'ARCH', 'DESIGN', 'DEV', 'DOCS']);

/**
 * 從帶後綴的 stage ID 取得基礎 stage 名稱
 * 例：'TEST:write' → 'TEST', 'DEV' → 'DEV'
 * @param {string} stageId
 * @returns {string}
 */
function getBaseStage(stageId) {
  if (!stageId) return '';
  return stageId.split(':')[0];
}

/**
 * 解析 stage ID 對應的 agent 和 skill
 * @param {string} stageId
 * @param {Object} stageMap - pipeline.json provides 映射
 * @returns {{ agent: string, skill: string|null, plugin: string|null } | null}
 */
function resolveAgent(stageId, stageMap) {
  const base = getBaseStage(stageId);
  const info = stageMap[base];
  if (info) return info;
  // Fallback: 從 STAGES 推導
  const stageDef = STAGES[base];
  if (stageDef) return { agent: stageDef.agent, skill: null, plugin: 'vibe' };
  return null;
}

/**
 * 拓撲排序（Kahn's algorithm）
 * @param {Object} dag - { stageId: { deps: string[] }, ... }
 * @returns {string[]} 排序後的 stage ID 列表
 * @throws {Error} 如果有環
 */
function topologicalSort(dag) {
  const nodes = Object.keys(dag);
  const inDegree = {};
  const adjList = {};

  for (const node of nodes) {
    inDegree[node] = 0;
    adjList[node] = [];
  }

  for (const [node, config] of Object.entries(dag)) {
    for (const dep of (config.deps || [])) {
      if (!adjList[dep]) continue; // dep 不在 DAG 中
      adjList[dep].push(node);
      inDegree[node]++;
    }
  }

  const queue = nodes.filter(n => inDegree[n] === 0);
  const result = [];

  while (queue.length > 0) {
    const node = queue.shift();
    result.push(node);
    for (const neighbor of (adjList[node] || [])) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (result.length !== nodes.length) {
    const remaining = nodes.filter(n => !result.includes(n));
    throw new Error(`DAG 有環：${remaining.join(', ')}`);
  }

  return result;
}

/**
 * 驗證 DAG 結構
 * @param {Object} dag - { stageId: { deps: string[] }, ... }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDag(dag) {
  const errors = [];

  if (!dag || typeof dag !== 'object') {
    return { valid: false, errors: ['DAG 必須是物件'] };
  }

  const nodes = Object.keys(dag);
  if (nodes.length === 0) {
    return { valid: false, errors: ['DAG 不能為空'] };
  }

  // 檢查每個 stage 的 deps
  for (const [node, config] of Object.entries(dag)) {
    if (!config || !Array.isArray(config.deps)) {
      errors.push(`${node}: deps 必須是陣列`);
      continue;
    }
    for (const dep of config.deps) {
      if (!dag[dep]) {
        errors.push(`${node}: 依賴 ${dep} 不存在於 DAG 中`);
      }
    }
    // 檢查基礎 stage 是否合法
    const base = getBaseStage(node);
    if (!STAGES[base]) {
      errors.push(`${node}: 基礎 stage ${base} 不在已知 STAGES 中`);
    }
  }

  // 檢查環
  try {
    topologicalSort(dag);
  } catch (e) {
    errors.push(e.message);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 從線性 stage 列表建立 DAG（每個 stage 依賴前一個）
 * @param {string[]} stages - 如 ['PLAN', 'ARCH', 'DEV']
 * @returns {Object} DAG 物件
 */
function linearToDag(stages) {
  const dag = {};
  for (let i = 0; i < stages.length; i++) {
    dag[stages[i]] = {
      deps: i > 0 ? [stages[i - 1]] : [],
    };
  }
  return dag;
}

/**
 * 從 DAG 提取執行步驟（blueprint）
 * 共享同一 deps 的 stages 歸為同一步（可並行）
 * @param {Object} dag
 * @returns {Array<{ step: number, stages: string[], parallel: boolean }>}
 */
function buildBlueprint(dag) {
  const sorted = topologicalSort(dag);
  const steps = [];
  const assigned = new Set();

  // 按拓撲序，每一批 ready stages 歸為同一步
  while (assigned.size < sorted.length) {
    const batch = [];
    for (const node of sorted) {
      if (assigned.has(node)) continue;
      const deps = dag[node].deps || [];
      if (deps.every(d => assigned.has(d))) {
        batch.push(node);
      }
    }
    if (batch.length === 0) break; // 安全閥
    for (const b of batch) assigned.add(b);
    steps.push({
      step: steps.length + 1,
      stages: batch,
      parallel: batch.length > 1,
    });
  }

  return steps;
}

/**
 * 從 pipeline 模板建立包含 barrier/onFail/next 的增強 DAG
 *
 * v4 Phase 4：取代 linearToDag()，用於已知模板的 DAG 建立。
 * - 自動偵測並行節點（共享同一前驅的 QUALITY stages）→ 加入 barrier
 * - 自動設定 onFail（QUALITY stage → 最近的 IMPL stage）
 * - 自動設定 next（線性後繼，並行節點的 next 指向 barrier.next）
 *
 * @param {string} pipelineId - pipeline 模板 ID（如 'full', 'standard'）
 * @param {string[]} [stages] - 可選：覆蓋 REFERENCE_PIPELINES 的 stages
 * @returns {Object} 增強 DAG 物件（含 barrier/onFail/next 欄位）
 */
function templateToDag(pipelineId, stages) {
  // 取得 stages 列表
  const templateStages = stages || REFERENCE_PIPELINES[pipelineId]?.stages || [];
  if (templateStages.length === 0) {
    return {};
  }

  // 先用 linearToDag 建立基礎結構
  const dag = linearToDag(templateStages);

  // 查詢此 pipeline 的 barrier 設定
  const barrierGroups = BARRIER_CONFIG[pipelineId];

  // 標記哪些 stage 屬於哪個 barrier group
  const stageBarrierMap = {}; // stageId → { group, next, siblings }
  if (barrierGroups) {
    for (const config of barrierGroups) {
      const { stages: barStages, group, next } = config;
      // 只處理 templateStages 中實際存在的 stages
      const validBarStages = barStages.filter(s => templateStages.includes(s));
      if (validBarStages.length < 2) continue; // 少於 2 個 stage 不構成 barrier

      for (const s of validBarStages) {
        stageBarrierMap[s] = {
          group,
          total: validBarStages.length,
          next: next || null,
          siblings: validBarStages,
        };
      }
    }
  }

  // M-1 修正：barrier group 內的 stages 共享前驅 deps
  // 例如 REVIEW 和 TEST barrier → 都依賴 DEV（而非 TEST 依賴 REVIEW）
  if (barrierGroups) {
    for (const config of barrierGroups) {
      const { stages: barStages } = config;
      const validBarStages = barStages.filter(s => templateStages.includes(s));
      if (validBarStages.length < 2) continue;

      // M-7 防禦性 assertion：驗證 BARRIER_CONFIG stages 順序與 templateStages 一致
      // 若順序不一致，shared deps 計算可能基於錯誤的「第一個 stage」
      const templateIndices = validBarStages.map(s => templateStages.indexOf(s));
      const isSorted = templateIndices.every((idx, i) => i === 0 || idx > templateIndices[i - 1]);
      if (!isSorted) {
        // 順序不一致：依 templateStages 順序重排 validBarStages，確保 shared deps 計算正確
        validBarStages.sort((a, b) => templateStages.indexOf(a) - templateStages.indexOf(b));
      }

      // 找到 group 中第一個 stage 的 deps（即共享前驅）
      const firstStage = validBarStages[0];
      const sharedDeps = dag[firstStage]?.deps || [];

      // 將 group 內其他 stages 的 deps 改為相同的共享前驅
      for (let k = 1; k < validBarStages.length; k++) {
        if (dag[validBarStages[k]]) {
          dag[validBarStages[k]].deps = [...sharedDeps];
        }
      }
    }
  }

  // 為每個 stage 設定增強欄位
  for (let i = 0; i < templateStages.length; i++) {
    const stageId = templateStages[i];
    const baseStage = getBaseStage(stageId);
    const isQuality = QUALITY_STAGES.includes(baseStage);
    const isBarrierStage = !!stageBarrierMap[stageId];

    // 計算 next（線性後繼，但 barrier stage 的 next 是 barrier.next）
    let nextStageId = null;
    if (isBarrierStage) {
      // barrier stage 的 next 由 barrier.next 決定（不使用線性後繼）
      // 線性後繼是 barrier 的兄弟節點，不是真正的 next
      nextStageId = null; // barrier stage 沒有線性 next（會被 barrier 機制接管）
    } else {
      // 非 barrier stage：線性後繼
      // 但要跳過所有 barrier stage（它們由 barrier 機制路由）
      if (i < templateStages.length - 1) {
        const candidate = templateStages[i + 1];
        nextStageId = stageBarrierMap[candidate] ? null : candidate;
        // 如果後繼是 barrier stage，繼續往後找真正的 next
        if (!nextStageId) {
          // 找到第一個不是 barrier stage 的後繼（即 barrier.next）
          for (let j = i + 1; j < templateStages.length; j++) {
            if (!stageBarrierMap[templateStages[j]]) {
              nextStageId = templateStages[j];
              break;
            }
          }
          // 找不到 → null（完成）
        }
      }
    }

    // 計算 onFail（只有 QUALITY stages 才有）
    let onFail = null;
    let maxRetries = null;
    if (isQuality) {
      // 找最近的前驅 IMPL stage
      const devStage = findNearestImplStage(templateStages, i);
      if (devStage) {
        onFail = devStage;
        maxRetries = MAX_RETRIES;
      }
    }

    // 組裝增強 DAG 節點
    dag[stageId] = {
      ...dag[stageId],
      ...(nextStageId !== null ? { next: nextStageId } : {}),
      ...(onFail !== null ? { onFail, maxRetries } : {}),
      ...(isBarrierStage ? { barrier: stageBarrierMap[stageId] } : {}),
    };
  }

  return dag;
}

/**
 * 在 stages 列表中找最近的前驅 IMPL stage
 *
 * @param {string[]} stages - 所有 stage 列表
 * @param {number} currentIdx - 當前 stage 的索引
 * @returns {string|null} 最近的前驅 IMPL stage ID
 */
function findNearestImplStage(stages, currentIdx) {
  for (let i = currentIdx - 1; i >= 0; i--) {
    const base = getBaseStage(stages[i]);
    if (IMPL_STAGE_NAMES.has(base)) {
      return stages[i];
    }
  }
  return null;
}

module.exports = {
  getBaseStage,
  resolveAgent,
  topologicalSort,
  validateDag,
  linearToDag,
  templateToDag,
  buildBlueprint,
};
