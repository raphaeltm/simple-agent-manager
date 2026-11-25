/**
 * The VM agent tells a SAM AI usage-limit refusal from a provider overload by the refusal's
 * message (packages/vm-agent/internal/acp/sam_usage_limit.go, samUsageLimitMarkers). Both are
 * 429s, so if a message here drifts away from those markers, users see "Provider overloaded"
 * again (idea 01M89JXTFHW4W3PQ65GTED6D0K). The markers are read from the Go source itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { monthlyCostCapMessage } from '@simple-agent-manager/ai-proxy';
import { describe, expect, it } from 'vitest';

import { anthropicUsageGateError as anthropicSupportError } from '../../../src/routes/ai-proxy-anthropic-support';
import {
  anthropicUsageGateError,
  openaiUsageGateError,
} from '../../../src/routes/ai-proxy-passthrough-errors';

/** The marker list as the VM agent compiles it, read from its source rather than copied. */
function goMarkers(): string[] {
  const source = readFileSync(
    resolve(__dirname, '../../../../../packages/vm-agent/internal/acp/sam_usage_limit.go'),
    'utf8'
  );
  const block = /var samUsageLimitMarkers = \[\]string\{([^}]*)\}/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}
const GO_MARKERS = goMarkers();

it('reads the VM agent marker list (a broken parse cannot pass as an empty list)', () => {
  expect(GO_MARKERS).toHaveLength(3);
  expect(GO_MARKERS.every((m) => m === m.toLowerCase())).toBe(true);
});

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
