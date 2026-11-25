/**
 * The VM agent tells a SAM AI usage-limit refusal from a provider overload by the refusal's
 * message (packages/vm-agent/internal/acp/sam_usage_limit.go, samUsageLimitMarkers). Both are
 * 429s, so if a message here drifts away from those markers, users see "Provider overloaded"
 * again (idea 01M89JXTFHW4W3PQ65GTED6D0K). Keep this list identical to the Go one.
 */
import { monthlyCostCapMessage } from '@simple-agent-manager/ai-proxy';
import { describe, expect, it } from 'vitest';

import { anthropicUsageGateError as anthropicSupportError } from '../../../src/routes/ai-proxy-anthropic-support';
import {
  anthropicUsageGateError,
  openaiUsageGateError,
} from '../../../src/routes/ai-proxy-passthrough-errors';

const GO_MARKERS = [
  'monthly ai spending limit reached',
  'monthly cost cap exceeded',
  'daily token budget exceeded',
];

const administrator = { allowed: false, limitSource: 'administrator' } as Parameters<
  typeof monthlyCostCapMessage
>[0];

describe('SAM AI usage-limit refusals carry a marker the VM agent recognizes', () => {
  it.each([
    ['administrator ceiling', monthlyCostCapMessage(administrator)],
    ['personal cap', monthlyCostCapMessage(undefined)],
  ])('monthly message: %s', (_name, message) => {
    expect(GO_MARKERS.some((marker) => message.toLowerCase().includes(marker))).toBe(true);
  });

  it.each([
    ['anthropic passthrough', anthropicUsageGateError],
    ['anthropic support', anthropicSupportError],
    ['openai passthrough', openaiUsageGateError],
  ])('%s: every refusal is a 429 whose message has a marker', async (_name, build) => {
    for (const response of [
      build('daily-token-budget'),
      build('monthly-cost-cap', administrator),
      build('monthly-cost-cap'),
    ]) {
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: { message: string } };
      const message = body.error.message.toLowerCase();
      expect(GO_MARKERS.some((marker) => message.includes(marker))).toBe(true);
    }
  });
});
