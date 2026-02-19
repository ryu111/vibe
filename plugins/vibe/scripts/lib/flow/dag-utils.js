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

const { STAGES, REFERENCE_PIPELINES, MAX_RETRIES, QUALITY_STAGES, BARRIER_CONFIG } = require('../registry.js');

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
 * 偵測並消除重複 stage 名稱（如 ['TEST','DEV','TEST'] → ['TEST','DEV','TEST:2']）
 * 使用 `:N` 後綴，相容 getBaseStage() 的 `:` 分割邏輯。
 * @param {string[]} stages
 * @returns {string[]} 去重後的 stage 列表
 */
function deduplicateStages(stages) {
  const count = {};
  return stages.map(s => {
    count[s] = (count[s] || 0) + 1;
    return count[s] > 1 ? `${s}:${count[s]}` : s;
  });
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
  // 取得 stages 列表（自動消除重複，如 TEST→DEV→TEST 變 TEST→DEV→TEST:2）
  const rawStages = stages || REFERENCE_PIPELINES[pipelineId]?.stages || [];
  if (rawStages.length === 0) {
    return {};
  }
  const templateStages = deduplicateStages(rawStages);

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

/**
 * 修復 pipeline-architect 產出的 DAG 格式偏差
 *
 * 可修復項目：
 * - config 為 null/undefined → { deps: [] }
 * - deps 為 string → [string]
 * - deps 缺失 → []
 * - 懸空 dep 引用（指向不存在的 stage）→ 移除
 * - 未知 stage 名稱（不在 STAGES 註冊表中）→ 移除
 *
 * 不可修復（回傳 null）：
 * - DAG 不是物件
 * - 修復後 DAG 為空
 * - 修復後仍有環
 *
 * @param {Object} dag - 原始 DAG
 * @returns {{ dag: Object, fixes: string[] } | null}
 */
function repairDag(dag) {
  if (!dag || typeof dag !== 'object') return null;

  const fixes = [];
  const repaired = {};

  // Phase 1: 逐節點修復格式
  for (const [node, config] of Object.entries(dag)) {
    const base = getBaseStage(node);

    // 移除未知 stage
    if (!STAGES[base]) {
      fixes.push(`移除未知 stage: ${node}`);
      continue;
    }

    // 修復 config
    if (!config || typeof config !== 'object') {
      repaired[node] = { deps: [] };
      fixes.push(`${node}: config 為空，補 { deps: [] }`);
      continue;
    }

    // 修復 deps
    let deps = config.deps;
    if (deps === undefined || deps === null) {
      deps = [];
      fixes.push(`${node}: deps 缺失，補 []`);
    } else if (typeof deps === 'string') {
      deps = [deps];
      fixes.push(`${node}: deps 為 string "${deps[0]}"，轉為陣列`);
    } else if (!Array.isArray(deps)) {
      deps = [];
      fixes.push(`${node}: deps 格式無效，重設為 []`);
    }

    repaired[node] = { ...config, deps };
  }

  // 空 DAG 不可修復
  if (Object.keys(repaired).length === 0) return null;

  // Phase 2: 移除懸空 dep 引用
  for (const [node, config] of Object.entries(repaired)) {
    const validDeps = config.deps.filter(d => {
      if (repaired[d]) return true;
      fixes.push(`${node}: 移除懸空依賴 ${d}`);
      return false;
    });
    repaired[node] = { ...config, deps: validDeps };
  }

  // Phase 3: 環偵測（修復後仍有環 → 不可修復）
  try {
    topologicalSort(repaired);
  } catch (_) {
    return null;
  }

  return { dag: repaired, fixes };
}

/**
 * 為 custom DAG 加入 v4 增強 metadata（barrier/onFail/next/maxRetries）
 *
 * 針對 pipeline-architect 產出的原始 DAG（只有 deps），自動：
 * 1. 偵測並行品質 stages（共享同一前驅 deps）→ 加 barrier
 * 2. 品質 stages 加 onFail（指向最近的上游 IMPL stage）
 * 3. 品質 stages 加 maxRetries
 * 4. 線性 stages 加 next
 *
 * @param {Object} dag - 已驗證的 DAG
 * @returns {Object} 增強 DAG
 */
function enrichCustomDag(dag) {
  if (!dag) return dag;

  const enriched = {};
  for (const [k, v] of Object.entries(dag)) {
    enriched[k] = { ...v };
  }

  const sorted = topologicalSort(enriched);

  // 偵測 barrier groups：共享同一 deps 的 QUALITY stages
  const depKey = (deps) => [...deps].sort().join(',');
  const groups = {};
  for (const node of sorted) {
    const base = getBaseStage(node);
    if (!QUALITY_STAGES.includes(base)) continue;
    const key = depKey(enriched[node].deps);
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }

  // 為 barrier groups 加入 barrier metadata
  const barrierStages = new Set();
  for (const [, members] of Object.entries(groups)) {
    if (members.length < 2) continue;
    // 找 barrier 的 next：所有依賴此 group 任一成員的 stage
    const memberSet = new Set(members);
    let barrierNext = null;
    for (const node of sorted) {
      if (memberSet.has(node)) continue;
      const deps = enriched[node].deps;
      if (deps.some(d => memberSet.has(d))) {
        barrierNext = node;
        break;
      }
    }

    const groupName = `barrier-${members.join('-').toLowerCase()}`;
    for (const member of members) {
      enriched[member].barrier = {
        group: groupName,
        total: members.length,
        next: barrierNext,
        siblings: members,
      };
      barrierStages.add(member);
    }
  }

  // 為每個 stage 加入 onFail / maxRetries / next
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    const base = getBaseStage(node);
    const isQuality = QUALITY_STAGES.includes(base);

    // onFail + maxRetries（只有品質 stages）
    if (isQuality) {
      // 找最近的上游 IMPL stage（沿拓撲逆序）
      const deps = enriched[node].deps;
      let onFail = null;
      for (let j = i - 1; j >= 0; j--) {
        const candidate = sorted[j];
        if (IMPL_STAGE_NAMES.has(getBaseStage(candidate))) {
          onFail = candidate;
          break;
        }
      }
      if (onFail) {
        enriched[node].onFail = onFail;
        enriched[node].maxRetries = MAX_RETRIES;
      }
    }

    // next（線性後繼，barrier stages 跳過）
    if (!barrierStages.has(node)) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (!barrierStages.has(sorted[j])) {
          enriched[node].next = sorted[j];
          break;
        }
      }
    }
  }

  return enriched;
}

module.exports = {
  getBaseStage,
  deduplicateStages,
  resolveAgent,
  topologicalSort,
  validateDag,
  repairDag,
  enrichCustomDag,
  linearToDag,
  templateToDag,
  buildBlueprint,
};
