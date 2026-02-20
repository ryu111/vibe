#!/usr/bin/env node
/**
 * status-writer.js — FIC 狀態壓縮（S5 Context 效率 + Crash Recovery）
 *
 * 每個 stage PASS 後生成壓縮狀態摘要，寫入 pipeline-status-{sid}.md。
 * 於 Compact/Resume 時注入 additionalContext，降低 Main Agent 的 context 消耗。
 *
 * 設計原則：
 * - generateStatus：純函式，從 state 產生 Markdown 摘要（包含 wisdom 決策記錄）
 * - updateStatus：writeFileSync（不需 atomicWrite，覆寫摘要即可）
 * - readStatus：讀取摘要供 resume/compact 注入
 *
 * @module flow/status-writer
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readWisdom } = require('./wisdom.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 時間計算常數
const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

// ────────────────── getStatusPath ──────────────────

/**
 * 取得 pipeline-status-{sessionId}.md 路徑。
 *
 * @param {string} sessionId - session 識別碼
 * @returns {string} 完整路徑
 */
function getStatusPath(sessionId) {
  return path.join(CLAUDE_DIR, `pipeline-status-${sessionId}.md`);
}

// ────────────────── generateStatus ──────────────────

/**
 * 從 pipeline state 產生 Markdown 狀態摘要。
 *
 * 輸出格式：
 * ```markdown
 * # Pipeline Status [{pipelineId}] — Session {shortId}
 *
 * ## 已完成
 * - [x] PLAN: PASS
 * - [x] DEV: PASS
 *
 * ## 進行中
 * - [ ] REVIEW: 等待委派
 *
 * ## 決策記錄
 * （從 wisdom 提取，如果有的話）
 * ```
 *
 * @param {object} state - v4 pipeline state
 * @param {string} [wisdomContent] - 可選的 wisdom 內容（readWisdom 回傳值）
 * @returns {string} Markdown 格式的狀態摘要
 */
function generateStatus(state, wisdomContent) {
  if (!state || typeof state !== 'object') return '';

  const pipelineId = state.classification?.pipelineId || 'unknown';
  // sessionId 儲存在 state 頂層（非 state.meta），與 createInitialState 一致
  const sessionId = state.sessionId || '';
  const shortId = sessionId ? sessionId.slice(0, 8) : 'unknown';

  const stages = state.stages || {};
  const dag = state.dag || {};

  // 依 DAG 順序排列 stage（如無 DAG，按 Object.keys 順序）
  const stageIds = Object.keys(stages);

  const completed = [];
  const inProgress = [];
  const pending = [];

  for (const stageId of stageIds) {
    const stageInfo = stages[stageId];
    const status = stageInfo?.status || 'pending';

    if (status === 'completed' || status === 'skipped') {
      const verdict = stageInfo?.verdict || 'PASS';
      const timestamp = stageInfo?.completedAt;
      const timeStr = timestamp ? _formatRelativeTime(timestamp) : '';
      const timeLabel = timeStr ? ` (${timeStr})` : '';
      completed.push(`- [x] ${stageId}: ${verdict}${timeLabel}`);
    } else if (status === 'active') {
      inProgress.push(`- [ ] ${stageId}: 執行中`);
    } else {
      // pending 或 failed
      const isReady = _isStageReady(stageId, stages, dag);
      if (status === 'failed') {
        inProgress.push(`- [ ] ${stageId}: FAIL（待重試）`);
      } else if (isReady) {
        pending.push(`- [ ] ${stageId}: 等待委派`);
      } else {
        pending.push(`- [ ] ${stageId}: 等待依賴`);
      }
    }
  }

  const lines = [];
  lines.push(`# Pipeline Status [${pipelineId}] — Session ${shortId}`);
  lines.push('');

  if (completed.length > 0) {
    lines.push('## 已完成');
    lines.push(...completed);
    lines.push('');
  }

  if (inProgress.length > 0) {
    lines.push('## 進行中');
    lines.push(...inProgress);
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push('## 待執行');
    lines.push(...pending);
    lines.push('');
  }

  // 決策記錄（從 wisdom 提取）
  if (wisdomContent && typeof wisdomContent === 'string' && wisdomContent.trim()) {
    lines.push('## 決策記錄');
    lines.push(wisdomContent.trim());
    lines.push('');
  }

  return lines.join('\n');
}

// ────────────────── updateStatus ──────────────────

/**
 * 更新狀態摘要，寫入 pipeline-status-{sid}.md。
 *
 * 會嘗試讀取 wisdom 內容並整合到摘要中。
 * 非關鍵路徑：呼叫方應以 try-catch 包裹。
 *
 * @param {string} sessionId - session 識別碼
 * @param {object} state - v4 pipeline state
 */
function updateStatus(sessionId, state) {
  if (!sessionId || !state) return;

  try {
    // 嘗試讀取 wisdom 作為決策記錄
    let wisdomContent = null;
    try {
      wisdomContent = readWisdom(sessionId);
    } catch (_) {
      // wisdom 讀取失敗不影響狀態摘要
    }

    const content = generateStatus(state, wisdomContent);
    if (!content) return;

    // 確保 CLAUDE_DIR 存在
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }

    fs.writeFileSync(getStatusPath(sessionId), content, 'utf8');
  } catch (_) {
    // 非關鍵路徑，靜默忽略
  }
}

// ────────────────── readStatus ──────────────────

/**
 * 讀取狀態摘要（resume/compact 用）。
 *
 * @param {string} sessionId - session 識別碼
 * @returns {string|null} 狀態摘要內容，或 null（檔案不存在/空）
 */
function readStatus(sessionId) {
  if (!sessionId) return null;

  try {
    const p = getStatusPath(sessionId);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf8').trim();
    return content || null;
  } catch (_) {
    return null;
  }
}

// ────────────────── 輔助函式 ──────────────────

/**
 * 判斷 stage 的依賴是否都已完成（pending → ready 條件）。
 *
 * @param {string} stageId
 * @param {object} stages - state.stages
 * @param {object} dag - state.dag
 * @returns {boolean}
 */
function _isStageReady(stageId, stages, dag) {
  const deps = dag[stageId]?.deps || [];
  if (deps.length === 0) return true;
  return deps.every(dep => {
    const depStatus = stages[dep]?.status;
    return depStatus === 'completed' || depStatus === 'skipped';
  });
}

/**
 * 格式化相對時間（如：3 分鐘前、2 小時前）。
 *
 * @param {string} isoTimestamp - ISO 時間字串
 * @returns {string} 相對時間描述
 */
function _formatRelativeTime(isoTimestamp) {
  try {
    const elapsed = Date.now() - new Date(isoTimestamp).getTime();
    if (isNaN(elapsed) || elapsed < 0) return '';

    const minutes = Math.floor(elapsed / MS_PER_MINUTE);
    if (minutes < 1) return '剛剛';
    if (minutes < MINUTES_PER_HOUR) return `${minutes} 分鐘前`;
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    if (hours < HOURS_PER_DAY) return `${hours} 小時前`;
    const days = Math.floor(hours / HOURS_PER_DAY);
    return `${days} 天前`;
  } catch (_) {
    return '';
  }
}

// ────────────────── Exports ──────────────────

module.exports = {
  generateStatus,
  updateStatus,
  readStatus,
  getStatusPath,
};
