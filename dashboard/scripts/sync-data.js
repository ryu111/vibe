#!/usr/bin/env node
/**
 * sync-dashboard-data.js — 從 plugin 目錄自動提取 metadata
 *
 * 掃描：agents/*.md frontmatter、pipeline.json、hooks.json
 * 產出：dashboard/data/meta.json（自動生成，.gitignore）
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SPECS_PATH = path.join(ROOT, 'docs', 'plugin-specs.json');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const OUTPUT_PATH = path.join(ROOT, 'dashboard', 'data', 'meta.json');

// ─── YAML Frontmatter 解析 ──────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split('\n')) {
    // 新的 key: value 行
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      // 跳過 YAML 多行指示符
      if (value === '>-' || value === '>' || value === '|') {
        result[currentKey] = '';
      } else {
        result[currentKey] = value;
      }
    } else if (currentKey && /^\s+/.test(line) && line.trim()) {
      // 多行延續（description 等）
      if (line.trim().startsWith('- ')) {
        // 陣列項目（如 skills: 下的 - agent-browser）
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = result[currentKey] ? [result[currentKey]] : [];
        }
        result[currentKey].push(line.trim().slice(2));
      } else {
        result[currentKey] = (result[currentKey] ? result[currentKey] + ' ' : '') + line.trim();
      }
    }
  }

  // 解析逗號分隔的 tools
  if (typeof result.tools === 'string') {
    result.tools = result.tools.split(',').map(t => t.trim());
  }

  // 解析數字欄位
  if (result.maxTurns) result.maxTurns = parseInt(result.maxTurns, 10);

  return result;
}

/** 從 description 提取 emoji（第一個字元） */
function extractEmoji(description) {
  if (!description) return null;
  // 匹配 emoji（含組合 emoji）
  const match = description.match(/^([\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f]+)/u);
  return match ? match[1] : null;
}

// ─── 掃描邏輯 ──────────────────────────────────

function scanAgents(pluginDir, pluginName) {
  const agentsDir = path.join(pluginDir, 'agents');
  const agents = {};

  if (!fs.existsSync(agentsDir)) return agents;

  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm.name) continue;

    agents[fm.name] = {
      name: fm.name,
      plugin: pluginName,
      model: fm.model || 'sonnet',
      color: fm.color || 'cyan',
      tools: fm.tools || [],
      maxTurns: fm.maxTurns || 30,
      permissionMode: fm.permissionMode || 'default',
      emoji: extractEmoji(fm.description),
      memory: fm.memory || null,
    };
  }

  return agents;
}

function scanPipeline(pluginDir) {
  const pipelinePath = path.join(pluginDir, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function scanHooks(pluginDir) {
  const hooksPath = path.join(pluginDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const hooks = data.hooks || data;
    const summary = {};

    if (typeof hooks === 'object' && !Array.isArray(hooks)) {
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        summary[event] = entries.map(group => {
          const hookList = group.hooks || [group];
          return hookList.map(h => {
            const cmd = h.command || '';
            const scriptName = path.basename(cmd).replace(/\.(js|sh)$/, '');
            return { script: scriptName, matcher: group.matcher || '*' };
          });
        }).flat();
      }
    }

    return summary;
  } catch (_) {
    return null;
  }
}

// ─── 主流程 ────────────────────────────────────

function main() {
  if (!fs.existsSync(SPECS_PATH)) {
    console.error('找不到 docs/plugin-specs.json');
    process.exit(1);
  }

  const specs = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf-8'));
  const output = {
    timestamp: new Date().toISOString(),
    agents: {},
    pipeline: {
      stages: [],
      stageLabels: {},
      stageProviders: {},
    },
    hooks: {},
  };

  // 掃描每個 plugin
  for (const pluginName of Object.keys(specs.plugins)) {
    const pluginDir = path.join(PLUGINS_DIR, pluginName);
    if (!fs.existsSync(pluginDir)) continue;

    // Agents
    const agents = scanAgents(pluginDir, pluginName);
    Object.assign(output.agents, agents);

    // Pipeline
    const pipeline = scanPipeline(pluginDir);
    if (pipeline) {
      // 合併 stages 和 stageLabels（以 flow 的為主）
      if (pipeline.stages) {
        output.pipeline.stages = pipeline.stages;
      }
      if (pipeline.stageLabels) {
        Object.assign(output.pipeline.stageLabels, pipeline.stageLabels);
      }
      if (pipeline.provides) {
        for (const [stage, provider] of Object.entries(pipeline.provides)) {
          output.pipeline.stageProviders[stage] = {
            ...provider,
            plugin: pluginName,
          };
        }
      }
    }

    // Hooks
    const hooks = scanHooks(pluginDir);
    if (hooks) {
      output.hooks[pluginName] = hooks;
    }
  }

  // 寫入
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

  const agentCount = Object.keys(output.agents).length;
  const stageCount = output.pipeline.stages.length;
  const hookPlugins = Object.keys(output.hooks).length;
  console.log(`dashboard-meta.json 生成完成 — ${agentCount} agents · ${stageCount} stages · ${hookPlugins} hook plugins`);
}

main();
