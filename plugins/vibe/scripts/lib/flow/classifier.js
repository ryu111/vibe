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
  const catalog = Object.entries(PIPELINES)
    .map(([id, p]) => `- ${id}: ${p.description}`)
    .join('\n');

  return [
    '你是開發任務分類器。根據使用者的自然語言輸入，判斷最適合的開發 pipeline。',
    '',
    '關鍵原則：分析使用者的主要意圖，不要被附屬子句的措辭干擾。',
    '例如「繼續尋找有沒有遺留跟斷裂並優化」→ 主意圖是「優化/重構」，不是問問題。',
    '例如「幫我看看這個 bug 然後修掉」→ 主意圖是「修 bug」，不是「看看」。',
    '',
    '可用 pipeline：',
    catalog,
    '',
    '分類原則：',
    '- 純粹問問題、查資料、探索、聊天、打招呼、確認（好/OK/繼續）→ none',
    '- 修 typo、改名、改設定、一行修改 → fix',
    '- Bug 修復 + 需要測試驗證 → quick-dev',
    '- 新功能、新系統、新模組（含 UI）→ full',
    '- 新功能、新系統、新模組（無 UI）→ standard',
    '- 重構、優化、改善、改進既有程式碼 → standard',
    '- TDD 工作流（先寫測試再實作）→ test-first',
    '- 純 UI/樣式調整 → ui-only',
    '- 程式碼審查 → review-only',
    '- 純文件更新（.md/README/CHANGELOG）→ docs-only',
    '- 安全漏洞修復 → security',
    '- 不確定時選 none（保守策略）',
    '',
    '回覆格式（嚴格 JSON）：',
    '- 需要 pipeline → {"decision":"allow","systemMessage":"此需求適合 [pipeline:ID]。請使用對應 skill 開始委派。"}',
    '- 不需要 → {"decision":"allow"}',
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
