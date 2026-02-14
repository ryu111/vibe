#!/usr/bin/env node
/**
 * pipeline-init.js — SessionStart hook
 *
 * 環境偵測 + state file 初始化（不注入 pipeline 規則）。
 * Pipeline 規則由 task-classifier 根據任務類型決定是否注入。
 * 防重複：透過 state file 的 initialized 欄位。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const { detect } = require(path.join(__dirname, '..', 'lib', 'flow', 'env-detector.js'));
const { reset: resetCounter } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

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

    // Pipeline 動態發現（儲存到 state，供 task-classifier 使用）
    const pipeline = discoverPipeline();
    const installedStages = pipeline.stageOrder.filter(s => pipeline.stageMap[s]);

    // 建立委派規則（儲存到 state，供 task-classifier 注入）
    const pipelineRules = [];
    for (const stage of pipeline.stageOrder) {
      const info = pipeline.stageMap[stage];
      if (!info) continue;
      const label = pipeline.stageLabels[stage] || stage;
      if (info.skill) {
        pipelineRules.push(`- ${stage}（${label}）→ 使用 Skill 工具呼叫 ${info.skill}`);
      } else {
        pipelineRules.push(`- ${stage}（${label}）→ 使用 Task 工具委派給 ${info.agent} agent`);
      }
    }

    // 重設 tool call 計數器
    resetCounter(sessionId);

    // 偵測 OpenSpec 目錄
    const openspecDir = path.join(cwd, 'openspec');
    const openspecEnabled = fs.existsSync(openspecDir)
      && fs.existsSync(path.join(openspecDir, 'config.yaml'));

    // 寫入 state file（不含 taskType — 由 task-classifier 設定）
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId,
      initialized: true,
      completed: [],
      expectedStages: installedStages,
      pipelineRules,
      environment: env,
      openspecEnabled,
      lastTransition: new Date().toISOString(),
    }, null, 2));

    // Emit timeline event
    emit(EVENT_TYPES.SESSION_START, sessionId, {
      cwd,
      environment: {
        language: env.languages.primary,
        framework: env.framework?.name,
        packageManager: env.packageManager?.name,
        tools: {
          test: env.tools.test,
          linter: env.tools.linter,
        },
      },
    });

    // 輸出環境摘要（additionalContext = 資訊提示，不觸發 "hook error" 標籤）
    if (env.languages.primary) {
      const envParts = [`語言: ${env.languages.primary}`];
      if (env.framework) envParts.push(`框架: ${env.framework.name}`);
      if (env.packageManager) envParts.push(`PM: ${env.packageManager.name}`);
      if (env.tools.test) envParts.push(`測試: ${env.tools.test}`);
      if (env.tools.linter) envParts.push(`Linter: ${env.tools.linter}`);
      console.log(JSON.stringify({ additionalContext: `[環境] ${envParts.join(' · ')}` }));
    }
  } catch (err) {
    hookLogger.error('pipeline-init', err);
  }
});
