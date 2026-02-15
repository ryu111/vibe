#!/usr/bin/env node
/**
 * registry.js — Vibe Agent/Stage Registry
 *
 * 所有 agent/stage metadata 的唯一定義點（Single Source of Truth）。
 * remote-sender、bot.js、task-classifier、dashboard 都從這裡讀取。
 *
 * @module registry
 * @exports {Object} STAGES - 階段定義（agent/emoji/label/color）
 * @exports {string[]} STAGE_ORDER - 階段執行順序
 * @exports {Object} AGENT_TO_STAGE - agent 短名 → stage 映射
 * @exports {Object} NAMESPACED_AGENT_TO_STAGE - 帶前綴 agent → stage 映射
 * @exports {Array} TOOL_EMOJI - 工具 emoji 映射
 */
'use strict';

// ⚠️ 物件 key 順序決定 STAGE_ORDER！DESIGN 必須在 ARCH 和 DEV 之間
const STAGES = {
  PLAN:   { agent: 'planner',          emoji: '\u{1F4CB}',          label: '規劃',       color: 'purple' },
  ARCH:   { agent: 'architect',        emoji: '\u{1F3D7}\uFE0F',   label: '架構',       color: 'cyan' },
  DESIGN: { agent: 'designer',         emoji: '\u{1F3A8}',          label: '設計',       color: 'cyan' },
  DEV:    { agent: 'developer',        emoji: '\u{1F4BB}',          label: '開發',       color: 'yellow' },
  REVIEW: { agent: 'code-reviewer',    emoji: '\u{1F50D}',          label: '審查',       color: 'blue' },
  TEST:   { agent: 'tester',           emoji: '\u{1F9EA}',          label: '測試',       color: 'pink' },
  QA:     { agent: 'qa',               emoji: '\u2705',             label: '行為驗證',   color: 'yellow' },
  E2E:    { agent: 'e2e-runner',       emoji: '\u{1F310}',          label: '端對端測試', color: 'green' },
  DOCS:   { agent: 'doc-updater',      emoji: '\u{1F4DD}',          label: '文件整理',   color: 'purple' },
};

const STAGE_ORDER = Object.keys(STAGES);

// agent 短名 → stage（如 'planner' → 'PLAN'）
const AGENT_TO_STAGE = Object.fromEntries(
  Object.entries(STAGES).map(([stage, cfg]) => [cfg.agent, stage])
);

// agent namespace（ECC 加前綴後）→ stage（如 'vibe:planner' → 'PLAN'）
const NAMESPACED_AGENT_TO_STAGE = Object.fromEntries(
  Object.entries(STAGES).map(([stage, cfg]) => [`vibe:${cfg.agent}`, stage])
);

// 工具 emoji 映射（用於回合摘要通知）
const TOOL_EMOJI = [
  ['write',  '\u{1F4DD}'],  // 📝
  ['edit',   '\u270F\uFE0F'], // ✏️
  ['bash',   '\u26A1'],      // ⚡
  ['task',   '\u{1F916}'],   // 🤖
  ['search', '\u{1F50D}'],   // 🔍
  ['read',   '\u{1F4D6}'],   // 📖
];

// 前端框架 — 需要視覺設計階段（共用常量）
const FRONTEND_FRAMEWORKS = ['next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular'];

// Pipeline 模板定義 — 10 種工作流模板
const PIPELINES = {
  'full':       { stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'], enforced: true,  label: '完整開發', description: '新功能（含 UI）' },
  'standard':   { stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],                       enforced: true,  label: '標準開發', description: '新功能（無 UI）、大重構' },
  'quick-dev':  { stages: ['DEV', 'REVIEW', 'TEST'],                                               enforced: true,  label: '快速開發', description: 'bugfix + 補測試、小改動' },
  'fix':        { stages: ['DEV'],                                                                  enforced: false, label: '快速修復', description: 'hotfix、config、一行修改' },
  'test-first': { stages: ['TEST', 'DEV', 'TEST'],                                                  enforced: true,  label: 'TDD 開發', description: 'TDD 工作流' },
  'ui-only':    { stages: ['DESIGN', 'DEV', 'QA'],                                                  enforced: true,  label: 'UI 調整',  description: '純 UI/樣式調整' },
  'review-only':{ stages: ['REVIEW'],                                                               enforced: false, label: '程式碼審查', description: '程式碼審查' },
  'docs-only':  { stages: ['DOCS'],                                                                 enforced: false, label: '文件更新', description: '純文件更新' },
  'security':   { stages: ['DEV', 'REVIEW', 'TEST'],                                                enforced: true,  label: '安全修復', description: '安全修復（REVIEW 含安全審查）' },
  'none':       { stages: [],                                                                       enforced: false, label: '無 Pipeline', description: '問答、研究、trivial' },
};

// Pipeline 優先級映射 — 數字越高代表流程越完整
const PIPELINE_PRIORITY = {
  'none': 0,
  'docs-only': 1,
  'review-only': 1,
  'fix': 2,
  'ui-only': 3,
  'security': 3,
  'quick-dev': 4,
  'test-first': 5,
  'standard': 6,
  'full': 7,
};

// 舊 taskType → pipeline ID 映射（向後相容）
const TASKTYPE_TO_PIPELINE = {
  'research': 'none',
  'quickfix': 'fix',
  'bugfix': 'quick-dev',
  'feature': 'standard',
  'refactor': 'standard',
  'test': 'quick-dev',
  'tdd': 'test-first',
};

module.exports = {
  STAGES,
  STAGE_ORDER,
  AGENT_TO_STAGE,
  NAMESPACED_AGENT_TO_STAGE,
  TOOL_EMOJI,
  FRONTEND_FRAMEWORKS,
  PIPELINES,
  PIPELINE_PRIORITY,
  TASKTYPE_TO_PIPELINE,
};
