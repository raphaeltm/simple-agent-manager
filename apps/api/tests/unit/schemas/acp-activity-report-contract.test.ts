import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { AcpSessionActivityReportSchema } from '../../../src/schemas/acp-sessions';

/**
 * Cross-boundary contract test (.claude/rules/23).
 *
 * The vm-agent serializes `activityPayload`
 * (`packages/vm-agent/internal/acp/session_host_reporting.go`) and this Worker
 * schema validates it. Previously each side was tested only against itself — the
 * Go test round-tripped its own struct through its own json tags, and the Worker
 * route test hand-typed a matching object literal. Neither could catch a rename
 * on the other side; the field would simply arrive `undefined` and the
 * harness-work sleep deferral would silently stop working.
 *
 * Both sides now read THIS fixture. The Go counterpart is
 * `packages/vm-agent/internal/acp/activity_report_contract_test.go`.
 */
const FIXTURE_PATH = join(__dirname, '../../../../../tests/fixtures/acp-activity-report-v1.json');

interface FixtureCase {
  name: string;
  comment: string;
  payload: Record<string, unknown>;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: FixtureCase[] };

describe('ACP activity report cross-boundary contract', () => {
  it('loads every fixture case', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(4);
    expect(fixture.cases.map((c) => c.name)).toContain('legacy_no_harness_fields');
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))(
    'validates the vm-agent payload shape: %s',
    (_name, testCase) => {
      const parsed = v.parse(AcpSessionActivityReportSchema, testCase.payload);

      // Every field the vm-agent sent must survive validation with its value
      // intact — not be silently dropped by a schema/JSON-tag mismatch.
      for (const [key, value] of Object.entries(testCase.payload)) {
        expect(parsed, `field "${key}" was dropped by the Worker schema`).toHaveProperty(key);
        expect((parsed as Record<string, unknown>)[key]).toEqual(value);
      }
    }
  );

  it('carries the harness-work fields the sleep gate reads', () => {
    const active = fixture.cases.find((c) => c.name === 'harness_work_active');
    expect(active).toBeDefined();
    const parsed = v.parse(AcpSessionActivityReportSchema, active!.payload);

    // These four are exactly what `getFreshHarnessWorkLeaseExpiry` and
    // `harnessWorkKeepsRuntimeActive` depend on.
    expect(parsed.runtimeWorkState).toBe('active');
    expect(parsed.runtimeWorkCount).toBe(2);
    expect(parsed.runtimeWorkSource).toBe('claude_sdk');
    expect(typeof parsed.runtimeWorkProgressAt).toBe('number');
  });

  it('rejects a runtimeWorkState the vm-agent could never emit', () => {
    expect(() =>
      v.parse(AcpSessionActivityReportSchema, {
        activity: 'idle',
        nodeId: 'node-1',
        runtimeWorkState: 'bogus',
      })
    ).toThrow();
  });
});
