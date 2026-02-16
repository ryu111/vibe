/**
 * verdict.js — Verdict 解析（純函式）
 *
 * 從 agent transcript 中解析 PIPELINE_VERDICT 標記。
 * 品質階段（REVIEW/TEST/QA/E2E）的 agent 在完成時輸出：
 *   <!-- PIPELINE_VERDICT: PASS -->
 *   <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->
 *
 * @module flow/verdict
 */
'use strict';

const fs = require('fs');
const { VERDICT_REGEX } = require('../registry.js');

/**
 * 從 agent transcript 中解析最後的 PIPELINE_VERDICT 標記
 * @param {string} transcriptPath - JSONL transcript 路徑
 * @returns {{ verdict: string, severity: string|null } | null}
 */
function parseVerdict(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // 從後往前搜尋（verdict 通常在最後幾行）
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const text = JSON.stringify(entry);
        const match = text.match(VERDICT_REGEX);
        if (match) {
          const [, full] = match;
          if (full === 'PASS') return { verdict: 'PASS', severity: null };
          const parts = full.split(':');
          return { verdict: 'FAIL', severity: parts[1] || 'HIGH' };
        }
      } catch (_) { /* 跳過非 JSON 行 */ }
    }
  } catch (_) {}

  return null;
}

module.exports = { parseVerdict };
