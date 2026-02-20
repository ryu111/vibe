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
        result.framework = { name: fw.name, version: allDeps[fw.key].replace(/[\^~]/g, '') };
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
        if (toml.includes('mypy')) result.tools.typeChecker = 'mypy';
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

  // 前端信號偵測
  result.frontend = detectFrontendSignals(cwd, pkg);

  return result;
}

/**
 * 前端信號偵測（啟發式三層偵測）
 * @param {string} cwd - 工作目錄
 * @param {Object|null} pkg - package.json 內容
 * @returns {{ detected: boolean, signals: string[], confidence: string }}
 */
function detectFrontendSignals(cwd, pkg) {
  const signals = [];

  // Layer 1: UI 庫 deps（高信心度）
  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const uiLibs = [
      '@mui/material', '@chakra-ui/react', 'antd', '@headlessui/react',
      '@radix-ui/react-dialog', 'solid-js', '@solidjs/router',
      'preact', '@preact/signals', 'lit', '@lit/reactive-element',
      '@angular/material', 'vuetify', 'element-plus',
      'tailwindcss', '@tailwindcss/forms',
      'styled-components', '@emotion/react', '@emotion/styled',
    ];
    for (const lib of uiLibs) {
      if (allDeps[lib]) {
        signals.push(`dep:${lib}`);
      }
    }
  }

  // Layer 2: 配置檔（中信心度）
  const configPatterns = [
    { prefix: 'tailwind.config', signal: 'config:tailwind' },
    { prefix: 'postcss.config', signal: 'config:postcss' },
    { prefix: '.storybook', signal: 'dir:storybook', isDir: true },
  ];

  try {
    const entries = fs.readdirSync(cwd);
    for (const { prefix, signal, isDir } of configPatterns) {
      if (isDir) {
        if (entries.includes(prefix)) {
          try {
            if (fs.statSync(path.join(cwd, prefix)).isDirectory()) {
              signals.push(signal);
            }
          } catch (_) {}
        }
      } else {
        if (entries.some(e => e.startsWith(prefix))) {
          signals.push(signal);
        }
      }
    }
  } catch (_) {}

  // Layer 3: 目錄結構（中信心度，需 pkg 存在避免 Go/Python 誤判）
  if (pkg) {
    const uiDirs = ['src/components', 'src/pages', 'src/views', 'src/layouts', 'components', 'pages'];
    for (const dir of uiDirs) {
      try {
        const dirPath = path.join(cwd, dir);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          signals.push(`dir:${dir.split('/').pop()}`);
        }
      } catch (_) {}
    }
  }

  const detected = signals.length > 0;
  const confidence = signals.length >= 3 ? 'high' : (signals.length >= 1 ? 'medium' : 'none');

  return { detected, signals, confidence };
}

module.exports = { detect };
