#!/usr/bin/env node
/**
 * suggest-compact.js — PreToolUse hook
 *
 * 1. 追蹤 tool calls 數量，達閾值後建議 compact。
 * 2. 發射 tool.used 事件到 Timeline（完整記錄所有工具呼叫）。
 * 不阻擋任何工具執行。
 */
'use strict';
const path = require('path');
const { increment } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

/**
 * 從 tool_input 提取關鍵資訊（避免記錄完整 content/command）
 */
function extractToolInfo(toolName, toolInput) {
  const info = { tool: toolName };
  switch (toolName) {
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      if (toolInput.file_path) info.file = path.basename(toolInput.file_path);
      break;
    case 'Bash':
      if (toolInput.command) info.command = toolInput.command.slice(0, 80);
      break;
    case 'Glob':
      if (toolInput.pattern) info.pattern = toolInput.pattern;
      break;
    case 'Grep':
      if (toolInput.pattern) info.pattern = toolInput.pattern;
      break;
    case 'Skill':
      if (toolInput.skill) info.skill = toolInput.skill;
      break;
    case 'WebFetch':
      if (toolInput.url) info.url = toolInput.url.slice(0, 120);
      break;
    case 'WebSearch':
      if (toolInput.query) info.query = toolInput.query.slice(0, 80);
      break;
    case 'AskUserQuestion':
      info.questionCount = (toolInput.questions || []).length;
      break;
  }
  return info;
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    // 1. tool.used 事件（Task 由 delegation-tracker 處理）
    if (toolName && toolName !== 'Task') {
      emit(EVENT_TYPES.TOOL_USED, sessionId, extractToolInfo(toolName, toolInput));
    }

    // 2. Compact 計數與提醒（原有邏輯）
    const result = increment(sessionId);

    if (result.shouldRemind && result.message) {
      emit(EVENT_TYPES.COMPACT_SUGGESTED, sessionId, {
        count: result.count,
        threshold: result.threshold,
      });
      console.log(JSON.stringify({ systemMessage: result.message }));
    }
  } catch (err) {
    hookLogger.error('suggest-compact', err);
  }
});
