#!/usr/bin/env node
/**
 * task-classifier.js — UserPromptSubmit hook
 *
 * v4.0.0 LLM-first：async handler，classifyWithConfidence() 呼叫 LLM。
 * 所有業務邏輯移至 pipeline-controller.js。
 */
'use strict';
const path = require('path');

const { safeRun } = require(path.join(__dirname, '..', 'lib', 'hook-utils.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const ctrl = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-controller.js'));

safeRun('task-classifier', async (data) => {
  const prompt = data.prompt || data.user_prompt || data.content || '';
  const sessionId = data.session_id || 'unknown';

  emit(EVENT_TYPES.PROMPT_RECEIVED, sessionId, {});

  const result = await ctrl.classify(sessionId, prompt);

  if (result.output) {
    console.log(JSON.stringify(result.output));
  }
});
