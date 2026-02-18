#!/usr/bin/env node
/**
 * reflection.js — Reflexion Memory 管理（v4）
 *
 * 記錄品質階段的回退歷史，供下一輪 agent 讀取改進。
 * 策略：Markdown append 模式，每輪 500 chars 上限，總計 3000 chars 上限。
 *
 * 檔案路徑：~/.claude/reflection-memory-{sessionId}-{stage}.md
 *
 * @module flow/reflection
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('./atomic-write.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 每輪最大字元數
const MAX_ROUND_CHARS = 500;
// 整個 reflection 最大字元數
const MAX_TOTAL_CHARS = 3000;

// ────────────────── 路徑工具 ──────────────────

/**
 * 取得 reflection 檔案路徑
 */
function getReflectionPath(sessionId, stage) {
  return path.join(CLAUDE_DIR, `reflection-memory-${sessionId}-${stage}.md`);
}

// ────────────────── 讀寫操作 ──────────────────

/**
 * 寫入反思記憶（append 模式，每輪加一個 ## Round 區塊）
 *
 * @param {string} sessionId - session 識別碼
 * @param {string} stage - 階段 ID（如 REVIEW、TEST）
 * @param {{ verdict: string, severity?: string, route?: string, hint?: string }|null} verdict - 路由結果
 * @param {number} retryCount - 當前回退輪次（0-indexed）
 */
function writeReflection(sessionId, stage, verdict, retryCount) {
  if (!sessionId || !stage) return;

  // 確保目錄存在
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });

  const filePath = getReflectionPath(sessionId, stage);
  const round = retryCount + 1;
  const now = new Date().toISOString();

  // 組裝本輪內容
  const verdictStr = verdict?.verdict || 'UNKNOWN';
  const severityStr = verdict?.severity ? `:${verdict.severity}` : '';
  const hintStr = verdict?.hint ? `\n**問題摘要**：${verdict.hint}` : '';

  let roundContent =
    `## Round ${round} — ${now}\n` +
    `**Verdict**：${verdictStr}${severityStr}${hintStr}\n`;

  // 截斷單輪內容
  if (roundContent.length > MAX_ROUND_CHARS) {
    roundContent = roundContent.slice(0, MAX_ROUND_CHARS - 3) + '...\n';
  }

  try {
    // 讀取現有內容
    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf8');
    } else {
      // 第一次寫入：加上標題
      existing = `# ${stage} 回退歷史記錄\n\n`;
    }

    // 計算新增後的總長度，超過上限則截斷舊內容
    const combined = existing + roundContent + '\n';
    let finalContent = combined;

    if (finalContent.length > MAX_TOTAL_CHARS) {
      // M-5 修正：改為按 `## Round` 標題分割，保留完整的最近 Round sections，
      //          避免截斷在 Round section 中間導致不完整記錄。
      const title = `# ${stage} 回退歷史記錄\n\n[早期記錄已截斷]\n\n`;
      const budget = MAX_TOTAL_CHARS - title.length - roundContent.length - 1;

      if (budget > 0) {
        // 按 ## Round 標題分割舊 rounds
        const roundSections = existing.split(/(?=## Round )/);
        // 從後往前累積完整 round sections，不在中間斷開
        let kept = '';
        for (let i = roundSections.length - 1; i >= 0; i--) {
          const section = roundSections[i];
          if (kept.length + section.length > budget) break;
          kept = section + kept;
        }
        finalContent = title + kept + roundContent + '\n';
      } else {
        finalContent = title + roundContent + '\n';
      }
    }

    // L-2 修正：改用 atomicWrite 確保寫入安全
    atomicWrite(filePath, finalContent);
  } catch (_) {
    // 寫入失敗不阻擋主流程
  }
}

/**
 * 讀取反思記憶
 *
 * @param {string} sessionId - session 識別碼
 * @param {string} failedStage - 失敗的階段 ID
 * @returns {string|null} Markdown 內容，不存在時回 null
 */
function readReflection(sessionId, failedStage) {
  if (!sessionId || !failedStage) return null;

  const filePath = getReflectionPath(sessionId, failedStage);
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * 清理指定 session 的所有反思檔案
 *
 * @param {string} sessionId - session 識別碼
 */
function cleanReflections(sessionId) {
  if (!sessionId) return;

  try {
    const prefix = `reflection-memory-${sessionId}-`;
    const files = fs.readdirSync(CLAUDE_DIR).filter(
      f => f.startsWith(prefix) && f.endsWith('.md')
    );
    for (const f of files) {
      try { fs.unlinkSync(path.join(CLAUDE_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

/**
 * PASS 後刪除特定 stage 的反思（清理已修復的問題歷史）
 *
 * @param {string} sessionId - session 識別碼
 * @param {string} stage - 已通過的階段 ID
 */
function cleanReflectionForStage(sessionId, stage) {
  if (!sessionId || !stage) return;

  const filePath = getReflectionPath(sessionId, stage);
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ────────────────── Exports ──────────────────

module.exports = {
  writeReflection,
  readReflection,
  cleanReflections,
  cleanReflectionForStage,
  getReflectionPath,
  MAX_ROUND_CHARS,
  MAX_TOTAL_CHARS,
};
