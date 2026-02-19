#!/usr/bin/env node
/**
 * registry.js — Vibe Agent/Stage Registry
 *
 * 所有 agent/stage/pipeline metadata 的唯一定義點（Single Source of Truth）。
 * hook 腳本、bot.js、server.js、dashboard 都從這裡讀取。
 *
 * v1.0.43 重構：集中化原本散落在 stage-transition / task-classifier 中的常量。
 *
 * @module registry
 */
'use strict';

// ────────────────── Stage 定義 ──────────────────
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
const AGENT_TO_STAGE = {
  ...Object.fromEntries(
    Object.entries(STAGES).map(([stage, cfg]) => [cfg.agent, stage])
  ),
  'security-reviewer': 'REVIEW',  // 支援 agent，對應 REVIEW 階段
};

// agent namespace（ECC 加前綴後）→ stage（如 'vibe:planner' → 'PLAN'）
const NAMESPACED_AGENT_TO_STAGE = {
  ...Object.fromEntries(
    Object.entries(STAGES).map(([stage, cfg]) => [`vibe:${cfg.agent}`, stage])
  ),
  'vibe:security-reviewer': 'REVIEW',  // 支援 agent
};

// 工具 emoji 映射（用於回合摘要通知）
const TOOL_EMOJI = [
  ['write',  '\u{1F4DD}'],  // 📝
  ['edit',   '\u270F\uFE0F'], // ✏️
  ['bash',   '\u26A1'],      // ⚡
  ['task',   '\u{1F916}'],   // 🤖
  ['search', '\u{1F50D}'],   // 🔍
  ['read',   '\u{1F4D6}'],   // 📖
];

// ────────────────── 框架分類 ──────────────────

// 前端框架 — 需要視覺設計階段
const FRONTEND_FRAMEWORKS = ['next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular', 'solid', 'preact', 'lit', 'qwik', 'ember'];

// 純 API 框架 — 不需要瀏覽器 E2E 測試
const API_ONLY_FRAMEWORKS = ['express', 'fastify', 'hono', 'koa', 'nest'];

// ────────────────── Pipeline 定義 ──────────────────

// 10 種參考工作流模板（v3：DAG 由 pipeline-architect agent 動態生成，這些作為參考範例）
const REFERENCE_PIPELINES = {
  'full':       { stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'], enforced: true,  label: '完整開發', description: '新功能（含 UI）' },
  'standard':   { stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],                       enforced: true,  label: '標準開發', description: '新功能（無 UI）、大重構' },
  'quick-dev':  { stages: ['DEV', 'REVIEW', 'TEST'],                                               enforced: true,  label: '快速開發', description: 'bugfix + 補測試、小改動' },
  'fix':        { stages: ['DEV'],                                                                  enforced: true,  label: '快速修復', description: 'hotfix、config、一行修改' },
  'test-first': { stages: ['TEST', 'DEV', 'TEST:verify'],                                              enforced: true,  label: 'TDD 開發', description: 'TDD 工作流（RED→GREEN→REFACTOR）' },
  'ui-only':    { stages: ['DESIGN', 'DEV', 'QA'],                                                  enforced: true,  label: 'UI 調整',  description: '純 UI/樣式調整' },
  'review-only':{ stages: ['REVIEW'],                                                               enforced: true,  label: '程式碼審查', description: '程式碼審查' },
  'docs-only':  { stages: ['DOCS'],                                                                 enforced: true,  label: '文件更新', description: '純文件更新' },
  'security':   { stages: ['DEV', 'REVIEW', 'TEST'],                                                enforced: true,  label: '安全修復', description: '安全修復（REVIEW 含安全審查）' },
  'none':       { stages: [],                                                                       enforced: false, label: '無 Pipeline', description: '問答、研究、trivial' },
};

// Pipeline 優先級映射 — 數字越高代表流程越完整
const PIPELINE_PRIORITY = {
  'none': 0, 'docs-only': 1, 'review-only': 1, 'fix': 2,
  'ui-only': 3, 'security': 3, 'quick-dev': 4,
  'test-first': 5, 'standard': 6, 'full': 7,
};

// 舊 taskType → pipeline ID 映射（向後相容）
const TASKTYPE_TO_PIPELINE = {
  'research': 'none', 'quickfix': 'fix', 'bugfix': 'quick-dev',
  'feature': 'standard', 'refactor': 'standard',
  'test': 'quick-dev', 'tdd': 'test-first',
  'docs': 'docs-only',
};

// pipeline ID → legacy taskType 反推映射（向後相容）
const PIPELINE_TO_TASKTYPE = {
  'full': 'feature', 'standard': 'feature', 'quick-dev': 'bugfix',
  'fix': 'quickfix', 'test-first': 'tdd', 'ui-only': 'feature',
  'review-only': 'quickfix', 'docs-only': 'quickfix',
  'security': 'bugfix', 'none': 'research',
};

// ────────────────── Pipeline 行為常量 ──────────────────

// 品質階段 — 會輸出 verdict，失敗時可觸發回退
const QUALITY_STAGES = ['REVIEW', 'TEST', 'QA', 'E2E'];

// Verdict 正規表達式（v3 fallback 用）
const VERDICT_REGEX = /<!-- PIPELINE_VERDICT:\s*(PASS|FAIL(?::(?:CRITICAL|HIGH|MEDIUM|LOW))?)\s*-->/;

// Route 正規表達式（v4 PIPELINE_ROUTE 協議）
// 注意：JSON payload 中不可含 '-->'，route-parser.js validateRoute() 會自動 sanitize
const PIPELINE_ROUTE_REGEX = /<!-- PIPELINE_ROUTE:\s*([\s\S]*?)\s*-->/;

// 智慧回退上限
const MAX_RETRIES = parseInt(process.env.CLAUDE_PIPELINE_MAX_RETRIES || '3', 10);

// ────────────────── 階段上下文提示 ──────────────────

// 各階段專屬 context（注入到 systemMessage）
const STAGE_CONTEXT = {
  QA: '📋 QA 重點：API/CLI 行為正確性驗證。用 curl 發送真實請求，驗證回應格式、HTTP status code、error handling。不要寫測試碼。',
  E2E_UI: '🌐 E2E 重點：瀏覽器使用者流程。用 agent-browser 操作 UI，驗證完整的使用者旅程。不重複 QA 已驗證的 API 場景。',
  E2E_API: '🌐 E2E 重點：跨步驟資料一致性驗證。重點測試多使用者互動、狀態依賴鏈（如 email 更新後能否用新 email 登入）、錯誤恢復流程。不重複 QA 已做過的基本 API 場景。',
};

// 階段完成後的附加提示
const POST_STAGE_HINTS = {
  ARCH: '🎨 設計提示：ARCH 完成。如果這是前端專案，接下來的 DESIGN 階段會產出設計系統和視覺化 mockup。',
  DESIGN: '🎨 設計提示：DESIGN 已產出 design-system.md 和 mockup.html。developer 請遵循設計系統的色彩(hex)、字體(Google Fonts)、間距(spacing tokens) 規範。',
  REVIEW: '🔒 安全提示：REVIEW 已完成程式碼品質審查。建議在 TEST 階段也關注安全相關測試（auth、input validation、injection）。如有 auth/crypto 相關變更，可在 pipeline 完成後執行 /vibe:security 深度掃描。',
  TEST: '📊 覆蓋率提示：TEST 已完成。進入 QA 前建議關注測試覆蓋率。pipeline 完成後可用 /vibe:coverage 取得詳細報告。',
};

// OpenSpec 階段上下文
const OPENSPEC_CONTEXT = {
  ARCH: '📋 OpenSpec：planner 已建立 proposal.md，architect 請讀取 openspec/changes/ 中的 proposal 後產出 design.md、specs/、tasks.md。',
  DESIGN: '📋 OpenSpec：architect 已產出 design.md 和 proposal.md。designer 請讀取這兩份文件，產出 design-system.md（色彩/字體/間距規範）和 design-mockup.html（視覺化預覽）到 openspec/changes/ 中。',
  DEV: '📋 OpenSpec：architect 已產出完整規格，developer 請依照 openspec/changes/ 中的 tasks.md checkbox 逐一實作並打勾。',
  REVIEW: '📋 OpenSpec：請讀取 openspec/changes/ 中的 specs/ 和 design.md，對照審查實作是否符合規格。',
  TEST: '📋 OpenSpec：請讀取 openspec/changes/ 中的 specs/，將每個 Scenario 的 WHEN/THEN 轉換為測試案例。',
  DOCS: '📋 OpenSpec：所有實作已完成，doc-updater 請在更新文件後將 change 歸檔到 openspec/changes/archive/。',
};

// ────────────────── 知識 Skill 映射 ──────────────────

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
  common: ['/vibe:coding-standards', '/vibe:testing-patterns'],
};

// ────────────────── Barrier 並行配置 ──────────────────
// 需要 barrier 同步的 pipeline 模板設定（SoT）
// key: pipelineId, value: barrier group 設定陣列
const BARRIER_CONFIG = {
  'full': [
    { stages: ['REVIEW', 'TEST'], group: 'post-dev', next: 'QA' },
    { stages: ['QA', 'E2E'], group: 'post-qa', next: 'DOCS' },
  ],
  'standard': [
    { stages: ['REVIEW', 'TEST'], group: 'post-dev', next: 'DOCS' },
  ],
  'quick-dev': [
    { stages: ['REVIEW', 'TEST'], group: 'post-dev', next: null },
  ],
};

// ────────────────── Exports ──────────────────

module.exports = {
  // Stage 定義
  STAGES, STAGE_ORDER, AGENT_TO_STAGE, NAMESPACED_AGENT_TO_STAGE, TOOL_EMOJI,
  // 框架分類
  FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS,
  // Pipeline 定義
  REFERENCE_PIPELINES,
  PIPELINES: REFERENCE_PIPELINES,  // 向後相容別名
  PIPELINE_PRIORITY, TASKTYPE_TO_PIPELINE, PIPELINE_TO_TASKTYPE,
  // Pipeline 行為
  QUALITY_STAGES, VERDICT_REGEX, PIPELINE_ROUTE_REGEX, MAX_RETRIES,
  // Barrier 並行
  BARRIER_CONFIG,
  // 階段上下文
  STAGE_CONTEXT, POST_STAGE_HINTS, OPENSPEC_CONTEXT,
  // 知識 Skills
  KNOWLEDGE_SKILLS,
};
