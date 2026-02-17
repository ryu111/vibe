#!/usr/bin/env node
/**
 * log-compact.js — PreCompact hook
 *
 * 1. 記錄 compact 事件 + 重設 tool call 計數器。
 * 2. 注入智慧摘要（additionalContext）引導壓縮保留重要 context。
 *    - trigger=auto：注入完整 pipeline 摘要 + git 摘要
 *    - trigger=manual：使用者已提供 hint，只補充 pipeline 狀態
 */
'use strict';
const path = require('path');
const { execSync } = require('child_process');
const { reset } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ds = require(path.join(__dirname, '..', 'lib', 'flow', 'dag-state.js'));

/**
 * 從 pipeline state 提取進度摘要
 */
function getPipelineSummary(sessionId) {
  try {
    const st = ds.readState(sessionId);
    if (!st || !st.dag) return null;

    const pipelineId = st.classification?.pipelineId || '未知';
    const taskType = st.classification?.taskType || '';
    const stageIds = Object.keys(st.dag);
    const stages = st.stages || {};

    // 各階段狀態
    const stageLines = stageIds.map(id => {
      const status = stages[id]?.status || 'pending';
      const verdict = stages[id]?.verdict;
      const emoji = status === 'completed' ? '✅'
        : status === 'active' ? '🔄'
        : status === 'failed' ? '❌'
        : status === 'skipped' ? '⏭️'
        : '⏳';
      let label = `${emoji} ${id}`;
      if (verdict) {
        const v = typeof verdict === 'object' ? verdict.verdict : verdict;
        if (v) label += ` (${v})`;
      }
      return label;
    });

    // pendingRetry
    const retryInfo = st.pendingRetry
      ? `回退中：${st.pendingRetry.stage}（原因：${st.pendingRetry.severity || 'FAIL'}）`
      : null;

    const lines = [
      `Pipeline: ${pipelineId}${taskType ? ` (${taskType})` : ''}`,
      `進度: ${stageLines.join(' → ')}`,
    ];
    if (retryInfo) lines.push(retryInfo);

    return lines.join('\n');
  } catch (_) {
    return null;
  }
}

/**
 * 從 git 提取最近修改的檔案摘要
 */
function getGitSummary(cwd) {
  try {
    // 最近修改的檔案（未 commit + 最近 commit）
    const diffFiles = execSync('git diff --name-only HEAD 2>/dev/null || true', {
      cwd, encoding: 'utf8', timeout: 3000,
    }).trim().split('\n').filter(Boolean);

    const recentFiles = execSync('git diff --name-only HEAD~5..HEAD 2>/dev/null || true', {
      cwd, encoding: 'utf8', timeout: 3000,
    }).trim().split('\n').filter(Boolean);

    const allFiles = [...new Set([...diffFiles, ...recentFiles])].slice(0, 15);
    if (allFiles.length === 0) return null;

    return `修改檔案: ${allFiles.join(', ')}`;
  } catch (_) {
    return null;
  }
}

/**
 * 從 TaskList 提取未完成任務（讀 transcript 太慢，用 pipeline stages 代替）
 */
function getPendingWork(sessionId) {
  try {
    const st = ds.readState(sessionId);
    if (!st || !st.dag || !st.stages) return null;

    const pending = Object.keys(st.dag).filter(id => {
      const s = st.stages[id]?.status;
      return s === 'pending' || s === 'active';
    });

    if (pending.length === 0) return null;
    return `待完成階段: ${pending.join(', ')}`;
  } catch (_) {
    return null;
  }
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const trigger = data.trigger || 'auto';
    const cwd = data.cwd || process.cwd();

    // 1. Timeline 事件 + 計數器重設
    emit(EVENT_TYPES.COMPACT_EXECUTED, sessionId, {
      sessionId,
      trigger,
    });
    reset(sessionId);

    // 2. 智慧摘要注入
    const sections = [];

    const pipelineSummary = getPipelineSummary(sessionId);
    if (pipelineSummary) sections.push(pipelineSummary);

    // auto 模式：完整摘要（使用者沒提供 hint）
    // manual 模式：只補 pipeline 狀態（使用者已提供 hint）
    if (trigger === 'auto') {
      const gitSummary = getGitSummary(cwd);
      if (gitSummary) sections.push(gitSummary);

      const pendingWork = getPendingWork(sessionId);
      if (pendingWork) sections.push(pendingWork);
    }

    if (sections.length > 0) {
      const summary = `[Compact 摘要]\n${sections.join('\n')}`;
      console.log(JSON.stringify({ additionalContext: summary }));
    }
  } catch (err) {
    hookLogger.error('log-compact', err);
  }
});
