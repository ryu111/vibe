#!/usr/bin/env node
/**
 * pipeline-discovery.js — 跨 plugin Pipeline 動態發現
 *
 * 讀取 flow 的 pipeline.json（stage 順序），
 * 掃描所有已安裝 plugin 的 pipeline.json.provides 欄位，
 * 回傳完整的 pipeline 配置。
 *
 * 注意：pipeline 資料放在 pipeline.json 而非 plugin.json，
 * 因為 Claude Code 的 plugin.json schema 不允許自定義欄位。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 動態發現已安裝 plugin 的 pipeline 配置
 * @returns {{ stageOrder: string[], stageLabels: Object, stageMap: Object, agentToStage: Object }}
 */
function discoverPipeline() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    return { stageOrder: [], stageLabels: {}, stageMap: {}, agentToStage: {} };
  }

  const pluginsDir = path.join(pluginRoot, '..');

  // 讀取 flow 的 stage 順序
  const pipelinePath = path.join(pluginRoot, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) {
    return { stageOrder: [], stageLabels: {}, stageMap: {}, agentToStage: {} };
  }
  const pipelineConfig = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));

  const stageMap = {};      // stage → { agent, skill, plugin }
  const agentToStage = {};  // agent name → stage name

  // 掃描所有已安裝 plugin 的 pipeline.json
  try {
    for (const dir of fs.readdirSync(pluginsDir)) {
      const pipePath = path.join(pluginsDir, dir, 'pipeline.json');
      if (!fs.existsSync(pipePath)) continue;

      try {
        const pipeFile = JSON.parse(fs.readFileSync(pipePath, 'utf8'));
        if (!pipeFile.provides) continue;

        // 讀取 plugin 名稱（用於標記來源）
        let pluginName = dir;
        const pjPath = path.join(pluginsDir, dir, '.claude-plugin', 'plugin.json');
        try {
          const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
          pluginName = pj.name || dir;
        } catch (_) {}

        for (const [stage, config] of Object.entries(pipeFile.provides)) {
          stageMap[stage] = { ...config, plugin: pluginName };
          if (config.agent) {
            agentToStage[config.agent] = stage;
          }
        }
      } catch (_) { /* 跳過無效 JSON */ }
    }
  } catch (_) { /* pluginsDir 不存在 */ }

  return {
    stageOrder: pipelineConfig.stages || [],
    stageLabels: pipelineConfig.stageLabels || {},
    stageMap,
    agentToStage,
  };
}

/**
 * 查找下一個「已安裝」的 stage
 * @param {string[]} stageOrder - 全部 stage 順序
 * @param {Object} stageMap - 已安裝的 stage 映射
 * @param {string} currentStage - 當前 stage
 * @returns {string|null} 下一個已安裝的 stage，或 null（pipeline 結束）
 */
function findNextStage(stageOrder, stageMap, currentStage) {
  const idx = stageOrder.indexOf(currentStage);
  if (idx === -1) return null;
  for (let i = idx + 1; i < stageOrder.length; i++) {
    if (stageMap[stageOrder[i]]) return stageOrder[i];
  }
  return null;
}

module.exports = { discoverPipeline, findNextStage };
