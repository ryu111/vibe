#!/usr/bin/env node
/**
 * classifier.js — Pipeline 分類器
 *
 * 設計原則：
 *   Main Agent 本身是最佳分類器 — 它有完整對話歷史和 context。
 *   Hook 層只處理顯式語法，其餘交給 Main Agent 自主判斷。
 *
 * 兩層架構：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度，零成本）
 *   Layer 2:  Main Agent 自主判斷（有完整 context，透過 systemMessage 強制分類指令）
 *
 * @module flow/classifier
 */
'use strict';

const { PIPELINES, TASKTYPE_TO_PIPELINE, PIPELINE_TO_TASKTYPE } = require('../registry.js');

// ═══════════════════════════════════════════════
// Layer 1: 顯式 Pipeline 覆寫
// ═══════════════════════════════════════════════

/**
 * 解析顯式 pipeline 語法 [pipeline:xxx]
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {string|null} pipeline ID 或 null（大小寫不敏感）
 */
function extractExplicitPipeline(prompt) {
  if (!prompt) return null;

  const match = prompt.match(/\[pipeline:([a-z0-9-]+)\]/i);
  if (!match) return null;

  const pipelineId = match[1].toLowerCase();
  if (!PIPELINES[pipelineId]) return null;

  return pipelineId;
}

/**
 * 將 taskType 映射到 pipeline ID
 * @param {string} taskType
 * @returns {string} pipeline ID
 */
function mapTaskTypeToPipeline(taskType) {
  return TASKTYPE_TO_PIPELINE[taskType] || 'fix';
}

// ═══════════════════════════════════════════════
// 主要 API
// ═══════════════════════════════════════════════

/**
 * 分類使用者 prompt
 *
 * Layer 1: 顯式 [pipeline:xxx] → 直接返回
 * Layer 2: 交給 Main Agent 判斷（透過 additionalContext 提示 pipeline 選項）
 *
 * @param {string} prompt
 * @returns {Promise<{ pipeline: string, confidence: number, source: string, matchedRule: string }>}
 */
async function classifyWithConfidence(prompt) {
  if (!prompt || !prompt.trim()) {
    return { pipeline: 'none', confidence: 0, source: 'fallback', matchedRule: 'empty' };
  }

  // Layer 1: 顯式覆寫
  const explicitPipeline = extractExplicitPipeline(prompt);
  if (explicitPipeline) {
    return { pipeline: explicitPipeline, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' };
  }

  // Layer 2: 交給 Main Agent（它有完整對話 context）
  return { pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' };
}

/**
 * 產生 Pipeline 目錄提示（供 systemMessage + additionalContext 注入 Main Agent）
 * @returns {string}
 */
function buildPipelineCatalogHint() {
  const catalog = Object.entries(PIPELINES)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => `  [pipeline:${id}] — ${p.label}：${p.description}`)
    .join('\n');

  return '\n可用 pipeline：\n' + catalog;
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 主要 API（async）
  classifyWithConfidence,

  // 工具函式
  extractExplicitPipeline,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,
};
