/**
 * test-helpers.js — 測試共用輔助函式
 *
 * 提供跨測試檔案的共用功能，避免重複程式碼。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * 清理上次測試殘留的 state 檔案
 * 刪除所有 test-* / e2e-* 前綴的 pipeline-state、timeline、task-guard-state、test-transcript
 * 在每個測試檔案開頭呼叫，確保乾淨的起始狀態
 */
function cleanTestStateFiles() {
  const patterns = [
    { prefix: 'pipeline-state-test-', suffix: '.json' },
    { prefix: 'pipeline-state-e2e-', suffix: '.json' },
    { prefix: 'timeline-test-', suffix: '.jsonl' },
    { prefix: 'timeline-e2e-', suffix: '.jsonl' },
    { prefix: 'timeline-tg-test-', suffix: '.jsonl' },
    { prefix: 'timeline-integration-test-', suffix: '.jsonl' },
    { prefix: 'timeline-unknown', suffix: '.jsonl' },
    { prefix: 'task-guard-state-', suffix: '.json' },
    { prefix: 'test-transcript-', suffix: '.jsonl' },
  ];

  let count = 0;
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    for (const file of files) {
      for (const { prefix, suffix } of patterns) {
        if (file.startsWith(prefix) && file.endsWith(suffix)) {
          try {
            fs.unlinkSync(path.join(CLAUDE_DIR, file));
            count++;
          } catch (_) {}
          break;
        }
      }
    }
  } catch (_) {}
  return count;
}

module.exports = { cleanTestStateFiles, CLAUDE_DIR };
