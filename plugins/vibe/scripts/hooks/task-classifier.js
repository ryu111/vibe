#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * v2.0.0 FSM 重構：
 * - 使用 transition() 取代直接欄位操作
 * - CLASSIFY/RESET/RECLASSIFY 三種 action
 * - 移除 resetPipelineState()、isPipelineComplete()（由 state-machine 提供）
 *
 * 行為：
 * - 初始分類：transition(CLASSIFY) → CLASSIFIED 或 IDLE
 * - 重新分類（升級）：transition(RECLASSIFY)
 * - Pipeline 完成後：transition(RESET) + transition(CLASSIFY)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const {
  NAMESPACED_AGENT_TO_STAGE,
  PIPELINES, PIPELINE_PRIORITY, PIPELINE_TO_TASKTYPE,
  KNOWLEDGE_SKILLS, FRONTEND_FRAMEWORKS,
} = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const {
  classifyWithConfidence, classifyWithLLM, buildPipelineCatalogHint,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'classifier.js'));
const {
  transition, readState, writeState, isComplete, getPhase, getPipelineId, PHASES,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));

// ────────────────── 工具函式 ──────────────────

/** 根據 env-detect 結果產生知識 skill 提示 */
function buildKnowledgeHints(envInfo) {
  if (!envInfo) return '';
  const skills = new Set();

  const primary = envInfo.languages && envInfo.languages.primary;
  if (primary && KNOWLEDGE_SKILLS.languages[primary]) {
    skills.add(KNOWLEDGE_SKILLS.languages[primary]);
  }
  for (const lang of ((envInfo.languages && envInfo.languages.secondary) || [])) {
    if (KNOWLEDGE_SKILLS.languages[lang]) skills.add(KNOWLEDGE_SKILLS.languages[lang]);
  }

  const framework = envInfo.framework && envInfo.framework.name;
  if (framework && KNOWLEDGE_SKILLS.frameworks[framework]) {
    skills.add(KNOWLEDGE_SKILLS.frameworks[framework]);
  }

  if (primary) {
    skills.add('/vibe:coding-standards');
    skills.add('/vibe:testing-patterns');
  }

  if (framework && FRONTEND_FRAMEWORKS.includes(framework)) skills.add('/vibe:design');
  if (envInfo.tools && envInfo.tools.designSystem) skills.add('/vibe:design');

  if (skills.size === 0) return '';
  return `\n\n█ 可用知識庫 █\n以下知識 skills 與目前專案環境匹配，sub-agent 可在需要時參考：\n` +
    Array.from(skills).map(s => `- ${s}`).join('\n');
}

/** Layer 推導（1=explicit, 2=regex, 3=llm） */
function determineLayer(result) {
  switch (result.source) {
    case 'explicit': return 1;
    case 'regex': case 'regex-low': case 'pending-llm': return 2;
    case 'llm': case 'llm-cached': return 3;
    default: return 2;
  }
}

function isUpgrade(oldId, newId) {
  return (PIPELINE_PRIORITY[newId] || 0) > (PIPELINE_PRIORITY[oldId] || 0);
}

function getCompletedStages(completedAgents) {
  const stages = new Set();
  for (const agent of (completedAgents || [])) {
    const stage = NAMESPACED_AGENT_TO_STAGE[agent];
    if (stage) stages.add(stage);
  }
  return stages;
}

// ────────────────── Pipeline 委派規則 ──────────────────

function buildPipelineRules(pipelineId, stages, pipelineRules) {
  const stageStr = stages.join(' → ');
  const label = PIPELINES[pipelineId]?.label || pipelineId;
  const parts = [
    `⛔ PIPELINE 模式 — 你是管理者，不是執行者。`,
    `Pipeline: ${label}（${stageStr}）`,
    `禁止 Write/Edit/EnterPlanMode（pipeline-guard 硬阻擋）。使用 Task/Skill 委派 sub-agent。`,
  ];
  if (pipelineRules && pipelineRules.length > 0) parts.push(...pipelineRules);
  parts.push(`每階段完成後 stage-transition 指示下一步，照做即可。禁止 AskUserQuestion（PLAN 階段除外）。`);
  parts.push(`立即委派 ${stages[0]} 階段。`);
  return parts.join('\n');
}

// ────────────────── 輸出函式 ──────────────────

function outputInitialClassification(pipelineId, stages, state, options = {}) {
  const label = PIPELINES[pipelineId]?.label || pipelineId;
  const pipelineEnforced = PIPELINES[pipelineId]?.enforced || false;
  const catalogHint = options.catalogHint || '';
  const envInfo = state?.context?.environment || state?.environment || {};

  if (stages.length === 0) {
    const knowledgeHints = buildKnowledgeHints(envInfo);
    const context = `[任務分類] Pipeline: ${label} — 無需 pipeline，直接回答。` +
      (knowledgeHints ? `\n${knowledgeHints}` : '') + catalogHint;
    console.log(JSON.stringify({ additionalContext: context }));
    return;
  }

  const knowledgeHints = buildKnowledgeHints(envInfo);

  if (pipelineEnforced) {
    const pipelineRules = state?.context?.pipelineRules || state?.pipelineRules || [];
    console.log(JSON.stringify({
      systemMessage: buildPipelineRules(pipelineId, stages, pipelineRules) + knowledgeHints,
    }));
  } else {
    const stageStr = stages.join(' → ');
    console.log(JSON.stringify({
      additionalContext: `[任務分類] Pipeline: ${label}\n建議階段：${stageStr}${knowledgeHints}`,
    }));
  }
}

function outputUpgrade(oldPipelineId, newPipelineId, remainingStages, skippedStages) {
  const oldLabel = PIPELINES[oldPipelineId]?.label || oldPipelineId;
  const newLabel = PIPELINES[newPipelineId]?.label || newPipelineId;
  const pipelineEnforced = PIPELINES[newPipelineId]?.enforced || false;

  if (remainingStages.length === 0) {
    console.log(JSON.stringify({
      additionalContext: `[Pipeline 升級] ${oldLabel} → ${newLabel} — 所有階段已完成。`,
    }));
    return;
  }

  const stageStr = remainingStages.join(' → ');
  const skipNote = skippedStages.length > 0
    ? `\n⏭️ 已完成的階段自動跳過：${skippedStages.join('、')}` : '';

  if (pipelineEnforced) {
    console.log(JSON.stringify({
      systemMessage: `⛔ [Pipeline 升級] ${oldLabel} → ${newLabel}\n` +
        `切換管理者模式。禁止 Write/Edit（pipeline-guard 硬阻擋）。\n` +
        `剩餘階段：${stageStr}${skipNote}\n` +
        `立即委派 ${remainingStages[0]} 階段。`,
    }));
  } else {
    console.log(JSON.stringify({
      additionalContext: `[Pipeline 升級] ${oldLabel} → ${newLabel}\n建議階段：${stageStr}${skipNote}`,
    }));
  }
}

// ────────────────── 主邏輯 ──────────────────

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  (async () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || data.content || '';
    const sessionId = data.session_id || 'unknown';

    emit(EVENT_TYPES.PROMPT_RECEIVED, sessionId, {});

    // ── 三層級聯分類 ──
    const result = classifyWithConfidence(prompt);

    // Layer 3: LLM Fallback
    let catalogHint = '';
    if (result.source === 'pending-llm') {
      const stateForCache = readState(sessionId);

      const LLM_CACHE_TTL = 5 * 60 * 1000;
      const cached = stateForCache?.meta?.llmClassification;
      const cacheValid = cached && cached.timestamp && (Date.now() - cached.timestamp < LLM_CACHE_TTL);
      if (cacheValid) {
        result.pipeline = cached.pipeline;
        result.confidence = cached.confidence;
        result.source = 'llm-cached';
      } else {
        const llmResult = await classifyWithLLM(prompt);
        if (llmResult) {
          result.pipeline = llmResult.pipeline;
          result.confidence = llmResult.confidence;
          result.source = llmResult.source;
          // LLM 快取寫入 meta
          if (stateForCache) {
            stateForCache.meta = stateForCache.meta || {};
            stateForCache.meta.llmClassification = { ...llmResult, timestamp: Date.now() };
            writeState(sessionId, stateForCache);
          }
        } else {
          result.source = 'regex-low';
          catalogHint = buildPipelineCatalogHint();
        }
      }
    }

    const newPipelineId = result.pipeline;
    const newStages = PIPELINES[newPipelineId]?.stages || [];
    const newTaskType = PIPELINE_TO_TASKTYPE[newPipelineId] || 'quickfix';

    // 讀取現有 state
    let state = readState(sessionId);

    // 已完成 pipeline → RESET
    if (state && isComplete(state)) {
      state = transition(state, { type: 'RESET' });
      writeState(sessionId, state);
    }

    // ── 初始分類 ──
    const currentPipelineId = getPipelineId(state);
    if (!state || !currentPipelineId) {
      if (state) {
        state = transition(state, {
          type: 'CLASSIFY',
          pipelineId: newPipelineId,
          taskType: newTaskType,
          expectedStages: newStages,
          source: result.source,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          layer: determineLayer(result),
        });
        writeState(sessionId, state);
      }

      emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
        pipelineId: newPipelineId, taskType: newTaskType,
        expectedStages: newStages, reclassified: false,
        layer: determineLayer(result), confidence: result.confidence,
        source: result.source, matchedRule: result.matchedRule,
      });

      outputInitialClassification(newPipelineId, newStages, state, { catalogHint });
      return;
    }

    // ── 重新分類 ──
    const oldPipelineId = currentPipelineId;
    if (oldPipelineId === newPipelineId) return;

    if (!isUpgrade(oldPipelineId, newPipelineId)) {
      // 降級：如果舊 pipeline 過時（超過 10 分鐘無 stage transition），重設
      const lastTransition = state.meta?.lastTransition
        ? new Date(state.meta.lastTransition).getTime() : 0;
      const STALE_MS = 10 * 60 * 1000;
      const isStale = (Date.now() - lastTransition) > STALE_MS;

      if (isStale && !isComplete(state)) {
        state = transition(state, { type: 'RESET' });
        state = transition(state, {
          type: 'CLASSIFY',
          pipelineId: newPipelineId,
          taskType: newTaskType,
          expectedStages: newStages,
          source: result.source,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          layer: determineLayer(result),
        });
        writeState(sessionId, state);

        emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
          pipelineId: newPipelineId, taskType: newTaskType,
          expectedStages: newStages, reclassified: true, from: oldPipelineId,
          staleReset: true,
          layer: determineLayer(result), confidence: result.confidence,
          source: result.source, matchedRule: result.matchedRule,
        });

        outputInitialClassification(newPipelineId, newStages, state, { catalogHint });
        return;
      }
      return;
    }

    // 升級
    const completedStages = getCompletedStages(state.progress?.completedAgents || state.completed);
    const remainingStages = newStages.filter(s => !completedStages.has(s));
    const skippedByUpgrade = newStages.filter(s => completedStages.has(s));

    state = transition(state, {
      type: 'RECLASSIFY',
      oldPipelineId,
      newPipelineId,
      newTaskType,
      newExpectedStages: newStages,
      remainingStages,
      skippedByUpgrade,
      source: result.source,
      confidence: result.confidence,
      matchedRule: result.matchedRule,
      layer: determineLayer(result),
    });
    writeState(sessionId, state);

    emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
      pipelineId: newPipelineId, taskType: newTaskType,
      expectedStages: newStages, reclassified: true, from: oldPipelineId,
      layer: determineLayer(result), confidence: result.confidence,
      source: result.source, matchedRule: result.matchedRule,
    });

    outputUpgrade(oldPipelineId, newPipelineId, remainingStages, skippedByUpgrade);
  } catch (err) {
    hookLogger.error('task-classifier', err);
  }
  })();
});
