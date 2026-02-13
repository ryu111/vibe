#!/usr/bin/env node
/**
 * dev-gate.js — PreToolUse hook (matcher: Write|Edit)
 *
 * Pipeline 模式下，阻擋 Main Agent 直接使用 Write/Edit 寫程式碼。
 *
 * 重要：plugin hooks 會同時攔截 sub-agent 的 tool calls。
 * 因此需要配合 delegation-tracker.js 來追蹤委派狀態：
 * - delegation-tracker 在 Task 呼叫時設定 delegationActive = true
 * - dev-gate 在 delegationActive = true 時放行（sub-agent 正在工作）
 *
 * 放行條件：
 * - 無 pipeline state → 放行
 * - pipelineEnforced = false（由 task-classifier 設定）→ 放行
 * - delegationActive = true → 放行（sub-agent 操作）
 * - 編輯非程式碼檔案（.md/.json/.yml 等）→ 放行
 *
 * 阻擋條件：
 * - pipelineEnforced = true + delegationActive = false + 編輯程式碼 → exit 2
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 非程式碼副檔名（允許直接編輯）
const NON_CODE_EXTS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.cfg', '.ini', '.env', '.gitignore', '.dockerignore',
  '.csv', '.xml', '.html', '.css', '.svg',
]);

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

    // Pipeline 未啟動 → 放行
    if (!state.initialized) {
      process.exit(0);
    }

    // taskType 尚未分類 → 放行（pipeline-init 先於 task-classifier）
    if (!state.taskType) {
      process.exit(0);
    }

    // 非強制 pipeline 任務 → 放行（flag 由 task-classifier 設定）
    if (!state.pipelineEnforced) {
      process.exit(0);
    }

    // 委派已啟動（Task 已呼叫）→ 放行（sub-agent 正在操作）
    if (state.delegationActive) {
      process.exit(0);
    }

    // 檢查檔案副檔名 — 非程式碼檔案放行
    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || '';
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (NON_CODE_EXTS.has(ext)) {
        process.exit(0);
      }
    }

    // ⛔ 阻擋：Main Agent 不應直接寫程式碼
    const toolName = data.tool_name || 'Write';
    process.stderr.write(
      `⛔ Pipeline 模式下禁止直接使用 ${toolName} 寫程式碼。\n` +
      `你是管理者（Orchestrator），不是執行者。\n` +
      `請使用 Task 工具委派給對應的 sub-agent：\n` +
      `  Task({ subagent_type: "flow:developer", prompt: "..." })\n`
    );
    process.exit(2);
  } catch (err) {
    // 解析錯誤 → 靜默放行，不阻擋正常操作
    process.exit(0);
  }
});
