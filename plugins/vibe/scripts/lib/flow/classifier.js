#!/usr/bin/env node
/**
 * classifier.js — Pipeline 分類器
 *
 * 兩層架構 + system-feedback 防護：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度，零成本）
 *   System:   system-feedback 偵測 — hook 輸出 / 系統通知（不觸發 pipeline）
 *   Layer 2:  Main Agent 主動選擇（有完整 context，透過 systemMessage pipeline 選擇表）
 *
 * v5 Always-Pipeline 架構：
 *   - 刪除 regex heuristic（Layer 1.5）— Opus 的語意理解遠勝正則比對
 *   - Main Agent 從「被動自分類」改為「主動選擇 pipeline」
 *   - 不確定時用 AskUserQuestion 反問使用者（Layer 3 兜底）
 *
 * @module flow/classifier
 */
'use strict';

const { PIPELINES, TASKTYPE_TO_PIPELINE, PIPELINE_TO_TASKTYPE } = require('../registry.js');

// ═══════════════════════════════════════════════
// 系統標記常數
// ═══════════════════════════════════════════════

/**
 * 結構化系統標記 — 用於識別 hook 輸出（pipeline-check reason、task-guard systemMessage）
 * 加上此標記的訊息會被 isSystemFeedback 攔截，確保不會誤觸發 pipeline
 */
const SYSTEM_MARKER = '<!-- VIBE_SYSTEM -->';

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

// ═══════════════════════════════════════════════
// System-feedback 偵測
// ═══════════════════════════════════════════════

/**
 * 偵測系統回饋訊息（hook 輸出、系統通知）
 *
 * 三層偵測：
 *   1. SYSTEM_MARKER 結構化標記（最可靠，pipeline-check / task-guard 主動加上）
 *   2. Emoji 前綴（防禦性兜底，涵蓋各種 hook 輸出格式）
 *   3. 英文系統通知模式（background task 結果、agent 回報）
 *
 * @param {string} prompt - 使用者輸入
 * @returns {boolean} true = 系統回饋，不應觸發 pipeline
 */
function isSystemFeedback(prompt) {
  if (!prompt) return false;
  const t = prompt.trim();
  if (!t) return false;
  // 1. 結構化標記（最可靠）
  if (t.includes(SYSTEM_MARKER)) return true;
  // 2. Emoji 前綴（防禦性兜底）
  if (/^[⛔⚠️✅🔄📋➡️📌📄]/.test(t)) return true;
  // 3. 英文系統通知模式
  if (/^(Background task|Task .+ (completed|finished|failed)|Result from|Output from)/i.test(t)) return true;
  return false;
}

// ═══════════════════════════════════════════════
// 工具函式
// ═══════════════════════════════════════════════

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
 * Layer 1:   顯式 [pipeline:xxx] → 直接返回
 * System:    system-feedback → 返回 none（不觸發 pipeline）
 * Layer 2:   交給 Main Agent 主動選擇（透過 systemMessage pipeline 選擇表）
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

  // System-feedback: hook 輸出 / 系統通知 → 不觸發 pipeline
  if (isSystemFeedback(prompt)) {
    return { pipeline: 'none', confidence: 0.9, source: 'system', matchedRule: 'system-feedback' };
  }

  // Layer 2: 交給 Main Agent 主動選擇（它有完整對話 context）
  return { pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' };
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 系統標記常數（供 hook 端 require，避免硬編碼）
  SYSTEM_MARKER,

  // 主要 API（async）
  classifyWithConfidence,

  // 工具函式
  extractExplicitPipeline,
  isSystemFeedback,
  mapTaskTypeToPipeline,
};
