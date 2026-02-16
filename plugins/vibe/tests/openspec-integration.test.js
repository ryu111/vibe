#!/usr/bin/env node
/**
 * openspec-integration.test.js — OpenSpec 整合測試
 *
 * 測試重點：
 * 1. pipeline-init.js 偵測 openspec/ 目錄設 openspecEnabled
 * 2. stage-transition.js 注入 OpenSpec 上下文提示（ARCH/DEV/REVIEW/TEST/DOCS 5 階段）
 * 3. Agent 定義驗證：planner/architect/developer/doc-updater/QA/code-reviewer/tester
 *
 * 執行：bun test plugins/vibe/tests/openspec-integration.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;

let passed = 0;
let failed = 0;
require('./test-helpers').cleanTestStateFiles();

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

// ─── 輔助 ─────────────────────────────

function runHook(hookName, stdinData) {
  const hookPath = path.join(PLUGIN_ROOT, 'scripts', 'hooks', `${hookName}.js`);
  const result = execSync(`node "${hookPath}"`, {
    input: JSON.stringify(stdinData),
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
  });
  return result.toString().trim();
}

function createTempState(sessionId, state) {
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

function readState(sessionId) {
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 1: pipeline-init OpenSpec 偵測');
// ═══════════════════════════════════════════════

test('pipeline-init 偵測 openspec/ 目錄存在時設 openspecEnabled=true', () => {
  const sessionId = 'test-openspec-init-enabled';
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  cleanup(statePath);

  // vibe 專案根目錄有 openspec/config.yaml
  const cwd = path.join(PLUGIN_ROOT, '..', '..');
  const output = runHook('pipeline-init', {
    session_id: sessionId,
    cwd,
  });

  const state = readState(sessionId);
  assert.strictEqual(state.context.openspecEnabled, true, 'openspecEnabled 應為 true');
  assert.strictEqual(state.meta.initialized, true, 'initialized 應為 true');
  cleanup(statePath);
});

test('pipeline-init 偵測 openspec/ 不存在時設 openspecEnabled=false', () => {
  const sessionId = 'test-openspec-init-disabled';
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  cleanup(statePath);

  // 用 /tmp 作為沒有 openspec/ 的目錄
  const output = runHook('pipeline-init', {
    session_id: sessionId,
    cwd: os.tmpdir(),
  });

  const state = readState(sessionId);
  assert.strictEqual(state.context.openspecEnabled, false, 'openspecEnabled 應為 false');
  cleanup(statePath);
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 2: stage-transition OpenSpec 上下文注入');
// ═══════════════════════════════════════════════

test('PLAN→ARCH 轉場注入 OpenSpec 提示（openspecEnabled=true）', () => {
  const sessionId = 'test-openspec-plan-to-arch';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'PLAN',
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'planner',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    parsed.systemMessage.includes('OpenSpec'),
    'systemMessage 應包含 OpenSpec 提示'
  );
  assert.ok(
    parsed.systemMessage.includes('proposal'),
    'systemMessage 應提及 proposal'
  );
  cleanup(statePath);
});

test('ARCH→DEV 轉場注入 OpenSpec 提示（openspecEnabled=true）', () => {
  const sessionId = 'test-openspec-arch-to-dev';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'ARCH',
      stageIndex: 1,
      completedAgents: ['planner'],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'architect',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    parsed.systemMessage.includes('OpenSpec'),
    'systemMessage 應包含 OpenSpec 提示'
  );
  assert.ok(
    parsed.systemMessage.includes('tasks.md'),
    'systemMessage 應提及 tasks.md'
  );
  cleanup(statePath);
});

test('PLAN→ARCH 轉場無 OpenSpec 提示（openspecEnabled=false）', () => {
  const sessionId = 'test-openspec-disabled-transition';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: false,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'PLAN',
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'planner',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    !parsed.systemMessage.includes('OpenSpec'),
    'openspecEnabled=false 時 systemMessage 不應包含 OpenSpec 提示'
  );
  cleanup(statePath);
});

test('DEV→REVIEW 轉場注入 OpenSpec 規格對照提示', () => {
  const sessionId = 'test-openspec-dev-to-review';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'DEV',
      stageIndex: 3,
      completedAgents: ['planner', 'architect'],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'developer',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    parsed.systemMessage.includes('OpenSpec'),
    'REVIEW 轉場應包含 OpenSpec 提示'
  );
  assert.ok(
    parsed.systemMessage.includes('specs/') && parsed.systemMessage.includes('design.md'),
    'REVIEW 轉場應提及 specs/ 和 design.md'
  );
  cleanup(statePath);
});

test('REVIEW→TEST 轉場注入 OpenSpec Scenario 測試提示', () => {
  const sessionId = 'test-openspec-review-to-test';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'REVIEW',
      stageIndex: 4,
      completedAgents: ['planner', 'architect', 'developer'],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'code-reviewer',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    parsed.systemMessage.includes('OpenSpec'),
    'TEST 轉場應包含 OpenSpec 提示'
  );
  assert.ok(
    parsed.systemMessage.includes('WHEN/THEN'),
    'TEST 轉場應提及 WHEN/THEN 轉換'
  );
  cleanup(statePath);
});

test('TEST→QA 轉場無 OpenSpec 提示（QA 無 OpenSpec 指引）', () => {
  const sessionId = 'test-openspec-test-to-qa';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'TEST',
      stageIndex: 5,
      completedAgents: ['planner', 'architect', 'developer', 'code-reviewer'],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'tester',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    !parsed.systemMessage.includes('OpenSpec'),
    'TEST→QA 轉場不應有 OpenSpec 提示'
  );
  cleanup(statePath);
});

test('QA→E2E→DOCS 轉場注入 OpenSpec 歸檔提示', () => {
  const sessionId = 'test-openspec-to-docs';
  const statePath = createTempState(sessionId, {
    sessionId,
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      openspecEnabled: true,
      environment: {},
      needsDesign: false,
      pipelineRules: [],
    },
    progress: {
      currentStage: 'E2E',
      stageIndex: 7,
      completedAgents: ['planner', 'architect', 'developer', 'code-reviewer', 'tester', 'qa', 'e2e-runner'],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      classifiedAt: new Date().toISOString(),
      lastTransition: new Date().toISOString(),
      classificationSource: null,
      classificationConfidence: null,
      matchedRule: null,
      layer: null,
      reclassifications: [],
      llmClassification: null,
      correctionCount: 0,
      cancelled: false,
    },
  });

  const output = runHook('stage-transition', {
    session_id: sessionId,
    agent_type: 'e2e-runner',
    stop_hook_active: false,
  });

  const parsed = JSON.parse(output);
  assert.ok(parsed.systemMessage, '應有 systemMessage');
  assert.ok(
    parsed.systemMessage.includes('OpenSpec'),
    'DOCS 轉場應包含 OpenSpec 歸檔提示'
  );
  assert.ok(
    parsed.systemMessage.includes('archive'),
    'DOCS 轉場應提及 archive'
  );
  cleanup(statePath);
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 3: OpenSpec 目錄結構驗證');
// ═══════════════════════════════════════════════

const PROJECT_ROOT = path.join(PLUGIN_ROOT, '..', '..');

test('openspec/config.yaml 存在且包含 schema 欄位', () => {
  const configPath = path.join(PROJECT_ROOT, 'openspec', 'config.yaml');
  assert.ok(fs.existsSync(configPath), 'config.yaml 應存在');
  const content = fs.readFileSync(configPath, 'utf8');
  assert.ok(content.includes('schema: vibe-pipeline'), '應包含 schema: vibe-pipeline');
  assert.ok(content.includes('context:'), '應包含 context 區塊');
  assert.ok(content.includes('rules:'), '應包含 rules 區塊');
});

test('openspec/schemas/vibe-pipeline/schema.yaml 存在且定義 6 個 artifacts', () => {
  const schemaPath = path.join(PROJECT_ROOT, 'openspec', 'schemas', 'vibe-pipeline', 'schema.yaml');
  assert.ok(fs.existsSync(schemaPath), 'schema.yaml 應存在');
  const content = fs.readFileSync(schemaPath, 'utf8');
  assert.ok(content.includes('id: proposal'), '應定義 proposal artifact');
  assert.ok(content.includes('id: specs'), '應定義 specs artifact');
  assert.ok(content.includes('id: design'), '應定義 design artifact');
  assert.ok(content.includes('id: design-system'), '應定義 design-system artifact');
  assert.ok(content.includes('id: design-mockup'), '應定義 design-mockup artifact');
  assert.ok(content.includes('id: tasks'), '應定義 tasks artifact');
});

test('openspec/specs/ 目錄存在', () => {
  const specsDir = path.join(PROJECT_ROOT, 'openspec', 'specs');
  assert.ok(fs.existsSync(specsDir), 'specs/ 目錄應存在');
});

test('openspec/changes/ 目錄存在', () => {
  const changesDir = path.join(PROJECT_ROOT, 'openspec', 'changes');
  assert.ok(fs.existsSync(changesDir), 'changes/ 目錄應存在');
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 4: Agent 定義驗證');
// ═══════════════════════════════════════════════

test('planner agent 包含 Write 工具和 acceptEdits 權限', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'planner.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('tools: Read, Write, Grep, Glob'), 'planner 應有 Write 工具');
  assert.ok(content.includes('permissionMode: acceptEdits'), 'planner 應為 acceptEdits 權限');
  assert.ok(content.includes('proposal.md'), 'planner 應提及 proposal.md');
  assert.ok(content.includes('openspec/changes/'), 'planner 應提及 openspec/changes/');
});

test('architect agent 包含 Write 工具和 acceptEdits 權限', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'architect.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('tools: Read, Write, Grep, Glob'), 'architect 應有 Write 工具');
  assert.ok(content.includes('permissionMode: acceptEdits'), 'architect 應為 acceptEdits 權限');
  assert.ok(content.includes('design.md'), 'architect 應提及 design.md');
  assert.ok(content.includes('tasks.md'), 'architect 應提及 tasks.md');
  assert.ok(content.includes('Delta Spec'), 'architect 應提及 Delta Spec');
});

test('developer agent 包含 OpenSpec 任務追蹤指引', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'developer.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('OpenSpec 任務追蹤'), 'developer 應有 OpenSpec 任務追蹤區塊');
  assert.ok(content.includes('tasks.md'), 'developer 應提及 tasks.md');
  assert.ok(content.includes('- [ ]'), 'developer 應提及 checkbox 格式');
});

test('doc-updater agent 包含 OpenSpec 歸檔指引', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'doc-updater.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('OpenSpec 歸檔'), 'doc-updater 應有 OpenSpec 歸檔區塊');
  assert.ok(content.includes('archive/'), 'doc-updater 應提及 archive/');
  assert.ok(content.includes('delta specs'), 'doc-updater 應提及 delta specs');
});

test('QA agent 包含三維驗證模型', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'qa.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('完整性（Completeness）'), 'QA 應有完整性維度');
  assert.ok(content.includes('正確性（Correctness）'), 'QA 應有正確性維度');
  assert.ok(content.includes('一致性（Coherence）'), 'QA 應有一致性維度');
  assert.ok(content.includes('CRITICAL'), 'QA 應有問題分級');
});

test('code-reviewer agent 包含 OpenSpec 規格對照審查', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'code-reviewer.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('OpenSpec 規格對照審查'), 'code-reviewer 應有 OpenSpec 規格對照區塊');
  assert.ok(content.includes('規格一致性'), 'code-reviewer 應有規格一致性維度');
  assert.ok(content.includes('WHEN/THEN'), 'code-reviewer 應提及 WHEN/THEN 驗證');
  assert.ok(content.includes('openspec/changes/'), 'code-reviewer 應提及 openspec/changes/');
});

test('tester agent 包含 OpenSpec 規格驅動測試產生', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'tester.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('從規格推導測試'), 'tester 應有規格推導測試區塊');
  assert.ok(content.includes('WHEN/THEN'), 'tester 應提及 WHEN/THEN 轉換');
  assert.ok(content.includes('ADDED'), 'tester 應提及 ADDED Requirements');
  assert.ok(content.includes('REMOVED'), 'tester 應提及 REMOVED Requirements');
});

test('security-reviewer agent 包含 OpenSpec 安全規格對照', () => {
  const agentPath = path.join(PLUGIN_ROOT, 'agents', 'security-reviewer.md');
  const content = fs.readFileSync(agentPath, 'utf8');
  assert.ok(content.includes('OpenSpec 安全規格對照'), 'security-reviewer 應有 OpenSpec 安全規格區塊');
  assert.ok(content.includes('認證/授權'), 'security-reviewer 應提及認證/授權架構');
  assert.ok(content.includes('openspec/changes/'), 'security-reviewer 應提及 openspec/changes/');
  assert.ok(content.includes('遺漏的安全需求'), 'security-reviewer 應檢查遺漏的安全需求');
});

// ─── 結果 ─────────────────────────────
console.log(`\n📊 結果：${passed} 通過，${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
