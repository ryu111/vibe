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

const STAGES = {
  PLAN:   { agent: 'planner',          emoji: '\u{1F4CB}',          label: '規劃',       color: 'purple' },
  ARCH:   { agent: 'architect',        emoji: '\u{1F3D7}\uFE0F',   label: '架構',       color: 'cyan' },
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

module.exports = {
  STAGES,
  STAGE_ORDER,
  AGENT_TO_STAGE,
  NAMESPACED_AGENT_TO_STAGE,
  TOOL_EMOJI,
};
