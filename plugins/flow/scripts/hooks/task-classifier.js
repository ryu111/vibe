#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * 分析使用者 prompt，分類任務類型，更新 pipeline state 的 expectedStages。
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

// 硬編碼 agent→stage 映射（零依賴，不 import pipeline-discovery）
const AGENT_STAGE = {
  'flow:planner': 'PLAN',
  'flow:architect': 'ARCH',
  'flow:developer': 'DEV',
  'sentinel:code-reviewer': 'REVIEW',
  'sentinel:tester': 'TEST',
  'sentinel:qa': 'QA',
  'sentinel:e2e-runner': 'E2E',
  'evolve:doc-updater': 'DOCS',
};

/**
 * 關鍵字分類 — V1 用 heuristic，足夠精確
 */
function classify(prompt) {
  if (!prompt) return 'feature';
  const p = prompt.toLowerCase();

  // 研究型：問題、探索、理解
  if (/[?？]$|^(what|how|why|where|explain|show|list|find|search)\b|看看|查看|找找|說明|解釋|什麼|怎麼|為什麼|哪裡|告訴|描述|列出|做什麼|是什麼|有哪些/.test(p)) {
    return 'research';
  }
  // TDD：明確要求
  if (/tdd|test.?first|測試驅動|先寫測試/.test(p)) {
    return 'tdd';
  }
  // 純測試
  if (/^(write|add|create|fix).*test|^(寫|加|新增|修).*測試|^test\b/.test(p)) {
    return 'test';
  }
  // 重構
  if (/refactor|restructure|重構|重寫|重新設計|改架構/.test(p)) {
    return 'refactor';
  }
  // 快速修復：簡單改動
  if (/fix.*typo|rename|change.*name|update.*text|改名|修.*typo|換.*名|改.*顏色|改.*文字/.test(p)) {
    return 'quickfix';
  }
  // Bug 修復
  if (/fix|bug|修(復|正)|debug|壞了|出錯|不work|不能/.test(p)) {
    return 'bugfix';
  }
  // 預設：功能開發（完整 pipeline）
  return 'feature';
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
    const stage = AGENT_STAGE[agent];
    if (stage) stages.add(stage);
  }
  return stages;
}

/**
 * 初始分類輸出（首次分類）
 */
function outputInitialClassification(type, label, stages) {
  if (stages.length > 0) {
    const stageStr = stages.join(' → ');
    const firstStage = stages[0];
    console.log(JSON.stringify({
      additionalContext: `⛔ [Pipeline 任務分類] 類型：${label}\n必要階段：${stageStr}\n🚫 你是管理者 — 禁止直接使用 Write/Edit 寫程式碼。立即使用 Task 工具委派 ${firstStage} 階段的 sub-agent。`,
    }));
  } else {
    console.log(JSON.stringify({
      additionalContext: `[任務分類] 類型：${label} — 無需 pipeline，直接回答。`,
    }));
  }
}

/**
 * 升級輸出（中途升級到更大型 pipeline）
 * 使用 systemMessage 強注入委派規則（因為 pipeline-init 不會重新觸發）
 */
function outputUpgrade(oldLabel, newLabel, remainingStages, skippedStages) {
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

  // 升級時用 systemMessage（強）— 彌補 pipeline-init 不會重新觸發的問題
  console.log(JSON.stringify({
    systemMessage: `⛔ [Pipeline 升級] ${oldLabel} → ${newLabel}\n` +
      `你**必須**切換到 Pipeline 管理者模式。\n` +
      `剩餘階段：${stageStr}${skipNote}\n` +
      `\n█ 絕對禁止 █\n` +
      `- 🚫 禁止直接使用 Write/Edit 寫程式碼\n` +
      `- 你的唯一職責：使用 Task/Skill 工具委派各階段給 sub-agent\n` +
      `- 違反此規則的 Write/Edit 操作會被 dev-gate hook 硬阻擋（exit 2）\n` +
      `\n立即使用 Task 工具委派 ${firstStage} 階段的 sub-agent。`,
  }));
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || data.content || '';
    const sessionId = data.session_id || 'unknown';

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
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      }
      outputInitialClassification(newType, newLabel, newStages);
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
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 輸出升級指令
    outputUpgrade(oldLabel, newLabel, remainingStages, skippedStages);
  } catch (err) {
    process.stderr.write(`task-classifier: ${err.message}\n`);
  }
});
