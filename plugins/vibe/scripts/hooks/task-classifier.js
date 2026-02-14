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

// 各任務類型對應的 pipeline 階段
const STAGE_MAPS = {
  research: [],
  quickfix: ['DEV'],
  bugfix: ['DEV', 'TEST'],
  feature: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
  refactor: ['ARCH', 'DEV', 'REVIEW'],
  test: ['TEST'],
  tdd: ['TEST', 'DEV', 'REVIEW'],
};

const TYPE_LABELS = {
  research: '研究探索',
  quickfix: '快速修復',
  bugfix: '修復 Bug',
  feature: '新功能開發',
  refactor: '重構',
  test: '測試',
  tdd: 'TDD 開發',
};

// 任務類型優先級（越大 = pipeline 越完整）
const TYPE_PRIORITY = {
  research: 0,
  quickfix: 1,
  test: 2,
  bugfix: 3,
  refactor: 4,
  tdd: 5,
  feature: 6,
};

// 需要完整 pipeline 委派的任務類型（單一定義點 — pipeline-guard/pipeline-check 讀 state.pipelineEnforced）
const FULL_PIPELINE_TYPES = ['feature', 'refactor', 'tdd'];

const { NAMESPACED_AGENT_TO_STAGE } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

// 分類邏輯提取至 scripts/lib/flow/classifier.js（兩階段級聯分類器）
const { classify } = require(path.join(__dirname, '..', 'lib', 'flow', 'classifier.js'));

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

  if (skills.size === 0) return '';

  return `\n\n█ 可用知識庫 █\n` +
    `以下知識 skills 與目前專案環境匹配，sub-agent 可在需要時參考：\n` +
    Array.from(skills).map(s => `- ${s}`).join('\n');
}

/**
 * 判斷是否為升級（新類型的 pipeline 更大）
 */
function isUpgrade(oldType, newType) {
  return (TYPE_PRIORITY[newType] || 0) > (TYPE_PRIORITY[oldType] || 0);
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
function buildPipelineRules(stages, pipelineRules) {
  const stageStr = stages.join(' → ');
  const firstStage = stages[0];

  const parts = [];
  parts.push(`⛔ PIPELINE 模式 — 你是管理者，不是執行者。`);
  parts.push(`禁止 Write/Edit/EnterPlanMode（pipeline-guard 硬阻擋）。使用 Task/Skill 委派 sub-agent。`);
  if (pipelineRules && pipelineRules.length > 0) {
    parts.push(...pipelineRules);
  } else {
    parts.push(`階段：${stageStr}`);
  }
  parts.push(`每階段完成後 stage-transition 指示下一步，照做即可。禁止 AskUserQuestion。`);
  parts.push(`立即委派 ${firstStage} 階段。`);

  return parts.join('\n');
}

/**
 * 初始分類輸出（首次分類）
 */
function outputInitialClassification(type, label, stages, state) {
  if (stages.length === 0) {
    // 無需 pipeline（research）— 仍注入知識提示
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    const context = `[任務分類] 類型：${label} — 無需 pipeline，直接回答。` +
      (knowledgeHints ? `\n${knowledgeHints}` : '');
    console.log(JSON.stringify({ additionalContext: context }));
    return;
  }

  if (FULL_PIPELINE_TYPES.includes(type)) {
    // 完整 pipeline 任務 → 注入強制委派規則 + 知識提示（systemMessage）
    const pipelineRules = (state && state.pipelineRules) || [];
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    console.log(JSON.stringify({
      systemMessage: buildPipelineRules(stages, pipelineRules) + knowledgeHints,
    }));
  } else {
    // 輕量 pipeline（quickfix/bugfix/test）→ 資訊提示 + 知識提示
    const stageStr = stages.join(' → ');
    const envInfo = state && state.environment;
    const knowledgeHints = buildKnowledgeHints(envInfo);
    console.log(JSON.stringify({
      additionalContext: `[任務分類] 類型：${label}\n建議階段：${stageStr}${knowledgeHints}`,
    }));
  }
}

/**
 * 升級輸出（中途升級到更大型 pipeline）
 * 使用 systemMessage 強注入委派規則
 */
function outputUpgrade(oldLabel, newLabel, remainingStages, skippedStages, state) {
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

  // 升級時用 systemMessage（強）— 精簡版，pipeline-guard 硬阻擋已保障
  console.log(JSON.stringify({
    systemMessage: `⛔ [Pipeline 升級] ${oldLabel} → ${newLabel}\n` +
      `切換管理者模式。禁止 Write/Edit（pipeline-guard 硬阻擋）。\n` +
      `剩餘階段：${stageStr}${skipNote}\n` +
      `立即委派 ${firstStage} 階段。`,
  }));
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || data.content || '';
    const sessionId = data.session_id || 'unknown';

    // Emit prompt received event
    emit(EVENT_TYPES.PROMPT_RECEIVED, sessionId, {});

    const newType = classify(prompt);
    const newStages = STAGE_MAPS[newType] || [];
    const newLabel = TYPE_LABELS[newType] || newType;

    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);

    // 讀取現有 state
    let state = null;
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 無 state file 或無 taskType → 初始分類
    if (!state || !state.taskType) {
      if (state) {
        state.taskType = newType;
        state.expectedStages = newStages;
        state.pipelineEnforced = FULL_PIPELINE_TYPES.includes(newType);
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      }
      // Emit initial classification
      emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
        taskType: newType,
        expectedStages: newStages,
        reclassified: false,
      });
      outputInitialClassification(newType, newLabel, newStages, state);
      return;
    }

    // ===== 已有 taskType → 重新分類邏輯 =====
    const oldType = state.taskType;
    const oldLabel = TYPE_LABELS[oldType] || oldType;

    // 相同類型 → 不重複注入（避免每次 prompt 都觸發）
    if (oldType === newType) {
      return;
    }

    // 降級 → 阻擋，保持現有 pipeline 不中斷
    if (!isUpgrade(oldType, newType)) {
      return;
    }

    // ===== 升級！=====
    const completedStages = getCompletedStages(state.completed);
    const remainingStages = newStages.filter(s => !completedStages.has(s));
    const skippedStages = newStages.filter(s => completedStages.has(s));

    // 記錄重新分類歷史
    if (!state.reclassifications) state.reclassifications = [];
    state.reclassifications.push({
      from: oldType,
      to: newType,
      at: new Date().toISOString(),
      skippedStages,
    });

    // 更新 state
    state.taskType = newType;
    state.expectedStages = newStages;
    state.pipelineEnforced = FULL_PIPELINE_TYPES.includes(newType);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Emit upgrade classification
    emit(EVENT_TYPES.TASK_CLASSIFIED, sessionId, {
      taskType: newType,
      expectedStages: newStages,
      reclassified: true,
      from: oldType,
    });

    // 輸出升級指令（只有強制 pipeline 類型才用 systemMessage）
    if (state.pipelineEnforced) {
      outputUpgrade(oldLabel, newLabel, remainingStages, skippedStages, state);
    } else {
      // 輕量升級（research → quickfix 等）→ additionalContext
      const stageStr = newStages.join(' → ');
      console.log(JSON.stringify({
        additionalContext: `[任務分類升級] ${oldLabel} → ${newLabel}\n建議階段：${stageStr}`,
      }));
    }
  } catch (err) {
    hookLogger.error('task-classifier', err);
  }
});
