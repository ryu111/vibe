'use strict';
/**
 * memory-audit.test.js — Layer 1 確定性驗證引擎單元測試
 *
 * 測試策略：用 tmpDir 模擬專案結構，隔離驗證每個 C1~C6 函式。
 * 不依賴真實專案目錄，完全可重複執行。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  countActual,
  parseClaudeMd,
  checkComponentConsistency,
  checkVersionConsistency,
  checkMemoryLineCount,
  scanDeadReferences,
  scanStaleVersions,
  checkAgentMemoryLines,
  runAudit,
} = require('../scripts/tools/memory-audit.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`❌ ${name}: ${err.message}`);
  }
}

// ─── 輔助：建立臨時目錄結構 ───────────────────────────────────────────

/**
 * 建立 tmpDir 並返回清理函式
 * @returns {{ tmpDir: string, cleanup: Function }}
 */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-audit-test-'));
  return {
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * 建立基本的 plugin 目錄結構
 * @param {string} projectRoot
 * @param {{ skills?: string[], agents?: number, hooks?: number, hookScripts?: number, libFiles?: string[] }} opts
 */
function setupPluginStructure(projectRoot, opts = {}) {
  const pluginRoot = path.join(projectRoot, 'plugins', 'vibe');
  const skillsDir = path.join(pluginRoot, 'skills');
  const agentsDir = path.join(pluginRoot, 'agents');
  const hookScriptsDir = path.join(pluginRoot, 'scripts', 'hooks');
  const libDir = path.join(pluginRoot, 'scripts', 'lib');
  const toolsDir = path.join(pluginRoot, 'scripts', 'tools');
  const pluginJsonDir = path.join(pluginRoot, '.claude-plugin');

  // 建立目錄
  for (const d of [skillsDir, agentsDir, hookScriptsDir, libDir, toolsDir, pluginJsonDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Skills
  const skillNames = opts.skills || ['skill-a', 'skill-b'];
  for (const name of skillNames) {
    const sDir = path.join(skillsDir, name);
    fs.mkdirSync(sDir, { recursive: true });
    fs.writeFileSync(path.join(sDir, 'SKILL.md'), `# ${name}`);
  }

  // Agents
  const agentCount = opts.agents !== undefined ? opts.agents : 2;
  for (let i = 0; i < agentCount; i++) {
    fs.writeFileSync(path.join(agentsDir, `agent-${i}.md`), `# agent-${i}`);
  }

  // hooks.json（含 hooks 條目）
  const hookCount = opts.hooks !== undefined ? opts.hooks : 3;
  const hookEntries = [];
  for (let i = 0; i < hookCount; i++) {
    hookEntries.push({ type: 'command', command: `echo hook${i}` });
  }
  const hooksDir = path.join(pluginRoot, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ matcher: '*', hooks: hookEntries }],
    },
  }));

  // Hook 腳本
  const hookScriptCount = opts.hookScripts !== undefined ? opts.hookScripts : 2;
  for (let i = 0; i < hookScriptCount; i++) {
    fs.writeFileSync(path.join(hookScriptsDir, `hook-${i}.js`), `// hook-${i}`);
  }

  // Lib 檔案
  const libFiles = opts.libFiles || ['lib-a.js'];
  for (const f of libFiles) {
    fs.writeFileSync(path.join(libDir, f), `// ${f}`);
  }

  // plugin.json
  const version = opts.version || '2.0.7';
  fs.writeFileSync(path.join(pluginJsonDir, 'plugin.json'), JSON.stringify({
    name: 'vibe',
    version,
  }));

  return { pluginRoot, skillsDir, agentsDir, hookScriptsDir, libDir, toolsDir, pluginJsonDir };
}

/**
 * 建立 CLAUDE.md 含 Plugin 架構表
 */
function writeClaudeMd(projectRoot, opts = {}) {
  const {
    version = '2.0.7',
    skills = 2,
    agents = 2,
    hooks = 3,
    scripts = 4,
  } = opts;
  const content = `# Vibe

## Plugin 架構

| Plugin | 版號 | 定位 | Skills | Agents | Hooks | Scripts |
|--------|------|------|:------:|:------:|:-----:|:-------:|
| **forge** | 0.1.5 | forge | 4 | 0 | 0 | 7 |
| **vibe** | ${version} | 全方位開發工作流 | ${skills} | ${agents} | ${hooks} | ${scripts} |

## Hooks 事件全景

統一 hooks.json，${hooks} hooks 按事件分組（順序明確）：

### 目錄結構

\`\`\`
hooks.json  # 統一 ${hooks} hooks
hooks/      # ${scripts} 個 hook 腳本
\`\`\`
`;
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), content);
}

/**
 * 建立 plugin-specs.json
 */
function writePluginSpecs(projectRoot, skillNames) {
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'docs', 'plugin-specs.json'),
    JSON.stringify({
      plugins: {
        vibe: {
          expected: {
            skills: skillNames,
            agents: [],
            hooks: 0,
            scripts: 0,
          },
        },
      },
    })
  );
}

// ─── countActual 測試 ──────────────────────────────────────────────────

test('countActual: 計算正確的組件數', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, {
      skills: ['skill-a', 'skill-b', 'skill-c'],
      agents: 3,
      hooks: 4,
      hookScripts: 5,
      libFiles: ['lib-a.js', 'lib-b.js'],
    });
    const pluginRoot = path.join(tmpDir, 'plugins', 'vibe');
    const counts = countActual(pluginRoot);
    assert.strictEqual(counts.skills, 3, 'skills 應為 3');
    assert.strictEqual(counts.agents, 3, 'agents 應為 3');
    assert.strictEqual(counts.hooks, 4, 'hooks 應為 4');
    assert.strictEqual(counts.hookScripts, 5, 'hookScripts 應為 5');
    // scripts = hookScripts + libFiles = 5 + 2 = 7（無 tools）
    assert.strictEqual(counts.scripts, 7, 'scripts 應為 7');
  } finally {
    cleanup();
  }
});

test('countActual: skills 目錄不存在時返回 0', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const pluginRoot = path.join(tmpDir, 'plugins', 'vibe');
    fs.mkdirSync(pluginRoot, { recursive: true });
    const counts = countActual(pluginRoot);
    assert.strictEqual(counts.skills, 0);
    assert.strictEqual(counts.agents, 0);
    assert.strictEqual(counts.hooks, 0);
  } finally {
    cleanup();
  }
});

// ─── parseClaudeMd 測試 ────────────────────────────────────────────────

test('parseClaudeMd: 正確解析版號和組件數', () => {
  const content = `
| **vibe** | 2.0.7 | 全方位開發工作流 | 35 | 12 | 19 | 50 |

統一 hooks.json，19 hooks 按事件分組：

hooks.json  # 統一 19 hooks
hooks/      # 15 個 hook 腳本
`;
  const result = parseClaudeMd(content);
  assert.strictEqual(result.tableVersion, '2.0.7');
  assert.strictEqual(result.tableSkills, 35);
  assert.strictEqual(result.tableAgents, 12);
  assert.strictEqual(result.tableHooks, 19);
  assert.strictEqual(result.tableScripts, 50);
  assert.strictEqual(result.dirHooks, 19);
  assert.strictEqual(result.dirHookScripts, 15);
  assert.strictEqual(result.panoramaHooks, 19);
});

test('parseClaudeMd: 無匹配時返回 null', () => {
  const result = parseClaudeMd('# 空內容，無 vibe 表格');
  assert.strictEqual(result.tableVersion, null);
  assert.strictEqual(result.tableSkills, null);
});

// ─── C1 組件數一致性 ─────────────────────────────────────────────────

test('C1: 三者數字一致時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, {
      skills: ['skill-a', 'skill-b'],
      agents: 2,
      hooks: 3,
      hookScripts: 2,
      libFiles: ['lib.js'],
    });
    // scripts = hookScripts(2) + lib(1) + tools(0) = 3
    writeClaudeMd(tmpDir, { version: '2.0.7', skills: 2, agents: 2, hooks: 3, scripts: 3 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.id, 'C1');
    assert.strictEqual(result.status, 'pass');
    assert.deepStrictEqual(result.details, []);
  } finally {
    cleanup();
  }
});

test('C1: plugin-specs.json skills 數不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 實際 skills = 2，但 specs 有 3 個
    setupPluginStructure(tmpDir, { skills: ['skill-a', 'skill-b'] });
    writeClaudeMd(tmpDir, { skills: 2 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b', 'skill-c']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.severity, 'error');
    const detail = result.details.find(d => d.context === 'plugin-specs.json skills');
    assert.ok(detail, '應有 plugin-specs.json 相關 detail');
    assert.strictEqual(detail.expected, 3);
    assert.strictEqual(detail.actual, 2);
  } finally {
    cleanup();
  }
});

test('C1: CLAUDE.md Skills 數不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 實際 skills = 2，CLAUDE.md 寫 34
    setupPluginStructure(tmpDir, { skills: ['skill-a', 'skill-b'] });
    writeClaudeMd(tmpDir, { skills: 34 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    const detail = result.details.find(d => d.context && d.context.includes('CLAUDE.md'));
    assert.ok(detail, '應有 CLAUDE.md 相關 detail');
    assert.strictEqual(detail.expected, 34);
    assert.strictEqual(detail.actual, 2);
  } finally {
    cleanup();
  }
});

test('C1: plugin-specs.json 不存在時只檢查 CLAUDE.md', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // skills=2, agents=2, hooks=3, hookScripts=2, libFiles=['lib.js'] => scripts=3
    setupPluginStructure(tmpDir, { skills: ['skill-a', 'skill-b'], hookScripts: 2, libFiles: ['lib.js'] });
    writeClaudeMd(tmpDir, { skills: 2, agents: 2, hooks: 3, scripts: 3 });
    // 不建立 plugin-specs.json

    const result = checkComponentConsistency(tmpDir);
    // CLAUDE.md 一致，specs 不存在 → pass
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

// ─── C2 版號一致性 ─────────────────────────────────────────────────────

test('C2: 版號一致時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    writeClaudeMd(tmpDir, { version: '2.0.7' });

    const result = checkVersionConsistency(tmpDir);
    assert.strictEqual(result.id, 'C2');
    assert.strictEqual(result.status, 'pass');
    assert.deepStrictEqual(result.details, []);
  } finally {
    cleanup();
  }
});

test('C2: 版號不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    writeClaudeMd(tmpDir, { version: '2.0.6' });

    const result = checkVersionConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.severity, 'error');
    assert.strictEqual(result.details.length, 1);
    assert.strictEqual(result.details[0].file, 'CLAUDE.md');
    assert.strictEqual(result.details[0].expected, '2.0.7');
    assert.strictEqual(result.details[0].actual, '2.0.6');
  } finally {
    cleanup();
  }
});

test('C2: CLAUDE.md 無版號時 status 仍為 pass（無法比對）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    // 寫一個不含版號的 CLAUDE.md
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# 無版號的文件');

    const result = checkVersionConsistency(tmpDir);
    assert.strictEqual(result.status, 'pass');
    assert.ok(result.message.includes('無版號'), `訊息應提示無版號，但得到：${result.message}`);
  } finally {
    cleanup();
  }
});

// ─── C3 專案記憶行數上限 ───────────────────────────────────────────────

test('C3: MEMORY.md 不存在時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 不建立 MEMORY.md
    const result = checkMemoryLineCount(tmpDir);
    assert.strictEqual(result.id, 'C3');
    assert.strictEqual(result.status, 'pass');
    assert.ok(result.message.includes('不存在'));
  } finally {
    cleanup();
  }
});

test('C3: MEMORY.md 行數未超限時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立記憶目錄和 MEMORY.md（模擬真實路徑結構）
    const encodedPath = tmpDir.replace(/\//g, '-');
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    // 180 行
    const content = Array.from({ length: 180 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), content);

    try {
      const result = checkMemoryLineCount(tmpDir);
      assert.strictEqual(result.status, 'pass');
      assert.ok(result.message.includes('180'));
    } finally {
      // 清理測試建立的 memory 目錄
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test('C3: MEMORY.md 超過 200 行時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const encodedPath = tmpDir.replace(/\//g, '-');
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    // 220 行
    const content = Array.from({ length: 220 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), content);

    try {
      const result = checkMemoryLineCount(tmpDir);
      assert.strictEqual(result.status, 'fail');
      assert.strictEqual(result.severity, 'warn');
      assert.strictEqual(result.details.length, 1);
      assert.strictEqual(result.details[0].actual, 220);
      assert.strictEqual(result.details[0].expected, 200);
      assert.ok(result.details[0].context.includes('超出 20 行'));
    } finally {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// ─── C4 死引用掃描 ─────────────────────────────────────────────────────

test('C4: 無死引用時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立 agent 記憶目錄（用 .claude/agent-memory/ 相對路徑）
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // 建立一個實際存在的檔案
    const realFile = path.join(tmpDir, 'plugins', 'vibe', 'scripts', 'lib', 'registry.js');
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, '// registry');

    // 記憶檔引用這個存在的路徑
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '詳見 `plugins/vibe/scripts/lib/registry.js` 的設計'
    );

    const result = scanDeadReferences(tmpDir);
    assert.strictEqual(result.id, 'C4');
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

test('C4: 發現死引用時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // 引用不存在的路徑
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '舊模組路徑：`plugins/vibe/scripts/lib/old-module.js` 已刪除'
    );

    const result = scanDeadReferences(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.severity, 'warn');
    assert.ok(result.details.length > 0);
    const detail = result.details[0];
    assert.ok(detail.context.includes('old-module.js'));
  } finally {
    cleanup();
  }
});

test('C4: 排除 http URL 不視為路徑', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // URL 不應被視為路徑
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '參考 `https://github.com/anthropics/claude-code/issues/4953`'
    );

    const result = scanDeadReferences(tmpDir);
    // URL 被排除，沒有死引用
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

test('C4: 排除 {placeholder} 模板路徑', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // placeholder 路徑不應被驗證
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '格式：`~/.claude/{name}-{sessionId}.json`'
    );

    const result = scanDeadReferences(tmpDir);
    // placeholder 被排除
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

test('C4: 掃描 agent 記憶目錄不存在時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 不建立任何記憶目錄
    const result = scanDeadReferences(tmpDir);
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

// ─── C5 過時版號引用 ───────────────────────────────────────────────────

test('C5: 同 major 版號引用不報告', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });

    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });
    // 引用同 major 的舊版號（v2.0.2）
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      'v2.0.2 Pipeline v4 穩定化完成'
    );

    const result = scanStaleVersions(tmpDir);
    assert.strictEqual(result.id, 'C5');
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

test('C5: 舊 major 版號引用標記 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });

    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });
    // 引用舊 major 的版號（v1.0.43）
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      'v1.0.43 Pipeline 閉環重構完成，參見架構演進說明'
    );

    const result = scanStaleVersions(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.severity, 'info');
    assert.ok(result.details.length > 0);
    assert.ok(result.details[0].context.includes('v1.0.43'));
    assert.ok(result.details[0].context.includes('major: 1'));
    assert.ok(result.details[0].context.includes('current major: 2'));
  } finally {
    cleanup();
  }
});

test('C5: 無版號引用時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });

    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '這個記憶檔沒有任何版號引用'
    );

    const result = scanStaleVersions(tmpDir);
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

test('C5: plugin.json 不存在時跳過掃描', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 不建立 plugin.json
    const result = scanStaleVersions(tmpDir);
    assert.strictEqual(result.status, 'pass');
    assert.ok(result.message.includes('無法取得'));
  } finally {
    cleanup();
  }
});

// ─── C6 Agent 記憶行數 ─────────────────────────────────────────────────

test('C6: agent 記憶目錄不存在時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const result = checkAgentMemoryLines(tmpDir);
    assert.strictEqual(result.id, 'C6');
    assert.strictEqual(result.status, 'pass');
    assert.ok(result.message.includes('無 agent 記憶目錄'));
  } finally {
    cleanup();
  }
});

test('C6: 所有 agent 記憶未超限時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agents = ['vibe-planner', 'vibe-architect', 'vibe-developer'];
    for (const agentName of agents) {
      const dir = path.join(tmpDir, '.claude', 'agent-memory', agentName);
      fs.mkdirSync(dir, { recursive: true });
      // 100 行，未超限
      const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), content);
    }

    const result = checkAgentMemoryLines(tmpDir);
    assert.strictEqual(result.status, 'pass');
    assert.deepStrictEqual(result.details, []);
  } finally {
    cleanup();
  }
});

test('C6: 部分 agent 記憶超限時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // vibe-architect: 210 行（超限）
    const archDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-architect');
    fs.mkdirSync(archDir, { recursive: true });
    const archContent = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(archDir, 'MEMORY.md'), archContent);

    // vibe-developer: 250 行（超限）
    const devDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(devDir, { recursive: true });
    const devContent = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(devDir, 'MEMORY.md'), devContent);

    // vibe-planner: 50 行（正常）
    const planDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'MEMORY.md'), 'normal content');

    const result = checkAgentMemoryLines(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.severity, 'warn');
    assert.strictEqual(result.details.length, 2, '應有 2 個超限的 agent');
    const archDetail = result.details.find(d => d.file.includes('vibe-architect'));
    assert.ok(archDetail, '應有 vibe-architect 的 detail');
    assert.strictEqual(archDetail.actual, 210);
    assert.strictEqual(archDetail.expected, 200);
  } finally {
    cleanup();
  }
});

// ─── runAudit 完整報告 ─────────────────────────────────────────────────

test('runAudit: 完整報告結構', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, {
      skills: ['skill-a', 'skill-b'],
      version: '2.0.7',
    });
    writeClaudeMd(tmpDir, { version: '2.0.7', skills: 2 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const report = runAudit(tmpDir);

    // 必須有的頂層欄位
    assert.ok(report.timestamp, 'timestamp 應存在');
    assert.ok(new Date(report.timestamp).toISOString() === report.timestamp, 'timestamp 應為 ISO 格式');
    assert.ok(report.summary, 'summary 應存在');
    assert.ok(typeof report.summary.errors === 'number', 'summary.errors 應為數字');
    assert.ok(typeof report.summary.warnings === 'number', 'summary.warnings 應為數字');
    assert.ok(typeof report.summary.info === 'number', 'summary.info 應為數字');
    assert.ok(Array.isArray(report.checks), 'checks 應為陣列');
    assert.strictEqual(report.checks.length, 6, '應有 C1~C6 共 6 個 check');
  } finally {
    cleanup();
  }
});

test('runAudit: 每個 check 結構正確', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    writeClaudeMd(tmpDir, { version: '2.0.7' });

    const report = runAudit(tmpDir);

    for (const check of report.checks) {
      assert.ok(check.id, `${check.id} 應有 id`);
      assert.ok(check.name, `${check.id} 應有 name`);
      assert.ok(['error', 'warn', 'info'].includes(check.severity), `${check.id} severity 應為合法值`);
      assert.ok(['pass', 'fail'].includes(check.status), `${check.id} status 應為 pass/fail`);
      assert.ok(typeof check.message === 'string', `${check.id} 應有 message`);
      assert.ok(Array.isArray(check.details), `${check.id} details 應為陣列`);
    }

    // 確認 ID 順序
    const ids = report.checks.map(c => c.id);
    assert.deepStrictEqual(ids, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  } finally {
    cleanup();
  }
});

test('runAudit: summary 統計正確（有 fail 時）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, {
      skills: ['skill-a', 'skill-b'],
      version: '2.0.7',
    });
    // CLAUDE.md 版號故意不一致（C2 FAIL），skills 數也不一致（C1 FAIL）
    writeClaudeMd(tmpDir, { version: '2.0.6', skills: 99 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const report = runAudit(tmpDir);

    // C1 + C2 都是 error，所以 errors >= 2
    assert.ok(report.summary.errors >= 2, `errors 應 >= 2，但得 ${report.summary.errors}`);
    // 總 fail 數 = errors + warnings + info
    const totalFails = report.summary.errors + report.summary.warnings + report.summary.info;
    const actualFails = report.checks.filter(c => c.status === 'fail').length;
    assert.strictEqual(totalFails, actualFails, 'summary 統計應與實際 fail 數一致');
  } finally {
    cleanup();
  }
});

test('runAudit: 使用 process.cwd() 當 projectRoot 未提供', () => {
  // 只確認函式可正常呼叫，不 crash
  const report = runAudit(undefined);
  assert.ok(report.timestamp);
  assert.ok(report.checks.length === 6);
});

// ─── 模組匯出驗證 ──────────────────────────────────────────────────────

test('模組匯出所有必要函式', () => {
  const mod = require('../scripts/tools/memory-audit.js');
  const expectedExports = [
    'countActual', 'parseClaudeMd',
    'checkComponentConsistency', 'checkVersionConsistency',
    'checkMemoryLineCount', 'scanDeadReferences',
    'scanStaleVersions', 'checkAgentMemoryLines',
    'runAudit',
  ];
  for (const name of expectedExports) {
    assert.strictEqual(typeof mod[name], 'function', `${name} 應為函式`);
  }
});

// ─── C1 補充：CLAUDE.md 其他欄位不一致（Agents / Hooks / Scripts）────

test('C1: CLAUDE.md Agents 數不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 實際 agents=2，CLAUDE.md 寫 12
    setupPluginStructure(tmpDir, { agents: 2 });
    writeClaudeMd(tmpDir, { agents: 12 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    const detail = result.details.find(d => d.context && d.context.includes('Agents'));
    assert.ok(detail, '應有 CLAUDE.md Agents 相關 detail');
    assert.strictEqual(detail.expected, 12);
    assert.strictEqual(detail.actual, 2);
  } finally {
    cleanup();
  }
});

test('C1: CLAUDE.md Hooks 數不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 實際 hooks=3（3 個 hook 條目），CLAUDE.md 寫 19
    setupPluginStructure(tmpDir, { hooks: 3 });
    writeClaudeMd(tmpDir, { hooks: 19 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    const detail = result.details.find(d => d.context && d.context.includes('Hooks'));
    assert.ok(detail, '應有 CLAUDE.md Hooks 相關 detail');
    assert.strictEqual(detail.expected, 19);
    assert.strictEqual(detail.actual, 3);
  } finally {
    cleanup();
  }
});

test('C1: CLAUDE.md Scripts 數不一致時返回 fail', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // hookScripts=2 + libFiles=['lib.js'] = scripts=3，CLAUDE.md 寫 50
    setupPluginStructure(tmpDir, { hookScripts: 2, libFiles: ['lib.js'] });
    writeClaudeMd(tmpDir, { scripts: 50 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    const result = checkComponentConsistency(tmpDir);
    assert.strictEqual(result.status, 'fail');
    const detail = result.details.find(d => d.context && d.context.includes('Scripts'));
    assert.ok(detail, '應有 CLAUDE.md Scripts 相關 detail');
    assert.strictEqual(detail.expected, 50);
    assert.strictEqual(detail.actual, 3);
  } finally {
    cleanup();
  }
});

test('C1: hooks.json 格式異常時 graceful fallback（hooks=0）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir);
    // 覆寫 hooks.json 為非法 JSON
    const hooksFile = path.join(tmpDir, 'plugins', 'vibe', 'hooks', 'hooks.json');
    fs.writeFileSync(hooksFile, '{ invalid json %%%');
    writeClaudeMd(tmpDir, { hooks: 0 });
    writePluginSpecs(tmpDir, ['skill-a', 'skill-b']);

    // 應不崩潰，hooks 計算為 0（fallback）
    const result = checkComponentConsistency(tmpDir);
    assert.ok(['pass', 'fail'].includes(result.status), '應返回合法 status');
    const actual = countActual(path.join(tmpDir, 'plugins', 'vibe'));
    assert.strictEqual(actual.hooks, 0, 'JSON 異常時 hooks 應 fallback 為 0');
  } finally {
    cleanup();
  }
});

test('C1: plugin-specs.json 格式異常時 graceful fallback（僅比對 CLAUDE.md）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { skills: ['skill-a', 'skill-b'], hookScripts: 2, libFiles: ['lib.js'] });
    writeClaudeMd(tmpDir, { skills: 2, agents: 2, hooks: 3, scripts: 3 });
    // plugin-specs.json 非法 JSON
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'plugin-specs.json'), '{ NOT JSON }');

    const result = checkComponentConsistency(tmpDir);
    // specs 無法解析 → 只比對 CLAUDE.md → CLAUDE.md 一致 → pass
    assert.strictEqual(result.status, 'pass');
  } finally {
    cleanup();
  }
});

// ─── C2 補充：plugin.json 不存在 ────────────────────────────────────

test('C2: plugin.json 不存在時返回 pass 且訊息含「不存在」', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立 CLAUDE.md 但不建 plugin.json
    writeClaudeMd(tmpDir, { version: '2.0.7' });
    // pluginRoot 目錄存在但 .claude-plugin/plugin.json 不存在

    const result = checkVersionConsistency(tmpDir);
    assert.strictEqual(result.id, 'C2');
    assert.strictEqual(result.status, 'pass');
    assert.ok(
      result.message.includes('不存在') || result.message.includes('plugin.json'),
      `message 應提示 plugin.json 不存在，但得到：${result.message}`
    );
  } finally {
    cleanup();
  }
});

test('C2: CLAUDE.md 不存在時返回 pass', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    // 不建立 CLAUDE.md

    const result = checkVersionConsistency(tmpDir);
    assert.strictEqual(result.status, 'pass');
    // claudeVersion 為 null → 無法比對 → pass
  } finally {
    cleanup();
  }
});

// ─── C4 補充：掃描範圍、code-block、多記憶檔 ───────────────────────

test('C4: 掃描範圍涵蓋多個記憶檔（死引用在不同記憶檔中）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // agent A 有死引用
    const agentA = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(agentA, { recursive: true });
    fs.writeFileSync(
      path.join(agentA, 'MEMORY.md'),
      '舊路徑：`plugins/vibe/scripts/lib/dead-a.js`'
    );

    // agent B 有死引用
    const agentB = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-architect');
    fs.mkdirSync(agentB, { recursive: true });
    fs.writeFileSync(
      path.join(agentB, 'MEMORY.md'),
      '舊路徑：`plugins/vibe/scripts/lib/dead-b.js`'
    );

    const result = scanDeadReferences(tmpDir);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.details.length, 2, '兩個記憶檔各有一個死引用');
    const files = result.details.map(d => d.file);
    assert.ok(files.some(f => f.includes('vibe-planner')), '應包含 vibe-planner 的死引用');
    assert.ok(files.some(f => f.includes('vibe-architect')), '應包含 vibe-architect 的死引用');
  } finally {
    cleanup();
  }
});

test('C4: 掃描總記憶檔數包含專案記憶檔 + agent 記憶檔', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立專案記憶檔（gatherMemoryFiles 動態掃描 memory/ 目錄）
    const encodedPath = tmpDir.replace(/\//g, '-');
    const memDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    for (const name of ['MEMORY.md', 'debugging.md', 'design-principles.md', 'research-findings.md']) {
      fs.writeFileSync(path.join(memDir, name), '正常記憶，無路徑引用。');
    }

    // 建立 agent memory（無引用）
    const agentDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), '正常記憶，無路徑引用。');

    const result = scanDeadReferences(tmpDir);
    // 4 個專案記憶檔 + 1 個 agent 記憶檔 = 5 個
    assert.ok(result.message.includes('5'), `應掃描 5 個記憶檔，訊息：${result.message}`);

    // 清理測試用記憶目錄
    fs.rmSync(memDir, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test('C4: code block 內含路徑字串（無反引號包裹）不被視為路徑引用', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // 三反引號 code block 內有路徑字串（不被反引號包裹）
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      '```\nplugins/nonexistent/path.js 範例\n```\n\n正常文字無路徑引用。'
    );

    const result = scanDeadReferences(tmpDir);
    // code block 內文字未被 backtick 包裹，extractPaths 不會提取
    assert.strictEqual(result.status, 'pass', 'code block 內純文字路徑不應被視為引用');
  } finally {
    cleanup();
  }
});

test('C4: 有效的 ~/.claude 路徑引用不報告死引用', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });

    // ~/.claude 路徑（home dir 下通常存在）
    const homeClaudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(homeClaudeDir, { recursive: true });

    // 引用 ~/.claude 目錄本身（存在）
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      `狀態檔放在 \`~/.claude\` 目錄下`
    );

    const result = scanDeadReferences(tmpDir);
    // ~/.claude 目錄存在 → pass
    assert.strictEqual(result.status, 'pass', '~/.claude 存在時不應報告死引用');
  } finally {
    cleanup();
  }
});

// ─── C5 補充：CLAUDE.md 版號不掃描 / 多版號混合 ────────────────────

test('C5: CLAUDE.md 中的歷史版號引用不被掃描', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    // CLAUDE.md 含 v1.x 歷史說明（SoT，不在掃描範圍）
    writeClaudeMd(tmpDir, { version: '2.0.7' });
    // 直接覆寫 CLAUDE.md 加上 v1.x 引用
    const claudeMdContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      claudeMdContent + '\n\n## 歷史版本\n\nv1.0.43 Pipeline 閉環重構完成。\n'
    );

    // 不建立 agent memory，只有 CLAUDE.md
    const result = scanStaleVersions(tmpDir);
    // CLAUDE.md 不在掃描範圍，應 pass（或 fail 僅因 agent memory 不存在 → pass）
    assert.strictEqual(result.status, 'pass', 'CLAUDE.md 歷史版號引用不應被 C5 偵測');
  } finally {
    cleanup();
  }
});

test('C5: 記憶檔含同 major 與舊 major 混合版號，只報告舊 major', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });

    const agentMemDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-developer');
    fs.mkdirSync(agentMemDir, { recursive: true });
    // 同 major（v2.0.2）不報告，舊 major（v1.0.43）報告
    fs.writeFileSync(
      path.join(agentMemDir, 'MEMORY.md'),
      'v2.0.2 Pipeline v4 穩定化完成\nv1.0.43 Pipeline 閉環重構完成\nv1.0.55 三項改善'
    );

    const result = scanStaleVersions(tmpDir);
    assert.strictEqual(result.status, 'fail', '含舊 major 版號應為 fail');
    // 只報告 v1.x（v2.x 不報告）
    const contexts = result.details.map(d => d.context);
    assert.ok(contexts.some(c => c.includes('v1.0.43')), '應報告 v1.0.43');
    assert.ok(contexts.some(c => c.includes('v1.0.55')), '應報告 v1.0.55');
    assert.ok(!contexts.some(c => c.includes('v2.0.2')), '不應報告 v2.0.2（同 major）');
  } finally {
    cleanup();
  }
});

test('C5: 版號正則 lastIndex 重設（連續掃描多個檔案）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });

    // 建立兩個各有舊版號的 agent
    for (const agentName of ['vibe-planner', 'vibe-architect']) {
      const dir = path.join(tmpDir, '.claude', 'agent-memory', agentName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), `${agentName} v1.0.10 舊記憶`);
    }

    const result = scanStaleVersions(tmpDir);
    // 兩個檔案各有 v1.0.10 → 應有 2 個 detail（重複版號在同一檔去重，但跨檔不去重）
    assert.strictEqual(result.status, 'fail');
    assert.ok(result.details.length >= 2, `應至少有 2 個 detail（兩個 agent 各一），得 ${result.details.length}`);
  } finally {
    cleanup();
  }
});

// ─── C6 補充：agent 目錄無 MEMORY.md 時跳過 ─────────────────────────

test('C6: agent 目錄存在但無 MEMORY.md 時跳過不報錯', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立 agent 目錄但不建 MEMORY.md
    const agentDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(agentDir, { recursive: true });
    // 只有一個非 MEMORY.md 檔案
    fs.writeFileSync(path.join(agentDir, 'other.md'), '其他記憶檔');

    const result = checkAgentMemoryLines(tmpDir);
    assert.strictEqual(result.status, 'pass');
    assert.deepStrictEqual(result.details, [], '無 MEMORY.md 的 agent 不應出現在 details');
  } finally {
    cleanup();
  }
});

// ─── runAudit 補充：summary 統計計數 ─────────────────────────────────

test('runAudit: summary.warnings 計數正確（C3 或 C6 fail）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // C6 触發 warn：agent 記憶超限
    const agentDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(agentDir, { recursive: true });
    const content = Array.from({ length: 210 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), content);

    setupPluginStructure(tmpDir, { version: '2.0.7', skills: ['skill-a'], hookScripts: 2, libFiles: ['lib.js'] });
    writeClaudeMd(tmpDir, { version: '2.0.7', skills: 1, agents: 2, hooks: 3, scripts: 3 });
    writePluginSpecs(tmpDir, ['skill-a']);

    const report = runAudit(tmpDir);
    // C6 應 fail with severity=warn
    const c6 = report.checks.find(c => c.id === 'C6');
    assert.strictEqual(c6.status, 'fail', 'C6 應 fail');
    assert.strictEqual(c6.severity, 'warn', 'C6 severity 應為 warn');
    // summary.warnings 應計入 C6
    assert.ok(report.summary.warnings >= 1, `summary.warnings 應 >= 1，但得 ${report.summary.warnings}`);
  } finally {
    cleanup();
  }
});

test('runAudit: summary.info 計數正確（C5 fail）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7', skills: ['skill-a'], hookScripts: 2, libFiles: ['lib.js'] });
    writeClaudeMd(tmpDir, { version: '2.0.7', skills: 1, agents: 2, hooks: 3, scripts: 3 });
    writePluginSpecs(tmpDir, ['skill-a']);

    // 觸發 C5 fail（info 嚴重度）
    const agentDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), 'v1.0.43 舊版本引用');

    const report = runAudit(tmpDir);
    const c5 = report.checks.find(c => c.id === 'C5');
    assert.strictEqual(c5.status, 'fail', 'C5 應 fail');
    assert.strictEqual(c5.severity, 'info', 'C5 severity 應為 info');
    assert.ok(report.summary.info >= 1, `summary.info 應 >= 1，但得 ${report.summary.info}`);
  } finally {
    cleanup();
  }
});

test('runAudit: summary 各計數互斥（errors+warnings+info = 總 fail 數）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 觸發 C1(error) + C2(error) + C5(info) 同時 fail
    setupPluginStructure(tmpDir, { version: '2.0.7', skills: ['skill-a'] });
    // C1 fail: CLAUDE.md skills=99 不一致
    // C2 fail: CLAUDE.md version=1.0.0 不一致
    writeClaudeMd(tmpDir, { version: '1.0.0', skills: 99 });
    writePluginSpecs(tmpDir, ['skill-a']);

    // C5 fail: agent memory 有舊版號
    const agentDir = path.join(tmpDir, '.claude', 'agent-memory', 'vibe-planner');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), 'v1.0.43 舊版本');

    const report = runAudit(tmpDir);
    const totalSummary = report.summary.errors + report.summary.warnings + report.summary.info;
    const actualFails = report.checks.filter(c => c.status === 'fail').length;
    assert.strictEqual(totalSummary, actualFails, 'summary 計數總和應等於實際 fail 數');
  } finally {
    cleanup();
  }
});

test('runAudit: 接受自訂 projectRoot 參數（CLI 路徑模式）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    setupPluginStructure(tmpDir, { version: '2.0.7' });
    writeClaudeMd(tmpDir, { version: '2.0.7' });

    // 明確傳入 tmpDir 路徑（模擬 CLI process.argv[2]）
    const report = runAudit(tmpDir);
    assert.ok(report.timestamp, '應有 timestamp');
    assert.strictEqual(report.checks.length, 6, '應有 6 個 checks');

    // 確認使用了自訂路徑（C2 版號一致）
    const c2 = report.checks.find(c => c.id === 'C2');
    assert.strictEqual(c2.status, 'pass', 'C2 版號應一致');
  } finally {
    cleanup();
  }
});

// ─── gatherMemoryFiles 範圍確認 ────────────────────────────────────

test('C4: 掃描範圍包含 debugging.md / design-principles.md / research-findings.md', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    // 建立專案記憶目錄和多個記憶檔
    const encodedPath = tmpDir.replace(/\//g, '-');
    const projectMemoryDir = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'memory');
    fs.mkdirSync(projectMemoryDir, { recursive: true });

    // 在 debugging.md 放一個死引用
    fs.writeFileSync(
      path.join(projectMemoryDir, 'debugging.md'),
      '除錯相關：`plugins/vibe/scripts/lib/nonexistent-debug.js`'
    );
    // MEMORY.md、design-principles.md、research-findings.md 正常
    fs.writeFileSync(path.join(projectMemoryDir, 'MEMORY.md'), '正常記憶');
    fs.writeFileSync(path.join(projectMemoryDir, 'design-principles.md'), '設計原則，無路徑引用');
    fs.writeFileSync(path.join(projectMemoryDir, 'research-findings.md'), '研究發現，無路徑引用');

    try {
      const result = scanDeadReferences(tmpDir);
      assert.strictEqual(result.status, 'fail', 'debugging.md 的死引用應被偵測');
      assert.ok(
        result.details.some(d => d.file.includes('debugging.md')),
        '應包含 debugging.md 的死引用 detail'
      );
    } finally {
      fs.rmSync(projectMemoryDir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// ─── countActual 補充：tools 目錄計算 ─────────────────────────────

test('countActual: tools 目錄的 .js 和 .sh 都計入 scripts', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const { toolsDir } = setupPluginStructure(tmpDir, {
      skills: ['skill-a'],
      hookScripts: 1,
      libFiles: ['lib.js'],
    });
    // 新增 tools 檔案（1 .js + 1 .sh）
    fs.writeFileSync(path.join(toolsDir, 'tool.js'), '// tool');
    fs.writeFileSync(path.join(toolsDir, 'tool.sh'), '#!/bin/sh');

    const counts = countActual(path.join(tmpDir, 'plugins', 'vibe'));
    // hookScripts(1) + lib(1) + tools(2) = 4
    assert.strictEqual(counts.scripts, 4, `scripts 應為 4，得 ${counts.scripts}`);
  } finally {
    cleanup();
  }
});

test('countActual: lib 目錄遞迴計算（子目錄中的 .js 檔）', () => {
  const { tmpDir, cleanup } = makeTmpProject();
  try {
    const pluginRoot = path.join(tmpDir, 'plugins', 'vibe');
    setupPluginStructure(tmpDir, {
      hookScripts: 0,
      libFiles: ['lib-a.js'],
    });

    // 在 lib 子目錄新增更多 .js 檔
    const flowDir = path.join(pluginRoot, 'scripts', 'lib', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, 'dag-state.js'), '// dag-state');
    fs.writeFileSync(path.join(flowDir, 'classifier.js'), '// classifier');

    const counts = countActual(pluginRoot);
    // hookScripts(0) + lib(1 + 2=3) + tools(0) = 3
    assert.strictEqual(counts.scripts, 3, `scripts 應為 3（遞迴計算 lib），得 ${counts.scripts}`);
  } finally {
    cleanup();
  }
});

// ─── parseClaudeMd 補充：panoramaHooks 解析 ──────────────────────────

test('parseClaudeMd: Hooks 全景中的 hooks 數解析', () => {
  const content = `
## Plugin 架構
| **vibe** | 2.0.7 | 全方位 | 35 | 12 | 19 | 50 |

## Hooks 全景

統一 hooks.json，19 hooks 按事件分組（順序明確）：

## 目錄結構
\`\`\`
hooks.json  # 統一 19 hooks
hooks/      # 15 個 hook 腳本
\`\`\`
`;
  const result = parseClaudeMd(content);
  assert.strictEqual(result.panoramaHooks, 19, 'panoramaHooks 應為 19');
  assert.strictEqual(result.dirHooks, 19, 'dirHooks 應為 19');
  assert.strictEqual(result.dirHookScripts, 15, 'dirHookScripts 應為 15');
  assert.strictEqual(result.tableVersion, '2.0.7');
  assert.strictEqual(result.tableSkills, 35);
  assert.strictEqual(result.tableAgents, 12);
  assert.strictEqual(result.tableHooks, 19);
  assert.strictEqual(result.tableScripts, 50);
});

// ─── 結果 ─────────────────────────────────────────────────────────────

console.log(`\n=== memory-audit.test.js: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
