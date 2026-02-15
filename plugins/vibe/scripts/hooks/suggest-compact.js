#!/usr/bin/env node
/**
 * suggest-compact.js — PreToolUse hook
 *
 * 1. 追蹤 tool calls 數量，達閾值後建議 compact。
 * 2. 發射 tool.used 事件到 Timeline（完整記錄所有工具呼叫）。
 * 不阻擋任何工具執行。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { increment } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

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
    default:
      // MCP 工具：額外記錄 server 和 method
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        if (parts.length >= 3) {
          let server = parts[1];
          if (server.startsWith('plugin_')) {
            server = server.replace(/^plugin_/, '').replace(/_mcp.*$/, '');
          }
          info.mcpServer = server;
          info.mcpMethod = parts[parts.length - 1];
        }
      }
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
      const info = extractToolInfo(toolName, toolInput);
      // 嵌入當前 stage 和 delegation 狀態（供 replay 時正確顯示 emoji）
      try {
        const stateFile = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
        if (fs.existsSync(stateFile)) {
          const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (st.currentStage) info.stage = st.currentStage;
          if (st.delegationActive) info.delegationActive = true;
        }
      } catch (_) {}
      emit(EVENT_TYPES.TOOL_USED, sessionId, info);
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
