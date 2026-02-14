#!/usr/bin/env node
/**
 * consumer.js — Timeline 消費端抽象
 *
 * 提供 createConsumer() 工廠函式，封裝 watch + parse + filter + 錯誤隔離。
 * 消費端只需宣告「關心哪些事件 + 收到後做什麼」。
 *
 * 回傳介面與 server-manager / bot-manager 風格對齊：
 * { start, stop, isActive }
 *
 * @module timeline/consumer
 * @exports {function} createConsumer - 建立 timeline 消費端
 */
'use strict';
const { watch, query } = require('./timeline');
const { CATEGORIES } = require('./schema');

/**
 * 建立 timeline 消費端
 *
 * @param {object} config
 * @param {string} config.name - 消費端名稱（用於 log 和除錯）
 * @param {string[]} [config.types] - 訂閱的事件類型（空=全部）
 *   可使用分類名稱（如 'pipeline'）自動展開為該分類所有類型
 * @param {Object.<string, function>} config.handlers - 事件處理器映射
 *   key 為事件類型或 '*'（萬用），value 為 (event) => void
 * @param {function} [config.onError] - 錯誤處理（預設：console.error）
 * @returns {{ start: function, stop: function, isActive: function, getStats: function }}
 *
 * @example
 * const consumer = createConsumer({
 *   name: 'dashboard',
 *   types: ['pipeline', 'quality'],  // 分類名稱自動展開
 *   handlers: {
 *     'stage.complete': (event) => broadcast(event),
 *     'quality.lint': (event) => showLintResult(event),
 *     '*': (event) => logEvent(event),
 *   },
 * });
 * consumer.start(sessionId);
 * // ... 稍後 ...
 * consumer.stop();
 */
function createConsumer(config) {
  const { name, handlers = {}, onError } = config;
  const errorHandler = onError || (() => {});

  // 展開分類名稱為事件類型
  const types = expandTypes(config.types);

  let watchHandle = null;
  let active = false;
  let stats = { eventsReceived: 0, errorsCount: 0, startedAt: null };

  /**
   * 展開類型列表（支援分類名稱）
   * @param {string[]} [typeList]
   * @returns {string[]|null} 展開後的類型列表，null 表示全部
   */
  function expandTypes(typeList) {
    if (!typeList || typeList.length === 0) return null;

    const expanded = new Set();
    for (const t of typeList) {
      if (CATEGORIES[t]) {
        // 分類名稱 → 展開為所有該分類事件
        for (const eventType of CATEGORIES[t]) {
          expanded.add(eventType);
        }
      } else {
        // 視為具體事件類型
        expanded.add(t);
      }
    }
    return Array.from(expanded);
  }

  /**
   * 處理收到的事件批次
   * @param {object[]} events
   */
  function handleEvents(events) {
    for (const event of events) {
      stats.eventsReceived++;
      try {
        // 精確匹配的 handler
        if (handlers[event.type]) {
          handlers[event.type](event);
        }
        // 萬用 handler
        if (handlers['*']) {
          handlers['*'](event);
        }
      } catch (err) {
        stats.errorsCount++;
        try {
          errorHandler(name, err, event);
        } catch (_) {}
      }
    }
  }

  return {
    /**
     * 開始監聽指定 session 的 timeline
     * @param {string} sessionId
     * @param {object} [opts]
     * @param {boolean} [opts.replay=false] - 是否重播歷史事件
     */
    start(sessionId, opts) {
      if (active) return;
      active = true;
      stats.startedAt = Date.now();

      // 可選：重播歷史事件
      if (opts && opts.replay) {
        try {
          const history = query(sessionId, { types: types || undefined });
          if (history.length > 0) {
            handleEvents(history);
          }
        } catch (_) {}
      }

      // 開始監聽新事件
      watchHandle = watch(sessionId, handleEvents, {
        types: types || undefined,
      });
    },

    /**
     * 停止監聽
     */
    stop() {
      if (!active) return;
      active = false;
      if (watchHandle) {
        watchHandle.stop();
        watchHandle = null;
      }
    },

    /**
     * 是否正在監聽
     * @returns {boolean}
     */
    isActive() {
      return active;
    },

    /**
     * 取得消費統計
     * @returns {{ name: string, eventsReceived: number, errorsCount: number, startedAt: number|null }}
     */
    getStats() {
      return { name, ...stats };
    },
  };
}

module.exports = { createConsumer };
