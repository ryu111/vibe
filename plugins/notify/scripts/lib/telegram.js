#!/usr/bin/env node
/**
 * telegram.js — Telegram Bot API 封裝
 *
 * 提供：getCredentials / sendMessage / getUpdates / getMe
 * 零外部依賴，純 Node.js https 模組。
 */
'use strict';
const https = require('https');

const API_BASE = 'https://api.telegram.org/bot';
const SEND_TIMEOUT = 8000;   // sendMessage timeout
const POLL_TIMEOUT = 30;     // getUpdates long polling（秒）

/**
 * 從環境變數讀取 Telegram 認證
 * @returns {{ token: string, chatId: string } | null}
 */
function getCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/**
 * 通用 Telegram API 呼叫
 * @param {string} token
 * @param {string} method
 * @param {object} body
 * @param {number} [timeout]
 * @returns {Promise<object>}
 */
function apiCall(token, method, body, timeout) {
  timeout = timeout || SEND_TIMEOUT;
  const payload = JSON.stringify(body);
  const url = new URL(`${API_BASE}${token}/${method}`);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(`Telegram API ${method}: ${parsed.description || 'unknown error'}`));
          }
        } catch (err) {
          reject(new Error(`Telegram API ${method}: invalid JSON response`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Telegram API ${method}: timeout (${timeout}ms)`));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * 發送訊息到指定 chat
 * @param {string} token
 * @param {string} chatId
 * @param {string} text — 支援 Markdown
 * @returns {Promise<object>}
 */
function sendMessage(token, chatId, text) {
  return apiCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  });
}

/**
 * Long polling 取得新訊息
 * @param {string} token
 * @param {number} offset — 上次 update_id + 1
 * @param {number} [timeout] — long polling 秒數
 * @returns {Promise<Array>}
 */
function getUpdates(token, offset, timeout) {
  timeout = timeout || POLL_TIMEOUT;
  return apiCall(token, 'getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message'],
  }, (timeout + 5) * 1000); // HTTP timeout 略大於 long polling timeout
}

/**
 * 驗證 Bot Token 有效性
 * @param {string} token
 * @returns {Promise<object>} — Bot 資訊
 */
function getMe(token) {
  return apiCall(token, 'getMe', {});
}

module.exports = { getCredentials, sendMessage, getUpdates, getMe };
