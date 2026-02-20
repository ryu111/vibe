#!/usr/bin/env node
/**
 * wisdom.js — 跨 Stage 知識傳遞（S4 Wisdom Accumulation）
 *
 * 品質 stage（REVIEW/TEST/QA/E2E）PASS 後，將學習筆記寫入
 * pipeline-wisdom-{sid}.md，後續 stage 委派時讀取注入到 Node Context。
 *
 * 設計原則：
 * - extractWisdom：純文字處理，從 context_file 內容提取結構化摘要
 * - writeWisdom：appendFileSync 追加（不需 atomicWrite，追加不覆寫）
 * - readWisdom：讀取並截斷到 MAX_WISDOM_CHARS
 *
 * @module flow/wisdom
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 整份 wisdom 檔案截斷上限（500 chars 約 3~5 個 stage 筆記）
const MAX_WISDOM_CHARS = 500;

// 單一 stage wisdom 截斷上限
const MAX_STAGE_WISDOM_CHARS = 200;

// 無要點時的 fallback 截斷字元數（避免 wisdom 過長）
const MAX_FALLBACK_SUMMARY_CHARS = 150;

// ────────────────── getWisdomPath ──────────────────

/**
 * 取得 pipeline-wisdom-{sessionId}.md 路徑。
 *
 * @param {string} sessionId - session 識別碼
 * @returns {string} 完整路徑
 */
function getWisdomPath(sessionId) {
  return path.join(CLAUDE_DIR, `pipeline-wisdom-${sessionId}.md`);
}

// ────────────────── extractWisdom ──────────────────

/**
 * 從 context_file 內容提取結構化摘要。
 *
 * 提取策略：
 * 1. 尋找 markdown 要點（`- ` 開頭的行）作為主要來源
 * 2. 無要點時，取前兩段文字（最多 150 chars）
 * 3. 截斷到 MAX_STAGE_WISDOM_CHARS
 *
 * @param {string} stageId - stage ID（如 'REVIEW' 或 'REVIEW:1'）
 * @param {string} contextContent - context_file 的文字內容
 * @returns {{ stage: string, summary: string }|null}
 */
function extractWisdom(stageId, contextContent) {
  if (!stageId || !contextContent || typeof contextContent !== 'string') return null;

  const trimmed = contextContent.trim();
  if (!trimmed) return null;

  // 提取 markdown 要點（`- ` 開頭的行，去除重複空白）
  const bulletLines = trimmed
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ') && l.length > 3)
    .slice(0, 5); // 最多 5 個要點

  let summary;

  if (bulletLines.length > 0) {
    // 有要點：組合要點直到達到上限
    const combined = bulletLines.join('\n');
    summary = combined.length > MAX_STAGE_WISDOM_CHARS
      ? combined.slice(0, MAX_STAGE_WISDOM_CHARS - 3) + '...'
      : combined;
  } else {
    // 無要點：取前 MAX_FALLBACK_SUMMARY_CHARS chars 的非空行
    const firstLines = trimmed
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
      .slice(0, 3)
      .join(' ');

    const raw = firstLines.length > MAX_FALLBACK_SUMMARY_CHARS
      ? firstLines.slice(0, MAX_FALLBACK_SUMMARY_CHARS - 3) + '...'
      : firstLines;
    summary = raw.length > MAX_STAGE_WISDOM_CHARS
      ? raw.slice(0, MAX_STAGE_WISDOM_CHARS - 3) + '...'
      : raw;
  }

  if (!summary) return null;

  return { stage: stageId, summary };
}

// ────────────────── writeWisdom ──────────────────

/**
 * 追加 wisdom 到 pipeline-wisdom-{sid}.md。
 *
 * 格式：
 * ```markdown
 * ## REVIEW
 * - 要點 1
 * - 要點 2
 * ```
 *
 * @param {string} sessionId - session 識別碼
 * @param {string} stageId - stage ID（如 'REVIEW:1'）
 * @param {string} summary - extractWisdom 回傳的 summary 字串
 */
function writeWisdom(sessionId, stageId, summary) {
  if (!sessionId || !stageId || !summary) return;

  try {
    const filePath = getWisdomPath(sessionId);
    // 確保 CLAUDE_DIR 存在
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    const block = `## ${stageId}\n${summary}\n\n`;
    fs.appendFileSync(filePath, block, 'utf8');
  } catch (_) {
    // 寫入失敗靜默忽略（非關鍵路徑）
  }
}

// ────────────────── readWisdom ──────────────────

/**
 * 讀取 pipeline-wisdom-{sid}.md 並截斷到 MAX_WISDOM_CHARS。
 *
 * @param {string} sessionId - session 識別碼
 * @returns {string|null} wisdom 內容，或 null（檔案不存在/空）
 */
function readWisdom(sessionId) {
  if (!sessionId) return null;

  try {
    const filePath = getWisdomPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return null;

    // 截斷到 MAX_WISDOM_CHARS
    if (content.length > MAX_WISDOM_CHARS) {
      return content.slice(0, MAX_WISDOM_CHARS - 3) + '...';
    }
    return content;
  } catch (_) {
    return null;
  }
}

// ────────────────── Exports ──────────────────

module.exports = {
  extractWisdom,
  writeWisdom,
  readWisdom,
  getWisdomPath,
  MAX_WISDOM_CHARS,
  MAX_STAGE_WISDOM_CHARS,
  MAX_FALLBACK_SUMMARY_CHARS,
};
