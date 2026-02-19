#!/usr/bin/env node
/**
 * classifier.js — Pipeline 分類器
 *
 * 三層架構：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度，零成本）
 *   Layer 1.5: Regex Heuristic — 中英文關鍵字模式匹配（高信心度，零成本）
 *   Layer 2:  Main Agent 自主判斷（有完整 context，透過 systemMessage 強制分類指令）
 *
 * Layer 1.5 解決 -p 模式下 Main Agent 自主分類不可靠的問題：
 *   模型在單次回應中傾向直接回答而非先呼叫 /vibe:pipeline。
 *   regex 分類讓明確的編碼任務直接進入正確 pipeline，
 *   只有真正模糊的 prompt 才 fallback 到 Layer 2。
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

// ═══════════════════════════════════════════════
// Layer 1.5: Regex Heuristic
// ═══════════════════════════════════════════════

/**
 * 純問答偵測：prompt 看起來像研究/問答而非編碼任務
 */
const QUESTION_PATTERNS = [
  /^.{0,10}(有幾個|有哪些|是什麼|怎麼|如何|為什麼|什麼是|列出|說明|解釋|分析|比較)/,
  /\?$/,
  /(幾個|幾種|哪些).{0,15}[？?]?$/,
];

/**
 * 檔案路徑偵測：prompt 中是否包含明確的檔案路徑
 */
const FILE_PATH_PATTERN = /(?:plugins\/|scripts\/|src\/|lib\/|docs\/|tests?\/)\S+\.\w+/;

/**
 * 分類規則（按優先級排列）
 * 每條規則：{ pattern, pipeline, id }
 * pattern 可以是 RegExp 或 RegExp[]（any match）
 *
 * 設計原則：Heuristic 只分類到單階段 pipeline（fix/docs-only/none）。
 * 多階段 pipeline（standard/quick-dev）需要模型完整 context 才能判斷——
 * 在 -p 模式下，模型無法可靠地執行多階段委派，因此多階段交由
 * Layer 2（Main Agent systemMessage 自主判斷）處理。
 */
const HEURISTIC_RULES = [
  // system-feedback: pipeline 系統回饋（stop hook reason / delegation hint / 系統通知）
  // stop hook 的 decision:"block" reason 會成為新 prompt → 必須在最前面攔截
  // 涵蓋：⛔ block reason + ⚠️ 警告 + background task 完成通知
  { id: 'system-feedback', pipeline: 'none',
    test: (p) => {
      const t = p.trim();
      // Hook block reason 前綴（pipeline-check / stage-transition 等）
      if (/^[⛔⚠️]/.test(t)) return true;
      // 系統通知模式（background task 結果、agent 回報、自動化觸發）
      if (/^(Background task|Task .+ (completed|finished|failed)|Result from|Output from)/i.test(t)) return true;
      return false;
    }},

  // none: 純問答（最先匹配，避免誤分類）
  { id: 'question', pipeline: 'none',
    test: (p) => QUESTION_PATTERNS.some(r => r.test(p)) && !FILE_PATH_PATTERN.test(p) },

  // docs-only: 更新/撰寫文件（1 階段）
  { id: 'docs', pipeline: 'docs-only',
    test: (p) => /(?:更新|撰寫|補[上完]|修[改正訂])\s*(?:docs?|文[件檔]|README|CHANGELOG|JSDoc|註解|說明)/i.test(p) &&
                 !/(程式碼|code|函式|模組|function|module)/i.test(p) },

  // fix: 一行修改/改常量/改設定（1 階段）
  { id: 'fix-change', pipeline: 'fix',
    test: (p) => /(?:改[成為]|換成|替換|從\s*\S+\s*改|寫死.*改|常[量數].*改|把.*改)/.test(p) &&
                 !/(?:重構|refactor|新增.*模組|新增.*功能)/i.test(p) },

  // fix: 修復/修正 bug（1 階段 — 多階段 quick-dev 交由 Layer 2）
  // 排除系統通知、背景任務完成、hook 回饋等非使用者意圖的 prompt
  { id: 'bugfix', pipeline: 'fix',
    test: (p) => /(?:修復|修正|fix|bug|邊界[條情]|防禦性|補[完上加].*測試|加[上入].*處理)/i.test(p) &&
                 !/(completed|已完成|finished|已結束|status|背景|background|通知|notification|pipeline|禁止停止|尚未完成)/i.test(p) },

  // 新增/建立/重構 → 不在 heuristic 層分類（需要完整 context 判斷 pipeline 規模）
  // 交由 Layer 2 Main Agent 根據對話 context 自主選擇 standard/quick-dev/fix
];

/**
 * 用 regex heuristic 分類
 * @param {string} prompt
 * @returns {{ pipeline: string, confidence: number, matchedRule: string } | null}
 */
function classifyByHeuristic(prompt) {
  const p = prompt.trim();
  for (const rule of HEURISTIC_RULES) {
    if (rule.test(p)) {
      return { pipeline: rule.pipeline, confidence: 0.7, matchedRule: `heuristic:${rule.id}` };
    }
  }
  return null;
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
 * Layer 1.5: Regex heuristic → 關鍵字匹配
 * Layer 2:   交給 Main Agent 判斷（透過 systemMessage 提示 pipeline 選項）
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

  // Layer 1.5: Regex heuristic
  const heuristic = classifyByHeuristic(prompt);
  if (heuristic) {
    return { pipeline: heuristic.pipeline, confidence: heuristic.confidence, source: 'heuristic', matchedRule: heuristic.matchedRule };
  }

  // Layer 2: 交給 Main Agent（它有完整對話 context）
  return { pipeline: 'none', confidence: 0, source: 'main-agent', matchedRule: 'main-agent' };
}

// 顯示優先級較高的 pipeline（數字越高越常用），用於無 pipelineId 時的 fallback 選單
const PRIORITY_ORDER = ['quick-dev', 'standard', 'fix', 'full', 'test-first', 'docs-only', 'ui-only', 'review-only', 'security'];

// 相鄰窗口大小（currentPipelineId 上下各取幾個相關）
const CATALOG_WINDOW = 2;

/**
 * 產生 Pipeline 目錄提示（供 systemMessage + additionalContext 注入 Main Agent）
 *
 * 裁剪規則：
 * - 有 currentPipelineId：取當前 pipeline 同類 + 相鄰優先級的最多 5 個
 * - 無 currentPipelineId（none 分支）：列最常用的 5 個 + fallback 提示
 *
 * @param {string|null} currentPipelineId - 當前已分類的 pipeline ID（可選）
 * @returns {string}
 */
function buildPipelineCatalogHint(currentPipelineId) {
  const allIds = PRIORITY_ORDER.filter(id => PIPELINES[id]);

  let selectedIds;
  if (currentPipelineId && PIPELINES[currentPipelineId] && currentPipelineId !== 'none') {
    // 有 pipelineId：以當前為中心，取上下 CATALOG_WINDOW 個相鄰 pipeline
    const idx = allIds.indexOf(currentPipelineId);
    if (idx >= 0) {
      const start = Math.max(0, idx - CATALOG_WINDOW);
      const end = Math.min(allIds.length, idx + CATALOG_WINDOW + 1);
      // 排除自身，只顯示相鄰的其他 pipeline
      selectedIds = allIds.slice(start, end).filter(id => id !== currentPipelineId);
    } else {
      // 不在 PRIORITY_ORDER 中（如自訂 pipeline）→ 退回最常用 5 個
      selectedIds = allIds.slice(0, 5);
    }
    // 最多 5 個
    if (selectedIds.length > 5) selectedIds = selectedIds.slice(0, 5);
  } else {
    // 無 pipelineId → 最常用的 5 個
    selectedIds = allIds.slice(0, 5);
  }

  const catalog = selectedIds
    .map(id => `  [pipeline:${id}] — ${PIPELINES[id].label}：${PIPELINES[id].description}`)
    .join('\n');

  return '\n可用 pipeline：\n' + catalog + '\n（完整清單見 /vibe:pipeline）';
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 主要 API（async）
  classifyWithConfidence,

  // 工具函式
  extractExplicitPipeline,
  classifyByHeuristic,
  mapTaskTypeToPipeline,
  buildPipelineCatalogHint,
};
