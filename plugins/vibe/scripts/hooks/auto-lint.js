#!/usr/bin/env node
/**
 * auto-lint.js — PostToolUse hook
 *
 * Write/Edit 後自動執行 lint --fix。
 * 強度：強建議（systemMessage 注入錯誤資訊）。
 * 未安裝 linter 時靜默退出。
 */
"use strict";
const { execSync } = require("child_process");
const path = require("path");

const langMap = require(path.join(__dirname, "..", "lib", "lang-map.js"));
const toolDetector = require(
  path.join(__dirname, "..", "lib", "tool-detector.js"),
);

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

    // 取得被修改的檔案路徑
    const filePath =
      data.tool_input?.file_path ||
      data.tool_input?.path ||
      data.input?.file_path ||
      null;

    if (!filePath) process.exit(0);

    // 查詢語言和 linter
    const info = langMap.lookup(filePath);
    if (!info || !info.linter) process.exit(0);

    // 偵測 linter 是否已安裝
    const tools = toolDetector.detectTools(info);
    if (!tools.linter) process.exit(0);

    // 執行 lint --fix
    const lintCmd = `${tools.linter} --fix "${filePath}"`;
    try {
      execSync(lintCmd, { stdio: "pipe", timeout: 12000 });
    } catch (err) {
      // lint 有錯誤（exit code !== 0）
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      const stdout = err.stdout ? err.stdout.toString().trim() : "";
      const output = stderr || stdout;

      if (output) {
        console.log(
          JSON.stringify({
            continue: true,
            systemMessage: `⚠️ Lint 發現問題（${info.lang}）：\n\`\`\`\n${output.slice(0, 500)}\n\`\`\`\n請修復上述 lint 錯誤。`,
          }),
        );
      }
      process.exit(0);
    }

    // lint 通過，靜默退出
  } catch (err) {
    process.stderr.write(`auto-lint: ${err.message}\n`);
  }
});
