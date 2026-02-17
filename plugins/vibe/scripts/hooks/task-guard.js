#!/usr/bin/env node
/**
 * task-guard.js — Stop hook
 *
 * 未完成任務時阻擋 Claude 結束回合。
 * 強度：絕對阻擋（continue: false）。
 *
 * 任務解析邏輯委託給 lib/task-parser.js（純函式模組）。
 *
 * 完成承諾機制（借鑑 ralph-wiggum plugin）：
 * Claude 可在最後訊息中輸出 <promise>ALL_TASKS_COMPLETE</promise>
 * 強制宣告完成，繞過 TaskUpdate 狀態檢查。
 *
 * 阻擋格式：
 *   { continue: false, stopReason: "描述", systemMessage: "狀態資訊" }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MAX_BLOCKS_DEFAULT = 5;
const MAX_BLOCKS = parseInt(process.env.CLAUDE_TASK_GUARD_MAX_BLOCKS || MAX_BLOCKS_DEFAULT, 10);
const DEFAULT_PROMISE = 'ALL_TASKS_COMPLETE';
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { reconstructTasks, extractPromise, getIncompleteTasks } = require(path.join(__dirname, '..', 'lib', 'task-parser.js'));

function cleanup(statePath) {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch (_) {}
}

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

    // 2. 讀取 transcript
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.exit(0);
    }

    const lines = fs.readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter(Boolean);

    // 3. 重建任務狀態
    const tasks = reconstructTasks(lines);
    const taskIds = Object.keys(tasks);

    // 無任務 → 不阻擋
    if (taskIds.length === 0) {
      cleanup(statePath);
      process.exit(0);
    }

    // 4. 找出未完成任務
    const incomplete = getIncompleteTasks(tasks);

    if (incomplete.length === 0) {
      cleanup(statePath);
      process.exit(0);
    }

    // 4.5 完成承諾檢查
    const promiseText = extractPromise(lines);
    const expectedPromise = process.env.CLAUDE_TASK_GUARD_PROMISE || DEFAULT_PROMISE;
    if (promiseText && promiseText === expectedPromise) {
      cleanup(statePath);
      process.exit(0);
    }

    // 5. 讀取 state file
    let state = { blockCount: 0, maxBlocks: MAX_BLOCKS, cancelled: false };
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 6. 手動取消
    if (state.cancelled) {
      cleanup(statePath);
      process.exit(0);
    }

    // 7. 安全閥
    if (state.blockCount >= (state.maxBlocks || MAX_BLOCKS)) {
      cleanup(statePath);
      console.log(JSON.stringify({
        continue: true,
        systemMessage: `⚠️ task-guard：已達到最大阻擋次數（${state.blockCount}），強制放行。`,
      }));
      process.exit(0);
    }

    // 8. 阻擋
    state.blockCount = (state.blockCount || 0) + 1;
    state.activatedAt = state.activatedAt || new Date().toISOString();

    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const todoList = incomplete
      .map(t => `- [ ] ${t.subject}`)
      .join('\n');

    emit(EVENT_TYPES.TASK_INCOMPLETE, sessionId, {
      blockCount: state.blockCount,
      maxBlocks: state.maxBlocks || MAX_BLOCKS,
      incompleteTasks: incomplete.map(t => t.subject),
    });

    console.log(JSON.stringify({
      continue: false,
      stopReason: `${incomplete.length} 個任務未完成`,
      systemMessage: `⛔ 任務尚未完成（第 ${state.blockCount}/${state.maxBlocks || MAX_BLOCKS} 次阻擋）\n\n未完成項目（${incomplete.length}/${taskIds.length}）：\n${todoList}\n\n請繼續完成以上項目。完成後請將所有任務標記為 completed。\n如果確實已全部完成，輸出 <promise>${expectedPromise}</promise> 以退出。`,
    }));
  } catch (err) {
    hookLogger.error('task-guard', err);
  }
});
