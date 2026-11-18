/**
 * `boundCapturePayload` trims the oldest lines from whichever source holds the most, so one
 * chatty source cannot evict the others, and the result always fits the byte cap.
 */
import { describe, expect, it } from 'vitest';

import {
  boundCapturePayload,
  type NodeLogCapturePayload,
} from '../../../src/services/node-log-capture';

function lines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: `2026-11-03T12:${String(59 - (i % 60)).padStart(2, '0')}:00Z`,
    level: 'info',
    message: `${prefix} line ${i} ${'x'.repeat(80)}`,
  }));
}

function payload(agent: number, systemd: number, cloudInit: number): NodeLogCapturePayload {
  return {
    sources: {
      agent: { entries: lines('agent', agent), error: null },
      systemd: { entries: lines('systemd', systemd), error: null },
      'cloud-init': { entries: lines('cloud-init', cloudInit), error: null },
    },
  } as NodeLogCapturePayload;
}

describe('boundCapturePayload', () => {
  it('trims the chattiest source first and keeps every source represented', () => {
    const json = boundCapturePayload(payload(300, 20, 10), 12_000);
    const bounded = JSON.parse(json) as NodeLogCapturePayload;

    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(12_000);
    expect(bounded.sources.agent.entries.length).toBeLessThan(300);
    expect(bounded.sources.systemd.entries.length).toBeGreaterThan(0);
    expect(bounded.sources['cloud-init'].entries.length).toBe(10);
    // Newest first in, so the newest agent line survives.
    expect(bounded.sources.agent.entries[0]?.message).toContain('agent line 0 ');
  });

  it('returns the payload unchanged when it already fits', () => {
    const small = payload(2, 2, 2);
    expect(boundCapturePayload(small, 1_000_000)).toBe(JSON.stringify(small));
  });

  it('stops when every source is empty, even if the cap is tiny', () => {
    expect(() => boundCapturePayload(payload(0, 0, 0), 1)).not.toThrow();
  });
});
