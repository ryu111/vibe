#!/usr/bin/env node
/**
 * pipeline-init.js — SessionStart hook
 *
 * 環境偵測 + pipeline 委派規則注入。
 * 防重複：透過 state file 的 initialized 欄位。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'pipeline-discovery.js'));
const { detect } = require(path.join(__dirname, '..', 'lib', 'env-detector.js'));
const { reset: resetCounter } = require(path.join(__dirname, '..', 'lib', 'counter.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const cwd = data.cwd || process.cwd();
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    // 防重複：已初始化過則跳過
    if (fs.existsSync(statePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (existing.initialized) {
          process.exit(0);
        }
      } catch (_) {}
    }

    // 環境偵測
    const env = detect(cwd);

    // Pipeline 動態發現
    const pipeline = discoverPipeline();
    const installedStages = pipeline.stageOrder
      .filter(s => pipeline.stageMap[s])
      .map(s => `${s}（${pipeline.stageLabels[s] || s}）`);

    // 建立委派規則文字（包含具體執行方法）
    const rules = [];
    for (const stage of pipeline.stageOrder) {
      const info = pipeline.stageMap[stage];
      if (!info) continue;
      const label = pipeline.stageLabels[stage] || stage;
      if (info.skill) {
        rules.push(`- ${stage}（${label}）→ 使用 Skill 工具呼叫 ${info.skill}`);
      } else {
        rules.push(`- ${stage}（${label}）→ 使用 Task 工具委派給 ${info.agent} agent`);
      }
    }

    // 組裝 systemMessage（強注入 — 不可忽略）
    const parts = [];

    // 環境摘要
    if (env.languages.primary) {
      const envParts = [`語言: ${env.languages.primary}`];
      if (env.framework) envParts.push(`框架: ${env.framework.name}`);
      if (env.packageManager) envParts.push(`PM: ${env.packageManager.name}`);
      if (env.tools.test) envParts.push(`測試: ${env.tools.test}`);
      if (env.tools.linter) envParts.push(`Linter: ${env.tools.linter}`);
      parts.push(`[環境] ${envParts.join(' · ')}`);
    }

    // Pipeline 規則（強語言 — 模型必須遵守）
    if (rules.length > 0) {
      parts.push('⛔ PIPELINE 模式啟動 — 你是管理者（Orchestrator），不是執行者（Executor）');
      parts.push('');
      parts.push('█ 絕對禁止 █');
      parts.push('- 🚫 禁止直接使用 Write 工具寫任何程式碼檔案');
      parts.push('- 🚫 禁止直接使用 Edit 工具修改任何程式碼檔案');
      parts.push('- 🚫 禁止直接使用 Bash 工具執行 build、test、lint 等開發指令');
      parts.push('- 你的唯一職責：按順序使用 Task/Skill 工具委派各階段給 sub-agent');
      parts.push('- 違反此規則的 Write/Edit 操作會被 dev-gate hook 硬阻擋（exit 2）');
      parts.push('');
      parts.push('█ 委派順序 █');
      parts.push(...rules);
      parts.push('');
      parts.push('█ 執行規則 █');
      parts.push('1. task-classifier hook 會分類任務類型和必要階段 — 收到後立即從第一個階段開始委派');
      parts.push('2. 每個階段完成後，stage-transition hook 會指示下一步 — 你**必須**照做');
      parts.push('3. 不可跳過已安裝的階段（REVIEW、TEST、QA 階段**不可省略**）');
      parts.push('4. 未安裝的 plugin 對應的階段會自動跳過');
      parts.push('5. Pipeline 執行中**禁止使用 AskUserQuestion** — 各階段自動完成，不中斷使用者');
      parts.push('');
      parts.push('█ 正確做法範例 █');
      parts.push('✅ Task({ subagent_type: "flow:planner", prompt: "..." })');
      parts.push('✅ Task({ subagent_type: "flow:architect", prompt: "..." })');
      parts.push('✅ Task({ subagent_type: "flow:developer", prompt: "..." })');
      parts.push('❌ Write({ file_path: "src/app.ts", content: "..." }) ← 這會被 dev-gate 阻擋');
      parts.push('');
      parts.push(`已安裝階段：${installedStages.join(' → ')}`);
    }

    // 重設 tool call 計數器
    resetCounter(sessionId);

    // 寫入 state file
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId,
      initialized: true,
      completed: [],
      expectedStages: pipeline.stageOrder.filter(s => pipeline.stageMap[s]),
      environment: env,
      lastTransition: new Date().toISOString(),
    }, null, 2));

    // 輸出（systemMessage = 強注入，主 agent 不可忽略）
    if (parts.length > 0) {
      console.log(JSON.stringify({ systemMessage: parts.join('\n') }));
    }
  } catch (err) {
    // 靜默失敗，不阻擋 session 啟動
    process.stderr.write(`pipeline-init: ${err.message}\n`);
  }
});
