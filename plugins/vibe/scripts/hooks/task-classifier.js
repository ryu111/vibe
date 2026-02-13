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

// 需要完整 pipeline 委派的任務類型（單一定義點 — dev-gate/pipeline-check 讀 state.pipelineEnforced）
const FULL_PIPELINE_TYPES = ['feature', 'refactor', 'tdd'];

const { NAMESPACED_AGENT_TO_STAGE } = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));

/**
 * 關鍵字分類 — V2 保守預設（quickfix），feature 需正向匹配
 */
function classify(prompt) {
  if (!prompt) return 'quickfix';
  const p = prompt.toLowerCase();

  // 研究型：問題、探索、理解
  if (/[?？]$|^(what|how|why|where|explain|show|list|find|search)\b|看看|查看|找找|說明|解釋|什麼|怎麼|為什麼|哪裡|告訴|描述|列出|做什麼|是什麼|有哪些|出問題|是不是/.test(p)) {
    return 'research';
  }
  // Trivial/Demo 任務：明確的簡單任務不需要完整 pipeline
  if (/hello.?world|boilerplate|scaffold|skeleton|poc|proof.?of.?concept|概念驗證|prototype|原型|試做|試作|簡單的?\s*(?:範例|demo|example|試試)|練習用|練習一下|tutorial|學習用|playground|scratch/.test(p)) {
    return 'quickfix';
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
  // 功能開發：明確的功能建設意圖（正向匹配）
  if (/implement|develop|build.*feature|新增功能|建立.*(?:功能|api|rest|endpoint|server|service|database|服務|系統|模組|元件|頁面|app|應用|專案|component|module)|實作|開發.*功能|加入.*功能|新的.*(api|endpoint|component|頁面|模組|plugin)|整合.*系統/.test(p)) {
    return 'feature';
  }
  // 快速修復：簡單改動
  if (/fix.*typo|rename|change.*name|update.*text|改名|修.*typo|換.*名|改.*顏色|改.*文字/.test(p)) {
    return 'quickfix';
  }
  // Bug 修復
  if (/fix|bug|修(復|正)|debug|壞了|出錯|不work|不能/.test(p)) {
    return 'bugfix';
  }
  // 預設：quickfix（保守 — 僅 DEV 階段，不鎖定 pipeline 模式）
  return 'quickfix';
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
 * 產生完整 pipeline 委派規則（systemMessage 用）
 */
function buildPipelineRules(stages, pipelineRules) {
  const stageStr = stages.join(' → ');
  const firstStage = stages[0];

  const parts = [];
  parts.push(`⛔ PIPELINE 模式啟動 — 你是管理者（Orchestrator），不是執行者（Executor）`);
  parts.push('');
  parts.push('█ 絕對禁止 █');
  parts.push('- 🚫 禁止直接使用 Write 工具寫任何程式碼檔案');
  parts.push('- 🚫 禁止直接使用 Edit 工具修改任何程式碼檔案');
  parts.push('- 🚫 禁止直接使用 Bash 工具執行 build、test、lint 等開發指令');
  parts.push('- 你的唯一職責：按順序使用 Task/Skill 工具委派各階段給 sub-agent');
  parts.push('- 違反此規則的 Write/Edit 操作會被 dev-gate hook 硬阻擋（exit 2）');
  parts.push('');
  parts.push('█ 委派順序 █');
  if (pipelineRules && pipelineRules.length > 0) {
    parts.push(...pipelineRules);
  } else {
    parts.push(`必要階段：${stageStr}`);
  }
  parts.push('');
  parts.push('█ 執行規則 █');
  parts.push('1. 立即從第一個階段開始委派');
  parts.push('2. 每個階段完成後，stage-transition hook 會指示下一步 — 你**必須**照做');
  parts.push('3. 不可跳過已安裝的階段（REVIEW、TEST、QA 階段**不可省略**）');
  parts.push('4. 未安裝的 plugin 對應的階段會自動跳過');
  parts.push('5. Pipeline 執行中**禁止使用 AskUserQuestion** — 各階段自動完成，不中斷使用者');
  parts.push('');
  parts.push('█ 正確做法範例 █');
  parts.push('✅ Task({ subagent_type: "vibe:planner", prompt: "..." })');
  parts.push('✅ Task({ subagent_type: "vibe:architect", prompt: "..." })');
  parts.push('✅ Task({ subagent_type: "vibe:developer", prompt: "..." })');
  parts.push('❌ Write({ file_path: "src/app.ts", content: "..." }) ← 這會被 dev-gate 阻擋');
  parts.push('');
  parts.push(`立即使用 Task 工具委派 ${firstStage} 階段的 sub-agent。`);

  return parts.join('\n');
}

/**
 * 初始分類輸出（首次分類）
 */
function outputInitialClassification(type, label, stages, state) {
  if (stages.length === 0) {
    // 無需 pipeline（research）
    console.log(JSON.stringify({
      additionalContext: `[任務分類] 類型：${label} — 無需 pipeline，直接回答。`,
    }));
    return;
  }

  if (FULL_PIPELINE_TYPES.includes(type)) {
    // 完整 pipeline 任務 → 注入強制委派規則（systemMessage）
    const pipelineRules = (state && state.pipelineRules) || [];
    console.log(JSON.stringify({
      systemMessage: buildPipelineRules(stages, pipelineRules),
    }));
  } else {
    // 輕量 pipeline（quickfix/bugfix/test）→ 資訊提示
    const stageStr = stages.join(' → ');
    console.log(JSON.stringify({
      additionalContext: `[任務分類] 類型：${label}\n建議階段：${stageStr}`,
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

  // 升級時用 systemMessage（強）
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
        state.pipelineEnforced = FULL_PIPELINE_TYPES.includes(newType);
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      }
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
