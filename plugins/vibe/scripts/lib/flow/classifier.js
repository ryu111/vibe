#!/usr/bin/env node
/**
 * classifier.js — LLM-first 分類器
 *
 * 設計原則：
 *   用 LLM 理解自然語言意圖，不靠 regex 猜測。
 *   使用者不需要分析自己的措辭，也不需要加 [pipeline:xxx] 標籤。
 *
 * 兩層架構：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度，零成本）
 *   Layer 2:  LLM Classification — Sonnet 語意分類（主要路徑）
 *   Fallback: API 不可用 → pipeline:none + additionalContext 提示
 *
 * 環境變數：
 *   VIBE_CLASSIFIER_MODEL — LLM 模型（預設 claude-sonnet-4-20250514）
 *   VIBE_CLASSIFIER_THRESHOLD — 設 1.0 停用 LLM（降級為 fallback）
 *
 * @module flow/classifier
 */
'use strict';

const https = require('https');
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

// ═══════════════════════════════════════════════
// Layer 2: LLM 分類（主要路徑）
// ═══════════════════════════════════════════════

/** LLM 模型（環境變數可覆寫） */
const LLM_MODEL = process.env.VIBE_CLASSIFIER_MODEL || 'claude-sonnet-4-20250514';

/** LLM 呼叫逾時（ms） */
const LLM_TIMEOUT = 10000;

/**
 * 將 taskType 映射到 pipeline ID
 * @param {string} taskType
 * @returns {string} pipeline ID
 */
function mapTaskTypeToPipeline(taskType) {
  return TASKTYPE_TO_PIPELINE[taskType] || 'fix';
}

/**
 * 呼叫 Anthropic API 進行語意分類
 *
 * @param {string} prompt - 使用者輸入
 * @returns {Promise<{pipeline: string, confidence: number, source: 'llm', matchedRule: string}|null>}
 */
function classifyWithLLM(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  // 環境變數可停用 LLM
  const threshold = parseFloat(process.env.VIBE_CLASSIFIER_THRESHOLD);
  if (!Number.isNaN(threshold) && threshold >= 1.0) return Promise.resolve(null);

  const catalog = Object.entries(PIPELINES)
    .map(([id, p]) => `- ${id}: ${p.description}`)
    .join('\n');

  const systemPrompt = [
    '你是開發任務分類器。根據使用者的自然語言輸入，判斷最適合的開發 pipeline。',
    '',
    '關鍵原則：分析使用者的主要意圖，不要被附屬子句的措辭干擾。',
    '例如「繼續尋找有沒有遺留跟斷裂並優化」→ 主意圖是「優化/重構」，不是問問題。',
    '例如「幫我看看這個 bug 然後修掉」→ 主意圖是「修 bug」，不是「看看」。',
    '',
    '只回覆一個 JSON 物件：{"pipeline":"<id>"}',
    '',
    '可用 pipeline：',
    catalog,
    '',
    '分類原則：',
    '- 純粹問問題、查資料、探索、聊天、打招呼 → none',
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
  ].join('\n');

  const body = JSON.stringify({
    model: LLM_MODEL,
    max_tokens: 60,
    messages: [{ role: 'user', content: prompt.slice(0, 500) }],
    system: systemPrompt,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-10-22',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          const match = text.match(/\{[^}]+\}/);
          if (!match) { resolve(null); return; }
          const result = JSON.parse(match[0]);
          if (!result.pipeline || !PIPELINES[result.pipeline]) { resolve(null); return; }
          resolve({ pipeline: result.pipeline, confidence: 0.85, source: 'llm', matchedRule: 'llm' });
        } catch (_) { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(LLM_TIMEOUT, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════
// 主要 API
// ═══════════════════════════════════════════════

/**
 * LLM-first 分類（async）
 *
 * Layer 1: 顯式 [pipeline:xxx] → 直接返回
 * Layer 2: LLM 語意分類 → 主要路徑
 * Fallback: API 不可用 → none + 提示
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

  // Layer 2: LLM 分類
  const llmResult = await classifyWithLLM(prompt);
  if (llmResult) {
    return llmResult;
  }

  // Fallback: API 不可用
  return { pipeline: 'none', confidence: 0, source: 'fallback', matchedRule: 'api-unavailable' };
}

/**
 * 產生 Pipeline 目錄提示（Fallback 時注入 additionalContext）
 * @returns {string}
 */
function buildPipelineCatalogHint() {
  const catalog = Object.entries(PIPELINES)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => `  [pipeline:${id}] — ${p.label}：${p.description}`)
    .join('\n');

  return '\n💡 LLM 分類器不可用。可在 prompt 中加上語法覆寫：\n' + catalog;
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 主要 API（async）
  classifyWithConfidence,
  classifyWithLLM,

  // 工具函式
  extractExplicitPipeline,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,

  // 常量（供測試）
  LLM_MODEL,
  LLM_TIMEOUT,
};
