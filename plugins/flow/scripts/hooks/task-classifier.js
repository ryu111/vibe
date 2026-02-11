#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * 分析使用者 prompt，分類任務類型，更新 pipeline state 的 expectedStages。
 * 取代原本的 prompt hook — 因為 prompt hook 的自定義欄位不會被讀取。
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

/**
 * 關鍵字分類 — V1 用 heuristic，足夠精確
 */
function classify(prompt) {
  if (!prompt) return 'feature';
  const p = prompt.toLowerCase();

  // 研究型：問題、探索、理解
  if (/\?$|^(what|how|why|where|explain|show|list|find|search|看|查|找|說明|解釋|什麼|怎麼|為什麼|哪|告訴|描述|列出)/.test(p)) {
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

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    // UserPromptSubmit stdin 可能有不同欄位名
    const prompt = data.prompt || data.user_prompt || data.content || '';
    const sessionId = data.session_id || 'unknown';

    const type = classify(prompt);
    const stages = STAGE_MAPS[type] || [];
    const label = TYPE_LABELS[type] || type;

    // 更新 pipeline state file 的 expectedStages
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.taskType = type;
        state.expectedStages = stages;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      } catch (_) {}
    }

    // 輸出分類結果給主 agent
    if (stages.length > 0) {
      const stageStr = stages.join(' → ');
      console.log(JSON.stringify({
        additionalContext: `[Pipeline 任務分類] 類型：${label}\n必要階段：${stageStr}\n請立即從第一個階段開始，按順序委派給對應的 sub-agent 執行。`,
      }));
    } else {
      console.log(JSON.stringify({
        additionalContext: `[任務分類] 類型：${label} — 無需 pipeline，直接回答。`,
      }));
    }
  } catch (err) {
    process.stderr.write(`task-classifier: ${err.message}\n`);
  }
});
