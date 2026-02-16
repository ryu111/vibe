#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * v1.0.43 重構：
 * - 移除散落的 KNOWLEDGE_SKILLS / PIPELINE_TO_TASKTYPE / PIPELINE_LABELS（統一從 registry 讀取）
 * - 簡化 LLM fallback 路徑
 * - 分類時一次決定所有 pipeline 參數（不靠 stage-transition 補救）
 *
 * 行為：
 * - 初始分類：設定 pipelineId/expectedStages/pipelineEnforced/taskType
 * - 重新分類：升級→合併階段 / 同級或降級→靜默忽略
 * - Pipeline 完成後→自動重設，準備接收新任務
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

function isPipelineComplete(state) {
  if (!state.expectedStages || state.expectedStages.length === 0) return true;
  return state.expectedStages.every(st => state.stageResults?.[st]?.verdict === 'PASS');
}

function resetPipelineState(state) {
  delete state.pipelineId;
  delete state.taskType;
  delete state.reclassifications;
  delete state.llmClassification;
  delete state.correctionCount;
  state.completed = [];
  state.stageResults = {};
  state.retries = {};
  state.skippedStages = [];
  state.expectedStages = [];
  state.stageIndex = 0;
  state.currentStage = null;
  state.delegationActive = false;
  state.pipelineEnforced = false;
  state.pendingRetry = false;
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

  if (stages.length === 0) {
    const knowledgeHints = buildKnowledgeHints(state && state.environment);
    const context = `[任務分類] Pipeline: ${label} — 無需 pipeline，直接回答。` +
      (knowledgeHints ? `\n${knowledgeHints}` : '') + catalogHint;
    console.log(JSON.stringify({ additionalContext: context }));
    return;
  }

  const knowledgeHints = buildKnowledgeHints(state && state.environment);

  if (pipelineEnforced) {
    const pipelineRules = (state && state.pipelineRules) || [];
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
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    emit(EVENT_TYPES.PROMPT_RECEIVED, sessionId, {});

    // ── 三層級聯分類 ──
    const result = classifyWithConfidence(prompt);

    // Layer 3: LLM Fallback
    let catalogHint = '';
    if (result.source === 'pending-llm') {
      const stateForCache = fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;

      if (stateForCache && stateForCache.llmClassification) {
        result.pipeline = stateForCache.llmClassification.pipeline;
        result.confidence = stateForCache.llmClassification.confidence;
        result.source = 'llm-cached';
      } else {
        const llmResult = await classifyWithLLM(prompt);
        if (llmResult) {
          result.pipeline = llmResult.pipeline;
          result.confidence = llmResult.confidence;
          result.source = llmResult.source;
          if (stateForCache) {
            stateForCache.llmClassification = llmResult;
            fs.writeFileSync(statePath, JSON.stringify(stateForCache, null, 2));
          }
        } else {
          result.source = 'regex-low';
          catalogHint = buildPipelineCatalogHint();
        }
      }
    }

    const newPipelineId = result.pipeline;
    const newStages = PIPELINES[newPipelineId]?.stages || [];
    const newPipelineEnforced = PIPELINES[newPipelineId]?.enforced || false;
    const newTaskType = PIPELINE_TO_TASKTYPE[newPipelineId] || 'quickfix';

    // 讀取現有 state
    let state = null;
    if (fs.existsSync(statePath)) {
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
    }

    // 已完成 pipeline → 重設
    if (state && state.pipelineId && isPipelineComplete(state)) {
      resetPipelineState(state);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    // ── 初始分類 ──
    if (!state || !state.pipelineId) {
      if (state) {
        state.pipelineId = newPipelineId;
        state.taskType = newTaskType;
        state.expectedStages = newStages;
        state.pipelineEnforced = newPipelineEnforced;
        state.classificationConfidence = result.confidence;
        state.classificationSource = result.source;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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
    const oldPipelineId = state.pipelineId;
    if (oldPipelineId === newPipelineId) return; // 同級
    if (!isUpgrade(oldPipelineId, newPipelineId)) return; // 降級

    // 升級
    const completedStages = getCompletedStages(state.completed);
    const remainingStages = newStages.filter(s => !completedStages.has(s));
    const skippedStages = newStages.filter(s => completedStages.has(s));

    if (!state.reclassifications) state.reclassifications = [];
    state.reclassifications.push({
      from: oldPipelineId, to: newPipelineId,
      at: new Date().toISOString(), skippedStages,
    });

    state.pipelineId = newPipelineId;
    state.taskType = newTaskType;
    state.expectedStages = newStages;
    state.pipelineEnforced = newPipelineEnforced;
    state.classificationConfidence = result.confidence;
    state.classificationSource = result.source;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
      pipelineId: newPipelineId, taskType: newTaskType,
      expectedStages: newStages, reclassified: true, from: oldPipelineId,
      layer: determineLayer(result), confidence: result.confidence,
      source: result.source, matchedRule: result.matchedRule,
    });

    outputUpgrade(oldPipelineId, newPipelineId, remainingStages, skippedStages);
  } catch (err) {
    hookLogger.error('task-classifier', err);
  }
  })();
});
