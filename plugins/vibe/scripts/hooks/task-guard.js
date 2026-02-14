#!/usr/bin/env node
/**
 * task-guard.js — Stop hook
 *
 * 未完成任務時阻擋 Claude 結束回合。
 * 強度：絕對阻擋（decision: "block"）。
 *
 * 從 transcript JSONL 解析 TaskCreate/TaskUpdate 工具呼叫，
 * 重建任務狀態，偵測未完成的任務。
 *
 * 完成承諾機制（借鑑 ralph-wiggum plugin）：
 * Claude 可在最後訊息中輸出 <promise>ALL_TASKS_COMPLETE</promise>
 * 強制宣告完成，繞過 TaskUpdate 狀態檢查。
 *
 * 阻擋格式：
 *   { decision: "block", reason: "繼續提示", systemMessage: "狀態資訊" }
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

/**
 * 從 transcript JSONL 重建任務狀態
 *
 * JSONL 格式：
 * - assistant 訊息含 tool_use: { type:"tool_use", id, name, input }
 *   路徑：entry.message.content[].name
 * - user 訊息含 tool_result: { type:"tool_result", tool_use_id, content }
 *   TaskCreate 結果格式："Task #N created successfully: SUBJECT"
 *
 * @returns {{ [id: string]: { subject: string, status: string } }}
 */
function reconstructTasks(lines) {
  // tool_use_id → { name, input } 用於匹配 tool_result
  const toolUseMap = {};
  // taskId → { subject, status }
  const tasks = {};

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // 1. 收集 TaskCreate / TaskUpdate tool_use
      if (block.type === 'tool_use') {
        if (block.name === 'TaskCreate' || block.name === 'TaskUpdate') {
          toolUseMap[block.id] = { name: block.name, input: block.input || {} };
        }

        // TaskUpdate 直接有 taskId 和 status
        if (block.name === 'TaskUpdate' && block.input?.taskId) {
          const id = String(block.input.taskId);
          if (!tasks[id]) tasks[id] = { subject: `Task #${id}`, status: 'pending' };
          if (block.input.status) {
            tasks[id].status = block.input.status;
          }
        }
      }

      // 2. 匹配 TaskCreate 的 tool_result → 取得 ID
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolUse = toolUseMap[block.tool_use_id];
        if (toolUse?.name === 'TaskCreate') {
          const resultText = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || b.content || '').join('')
              : '';

          // 格式："Task #N created successfully: SUBJECT"
          const match = resultText.match(/Task #(\d+)/);
          if (match) {
            const id = match[1];
            if (!tasks[id]) {
              tasks[id] = {
                subject: toolUse.input.subject || `Task #${id}`,
                status: 'pending',
              };
            }
          }
        }
      }
    }
  }

  return tasks;
}

/**
 * 從 transcript 最後一個 assistant 訊息中提取 <promise> 標籤內容
 * （借鑑 ralph-wiggum plugin 的完成承諾機制）
 *
 * @returns {string|null} promise 標籤的內容，或 null
 */
function extractPromise(lines) {
  // 從後往前找最後一個 assistant 訊息
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

    const role = entry.message?.role;
    if (role !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    // 拼接所有 text 區塊
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');

    // 提取 <promise>...</promise>
    const match = text.match(/<promise>([\s\S]*?)<\/promise>/);
    if (match) {
      // 正規化空白（與 ralph-wiggum 一致）
      return match[1].trim().replace(/\s+/g, ' ');
    }

    // 只看最後一個 assistant 訊息
    return null;
  }
  return null;
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

    // 4. 找出未完成任務（排除 completed 和 deleted）
    const incomplete = taskIds
      .filter(id => tasks[id].status !== 'completed' && tasks[id].status !== 'deleted')
      .map(id => tasks[id]);

    if (incomplete.length === 0) {
      cleanup(statePath);
      process.exit(0);
    }

    // 4.5 完成承諾檢查（借鑑 ralph-wiggum）
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

    // 6. 手動取消（/cancel 設定）
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

    // 8. 阻擋！
    state.blockCount = (state.blockCount || 0) + 1;
    state.activatedAt = state.activatedAt || new Date().toISOString();

    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const todoList = incomplete
      .map(t => `- [ ] ${t.subject}`)
      .join('\n');

    // Emit task incomplete event
    emit(EVENT_TYPES.TASK_INCOMPLETE, sessionId, {
      blockCount: state.blockCount,
      maxBlocks: state.maxBlocks || MAX_BLOCKS,
      incompleteTasks: incomplete.map(t => t.subject),
    });

    console.log(JSON.stringify({
      decision: 'block',
      reason: `繼續完成未完成的任務：\n${todoList}`,
      systemMessage: `⛔ 任務尚未完成（第 ${state.blockCount}/${state.maxBlocks || MAX_BLOCKS} 次阻擋）\n\n未完成項目（${incomplete.length}/${taskIds.length}）：\n${todoList}\n\n請繼續完成以上項目。完成後請將所有任務標記為 completed。\n如果確實已全部完成，輸出 <promise>${expectedPromise}</promise> 以退出。`,
    }));
  } catch (err) {
    hookLogger.error('task-guard', err);
  }
});

function cleanup(statePath) {
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch (_) {}
}
