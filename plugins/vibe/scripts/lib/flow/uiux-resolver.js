#!/usr/bin/env node
// uiux-resolver.js — ui-ux-pro-max 路徑偵測
//
// 偵測 ui-ux-pro-max 的 search.py 路徑，供 designer agent 和 architect 使用。
// 搜尋順序：
//   1. 專案本地 .claude/skills/ui-ux-pro-max/
//   2. Marketplace cache ~/.claude/plugins/cache/
//   3. 全域安裝 ~/.claude/plugins/{name}/ui-ux-pro-max/
// 回傳 null 表示未安裝。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// search.py 在 ui-ux-pro-max 中的相對路徑
const SEARCH_SCRIPT = path.join('src', 'ui-ux-pro-max', 'scripts', 'search.py');

/**
 * 偵測 ui-ux-pro-max 的 search.py 路徑
 * @param {string} [cwd] - 工作目錄（預設 process.cwd()）
 * @returns {string|null} search.py 的絕對路徑，或 null
 */
function resolve(cwd) {
  const projectDir = cwd || process.cwd();

  // 1. 專案本地 .claude/skills/ui-ux-pro-max/
  const localPath = path.join(projectDir, '.claude', 'skills', 'ui-ux-pro-max', SEARCH_SCRIPT);
  if (fs.existsSync(localPath)) return localPath;

  // 2. Marketplace cache（遍歷所有 marketplace 和版本）
  const cachePath = path.join(CLAUDE_DIR, 'plugins', 'cache');
  if (fs.existsSync(cachePath)) {
    try {
      const marketplaces = fs.readdirSync(cachePath);
      for (const mkt of marketplaces) {
        const pluginDir = path.join(cachePath, mkt, 'ui-ux-pro-max');
        if (fs.existsSync(pluginDir)) {
          const versions = fs.readdirSync(pluginDir);
          // 取最新版本（字典序最大）
          const latest = versions.sort().reverse()[0];
          if (latest) {
            const candidate = path.join(pluginDir, latest, SEARCH_SCRIPT);
            if (fs.existsSync(candidate)) return candidate;
          }
        }
      }
    } catch (_) {}
  }

  // 3. 全域 plugins 目錄
  const globalPlugins = path.join(CLAUDE_DIR, 'plugins');
  if (fs.existsSync(globalPlugins)) {
    try {
      const entries = fs.readdirSync(globalPlugins);
      for (const entry of entries) {
        if (entry === 'cache') continue;
        const candidate = path.join(globalPlugins, entry, 'ui-ux-pro-max', SEARCH_SCRIPT);
        if (fs.existsSync(candidate)) return candidate;
        // 也檢查直接在 entry 下的情況
        const directCandidate = path.join(globalPlugins, entry, SEARCH_SCRIPT);
        if (fs.existsSync(directCandidate)) return directCandidate;
      }
    } catch (_) {}
  }

  return null;
}

module.exports = { resolve };
