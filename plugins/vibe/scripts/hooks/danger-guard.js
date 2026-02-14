#!/usr/bin/env node
/**
 * danger-guard.js — PreToolUse hook
 *
 * 攔截高風險 Bash 指令。
 * 強度：硬阻擋（exit 2 + stderr）。
 */
'use strict';
const path = require("path");
const hookLogger = require(path.join(__dirname, "..", "lib", "hook-logger.js"));
const { emit, EVENT_TYPES } = require(path.join(__dirname, "..", "lib", "timeline"));

const DANGER_PATTERNS = [
  {
    pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$)/,
    desc: "rm -rf /",
  },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, desc: "DROP TABLE/DATABASE" },
  {
    pattern: /\bgit\s+push\s+--force\s+(main|master)\b/,
    desc: "git push --force main/master",
  },
  {
    pattern: /\bgit\s+push\s+-f\s+(main|master)\b/,
    desc: "git push -f main/master",
  },
  { pattern: /\bchmod\s+777\b/, desc: "chmod 777" },
  { pattern: />\s*\/dev\/sd[a-z]/, desc: "寫入裝置檔案" },
  { pattern: /\bmkfs\b/, desc: "mkfs 格式化磁碟" },
  { pattern: /\bdd\s+.*of=\/dev\//, desc: "dd 寫入裝置" },
];

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';

    // 取得 Bash 指令
    const command = data.tool_input?.command || data.input?.command || "";

    if (!command) process.exit(0);

    // 比對危險模式
    for (const { pattern, desc } of DANGER_PATTERNS) {
      if (pattern.test(command)) {
        // Emit tool blocked event (before exit)
        emit(EVENT_TYPES.TOOL_BLOCKED, sessionId, {
          tool: 'Bash',
          command: command.slice(0, 100), // 限制長度避免過大
          matchedPattern: desc,
        });

        process.stderr.write(
          `⛔ danger-guard: 攔截危險指令 — ${desc}\n指令：${command}\n`,
        );
        process.exit(2);
      }
    }

    // 安全，靜默放行
  } catch (err) {
    hookLogger.error('danger-guard', err);
  }
});
