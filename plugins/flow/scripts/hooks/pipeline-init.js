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

    // 建立委派規則文字
    const rules = [];
    for (const stage of pipeline.stageOrder) {
      const info = pipeline.stageMap[stage];
      if (!info) continue;
      const label = pipeline.stageLabels[stage] || stage;
      const skillHint = info.skill ? `（${info.skill}）` : '';
      rules.push(`- ${label}：${info.agent}${skillHint}`);
    }

    // 組裝 additionalContext
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
      parts.push('[Pipeline 委派規則]');
      parts.push('程式碼變更應透過對應的 sub-agent 執行，而非 Main Agent 直接處理：');
      parts.push(...rules);
      parts.push('task-classifier 會建議需要的階段，請依建議執行。');
      parts.push('未安裝的 plugin 對應的階段可以跳過。');
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

    // 輸出
    if (parts.length > 0) {
      console.log(JSON.stringify({ additionalContext: parts.join('\n') }));
    }
  } catch (err) {
    // 靜默失敗，不阻擋 session 啟動
    process.stderr.write(`pipeline-init: ${err.message}\n`);
  }
});
