#!/usr/bin/env node
/**
 * transcript.js — 共用 transcript JSONL 解析
 *
 * 從 Claude Code transcript 提取最後一個 assistant turn 的資訊。
 * 被 remote-receipt.js（Stop hook）和 remote-sender.js（SubagentStop hook）共用。
 */
'use strict';
const fs = require('fs');

/**
 * 從 transcript JSONL 提取最後一個 assistant turn 的資訊
 * @param {string} transcriptPath - transcript JSONL 檔案路徑
 * @param {object} [opts]
 * @param {number} [opts.maxTextLen=500] - 文字截斷長度
 * @param {number} [opts.maxReadBytes=65536] - 最大讀取位元組數
 * @param {boolean} [opts.toolStats=false] - 是否統計工具呼叫
 * @returns {{ text: string|null, tools: object|null }}
 */
function parseLastAssistantTurn(transcriptPath, opts = {}) {
  const maxTextLen = opts.maxTextLen ?? 500;
  const maxReadBytes = opts.maxReadBytes ?? 65536;
  const wantTools = opts.toolStats ?? false;

  let lines;
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, maxReadBytes);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    lines = buf.toString('utf8').trim().split('\n');
    // 第一行可能被截斷，丟棄
    if (stat.size > readSize) lines.shift();
  } catch (_) {
    return { text: null, tools: null };
  }

  const textParts = [];
  const tools = { write: 0, edit: 0, bash: 0, task: 0, search: 0, read: 0 };
  let foundAssistant = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

    // 遇到 user/human turn → 停止（只看最後一個 assistant 回合）
    if (entry.type === 'human' || entry.role === 'user') {
      if (foundAssistant) break;
      continue;
    }

    if (entry.type === 'assistant' || entry.role === 'assistant') {
      foundAssistant = true;
      const content = entry.message?.content || entry.content || [];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // 收集 text blocks（從尾部讀，需要 unshift 保持順序）
          textParts.unshift(block.text);
        }
        if (wantTools && block.type === 'tool_use') {
          const name = block.name;
          if (name === 'Write') tools.write++;
          else if (name === 'Edit') tools.edit++;
          else if (name === 'Bash') tools.bash++;
          else if (name === 'Task') tools.task++;
          else if (name === 'Grep' || name === 'Glob') tools.search++;
          else if (name === 'Read') tools.read++;
        }
      }
    }
  }

  // 組合文字，截斷到 maxTextLen
  let text = textParts.join('\n').trim();
  if (!text) text = null;
  else if (text.length > maxTextLen) text = text.slice(0, maxTextLen) + '…';

  const hasTools = wantTools && Object.values(tools).some(v => v > 0);

  return {
    text,
    tools: hasTools ? tools : null,
  };
}

module.exports = { parseLastAssistantTurn };
