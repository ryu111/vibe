#!/usr/bin/env node
/**
 * claude-md-check.js — 專案層級 Stop hook
 *
 * 比對 CLAUDE.md 中的組件數字與實際檔案系統。
 * 不一致時輸出 systemMessage 提醒更新。
 *
 * 層級歸屬：專案（.claude/settings.json），非 plugin。
 * 因為 CLAUDE.md 是專案層級文件，不應由 plugin hook 驗證。
 *
 * 檢查項目：
 * 1. Plugin 架構表（Skills, Agents, Hooks, Scripts）
 * 2. 目錄結構註解（hooks 數、hook 腳本數）
 * 3. Hooks 事件全景（hooks 數）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.cwd();
const PLUGIN_ROOT = path.join(PROJECT_ROOT, 'plugins', 'vibe');
const CLAUDE_MD = path.join(PROJECT_ROOT, 'CLAUDE.md');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) {
      process.exit(0);
    }

    // 確認檔案存在
    if (!fs.existsSync(CLAUDE_MD) || !fs.existsSync(PLUGIN_ROOT)) {
      process.exit(0);
    }

    // 1. 計算實際數量
    const actual = countActual(PLUGIN_ROOT);

    // 2. 解析 CLAUDE.md 數字
    const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
    const documented = parseClaudeMd(claudeMd);

    // 3. 比對
    const mismatches = [];

    if (documented.tableSkills !== null && documented.tableSkills !== actual.skills) {
      mismatches.push(`Skills：文件 ${documented.tableSkills} vs 實際 ${actual.skills}`);
    }
    if (documented.tableAgents !== null && documented.tableAgents !== actual.agents) {
      mismatches.push(`Agents：文件 ${documented.tableAgents} vs 實際 ${actual.agents}`);
    }
    if (documented.tableHooks !== null && documented.tableHooks !== actual.hooks) {
      mismatches.push(`Hooks：文件 ${documented.tableHooks} vs 實際 ${actual.hooks}`);
    }
    if (documented.tableScripts !== null && documented.tableScripts !== actual.scripts) {
      mismatches.push(`Scripts：文件 ${documented.tableScripts} vs 實際 ${actual.scripts}`);
    }
    if (documented.dirHooks !== null && documented.dirHooks !== actual.hooks) {
      mismatches.push(`目錄結構 hooks 數：文件 ${documented.dirHooks} vs 實際 ${actual.hooks}`);
    }
    if (documented.dirHookScripts !== null && documented.dirHookScripts !== actual.hookScripts) {
      mismatches.push(`目錄結構 hook 腳本數：文件 ${documented.dirHookScripts} vs 實際 ${actual.hookScripts}`);
    }
    if (documented.panoramaHooks !== null && documented.panoramaHooks !== actual.hooks) {
      mismatches.push(`Hooks 全景 hooks 數：文件 ${documented.panoramaHooks} vs 實際 ${actual.hooks}`);
    }

    if (mismatches.length === 0) {
      process.exit(0);
    }

    console.log(JSON.stringify({
      continue: true,
      systemMessage: `⚠️ CLAUDE.md 數字不同步，請更新：\n${mismatches.map(m => `- ${m}`).join('\n')}`,
    }));
  } catch (err) {
    // 專案層級 hook，錯誤靜默處理
    process.stderr.write(`claude-md-check error: ${err.message}\n`);
  }
});

/**
 * 計算實際組件數量
 */
function countActual(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  const agentsDir = path.join(pluginRoot, 'agents');
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  const hookScriptsDir = path.join(pluginRoot, 'scripts', 'hooks');
  const libDir = path.join(pluginRoot, 'scripts', 'lib');

  // Skills：計算 skills/ 下有 SKILL.md 的目錄數
  let skills = 0;
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))) {
        skills++;
      }
    }
  }

  // Agents：計算 agents/ 下的 .md 檔案數
  let agents = 0;
  if (fs.existsSync(agentsDir)) {
    agents = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).length;
  }

  // Hooks：計算 hooks.json 中的 hook 條目數（每個 matcher group 算一個）
  let hooks = 0;
  if (fs.existsSync(hooksFile)) {
    try {
      const hooksJson = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      const events = hooksJson.hooks || {};
      for (const groups of Object.values(events)) {
        if (Array.isArray(groups)) {
          hooks += groups.length;
        }
      }
    } catch (_) {}
  }

  // Hook 腳本：scripts/hooks/ 下的 .js 檔案數
  let hookScripts = 0;
  if (fs.existsSync(hookScriptsDir)) {
    hookScripts = fs.readdirSync(hookScriptsDir).filter(f => f.endsWith('.js')).length;
  }

  // Lib 腳本：scripts/lib/ 下的所有 .js 檔案（遞迴）
  let libScripts = 0;
  if (fs.existsSync(libDir)) {
    libScripts = countJsFiles(libDir);
  }

  return {
    skills,
    agents,
    hooks,
    hookScripts,
    scripts: hookScripts + libScripts,
  };
}

/**
 * 遞迴計算目錄下的 .js 檔案數
 */
function countJsFiles(dir) {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      count += countJsFiles(path.join(dir, e.name));
    } else if (e.name.endsWith('.js')) {
      count++;
    }
  }
  return count;
}

/**
 * 從 CLAUDE.md 解析各處數字
 */
function parseClaudeMd(content) {
  const result = {
    tableSkills: null,
    tableAgents: null,
    tableHooks: null,
    tableScripts: null,
    dirHooks: null,
    dirHookScripts: null,
    panoramaHooks: null,
  };

  // Plugin 架構表：| **vibe** | 1.0.x | ... | 29 | 10 | 22 | 33+daemon |
  const tableMatch = content.match(/\|\s*\*\*vibe\*\*\s*\|[^|]+\|[^|]+\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (tableMatch) {
    result.tableSkills = parseInt(tableMatch[1], 10);
    result.tableAgents = parseInt(tableMatch[2], 10);
    result.tableHooks = parseInt(tableMatch[3], 10);
    result.tableScripts = parseInt(tableMatch[4], 10);
  }

  // 目錄結構：hooks.json # 統一 N hooks
  const dirHooksMatch = content.match(/hooks\.json\s+#\s*統一\s*(\d+)\s*hooks/);
  if (dirHooksMatch) {
    result.dirHooks = parseInt(dirHooksMatch[1], 10);
  }

  // 目錄結構：hooks/ # N 個 hook 腳本
  const dirScriptsMatch = content.match(/hooks\/\s+#\s*(\d+)\s*個\s*hook\s*腳本/);
  if (dirScriptsMatch) {
    result.dirHookScripts = parseInt(dirScriptsMatch[1], 10);
  }

  // Hooks 全景：統一 hooks.json，N hooks
  const panoramaMatch = content.match(/統一\s*hooks\.json[，,]\s*(\d+)\s*hooks/);
  if (panoramaMatch) {
    result.panoramaHooks = parseInt(panoramaMatch[1], 10);
  }

  return result;
}
