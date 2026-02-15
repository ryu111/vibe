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
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV'],
    completed: [],
    stageResults: {},
    retries: {},
    delegationActive: true,
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
      output.systemMessage.includes('使用 Skill 工具呼叫'),
      'systemMessage 應包含 Skill 工具呼叫指示'
    );
  } finally {
    cleanup(statePath);
  }
});

test('前進場景：ARCH → DEV（無 skill 的階段，Task 委派）', () => {
  const sessionId = 'test-ns-1b';
  const statePath = createTempState(sessionId, {
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV'],
    completed: ['vibe:planner'],
    stageResults: { PLAN: { verdict: 'PASS' } },
    retries: {},
    delegationActive: true,
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
    // DEV 沒有 skill，應該使用 Task 委派
    assert.ok(
      output.systemMessage.includes('vibe:developer'),
      'systemMessage 應包含 vibe:developer'
    );
    assert.ok(
      output.systemMessage.includes('subagent_type: "vibe:developer"'),
      'systemMessage 應包含 subagent_type: "vibe:developer"'
    );
    assert.ok(
      output.systemMessage.includes('使用 Task 工具委派'),
      'systemMessage 應包含 Task 工具委派指示'
    );
  } finally {
    cleanup(statePath);
  }
});

test('回退場景：REVIEW FAIL:HIGH → DEV（namespaced 格式）', () => {
  const sessionId = 'test-ns-2';
  const statePath = createTempState(sessionId, {
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    completed: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
    stageResults: {
      PLAN: { verdict: 'PASS' },
      ARCH: { verdict: 'PASS' },
      DEV: { verdict: 'PASS' },
    },
    retries: {},
    delegationActive: true,
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
    assert.ok(
      output.systemMessage.includes('vibe:developer'),
      'systemMessage 應包含 vibe:developer（回退）'
    );
    assert.ok(
      output.systemMessage.includes('subagent_type: "vibe:developer"'),
      'systemMessage 應包含 subagent_type: "vibe:developer"'
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
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    completed: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
    stageResults: {
      PLAN: { verdict: 'PASS' },
      ARCH: { verdict: 'PASS' },
      DEV: { verdict: 'PASS' },
    },
    retries: {},
    delegationActive: true,
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
    // 精簡後回退訊息只包含 DEV method + 告知 stage-transition 會指示重跑
    assert.ok(
      output.systemMessage.includes('vibe:developer'),
      'systemMessage 應包含 vibe:developer（回退修復）'
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
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV'],
    completed: ['vibe:planner'],
    stageResults: { PLAN: { verdict: 'PASS' } },
    retries: {},
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
    assert.ok(output.systemMessage, '應該有 systemMessage');

    // ARCH 有 skill，應該顯示 skill 名稱
    assert.ok(
      output.systemMessage.includes('/vibe:architect'),
      'systemMessage 應包含 /vibe:architect skill'
    );

    // DEV 沒有 skill，應該顯示 Task 委派格式
    assert.ok(
      output.systemMessage.includes('vibe:developer'),
      'systemMessage 應包含 vibe:developer'
    );
    assert.ok(
      output.systemMessage.includes('subagent_type: "vibe:developer"'),
      'systemMessage 應包含 subagent_type: "vibe:developer"'
    );
  } finally {
    cleanup(statePath);
  }
});

test('全部完成：無輸出且刪除 state file', () => {
  const sessionId = 'test-ns-5';
  const statePath = createTempState(sessionId, {
    initialized: true,
    pipelineId: 'standard',
    taskType: 'feature',
    pipelineEnforced: true,
    expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'DOCS'],
    completed: ['vibe:planner', 'vibe:architect', 'vibe:developer', 'vibe:code-reviewer', 'vibe:tester', 'vibe:doc-updater'],
    stageIndex: 5, // DOCS 是 standard pipeline 的最後一個階段（index 5）
    stageResults: {
      PLAN: { verdict: 'PASS' },
      ARCH: { verdict: 'PASS' },
      DEV: { verdict: 'PASS' },
      REVIEW: { verdict: 'PASS' },
      TEST: { verdict: 'PASS' },
      DOCS: { verdict: 'PASS' },
    },
    retries: {},
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

    // State file 應該被刪除
    assert.ok(
      !fs.existsSync(statePath),
      'State file 應該被刪除'
    );
  } finally {
    cleanup(statePath);
  }
});

test('非強制 pipeline：不檢查', () => {
  const sessionId = 'test-ns-6';
  const statePath = createTempState(sessionId, {
    initialized: true,
    taskType: 'bugfix',
    pipelineEnforced: false, // 非強制
    expectedStages: ['PLAN', 'ARCH', 'DEV'],
    completed: ['vibe:planner'],
    stageResults: { PLAN: { verdict: 'PASS' } },
    retries: {},
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
    pipelineId: 'full',
    pipelineEnforced: true,
    taskType: 'feature',
    expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    completed: ['vibe:planner'], // stage-transition.js 依賴 completed (agentType 列表)
    currentStage: 'ARCH',
    stageIndex: 1, // ARCH 在 full pipeline 的 index
    environment: { framework: { name: 'react' } },
    stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
    retries: {},
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
    assert.ok(!updatedState.skippedStages || !updatedState.skippedStages.includes('DESIGN'),
      '前端框架不應跳過 DESIGN');
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('ARCH→DESIGN 前進：後端框架跳過 DESIGN', () => {
  const sessionId = `pipeline-test-design-backend-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    pipelineId: 'full',
    pipelineEnforced: true,
    taskType: 'feature',
    expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    completed: ['vibe:planner'], // stage-transition.js 依賴 completed (agentType 列表)
    currentStage: 'ARCH',
    stageIndex: 1, // ARCH 在 full pipeline 的 index
    environment: { framework: { name: 'express' } },
    stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
    retries: {},
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

    // 檢查 state file
    const updatedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(updatedState.skippedStages && updatedState.skippedStages.includes('DESIGN'),
      'skippedStages 應包含 DESIGN');
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('ARCH→DESIGN 前進：needsDesign=true 強制不跳過', () => {
  const sessionId = `pipeline-test-design-forced-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    pipelineId: 'full',
    pipelineEnforced: true,
    taskType: 'feature',
    expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    completed: ['vibe:planner'], // stage-transition.js 依賴 completed (agentType 列表)
    currentStage: 'ARCH',
    stageIndex: 1, // ARCH 在 full pipeline 的 index
    environment: { framework: { name: 'express' } }, // 後端框架
    needsDesign: true, // 強制需要設計
    stageResults: { PLAN: { verdict: 'PASS' }, ARCH: { verdict: 'PASS' } },
    retries: {},
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
    assert.ok(!updatedState.skippedStages || !updatedState.skippedStages.includes('DESIGN'),
      'needsDesign=true 不應跳過 DESIGN');
  } finally {
    cleanup(statePath);
    cleanup(transcriptPath);
  }
});

test('pipeline-check 排除 skippedStages 中的 DESIGN', () => {
  const sessionId = `pipeline-test-skip-check-${Date.now()}`;
  const statePath = createTempState(sessionId, {
    pipelineEnforced: true,
    taskType: 'feature',
    expectedStages: ['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'],
    completed: ['vibe:planner', 'vibe:architect', 'vibe:developer', 'vibe:code-reviewer', 'vibe:tester', 'vibe:qa', 'vibe:doc-updater'],
    currentStage: 'DOCS',
    skippedStages: ['DESIGN', 'E2E'], // 跳過了 DESIGN 和 E2E
    stageResults: {
      PLAN: { verdict: 'PASS' },
      ARCH: { verdict: 'PASS' },
      DEV: { verdict: 'PASS' },
      REVIEW: { verdict: 'PASS' },
      TEST: { verdict: 'PASS' },
      QA: { verdict: 'PASS' },
      DOCS: { verdict: 'PASS' },
    },
    retries: {},
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

    // 跳過的階段不應被視為遺漏（應該清理 state 並 exit 0）
    assert.strictEqual(result.trim(), '', 'skippedStages 中的階段不應被視為遺漏');
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
