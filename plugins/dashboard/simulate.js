#!/usr/bin/env bun
/**
 * Vibe Pipeline Simulation — 模擬完整 pipeline 執行流程
 * 包含：階段推進、REVIEW 失敗重試、E2E 跳過、完成清理
 */
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude');
if (!existsSync(CLAUDE_DIR)) mkdirSync(CLAUDE_DIR, { recursive: true });

const SID = `demo-${Date.now()}`;
const fp = join(CLAUDE_DIR, `pipeline-state-${SID}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STAGE_AGENTS = {
  PLAN: 'planner', ARCH: 'architect', DEV: 'developer',
  REVIEW: 'code-reviewer', TEST: 'tester', QA: 'qa',
  E2E: 'e2e-runner', DOCS: 'doc-updater',
};
const STAGE_CPU = {
  PLAN: [20, 40], ARCH: [15, 35], DEV: [55, 90],
  REVIEW: [35, 65], TEST: [65, 95], QA: [45, 75],
  E2E: [75, 95], DOCS: [10, 30],
};
const STAGE_SKILLS = {
  PLAN: ['plan'], ARCH: ['architect'], DEV: ['lint', 'format', 'env-detect'],
  REVIEW: ['review', 'security'], TEST: ['tdd', 'coverage'], QA: ['qa', 'verify'],
  E2E: ['e2e'], DOCS: ['doc-sync'],
};
const STAGE_TOOLS = {
  PLAN: [5, 12], ARCH: [8, 18], DEV: [25, 55],
  REVIEW: [15, 35], TEST: [20, 45], QA: [10, 25],
  E2E: [15, 30], DOCS: [5, 12],
};

const state = {
  sessionId: SID,
  initialized: true,
  completed: [],
  expectedStages: [],
  environment: {
    languages: { primary: 'typescript', secondary: [] },
    framework: { name: 'express', version: '4.21.0' },
    packageManager: { name: 'npm', lockFile: 'package-lock.json' },
    tools: { linter: 'eslint', formatter: 'prettier', test: 'vitest', bundler: null },
  },
  lastTransition: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  taskType: null,
  delegationActive: false,
  stageResults: {},
  retries: {},
  currentStage: null,
  resources: { cpu: 0, ram: 150 },
};

function save() {
  writeFileSync(fp, JSON.stringify(state, null, 2));
}

// SIGINT 清理
process.on('SIGINT', () => {
  try { unlinkSync(fp); } catch {}
  console.log('\n  🧹 已清理 state 檔案');
  process.exit(0);
});

async function doStage(stage, durationMs, verdict = 'PASS', severity = null) {
  const stageStart = Date.now();
  state.currentStage = stage;
  state.delegationActive = true;
  const [cpuMin, cpuMax] = STAGE_CPU[stage] || [10, 50];
  state.resources.cpu = Math.round(cpuMin + Math.random() * (cpuMax - cpuMin));
  state.resources.ram = Math.min(512, state.resources.ram + Math.round(5 + Math.random() * 15));
  state.lastTransition = new Date().toISOString();
  save();
  console.log(`  🔄 ${stage} — ${STAGE_AGENTS[stage]} 工作中...`);

  // 分段 sleep + 資源波動
  const chunks = Math.max(3, Math.ceil(durationMs / 600));
  for (let i = 0; i < chunks; i++) {
    await sleep(durationMs / chunks);
    state.resources.cpu = Math.round(cpuMin + Math.random() * (cpuMax - cpuMin));
    if (Math.random() > 0.6) state.resources.ram = Math.min(512, state.resources.ram + Math.round(Math.random() * 8));
    state.lastTransition = new Date().toISOString();
    save();
  }

  const duration = parseFloat(((Date.now() - stageStart) / 1000).toFixed(1));
  const [toolMin, toolMax] = STAGE_TOOLS[stage] || [5, 15];
  const toolCalls = Math.round(toolMin + Math.random() * (toolMax - toolMin));

  state.delegationActive = false;
  state.resources.cpu = Math.round(2 + Math.random() * 8);
  const allSkills = STAGE_SKILLS[stage] || [];
  const skillsUsed = verdict === 'PASS' ? allSkills.filter(() => Math.random() > 0.2) : allSkills.filter(() => Math.random() > 0.5);
  state.stageResults[stage] = { verdict, severity, duration, toolCalls, skillsUsed };
  if (!state.completed.includes(STAGE_AGENTS[stage])) {
    state.completed.push(STAGE_AGENTS[stage]);
  }
  state.lastTransition = new Date().toISOString();
  save();

  const icon = verdict === 'PASS' ? '✅' : '❌';
  console.log(`  ${icon} ${stage} — ${verdict}${severity ? ` (${severity})` : ''} [${duration}s, ${toolCalls} tools]`);
}

async function run() {
  console.log(`\n  🎬 Pipeline 模擬 — ${SID}`);
  console.log(`  打開 http://localhost:3800 觀看\n`);

  // 1. 初始化
  save();
  console.log('  📝 Session 已初始化');
  await sleep(1500);

  // 2. 任務分類
  state.taskType = 'feature';
  state.expectedStages = ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'DOCS'];
  state.lastTransition = new Date().toISOString();
  save();
  console.log('  🏷️  任務分類：feature（7 階段，E2E 跳過）');
  await sleep(1500);

  // 3. PLAN → ARCH → DEV
  await doStage('PLAN', 2000);
  await sleep(600);
  await doStage('ARCH', 2500);
  await sleep(600);
  await doStage('DEV', 3500);
  await sleep(600);

  // 4. REVIEW 失敗！
  await doStage('REVIEW', 2000, 'FAIL', 'HIGH');
  state.retries.REVIEW = 1;
  save();
  console.log('  🔁 回退到 DEV 重試...');
  await sleep(1200);

  // 5. DEV 重做
  await doStage('DEV', 2500);
  await sleep(600);

  // 6. REVIEW 重試（通過）
  await doStage('REVIEW', 2000);
  await sleep(600);

  // 7. TEST → QA → DOCS
  await doStage('TEST', 2000);
  await sleep(600);
  await doStage('QA', 2500);
  await sleep(600);
  await doStage('DOCS', 1500);
  await sleep(1500);

  // 8. 完成 — 保留足夠時間觀看結果
  console.log('\n  🏁 Pipeline 完成！');
  console.log('  ⏳ 5 分鐘後自動清理（Ctrl+C 提早結束）');
  await sleep(300000);

  unlinkSync(fp);
  console.log('  🗑️  State 檔案已清理\n');
}

run().catch(console.error);
