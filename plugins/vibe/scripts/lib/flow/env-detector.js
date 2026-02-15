#!/usr/bin/env node
/**
 * env-detector.js — 專案環境偵測
 *
 * 偵測順序（源自 ECC）：env var → 專案設定 → package.json → lock file → 全域設定 → fallback
 * 回傳結構化環境摘要。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 偵測專案環境
 * @param {string} cwd - 工作目錄
 * @returns {{ languages: Object, framework: Object|null, packageManager: Object|null, tools: Object }}
 */
function detect(cwd) {
  const result = {
    languages: { primary: null, secondary: [] },
    framework: null,
    packageManager: null,
    tools: { linter: null, formatter: null, test: null, bundler: null, designSystem: null },
  };

  // --- 語言偵測 ---
  const langSignals = {
    typescript: ['tsconfig.json', 'tsconfig.base.json'],
    javascript: ['jsconfig.json'],
    python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'requirements.txt'],
    go: ['go.mod'],
    rust: ['Cargo.toml'],
    java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    ruby: ['Gemfile'],
    php: ['composer.json'],
    swift: ['Package.swift'],
    csharp: ['*.csproj', '*.sln'],
  };

  const detectedLangs = [];
  for (const [lang, files] of Object.entries(langSignals)) {
    for (const file of files) {
      if (file.includes('*')) {
        // glob 模式 — 簡單檢查
        const ext = file.replace('*', '');
        try {
          const entries = fs.readdirSync(cwd);
          if (entries.some(e => e.endsWith(ext))) {
            detectedLangs.push(lang);
            break;
          }
        } catch (_) {}
      } else if (fs.existsSync(path.join(cwd, file))) {
        detectedLangs.push(lang);
        break;
      }
    }
  }

  // TypeScript 優先於 JavaScript
  if (detectedLangs.includes('typescript')) {
    result.languages.primary = 'typescript';
    result.languages.secondary = detectedLangs.filter(l => l !== 'typescript');
  } else if (detectedLangs.length > 0) {
    result.languages.primary = detectedLangs[0];
    result.languages.secondary = detectedLangs.slice(1);
  }

  // --- Package Manager 偵測 ---
  // 順序：env var → lock file → package.json
  const pmEnv = process.env.npm_config_user_agent;
  if (pmEnv) {
    if (pmEnv.includes('pnpm')) result.packageManager = { name: 'pnpm' };
    else if (pmEnv.includes('yarn')) result.packageManager = { name: 'yarn' };
    else if (pmEnv.includes('bun')) result.packageManager = { name: 'bun' };
    else result.packageManager = { name: 'npm' };
  } else {
    const lockFiles = {
      'pnpm-lock.yaml': 'pnpm',
      'yarn.lock': 'yarn',
      'bun.lockb': 'bun',
      'package-lock.json': 'npm',
    };
    for (const [file, pm] of Object.entries(lockFiles)) {
      if (fs.existsSync(path.join(cwd, file))) {
        result.packageManager = { name: pm, lockFile: file };
        break;
      }
    }
  }

  // --- 框架偵測 ---
  const pkgPath = path.join(cwd, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
  }

  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const frameworks = [
      { name: 'next.js', key: 'next' },
      { name: 'nuxt', key: 'nuxt' },
      { name: 'remix', key: '@remix-run/react' },
      { name: 'astro', key: 'astro' },
      { name: 'svelte', key: 'svelte' },
      { name: 'vue', key: 'vue' },
      { name: 'react', key: 'react' },
      { name: 'angular', key: '@angular/core' },
      { name: 'express', key: 'express' },
      { name: 'fastify', key: 'fastify' },
      { name: 'hono', key: 'hono' },
    ];
    for (const fw of frameworks) {
      if (allDeps[fw.key]) {
        result.framework = { name: fw.name, version: allDeps[fw.key].replace(/[\^~]/, '') };
        break;
      }
    }

    // 工具偵測
    const toolMap = {
      linter: ['eslint', 'biome', 'oxlint'],
      formatter: ['prettier', 'biome'],
      test: ['vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress'],
      bundler: ['turbopack', 'vite', 'webpack', 'esbuild', 'rollup', 'tsup'],
    };
    for (const [category, tools] of Object.entries(toolMap)) {
      for (const tool of tools) {
        if (allDeps[tool] || allDeps[`@${tool}/core`]) {
          result.tools[category] = tool;
          break;
        }
      }
    }
  }

  // Python 工具偵測
  if (result.languages.primary === 'python' || result.languages.secondary.includes('python')) {
    if (!result.packageManager) {
      const pyPMs = { 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv', 'uv.lock': 'uv' };
      for (const [file, pm] of Object.entries(pyPMs)) {
        if (fs.existsSync(path.join(cwd, file))) {
          result.packageManager = { name: pm, lockFile: file };
          break;
        }
      }
    }
    if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      try {
        const toml = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
        if (toml.includes('ruff')) result.tools.linter = result.tools.linter || 'ruff';
        if (toml.includes('black')) result.tools.formatter = result.tools.formatter || 'black';
        if (toml.includes('pytest')) result.tools.test = result.tools.test || 'pytest';
        if (toml.includes('mypy')) result.tools.bundler = 'mypy'; // 類型檢查作為 bundler 替代
      } catch (_) {}
    }
  }

  // Go 工具偵測
  if (result.languages.primary === 'go') {
    result.tools.test = result.tools.test || 'go test';
    result.tools.formatter = result.tools.formatter || 'gofmt';
  }

  // ui-ux-pro-max 偵測
  try {
    const { resolve } = require(path.join(__dirname, 'uiux-resolver.js'));
    if (resolve(cwd)) {
      result.tools.designSystem = 'ui-ux-pro-max';
    }
  } catch (_) {}

  return result;
}

module.exports = { detect };
