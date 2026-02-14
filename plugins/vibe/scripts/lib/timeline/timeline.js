#!/usr/bin/env node
/**
 * timeline.js — Timeline 核心模組
 *
 * 提供事件寫入（emit）、查詢（query）、監聽（watch）和清理（cleanup）。
 * 使用 append-only JSONL 檔案作為儲存，每個 session 獨立一個檔案。
 *
 * 檔案路徑：~/.claude/timeline-{sessionId}.jsonl
 *
 * @module timeline/timeline
 * @exports {function} emit - 寫入事件
 * @exports {function} query - 查詢事件
 * @exports {function} queryLast - 查詢指定類型最後一筆
 * @exports {function} watch - 監聽新事件
 * @exports {function} cleanup - 清理 session timeline
 * @exports {function} getPath - 取得 timeline 檔案路徑
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createEnvelope, validate } = require('./schema');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MAX_EVENTS = 2000;

/**
 * 取得 timeline JSONL 檔案路徑
 * @param {string} sessionId
 * @returns {string} ~/.claude/timeline-{sessionId}.jsonl
 */
function getPath(sessionId) {
  return path.join(CLAUDE_DIR, `timeline-${sessionId}.jsonl`);
}

/**
 * 寫入事件到 timeline JSONL
 *
 * 使用 appendFileSync 保證原子追加（POSIX 保證 < PIPE_BUF 的 write 原子性）。
 * emit 失敗不拋錯，靜默降級。
 *
 * @param {string} type - EVENT_TYPES 值
 * @param {string} sessionId - session 識別碼
 * @param {object} [data={}] - payload（應 < 1KB）
 * @returns {object|null} 寫入的 envelope，失敗回傳 null
 */
function emit(type, sessionId, data) {
  try {
    const envelope = createEnvelope(type, sessionId, data);
    const result = validate(envelope);
    if (!result.valid) return null;

    const filePath = getPath(sessionId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(envelope) + '\n';
    fs.appendFileSync(filePath, line);

    truncateIfNeeded(filePath);

    return envelope;
  } catch (_) {
    return null;
  }
}

/**
 * 超過 MAX_EVENTS 時保留後半部
 * @param {string} filePath
 */
function truncateIfNeeded(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_EVENTS) {
      const kept = lines.slice(-Math.floor(MAX_EVENTS / 2));
      fs.writeFileSync(filePath, kept.join('\n') + '\n');
    }
  } catch (_) {}
}

/**
 * 查詢 session 的事件流
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string[]} [opts.types] - 過濾事件類型
 * @param {number} [opts.since] - 起始 timestamp（不含）
 * @param {number} [opts.limit] - 最多回傳幾筆
 * @param {number} [opts.offset] - 跳過前 N 筆
 * @returns {object[]} 事件陣列
 */
function query(sessionId, opts) {
  try {
    const filePath = getPath(sessionId);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    let events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (_) {
        // 略過格式錯誤的行
      }
    }

    if (opts) {
      if (opts.types && opts.types.length > 0) {
        const typeSet = new Set(opts.types);
        events = events.filter(e => typeSet.has(e.type));
      }
      if (opts.since) {
        events = events.filter(e => e.timestamp > opts.since);
      }
      if (opts.offset) {
        events = events.splice(opts.offset);
      }
      if (opts.limit) {
        events = events.slice(0, opts.limit);
      }
    }

    return events;
  } catch (_) {
    return [];
  }
}

/**
 * 取得指定類型的最後一筆事件
 * @param {string} sessionId
 * @param {string} type - EVENT_TYPES 值
 * @returns {object|null} 最後一筆事件或 null
 */
function queryLast(sessionId, type) {
  try {
    const filePath = getPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    // 從尾部往前找
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === type) return event;
      } catch (_) {}
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 監聽 timeline 新事件（差量 tail）
 *
 * 使用 fs.watch 監聽檔案變更，讀取新增行並觸發 callback。
 * 回傳 stop handle 供呼叫者結束監聽。
 *
 * @param {string} sessionId
 * @param {function} callback - (events: object[]) => void
 * @param {object} [opts]
 * @param {string[]} [opts.types] - 過濾事件類型
 * @returns {{ stop: function }}
 */
function watch(sessionId, callback, opts) {
  const filePath = getPath(sessionId);
  let offset = 0;
  let watcher = null;
  let debounceTimer = null;
  const DEBOUNCE_MS = 50;

  // 初始化 offset 到檔案尾端（只監聽新事件）
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      offset = stat.size;
    }
  } catch (_) {}

  function readNew() {
    try {
      if (!fs.existsSync(filePath)) return;

      const stat = fs.statSync(filePath);
      if (stat.size <= offset) return;

      // 讀取新增部分
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n').filter(Boolean);

      let events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (_) {}
      }

      // 過濾
      if (opts && opts.types && opts.types.length > 0) {
        const typeSet = new Set(opts.types);
        events = events.filter(e => typeSet.has(e.type));
      }

      if (events.length > 0) {
        callback(events);
      }
    } catch (_) {}
  }

  // 確保目錄存在
  try {
    if (!fs.existsSync(CLAUDE_DIR)) {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    }
  } catch (_) {}

  // 如果檔案還不存在，先建空檔（讓 fs.watch 有目標）
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }
  } catch (_) {}

  try {
    watcher = fs.watch(filePath, () => {
      // 防抖：多次快速寫入只觸發一次讀取
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(readNew, DEBOUNCE_MS);
    });
  } catch (_) {}

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher) {
        try { watcher.close(); } catch (_) {}
        watcher = null;
      }
    },
  };
}

/**
 * 清理 session 的 timeline 檔案
 * @param {string} sessionId
 * @returns {boolean} 是否成功
 */
function cleanup(sessionId) {
  try {
    const filePath = getPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 列出所有 timeline session
 * @returns {string[]} sessionId 陣列
 */
function listSessions() {
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    return files
      .filter(f => f.startsWith('timeline-') && f.endsWith('.jsonl'))
      .map(f => f.replace('timeline-', '').replace('.jsonl', ''));
  } catch (_) {
    return [];
  }
}

module.exports = {
  emit,
  query,
  queryLast,
  watch,
  cleanup,
  listSessions,
  getPath,
  MAX_EVENTS,
};
