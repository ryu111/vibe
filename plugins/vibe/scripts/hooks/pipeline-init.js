#!/usr/bin/env node
/**
 * pipeline-init.js — SessionStart hook
 *
 * 環境偵測 + state file 初始化。
 * v2.0.0：使用 state-machine.js 的 createInitialState() 建立 FSM 結構。
 */
'use strict';
const path = require('path');

const { discoverPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const { detect } = require(path.join(__dirname, '..', 'lib', 'flow', 'env-detector.js'));
const { reset: resetCounter } = require(path.join(__dirname, '..', 'lib', 'flow', 'counter.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { createInitialState, readState, writeState, deleteState } = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));

const fs = require('fs');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const cwd = data.cwd || process.cwd();

    // 防重複：已初始化過則跳過（clear 事件或 FORCE_RESET 時重設）
    const triggerSource = data.source || '';
    const existing = readState(sessionId);
    if (existing && existing.meta && existing.meta.initialized) {
      if (triggerSource === 'clear' || process.env.VIBE_FORCE_RESET === '1') {
        deleteState(sessionId);
      } else {
        process.exit(0);
      }
    }

    // 環境偵測
    const env = detect(cwd);

    // Pipeline 動態發現
    const pipeline = discoverPipeline();

    // 建立委派規則
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

    // 建立初始 state（FSM phase: IDLE）
    const state = createInitialState(sessionId, {
      environment: env,
      openspecEnabled,
      pipelineRules,
    });

    writeState(sessionId, state);

    // Emit timeline event
    emit(EVENT_TYPES.SESSION_START, sessionId, {
      cwd,
      reason: triggerSource || 'startup',
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

    // 輸出環境摘要
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
