#!/usr/bin/env node
/**
 * task-parser.js — Transcript JSONL 任務狀態解析
 *
 * 純函式模組，從 Claude Code transcript JSONL 重建任務狀態。
 * 被 task-guard.js（Stop hook）使用。
 *
 * 與 remote/transcript.js 不同：
 * - remote/transcript.js：提取最後 assistant turn 的文字/工具統計
 * - task-parser.js：遍歷整個 transcript 重建 TaskCreate/TaskUpdate 狀態
 */
'use strict';

/**
 * 從 transcript JSONL 重建任務狀態
 *
 * JSONL 格式：
 * - assistant 訊息含 tool_use: { type:"tool_use", id, name, input }
 *   路徑：entry.message.content[].name
 * - user 訊息含 tool_result: { type:"tool_result", tool_use_id, content }
 *   TaskCreate 結果格式："Task #N created successfully: SUBJECT"
 *
 * @param {string[]} lines - transcript JSONL 行陣列
 * @returns {{ [id: string]: { subject: string, status: string } }}
 */
function reconstructTasks(lines) {
  const toolUseMap = {};
  const tasks = {};

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') {
        if (block.name === 'TaskCreate' || block.name === 'TaskUpdate') {
          toolUseMap[block.id] = { name: block.name, input: block.input || {} };
        }

        if (block.name === 'TaskUpdate' && block.input?.taskId) {
          const id = String(block.input.taskId);
          if (!tasks[id]) tasks[id] = { subject: `Task #${id}`, status: 'pending' };
          if (block.input.status) {
            tasks[id].status = block.input.status;
          }
        }
      }

      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolUse = toolUseMap[block.tool_use_id];
        if (toolUse?.name === 'TaskCreate') {
          const resultText = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || b.content || '').join('')
              : '';

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
 * @param {string[]} lines - transcript JSONL 行陣列
 * @returns {string|null} promise 標籤的內容，或 null
 */
function extractPromise(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

    const role = entry.message?.role;
    if (role !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');

    const match = text.match(/<promise>([\s\S]*?)<\/promise>/);
    if (match) {
      return match[1].trim().replace(/\s+/g, ' ');
    }

    return null;
  }
  return null;
}

/**
 * 從任務物件中篩選未完成任務
 *
 * @param {{ [id: string]: { subject: string, status: string } }} tasks
 * @returns {{ id: string, subject: string, status: string }[]}
 */
function getIncompleteTasks(tasks) {
  return Object.entries(tasks)
    .filter(([, t]) => t.status !== 'completed' && t.status !== 'deleted')
    .map(([id, t]) => ({ id, ...t }));
}

module.exports = { reconstructTasks, extractPromise, getIncompleteTasks };
