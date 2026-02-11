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
  taskType: null,
  delegationActive: false,
  stageResults: {},
  retries: {},
  currentStage: null,
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
  // 開始委派
  state.currentStage = stage;
  state.delegationActive = true;
  state.lastTransition = new Date().toISOString();
  save();
  console.log(`  🔄 ${stage} — ${STAGE_AGENTS[stage]} 工作中...`);

  await sleep(durationMs);

  // 完成
  state.delegationActive = false;
  state.stageResults[stage] = { verdict, severity };
  if (!state.completed.includes(STAGE_AGENTS[stage])) {
    state.completed.push(STAGE_AGENTS[stage]);
  }
  state.lastTransition = new Date().toISOString();
  save();

  const icon = verdict === 'PASS' ? '✅' : '❌';
  console.log(`  ${icon} ${stage} — ${verdict}${severity ? ` (${severity})` : ''}`);
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
  console.log('  ⏳ 30 秒後自動清理（Ctrl+C 提早結束）');
  await sleep(30000);

  unlinkSync(fp);
  console.log('  🗑️  State 檔案已清理\n');
}

run().catch(console.error);
