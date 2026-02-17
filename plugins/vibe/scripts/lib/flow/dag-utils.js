#!/usr/bin/env node
/**
 * dag-utils.js — DAG 工具函式（純函式）
 *
 * DAG 驗證、拓撲排序、stage 解析工具。
 * Pipeline v3 的基礎工具模組。
 *
 * @module flow/dag-utils
 */
'use strict';

const { STAGES } = require('../registry.js');

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

module.exports = {
  getBaseStage,
  resolveAgent,
  topologicalSort,
  validateDag,
  linearToDag,
  buildBlueprint,
};
