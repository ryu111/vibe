#!/usr/bin/env node
/**
 * ask-gate.js — PreToolUse hook (matcher: AskUserQuestion)
 *
 * Pipeline 模式下，阻擋 Main Agent 使用 AskUserQuestion。
 * Pipeline 是全自動閉環流程：stage-transition 指示下一步 → 直接執行，
 * 不需要也不應該中途詢問使用者。
 *
 * 放行條件：
 * - 無 pipeline state → 放行
 * - pipelineEnforced = false → 放行（非 pipeline 任務 / pipeline 已完成）
 * - pipeline 已取消（cancelled = true）→ 放行
 *
 * 阻擋條件：
 * - pipelineEnforced = true → exit 2
 *
 * 注意：pipeline 完成時 stage-transition 會設 pipelineEnforced=false，自然放行。
 *
 * 強度：硬阻擋（exit 2）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    // 讀取 pipeline state
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (!fs.existsSync(statePath)) {
      process.exit(0);
    }

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // Pipeline 未初始化 → 放行
    if (!state.initialized) {
      process.exit(0);
    }

    // 非強制 pipeline → 放行
    if (!state.pipelineEnforced) {
      process.exit(0);
    }

    // Pipeline 已取消 → 放行
    if (state.cancelled) {
      process.exit(0);
    }

    // pipelineEnforced=true + 非取消 + 已初始化 → 阻擋
    // 注意：pipeline 完成時 stage-transition 會設 pipelineEnforced=false，自然放行

    // ⛔ 阻擋：Pipeline 自動模式下不需 AskUserQuestion
    emit(EVENT_TYPES.TOOL_BLOCKED, sessionId, {
      tool: 'AskUserQuestion',
      reason: 'pipeline-auto-mode',
    });

    process.stderr.write(
      '⛔ Pipeline 自動模式：禁止使用 AskUserQuestion。\n' +
      'Pipeline 是全自動閉環流程，stage-transition 會指示下一步。\n' +
      '請直接按照 pipeline 指示執行下一階段。\n' +
      '如需退出 pipeline 自動模式，使用 /vibe:cancel。\n'
    );
    process.exit(2);
  } catch (err) {
    hookLogger.error('ask-gate', err);
  }
});
