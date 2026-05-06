/**
 * Scenario: Weather Baseline (continuity with existing experiment)
 *
 * Tests the two-tool loop: get_weather -> calculate -> final answer.
 * This is the same test from experiments/ai-gateway-tool-call/experiment.ts
 * preserved for continuity and regression detection.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { makeGetWeather, makeCalculate } from '../tools.js';

const scenario: EvalScenario = {
  id: 'weather-baseline',
  name: 'Weather Baseline (Two-Tool Loop)',
  category: 'baseline',
  description: 'Model calls get_weather, then calculate to convert F→C, then gives a final answer.',

  systemPrompt:
    'You are a helpful assistant. Use the provided tools to answer questions. When you need to convert temperature, use the calculate tool.',

  userPrompt: 'What is the weather in Paris right now? Also tell me the temperature in Celsius.',

  tools: [makeGetWeather(), makeCalculate()],

  maxTurns: 6,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'used_get_weather',
        pass: run.toolCalls.some((tc) => tc.toolName === 'get_weather'),
        detail: 'Model should call get_weather',
      },
      {
        name: 'used_calculate',
        pass: run.toolCalls.some((tc) => tc.toolName === 'calculate'),
        detail: 'Model should call calculate for F→C conversion',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete (not max_turns or error)',
      },
      {
        name: 'final_answer_has_celsius',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /22|celsius|°C/i.test(m.content),
        ),
        detail: 'Final answer should mention the Celsius temperature (~22°C)',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Two-tool weather loop completed successfully'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
