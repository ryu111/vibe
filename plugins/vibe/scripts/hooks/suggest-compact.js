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
const { readState: dsReadState, derivePhase, getReadyStages } = require(path.join(__dirname, '..', 'lib', 'flow', 'dag-state.js'));
const { atomicWrite } = require(path.join(__dirname, '..', 'lib', 'flow', 'atomic-write.js'));

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

    // Heartbeat（活性偵測 — Dashboard sidebar 用）
    try { fs.writeFileSync(path.join(CLAUDE_DIR, `heartbeat-${sessionId}`), ''); } catch (_) {}

    // 讀取 pipeline state（只讀一次，後續複用）
    const cachedState = dsReadState(sessionId);

    // 1. tool.used 事件（Task 由 delegation-tracker 處理）
    if (toolName && toolName !== 'Task') {
      const info = extractToolInfo(toolName, toolInput);
      // 嵌入當前 stage 和 delegation 狀態（供 replay 時正確顯示 emoji）
      if (cachedState?.stages) {
        const stage = Object.keys(cachedState.stages).find(s => cachedState.stages[s]?.status === 'active');
        if (stage) info.stage = stage;
        const hasActive = Object.values(cachedState.stages).some(s => s?.status === 'active');
        if (hasActive) info.delegationActive = true;
      }
      emit(EVENT_TYPES.TOOL_USED, sessionId, info);
    }

    // 2. Compact 計數與提醒（原有邏輯）
    const result = increment(sessionId);

    // 收集所有 systemMessage（避免多次 console.log 衝突）
    const systemMessages = [];

    if (result.shouldRemind && result.message) {
      emit(EVENT_TYPES.COMPACT_SUGGESTED, sessionId, {
        count: result.count,
        threshold: result.threshold,
      });
      systemMessages.push(result.message);
    }

    // 3. CLASSIFIED 階段 delegation 提醒（獨立計數檔案，不寫 pipeline state）
    try {
      if (cachedState) {
        const phase = derivePhase(cachedState);
        const countFile = path.join(CLAUDE_DIR, `classified-reads-${sessionId}.json`);

        if (phase === 'CLASSIFIED') {
          // 追蹤連續唯讀呼叫次數（獨立檔案，避免 pipeline state 競態）
          let count = 0;
          try { count = JSON.parse(fs.readFileSync(countFile, 'utf8')).count || 0; } catch (_) {}
          count++;
          atomicWrite(countFile, { count });

          // 間隔提醒（閾值首次 + 之後每 5 次）
          const THRESHOLD = 3;
          if (count === THRESHOLD || (count > THRESHOLD && (count - THRESHOLD) % 5 === 0)) {
            const ready = getReadyStages(cachedState);
            const nextStage = ready[0] || '下一階段';
            const pipelineId = cachedState.classification?.pipelineId || '';
            const pipelineLabel = pipelineId ? ` (${pipelineId})` : '';
            const reminder = `⚠️ Pipeline${pipelineLabel} 已分類完成，已連續 ${count} 次唯讀操作。請使用 Skill 或 Task 工具委派 sub-agent 進行 ${nextStage} 階段。`;
            systemMessages.push(reminder);
          }
        } else if (phase === 'DELEGATING') {
          // 進入委派後刪除計數檔
          try { fs.unlinkSync(countFile); } catch (_) {}
        }
      }
    } catch (_) {}

    // 統一輸出（合併多個 systemMessage）
    if (systemMessages.length > 0) {
      console.log(JSON.stringify({ systemMessage: systemMessages.join('\n\n') }));
    }
  } catch (err) {
    hookLogger.error('suggest-compact', err);
  }
});
