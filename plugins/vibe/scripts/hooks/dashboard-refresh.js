#!/usr/bin/env node
/**
 * dashboard-refresh.js — Stop hook 橋接腳本
 *
 * 呼叫 dashboard/scripts/refresh.js 執行自動同步鏈：
 * sync-data.js + scan-progress.js → generate.js → dashboard.html + index.md
 *
 * 橋接原因：refresh.js 在 plugin 外部（dashboard/），
 * 而 hooks.json 只能用 ${CLAUDE_PLUGIN_ROOT} 引用 plugin 內部腳本。
 *
 * 永遠 exit 0，不阻擋 Claude 停止。
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const hookLogger = require('../lib/hook-logger.js');

try {
  const ROOT = process.cwd();
  const refreshScript = path.join(ROOT, 'dashboard', 'scripts', 'refresh.js');

  execFileSync('node', [refreshScript], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 30000,
  });
} catch (err) {
  hookLogger.error('dashboard-refresh', err);
}

process.exit(0);
