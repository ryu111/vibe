#!/usr/bin/env node
/**
 * generate-vibe-doc.js — 從 plugin 原始碼自動產生 docs/ref/vibe.md
 *
 * 資料來源：
 *   - plugins/vibe/.claude-plugin/plugin.json（版號）
 *   - plugins/vibe/hooks/hooks.json（hook 定義）
 *   - plugins/vibe/pipeline.json（pipeline 階段）
 *   - plugins/vibe/skills/{name}/SKILL.md（skill frontmatter）
 *   - plugins/vibe/scripts/hooks/{name}.js（hook 腳本列表）
 *   - plugins/vibe/scripts/lib/{深層}（共用函式庫列表）
 *   - dashboard/data/meta.json（agent metadata）
 *
 * 此檔案由 generate.js main() 引入呼叫
 */

const fs = require('fs');
const path = require('path');

// ─── 模組映射（設計決策，新增組件時需更新） ───

const SKILL_MODULE_MAP = {
  scope: 'Flow', architect: 'Flow', checkpoint: 'Flow',
  'context-status': 'Flow', 'env-detect': 'Flow', cancel: 'Flow',
  review: 'Sentinel', lint: 'Sentinel', format: 'Sentinel',
  security: 'Sentinel', tdd: 'Sentinel', e2e: 'Sentinel',
  qa: 'Sentinel', coverage: 'Sentinel', verify: 'Sentinel',
  'coding-standards': 'Patterns', 'frontend-patterns': 'Patterns',
  'backend-patterns': 'Patterns', 'db-patterns': 'Patterns',
  'typescript-patterns': 'Patterns', 'python-patterns': 'Patterns',
  'go-patterns': 'Patterns', 'testing-patterns': 'Patterns',
  evolve: 'Evolve', 'doc-sync': 'Evolve',
  dashboard: 'Dashboard',
  remote: 'Remote', 'remote-config': 'Remote',
  'hook-diag': '診斷',
};

const AGENT_MODULE_MAP = {
  planner: 'Flow', architect: 'Flow', developer: 'Flow',
  'code-reviewer': 'Sentinel', 'security-reviewer': 'Sentinel',
  tester: 'Sentinel', 'build-error-resolver': 'Sentinel',
  'e2e-runner': 'Sentinel', qa: 'Sentinel',
  'doc-updater': 'Evolve',
};

const AGENT_SHORT_DESC = {
  planner: '需求分析 + 分階段計畫',
  architect: '架構方案 + 介面設計',
  developer: '按計畫實作 + 寫測試',
  'code-reviewer': 'CRITICAL→LOW 品質報告',
  'security-reviewer': 'OWASP Top 10 安全報告',
  tester: '獨立測試視角',
  'build-error-resolver': '最小修復（最多 3 輪）',
  'e2e-runner': 'UI/API 雙模式 E2E',
  qa: 'API/CLI 行為驗證',
  'doc-updater': '程式碼變更 → 文件更新',
};

const MODULE_INFO = [
  { key: 'Flow',      desc: '開發工作流 + Pipeline 管理' },
  { key: 'Sentinel',  desc: '品質全鏈守衛' },
  { key: 'Patterns',  desc: '語言/框架模式庫' },
  { key: 'Evolve',    desc: '知識進化 + 文件同步' },
  { key: 'Dashboard', desc: 'Pipeline 即時儀表板' },
  { key: 'Remote',    desc: 'Telegram 遠端控制' },
  { key: '診斷',      desc: 'Hook 錯誤診斷' },
];

const HOOK_META_MAP = {
  'pipeline-init':         { module: 'Flow',      strength: '—',      desc: '環境偵測 + state file 初始化' },
  'dashboard-autostart':   { module: 'Dashboard', strength: '—',      desc: '自動啟動 WebSocket server' },
  'remote-autostart':      { module: 'Remote',    strength: '—',      desc: '自動啟動 bot daemon' },
  'task-classifier':       { module: 'Flow',      strength: '軟→強',  desc: '任務分類 + pipeline 階段注入' },
  'remote-prompt-forward': { module: 'Remote',    strength: '—',      desc: '使用者輸入轉發 Telegram' },
  'delegation-tracker':    { module: 'Flow',      strength: '—',      desc: '標記 delegationActive' },
  'pipeline-guard':        { module: 'Flow',      strength: '硬阻擋', desc: '阻擋 Write|Edit|AskUserQuestion|EnterPlanMode（需用 delegation 或 /vibe:scope）' },
  'suggest-compact':       { module: 'Flow',      strength: '軟建議', desc: '50 calls 建議 compact' },
  'danger-guard':          { module: 'Sentinel',  strength: '硬阻擋', desc: '攔截 rm -rf、DROP TABLE 等' },
  'remote-ask-intercept':  { module: 'Remote',    strength: '—',      desc: 'AskUserQuestion → inline keyboard' },
  'auto-lint':             { module: 'Sentinel',  strength: '強建議', desc: '自動 lint + systemMessage' },
  'auto-format':           { module: 'Sentinel',  strength: '—',      desc: '自動格式化（靜默）' },
  'test-check':            { module: 'Sentinel',  strength: '軟建議', desc: '修改程式碼 → 提醒跑測試' },
  'log-compact':           { module: 'Flow',      strength: '—',      desc: '記錄 compact + 重設計數' },
  'stage-transition':      { module: 'Flow',      strength: '強建議', desc: '判斷下一步（前進/回退/跳過）' },
  'remote-sender':         { module: 'Remote',    strength: '—',      desc: 'Pipeline stage 完成 → Telegram' },
  'pipeline-check':        { module: 'Flow',      strength: '強建議', desc: '結束前檢查遺漏階段' },
  'task-guard':            { module: 'Flow',      strength: '硬阻擋', desc: '未完成任務時 block 退出' },
  'check-console-log':     { module: 'Sentinel',  strength: '強建議', desc: '偵測殘留 console.log/debugger' },
  'dashboard-refresh':     { module: 'Dashboard', strength: '—',      desc: '觸發 Dashboard 同步鏈' },
  'remote-receipt':        { module: 'Remote',    strength: '—',      desc: '/say 已讀回條 + 回合摘要' },
};

const HOOK_SCRIPT_MODULE = {
  'pipeline-init.js': 'Flow', 'task-classifier.js': 'Flow',
  'delegation-tracker.js': 'Flow', 'pipeline-guard.js': 'Flow',
  'suggest-compact.js': 'Flow', 'log-compact.js': 'Flow',
  'stage-transition.js': 'Flow', 'pipeline-check.js': 'Flow',
  'task-guard.js': 'Flow', 'auto-lint.js': 'Sentinel',
  'auto-format.js': 'Sentinel', 'test-check.js': 'Sentinel',
  'danger-guard.js': 'Sentinel', 'check-console-log.js': 'Sentinel',
  'dashboard-autostart.js': 'Dashboard', 'dashboard-refresh.js': 'Dashboard',
  'remote-autostart.js': 'Remote', 'remote-prompt-forward.js': 'Remote',
  'remote-ask-intercept.js': 'Remote', 'remote-sender.js': 'Remote',
  'remote-receipt.js': 'Remote',
};

const LIB_DESC_MAP = {
  'registry.js':           { dir: '（根）',      desc: '全域 metadata — STAGES/AGENTS/EMOJI' },
  'hook-logger.js':        { dir: '（根）',      desc: 'Hook 錯誤日誌 — 寫入 ~/.claude/hook-errors.log' },
  'env-detector.js':       { dir: 'flow/',       desc: '環境偵測（語言/框架/PM/工具）' },
  'counter.js':            { dir: 'flow/',       desc: 'tool call 計數器' },
  'pipeline-discovery.js': { dir: 'flow/',       desc: '跨 plugin pipeline 動態發現' },
  'lang-map.js':           { dir: 'sentinel/',   desc: '副檔名→語言→工具映射' },
  'tool-detector.js':      { dir: 'sentinel/',   desc: '偵測已安裝工具 + 快取' },
  'server-manager.js':     { dir: 'dashboard/',  desc: 'Dashboard server 生命週期' },
  'telegram.js':           { dir: 'remote/',     desc: 'Telegram Bot API 封裝' },
  'transcript.js':         { dir: 'remote/',     desc: 'Transcript JSONL 解析' },
  'bot-manager.js':        { dir: 'remote/',     desc: 'Bot daemon 生命週期' },
};

// ─── 掃描函式 ─────────────────────────────────

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// 掃描所有 skill 的 SKILL.md frontmatter，回傳 [{name, description, module}]
function scanSkillFrontmatter(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  const skills = [];
  if (!fs.existsSync(skillsDir)) return skills;
  for (const dir of fs.readdirSync(skillsDir).sort()) {
    const skillMd = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : dir;
    // 解析 description（單行或多行 >- 格式）
    let desc = '';
    const singleDesc = fm.match(/^description:\s+(?!>)(.+)$/m);
    if (singleDesc) {
      desc = singleDesc[1].trim();
    } else {
      // 多行 >- 格式：擷取後續所有縮排行
      const multiStart = fm.match(/^description:\s*>-?\s*$/m);
      if (multiStart) {
        const after = fm.slice(multiStart.index + multiStart[0].length);
        const lines = [];
        for (const line of after.split('\n')) {
          if (/^\s+\S/.test(line)) lines.push(line.trim());
          else if (line.trim() === '' && lines.length > 0) continue;
          else if (lines.length > 0) break;
        }
        desc = lines.join(' ');
      }
    }
    skills.push({ name, description: desc, module: SKILL_MODULE_MAP[name] || '—' });
  }
  return skills;
}

/** 解析 hooks.json 為扁平列表 [{event, scriptName, matcher, type, module, strength, desc}] */
function flattenHooksJson(hooksJsonPath) {
  const raw = loadJSON(hooksJsonPath);
  const entries = raw.hooks || raw;
  const result = [];
  for (const [event, groups] of Object.entries(entries)) {
    for (const group of groups) {
      const matcher = group.matcher || '*';
      for (const hook of group.hooks) {
        const cmd = hook.command || '';
        const scriptMatch = cmd.match(/([^/]+)\.js$/);
        const scriptName = scriptMatch ? scriptMatch[1] : cmd;
        const meta = HOOK_META_MAP[scriptName] || {};
        result.push({
          event, scriptName, matcher,
          type: hook.type || 'command',
          module: meta.module || '—',
          strength: meta.strength || '—',
          desc: meta.desc || '',
        });
      }
    }
  }
  return result;
}

/** 格式化 hook 事件顯示（含 matcher 縮寫） */
function fmtHookEvent(event, matcher) {
  if (['SessionStart', 'UserPromptSubmit', 'PreCompact', 'SubagentStop', 'Stop'].includes(event)) {
    return event;
  }
  const abbrev = matcher
    .replace('Write|Edit', 'W\\|E')
    .replace('AskUserQuestion', 'Ask')
    .replace('EnterPlanMode', 'EPM');
  return `${event}(${abbrev})`;
}

/** 遞迴掃描目錄下所有 .js 檔案名稱 */
function scanJsRecursive(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      result.push(...scanJsRecursive(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      result.push(entry.name);
    }
  }
  return result;
}

/** inline code helper */
function c(text) { return '`' + text + '`'; }

// ─── 主生成函式 ───────────────────────────────

function generateVibeDoc(specs, metaPath) {
  const ROOT = process.cwd();
  const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'vibe');

  // ── 讀取資料來源 ──
  const pluginJson = loadJSON(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const pluginJsonStr = JSON.stringify(pluginJson, null, 2);
  const version = pluginJson.version;
  const meta = fs.existsSync(metaPath) ? loadJSON(metaPath) : null;
  const pipelineJson = loadJSON(path.join(PLUGIN_ROOT, 'pipeline.json'));
  const hooksJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');

  // ── 掃描組件 ──
  const skills = scanSkillFrontmatter(PLUGIN_ROOT);
  const hooks = flattenHooksJson(hooksJsonPath);
  const hookScripts = fs.readdirSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks'))
    .filter(f => f.endsWith('.js')).sort();
  const libScripts = scanJsRecursive(path.join(PLUGIN_ROOT, 'scripts', 'lib'));

  const totalSkills = skills.length;
  const totalAgents = meta ? Object.keys(meta.agents).length : 0;
  const totalHooks = hooks.length;
  const totalHookScripts = hookScripts.length;
  const totalLibScripts = libScripts.length;
  const totalScripts = totalHookScripts + totalLibScripts;

  // ── 模組統計 ──
  const modStats = {};
  for (const m of MODULE_INFO) modStats[m.key] = { skills: 0, agents: 0, hooks: 0 };
  for (const s of skills) { if (modStats[s.module]) modStats[s.module].skills++; }
  for (const name of Object.keys(meta ? meta.agents : {})) {
    const m = AGENT_MODULE_MAP[name];
    if (m && modStats[m]) modStats[m].agents++;
  }
  for (const h of hooks) { if (modStats[h.module]) modStats[h.module].hooks++; }

  const agentOrder = meta ? Object.keys(meta.agents) : [];

  // ── 組合文件 ──
  const d = [];
  const hr = '\n---\n';

  // ━━━ Header ━━━
  d.push('# vibe — 統一開發工作流 Plugin');
  d.push('');
  d.push(`> **版本**：${version}`);
  d.push('> **定位**：全方位開發工作流 — 規劃、品質守衛、知識庫、即時監控、遠端控制');
  d.push(`> **架構**：${MODULE_INFO.length} 個功能模組合併為單一 plugin，共用 registry.js 統一 metadata`);
  d.push('>');
  d.push(`> **此檔案由 ${c('dashboard/scripts/generate.js')} 自動產生，請勿手動編輯。**`);
  d.push(`> 修改來源：plugin 原始碼（SKILL.md / agent .md / hooks.json / scripts/）`);

  // ━━━ §1 概述 ━━━
  d.push(hr);
  d.push('## 1. 概述');
  d.push('');
  d.push(`vibe 是 Vibe marketplace 的核心 plugin，合併了 ${MODULE_INFO.length} 個功能模組：`);
  d.push('');
  d.push('| 模組 | 定位 | 組件概要 |');
  d.push('|------|------|---------|');
  for (const m of MODULE_INFO) {
    const s = modStats[m.key];
    const parts = [];
    if (s.skills) parts.push(`${s.skills}S`);
    if (s.agents) parts.push(`${s.agents}A`);
    if (s.hooks) parts.push(`${s.hooks}H`);
    d.push(`| **${m.key}** | ${m.desc} | ${parts.join(' + ') || '—'} |`);
  }
  d.push('');
  d.push(`**合計**：${totalSkills} Skills + ${totalAgents} Agents + ${totalHooks} Hooks + ${totalScripts} Scripts`);
  d.push('');
  d.push('### 設計原則');
  d.push('');
  d.push('- **先想清楚再寫碼**（Flow）— Pipeline 引導每一步');
  d.push('- **寫完就檢查**（Sentinel）— 問題不過夜');
  d.push('- **Claude 知道越多，寫越好**（Patterns）— 純知識注入');
  d.push('- **文件是程式碼的影子**（Evolve）— 自動同步');
  d.push('- **離開電腦也能掌控**（Remote）— 遊戲外掛模式');
  d.push('');
  d.push('### 與外部 plugin 的關係');
  d.push('');
  d.push('- **forge**：獨立 plugin（造工具的工具），不在 vibe 內');
  d.push('- **claude-mem**：獨立 plugin（記憶持久化），推薦搭配但非依賴');

  // ━━━ §2 組件清單 ━━━
  d.push(hr);
  d.push('## 2. 完整組件清單');
  d.push('');

  // Skills
  d.push(`### Skills（${totalSkills} 個）`);
  d.push('');
  d.push('| # | 名稱 | 模組 | 說明 |');
  d.push('|:-:|------|:----:|------|');
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    d.push(`| ${i + 1} | ${c(s.name)} | ${s.module} | ${s.description} |`);
  }
  d.push('');

  // Agents
  d.push(`### Agents（${totalAgents} 個）`);
  d.push('');
  d.push('| # | 名稱 | 模組 | Model | 權限 | 色彩 | 說明 |');
  d.push('|:-:|------|:----:|:-----:|:----:|:----:|------|');
  for (let i = 0; i < agentOrder.length; i++) {
    const name = agentOrder[i];
    const ag = meta.agents[name];
    const module = AGENT_MODULE_MAP[name] || '—';
    const desc = AGENT_SHORT_DESC[name] || '';
    d.push(`| ${i + 1} | ${c(name)} | ${module} | ${ag.model} | ${ag.permissionMode} | ${ag.color} | ${desc} |`);
  }
  d.push('');

  // Hooks
  d.push(`### Hooks（${totalHooks} 個）`);
  d.push('');
  d.push('| # | 事件 | 名稱 | 模組 | 類型 | 強度 | 說明 |');
  d.push('|:-:|------|------|:----:|:----:|:----:|------|');
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    d.push(`| ${i + 1} | ${fmtHookEvent(h.event, h.matcher)} | ${h.scriptName} | ${h.module} | ${h.type} | ${h.strength} | ${h.desc} |`);
  }
  d.push('');

  // Scripts
  d.push(`### Scripts（${totalScripts} 個）`);
  d.push('');
  d.push(`**Hook 腳本（${totalHookScripts} 個）** — ${c('scripts/hooks/')}`);
  d.push('');
  d.push('| 名稱 | 模組 | 對應 Hook # |');
  d.push('|------|:----:|:----------:|');
  for (const f of hookScripts) {
    const name = f.replace('.js', '');
    const hookIdx = hooks.findIndex(h => h.scriptName === name);
    const module = HOOK_SCRIPT_MODULE[f] || '—';
    d.push(`| ${f} | ${module} | ${hookIdx >= 0 ? hookIdx + 1 : '—'} |`);
  }
  d.push('');
  d.push(`**共用函式庫（${totalLibScripts} 個）** — ${c('scripts/lib/')}`);
  d.push('');
  d.push('| 名稱 | 子目錄 | 說明 |');
  d.push('|------|--------|------|');
  for (const f of libScripts) {
    const info = LIB_DESC_MAP[f] || { dir: '—', desc: '' };
    d.push(`| ${f} | ${info.dir} | ${info.desc} |`);
  }

  // ━━━ §3 Pipeline ━━━
  d.push(hr);
  d.push('## 3. Pipeline 8 階段');
  d.push('');
  d.push('```');
  d.push(pipelineJson.stages.join(' → '));
  d.push('```');
  d.push('');
  d.push('| 階段 | Agent | Model/Color | Skill |');
  d.push('|------|-------|-------------|-------|');
  for (const stage of pipelineJson.stages) {
    const prov = pipelineJson.provides[stage];
    const ag = meta && meta.agents[prov.agent];
    const model = ag ? ag.model : '—';
    const color = ag ? ag.color : '—';
    const skill = prov.skill || '—';
    d.push(`| ${stage} | ${prov.agent} | ${model}/${color} | ${skill} |`);
  }
  d.push('');
  d.push('詳見 → [pipeline.md](pipeline.md)');
  d.push('');

  // PIPELINE_VERDICT
  d.push('### PIPELINE_VERDICT 協議');
  d.push('');
  d.push('品質 agents 在報告末尾必須輸出結論標記：');
  d.push('');
  d.push('```');
  d.push('<!-- PIPELINE_VERDICT: PASS|FAIL:CRITICAL|FAIL:HIGH|FAIL:MEDIUM|FAIL:LOW -->');
  d.push('```');
  d.push('');
  d.push('| Agent | PASS 條件 | FAIL 標記 |');
  d.push('|-------|----------|-----------|');
  d.push('| code-reviewer | 無 CRITICAL/HIGH | FAIL:CRITICAL 或 FAIL:HIGH |');
  d.push('| tester | 全部測試通過 | FAIL:HIGH |');
  d.push('| qa | 全部場景通過 | FAIL:HIGH |');
  d.push('| e2e-runner | 全部流程通過 | FAIL:HIGH |');
  d.push('');
  d.push('FAIL:MEDIUM/LOW 不觸發回退，僅供參考。');
  d.push('');

  // 品質分工
  d.push('### 品質 Agents 分工');
  d.push('');
  d.push('| Agent | 負責層 | 做什麼 | 不做什麼 |');
  d.push('|-------|--------|--------|---------|');
  d.push('| tester | 測試碼 | 撰寫 unit/integration 測試 | 不啟動 app |');
  d.push('| e2e-runner | 跨步驟 | 複合流程、資料一致性 | 不重複 QA |');
  d.push('| qa | API/CLI | 啟動 app、呼叫 API | 不寫測試碼 |');

  // ━━━ §4 Flow 模組 ━━━
  d.push(hr);
  d.push('## 4. Flow 模組 — 開發工作流');
  d.push('');
  d.push('### 核心理念');
  d.push('');
  d.push('先想清楚再寫碼，Pipeline 引導每一步。');
  d.push('');
  d.push('### Skills 設計');
  d.push('');
  d.push('#### scope — 功能規劃');
  d.push('');
  d.push('推斷技術棧 → planner agent 分析 → 展示分階段計畫 → 確認範圍 → 執行。');
  d.push('產出：摘要 + 階段分解 + 風險摘要 + 依賴圖。');
  d.push('');
  d.push('#### architect — 架構設計');
  d.push('');
  d.push('掃描結構 → architect agent 分析 → 展示多方案（目錄樹 + 介面 + 資料流）→ 使用者選擇。');
  d.push('');
  d.push('#### context-status — Context 狀態查詢');
  d.push('');
  d.push('50 calls 閾值，每 25 calls 提醒，在邏輯邊界建議（不阻擋）。');
  d.push('');
  d.push('#### checkpoint — 工作檢查點');
  d.push('');
  d.push(`建立（${c('git stash create')} / ${c('git commit')} + metadata）→ 列出 → 恢復（預覽 → 確認 → apply）。`);
  d.push('');
  d.push('#### env-detect — 環境偵測');
  d.push('');
  d.push('偵測順序（PM）：env var → 專案設定 → package.json → lock file → 全域設定 → fallback。');
  d.push('');
  d.push('#### cancel — 取消鎖定 + 退出 pipeline');
  d.push('');
  d.push(`處理兩種鎖定：(1) task-guard：設定 ${c('cancelled: true')} → 放行結束；(2) pipeline：重設 ${c('pipelineEnforced=false')} + ${c('delegationActive=false')} → 允許直接 Write/Edit。`);
  d.push('');
  d.push('### Agents 設計');
  d.push('');
  d.push('**planner**（opus, plan, purple）— 理解需求 → 掃描專案 → 識別影響 → 拆解階段 → 評估風險 → 產出計畫。');
  d.push('');
  d.push('**architect**（opus, plan, cyan）— 掃描結構 → 分析慣例 → 識別邊界 → 設計 2-3 方案 → 產出目錄樹+介面+資料流。');
  d.push('');
  d.push('**developer**（sonnet, acceptEdits, yellow）— 載入 PATTERNS → 按階段實作 → 寫測試 → 自動 hooks 介入。遵循 architect 方案，不自行發明架構。');
  d.push('');
  d.push('### Hooks 設計');
  d.push('');
  d.push('#### task-classifier（UserPromptSubmit）');
  d.push('');
  d.push(`**漸進式升級**：keyword heuristic 分類（7 類型），初始為 ${c('additionalContext')}（軟），升級為 ${c('systemMessage')}（強）。`);
  d.push('');
  d.push('**分類順序**（先匹配先贏）：research → **trivial** → tdd → test → refactor → feature → quickfix → bugfix → default quickfix。');
  d.push('');
  d.push('#### pipeline-init（SessionStart）');
  d.push('');
  d.push(`偵測環境 + 初始化 state file。防重複：state file 已存在 ${c('initialized: true')} 時 exit 0。`);
  d.push('');
  d.push('#### delegation-tracker（PreToolUse:Task）');
  d.push('');
  d.push(`Task 呼叫時標記 ${c('delegationActive=true')}，讓 sub-agent 通過 pipeline-guard。`);
  d.push('');
  d.push('#### pipeline-guard（PreToolUse:Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode）');
  d.push('');
  d.push(`統一防護層：`);
  d.push(`- Write|Edit：阻擋 Main Agent 直寫碼（${c('delegationActive=true')} 時放行）`);
  d.push(`- AskUserQuestion：轉發給 remote-ask-intercept（Telegram 互動選單）`);
  d.push(`- EnterPlanMode：阻擋內建 Plan Mode，強制使用 ${c('/vibe:scope')}）`);
  d.push(`雙層防禦：${c('systemMessage')} ⛔ + ${c('exit 2')} 硬阻擋。`);
  d.push('');
  d.push('#### suggest-compact（PreToolUse:*）');
  d.push('');
  d.push(`追蹤所有 tool calls，50 次 → 建議 compact，每 25 次提醒。透過 ${c('systemMessage')} 注入建議。`);
  d.push('');
  d.push('#### stage-transition（SubagentStop）');
  d.push('');
  d.push('Agent 完成後判斷下一步：');
  d.push('');
  d.push(`1. ${c('stop_hook_active === true')} → exit 0（防迴圈）`);
  d.push(`2. ${c('discoverPipeline()')} 載入配置`);
  d.push(`3. ${c('agentToStage[agent_type]')} 查找所屬 stage`);
  d.push(`4. ${c('parseVerdict()')} 從 transcript 解析 PIPELINE_VERDICT`);
  d.push(`5. ${c('shouldRetryStage()')} 判斷是否回退`);
  d.push('6. 更新 state file + systemMessage 指示下一步');
  d.push('');
  d.push('**智慧回退**：FAIL:CRITICAL 或 FAIL:HIGH → 回到 DEV 修復 → 重試（每階段獨立 3 輪上限）。');
  d.push('');
  d.push('**智慧跳過**：純 API 框架自動跳過 E2E 瀏覽器測試。');
  d.push('');
  d.push('#### pipeline-check（Stop）');
  d.push('');
  d.push('結束前檢查遺漏階段，透過 systemMessage 提醒。');
  d.push('');
  d.push('#### task-guard（Stop）');
  d.push('');
  d.push(`讀取 transcript 中 TaskCreate/TaskUpdate 工具呼叫，重建任務狀態，檢查未完成任務。${c('decision: "block"')} 阻止退出。完成承諾機制：Claude 可輸出 ${c('<promise>ALL_TASKS_COMPLETE</promise>')} 繞過檢查。安全閥：5 次阻擋後強制放行。${c('/vibe:cancel')} 可手動解除。`);

  // ━━━ §5 Sentinel 模組 ━━━
  d.push(hr);
  d.push('## 5. Sentinel 模組 — 品質全鏈');
  d.push('');
  d.push('### 核心理念');
  d.push('');
  d.push('寫完就檢查，測完就確認，問題不過夜。');
  d.push('');
  d.push('### Skills 設計');
  d.push('');
  d.push('#### review — 程式碼審查');
  d.push('');
  d.push('CRITICAL → HIGH → MEDIUM → LOW 按嚴重程度排序。涵蓋安全、邏輯、效能、命名。');
  d.push('');
  d.push('#### lint / format — 靜態分析與格式化');
  d.push('');
  d.push('| 語言 | Linter | Formatter |');
  d.push('|------|--------|-----------|');
  d.push('| TypeScript/JavaScript | ESLint | Prettier |');
  d.push('| Python | Ruff | Ruff format |');
  d.push('| Go | golangci-lint | gofmt/goimports |');
  d.push('| CSS/SCSS | Stylelint | Prettier |');
  d.push('');
  d.push('#### security — 安全掃描');
  d.push('');
  d.push('OWASP Top 10：注入、認證、資料曝露、設定、依賴 CVE。');
  d.push('');
  d.push('#### tdd — TDD 工作流');
  d.push('');
  d.push('RED（寫失敗的測試 → 必須 FAIL）→ GREEN（最小實作 → 必須 PASS）→ REFACTOR（改善 → 仍 PASS）。');
  d.push('');
  d.push('#### e2e — E2E 測試');
  d.push('');
  d.push(`工具：[agent-browser](https://github.com/vercel-labs/agent-browser)（Playwright 上的 AI 友善 CLI）。`);
  d.push(`工作流：${c('open')} → ${c('snapshot -i')} → 操作（ref） → ${c('snapshot')} 驗證 → ${c('close')}。`);
  d.push('');
  d.push('#### qa — 行為測試');
  d.push('');
  d.push('啟動 app → 健康檢查 → API/CLI 操作 → 驗證結果。不寫測試碼，不做瀏覽器 UI 測試。');
  d.push('');
  d.push('#### coverage — 覆蓋率分析');
  d.push('');
  d.push('整體 80%、關鍵路徑 100%、工具函式 90%、UI 元件 60%。');
  d.push('');
  d.push('#### verify — 綜合驗證');
  d.push('');
  d.push('Build → Types → Lint → Tests → console.log → Git。任一步驟失敗即停止。');
  d.push('');
  d.push('### Hooks 設計');
  d.push('');
  d.push('#### auto-lint（PostToolUse:Write|Edit）');
  d.push('');
  d.push('偵測語言 → 選擇 linter → 執行 --fix → 結果透過 systemMessage 注入。強建議。');
  d.push('');
  d.push('#### auto-format（PostToolUse:Write|Edit）');
  d.push('');
  d.push('直接套用格式化，無需 Claude 決策。靜默執行。');
  d.push('');
  d.push('#### test-check（PostToolUse:Write|Edit）');
  d.push('');
  d.push('command hook，確定性副檔名/路徑判斷，修改程式碼後提醒跑測試。軟建議。');
  d.push('');
  d.push('#### danger-guard（PreToolUse:Bash）');
  d.push('');
  d.push('regex 匹配 8 個危險模式（rm -rf /、DROP TABLE 等），exit 2 硬阻擋。');
  d.push('');
  d.push('#### check-console-log（Stop）');
  d.push('');
  d.push(`git diff 偵測殘留 console.log/debugger，透過 systemMessage 提醒。`);
  d.push(`必須有 ${c('stop_hook_active')} 防無限迴圈。排除 ${c('scripts/hooks/')} 路徑和 ${c('hook-logger.js')}。`);

  // ━━━ §6 Patterns 模組 ━━━
  d.push(hr);
  d.push('## 6. Patterns 模組 — 知識庫');
  d.push('');
  d.push('### 核心理念');
  d.push('');
  d.push('Claude 知道的越多，寫出的程式碼越好。純知識庫，無 hooks/agents/scripts。');
  d.push('');
  d.push(`### ${modStats['Patterns'].skills} 個 Pattern Skills`);
  d.push('');
  d.push('每個 skill 遵循統一格式：');
  d.push('');
  d.push('```markdown');
  d.push('---');
  d.push('name: {skill-name}');
  d.push('description: {一句話}');
  d.push('---');
  d.push('## Quick Reference（速查表格）');
  d.push('## Patterns（❌ BAD / ✅ GOOD 對比）');
  d.push('## Checklist（審查清單）');
  d.push('## 常見陷阱');
  d.push('```');
  d.push('');
  d.push('| Skill | 涵蓋範圍 |');
  d.push('|-------|---------|');
  d.push('| coding-standards | 命名規範、檔案組織、錯誤處理、不可變性 |');
  d.push('| frontend-patterns | React Hooks、Next.js App Router、Vue Composition API、狀態管理 |');
  d.push('| backend-patterns | RESTful API、Middleware、JWT/OAuth、ORM、快取 |');
  d.push('| db-patterns | PostgreSQL 最佳化、索引策略、Migration、Redis、N+1 |');
  d.push('| typescript-patterns | Utility types、Generics、Type guards、Strict mode、Zod |');
  d.push('| python-patterns | typing、async/await、dataclass、FastAPI/Django |');
  d.push('| go-patterns | Error handling、Concurrency、Interface、Table-driven tests |');
  d.push('| testing-patterns | 測試金字塔（70/20/10）、Mocking、Fixtures、覆蓋率目標 |');

  // ━━━ §7 Evolve 模組 ━━━
  d.push(hr);
  d.push('## 7. Evolve 模組 — 知識進化');
  d.push('');
  d.push('### 核心理念');
  d.push('');
  d.push('觀察由 claude-mem 處理，進化由 evolve 處理。文件是程式碼的影子。');
  d.push('');
  d.push('### 與 claude-mem 的關係');
  d.push('');
  d.push('```');
  d.push('claude-mem（底層）             evolve（上層）');
  d.push('┌────────────────────┐      ┌────────────────────┐');
  d.push('│ PostToolUse: 觀察捕獲 │      │ evolve: 聚類 → skill │');
  d.push('│ Stop: session 摘要   │ ←讀─ │ doc-sync: 文件同步   │');
  d.push('│ SessionStart: 注入   │      │ doc-updater: 自動更新│');
  d.push('└────────────────────┘      └────────────────────┘');
  d.push('```');
  d.push('');
  d.push('**解耦**：evolve 不 import mem，無 mem 時從對話提取或手動輸入。');
  d.push('');
  d.push('### Instinct 進化路徑');
  d.push('');
  d.push('```');
  d.push('Observation → Instinct(0.3) → Cluster(≥3, avg≥0.7) → Skill/Agent');
  d.push('```');
  d.push('');
  d.push('| 分數 | 狀態 | 進化目標條件 |');
  d.push('|:----:|------|-------------|');
  d.push('| 0.3 | 初始 | — |');
  d.push('| 0.7 | 成熟 | Skill：≥5 instincts, avg ≥ 0.7 |');
  d.push('| 0.9 | 可進化 | Agent：≥8 instincts, avg ≥ 0.8 |');

  // ━━━ §8 Dashboard 模組 ━━━
  d.push(hr);
  d.push('## 8. Dashboard 模組 — 即時監控');
  d.push('');
  d.push('### 架構');
  d.push('');
  d.push(`Bun HTTP + WebSocket server，監聽 ${c('~/.claude/pipeline-state-*.json')} 變化即時推播。`);
  d.push('');
  d.push('| 元件 | 說明 |');
  d.push('|------|------|');
  d.push('| server.js | HTTP + WebSocket server |');
  d.push('| web/index.html | 前端（自包含 HTML） |');
  d.push('| server-manager.js | 共用 lib — start/stop/isRunning/getState |');
  d.push('');
  d.push('### 生命週期');
  d.push('');
  d.push(`- **PID**：${c('~/.claude/dashboard-server.pid')}（全域，跨 session 共享）`);
  d.push(`- **Port 偵測**：${c('net.createConnection')}（非 lsof）`);
  d.push('- **自動啟動**：SessionStart hook → dashboard-autostart.js → port 偵測 → spawn + detached');
  d.push(`- **自動開瀏覽器**：偵測 ${c('TERM_PROGRAM=vscode')} → VSCode Simple Browser；否則 macOS ${c('open')}`);
  d.push(`- **手動控管**：${c('/vibe:dashboard start|stop|status|open|restart')}`);
  d.push('- **優雅關閉**：SIGTERM → 關閉 WebSocket → 清理 PID → exit 0');

  // ━━━ §9 Remote 模組 ━━━
  d.push(hr);
  d.push('## 9. Remote 模組 — Telegram 遠端控制');
  d.push('');
  d.push('### 核心概念');
  d.push('');
  d.push('遊戲外掛模式 — 讀取狀態（pipeline state files）+ 注入輸入（tmux send-keys）。Claude Code 不知道有外掛存在。');
  d.push('');
  d.push('### 架構');
  d.push('');
  d.push('```');
  d.push('Claude Code (tmux)');
  d.push('    ↓ SubagentStop');
  d.push('remote-sender.js → 讀 state → Telegram ──→ 手機');
  d.push('                                             ↓ /status /say');
  d.push('bot.js daemon ← Telegram Bot API ←────── 手機');
  d.push('    ├── 查詢 → 讀 state files → 回覆');
  d.push('    └── 控制 → tmux send-keys → Claude Code');
  d.push('```');
  d.push('');
  d.push('### 五大功能軸');
  d.push('');
  d.push('| 功能 | Hook/機制 | 說明 |');
  d.push('|------|----------|------|');
  d.push('| 推播通知 | SubagentStop: remote-sender | Stage 完成 → Telegram |');
  d.push('| 對話同步 | UserPromptSubmit: remote-prompt-forward | 使用者輸入轉發 |');
  d.push('| 回合摘要 | Stop: remote-receipt | 文字回應 + 工具統計 |');
  d.push('| 互動選單 | PreToolUse: remote-ask-intercept | AskUserQuestion → inline keyboard |');
  d.push('| 遠端控制 | bot.js daemon | /say → tmux send-keys |');
  d.push('');
  d.push('### AskUserQuestion 互動');
  d.push('');
  d.push('| 模式 | Inline 按鈕 | 數字回覆 |');
  d.push('|------|------------|---------|');
  d.push(`| 單選 | 按 = 選 + 確認 | ${c('2')} → 選第 2 項 |`);
  d.push(`| 多選 | toggle ☑/☐ → 確認 | ${c('1 3')} toggle → ${c('ok')} |`);
  d.push('');
  d.push('### Daemon 生命週期');
  d.push('');
  d.push('| 面向 | 設計 |');
  d.push('|------|------|');
  d.push(`| PID | ${c('~/.claude/remote-bot.pid')}（全域） |`);
  d.push(`| 存活偵測 | ${c('process.kill(pid, 0)')} |`);
  d.push('| 啟動 | spawn detached + stdio ignore |');
  d.push('| 自動啟動 | SessionStart hook |');
  d.push('| 安全 | 只回應指定 chatId |');
  d.push('| 錯誤恢復 | polling 失敗 → 5s 重試 |');
  d.push('');
  d.push('### 認證');
  d.push('');
  d.push(`環境變數（${c('TELEGRAM_BOT_TOKEN')} + ${c('TELEGRAM_CHAT_ID')}）優先 → ${c('~/.claude/remote.env')} fallback。`);
  d.push('缺失時 exit 0 靜默降級。');

  // ━━━ §10 共用基礎設施 ━━━
  d.push(hr);
  d.push('## 10. 共用基礎設施');
  d.push('');
  d.push('### registry.js — Single Source of Truth');
  d.push('');
  d.push('```javascript');
  d.push('const STAGES = {');
  d.push("  PLAN:   { agent: 'planner',        emoji: '📋', label: '規劃',       color: 'purple' },");
  d.push("  ARCH:   { agent: 'architect',      emoji: '🏗️', label: '架構',       color: 'cyan' },");
  d.push("  DEV:    { agent: 'developer',      emoji: '💻', label: '開發',       color: 'yellow' },");
  d.push("  REVIEW: { agent: 'code-reviewer',  emoji: '🔍', label: '審查',       color: 'blue' },");
  d.push("  TEST:   { agent: 'tester',         emoji: '🧪', label: '測試',       color: 'pink' },");
  d.push("  QA:     { agent: 'qa',             emoji: '✅', label: '行為驗證',   color: 'yellow' },");
  d.push("  E2E:    { agent: 'e2e-runner',     emoji: '🌐', label: '端對端測試', color: 'green' },");
  d.push("  DOCS:   { agent: 'doc-updater',    emoji: '📝', label: '文件整理',   color: 'purple' },");
  d.push('};');
  d.push('```');
  d.push('');
  d.push(`匯出：${c('STAGES')}、${c('STAGE_ORDER')}、${c('AGENT_TO_STAGE')}、${c('NAMESPACED_AGENT_TO_STAGE')}、${c('TOOL_EMOJI')}。`);
  d.push('');
  d.push('### State Files');
  d.push('');
  d.push('| 檔案 | 用途 |');
  d.push('|------|------|');
  d.push(`| ${c('~/.claude/pipeline-state-{sessionId}.json')} | Pipeline 階段進度 |`);
  d.push(`| ${c('~/.claude/task-guard-state-{sessionId}.json')} | task-guard 阻擋狀態 |`);
  d.push(`| ${c('~/.claude/counter-{sessionId}.json')} | tool call 計數器 |`);
  d.push(`| ${c('~/.claude/dashboard-server.pid')} | Dashboard server PID（全域） |`);
  d.push(`| ${c('~/.claude/remote-bot.pid')} | Bot daemon PID（全域） |`);
  d.push(`| ${c('~/.claude/remote-say-pending.json')} | /say 已讀回條狀態 |`);
  d.push(`| ${c('~/.claude/remote-ask-pending.json')} | AskUserQuestion 互動狀態 |`);
  d.push(`| ${c('~/.claude/hook-errors.log')} | Hook 錯誤日誌（自動截斷 500 行） |`);
  d.push('');
  d.push('### pipeline.json');
  d.push('');
  d.push('```json');
  d.push(JSON.stringify(pipelineJson, null, 2));
  d.push('```');

  // ━━━ §11 目錄結構 ━━━
  d.push(hr);
  d.push('## 11. 目錄結構');
  d.push('');
  d.push('```');
  d.push('plugins/vibe/');
  d.push('├── .claude-plugin/');
  d.push(`│   └── plugin.json               # name: "vibe", ${totalSkills} skills, ${totalAgents} agents`);
  d.push('├── hooks/');
  d.push(`│   └── hooks.json                # 統一 ${totalHooks} hooks`);
  d.push('├── pipeline.json                 # Stage 順序 + provides');
  d.push(`├── skills/                       # ${totalSkills} 個 skill 目錄`);
  // 動態生成 skill 目錄列表
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const prefix = i < skills.length - 1 ? '├──' : '└──';
    const padding = ' '.repeat(Math.max(1, 24 - s.name.length));
    d.push(`│   ${prefix} ${s.name}/${padding}# ${s.module}`);
  }
  d.push(`├── agents/                       # ${totalAgents} 個 agent 定義`);
  for (let i = 0; i < agentOrder.length; i++) {
    const prefix = i < agentOrder.length - 1 ? '├──' : '└──';
    d.push(`│   ${prefix} ${agentOrder[i]}.md`);
  }
  d.push('├── scripts/');
  d.push(`│   ├── hooks/                    # ${totalHookScripts} 個 hook 腳本`);
  d.push('│   └── lib/                      # 共用函式庫');
  d.push('│       ├── registry.js           # 全域 metadata');
  d.push('│       ├── hook-logger.js        # Hook 錯誤日誌');
  d.push('│       ├── flow/                 # env-detector, counter, pipeline-discovery');
  d.push('│       ├── sentinel/             # lang-map, tool-detector');
  d.push('│       ├── dashboard/            # server-manager');
  d.push('│       └── remote/               # telegram, transcript, bot-manager');
  d.push('├── server.js                     # Dashboard HTTP+WS server');
  d.push('├── web/');
  d.push('│   └── index.html                # Dashboard 前端');
  d.push('└── bot.js                        # Telegram daemon');
  d.push('```');

  // ━━━ §12 plugin.json ━━━
  d.push(hr);
  d.push('## 12. plugin.json');
  d.push('');
  d.push('```json');
  d.push(pluginJsonStr);
  d.push('```');
  d.push('');

  return d.join('\n');
}

module.exports = { generateVibeDoc };
