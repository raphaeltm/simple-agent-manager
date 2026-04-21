/**
 * Regression tests for `formatSse()` — SSE frame serialization helper.
 *
 * Two invariants are guarded here:
 *
 *   1. The frame MUST be an unnamed ("message") SSE event — i.e. no `event:`
 *      line. Browser EventSource consumers only invoke `onmessage` for the
 *      default event; named events require per-type `addEventListener()`
 *      registrations. Emitting named events caused the "zero trial.* events
 *      on staging" incident (2026-04-19) where bytes arrived on the wire but
 *      the frontend's `onmessage` handler never fired. See
 *      `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`.
 *
 *   2. Data is JSON-encoded, so embedded newlines in payload strings are
 *      escaped — an SSE-frame-injection defence. The `TrialEvent` discriminated
 *      union exposed at the call site additionally narrows the `type` field
 *      to a safe set of literals.
 */
import { describe, expect, it } from 'vitest';

import { formatSse } from '../../../src/routes/trial/events';

describe('formatSse()', () => {
  it('produces an unnamed SSE frame so EventSource.onmessage fires', () => {
    const frame = formatSse({ type: 'trial.ready', at: 123 });
    expect(frame).toBe('data: {"type":"trial.ready","at":123}\n\n');
    // No `event:` line — otherwise the client has to register listeners
    // per event type and `onmessage` silently never fires.
    expect(frame).not.toContain('event:');
  });

  it('json-encodes the data payload (newlines inside strings are escaped)', () => {
    const frame = formatSse({ msg: 'line1\nline2' });
    // JSON.stringify escapes the embedded newline to \n (literal backslash n),
    // preventing the payload from terminating the SSE frame early.
    expect(frame).toBe('data: {"msg":"line1\\nline2"}\n\n');
  });

  it('frame shape is exactly one data line plus the blank terminator', () => {
    const frame = formatSse({
      type: 'trial.knowledge',
      key: 'description',
      value: 'hello',
    });
    const lines = frame.split('\n');
    // ['data: {...}', '', '']
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith('data: ')).toBe(true);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('');
    const dataLines = frame.match(/^data: /gm) ?? [];
    expect(dataLines).toHaveLength(1);
  });
});
