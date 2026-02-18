'use strict';
/**
 * memory-audit.js — 統一文檔審計工具（Layer 1 確定性驗證引擎）
 *
 * 提供 6 項確定性檢查：
 *   C1. 組件數一致性（plugin-specs.json / plugin.json / CLAUDE.md）
 *   C2. 版號一致性（plugin.json vs CLAUDE.md）
 *   C3. 專案 MEMORY.md 行數上限（200 行）
 *   C4. 死引用掃描（記憶檔中路徑引用的存在性）
 *   C5. 過時版號引用（major 版號範圍外的版號）
 *   C6. Agent 記憶行數上限（每個 agent MEMORY.md 200 行）
 *
 * CLI 模式：node memory-audit.js [projectRoot]
 * 模組模式：require('./memory-audit.js')
 *
 * 輸出格式：JSON AuditReport（stdout）
 *
 * 層級歸屬：plugin 工具（scripts/tools/）
 * 注意：不修改 .claude/hooks/claude-md-check.js，邏輯獨立實作
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 常數 ───────────────────────────────────────────────────────────────

const MEMORY_LINE_LIMIT = 200;

// ─── 輔助函式：遞迴計算 .js 檔案數 ────────────────────────────────────

function countJsFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return count;
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

// ─── 核心函式（吸收並增強 claude-md-check.js 邏輯） ───────────────────

/**
 * 計算實際組件數量
 * @param {string} pluginRoot - vibe plugin 根目錄
 * @returns {{ skills, agents, hooks, hookScripts, scripts }}
 */
function countActual(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  const agentsDir = path.join(pluginRoot, 'agents');
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  const hookScriptsDir = path.join(pluginRoot, 'scripts', 'hooks');
  const libDir = path.join(pluginRoot, 'scripts', 'lib');
  const toolsDir = path.join(pluginRoot, 'scripts', 'tools');

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

  // Hooks：計算 hooks.json 中的個別 hook 條目數
  let hooks = 0;
  if (fs.existsSync(hooksFile)) {
    try {
      const hooksJson = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
      const events = hooksJson.hooks || {};
      for (const groups of Object.values(events)) {
        if (Array.isArray(groups)) {
          for (const group of groups) {
            hooks += (group.hooks || []).length;
          }
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
  const libScripts = countJsFiles(libDir);

  // Tool 腳本：scripts/tools/ 下的所有腳本（.js + .sh）
  let toolScripts = 0;
  if (fs.existsSync(toolsDir)) {
    toolScripts = fs.readdirSync(toolsDir)
      .filter(f => f.endsWith('.js') || f.endsWith('.sh')).length;
  }

  return {
    skills,
    agents,
    hooks,
    hookScripts,
    scripts: hookScripts + libScripts + toolScripts,
  };
}

/**
 * 從 CLAUDE.md 解析各處數字（含版號）
 * @param {string} content - CLAUDE.md 全文
 * @returns {{ tableSkills, tableAgents, tableHooks, tableScripts, tableVersion, dirHooks, dirHookScripts, panoramaHooks }}
 */
function parseClaudeMd(content) {
  const result = {
    tableSkills: null,
    tableAgents: null,
    tableHooks: null,
    tableScripts: null,
    tableVersion: null,  // 增強：解析版號
    dirHooks: null,
    dirHookScripts: null,
    panoramaHooks: null,
  };

  // Plugin 架構表：| **vibe** | 2.0.7 | ... | Skills | Agents | Hooks | Scripts |
  const tableMatch = content.match(/\|\s*\*\*vibe\*\*\s*\|\s*([\d.]+)\s*\|[^|]+\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (tableMatch) {
    result.tableVersion = tableMatch[1];
    result.tableSkills = parseInt(tableMatch[2], 10);
    result.tableAgents = parseInt(tableMatch[3], 10);
    result.tableHooks = parseInt(tableMatch[4], 10);
    result.tableScripts = parseInt(tableMatch[5], 10);
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

// ─── 路徑提取輔助 ────────────────────────────────────────────────────────

/**
 * 從文字中提取 backtick 包裹的路徑引用，排除 URL / placeholder / 非路徑字串
 * @param {string} content - 文字內容
 * @returns {string[]} - 候選路徑清單
 */
function extractPaths(content) {
  const paths = [];
  // 匹配 backtick 包裹的字串
  const regex = /`([^`\n]+)`/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const raw = m[1].trim();
    // 排除 URL
    if (/^https?:\/\//.test(raw)) continue;
    // 排除 {placeholder} 模板
    if (/\{[^}]+\}/.test(raw)) continue;
    // 排除純指令（含空格且非路徑）
    if (/\s/.test(raw) && !raw.startsWith('./') && !raw.startsWith('../')) continue;
    // 必須含路徑分隔符才算路徑
    if (!raw.includes('/') && !raw.includes('\\')) continue;
    // 排除 glob pattern（任意位置含 *）
    if (raw.includes('*')) continue;
    // 排除 skill 識別符（/vibe:xxx 格式）
    if (/^\/\w+:/.test(raw)) continue;
    // 排除以 ~ 加上非 .claude（純概念說明）
    // 但允許 ~/.claude 開頭（實際記憶路徑）
    // 排除副檔名為空的純目錄指示（ v/path/ 結尾且短）
    paths.push(raw);
  }
  return [...new Set(paths)];
}

/**
 * 將路徑候選轉換為可驗證的絕對路徑
 * @param {string} rawPath - 原始路徑字串
 * @param {string} projectRoot - 專案根目錄
 * @returns {string|null} - 絕對路徑（無法解析則返回 null）
 */
function resolvePathCandidate(rawPath, projectRoot) {
  // ~/.claude 開頭 → 展開 home
  if (rawPath.startsWith('~/.claude')) {
    return rawPath.replace('~', os.homedir());
  }
  // 絕對路徑
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  // 相對路徑（必須以常見前綴開頭才驗證）
  // 避免誤判版號、套件名稱等
  const prefixMatch = rawPath.match(/^(plugins|scripts|skills|agents|hooks|tests|docs|openspec|\.claude|src|lib)\//);
  if (prefixMatch) {
    const direct = path.join(projectRoot, rawPath);
    if (fs.existsSync(direct)) return direct;
    // 備選：嘗試 plugins/vibe/ 前綴（記憶檔中常省略 plugins/vibe/）
    const vibePrefix = ['scripts', 'skills', 'agents', 'hooks', 'tests'];
    if (vibePrefix.includes(prefixMatch[1])) {
      return path.join(projectRoot, 'plugins', 'vibe', rawPath);
    }
    return direct;
  }
  return null;
}

// ─── C1 組件數一致性 ─────────────────────────────────────────────────────

/**
 * C1：比對 plugin-specs.json / plugin.json / CLAUDE.md 三者的組件數量
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function checkComponentConsistency(projectRoot) {
  const pluginRoot = path.join(projectRoot, 'plugins', 'vibe');
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const specsPath = path.join(projectRoot, 'docs', 'plugin-specs.json');

  const details = [];

  // 計算實際組件數
  const actual = countActual(pluginRoot);

  // 讀取 CLAUDE.md
  let documented = { tableSkills: null, tableAgents: null, tableHooks: null, tableScripts: null };
  if (fs.existsSync(claudeMdPath)) {
    documented = parseClaudeMd(fs.readFileSync(claudeMdPath, 'utf8'));
  }

  // 讀取 plugin-specs.json
  let specsSkillsCount = null;
  if (fs.existsSync(specsPath)) {
    try {
      const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
      const vibeSkills = specs.plugins && specs.plugins.vibe && specs.plugins.vibe.expected && specs.plugins.vibe.expected.skills;
      if (Array.isArray(vibeSkills)) {
        specsSkillsCount = vibeSkills.length;
      }
    } catch (_) {}
  }

  // 比對 CLAUDE.md 數字
  const fields = [
    { key: 'tableSkills', label: 'CLAUDE.md Plugin 架構表 Skills', actualVal: actual.skills },
    { key: 'tableAgents', label: 'CLAUDE.md Plugin 架構表 Agents', actualVal: actual.agents },
    { key: 'tableHooks', label: 'CLAUDE.md Plugin 架構表 Hooks', actualVal: actual.hooks },
    { key: 'tableScripts', label: 'CLAUDE.md Plugin 架構表 Scripts', actualVal: actual.scripts },
  ];
  for (const f of fields) {
    const docVal = documented[f.key];
    if (docVal !== null && docVal !== f.actualVal) {
      details.push({
        file: 'CLAUDE.md',
        expected: docVal,
        actual: f.actualVal,
        context: f.label,
      });
    }
  }

  // 比對 plugin-specs.json skills
  if (specsSkillsCount !== null && specsSkillsCount !== actual.skills) {
    details.push({
      file: 'docs/plugin-specs.json',
      expected: specsSkillsCount,
      actual: actual.skills,
      context: 'plugin-specs.json skills',
    });
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  return {
    id: 'C1',
    name: '組件數一致性',
    severity: 'error',
    status,
    message: status === 'pass'
      ? `組件數一致（Skills=${actual.skills}, Agents=${actual.agents}, Hooks=${actual.hooks}, Scripts=${actual.scripts}）`
      : `發現 ${details.length} 個組件數不一致`,
    details,
  };
}

// ─── C2 版號一致性 ─────────────────────────────────────────────────────

/**
 * C2：比對 plugin.json version vs CLAUDE.md Plugin 架構表版號
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function checkVersionConsistency(projectRoot) {
  const pluginJsonPath = path.join(projectRoot, 'plugins', 'vibe', '.claude-plugin', 'plugin.json');
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const details = [];

  let pluginVersion = null;
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      pluginVersion = pluginJson.version || null;
    } catch (_) {}
  }

  let claudeVersion = null;
  if (fs.existsSync(claudeMdPath)) {
    const parsed = parseClaudeMd(fs.readFileSync(claudeMdPath, 'utf8'));
    claudeVersion = parsed.tableVersion;
  }

  if (pluginVersion !== null && claudeVersion !== null && pluginVersion !== claudeVersion) {
    details.push({
      file: 'CLAUDE.md',
      expected: pluginVersion,
      actual: claudeVersion,
      context: 'Plugin 架構表版號應與 plugin.json version 一致',
    });
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  let message;
  if (pluginVersion === null) {
    message = 'plugin.json 不存在或無 version 欄位';
  } else if (claudeVersion === null) {
    message = 'CLAUDE.md 無版號（Plugin 架構表格式可能已變更）';
  } else if (status === 'pass') {
    message = `版號一致（${pluginVersion}）`;
  } else {
    message = `版號不一致：plugin.json=${pluginVersion}，CLAUDE.md=${claudeVersion}`;
  }

  return {
    id: 'C2',
    name: '版號一致性',
    severity: 'error',
    status,
    message,
    details,
  };
}

// ─── C3 專案記憶行數上限 ───────────────────────────────────────────────

/**
 * C3：檢查專案 MEMORY.md 是否超過 200 行
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function checkMemoryLineCount(projectRoot) {
  // 專案記憶路徑：~/.claude/projects/-Users-sbu-projects-vibe/memory/MEMORY.md
  // 從 projectRoot 推導（將 / 替換為 -，去掉開頭的 /）
  const encodedPath = projectRoot.replace(/\//g, '-');
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
  const memoryFile = path.join(memoryDir, 'MEMORY.md');

  if (!fs.existsSync(memoryFile)) {
    return {
      id: 'C3',
      name: '專案記憶行數上限',
      severity: 'warn',
      status: 'pass',
      message: 'MEMORY.md 不存在（無需檢查）',
      details: [],
    };
  }

  const content = fs.readFileSync(memoryFile, 'utf8');
  const lines = content.split('\n').length;
  const details = [];

  if (lines > MEMORY_LINE_LIMIT) {
    details.push({
      file: memoryFile,
      actual: lines,
      expected: MEMORY_LINE_LIMIT,
      context: `超出 ${lines - MEMORY_LINE_LIMIT} 行，尾部內容會被 ECC 截斷`,
    });
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  return {
    id: 'C3',
    name: '專案記憶行數上限',
    severity: 'warn',
    status,
    message: status === 'pass'
      ? `MEMORY.md 行數正常（${lines} / ${MEMORY_LINE_LIMIT} 行）`
      : `MEMORY.md 超出行數上限（${lines} 行，上限 ${MEMORY_LINE_LIMIT} 行）`,
    details,
  };
}

// ─── C4 死引用掃描 ─────────────────────────────────────────────────────

/**
 * C4：掃描所有記憶檔中的路徑引用，驗證存在性
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function scanDeadReferences(projectRoot) {
  const details = [];

  // 收集所有記憶檔路徑
  const memoryFiles = gatherMemoryFiles(projectRoot);

  for (const memFile of memoryFiles) {
    if (!fs.existsSync(memFile)) continue;
    const content = fs.readFileSync(memFile, 'utf8');
    const candidates = extractPaths(content);

    for (const candidate of candidates) {
      const resolved = resolvePathCandidate(candidate, projectRoot);
      if (resolved === null) continue;

      // 驗證存在性
      if (!fs.existsSync(resolved)) {
        details.push({
          file: memFile,
          context: candidate,
          actual: '路徑不存在',
        });
      }
    }
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  return {
    id: 'C4',
    name: '死引用掃描',
    severity: 'warn',
    status,
    message: status === 'pass'
      ? `所有記憶檔路徑引用均有效（掃描 ${memoryFiles.length} 個記憶檔）`
      : `發現 ${details.length} 個死引用`,
    details,
  };
}

// ─── C5 過時版號引用 ───────────────────────────────────────────────────

/**
 * C5：掃描記憶檔中的版號引用，偵測超出當前 major 範圍的引用
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function scanStaleVersions(projectRoot) {
  const details = [];

  // 讀取當前版號
  const pluginJsonPath = path.join(projectRoot, 'plugins', 'vibe', '.claude-plugin', 'plugin.json');
  let currentMajor = null;
  if (fs.existsSync(pluginJsonPath)) {
    try {
      const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      if (pj.version) {
        currentMajor = parseInt(pj.version.split('.')[0], 10);
      }
    } catch (_) {}
  }

  if (currentMajor === null) {
    return {
      id: 'C5',
      name: '過時版號引用',
      severity: 'info',
      status: 'pass',
      message: '無法取得當前版號，跳過掃描',
      details: [],
    };
  }

  // 只掃描記憶檔（不包含 CLAUDE.md，CLAUDE.md 是 SoT）
  const memoryFiles = gatherMemoryFiles(projectRoot);
  const versionRegex = /\bv(\d+)\.\d+\.\d+\b/g;

  for (const memFile of memoryFiles) {
    if (!fs.existsSync(memFile)) continue;
    const content = fs.readFileSync(memFile, 'utf8');
    let m;
    const staleFound = new Set();
    while ((m = versionRegex.exec(content)) !== null) {
      const major = parseInt(m[1], 10);
      const versionStr = m[0];
      if (major < currentMajor && !staleFound.has(versionStr)) {
        staleFound.add(versionStr);
        details.push({
          file: memFile,
          context: `${versionStr} (major: ${major}, current major: ${currentMajor})`,
          actual: versionStr,
        });
      }
    }
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  return {
    id: 'C5',
    name: '過時版號引用',
    severity: 'info',
    status,
    message: status === 'pass'
      ? `無過時版號引用（當前 major: ${currentMajor}）`
      : `發現 ${details.length} 個舊 major 版號引用（當前 major: ${currentMajor}）`,
    details,
  };
}

// ─── C6 Agent 記憶行數 ─────────────────────────────────────────────────

/**
 * C6：檢查 5 個 agent MEMORY.md 是否超過 200 行
 * @param {string} projectRoot
 * @returns {AuditCheck}
 */
function checkAgentMemoryLines(projectRoot) {
  const agentMemoryDir = path.join(projectRoot, '.claude', 'agent-memory');
  const details = [];

  if (!fs.existsSync(agentMemoryDir)) {
    return {
      id: 'C6',
      name: 'Agent 記憶行數',
      severity: 'warn',
      status: 'pass',
      message: '無 agent 記憶目錄',
      details: [],
    };
  }

  // 遍歷 vibe-*/MEMORY.md
  const entries = fs.readdirSync(agentMemoryDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const memFile = path.join(agentMemoryDir, e.name, 'MEMORY.md');
    if (!fs.existsSync(memFile)) continue;

    const content = fs.readFileSync(memFile, 'utf8');
    const lines = content.split('\n').length;
    if (lines > MEMORY_LINE_LIMIT) {
      details.push({
        file: memFile,
        actual: lines,
        expected: MEMORY_LINE_LIMIT,
        context: `超出 ${lines - MEMORY_LINE_LIMIT} 行，尾部內容會被 ECC 截斷`,
      });
    }
  }

  const status = details.length === 0 ? 'pass' : 'fail';
  return {
    id: 'C6',
    name: 'Agent 記憶行數',
    severity: 'warn',
    status,
    message: status === 'pass'
      ? 'Agent 記憶行數均未超限'
      : `發現 ${details.length} 個 agent 記憶超出行數上限`,
    details,
  };
}

// ─── 輔助：收集所有記憶檔路徑 ────────────────────────────────────────

/**
 * 收集所有需要掃描的記憶檔清單
 * @param {string} projectRoot
 * @returns {string[]}
 */
function gatherMemoryFiles(projectRoot) {
  const files = [];

  // 專案記憶檔
  const encodedPath = projectRoot.replace(/\//g, '-');
  const projectMemoryDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
  for (const name of ['MEMORY.md', 'debugging.md', 'design-principles.md', 'research-findings.md']) {
    files.push(path.join(projectMemoryDir, name));
  }

  // Agent 記憶檔
  const agentMemoryDir = path.join(projectRoot, '.claude', 'agent-memory');
  if (fs.existsSync(agentMemoryDir)) {
    const entries = fs.readdirSync(agentMemoryDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const memFile = path.join(agentMemoryDir, e.name, 'MEMORY.md');
        files.push(memFile);
      }
    }
  }

  return files;
}

// ─── runAudit：組合所有檢查 ───────────────────────────────────────────

/**
 * 執行完整審計，回傳 AuditReport
 * @param {string} projectRoot - 專案根目錄（預設 process.cwd()）
 * @returns {{ timestamp, summary, checks }}
 */
function runAudit(projectRoot) {
  const root = projectRoot || process.cwd();

  const checks = [
    checkComponentConsistency(root),
    checkVersionConsistency(root),
    checkMemoryLineCount(root),
    scanDeadReferences(root),
    scanStaleVersions(root),
    checkAgentMemoryLines(root),
  ];

  // 統計 summary
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const check of checks) {
    if (check.status === 'fail') {
      if (check.severity === 'error') summary.errors++;
      else if (check.severity === 'warn') summary.warnings++;
      else if (check.severity === 'info') summary.info++;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    summary,
    checks,
  };
}

// ─── 模組匯出 ─────────────────────────────────────────────────────────

module.exports = {
  countActual,
  parseClaudeMd,
  extractPaths,
  resolvePathCandidate,
  gatherMemoryFiles,
  checkComponentConsistency,
  checkVersionConsistency,
  checkMemoryLineCount,
  scanDeadReferences,
  scanStaleVersions,
  checkAgentMemoryLines,
  runAudit,
};

// ─── CLI 模式 ─────────────────────────────────────────────────────────

if (require.main === module) {
  const projectRoot = process.argv[2] || process.cwd();
  try {
    const report = runAudit(projectRoot);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    process.stderr.write(`memory-audit error: ${err.message}\n`);
    process.exit(1);
  }
}
