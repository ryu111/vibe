#!/usr/bin/env node
/**
 * formatter.test.js — Timeline 格式化模組測試
 *
 * 測試 formatTimeline（三模式）、formatToolDetail、formatEventText、generateStats
 */
'use strict';

const path = require('path');
const {
  formatTimeline,
  formatLine,
  formatToolDetail,
  formatEventText,
  generateStats,
  EMOJI_MAP,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'timeline', 'formatter.js'));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ── 測試用事件 ─────────────────────────────────

const now = Date.now();

function makeEvent(type, data = {}, offset = 0) {
  return { id: `test-${offset}`, type, sessionId: 'test-session', timestamp: now + offset * 1000, data };
}

// ── EMOJI_MAP ──────────────────────────────────

section('EMOJI_MAP');

assert(Object.keys(EMOJI_MAP).length >= 22, 'EMOJI_MAP 至少有 22 個事件類型');
assert(EMOJI_MAP['session.start'] === '🚀', 'session.start emoji 正確');
assert(EMOJI_MAP['pipeline.complete'] === '🎉', 'pipeline.complete emoji 正確');
assert(EMOJI_MAP['tool.used'] === '🔧', 'tool.used emoji 正確');
assert(EMOJI_MAP['tool.blocked'] === '🚫', 'tool.blocked emoji 正確');

// ── formatToolDetail ───────────────────────────

section('formatToolDetail');

assert(formatToolDetail({ tool: 'Read', file: 'schema.js' }) === 'Read schema.js', 'Read + file');
assert(formatToolDetail({ tool: 'Read' }) === 'Read', 'Read without file');
assert(formatToolDetail({ tool: 'Write', file: 'index.js' }) === 'Write index.js', 'Write + file');
assert(formatToolDetail({ tool: 'Edit', file: 'bot.js' }) === 'Edit bot.js', 'Edit + file');
assert(formatToolDetail({ tool: 'Bash', command: 'git status' }) === 'Bash `git status`', 'Bash + command');
assert(formatToolDetail({ tool: 'Bash' }) === 'Bash', 'Bash without command');
assert(formatToolDetail({ tool: 'Glob', pattern: '**/*.js' }) === 'Glob "**/*.js"', 'Glob + pattern');
assert(formatToolDetail({ tool: 'Grep', pattern: 'TODO' }) === 'Grep "TODO"', 'Grep + pattern');
assert(formatToolDetail({ tool: 'Skill', skill: 'timeline' }) === 'Skill timeline', 'Skill + name');
assert(formatToolDetail({ tool: 'WebFetch', url: 'https://example.com' }) === 'WebFetch https://example.com', 'WebFetch + url');
assert(formatToolDetail({ tool: 'WebSearch', query: 'test query' }) === 'WebSearch "test query"', 'WebSearch + query');
assert(formatToolDetail({ tool: 'AskUserQuestion', questionCount: 3 }) === 'AskUserQuestion (3 題)', 'AskUserQuestion + count');
assert(formatToolDetail({ tool: 'EnterPlanMode' }) === 'EnterPlanMode', 'EnterPlanMode');
assert(formatToolDetail({ tool: 'mcp__plugin__search' }) === 'MCP:search', 'MCP 工具簡稱');
assert(formatToolDetail({ tool: 'mcp__claude-in-chrome__screenshot' }) === 'MCP:screenshot', 'MCP 長名稱簡稱');
assert(formatToolDetail({ tool: 'Unknown' }) === 'Unknown', '未知工具');

// ── formatEventText ────────────────────────────

section('formatEventText');

assert(formatEventText(makeEvent('session.start')) === 'Session 啟動', 'session.start 文字');
assert(formatEventText(makeEvent('prompt.received')) === '收到使用者輸入', 'prompt.received 文字');

const classifiedEvent = makeEvent('task.classified', { taskType: 'feature', expectedStages: ['PLAN', 'ARCH', 'DEV'] });
assert(formatEventText(classifiedEvent).includes('feature'), 'task.classified 含 taskType');
assert(formatEventText(classifiedEvent).includes('PLAN,ARCH,DEV'), 'task.classified 含 stages');

const delegationEvent = makeEvent('delegation.start', { agentType: 'architect', description: '設計架構' });
assert(formatEventText(delegationEvent).includes('architect'), 'delegation.start 含 agentType');
assert(formatEventText(delegationEvent).includes('設計架構'), 'delegation.start 含 description');

const stageCompleteEvent = makeEvent('stage.complete', { stage: 'DEV', agentType: 'developer', nextStage: 'REVIEW', verdict: 'PASS' });
assert(formatEventText(stageCompleteEvent).includes('DEV'), 'stage.complete 含 stage');
assert(formatEventText(stageCompleteEvent).includes('REVIEW'), 'stage.complete 含 nextStage');
assert(formatEventText(stageCompleteEvent).includes('PASS'), 'stage.complete 含 verdict');

const retryEvent = makeEvent('stage.retry', { stage: 'REVIEW', severity: 'CRITICAL', retryCount: 2 });
assert(formatEventText(retryEvent).includes('REVIEW'), 'stage.retry 含 stage');
assert(formatEventText(retryEvent).includes('CRITICAL'), 'stage.retry 含 severity');
assert(formatEventText(retryEvent).includes('2'), 'stage.retry 含 retryCount');

const pipelineCompleteEvent = makeEvent('pipeline.complete', { completedStages: ['PLAN', 'ARCH', 'DEV'] });
assert(formatEventText(pipelineCompleteEvent).includes('PLAN→ARCH→DEV'), 'pipeline.complete 含 stages 路徑');

const toolUsedEvent = makeEvent('tool.used', { tool: 'Read', file: 'test.js' });
assert(formatEventText(toolUsedEvent) === 'Read test.js', 'tool.used 委派給 formatToolDetail');

const toolBlockedEvent = makeEvent('tool.blocked', { tool: 'Write', reason: 'pipeline-guard' });
assert(formatEventText(toolBlockedEvent).includes('Write'), 'tool.blocked 含 tool');
assert(formatEventText(toolBlockedEvent).includes('pipeline-guard'), 'tool.blocked 含 reason');

// ── formatLine ─────────────────────────────────

section('formatLine');

const line = formatLine(makeEvent('session.start'), 0);
assert(line.includes('🚀'), 'formatLine 含 emoji');
assert(line.includes('session.start'), 'formatLine 含 event type');
assert(line.includes('Session 啟動'), 'formatLine 含 text');
assert(line.startsWith('  1.'), 'formatLine 含行號');

// ── formatTimeline — full 模式 ─────────────────

section('formatTimeline — full 模式');

const fullEvents = [
  makeEvent('session.start', {}, 0),
  makeEvent('tool.used', { tool: 'Read', file: 'a.js' }, 1),
  makeEvent('tool.used', { tool: 'Edit', file: 'b.js' }, 2),
  makeEvent('pipeline.complete', { completedStages: ['DEV'] }, 3),
];

const fullLines = formatTimeline(fullEvents, { mode: 'full' });
assert(Array.isArray(fullLines), 'full 回傳陣列');
assert(fullLines.length === 4, 'full 每事件一行');
assert(fullLines[0].includes('session.start'), 'full 第一行含 session.start');
assert(fullLines[3].includes('pipeline.complete'), 'full 最後行含 pipeline.complete');

// ── formatTimeline — compact 模式 ──────────────

section('formatTimeline — compact 模式');

const compactEvents = [
  makeEvent('session.start', {}, 0),
  makeEvent('delegation.start', { agentType: 'developer', description: '實作功能', promptPreview: '請根據 design.md...' }, 1),
  makeEvent('tool.used', { tool: 'Read', file: 'a.js' }, 2),
  makeEvent('tool.used', { tool: 'Read', file: 'a.js' }, 3),
  makeEvent('tool.used', { tool: 'Read', file: 'a.js' }, 4),
  makeEvent('tool.used', { tool: 'Edit', file: 'b.js' }, 5),
  makeEvent('stage.complete', { stage: 'DEV', agentType: 'developer', nextStage: 'REVIEW', verdict: 'PASS' }, 6),
];

const compactLines = formatTimeline(compactEvents, { mode: 'compact' });
assert(Array.isArray(compactLines), 'compact 回傳陣列');
assert(compactLines.length < fullEvents.length + compactEvents.length, 'compact 行數少於事件數');

// 驗證聚合：3 個 Read a.js 應該被壓縮成一行含 ×3
const readLine = compactLines.find(l => l.includes('Read a.js'));
assert(readLine && readLine.includes('×3'), 'compact 聚合連續 Read a.js ×3');

// 驗證 delegation 段落
const delegationLine = compactLines.find(l => l.includes('developer'));
assert(delegationLine && delegationLine.includes('🔀'), 'compact delegation 含 🔀 emoji');

// 驗證 promptPreview 縮排
const previewLine = compactLines.find(l => l.includes('design.md'));
assert(previewLine && previewLine.includes('📝'), 'compact promptPreview 含 📝');

// 驗證 stage.complete
const stageLine = compactLines.find(l => l.includes('DEV'));
assert(stageLine && stageLine.includes('✅'), 'compact stage.complete 含 ✅');

// ── formatTimeline — compact 噪音壓縮 ─────────

section('formatTimeline — compact 噪音壓縮');

const noiseEvents = [
  makeEvent('session.start', {}, 0),
  makeEvent('quality.test-needed', { filePath: '/a.js' }, 1),
  makeEvent('quality.test-needed', { filePath: '/b.js' }, 2),
  makeEvent('quality.test-needed', { filePath: '/c.js' }, 3),
  makeEvent('quality.test-needed', { filePath: '/d.js' }, 4),
  makeEvent('pipeline.complete', { completedStages: ['DEV'] }, 5),
];

const noiseLines = formatTimeline(noiseEvents, { mode: 'compact' });
// 4 個 quality.test-needed 應被壓縮為 ×4
const noiseLine = noiseLines.find(l => l.includes('×4'));
assert(noiseLine, 'compact 噪音壓縮 4 個 test-needed 為 ×4');

// ── formatTimeline — summary 模式 ──────────────

section('formatTimeline — summary 模式');

const summaryEvents = [
  makeEvent('session.start', {}, 0),
  makeEvent('tool.used', { tool: 'Read', file: 'a.js' }, 1),
  makeEvent('task.classified', { taskType: 'feature' }, 2),
  makeEvent('delegation.start', { agentType: 'developer' }, 3),
  makeEvent('tool.used', { tool: 'Edit', file: 'b.js' }, 4),
  makeEvent('stage.complete', { stage: 'DEV', verdict: 'PASS', nextStage: 'REVIEW' }, 5),
  makeEvent('pipeline.complete', { completedStages: ['DEV'] }, 6),
];

const summaryLines = formatTimeline(summaryEvents, { mode: 'summary' });
assert(Array.isArray(summaryLines), 'summary 回傳陣列');
// summary 應過濾掉 tool.used，只保留里程碑
assert(summaryLines.length < summaryEvents.length, 'summary 行數少於事件數');
assert(summaryLines.some(l => l.includes('session.start') || l.includes('Session')), 'summary 含 session.start');
assert(summaryLines.some(l => l.includes('pipeline') || l.includes('Pipeline')), 'summary 含 pipeline.complete');
// tool.used 不應出現在 summary
assert(!summaryLines.some(l => l.includes('Read a.js')), 'summary 不含 tool.used');

// ── formatTimeline — stats 選項 ────────────────

section('formatTimeline — stats 選項');

const statsLines = formatTimeline(summaryEvents, { mode: 'compact', stats: true });
assert(statsLines.some(l => l.includes('事件統計')), 'stats 含統計標題');
assert(statsLines.some(l => l.includes('合計')), 'stats 含合計');

// ── generateStats ──────────────────────────────

section('generateStats');

const stats = generateStats(summaryEvents);
assert(Array.isArray(stats), 'generateStats 回傳陣列');
assert(stats[0].includes('事件統計'), 'stats 第一行是標題');
assert(stats.some(l => l.includes('合計')), 'stats 含合計');
assert(stats.some(l => l.includes(String(summaryEvents.length))), 'stats 合計數正確');

// 含有 2 個 tool.used 的統計
const toolUsedStat = stats.find(l => l.includes('tool.used'));
assert(toolUsedStat && toolUsedStat.includes('2'), 'stats tool.used count = 2');

// ── 結果 ───────────────────────────────────────

console.log(`\n=== 結果：${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
