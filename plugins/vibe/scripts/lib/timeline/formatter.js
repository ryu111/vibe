#!/usr/bin/env node
/**
 * formatter.js — Timeline 顯示格式化模組
 *
 * 將 timeline 事件流轉換為人類可讀的格式化輸出。
 * 支援三種模式：full（逐行）、compact（聚合壓縮）、summary（里程碑）。
 *
 * @module timeline/formatter
 * @exports {function} formatTimeline - 主要格式化函式
 * @exports {function} formatLine - 單行格式化
 * @exports {Object} EMOJI_MAP - 事件類型 → emoji 映射
 */
'use strict';
const path = require('path');

// ── Emoji 映射 ────────────────────────────────────────

const EMOJI_MAP = {
  'session.start':      '🚀',
  'prompt.received':    '📨',
  'task.classified':    '🏷️',
  'ask.question':       '❓',
  'ask.answered':       '📝',
  'delegation.start':   '🔀',
  'stage.start':        '▶️',
  'stage.complete':     '✅',
  'stage.retry':        '🔄',
  'pipeline.complete':  '🎉',
  'pipeline.incomplete':'⚠️',
  'route.fallback':     '↩️',
  'retry.exhausted':    '🛑',
  // v4 Phase 4：Barrier 並行事件
  'barrier.waiting':    '⏳',
  'barrier.resolved':   '🔀',
  // v4 Phase 4：異常事件
  'agent.crash':        '💥',
  'pipeline.aborted':   '⛔',
  'pipeline.cancelled': '🚫',
  'tool.used':          '🔧',
  'tool.blocked':       '🚫',
  'tool.guarded':       '🛡️',
  'quality.lint':       '📏',
  'quality.format':     '💅',
  'quality.test-needed':'🧪',
  'task.incomplete':    '⏳',
  'turn.summary':       '📊',
  'say.sent':           '📤',
  'say.completed':      '📥',
  'compact.suggested':  '📦',
  'compact.executed':   '📦',
  // Safety 安全事件
  'safety.transcript-leak': '🔐',
};

// 噪音事件類型（compact 模式下可聚合或隱藏）
const NOISE_TYPES = new Set([
  'compact.suggested',
  'quality.test-needed',
]);

// ── 工具類型格式化 ──────────────────────────────────────

/**
 * 格式化 tool.used 事件的描述文字
 */
function formatToolDetail(data) {
  const tool = data.tool || 'Unknown';
  switch (tool) {
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      return data.file ? `${tool} ${data.file}` : tool;
    case 'Bash':
      return data.command ? `Bash \`${data.command}\`` : 'Bash';
    case 'Glob':
      return data.pattern ? `Glob "${data.pattern}"` : 'Glob';
    case 'Grep':
      return data.pattern ? `Grep "${data.pattern}"` : 'Grep';
    case 'Skill':
      return data.skill ? `Skill ${data.skill}` : 'Skill';
    case 'WebFetch':
      return data.url ? `WebFetch ${data.url}` : 'WebFetch';
    case 'WebSearch':
      return data.query ? `WebSearch "${data.query}"` : 'WebSearch';
    case 'AskUserQuestion':
      return data.questionCount ? `AskUserQuestion (${data.questionCount} 題)` : 'AskUserQuestion';
    case 'EnterPlanMode':
      return 'EnterPlanMode';
    default:
      // MCP 工具：顯示 server:method（例如 chrome:computer、claude-mem:search）
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        if (parts.length >= 3) {
          let server = parts[1];
          // Plugin MCP: plugin_{name}_{suffix} → 提取 {name}
          if (server.startsWith('plugin_')) {
            server = server.replace(/^plugin_/, '').replace(/_mcp.*$/, '');
          }
          // 常用縮寫
          server = server.replace('claude-in-chrome', 'chrome');
          return `${server}:${parts[parts.length - 1]}`;
        }
        return `MCP:${parts[parts.length - 1]}`;
      }
      return tool;
  }
}

/**
 * 格式化事件的描述文字
 */
function formatEventText(event) {
  const d = event.data || {};
  switch (event.type) {
    case 'session.start':
      return 'Session 啟動';
    case 'prompt.received':
      return '收到使用者輸入';
    case 'task.classified': {
      // Phase 3 新格式（有 layer 欄位）vs 舊格式向後相容
      if (d.layer !== undefined) {
        const conf = typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '?';
        const rule = d.matchedRule ? ` [${d.matchedRule}]` : '';
        const base = `分類=${d.pipelineId || d.taskType || '?'} L${d.layer}(${conf})${rule}`;
        if (d.reclassified && d.from) {
          return `升級 ${d.from}→${d.pipelineId || '?'} L${d.layer}(${conf})${rule}`;
        }
        return base;
      }
      return `分類=${d.taskType || d.pipelineId || '?'}`;
    }
    case 'ask.question':
      return `詢問使用者 (${d.questionCount || '?'} 題)`;
    case 'delegation.start': {
      let text = `→ ${d.agentType || '?'}`;
      if (d.description) text += ` — "${d.description}"`;
      return text;
    }
    case 'stage.complete': {
      const v = d.verdict && d.verdict !== 'UNKNOWN' ? ` [${d.verdict}]` : '';
      return `${d.stage || '?'} 完成 (${d.agentType || '?'}) → ${d.nextStage || 'END'}${v}`;
    }
    case 'stage.start':
      return `${d.stage || '?'} 階段開始 (${d.agentType || '?'})`;
    case 'stage.retry':
      return `${d.stage || '?'} FAIL:${d.severity || '?'} → ${d.retryTarget || 'DEV'} (第 ${d.retryCount || '?'} 輪回退)`;
    case 'pipeline.complete':
      return `Pipeline 完成! [${(d.completedStages || []).join('→')}]`;
    case 'pipeline.incomplete':
      return 'Pipeline 未完成';
    case 'route.fallback':
      return `路由 fallback：${d.stage || '?'} 使用 v3 PIPELINE_VERDICT 解析（未找到 PIPELINE_ROUTE）`;
    case 'retry.exhausted':
      return `${d.stage || '?'} 達到回退上限（${d.retryCount || '?'} 輪），強制前進`;
    case 'barrier.waiting': {
      const group = d.barrierGroup || '?';
      const done = d.completedCount || 0;
      const total = d.totalCount || '?';
      const waiting = (d.waitingStages || []).join(', ');
      return `Barrier ${group}：${done}/${total} 完成，等待 ${waiting || '其他節點'}`;
    }
    case 'barrier.resolved': {
      const group = d.barrierGroup || '?';
      const verdict = d.verdict || 'PASS';
      const next = d.next || 'END';
      return `Barrier ${group} 解鎖：${verdict} → ${next}`;
    }
    case 'agent.crash':
      return `${d.stage || '?'} agent crash（第 ${d.crashCount || 1} 次），${d.willRetry ? '重新委派' : 'ABORT'}`;
    case 'pipeline.aborted':
      return `Pipeline 異常終止（${d.reason || 'route=ABORT'}）`;
    case 'pipeline.cancelled':
      return `Pipeline 已取消${d.reason ? `（${d.reason}）` : ''}`;
    case 'safety.transcript-leak':
      return `Transcript 洩漏警告：${d.detail || d.source || '未知來源'}`;
    case 'tool.used':
      return formatToolDetail(d);
    case 'tool.blocked':
      return `阻擋 ${d.tool || '?'} (${d.reason || '?'})`;
    case 'tool.guarded':
      return `守衛檢查: ${(d.files || []).join(', ')}`;
    case 'quality.test-needed':
      return `需要測試: ${d.filePath ? path.basename(d.filePath) : '?'}`;
    case 'compact.suggested':
      return `建議壓縮 (tool count: ${d.count || '?'})`;
    case 'compact.executed':
      return '執行壓縮';
    case 'turn.summary':
      return `回合摘要 (tools: ${d.toolCount || '?'})`;
    default:
      return JSON.stringify(d).slice(0, 80);
  }
}

// ── 時間格式化 ──────────────────────────────────────────

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatTimeShort(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Full 模式 ───────────────────────────────────────────

/**
 * 格式化單一事件行
 */
function formatLine(event, index) {
  const time = formatTime(event.timestamp);
  const emoji = EMOJI_MAP[event.type] || '📌';
  const text = formatEventText(event);
  return `${String(index + 1).padStart(3)}. [${time}] ${emoji} ${event.type.padEnd(22)} ${text}`;
}

/**
 * Full 模式：每個事件一行（含 tool.used）
 */
function formatFull(events) {
  return events.map((e, i) => formatLine(e, i));
}

// ── Compact 模式 ────────────────────────────────────────

/**
 * 聚合 key：用於判斷 tool.used 是否可合併
 */
function toolAggKey(event) {
  const d = event.data || {};
  if (event.type !== 'tool.used') return null;
  const tool = d.tool || '';
  const target = d.file || d.pattern || d.skill || d.command || d.url || d.query || '';
  return `${tool}::${target}`;
}

/**
 * Compact 模式：聚合壓縮，以 delegation 為段落分組
 *
 * 規則：
 * 1. delegation.start 和 stage.complete 作為段落邊界
 * 2. 段落內的 tool.used 按 tool+target 聚合
 * 3. noise 事件（compact.suggested, quality.test-needed）壓縮為計數
 * 4. prompt preview 在 delegation 下方縮排顯示
 */
function formatCompact(events, options = {}) {
  const lines = [];
  const hideNoise = options.hideNoise !== false; // 預設隱藏噪音
  let i = 0;

  while (i < events.length) {
    const event = events[i];

    // 噪音事件：收集連續同類型並顯示計數
    if (NOISE_TYPES.has(event.type) && hideNoise) {
      let count = 0;
      const noiseType = event.type;
      while (i < events.length && events[i].type === noiseType) {
        count++;
        i++;
      }
      // 只在計數 > 2 時顯示壓縮行
      if (count > 2) {
        const emoji = EMOJI_MAP[noiseType] || '📌';
        const label = noiseType === 'quality.test-needed' ? '測試提醒' : '壓縮建議';
        lines.push(`     [${formatTimeShort(event.timestamp)}] ${emoji} ${label} ×${count}`);
      } else {
        // 少量時逐行顯示
        for (let j = 0; j < count; j++) {
          const e = events[i - count + j];
          lines.push(`     [${formatTimeShort(e.timestamp)}] ${EMOJI_MAP[e.type] || '📌'} ${formatEventText(e)}`);
        }
      }
      continue;
    }

    // tool.used 事件：聚合連續同 tool+target
    if (event.type === 'tool.used') {
      const key = toolAggKey(event);
      let count = 1;
      const startTime = event.timestamp;
      let endTime = event.timestamp;

      // 向前看，跳過噪音事件，聚合相同 key 的 tool.used
      let j = i + 1;
      while (j < events.length) {
        if (NOISE_TYPES.has(events[j].type)) {
          j++;
          continue;
        }
        if (events[j].type === 'tool.used' && toolAggKey(events[j]) === key) {
          count++;
          endTime = events[j].timestamp;
          j++;
          continue;
        }
        break;
      }

      // 跳過聚合範圍中的噪音事件
      const detail = formatToolDetail(event.data);
      const countStr = count > 1 ? ` ×${count}` : '';
      lines.push(`     [${formatTimeShort(startTime)}] 🔧 ${detail}${countStr}`);
      i = j;
      continue;
    }

    // delegation.start：段落標題
    if (event.type === 'delegation.start') {
      const d = event.data || {};
      let line = `\n  [${formatTimeShort(event.timestamp)}] 🔀 → ${d.agentType || '?'}`;
      if (d.description) line += ` — "${d.description}"`;
      lines.push(line);
      if (d.promptPreview) {
        lines.push(`     📝 ${d.promptPreview}`);
      }
      i++;
      continue;
    }

    // stage.complete：段落結尾
    if (event.type === 'stage.complete') {
      const d = event.data || {};
      const v = d.verdict && d.verdict !== 'UNKNOWN' ? ` [${d.verdict}]` : '';
      lines.push(`  [${formatTimeShort(event.timestamp)}] ✅ ${d.stage} → ${d.nextStage || 'END'}${v}`);
      i++;
      continue;
    }

    // stage.retry：回退標記
    if (event.type === 'stage.retry') {
      const d = event.data || {};
      lines.push(`  [${formatTimeShort(event.timestamp)}] 🔄 ${d.stage} FAIL:${d.severity} (第 ${d.retryCount} 輪)`);
      i++;
      continue;
    }

    // pipeline.complete：重要里程碑
    if (event.type === 'pipeline.complete') {
      const d = event.data || {};
      lines.push(`\n  [${formatTimeShort(event.timestamp)}] 🎉 Pipeline 完成! [${(d.completedStages || []).join('→')}]\n`);
      i++;
      continue;
    }

    // 其他事件：正常顯示
    const emoji = EMOJI_MAP[event.type] || '📌';
    lines.push(`  [${formatTimeShort(event.timestamp)}] ${emoji} ${formatEventText(event)}`);
    i++;
  }

  return lines;
}

// ── Summary 模式 ────────────────────────────────────────

/**
 * Summary 模式：只顯示 pipeline 里程碑
 */
function formatSummary(events) {
  const milestones = events.filter(e =>
    ['session.start', 'task.classified', 'delegation.start', 'stage.complete',
     'stage.retry', 'pipeline.complete', 'pipeline.incomplete',
     'tool.blocked', 'compact.executed'].includes(e.type)
  );

  return milestones.map((e, i) => {
    const time = formatTimeShort(e.timestamp);
    const emoji = EMOJI_MAP[e.type] || '📌';
    const text = formatEventText(e);
    return `${String(i + 1).padStart(3)}. [${time}] ${emoji} ${text}`;
  });
}

// ── 統計 ────────────────────────────────────────────────

/**
 * 產生事件統計摘要
 */
function generateStats(events) {
  const typeCounts = {};
  events.forEach(e => {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  });

  // 按計數降序排列
  const sorted = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1]);

  const total = events.length;
  const lines = ['--- 事件統計 ---'];
  sorted.forEach(([type, count]) => {
    const emoji = EMOJI_MAP[type] || '📌';
    const pct = ((count / total) * 100).toFixed(1);
    lines.push(`  ${emoji} ${type.padEnd(22)} ${String(count).padStart(4)} (${pct}%)`);
  });
  lines.push(`  ${'合計'.padEnd(24)} ${String(total).padStart(4)}`);

  // 時間跨度
  if (events.length >= 2) {
    const start = new Date(events[0].timestamp);
    const end = new Date(events[events.length - 1].timestamp);
    const mins = Math.round((end - start) / 60000);
    lines.push(`  時長：${mins} 分鐘（${formatTime(events[0].timestamp)} → ${formatTime(events[events.length - 1].timestamp)}）`);
  }

  return lines;
}

// ── 主要 API ────────────────────────────────────────────

/**
 * 格式化 timeline 事件流
 *
 * @param {Object[]} events - timeline 事件陣列
 * @param {Object} [options] - 格式化選項
 * @param {string} [options.mode='compact'] - 模式：'full'|'compact'|'summary'
 * @param {boolean} [options.hideNoise=true] - 是否隱藏噪音事件
 * @param {boolean} [options.stats=false] - 是否附加統計
 * @returns {string[]} 格式化後的行陣列
 */
function formatTimeline(events, options = {}) {
  const mode = options.mode || 'compact';
  let lines;

  switch (mode) {
    case 'full':
      lines = formatFull(events);
      break;
    case 'summary':
      lines = formatSummary(events);
      break;
    case 'compact':
    default:
      lines = formatCompact(events, options);
      break;
  }

  if (options.stats) {
    lines.push('');
    lines.push(...generateStats(events));
  }

  return lines;
}

module.exports = {
  formatTimeline,
  formatLine,
  formatToolDetail,
  formatEventText,
  generateStats,
  EMOJI_MAP,
};
