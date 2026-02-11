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

    // Pipeline 規則
    if (rules.length > 0) {
      parts.push('[Pipeline 委派規則 — 必須遵守]');
      parts.push('⚠️ 開發任務**必須**按照以下順序委派給對應的 sub-agent，不可由 Main Agent 直接執行：');
      parts.push(...rules);
      parts.push('');
      parts.push('📌 重要規則：');
      parts.push('1. task-classifier hook 會分類任務類型和必要階段 — 收到後按指示執行');
      parts.push('2. 每個階段完成後，stage-transition hook 會指示下一步 — 你**必須**照做');
      parts.push('3. 不可跳過已安裝的階段（REVIEW、TEST、QA 階段**不可省略**）');
      parts.push('4. 未安裝的 plugin 對應的階段會自動跳過');
      parts.push('5. Pipeline 執行中**禁止使用 AskUserQuestion** — 各階段自動完成，不中斷使用者');
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
