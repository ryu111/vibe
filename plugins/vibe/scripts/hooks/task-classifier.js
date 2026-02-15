#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * 分析使用者 prompt，分類任務類型，更新 pipeline state 的 expectedStages。
 * 首次分類為開發型任務時注入完整 pipeline 委派規則（systemMessage）。
 * 支援中途重新分類（漸進式升級）：
 *   - 升級（research → feature）：合併階段，注入委派規則
 *   - 降級（feature → research）：阻擋，保持現有 pipeline 不中斷
 *   - 同級：不重複注入
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const {
  NAMESPACED_AGENT_TO_STAGE,
  PIPELINES,
  PIPELINE_PRIORITY,
  TASKTYPE_TO_PIPELINE,
} = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

// 分類邏輯提取至 scripts/lib/flow/classifier.js（三層級聯分類器）
const {
  classifyWithConfidence,
  classifyWithLLM,
  buildPipelineCatalogHint,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'classifier.js'));

// 語言/框架 → 知識 skill 映射
const KNOWLEDGE_SKILLS = {
  languages: {
    typescript: '/vibe:typescript-patterns',
    python: '/vibe:python-patterns',
    go: '/vibe:go-patterns',
  },
  frameworks: {
    'next.js': '/vibe:frontend-patterns',
    nuxt: '/vibe:frontend-patterns',
    remix: '/vibe:frontend-patterns',
    astro: '/vibe:frontend-patterns',
    svelte: '/vibe:frontend-patterns',
    vue: '/vibe:frontend-patterns',
    react: '/vibe:frontend-patterns',
    angular: '/vibe:frontend-patterns',
    express: '/vibe:backend-patterns',
    fastify: '/vibe:backend-patterns',
    hono: '/vibe:backend-patterns',
  },
};

/**
 * 根據 env-detect 結果產生知識 skill 提示
 * @param {Object} envInfo - state.environment
 * @returns {string} 知識提示文字（空字串表示無提示）
 */
function buildKnowledgeHints(envInfo) {
  if (!envInfo) return '';
  const skills = new Set();

  // 語言映射
  const primary = envInfo.languages && envInfo.languages.primary;
  if (primary && KNOWLEDGE_SKILLS.languages[primary]) {
    skills.add(KNOWLEDGE_SKILLS.languages[primary]);
  }
  const secondary = (envInfo.languages && envInfo.languages.secondary) || [];
  for (const lang of secondary) {
    if (KNOWLEDGE_SKILLS.languages[lang]) {
      skills.add(KNOWLEDGE_SKILLS.languages[lang]);
    }
  }

  // 框架映射
  const framework = envInfo.framework && envInfo.framework.name;
  if (framework && KNOWLEDGE_SKILLS.frameworks[framework]) {
    skills.add(KNOWLEDGE_SKILLS.frameworks[framework]);
  }

  // 通用知識（有任何語言偵測時都加）
  if (primary) {
    skills.add('/vibe:coding-standards');
    skills.add('/vibe:testing-patterns');
  }

  // 前端框架偵測到時注入設計 skill 建議
  const { FRONTEND_FRAMEWORKS } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
  if (framework && FRONTEND_FRAMEWORKS.includes(framework)) {
    skills.add('/vibe:design');
  }

  // ui-ux-pro-max 已安裝時注入設計 skill
  const designSystem = envInfo.tools && envInfo.tools.designSystem;
  if (designSystem) {
    skills.add('/vibe:design');
  }

  if (skills.size === 0) return '';

  return `\n\n█ 可用知識庫 █\n` +
    `以下知識 skills 與目前專案環境匹配，sub-agent 可在需要時參考：\n` +
    Array.from(skills).map(s => `- ${s}`).join('\n');
}

/**
 * 動態生成 PIPELINE_LABELS（從 PIPELINES.label 讀取）
 */
const PIPELINE_LABELS = Object.fromEntries(
  Object.entries(PIPELINES).map(([id, p]) => [id, p.label])
);

/**
 * pipeline ID → legacy taskType 反推映射（向後相容）
 * 修復：顯式定義避免多對一覆蓋（feature/refactor → standard, bugfix/test → quick-dev）
 */
const PIPELINE_TO_TASKTYPE = {
  'full': 'feature',
  'standard': 'feature',
  'quick-dev': 'bugfix',
  'fix': 'quickfix',
  'test-first': 'tdd',
  'ui-only': 'feature',
  'review-only': 'quickfix',
  'docs-only': 'quickfix',
  'security': 'bugfix',
  'none': 'research',
};

/**
 * 判斷是否為升級（新 pipeline 的優先級更高）
 */
function isUpgrade(oldPipelineId, newPipelineId) {
  return (PIPELINE_PRIORITY[newPipelineId] || 0) > (PIPELINE_PRIORITY[oldPipelineId] || 0);
}

/**
 * 計算已完成的 stages（從 state.completed agents 推導）
 */
function getCompletedStages(completedAgents) {
  const stages = new Set();
  for (const agent of (completedAgents || [])) {
    const stage = NAMESPACED_AGENT_TO_STAGE[agent];
    if (stage) stages.add(stage);
  }
  return stages;
}

/**
 * 產生 pipeline 委派規則（systemMessage 用）
 * 精簡版：pipeline-guard 已硬阻擋 Write/Edit，這裡只需核心指令
 */
function buildPipelineRules(pipelineId, stages, pipelineRules) {
  const stageStr = stages.join(' → ');
  const firstStage = stages[0];
  const pipelineLabel = PIPELINE_LABELS[pipelineId] || pipelineId;

  const parts = [];
  parts.push(`⛔ PIPELINE 模式 — 你是管理者，不是執行者。`);
  parts.push(`Pipeline: ${pipelineLabel}（${stageStr}）`);
  parts.push(`禁止 Write/Edit/EnterPlanMode（pipeline-guard 硬阻擋）。使用 Task/Skill 委派 sub-agent。`);
  if (pipelineRules && pipelineRules.length > 0) {
    parts.push(...pipelineRules);
  }
  parts.push(`每階段完成後 stage-transition 指示下一步，照做即可。禁止 AskUserQuestion。`);
  parts.push(`立即委派 ${firstStage} 階段。`);

  return parts.join('\n');
}

/**
 * 初始分類輸出（首次分類）
 */
function outputInitialClassification(pipelineId, stages, state, options = {}) {
  const pipelineLabel = PIPELINE_LABELS[pipelineId] || pipelineId;
  const pipelineEnforced = PIPELINES[pipelineId]?.enforced || false;
  const catalogHint = options.catalogHint || '';

  if (stages.length === 0) {
    // 無需 pipeline（none）— 仍注入知識提示 + 低信心度時附加 pipeline 目錄
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    const context = `[任務分類] Pipeline: ${pipelineLabel} — 無需 pipeline，直接回答。` +
      (knowledgeHints ? `\n${knowledgeHints}` : '') +
      catalogHint;
    console.log(JSON.stringify({ additionalContext: context }));
    return;
  }

  if (pipelineEnforced) {
    // 完整 pipeline 任務 → 注入強制委派規則 + 知識提示（systemMessage）
    const pipelineRules = (state && state.pipelineRules) || [];
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    console.log(JSON.stringify({
      systemMessage: buildPipelineRules(pipelineId, stages, pipelineRules) + knowledgeHints,
    }));
  } else {
    // 輕量 pipeline（fix/review-only/docs-only）→ 資訊提示 + 知識提示
    const stageStr = stages.join(' → ');
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    console.log(JSON.stringify({
      additionalContext: `[任務分類] Pipeline: ${pipelineLabel}\n建議階段：${stageStr}${knowledgeHints}`,
    }));
  }
}

/**
 * 升級輸出（中途升級到更大型 pipeline）
 * 使用 systemMessage 強注入委派規則
 */
function outputUpgrade(oldPipelineId, newPipelineId, remainingStages, skippedStages, state) {
  const oldLabel = PIPELINE_LABELS[oldPipelineId] || oldPipelineId;
  const newLabel = PIPELINE_LABELS[newPipelineId] || newPipelineId;
  const pipelineEnforced = PIPELINES[newPipelineId]?.enforced || false;

  if (remainingStages.length === 0) {
    console.log(JSON.stringify({
      additionalContext: `[Pipeline 升級] ${oldLabel} → ${newLabel} — 所有階段已完成。`,
    }));
    return;
  }

  const stageStr = remainingStages.join(' → ');
  const firstStage = remainingStages[0];
  const skipNote = skippedStages.length > 0
    ? `\n⏭️ 已完成的階段自動跳過：${skippedStages.join('、')}`
    : '';

  if (pipelineEnforced) {
    // 升級到 enforced pipeline 用 systemMessage（強）— 精簡版，pipeline-guard 硬阻擋已保障
    console.log(JSON.stringify({
      systemMessage: `⛔ [Pipeline 升級] ${oldLabel} → ${newLabel}\n` +
        `切換管理者模式。禁止 Write/Edit（pipeline-guard 硬阻擋）。\n` +
        `剩餘階段：${stageStr}${skipNote}\n` +
        `立即委派 ${firstStage} 階段。`,
    }));
  } else {
    // 升級到輕量 pipeline 用 additionalContext
    console.log(JSON.stringify({
      additionalContext: `[Pipeline 升級] ${oldLabel} → ${newLabel}\n建議階段：${stageStr}${skipNote}`,
    }));
  }
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  (async () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || data.content || '';
    const sessionId = data.session_id || 'unknown';

    // Emit prompt received event
    emit(EVENT_TYPES.PROMPT_RECEIVED, sessionId, {});

    // 使用新的 classifyWithConfidence（回傳 { pipeline, confidence, source }）
    const result = classifyWithConfidence(prompt);

    // Layer 3: LLM Fallback — 低信心度時呼叫 Haiku 語意分類
    let catalogHint = '';
    if (result.source === 'pending-llm') {
      const llmResult = await classifyWithLLM(prompt);
      if (llmResult) {
        result.pipeline = llmResult.pipeline;
        result.confidence = llmResult.confidence;
        result.source = llmResult.source;
      } else {
        // LLM 不可用 → 降級回 regex + 注入 pipeline 目錄提示
        result.source = 'regex-low';
        catalogHint = buildPipelineCatalogHint();
      }
    }

    const newPipelineId = result.pipeline;
    const newStages = PIPELINES[newPipelineId]?.stages || [];
    const newPipelineEnforced = PIPELINES[newPipelineId]?.enforced || false;
    const newTaskType = PIPELINE_TO_TASKTYPE[newPipelineId] || 'quickfix'; // 向後相容

    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    // 讀取現有 state
    let state = null;
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 無 state file 或無 pipelineId → 初始分類
    if (!state || !state.pipelineId) {
      if (state) {
        state.pipelineId = newPipelineId;
        state.taskType = newTaskType; // 向後相容
        state.expectedStages = newStages;
        state.pipelineEnforced = newPipelineEnforced;
        state.classificationConfidence = result.confidence; // debug 用
        state.classificationSource = result.source; // debug 用
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      }
      // Emit initial classification
      emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
        pipelineId: newPipelineId,
        taskType: newTaskType,
        expectedStages: newStages,
        reclassified: false,
      });
      outputInitialClassification(newPipelineId, newStages, state, { catalogHint });
      return;
    }

    // ===== 已有 pipelineId → 重新分類邏輯 =====
    const oldPipelineId = state.pipelineId;

    // 相同 pipeline → 不重複注入（避免每次 prompt 都觸發）
    if (oldPipelineId === newPipelineId) {
      return;
    }

    // 降級 → 阻擋，保持現有 pipeline 不中斷
    if (!isUpgrade(oldPipelineId, newPipelineId)) {
      return;
    }

    // ===== 升級！=====
    const completedStages = getCompletedStages(state.completed);
    const remainingStages = newStages.filter(s => !completedStages.has(s));
    const skippedStages = newStages.filter(s => completedStages.has(s));

    // 記錄重新分類歷史
    if (!state.reclassifications) state.reclassifications = [];
    state.reclassifications.push({
      from: oldPipelineId,
      to: newPipelineId,
      at: new Date().toISOString(),
      skippedStages,
    });

    // 更新 state
    state.pipelineId = newPipelineId;
    state.taskType = newTaskType; // 向後相容
    state.expectedStages = newStages;
    state.pipelineEnforced = newPipelineEnforced;
    state.classificationConfidence = result.confidence; // debug 用
    state.classificationSource = result.source; // debug 用
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Emit upgrade classification
    emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
      pipelineId: newPipelineId,
      taskType: newTaskType,
      expectedStages: newStages,
      reclassified: true,
      from: oldPipelineId,
    });

    // 輸出升級指令
    outputUpgrade(oldPipelineId, newPipelineId, remainingStages, skippedStages, state);
  } catch (err) {
    hookLogger.error('task-classifier', err);
  }
  })();
});
