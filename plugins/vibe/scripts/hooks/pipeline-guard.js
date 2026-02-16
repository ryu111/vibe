#!/usr/bin/env node
/**
 * pipeline-guard.js — PreToolUse hook (unified)
 * Matcher: Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode|Bash
 *
 * v1.0.43 重構：精簡為純代理層。
 * 所有決策邏輯（含前置放行條件）統一在 guard-rules.js evaluate() 中。
 * 此 hook 只負責：讀 state → 呼叫 evaluate → 執行結果。
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

    // 讀取 pipeline state
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (!fs.existsSync(statePath)) process.exit(0);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // evaluate() 統一處理所有前置條件 + 工具規則
    const result = evaluate(toolName, toolInput, state);

    if (result.decision === 'allow') process.exit(0);

    // block → 發送 timeline 事件 + 硬阻擋
    emit(EVENT_TYPES.TOOL_BLOCKED, sessionId, {
      tool: toolName,
      filePath: toolInput.file_path,
      command: toolName === 'Bash' ? (toolInput.command || '').slice(0, 100) : undefined,
      matchedPattern: result.matchedPattern,
      reason: result.reason || 'pipeline-guard',
    });

    process.stderr.write(result.message || '⛔ Pipeline 模式下禁止此操作。\n');
    process.exit(2);
  } catch (err) {
    hookLogger.error('pipeline-guard', err);
  }
});
