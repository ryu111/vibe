#!/usr/bin/env node
/**
 * automation-features.test.js — v1.0.21 Skills 全自動化測試
 *
 * 測試重點：
 * 1. autoCheckpoint — git tag 建立
 * 2. POST_STAGE_HINTS — REVIEW→security / TEST→coverage 提示
 * 3. buildKnowledgeHints — env-detect 語言/框架映射知識 skills
 * 4. Pipeline 完成訊息 — 精簡格式（已完成 + 跳過 + 自動模式解除）
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
const { cleanTestStateFiles, writeV4State } = require('./test-helpers');
cleanTestStateFiles();

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

  const statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV'],
    active: 'PLAN',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
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

  const statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    completed: ['PLAN', 'ARCH', 'DEV'],
    active: 'REVIEW',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
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
  let statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV'],
    active: 'PLAN',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
  });

  try {
    runHook('stage-transition.js', {
      agent_type: 'vibe:planner',
      session_id: sessionId,
      stop_hook_active: false,
    });

    // ARCH 完成（重新寫入 state，PLAN 已完成，ARCH 為 active）
    statePath = writeV4State(sessionId, {
      stages: ['PLAN', 'ARCH', 'DEV'],
      completed: ['PLAN'],
      active: 'ARCH',
      pipelineId: 'standard',
      taskType: 'feature',
      enforced: true,
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
  const statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA'],
    completed: ['PLAN', 'ARCH', 'DEV'],
    active: 'REVIEW',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
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
  const statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST', 'QA'],
    completed: ['PLAN', 'ARCH', 'DEV', 'REVIEW'],
    active: 'TEST',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
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
  const statePath = writeV4State(sessionId, {
    stages: ['PLAN', 'ARCH', 'DEV', 'REVIEW', 'TEST'],
    completed: ['PLAN', 'ARCH'],
    active: 'DEV',
    pipelineId: 'standard',
    taskType: 'feature',
    enforced: true,
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

/**
 * 建立含 environment 的 v3 state（IDLE，無分類）
 * classify() 讀到此 state 後會保留 environment 並進行分類
 */
function createEnvState(sessionId, environment) {
  return {
    version: 3,
    sessionId,
    classification: null,
    environment,
    openspecEnabled: false,
    needsDesign: false,
    dag: null,
    enforced: false,
    blueprint: null,
    stages: {},
    retries: {},
    pendingRetry: null,
    meta: {
      initialized: true,
      cancelled: false,
      lastTransition: new Date().toISOString(),
      reclassifications: [],
      pipelineRules: [],
    },
  };
}

test('TypeScript 專案注入 typescript-patterns + coding-standards + testing-patterns', () => {
  const sessionId = 'test-knowledge-1';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'typescript', secondary: [] },
    framework: null,
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立完整的 TypeScript 系統',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(msg.includes('/vibe:typescript-patterns'), '應注入 typescript-patterns');
    assert.ok(msg.includes('/vibe:coding-standards'), '應注入 coding-standards');
    assert.ok(msg.includes('/vibe:testing-patterns'), '應注入 testing-patterns');
  } finally {
    cleanup(statePath);
  }
});

test('Python 專案注入 python-patterns', () => {
  const sessionId = 'test-knowledge-2';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'python', secondary: [] },
    framework: null,
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立完整的 Python 應用程式',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(msg.includes('/vibe:python-patterns'), '應注入 python-patterns');
  } finally {
    cleanup(statePath);
  }
});

test('React + TypeScript 專案注入 frontend-patterns + typescript-patterns', () => {
  const sessionId = 'test-knowledge-3';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'typescript', secondary: [] },
    framework: { name: 'react' },
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立 React 元件系統',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(msg.includes('/vibe:frontend-patterns'), '應注入 frontend-patterns');
    assert.ok(msg.includes('/vibe:typescript-patterns'), '應注入 typescript-patterns');
  } finally {
    cleanup(statePath);
  }
});

test('Express 專案注入 backend-patterns', () => {
  const sessionId = 'test-knowledge-4';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'javascript', secondary: [] },
    framework: { name: 'express' },
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立 Express API 伺服器',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    // express 框架會觸發 backend-patterns（+ coding-standards + testing-patterns）
    // javascript 不在 KNOWLEDGE_SKILLS.languages，所以不注入語言 skill
    assert.ok(msg.includes('/vibe:backend-patterns'), '應注入 backend-patterns');
  } finally {
    cleanup(statePath);
  }
});

test('Go 專案注入 go-patterns', () => {
  const sessionId = 'test-knowledge-5';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'go', secondary: [] },
    framework: null,
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立 Go 微服務',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(msg.includes('/vibe:go-patterns'), '應注入 go-patterns');
  } finally {
    cleanup(statePath);
  }
});

test('無語言偵測時不注入知識 skills', () => {
  const sessionId = 'test-knowledge-6';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: null, secondary: [] },
    framework: null,
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立完整的系統',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(!msg.includes('可用知識庫'), '無語言偵測時不應注入知識庫提示');
  } finally {
    cleanup(statePath);
  }
});

test('research 分類（none pipeline）也能注入知識提示', () => {
  const sessionId = 'test-knowledge-7';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'typescript', secondary: [] },
    framework: null,
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      // 問句觸發 none pipeline
      prompt: '這個 TypeScript API 怎麼用？',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    // none pipeline 也應注入知識庫提示（additionalContext 中）
    assert.ok(msg.includes('可用知識庫'), '即使是 none pipeline 也應注入知識庫提示');
  } finally {
    cleanup(statePath);
  }
});

test('多語言專案注入所有匹配的知識 skills', () => {
  const sessionId = 'test-knowledge-8';
  const statePath = createTempState(sessionId, createEnvState(sessionId, {
    languages: { primary: 'typescript', secondary: ['python'] },
    framework: { name: 'next.js' },
    packageManager: null,
    tools: {},
  }));

  try {
    const result = runHook('task-classifier.js', {
      prompt: '建立 Next.js 全端應用程式',
      session_id: sessionId,
    });

    const output = JSON.parse(result);
    const msg = (output.systemMessage || '') + (output.additionalContext || '');
    assert.ok(msg.includes('/vibe:typescript-patterns'), '應注入 typescript-patterns');
    assert.ok(msg.includes('/vibe:python-patterns'), '應注入 python-patterns');
    assert.ok(msg.includes('/vibe:frontend-patterns'), '應注入 frontend-patterns');
  } finally {
    cleanup(statePath);
  }
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 3b: buildKnowledgeHints — 直接單元測試');
// ═══════════════════════════════════════════════

const { buildKnowledgeHints } = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'flow', 'pipeline-controller.js'));

test('unit: TypeScript → typescript-patterns + common skills', () => {
  const result = buildKnowledgeHints({ environment: { languages: { primary: 'typescript', secondary: [] } } });
  assert.ok(result.includes('/vibe:typescript-patterns'));
  assert.ok(result.includes('/vibe:coding-standards'));
  assert.ok(result.includes('/vibe:testing-patterns'));
  assert.ok(result.startsWith('可用知識庫：'));
});

test('unit: React + TypeScript → frontend + typescript + common', () => {
  const result = buildKnowledgeHints({ environment: { languages: { primary: 'typescript' }, framework: { name: 'react' } } });
  assert.ok(result.includes('/vibe:typescript-patterns'));
  assert.ok(result.includes('/vibe:frontend-patterns'));
  assert.ok(result.includes('/vibe:coding-standards'));
});

test('unit: Go → go-patterns + common', () => {
  const result = buildKnowledgeHints({ environment: { languages: { primary: 'go' } } });
  assert.ok(result.includes('/vibe:go-patterns'));
  assert.ok(result.includes('/vibe:coding-standards'));
});

test('unit: Express (no lang match) → backend-patterns + common', () => {
  const result = buildKnowledgeHints({ environment: { languages: { primary: 'javascript' }, framework: { name: 'express' } } });
  assert.ok(result.includes('/vibe:backend-patterns'));
  assert.ok(!result.includes('/vibe:typescript-patterns'), 'javascript 不在 languages mapping');
});

test('unit: 空 environment → 空字串', () => {
  assert.strictEqual(buildKnowledgeHints({}), '');
  assert.strictEqual(buildKnowledgeHints({ environment: {} }), '');
  assert.strictEqual(buildKnowledgeHints({ environment: { languages: {} } }), '');
});

test('unit: null/undefined primary → 空字串', () => {
  assert.strictEqual(buildKnowledgeHints({ environment: { languages: { primary: null } } }), '');
  assert.strictEqual(buildKnowledgeHints({ environment: { languages: { primary: undefined } } }), '');
});

test('unit: secondary 含非字串元素 → 安全過濾', () => {
  const result = buildKnowledgeHints({
    environment: { languages: { primary: 'typescript', secondary: [123, null, 'python', undefined] } },
  });
  assert.ok(result.includes('/vibe:typescript-patterns'));
  assert.ok(result.includes('/vibe:python-patterns'));
  assert.ok(!result.includes('123'), '非字串應被過濾');
});

test('unit: Set 去重 — 多框架指向同一 skill 不重複', () => {
  const result = buildKnowledgeHints({
    environment: { languages: { primary: 'typescript' }, framework: { name: 'next.js' } },
  });
  const count = (result.match(/\/vibe:frontend-patterns/g) || []).length;
  assert.strictEqual(count, 1, 'frontend-patterns 不應重複');
});

test('unit: 大小寫不敏感 — TypeScript/PYTHON 正常匹配', () => {
  const r1 = buildKnowledgeHints({ environment: { languages: { primary: 'TypeScript' } } });
  assert.ok(r1.includes('/vibe:typescript-patterns'));
  const r2 = buildKnowledgeHints({ environment: { languages: { primary: 'PYTHON' } } });
  assert.ok(r2.includes('/vibe:python-patterns'));
});

// ═══════════════════════════════════════════════
console.log('\n🧪 Part 4: Pipeline 完成三步閉環');
// ═══════════════════════════════════════════════

// 注意：使用 writeV4State 建立 DAG 結構。DOCS 是最後階段，
// doc-updater 完成後觸發 pipeline 完成流程。

test('Pipeline 完成訊息包含已完成階段列表', () => {
  const sessionId = 'test-complete-1';
  const { writeV4State } = require('./test-helpers');
  const statePath = writeV4State(sessionId, {
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
    assert.ok(output.systemMessage.includes('Pipeline [standard] 完成'), '應包含 pipeline ID');
    assert.ok(output.systemMessage.includes('已完成'), '應包含已完成階段列表');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成訊息包含跳過階段（如有）', () => {
  const sessionId = 'test-complete-2';
  const { writeV4State } = require('./test-helpers');
  const statePath = writeV4State(sessionId, {
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
    // DEV + DOCS 完成，無跳過
    assert.ok(output.systemMessage.includes('Pipeline [standard] 完成'), '應包含完成標題');
    assert.ok(output.systemMessage.includes('自動模式已解除'), '應提示自動模式解除');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成訊息結構正確（精簡格式）', () => {
  const sessionId = 'test-complete-3';
  const { writeV4State } = require('./test-helpers');
  const statePath = writeV4State(sessionId, {
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
    // v3 精簡完成訊息：已完成列表 + 跳過（如有）+ 自動模式解除
    assert.ok(output.systemMessage.includes('Pipeline [standard] 完成'), '應包含完成標題');
    assert.ok(output.systemMessage.includes('已完成'), '應包含已完成階段列表');
    assert.ok(output.systemMessage.includes('自動模式已解除'), '應提示自動模式解除');
    // 不再要求 verify/AskUserQuestion 硬編碼指令
    assert.ok(!output.systemMessage.includes('/vibe:verify'), '不應包含 /vibe:verify 硬編碼');
    assert.ok(!output.systemMessage.includes('multiSelect'), '不應包含 AskUserQuestion 硬編碼');
  } finally {
    cleanup(statePath);
    cleanupGitTag('vibe-pipeline/docs');
  }
});

test('Pipeline 完成後 derivePhase 為 COMPLETE', () => {
  const sessionId = 'test-complete-4';
  const { writeV4State } = require('./test-helpers');
  const statePath = writeV4State(sessionId, {
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
