#!/usr/bin/env node
/**
 * test-check.test.js — 測試 test-check hook 的判斷邏輯
 *
 * 驗證非業務邏輯檔案靜默放行、業務邏輯檔案輸出 systemMessage 提醒。
 *
 * 執行：bun test plugins/vibe/tests/test-check.test.js
 */
'use strict';
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'test-check.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u274c ${name}`);
    console.log(`     ${err.message}`);
  }
}

function runHook(stdinData) {
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(stdinData)}' | node "${HOOK_SCRIPT}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    );
    return { exitCode: 0, stdout: stdout.toString().trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

// ===================================================
console.log('\n\ud83e\uddea test-check: \u975c\u9ed8\u653e\u884c\u5834\u666f\uff08\u975e\u696d\u52d9\u908f\u8f2f\uff09');
// ===================================================

test('\u975c\u9ed8 \u2014 \u7121\u6a94\u6848\u8def\u5f91', () => {
  const result = runHook({ tool_input: {} });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 \u6e2c\u8a66\u6a94\u6848 (.test.js)', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/utils.test.js' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 \u6e2c\u8a66\u6a94\u6848 (.spec.ts)', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/auth.spec.ts' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 JSON \u8a2d\u5b9a\u6a94', () => {
  const result = runHook({ tool_input: { file_path: '/app/config.json' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 Markdown \u6587\u4ef6', () => {
  const result = runHook({ tool_input: { file_path: '/app/README.md' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 CSS \u6a23\u5f0f\u6a94', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/styles/main.css' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 HTML \u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/public/index.html' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 hook \u8173\u672c\u8def\u5f91', () => {
  const result = runHook({ tool_input: { file_path: '/plugins/vibe/scripts/hooks/auto-lint.js' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 lib \u5171\u7528\u51fd\u5f0f\u5eab', () => {
  const result = runHook({ tool_input: { file_path: '/plugins/vibe/scripts/lib/registry.js' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 YAML \u8a2d\u5b9a', () => {
  const result = runHook({ tool_input: { file_path: '/app/.github/workflows/ci.yml' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 config \u6a94\u6848 (vite.config.ts)', () => {
  const result = runHook({ tool_input: { file_path: '/app/vite.config.ts' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 package.json', () => {
  const result = runHook({ tool_input: { file_path: '/app/package.json' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 tests \u76ee\u9304\u4e0b\u7684\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/tests/helpers/setup.js' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 __tests__ \u76ee\u9304', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/__tests__/utils.js' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 SVG \u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/public/logo.svg' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 lock \u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/yarn.lock' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

test('\u975c\u9ed8 \u2014 .claude-plugin \u76ee\u9304', () => {
  const result = runHook({ tool_input: { file_path: '/plugins/vibe/.claude-plugin/plugin.json' } });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stdout.includes('"continue":true') || result.stdout.includes('"continue": true'), '應輸出 continue: true');
});

// ===================================================
console.log('\n\ud83e\uddea test-check: \u63d0\u9192\u5834\u666f\uff08\u696d\u52d9\u908f\u8f2f\uff09');
// ===================================================

test('\u63d0\u9192 \u2014 JavaScript \u696d\u52d9\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/services/auth.js' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('auth.js'));
  assert.ok(output.systemMessage.includes('\u6e2c\u8a66'));
});

test('\u63d0\u9192 \u2014 TypeScript \u696d\u52d9\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/models/user.ts' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('user.ts'));
});

test('\u63d0\u9192 \u2014 Python \u696d\u52d9\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/api/routes.py' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('routes.py'));
});

test('\u63d0\u9192 \u2014 Go \u696d\u52d9\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/cmd/server/main.go' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('main.go'));
});

test('\u63d0\u9192 \u2014 JSX \u5143\u4ef6\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/components/Button.jsx' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('Button.jsx'));
});

test('\u63d0\u9192 \u2014 TSX \u5143\u4ef6\u6a94\u6848', () => {
  const result = runHook({ tool_input: { file_path: '/app/src/pages/Dashboard.tsx' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.continue, true);
  assert.ok(output.systemMessage.includes('Dashboard.tsx'));
});

test('\u63d0\u9192 \u2014 \u4f7f\u7528 input.file_path \u683c\u5f0f', () => {
  const result = runHook({ input: { file_path: '/app/src/utils/format.js' } });
  assert.strictEqual(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.ok(output.systemMessage.includes('format.js'));
});

// ===================================================
// 結果總結
// ===================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`\u7d50\u679c\uff1a${passed} \u901a\u904e / ${failed} \u5931\u6557 / ${passed + failed} \u7e3d\u8a08`);

if (failed > 0) {
  console.log('\u274c \u6709\u6e2c\u8a66\u5931\u6557\n');
  process.exit(1);
} else {
  console.log('\u2705 \u5168\u90e8\u901a\u904e\n');
}
