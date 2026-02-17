#!/usr/bin/env node
/**
 * pipeline-init.js — SessionStart hook
 *
 * v3.0.0：環境偵測 + v3 state 初始化。
 * 使用 dag-state.js 的 createInitialState()。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const { detect } = require(path.join(__dirname, '..', 'lib', 'flow', 'env-detector.js'));
const { reset: resetCounter } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ds = require(path.join(__dirname, '..', 'lib', 'flow', 'dag-state.js'));

safeRun('pipeline-init', (data) => {
  const sessionId = data.session_id || 'unknown';
  const cwd = data.cwd || process.cwd();

  // 防重複（clear / FORCE_RESET 時重設）
  const triggerSource = data.source || '';
  const existing = ds.readState(sessionId);
  if (existing && existing.meta?.initialized) {
    if (triggerSource === 'clear' || process.env.VIBE_FORCE_RESET === '1') {
      ds.deleteState(sessionId);
    } else {
      process.exit(0);
    }
  }

  // 環境偵測
  const env = detect(cwd);

  // Pipeline 動態發現（建立委派規則）
  const pipeline = discoverPipeline();
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

  // 重設計數器
  resetCounter(sessionId);

  // 偵測 OpenSpec
  const openspecDir = path.join(cwd, 'openspec');
  const openspecEnabled = fs.existsSync(openspecDir)
    && fs.existsSync(path.join(openspecDir, 'config.yaml'));

  // 建立 v3 初始 state
  const state = ds.createInitialState(sessionId, {
    environment: env,
    openspecEnabled,
    pipelineRules,
  });
  ds.writeState(sessionId, state);

  // Timeline
  emit(EVENT_TYPES.SESSION_START, sessionId, {
    cwd,
    reason: triggerSource || 'startup',
    environment: {
      language: env.languages.primary,
      framework: env.framework?.name,
      packageManager: env.packageManager?.name,
      tools: { test: env.tools.test, linter: env.tools.linter },
    },
  });

  // 環境摘要
  if (env.languages.primary) {
    const parts = [`語言: ${env.languages.primary}`];
    if (env.framework) parts.push(`框架: ${env.framework.name}`);
    if (env.packageManager) parts.push(`PM: ${env.packageManager.name}`);
    if (env.tools.test) parts.push(`測試: ${env.tools.test}`);
    if (env.tools.linter) parts.push(`Linter: ${env.tools.linter}`);
    console.log(JSON.stringify({ additionalContext: `[環境] ${parts.join(' · ')}` }));
  }
});
