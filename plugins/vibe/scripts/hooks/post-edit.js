#!/usr/bin/env node
/**
 * post-edit.js — PostToolUse hook（matcher: Write|Edit）
 *
 * 合併 none-pipeline 寫入提醒 + auto-lint + auto-format + test-check 四步驟。
 * 順序執行：Step 0 none 提醒 → lint → format → test-check，合併 systemMessage 輸出。
 * 減少 2 次 Node.js 啟動。
 */
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const langMap = require(path.join(__dirname, '..', 'lib', 'sentinel', 'lang-map.js'));
const toolDetector = require(path.join(__dirname, '..', 'lib', 'sentinel', 'tool-detector.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ds = require(path.join(__dirname, '..', 'lib', 'flow', 'dag-state.js'));
const { isNonCodeFile } = require(path.join(__dirname, '..', 'lib', 'sentinel', 'guard-rules.js'));
const { atomicWrite } = require(path.join(__dirname, '..', 'lib', 'flow', 'atomic-write.js'));

// ─── test-check 判斷邏輯 ─────────────

const SKIP_EXTENSIONS = new Set([
  // 測試
  '.test.js', '.test.ts', '.test.jsx', '.test.tsx',
  '.spec.js', '.spec.ts', '.spec.jsx', '.spec.tsx',
  // 設定
  '.json', '.yaml', '.yml', '.toml', '.env', '.lock',
  // 樣式
  '.css', '.scss', '.less', '.sass',
  // 文件
  '.md', '.mdx', '.txt', '.rst',
  // 標記語言
  '.html', '.htm', '.xml', '.svg',
  // 圖片 / 靜態資源
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
]);

const SKIP_PATH_PATTERNS = [
  '/tests/',
  '/test/',
  '/__tests__/',
  '/scripts/hooks/',
  '/scripts/lib/',
  '/.claude-plugin/',
  '/fixtures/',
  '/mocks/',
];

const SKIP_FILENAMES = new Set([
  '.gitignore', '.eslintrc', '.prettierrc', '.editorconfig',
  'tsconfig.json', 'package.json', 'package-lock.json',
  'bun.lockb', 'Makefile', 'Dockerfile', '.dockerignore',
]);

function shouldSkip(filePath) {
  if (!filePath) return true;

  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (SKIP_FILENAMES.has(basename)) return true;

  const doubleExt = basename.includes('.')
    ? '.' + basename.split('.').slice(-2).join('.')
    : '';
  if (doubleExt && SKIP_EXTENSIONS.has(doubleExt.toLowerCase())) return true;

  if (SKIP_EXTENSIONS.has(ext)) return true;

  if (basename.match(/\.config\.[jt]sx?$/)) return true;

  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of SKIP_PATH_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }

  return false;
}

// ─── Step 1: Auto-lint ─────────────

function runLintStep(filePath, sessionId, toolName) {
  if (!filePath) return null;
  const info = langMap.lookup(filePath);
  if (!info || !info.linter) return null;

  const tools = toolDetector.detectTools(info);
  if (!tools.linter) return null;

  const lintCmd = `${tools.linter} --fix "${filePath}"`;
  let passed = true;
  let lintMsg = null;

  try {
    execSync(lintCmd, { stdio: 'pipe', timeout: 12000 });
  } catch (err) {
    passed = false;
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const output = stderr || stdout;

    if (output) {
      lintMsg = `\u26A0\uFE0F Lint \u767C\u73FE\u554F\u984C\uFF08${info.lang}\uFF09\uFF1A\n\`\`\`\n${output.slice(0, 500)}\n\`\`\`\n\u8ACB\u4FEE\u5FA9\u4E0A\u8FF0 lint \u932F\u8AA4\u3002`;
    }
  }

  emit(EVENT_TYPES.QUALITY_LINT, sessionId, { filePath, tool: toolName, passed });
  return lintMsg;
}

// ─── Step 2: Auto-format ─────────────

function runFormatStep(filePath, sessionId, toolName) {
  if (!filePath) return;
  const info = langMap.lookup(filePath);
  if (!info || !info.formatter) return;

  const tools = toolDetector.detectTools(info);
  if (!tools.formatter) return;

  let fmtCmd;
  if (tools.formatter === 'prettier') {
    fmtCmd = `prettier --write "${filePath}"`;
  } else if (tools.formatter === 'ruff format') {
    fmtCmd = `ruff format "${filePath}"`;
  } else if (tools.formatter === 'gofmt -w') {
    fmtCmd = `gofmt -w "${filePath}"`;
  } else {
    fmtCmd = `${tools.formatter} "${filePath}"`;
  }

  try {
    execSync(fmtCmd, { stdio: 'pipe', timeout: 8000 });
    emit(EVENT_TYPES.QUALITY_FORMAT, sessionId, { filePath, tool: toolName });
  } catch (err) {
    hookLogger.error('post-edit:format', err);
  }
}

// ─── Step 3: Test-check ─────────────

function runTestCheckStep(filePath, sessionId) {
  if (shouldSkip(filePath)) return null;

  emit(EVENT_TYPES.QUALITY_TEST_NEEDED, sessionId, { filePath });

  const basename = path.basename(filePath);
  return `\u63D0\u9192\uFF1A${basename} \u5DF2\u4FEE\u6539\uFF0C\u8A18\u5F97\u57F7\u884C\u76F8\u95DC\u6E2C\u8A66\u78BA\u8A8D\u7121\u8FF4\u6B78\u3002`;
}

// ─── Step 0: none pipeline 寫入提醒 ─────────────

/**
 * 檢查是否在 none pipeline 下修改程式碼檔案，若是則遞增計數並回傳提醒訊息。
 *
 * @param {string} sessionId - Session ID
 * @param {string} filePath - 被修改的檔案路徑
 * @returns {string|null} 提醒訊息，若不需要提醒則為 null
 */
function runNonePipelineCheck(sessionId, filePath) {
  if (!filePath || !sessionId) return null;

  // 非程式碼檔案不計入
  if (isNonCodeFile(filePath)) return null;

  // 讀取 pipeline state
  const pState = ds.readState(sessionId);
  if (!pState || pState.classification?.pipelineId !== 'none') return null;

  // 讀取現有計數
  const counterPath = path.join(os.homedir(), '.claude', `none-writes-${sessionId}.json`);
  let noneWriteCount = 0;
  try {
    const raw = fs.readFileSync(counterPath, 'utf8');
    noneWriteCount = JSON.parse(raw).count || 0;
  } catch (_) {}

  // 遞增計數並原子寫入
  noneWriteCount++;
  atomicWrite(counterPath, { count: noneWriteCount });

  return (
    `⚠️ 偵測到 none pipeline 下的程式碼修改（已累計 ${noneWriteCount} 次）。` +
    `建議使用 /vibe:pipeline 選擇適合的 pipeline（如 quick-dev 或 fix）以啟用品質門。`
  );
}

// ─── 測試用 exports ─────────────

if (typeof module !== 'undefined') {
  module.exports = {
    shouldSkip, runLintStep, runFormatStep, runTestCheckStep, runNonePipelineCheck,
    SKIP_EXTENSIONS, SKIP_PATH_PATTERNS, SKIP_FILENAMES,
  };
}

// ─── Hook 模式 ─────────────

if (require.main === module) {
  let input = '';
  process.stdin.on('data', d => input += d);
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const sessionId = data.session_id || 'unknown';
      const toolName = data.tool_name || 'Write';

      const filePath =
        data.tool_input?.file_path ||
        data.tool_input?.path ||
        data.input?.file_path ||
        null;

      if (!filePath) {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const messages = [];

      // Step 0: none pipeline 寫入提醒
      const noneMsg = runNonePipelineCheck(sessionId, filePath);
      if (noneMsg) messages.push(noneMsg);

      // Step 1: Auto-lint
      const lintMsg = runLintStep(filePath, sessionId, toolName);
      if (lintMsg) messages.push(lintMsg);

      // Step 2: Auto-format
      runFormatStep(filePath, sessionId, toolName);

      // Step 3: Test-check
      const testMsg = runTestCheckStep(filePath, sessionId);
      if (testMsg) messages.push(testMsg);

      const result = { continue: true };
      if (messages.length > 0) result.systemMessage = messages.join('\n');
      console.log(JSON.stringify(result));
    } catch (err) {
      hookLogger.error('post-edit', err);
    }
  });
}
