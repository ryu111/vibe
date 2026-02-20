#!/usr/bin/env node
/**
 * phase-parser.js — Tasks.md Phase 結構解析器（S3.3~S3.6）
 *
 * 解析 tasks.md 中的 phase 分組結構，自動生成 suffixed stage DAG，
 * 支援 Phase 間依賴（deps → DAG edges）與獨立 phase 並行。
 *
 * 公開 API：
 * - parsePhasesFromTasks(tasksContent) → Phase 陣列
 * - generatePhaseDag(phases, pipelineId) → suffixed stage DAG 物件
 *
 * 設計原則：
 * - 純函式模組（無副作用），所有輸入明確，方便測試
 * - 退化安全：無 phase 結構時回傳空陣列
 *
 * @module flow/phase-parser
 */
'use strict';

// Pipeline 對應的階段選擇（每個 phase 包含哪些 stage）
// standard: DEV → REVIEW + TEST（barrier 並行）→ DOCS
// quick-dev: DEV → REVIEW + TEST（barrier 並行，無 DOCS）
// full: DEV → REVIEW + TEST（barrier 並行）→ DOCS
// 其他只有 DEV 的 pipeline 退化為無 phase 模式
const PIPELINE_PHASE_STAGES = {
  standard: ['DEV', 'REVIEW', 'TEST'],
  full:     ['DEV', 'REVIEW', 'TEST'],
  'quick-dev': ['DEV', 'REVIEW', 'TEST'],
  security: ['DEV', 'REVIEW', 'TEST'],
};

// 需要 DOCS 作為最終階段的 pipeline
const PIPELINES_WITH_DOCS = new Set(['standard', 'full']);

// REVIEW 與 TEST 構成 barrier（並行品質門）的 pipeline
const PIPELINES_WITH_BARRIER = new Set(['standard', 'full', 'quick-dev', 'security']);

// ────────────────── parsePhasesFromTasks ──────────────────

/**
 * 解析 tasks.md 內容，提取 phase 分組結構。
 *
 * 解析規則：
 * - `## Phase N: 標題` 開始新 phase（N 為正整數）
 * - `deps: [Phase M, Phase K]` 行解析依賴關係
 * - `- [ ] task` 或 `- [x] task` 收集 task 列表
 * - phase 外的 task 忽略
 * - 無 phase 結構時返回空陣列（退化條件）
 *
 * @param {string|null|undefined} tasksContent - tasks.md 的文字內容
 * @returns {Array<{
 *   name: string,       // 完整 phase 名稱，如 'Phase 1: Auth Login'
 *   index: number,      // phase 索引（1-based）
 *   deps: string[],     // 依賴的 phase 名稱陣列，如 ['Phase 1']
 *   tasks: string[]     // task 列表（純文字，不含 [ ] 前綴）
 * }>}
 */
function parsePhasesFromTasks(tasksContent) {
  // 空輸入或非字串 → 退化
  if (!tasksContent || typeof tasksContent !== 'string') return [];

  const lines = tasksContent.split('\n');
  const phases = [];
  let currentPhase = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // 偵測 phase 標題：## Phase N: 標題
    const phaseMatch = trimmed.match(/^##\s+Phase\s+(\d+)(?:\s*:\s*(.*))?$/i);
    if (phaseMatch) {
      // 儲存上一個 phase
      if (currentPhase) phases.push(currentPhase);

      const phaseIndex = parseInt(phaseMatch[1], 10);
      const phaseTitle = (phaseMatch[2] || '').trim();
      const phaseName = phaseTitle
        ? `Phase ${phaseIndex}: ${phaseTitle}`
        : `Phase ${phaseIndex}`;

      currentPhase = {
        name: phaseName,
        index: phaseIndex,
        deps: [],
        tasks: [],
      };
      continue;
    }

    // 偵測其他 ## 標題（非 Phase 格式）→ 結束當前 phase
    // 這樣 phase 外的 task 不會被錯誤歸入前一個 phase
    if (trimmed.startsWith('##') && currentPhase) {
      phases.push(currentPhase);
      currentPhase = null;
      continue;
    }

    // 在 phase 內才處理以下內容
    if (!currentPhase) continue;

    // 偵測 deps 行：deps: [Phase M, Phase K]
    const depsMatch = trimmed.match(/^deps\s*:\s*\[([^\]]*)\]/i);
    if (depsMatch) {
      const depsStr = depsMatch[1].trim();
      if (depsStr) {
        // 以逗號分割，去除空白，過濾空字串
        currentPhase.deps = depsStr
          .split(',')
          .map(d => d.trim())
          .filter(d => d.length > 0);
      }
      continue;
    }

    // 偵測 task 項目：- [ ] task 或 - [x] task
    const taskMatch = trimmed.match(/^-\s+\[[ xX]\]\s+(.+)$/);
    if (taskMatch) {
      currentPhase.tasks.push(taskMatch[1].trim());
      continue;
    }
  }

  // 儲存最後一個 phase
  if (currentPhase) phases.push(currentPhase);

  return phases;
}

// ────────────────── resolvePhaseDeps ──────────────────

/**
 * 解析 phase 依賴關係，計算每個 phase 的直接上游（依賴的 phase index 陣列）。
 *
 * deps 欄位為 phase 名稱字串，需要轉換為 index 以便 DAG 生成。
 * 無法解析的 dep 名稱靜默忽略（容錯設計）。
 *
 * @param {Array<{name: string, index: number, deps: string[]}>} phases
 * @returns {Map<number, number[]>} phaseIndex → 依賴的 phaseIndex 陣列
 */
function resolvePhaseDeps(phases) {
  // 建立 phase 名稱 → index 的映射（支援多種匹配模式）
  const nameToIndex = new Map();
  for (const phase of phases) {
    // 全名匹配：'Phase 1: Auth Login'
    nameToIndex.set(phase.name.toLowerCase(), phase.index);
    // 簡短名稱匹配：'Phase 1'
    nameToIndex.set(`phase ${phase.index}`, phase.index);
    // 如果有標題，也加入標題匹配
    const titleMatch = phase.name.match(/^Phase \d+:\s*(.+)$/i);
    if (titleMatch) {
      nameToIndex.set(titleMatch[1].trim().toLowerCase(), phase.index);
    }
  }

  const depMap = new Map();
  for (const phase of phases) {
    const resolvedDeps = [];
    for (const dep of phase.deps) {
      const depLower = dep.toLowerCase();
      const depIndex = nameToIndex.get(depLower);
      if (depIndex !== undefined && depIndex !== phase.index) {
        resolvedDeps.push(depIndex);
      }
    }
    depMap.set(phase.index, resolvedDeps);
  }

  return depMap;
}

// ────────────────── hasCyclicDeps ──────────────────

/**
 * 拓撲排序（Kahn's Algorithm）驗證 phase 依賴圖是否有循環。
 *
 * @param {Array<{index: number, deps: string[]}>} phases
 * @param {Map<number, number[]>} depMap - phaseIndex → 依賴 phaseIndex 陣列
 * @returns {boolean} true 表示有循環依賴
 */
function hasCyclicDeps(phases, depMap) {
  // 建立 inDegree（入度）計數和鄰接表
  const inDegree = new Map();
  const adjacency = new Map();

  for (const phase of phases) {
    inDegree.set(phase.index, 0);
    adjacency.set(phase.index, []);
  }

  // 根據 depMap 建立邊：dep → phase（dep 完成後 phase 才能執行）
  for (const phase of phases) {
    const deps = depMap.get(phase.index) || [];
    inDegree.set(phase.index, deps.length);
    for (const dep of deps) {
      if (!adjacency.has(dep)) continue; // 未知節點忽略
      adjacency.get(dep).push(phase.index);
    }
  }

  // BFS：從入度為 0 的節點開始
  const queue = [];
  for (const [idx, degree] of inDegree) {
    if (degree === 0) queue.push(idx);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    processed++;
    for (const next of (adjacency.get(current) || [])) {
      const newDegree = inDegree.get(next) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) queue.push(next);
    }
  }

  // 若 processed < phases.length → 有循環（Kahn's 定理）
  return processed < phases.length;
}

// ────────────────── generatePhaseDag ──────────────────

/**
 * 從 phase 結構產出 suffixed stage DAG。
 *
 * 生成邏輯：
 * - 每個 phase 產生 DEV:N → REVIEW:N + TEST:N（根據 pipelineId 選擇 stage 組合）
 * - REVIEW:N 和 TEST:N 設 barrier（若 pipeline 支援）
 * - phase 間依賴透過 deps 建立 DAG edges（DEV:N deps 上游 phase 的品質 stages）
 * - 最後一個 step 加入 DOCS（如果 pipeline 需要）
 * - 單 phase 退化為普通 DAG（無 suffix）
 *
 * 退化條件：
 * - phases.length < 2 → 回傳空物件（呼叫方退化到現有行為）
 * - pipelineId 不在 PIPELINE_PHASE_STAGES → 回傳空物件
 *
 * @param {Array<{name: string, index: number, deps: string[], tasks: string[]}>} phases
 * @param {string} pipelineId - pipeline ID（決定每 phase 的 stage 組合）
 * @returns {Object} suffixed stage DAG 物件
 *
 * @example
 * // Phase 1（deps:[]）+ Phase 2（deps:[Phase 1]）+ Phase 3（deps:[Phase 1]）
 * // Phase 2 和 Phase 3 都依賴 Phase 1 → 可並行
 * generatePhaseDag(phases, 'standard')
 * // →
 * // {
 * //   'DEV:1': { deps: [] },
 * //   'REVIEW:1': { deps: ['DEV:1'] },
 * //   'TEST:1': { deps: ['DEV:1'], barrier: { group: 'quality:1', total: 2, next: 'DEV:2', siblings: [...] } },
 * //   'DEV:2': { deps: ['REVIEW:1', 'TEST:1'] },
 * //   ...
 * //   'DOCS': { deps: [...所有最終品質 stages...] }
 * // }
 */
function generatePhaseDag(phases, pipelineId) {
  // 退化條件：不足 2 個 phase 或不支援的 pipeline
  if (!phases || phases.length < 2) return {};

  const phaseStages = PIPELINE_PHASE_STAGES[pipelineId];
  if (!phaseStages) return {};

  const hasBarrier = PIPELINES_WITH_BARRIER.has(pipelineId);
  const hasDocs = PIPELINES_WITH_DOCS.has(pipelineId);
  const hasQuality = phaseStages.includes('REVIEW') && phaseStages.includes('TEST');

  // 解析 phase 依賴關係
  const depMap = resolvePhaseDeps(phases);

  // M-1：循環依賴偵測（拓撲排序）— 有循環則退化為空物件
  if (hasCyclicDeps(phases, depMap)) return {};

  const dag = {};

  // 為每個 phase 建立 stage 節點
  for (const phase of phases) {
    const n = phase.index;
    const upstreamDeps = depMap.get(n) || [];

    // 計算 DEV:N 的 deps：
    // - 無依賴 phase → []
    // - 有依賴 phase M → 等待 M 的所有品質 stages 完成
    const devDeps = [];
    for (const upIdx of upstreamDeps) {
      // 加入上游 phase 的品質 stages（REVIEW + TEST）
      if (hasQuality) {
        const reviewId = `REVIEW:${upIdx}`;
        const testId = `TEST:${upIdx}`;
        if (!devDeps.includes(reviewId)) devDeps.push(reviewId);
        if (!devDeps.includes(testId)) devDeps.push(testId);
      } else {
        // 無品質階段，依賴上游 DEV
        const devId = `DEV:${upIdx}`;
        if (!devDeps.includes(devId)) devDeps.push(devId);
      }
    }

    // DEV:N
    dag[`DEV:${n}`] = { deps: devDeps };

    if (hasQuality) {
      // 計算 barrier 配置
      // 找出哪些 phase 在 DEV:N 完成後可以並行（共享同一 DEV:N 作為 phase 起點）
      // barrier 的 next 是：依賴此 phase 的下一批 DEV stages，或 DOCS
      let barrierConfig = null;

      if (hasBarrier) {
        const reviewId = `REVIEW:${n}`;
        const testId = `TEST:${n}`;
        const siblings = [reviewId, testId];

        // 計算 barrier.next：找出所有 deps 中包含此 phase 品質 stages 的後繼 DEV
        // 在 DAG 建立完成後再回填，這裡先存 null
        barrierConfig = {
          group: `quality:${n}`,
          total: 2,
          next: null, // 稍後回填
          siblings,
        };
      }

      // REVIEW:N — 含 onFail（回退到 DEV:N）和 maxRetries
      dag[`REVIEW:${n}`] = {
        deps: [`DEV:${n}`],
        onFail: `DEV:${n}`,
        maxRetries: 3,
        ...(barrierConfig ? { barrier: { ...barrierConfig } } : {}),
      };

      // TEST:N — 含 onFail（回退到 DEV:N）和 maxRetries
      dag[`TEST:${n}`] = {
        deps: [`DEV:${n}`],
        onFail: `DEV:${n}`,
        maxRetries: 3,
        ...(barrierConfig ? { barrier: { ...barrierConfig } } : {}),
      };
    }
  }

  // 回填 barrier.next：找出依賴此 phase 品質 stages 的後繼 DEV stages
  if (hasBarrier && hasQuality) {
    for (const phase of phases) {
      const n = phase.index;
      const reviewId = `REVIEW:${n}`;
      const testId = `TEST:${n}`;

      // 找出所有 deps 包含 REVIEW:N 或 TEST:N 的 DEV stage（後繼 phase）
      const successorDevs = [];
      for (const [stageId, stageConfig] of Object.entries(dag)) {
        if (!stageId.startsWith('DEV:')) continue;
        const deps = stageConfig.deps || [];
        if (deps.includes(reviewId) || deps.includes(testId)) {
          successorDevs.push(stageId);
        }
      }

      // 更新 barrier.next
      const nextStage = successorDevs.length > 0
        ? successorDevs[0] // 通常只有一個或第一個後繼
        : null; // 沒有後繼（最終 phase）

      if (dag[reviewId]?.barrier) {
        dag[reviewId].barrier.next = nextStage;
      }
      if (dag[testId]?.barrier) {
        dag[testId].barrier.next = nextStage;
      }
    }
  }

  // 加入 DOCS（如果需要）：deps 為所有最終品質 stages（無後繼 phase 的 REVIEW/TEST）
  if (hasDocs && hasQuality) {
    const finalQualityStages = [];
    for (const phase of phases) {
      const n = phase.index;
      const reviewId = `REVIEW:${n}`;
      const testId = `TEST:${n}`;

      // 最終 phase 的品質 stage：沒有任何後繼 DEV 依賴它們
      const reviewHasSuccessor = Object.values(dag).some(c =>
        (c.deps || []).includes(reviewId)
      );
      const testHasSuccessor = Object.values(dag).some(c =>
        (c.deps || []).includes(testId)
      );

      if (!reviewHasSuccessor) finalQualityStages.push(reviewId);
      if (!testHasSuccessor) finalQualityStages.push(testId);
    }

    if (finalQualityStages.length > 0) {
      dag['DOCS'] = { deps: finalQualityStages };
    }
  }

  return dag;
}

// ────────────────── Exports ──────────────────

module.exports = {
  parsePhasesFromTasks,
  generatePhaseDag,
  resolvePhaseDeps,
  PIPELINE_PHASE_STAGES,
  PIPELINES_WITH_DOCS,
  PIPELINES_WITH_BARRIER,
};
