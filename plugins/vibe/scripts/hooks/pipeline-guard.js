#!/usr/bin/env node
/**
 * pipeline-guard.js — PreToolUse hook (unified)
 * Matcher: Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode
 *
 * Pipeline 模式下統一管理 Main Agent 的工具使用限制。
 * 統一 dev-gate、ask-gate、plan-mode-gate 為一個 hook。
 *
 * 放行條件：
 * - 無 pipeline state → 放行
 * - !initialized / !taskType / !pipelineEnforced → 放行
 * - delegationActive=true → 放行（sub-agent 操作）
 * - cancelled=true → 放行（pipeline 已取消）
 * - Write/Edit/NotebookEdit 且編輯非程式碼檔案 → 放行
 *
 * 阻擋條件：
 * - pipelineEnforced=true + 上述放行條件不滿足 → exit 2
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { evaluate } = require(path.join(__dirname, '..', 'lib', 'sentinel', 'guard-rules.js'));
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const toolName = data.tool_name || 'Unknown';
    const toolInput = data.tool_input || {};

    // 讀取 pipeline state（一次）
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (!fs.existsSync(statePath)) {
      process.exit(0);
    }

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // Pipeline 未初始化 → 放行
    if (!state.initialized) {
      process.exit(0);
    }

    // taskType 尚未分類 → 放行（pipeline-init 先於 task-classifier）
    if (!state.taskType) {
      process.exit(0);
    }

    // 非強制 pipeline 任務 → 放行（flag 由 task-classifier 設定）
    if (!state.pipelineEnforced) {
      process.exit(0);
    }

    // 委派已啟動（Task 已呼叫）→ 放行（sub-agent 正在操作）
    // 注意：EnterPlanMode 是 Main Agent 專屬，不會被 sub-agent 呼叫，
    // 但這裡統一處理 — delegationActive 時即使 EnterPlanMode 也放行（實際不會發生）
    if (state.delegationActive) {
      process.exit(0);
    }

    // Pipeline 已取消 → 放行（ask-gate 邏輯）
    if (state.cancelled) {
      process.exit(0);
    }

    // 呼叫規則模組評估
    const result = evaluate(toolName, toolInput, state);

    if (result.decision === 'allow') {
      process.exit(0);
    }

    // 決策為 block → 發送 timeline 事件 + 阻擋
    emit(EVENT_TYPES.TOOL_BLOCKED, sessionId, {
      tool: toolName,
      filePath: toolInput.file_path,
      reason: result.reason || 'pipeline-guard',
    });

    process.stderr.write(result.message || '⛔ Pipeline 模式下禁止此操作。\n');
    process.exit(2);
  } catch (err) {
    // 解析錯誤 → 放行，不阻擋正常操作
    hookLogger.error('pipeline-guard', err);
  }
});
