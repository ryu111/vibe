#!/usr/bin/env node
/**
 * automation-features.test.js — v1.0.21 Skills 全自動化測試
 *
 * 測試重點：
 * 1. autoCheckpoint — git tag 建立
 * 2. POST_STAGE_HINTS — REVIEW→security / TEST→coverage 提示
 * 3. buildKnowledgeHints — env-detect 語言/框架映射知識 skills
 * 4. Pipeline 完成三步閉環 — verify + 報告 + AskUserQuestion
 *
 * 執行：node plugins/vibe/tests/automation-features.test.js
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

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

function runHook(hookName, stdinData) {
  return execSync(
    `node "${path.join(PLUGIN_ROOT, 'scripts', 'hooks', hookName)}"`,
    {
      input: JSON.stringify(stdinData),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    }
  );
}

function cleanupGitTag(tagName) {
  try { execSync(`git tag -d "${tagName}" 2>/dev/null`, { stdio: 'pipe' }); } catch (_) {}
}

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 1: autoCheckpoint — git tag 建立');
// ═══════════════════════════════════════════════

test('PLAN 完成後建立 vibe-pipeline/plan tag', () => {
  const sessionId = 'test-auto-ckpt-1';
  const tagName = 'vibe-pipeline/plan';
  cleanupGitTag(tagName);

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
    runHook('stage-transition.js', {
      agent_type: 'vibe:planner',
      session_id: sessionId,
      stop_hook_active: false,
    });

    // 驗證 git tag 存在
    const tagExists = execSync(`git tag -l "${tagName}"`, { encoding: 'utf8' }).trim();
    assert.strictEqual(tagExists, tagName, `應建立 ${tagName} tag`);
  } finally {
    cleanup(statePath);
    cleanupGitTag(tagName);
  }
});

test('回退場景不建立 checkpoint（shouldRetry=true）', () => {
  const sessionId = 'test-auto-ckpt-2';
  const tagName = 'vibe-pipeline/review';
  cleanupGitTag(tagName);

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

  // 建立 FAIL transcript
  const transcriptPath = path.join(CLAUDE_DIR, `test-transcript-${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    content: [{ type: 'text', text: '<!-- PIPELINE_VERDICT: FAIL:HIGH -->' }],
  }));

  try {
    runHook('stage-transition.js', {
      agent_type: 'vibe:code-reviewer',
      session_id: sessionId,
      stop_hook_active: false,
      agent_transcript_path: transcriptPath,
    });

    // 回退時不應建立 tag
    const tagExists = execSync(`git tag -l "${tagName}"`, { encoding: 'utf8' }).trim();
    assert.strictEqual(tagExists, '', '回退場景不應建立 checkpoint tag');
  } finally {
    cleanup(statePath, transcriptPath);
    cleanupGitTag(tagName);
  }
});

test('多個階段完成後各自有 tag', () => {
  const sessionId = 'test-auto-ckpt-3';
  const tags = ['vibe-pipeline/plan', 'vibe-pipeline/arch'];
  tags.forEach(cleanupGitTag);

  // PLAN 完成
  let statePath = createTempState(sessionId, {
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
    runHook('stage-transition.js', {
      agent_type: 'vibe:planner',
      session_id: sessionId,
      stop_hook_active: false,
    });

    // ARCH 完成
    statePath = createTempState(sessionId, {
      phase: 'DELEGATING',
      context: {
        pipelineId: null,
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

    runHook('stage-transition.js', {
      agent_type: 'vibe:architect',
      session_id: sessionId,
      stop_hook_active: false,
    });

    // 驗證兩個 tag 都存在
    for (const tag of tags) {
      const tagExists = execSync(`git tag -l "${tag}"`, { encoding: 'utf8' }).trim();
      assert.strictEqual(tagExists, tag, `應存在 ${tag} tag`);
    }
  } finally {
    cleanup(statePath);
    tags.forEach(cleanupGitTag);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 2: POST_STAGE_HINTS — 安全/覆蓋率提示注入');
// ═══════════════════════════════════════════════

test('REVIEW → TEST 包含安全提示', () => {
  const sessionId = 'test-hints-1';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer'],
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
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:code-reviewer',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    assert.ok(output.systemMessage.includes('安全提示'), 'REVIEW → TEST 應包含安全提示');
    assert.ok(output.systemMessage.includes('/vibe:security'), '應提及 /vibe:security');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/review');
  }
});

test('TEST → QA 包含覆蓋率提示', () => {
  const sessionId = 'test-hints-2';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner', 'vibe:architect', 'vibe:developer', 'vibe:code-reviewer'],
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
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:tester',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    assert.ok(output.systemMessage.includes('覆蓋率提示'), 'TEST → QA 應包含覆蓋率提示');
    assert.ok(output.systemMessage.includes('/vibe:coverage'), '應提及 /vibe:coverage');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/test');
  }
});

test('DEV → REVIEW 無額外提示（DEV 不在 POST_STAGE_HINTS 中）', () => {
  const sessionId = 'test-hints-3';
  const statePath = createTempState(sessionId, {
    phase: 'DELEGATING',
    context: {
      pipelineId: 'standard',
      taskType: 'feature',
      expectedStages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST'],
      environment: {},
      openspecEnabled: false,
      needsDesign: false,
    },
    progress: {
      currentStage: null,
      stageIndex: 0,
      completedAgents: ['vibe:planner', 'vibe:architect'],
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
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:developer',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    assert.ok(!output.systemMessage.includes('安全提示'), 'DEV → REVIEW 不應包含安全提示');
    assert.ok(!output.systemMessage.includes('覆蓋率提示'), 'DEV → REVIEW 不應包含覆蓋率提示');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/dev');
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 3: buildKnowledgeHints — 知識 skills 自動注入');
// ═══════════════════════════════════════════════

// TODO: v3 重構移除了知識 skill 注入功能（pipeline-controller.classify() 不產出 knowledge hints），
//       待 pipeline-controller 恢復知識 skill 注入後再啟用這些測試。

// test('TypeScript 專案注入 typescript-patterns + coding-standards + testing-patterns', () => { ... });
// test('Python 專案注入 python-patterns', () => { ... });
// test('React + TypeScript 專案注入 frontend-patterns + typescript-patterns', () => { ... });
// test('Express 專案注入 backend-patterns', () => { ... });
// test('Go 專案注入 go-patterns', () => { ... });

test('無語言偵測時不注入知識 skills', () => {
  const sessionId = 'test-knowledge-6';
  const statePath = createTempState(sessionId, {
    phase: 'IDLE',
    context: {
      pipelineId: null,
      taskType: null,
      expectedStages: [],
      environment: {
        languages: { primary: null, secondary: [] },
        framework: null,
        packageManager: null,
        tools: {},
      },
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
    const result = runHook('task-classifier.js', {
      prompt: '建立完整的系統',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = output.systemMessage || output.additionalContext || '';
    assert.ok(!msg.includes('可用知識庫'), '無語言偵測時不應注入知識庫提示');
  } finally {
    cleanup(statePath);
  }
});

// TODO: v3 重構移除了知識 skill 注入功能，待恢復
// test('research 分類也能注入知識提示', () => { ... });
// test('多語言專案注入所有匹配的知識 skills', () => { ... });

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 4: Pipeline 完成三步閉環');
// ═══════════════════════════════════════════════

// 注意：v3 使用 writeV3State 建立 DAG 結構。DOCS 是最後階段，
// doc-updater 完成後觸發 pipeline 完成流程。

test('Pipeline 完成訊息包含 verify 指令', () => {
  const sessionId = 'test-complete-1';
  const { writeV3State } = require('./test-helpers');
  const statePath = writeV3State(sessionId, {
    stages: ['DEV', 'REVIEW', 'TEST', 'DOCS'],
    completed: ['DEV', 'REVIEW', 'TEST'],
    active: 'DOCS',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
  });

  try {
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:doc-updater',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    assert.ok(output.systemMessage.includes('/vibe:verify'), '完成訊息應包含 /vibe:verify');
    assert.ok(output.systemMessage.includes('最終驗證'), '應提及最終驗證');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成訊息包含 AskUserQuestion 指令', () => {
  const sessionId = 'test-complete-2';
  const { writeV3State } = require('./test-helpers');
  const statePath = writeV3State(sessionId, {
    stages: ['DEV', 'DOCS'],
    completed: ['DEV'],
    active: 'DOCS',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
  });

  try {
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:doc-updater',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    assert.ok(output.systemMessage.includes('AskUserQuestion'), '完成訊息應包含 AskUserQuestion');
    assert.ok(output.systemMessage.includes('multiSelect'), '應指定 multiSelect');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成訊息結構正確（完成列表 + 後續動作）', () => {
  const sessionId = 'test-complete-3';
  const { writeV3State } = require('./test-helpers');
  const statePath = writeV3State(sessionId, {
    stages: ['DEV', 'DOCS'],
    completed: ['DEV'],
    active: 'DOCS',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
  });

  try {
    const result = runHook('stage-transition.js', {
      agent_type: 'vibe:doc-updater',
      session_id: sessionId,
      stop_hook_active: false,
    });

    const output = JSON.parse(result);
    // v3 完成訊息結構：已完成列表 + 後續動作 + 自動模式解除
    assert.ok(output.systemMessage.includes('Pipeline 完成'), '應包含完成標題');
    assert.ok(output.systemMessage.includes('已完成'), '應包含已完成階段列表');
    assert.ok(output.systemMessage.includes('後續動作'), '應包含後續動作區塊');
    assert.ok(output.systemMessage.includes('自動模式已解除'), '應提示自動模式解除');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成後 derivePhase 為 COMPLETE', () => {
  const sessionId = 'test-complete-4';
  const { writeV3State } = require('./test-helpers');
  const statePath = writeV3State(sessionId, {
    stages: ['DOCS'],
    active: 'DOCS',
    pipelineId: 'docs-only',
    taskType: 'quickfix',
    enforced: true,
  });

  try {
    runHook('stage-transition.js', {
      agent_type: 'vibe:doc-updater',
      session_id: sessionId,
      stop_hook_active: false,
    });

    // v3 沒有 stored phase — 用 derivePhase 從 stages 狀態推導
    const ds = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'dag-state.js'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(ds.derivePhase(state), 'COMPLETE', 'derivePhase 應為 COMPLETE');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
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
