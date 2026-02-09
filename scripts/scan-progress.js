#!/usr/bin/env node
/**
 * scan-progress.js — 掃描 plugins/ 目錄，產生 docs/progress.json
 *
 * 用途：SessionEnd hook 自動執行
 * 行為：讀取 plugin-specs.json → 掃描實際目錄 → 比對完成度 → 寫入 progress.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SPECS_PATH = path.join(ROOT, 'docs', 'plugin-specs.json');
const PROGRESS_PATH = path.join(ROOT, 'docs', 'progress.json');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// ─── 工具函式 ──────────────────────────────────

/** 遞迴計算目錄下所有檔案數（排除 . 開頭的隱藏檔） */
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

/** 計算完成百分比 */
function calcCompletion(actual, expected) {
  const expTotal =
    expected.skills.length +
    expected.agents.length +
    expected.hooks +
    expected.scripts;
  if (expTotal === 0) return 100;
  const actTotal =
    actual.skills.length +
    actual.agents.length +
    actual.hooks +
    actual.scripts;
  return Math.round((actTotal / expTotal) * 100);
}

// ─── 掃描邏輯 ──────────────────────────────────

function scanPlugin(name) {
  const pluginDir = path.join(PLUGINS_DIR, name);
  const result = { exists: false, skills: [], agents: [], hooks: 0, scripts: 0 };

  if (!fs.existsSync(pluginDir)) return result;
  result.exists = true;

  // Skills: plugins/{name}/skills/{skill}/SKILL.md
  const skillsDir = path.join(pluginDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
        result.skills.push(entry.name);
      }
    }
  }

  // Agents: plugins/{name}/agents/{agent}.md
  const agentsDir = path.join(pluginDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.endsWith('.md')) {
        result.agents.push(file.replace('.md', ''));
      }
    }
  }

  // Hooks: 從 hooks.json 解析 hook 數量
  const hooksFile = path.join(pluginDir, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
      const hooks = data.hooks || data;
      if (typeof hooks === 'object' && !Array.isArray(hooks)) {
        for (const entries of Object.values(hooks)) {
          if (Array.isArray(entries)) result.hooks += entries.length;
        }
      }
    } catch (_) { /* 無效 JSON，計為 0 */ }
  }

  // Scripts: plugins/{name}/scripts/ + plugins/{name}/skills/*/scripts/
  result.scripts = countFiles(path.join(pluginDir, 'scripts'));
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      result.scripts += countFiles(path.join(skillsDir, entry.name, 'scripts'));
    }
  }

  return result;
}

// ─── 主流程 ────────────────────────────────────

function main() {
  if (!fs.existsSync(SPECS_PATH)) {
    console.error('找不到 docs/plugin-specs.json');
    process.exit(1);
  }

  const specs = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf-8'));
  const progress = {
    timestamp: new Date().toISOString(),
    plugins: {},
    overall: { totalExpected: 0, totalActual: 0, completion: 0 }
  };

  for (const [name, spec] of Object.entries(specs.plugins)) {
    const actual = scanPlugin(name);
    const completion = calcCompletion(actual, spec.expected);

    let status = 'planned';
    if (actual.exists) {
      status = completion >= 100 ? 'complete' : 'in-progress';
    }

    progress.plugins[name] = {
      exists: actual.exists,
      status,
      expected: spec.expected,
      actual: {
        skills: actual.skills,
        agents: actual.agents,
        hooks: actual.hooks,
        scripts: actual.scripts
      },
      completion: {
        skills: `${actual.skills.length}/${spec.expected.skills.length}`,
        agents: `${actual.agents.length}/${spec.expected.agents.length}`,
        hooks: `${actual.hooks}/${spec.expected.hooks}`,
        scripts: `${actual.scripts}/${spec.expected.scripts}`,
        overall: completion
      }
    };

    const expTotal =
      spec.expected.skills.length +
      spec.expected.agents.length +
      spec.expected.hooks +
      spec.expected.scripts;
    const actTotal =
      actual.skills.length +
      actual.agents.length +
      actual.hooks +
      actual.scripts;
    progress.overall.totalExpected += expTotal;
    progress.overall.totalActual += actTotal;
  }

  progress.overall.completion =
    progress.overall.totalExpected > 0
      ? Math.round(
          (progress.overall.totalActual / progress.overall.totalExpected) * 100
        )
      : 0;

  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');

  // 輸出摘要供 hook 回報
  const pluginSummary = Object.entries(progress.plugins)
    .map(([n, p]) => `  ${n}: ${p.completion.overall}%`)
    .join('\n');
  console.log(
    `進度掃描完成 — 整體 ${progress.overall.completion}% (${progress.overall.totalActual}/${progress.overall.totalExpected})\n${pluginSummary}`
  );
}

main();
