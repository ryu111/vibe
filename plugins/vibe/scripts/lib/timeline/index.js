#!/usr/bin/env node
/**
 * timeline/index.js — Timeline 模組入口
 *
 * Re-export 所有子模組，提供統一的引入介面：
 *   const { emit, query, watch, createConsumer, EVENT_TYPES } = require('./timeline');
 *
 * @module timeline
 */
'use strict';
const { emit, query, queryLast, watch, cleanup, listSessions, getPath, MAX_EVENTS } = require('./timeline');
const { EVENT_TYPES, CATEGORIES, VALID_TYPES, createEnvelope, validate, getTypesByCategory } = require('./schema');
const { createConsumer } = require('./consumer');
const { formatTimeline, formatLine, formatToolDetail, formatEventText, generateStats, EMOJI_MAP } = require('./formatter');

module.exports = {
  // timeline.js
  emit,
  query,
  queryLast,
  watch,
  cleanup,
  listSessions,
  getPath,
  MAX_EVENTS,

  // schema.js
  EVENT_TYPES,
  CATEGORIES,
  VALID_TYPES,
  createEnvelope,
  validate,
  getTypesByCategory,

  // consumer.js
  createConsumer,

  // formatter.js
  formatTimeline,
  formatLine,
  formatToolDetail,
  formatEventText,
  generateStats,
  EMOJI_MAP,
};
