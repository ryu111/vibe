#!/usr/bin/env node
/**
 * classifier.js — Pipeline 分類器
 *
 * 設計原則：
 *   用 LLM 理解自然語言意圖，不靠 regex 猜測。
 *   使用者不需要分析自己的措辭，也不需要加 [pipeline:xxx] 標籤。
 *
 * 兩層架構：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度，零成本）
 *   Layer 2:  Prompt Hook LLM — hooks.json 的 prompt hook 用訂閱認證呼叫 haiku
 *   Fallback: prompt hook 不可用時 → pipeline:none
 *
 * 分類由 hooks.json 的 prompt hook 處理（使用訂閱認證，不需要 API key）。
 * 此模組只負責 Layer 1 顯式解析和結果後處理。
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
// Layer 2: Prompt Hook 分類結果解析
// ═══════════════════════════════════════════════

/**
 * 從 prompt hook 回傳的 systemMessage 中解析 pipeline ID
 *
 * prompt hook 回傳格式：
 *   systemMessage: "... [pipeline:standard] ..."
 *
 * @param {string} hookSystemMessage - prompt hook 的 systemMessage
 * @returns {string|null} pipeline ID 或 null
 */
function extractHookClassification(hookSystemMessage) {
  if (!hookSystemMessage) return null;
  return extractExplicitPipeline(hookSystemMessage);
}

// ═══════════════════════════════════════════════
// 主要 API
// ═══════════════════════════════════════════════

/**
 * 分類使用者 prompt（sync + async 相容）
 *
 * Layer 1: 顯式 [pipeline:xxx] → 直接返回
 * Layer 2: prompt hook 已處理（分類結果透過 systemMessage 注入 Main Agent）
 * Fallback: none（prompt hook 會補充分類建議）
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

  // Layer 2: 由 prompt hook 處理，此處回傳 none
  // prompt hook 的 systemMessage 會引導 Main Agent 使用正確的 pipeline
  return { pipeline: 'none', confidence: 0, source: 'prompt-hook', matchedRule: 'prompt-hook' };
}

/**
 * 產生 Pipeline 目錄提示（供 prompt hook system prompt 使用）
 * @returns {string}
 */
function buildPipelineCatalogHint() {
  const catalog = Object.entries(PIPELINES)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => `  [pipeline:${id}] — ${p.label}：${p.description}`)
    .join('\n');

  return '\n💡 可在 prompt 中加上語法覆寫：\n' + catalog;
}

/**
 * 產生 prompt hook 的 system prompt
 * @returns {string}
 */
function buildClassifierPrompt() {
  return [
    '你是開發任務分類器。你的唯一工作是判斷使用者輸入適合哪個 pipeline。你不是安全警衛，不要阻擋任何東西。',
    '',
    '## 絕對規則',
    '- decision 欄位永遠是 "allow"。絕對、永遠不要回傳 "block"。',
    '- 你沒有權限阻擋使用者。你只負責分類。',
    '- 回覆必須是繁體中文。',
    '',
    '## 分類原則',
    '分析主要意圖，不被附屬子句干擾。',
    '- commit/push/git 操作、問問題、聊天、確認、系統通知 → {"decision":"allow"}',
    '- fix/hotfix/一行修改 → [pipeline:fix]',
    '- bugfix + 測試 → [pipeline:quick-dev]',
    '- 新功能含 UI → [pipeline:full]',
    '- 新功能無 UI / 重構 → [pipeline:standard]',
    '- TDD → [pipeline:test-first]',
    '- 純 UI → [pipeline:ui-only]',
    '- 審查 → [pipeline:review-only]',
    '- 文件 → [pipeline:docs-only]',
    '- 安全 → [pipeline:security]',
    '- 不確定 → {"decision":"allow"}',
    '',
    '## 回覆格式（嚴格 JSON）',
    '只有兩種合法回覆：',
    '{"decision":"allow","systemMessage":"此需求適合 [pipeline:ID]。請使用對應 skill 開始委派。"}',
    '{"decision":"allow"}',
  ].join('\n');
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 主要 API（async）
  classifyWithConfidence,

  // 工具函式
  extractExplicitPipeline,
  extractHookClassification,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,
  buildClassifierPrompt,
};
