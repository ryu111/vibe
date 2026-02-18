/**
 * atomic-write.test.js — atomicWrite() 單元測試
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('../scripts/lib/flow/atomic-write.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`❌ ${name}: ${err.message}`);
  }
}

// 暫存測試目錄
const tmpDir = path.join(os.tmpdir(), `atomic-write-test-${process.pid}`);
fs.mkdirSync(tmpDir, { recursive: true });

// ──── 正常寫入 ────

test('寫入字串到現有目錄', () => {
  const filePath = path.join(tmpDir, 'test-string.txt');
  atomicWrite(filePath, 'hello world');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'hello world');
});

test('寫入 JSON 物件（自動序列化）', () => {
  const filePath = path.join(tmpDir, 'test-object.json');
  const data = { key: 'value', num: 42, arr: [1, 2, 3] };
  atomicWrite(filePath, data);
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);
  assert.deepStrictEqual(parsed, data);
});

test('覆寫已存在的檔案', () => {
  const filePath = path.join(tmpDir, 'overwrite.txt');
  atomicWrite(filePath, 'original');
  atomicWrite(filePath, 'updated');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'updated');
});

// ──── 目錄不存在時自動建立 ────

test('目錄不存在時自動建立（recursive）', () => {
  const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
  const filePath = path.join(nestedDir, 'nested.txt');
  atomicWrite(filePath, 'nested content');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'nested content');
  assert.ok(fs.existsSync(nestedDir));
});

// ──── .tmp 暫存檔不留存 ────

test('寫入完成後不留存 .tmp 暫存檔', () => {
  const filePath = path.join(tmpDir, 'no-tmp.txt');
  atomicWrite(filePath, 'data');
  const files = fs.readdirSync(tmpDir);
  const tmpFiles = files.filter(f => f.includes('.tmp.'));
  assert.strictEqual(tmpFiles.length, 0, `不應有 .tmp 檔案殘留：${tmpFiles.join(', ')}`);
});

// ──── JSON 格式化 ────

test('JSON 物件以縮排格式序列化', () => {
  const filePath = path.join(tmpDir, 'formatted.json');
  atomicWrite(filePath, { a: 1 });
  const content = fs.readFileSync(filePath, 'utf8');
  // JSON.stringify(data, null, 2) 應含縮排
  assert.ok(content.includes('\n'), '應含換行（縮排格式）');
});

test('空字串寫入', () => {
  const filePath = path.join(tmpDir, 'empty.txt');
  atomicWrite(filePath, '');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');
});

test('空物件寫入', () => {
  const filePath = path.join(tmpDir, 'empty-obj.json');
  atomicWrite(filePath, {});
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);
  assert.deepStrictEqual(parsed, {});
});

// ──── 清理測試目錄 ────

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

// ──── 結果 ────

console.log(`\n atomic-write: ${passed} 通過, ${failed} 失敗`);
if (failed > 0) process.exit(1);
