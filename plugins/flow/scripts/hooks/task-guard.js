#!/usr/bin/env node
/**
 * task-guard.js — Stop hook
 *
 * 未完成任務時阻擋 Claude 結束回合。
 * 強度：絕對阻擋（decision: "block"）。
 *
 * TodoWrite 狀態讀取：透過 transcript_path 解析 JSONL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MAX_BLOCKS_DEFAULT = 5;
const MAX_BLOCKS = parseInt(process.env.CLAUDE_TASK_GUARD_MAX_BLOCKS || MAX_BLOCKS_DEFAULT, 10);

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 1. 防迴圈
    if (data.stop_hook_active) {
      process.exit(0);
    }

    const sessionId = data.session_id || 'unknown';
    const transcriptPath = data.transcript_path;
    const statePath = path.join(CLAUDE_DIR, `task-guard-state-${sessionId}.json`);

    // 2. 讀取 transcript，找最後一次 TodoWrite
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.exit(0);
    }

    const transcript = fs.readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter(Boolean);

    let lastTodoWrite = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(transcript[i]);
        // 嘗試多種可能的欄位名稱
        const toolName = entry.tool || entry.toolName || entry.tool_name || '';
        if (toolName === 'TodoWrite') {
          lastTodoWrite = entry;
          break;
        }
      } catch (_) { continue; }
    }

    // 3. 無 TodoWrite → 不阻擋
    if (!lastTodoWrite) {
      cleanup(statePath);
      process.exit(0);
    }

    // 解析 todos
    const todos = lastTodoWrite.input?.todos
      || lastTodoWrite.params?.todos
      || lastTodoWrite.arguments?.todos
      || [];

    if (todos.length === 0) {
      cleanup(statePath);
      process.exit(0);
    }

    // 4. 讀取 state file
    let state = { blockCount: 0, maxBlocks: MAX_BLOCKS, cancelled: false };
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 5. 手動取消
    if (state.cancelled) {
      cleanup(statePath);
      process.exit(0);
    }

    // 6. 安全閥
    if (state.blockCount >= (state.maxBlocks || MAX_BLOCKS)) {
      process.stderr.write(`task-guard: 已達到最大阻擋次數（${state.blockCount}），強制放行。\n`);
      cleanup(statePath);
      process.exit(0);
    }

    // 7. 檢查任務完成度
    const incomplete = todos.filter(t => t.status !== 'completed');
    if (incomplete.length === 0) {
      cleanup(statePath);
      process.exit(0);
    }

    // 8. 阻擋！
    state.blockCount = (state.blockCount || 0) + 1;
    state.activatedAt = state.activatedAt || new Date().toISOString();

    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const todoList = incomplete
      .map(t => `- [ ] ${t.content}`)
      .join('\n');

    console.log(JSON.stringify({
      decision: 'block',
      reason: '繼續完成未完成的任務',
      systemMessage: `⚠️ 任務尚未完成（第 ${state.blockCount}/${state.maxBlocks || MAX_BLOCKS} 次阻擋）\n\n未完成項目：\n${todoList}\n\n請繼續完成以上項目。如果確實無法繼續，請告知使用者原因。`,
    }));
  } catch (err) {
    // 錯誤時不阻擋
    process.stderr.write(`task-guard: ${err.message}\n`);
  }
});

function cleanup(statePath) {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch (_) {}
}
