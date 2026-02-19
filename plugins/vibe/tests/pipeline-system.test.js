#!/usr/bin/env node
/**
 * pipeline-system.test.js — Pipeline 系統整合測試
 *
 * 測試重點：
 * 1. pipeline-discovery.js 雙格式 agent 映射（短名 + namespaced）
 * 2. stage-transition.js namespaced 輸出（前進 + 回退場景）
 * 3. pipeline-check.js namespaced 提示（遺漏階段檢查）
 *
 * 執行：bun test plugins/vibe/tests/pipeline-system.test.js
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

function createTempState(sessionId, state) {
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

function createTempTranscript(sessionId, entries) {
  const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n'));
  return transcriptPath;
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 1: pipeline-discovery 雙格式 agent 映射');
// ═══════════════════════════════════════════════

const { discoverPipeline } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'pipeline-discovery.js'));

test('agentToStage 包含 9 個短名稱映射', () => {
  const pipeline = discoverPipeline();
  const shortNames = ['planner', 'architect', 'designer', 'developer', 'code-reviewer', 'tester', 'qa', 'e2e-runner', 'doc-updater'];
  const expectedMappings = {
    'planner': 'PLAN',
    'architect': 'ARCH',
    'designer': 'DESIGN',
    'developer': 'DEV',
    'code-reviewer': 'REVIEW',
    'tester': 'TEST',
    'qa': 'QA',
    'e2e-runner': 'E2E',
    'doc-updater': 'DOCS',
  };

  for (const shortName of shortNames) {
    assert.ok(pipeline.agentToStage[shortName], `缺少短名稱映射: ${shortName}`);
    assert.strictEqual(
      pipeline.agentToStage[shortName],
      expectedMappings[shortName],
      `短名稱 ${shortName} 映射錯誤`
    );
  }
});

test('agentToStage 包含 9 個 namespaced 映射', () => {
  const pipeline = discoverPipeline();
  const namespacedNames = [
    'vibe:planner', 'vibe:architect', 'vibe:designer', 'vibe:developer', 'vibe:code-reviewer',
    'vibe:tester', 'vibe:qa', 'vibe:e2e-runner', 'vibe:doc-updater'
  ];
  const expectedMappings = {
    'vibe:planner': 'PLAN',
    'vibe:architect': 'ARCH',
    'vibe:designer': 'DESIGN',
    'vibe:developer': 'DEV',
    'vibe:code-reviewer': 'REVIEW',
    'vibe:tester': 'TEST',
    'vibe:qa': 'QA',
    'vibe:e2e-runner': 'E2E',
    'vibe:doc-updater': 'DOCS',
  };

  for (const namespacedName of namespacedNames) {
    assert.ok(pipeline.agentToStage[namespacedName], `缺少 namespaced 映射: ${namespacedName}`);
    assert.strictEqual(
      pipeline.agentToStage[namespacedName],
      expectedMappings[namespacedName],
      `namespaced ${namespacedName} 映射錯誤`
    );
  }
});

test('agentToStage 總數 = 18（9 短 + 9 namespaced）', () => {
  const pipeline = discoverPipeline();
  const count = Object.keys(pipeline.agentToStage).length;
  assert.strictEqual(count, 18, `agentToStage 應有 18 個映射，實際有 ${count} 個`);
});

test('stageMap 中每個 stage 的 plugin 欄位 = "vibe"', () => {
  const pipeline = discoverPipeline();
  const stages = ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];
  for (const stage of stages) {
    assert.ok(pipeline.stageMap[stage], `缺少 stage: ${stage}`);
    assert.strictEqual(
      pipeline.stageMap[stage].plugin,
      'vibe',
      `${stage} 的 plugin 應該是 "vibe"`
    );
  }
});

test('stageOrder 包含 9 個 stage 且順序正確', () => {
  const pipeline = discoverPipeline();
  const expected = ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];
  assert.deepStrictEqual(
    pipeline.stageOrder,
    expected,
    'stageOrder 順序不正確'
  );
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 2: stage-transition namespaced 輸出');
// ═══════════════════════════════════════════════

test('前進場景：PLAN → ARCH（有 skill 的階段）', () => {
  const sessionId = 'test-ns-1';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: [],
      stageResults: {},
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  try {
    const stdinData = {
      agent_type: 'vibe:planner',
      session_id: sessionId,
      stop_hook_active: false,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應該有 systemMessage');
    // ARCH 有 skill /vibe:architect，應該使用 Skill 工具
    assert.ok(
      output.systemMessage.includes('/vibe:architect'),
      'systemMessage 應包含 /vibe:architect skill'
    );
    assert.ok(
      output.systemMessage.includes('執行') || output.systemMessage.includes('委派'),
      'systemMessage 應包含執行或委派指示'
    );
  } finally {
    cleanup(statePath);
  }
});

test('前進場景：ARCH → DEV（Skill 委派）', () => {
  const sessionId = 'test-ns-1b';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner'],
      stageResults: { PLAN: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  try {
    const stdinData = {
      agent_type: 'vibe:architect',
      session_id: sessionId,
      stop_hook_active: false,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應該有 systemMessage');
    // DEV 有 skill /vibe:dev，應該使用 Skill 委派
    assert.ok(
      output.systemMessage.includes('/vibe:dev'),
      'systemMessage 應包含 /vibe:dev skill'
    );
    assert.ok(
      output.systemMessage.includes('執行') || output.systemMessage.includes('委派'),
      'systemMessage 應包含執行或委派指示'
    );
  } finally {
    cleanup(statePath);
  }
});

test('回退場景：REVIEW FAIL:HIGH → DEV（namespaced 格式）', () => {
  const sessionId = 'test-ns-2';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
      stageResults: {
        PLAN: { verdict: 'PASS' },
        ARCH: { verdict: 'PASS' },
        DEV: { verdict: 'PASS' },
      },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  const transcriptPath = createTempTranscript(sessionId, [
    {
      type: 'assistant',
      content: [
        { type: 'text', text: '發現嚴重問題 <!-- PIPELINE_VERDICT: FAIL:HIGH -->' }
      ]
    }
  ]);

  try {
    const stdinData = {
      agent_type: 'vibe:code-reviewer',
      session_id: sessionId,
      stop_hook_active: false,
      agent_transcript_path: transcriptPath,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應該有 systemMessage');
    // 回退到 DEV 使用 Skill 委派
    assert.ok(
      output.systemMessage.includes('/vibe:dev'),
      'systemMessage 應包含 /vibe:dev skill（回退）'
    );
    assert.ok(
      output.systemMessage.includes('執行') || output.systemMessage.includes('委派'),
      'systemMessage 應包含執行或委派指示'
    );
    assert.ok(
      output.systemMessage.includes('🔄'),
      'systemMessage 應包含回退標記 🔄'
    );
  } finally {
    cleanup(statePath, transcriptPath);
  }
});

test('回退場景：修復後重新執行 REVIEW（namespaced 格式）', () => {
  const sessionId = 'test-ns-3';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
      stageResults: {
        PLAN: { verdict: 'PASS' },
        ARCH: { verdict: 'PASS' },
        DEV: { verdict: 'PASS' },
      },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  const transcriptPath = createTempTranscript(sessionId, [
    {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Critical issue <!-- PIPELINE_VERDICT: FAIL:CRITICAL -->' }
      ]
    }
  ]);

  try {
    const stdinData = {
      agent_type: 'vibe:code-reviewer',
      session_id: sessionId,
      stop_hook_active: false,
      agent_transcript_path: transcriptPath,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應該有 systemMessage');
    // 回退修復後使用 Skill 委派 DEV
    assert.ok(
      output.systemMessage.includes('/vibe:dev') || output.systemMessage.includes('/vibe:review'),
      'systemMessage 應包含 /vibe:dev 或 /vibe:review skill（回退修復）'
    );
    assert.ok(
      output.systemMessage.includes('REVIEW'),
      'systemMessage 應提及 REVIEW（重跑目標階段）'
    );
  } finally {
    cleanup(statePath, transcriptPath);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 3: pipeline-check namespaced 提示');
// ═══════════════════════════════════════════════

test('缺漏 ARCH 和 DEV 階段（混合格式）', () => {
  const sessionId = 'test-ns-4';
  const statePath = createTempState(sessionId, {
    phase: 'CLASSIFIED',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner'],
      stageResults: { PLAN: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pipeline-check.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    // v4: pipeline-check 使用 decision:"block" + reason 格式
    assert.strictEqual(output.decision, 'block', '應有 decision: block');
    assert.ok(output.reason, '應有 reason 說明遺漏階段');
  } finally {
    cleanup(statePath);
  }
});

test('全部完成：無輸出且 state 保留', () => {
  const sessionId = 'test-ns-5';
  const statePath = createTempState(sessionId, {
    phase: 'COMPLETE',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 5, // DOCS 是 standard pipeline 的最後一個階段（index 5）
      completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer', 'vibe:code-reviewer', 'vibe:tester', 'vibe:doc-updater'],
      stageResults: {
        PLAN: { verdict: 'PASS' },
        ARCH: { verdict: 'PASS' },
        DEV: { verdict: 'PASS' },
        REVIEW: { verdict: 'PASS' },
        TEST: { verdict: 'PASS' },
        DOCS: { verdict: 'PASS' },
      },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
    };

    let result;
    try {
      result = execSync(
        `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pipeline-check.js')}"`,
        {
          input: JSON.stringify(stdinData),
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
        }
      );
    } catch (err) {
      // exit 0 且無輸出
      result = '';
    }

    // 應該沒有輸出
    assert.strictEqual(result.trim(), '', '全部完成時應該無輸出');

    // State file 應保留（pipeline-check 不再刪除，由 session-cleanup 過期清理）
    assert.ok(
      fs.existsSync(statePath),
      'State file 應保留供 Dashboard/驗證/分析'
    );
  } finally {
    cleanup(statePath);
  }
});

test('非強制 pipeline：不檢查', () => {
  const sessionId = 'test-ns-6';
  const statePath = createTempState(sessionId, {
    phase: 'IDLE', // 非強制
    context: {
      pipelineId: null,
      taskType: 'bugfix',
      expectedStages: ['PLAN', 'ARCH', 'DEV'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner'],
      stageResults: { PLAN: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
    };

    let result;
    try {
      result = execSync(
        `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pipeline-check.js')}"`,
        {
          input: JSON.stringify(stdinData),
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
        }
      );
    } catch (err) {
      result = '';
    }

    // 非強制 pipeline 不應該檢查
    assert.strictEqual(result.trim(), '', '非強制 pipeline 不應該檢查');
  } finally {
    cleanup(statePath);
  }
});

// ═══════════════════════════════════════════════
// DESIGN 跳過邏輯測試
// ═══════════════════════════════════════════════

test('ARCH→DESIGN 前進：前端框架不跳過 DESIGN', () => {
  const sessionId = `pipeline-test-design-frontend-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      environment: { framework: { name: 'react' } },
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: 'ARCH',
      stageIndex: 1, // ARCH 在 full pipeline 的 index
      completedAgents: ['vibe:planner'], // stage-transition.js 依賴 completedAgents (agentType 列表)
      stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  const transcriptPath = createTempTranscript(sessionId, [
    { role: 'user', type: 'agent_stop', subagent_type: 'vibe:architect' },
  ]);

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
      agent_type: 'vibe:architect',
      agent_transcript_path: transcriptPath,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應有 systemMessage');
    assert.ok(output.systemMessage.includes('→ DESIGN'), '應進入 DESIGN 階段');
    assert.ok(!output.systemMessage.includes('→ DEV'), '不應跳過 DESIGN 直接進 DEV');

    // 檢查 state file
    const updatedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const skipped = updatedState.progress?.skippedStages || [];
    assert.ok(!skipped.includes('DESIGN'),
      '前端框架不應跳過 DESIGN');
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('ARCH→DESIGN 前進：後端框架跳過 DESIGN', () => {
  const sessionId = `pipeline-test-design-backend-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      environment: { framework: { name: 'express' } },
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: 'ARCH',
      stageIndex: 1, // ARCH 在 full pipeline 的 index
      completedAgents: ['vibe:planner'], // stage-transition.js 依賴 completedAgents (agentType 列表)
      stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  const transcriptPath = createTempTranscript(sessionId, [
    { role: 'user', type: 'agent_stop', subagent_type: 'vibe:architect' },
  ]);

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
      agent_type: 'vibe:architect',
      agent_transcript_path: transcriptPath,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應有 systemMessage');
    assert.ok(output.systemMessage.includes('→ DEV'), '後端框架應跳過 DESIGN 進入 DEV');

    // v3：檢查 DESIGN stage status === 'skipped'
    const updatedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(
      updatedState.stages?.DESIGN?.status === 'skipped',
      'DESIGN stage 應被 skipped'
    );
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('ARCH→DESIGN 前進：needsDesign=true 強制不跳過', () => {
  const sessionId = `pipeline-test-design-forced-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'full',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
      environment: { framework: { name: 'express' } }, // 後端框架
      openspecEnabled: false,
      needsDesign: true, // 強制需要設計
    },
    progress: {
      currentStage: 'ARCH',
      stageIndex: 1, // ARCH 在 full pipeline 的 index
      completedAgents: ['vibe:planner'], // stage-transition.js 依賴 completedAgents (agentType 列表)
      stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
      retries: {},
      skippedStages: [],
      pendingRetry: null,
    },
    meta: {
      initialized: true,
      lastTransition: new Date().toISOString(),
    },
  });

  const transcriptPath = createTempTranscript(sessionId, [
    { role: 'user', type: 'agent_stop', subagent_type: 'vibe:architect' },
  ]);

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
      agent_type: 'vibe:architect',
      agent_transcript_path: transcriptPath,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'stage-transition.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    const output = JSON.parse(result);
    assert.ok(output.systemMessage, '應有 systemMessage');
    assert.ok(output.systemMessage.includes('→ DESIGN'), 'needsDesign=true 應進入 DESIGN');

    // 檢查 state file
    const updatedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // v3: 檢查 stages 物件中 DESIGN 的狀態
    assert.ok(updatedState.stages?.DESIGN?.status !== 'skipped',
      'needsDesign=true 不應跳過 DESIGN');
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('pipeline-check 排除 skipped stages', () => {
  const sessionId = `pipeline-test-skip-check-${Date.now()}`;
  const { writeV3State } = require('./test-helpers');
  // v3: DESIGN 和 E2E 跳過，其餘全部完成
  const statePath = writeV3State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    completed: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA', 'DOCS'],
    skipped: ['DESIGN', 'E2E'],
    pipelineId: 'full',
    taskType: 'feature',
    enforced: true,
  });

  try {
    const stdinData = {
      session_id: sessionId,
      stop_hook_active: false,
    };

    const result = execSync(
      `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pipeline-check.js')}"`,
      {
        input: JSON.stringify(stdinData),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      }
    );

    // 跳過的階段不應被視為遺漏（COMPLETE 狀態 → 正常退出）
    assert.strictEqual(result.trim(), '', 'skipped stages 不應被視為遺漏');
  } finally {
    cleanup(statePath);
  }
});

// ═══════════════════════════════════════════════
// 清理 + 結果
// ═══════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 全部通過\n');
}
