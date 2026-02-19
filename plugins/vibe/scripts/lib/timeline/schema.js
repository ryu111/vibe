#!/usr/bin/env node
/**
 * schema.js — Timeline 事件類型定義與 envelope 建構
 *
 * 定義所有 timeline 事件的類型常數、分類群組、
 * envelope 建構函式和驗證邏輯。
 *
 * @module timeline/schema
 * @exports {Object} EVENT_TYPES - 33 種事件類型常數
 * @exports {Object} CATEGORIES - 事件分類群組
 * @exports {function} createEnvelope - 建構統一 envelope
 * @exports {function} validate - 驗證事件格式
 */
'use strict';
const crypto = require('crypto');

// ── 31 種事件類型（7 大類） ─────────────────────────────

const EVENT_TYPES = {
  // Session 生命週期
  SESSION_START:       'session.start',

  // Task 任務管理
  TASK_CLASSIFIED:     'task.classified',
  PROMPT_RECEIVED:     'prompt.received',
  DELEGATION_START:    'delegation.start',
  TASK_INCOMPLETE:     'task.incomplete',

  // Pipeline 階段流程
  STAGE_START:         'stage.start',
  STAGE_COMPLETE:      'stage.complete',
  STAGE_RETRY:         'stage.retry',
  PIPELINE_COMPLETE:   'pipeline.complete',
  PIPELINE_INCOMPLETE: 'pipeline.incomplete',
  // v4 Phase 1：路由協議相關事件
  ROUTE_FALLBACK:      'route.fallback',   // parseRoute 回退到 v3 VERDICT 解析
  RETRY_EXHAUSTED:     'retry.exhausted',  // 達到 maxRetries 上限
  // v4 Phase 4：Barrier 並行事件
  BARRIER_WAITING:     'barrier.waiting',  // barrier 部分完成，等待其他節點
  BARRIER_RESOLVED:    'barrier.resolved', // barrier 全部完成，已合併
  // v4 Phase 4：異常事件
  AGENT_CRASH:         'agent.crash',      // agent crash（無 PIPELINE_ROUTE 輸出）
  PIPELINE_ABORTED:    'pipeline.aborted', // route=ABORT，pipeline 異常終止
  PIPELINE_CANCELLED:  'pipeline.cancelled', // 使用者取消 pipeline
  BARRIER_CRASH_GUARD: 'barrier.crash-guard', // barrier sibling crashed，阻擋下游
  STAGE_CRASH_RECOVERY:'stage.crash-recovery', // Stop hook 自動回收 crashed stage

  // Agent 行為追蹤
  TOOL_USED:           'tool.used',

  // Quality 品質守衛
  TOOL_BLOCKED:        'tool.blocked',
  TOOL_GUARDED:        'tool.guarded',
  QUALITY_LINT:        'quality.lint',
  QUALITY_FORMAT:      'quality.format',
  QUALITY_TEST_NEEDED: 'quality.test-needed',

  // Remote/UI 互動
  ASK_QUESTION:        'ask.question',
  ASK_ANSWERED:        'ask.answered',
  TURN_SUMMARY:        'turn.summary',
  SAY_SENT:            'say.sent',
  SAY_COMPLETED:       'say.completed',
  COMPACT_SUGGESTED:   'compact.suggested',
  COMPACT_EXECUTED:    'compact.executed',

  // Safety 安全事件
  TRANSCRIPT_LEAK_WARNING: 'safety.transcript-leak', // transcript 洩漏警告
};

// ── 分類群組（供 consumer 過濾用） ─────────────────────

const CATEGORIES = {
  session:  ['session.start'],
  task:     ['task.classified', 'prompt.received', 'delegation.start', 'task.incomplete'],
  agent:    ['tool.used', 'delegation.start'],
  pipeline: ['stage.start', 'stage.complete', 'stage.retry', 'pipeline.complete', 'pipeline.incomplete', 'route.fallback', 'retry.exhausted', 'barrier.waiting', 'barrier.resolved', 'agent.crash', 'pipeline.aborted', 'pipeline.cancelled'],
  quality:  ['tool.blocked', 'tool.guarded', 'quality.lint', 'quality.format', 'quality.test-needed'],
  remote:   ['ask.question', 'ask.answered', 'turn.summary', 'say.sent', 'say.completed', 'compact.suggested', 'compact.executed'],
  safety:   ['agent.crash', 'pipeline.aborted', 'safety.transcript-leak'],
};

// 合法事件類型集合（快速查找用）
const VALID_TYPES = new Set(Object.values(EVENT_TYPES));

/**
 * 建構統一 envelope
 * @param {string} type - EVENT_TYPES 值
 * @param {string} sessionId - session 識別碼
 * @param {object} [data={}] - 類型特定 payload（應 < 1KB）
 * @returns {object} envelope { id, type, sessionId, timestamp, data }
 */
function createEnvelope(type, sessionId, data) {
  return {
    id: crypto.randomUUID(),
    type,
    sessionId,
    timestamp: Date.now(),
    data: data || {},
  };
}

/**
 * 驗證事件 envelope 格式
 * @param {object} event - 待驗證的事件物件
 * @returns {{ valid: boolean, error?: string }}
 */
function validate(event) {
  if (!event || typeof event !== 'object') {
    return { valid: false, error: 'event must be an object' };
  }
  if (typeof event.id !== 'string' || !event.id) {
    return { valid: false, error: 'missing or invalid id' };
  }
  if (!VALID_TYPES.has(event.type)) {
    return { valid: false, error: `unknown event type: ${event.type}` };
  }
  if (typeof event.sessionId !== 'string' || !event.sessionId) {
    return { valid: false, error: 'missing or invalid sessionId' };
  }
  if (typeof event.timestamp !== 'number' || event.timestamp <= 0) {
    return { valid: false, error: 'missing or invalid timestamp' };
  }
  if (typeof event.data !== 'object') {
    return { valid: false, error: 'data must be an object' };
  }
  return { valid: true };
}

/**
 * 取得指定分類的所有事件類型
 * @param {string} category - CATEGORIES 鍵名
 * @returns {string[]} 事件類型陣列
 */
function getTypesByCategory(category) {
  return CATEGORIES[category] || [];
}

module.exports = {
  EVENT_TYPES,
  CATEGORIES,
  VALID_TYPES,
  createEnvelope,
  validate,
  getTypesByCategory,
};
