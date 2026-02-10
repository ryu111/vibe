#!/usr/bin/env node
/**
 * check-console-log.js — Stop hook
 *
 * 結束前檢查變更檔案中殘留的 console.log / debugger。
 * 強度：強建議（systemMessage 注入提醒）。
 */
'use strict';
const { execSync } = require('child_process');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) process.exit(0);

    // 取得變更的檔案
    let files = [];
    try {
      const staged = execSync('git diff --cached --name-only 2>/dev/null', { stdio: 'pipe' })
        .toString().trim();
      const unstaged = execSync('git diff --name-only 2>/dev/null', { stdio: 'pipe' })
        .toString().trim();
      files = [...new Set([...staged.split('\n'), ...unstaged.split('\n')])]
        .filter(f => f && /\.(js|jsx|ts|tsx|vue|svelte)$/.test(f));
    } catch {
      // 非 git 目錄或 git 不可用
      process.exit(0);
    }

    if (files.length === 0) process.exit(0);

    // 檢查殘留的 debug 程式碼
    const findings = [];
    for (const file of files) {
      try {
        const output = execSync(
          `grep -n "console\\.log\\|console\\.debug\\|debugger" "${file}" 2>/dev/null`,
          { stdio: 'pipe' }
        ).toString().trim();

        if (output) {
          findings.push({ file, lines: output });
        }
      } catch {
        // grep 無結果（exit 1）或檔案不存在
      }
    }

    if (findings.length === 0) process.exit(0);

    // 產出提醒
    const details = findings
      .map(f => `**${f.file}**:\n\`\`\`\n${f.lines}\n\`\`\``)
      .join('\n\n');

    console.log(JSON.stringify({
      continue: true,
      systemMessage: `⚠️ 偵測到殘留的 debug 程式碼，建議移除後再結束：\n\n${details}`,
    }));
  } catch (err) {
    process.stderr.write(`check-console-log: ${err.message}\n`);
  }
});
