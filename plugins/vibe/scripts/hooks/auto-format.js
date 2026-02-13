#!/usr/bin/env node
/**
 * auto-format.js — PostToolUse hook
 *
 * Write/Edit 後自動套用格式化。
 * 強度：靜默（格式化成功不通知，失敗記 stderr）。
 * 未安裝 formatter 時靜默退出。
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

    // 查詢語言和 formatter
    const info = langMap.lookup(filePath);
    if (!info || !info.formatter) process.exit(0);

    // 偵測 formatter 是否已安裝
    const tools = toolDetector.detectTools(info);
    if (!tools.formatter) process.exit(0);

    // 組合格式化指令
    let fmtCmd;
    if (tools.formatter === "prettier") {
      fmtCmd = `prettier --write "${filePath}"`;
    } else if (tools.formatter === "ruff format") {
      fmtCmd = `ruff format "${filePath}"`;
    } else if (tools.formatter === "gofmt -w") {
      fmtCmd = `gofmt -w "${filePath}"`;
    } else {
      fmtCmd = `${tools.formatter} "${filePath}"`;
    }

    // 執行格式化（靜默）
    try {
      execSync(fmtCmd, { stdio: "pipe", timeout: 8000 });
    } catch (err) {
      process.stderr.write(`auto-format: ${err.message}\n`);
    }
  } catch (err) {
    process.stderr.write(`auto-format: ${err.message}\n`);
  }
});
