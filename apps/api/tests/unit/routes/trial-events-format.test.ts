/**
 * Regression test for `formatSse()` — SSE frame serialization helper.
 *
 * Guards against SSE-frame injection: if a future caller ever bypasses the
 * `TrialEvent` discriminated union (e.g. via `as never` casts or dynamic
 * event names), CR/LF in the event name MUST be stripped so an attacker
 * cannot inject an extra `event:` / `data:` line into the stream.
 */
import { describe, expect, it } from 'vitest';

import { formatSse } from '../../../src/routes/trial/events';

describe('formatSse()', () => {
  it('produces a stable single-event frame on the happy path', () => {
    const frame = formatSse('trial.ready', { type: 'trial.ready', at: 123 });
    expect(frame).toBe(
      'event: trial.ready\ndata: {"type":"trial.ready","at":123}\n\n'
    );
  });

  it('strips CR and LF from the event name to prevent frame injection', () => {
    // Attacker-controlled event name tries to smuggle a second event into the
    // same frame. The CR/LF MUST be removed before the `event:` line is written.
    const hostile = 'trial.knowledge\r\nevent: trial.error\ndata: {"pwn":true}\r\n';
    const frame = formatSse(hostile, { ok: 1 });

    // The frame must have exactly one `event:` line and one `data:` line,
    // followed by the terminating blank line — i.e. three newlines total.
    const lines = frame.split('\n');
    // Expected shape: ['event: ...', 'data: {...}', '', '']
    expect(lines).toHaveLength(4);
    expect(lines[0]?.startsWith('event: ')).toBe(true);
    expect(lines[1]?.startsWith('data: ')).toBe(true);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('');

    // No CR/LF survives inside the event name.
    expect(lines[0]).not.toContain('\r');
    // And crucially, the word `error` is now part of the event name, not a
    // separate injected event line.
    const eventMatches = frame.match(/^event: /gm) ?? [];
    expect(eventMatches).toHaveLength(1);
  });

  it('json-encodes the data payload (newlines inside strings are escaped)', () => {
    const frame = formatSse('trial.log', { msg: 'line1\nline2' });
    // JSON.stringify escapes the embedded newline to \n (literal backslash n).
    expect(frame).toBe('event: trial.log\ndata: {"msg":"line1\\nline2"}\n\n');
  });
});
