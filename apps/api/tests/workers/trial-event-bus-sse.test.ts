/**
 * Capability + regression test: TrialEventBus DO → SSE endpoint wire-up.
 *
 * The "zero trial.* events on staging" incident (2026-04-19) was caused by
 * the SSE endpoint emitting named events (`event: trial.knowledge\ndata:`)
 * while browser EventSource consumers only fire `onmessage` for the default
 * (unnamed) event. The bytes arrived on the wire — curl saw them — but no
 * frontend-visible event was ever dispatched.
 *
 * This test exercises the full bus → SSE wire format:
 *
 *   1. Seed a trial record in KV (what `readTrial` reads in events.ts).
 *   2. Append an event directly on the TrialEventBus DO (identical to what
 *      `emitTrialEvent()` does in the Worker for real trials).
 *   3. Open the SSE stream via `SELF.fetch` with a valid fingerprint cookie.
 *   4. Read the raw stream bytes and assert:
 *        - HTTP 200 + correct `content-type`
 *        - At least one `data: {...}` frame
 *        - No `event:` line anywhere (the regression guard for the incident)
 *        - The parsed JSON payload round-trips through the bus intact
 *
 * See `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`.
 */
import type { TrialEvent } from '@simple-agent-manager/shared';
import { TRIAL_COOKIE_FINGERPRINT_NAME } from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { signFingerprint } from '../../src/services/trial/cookies';
import type { TrialRecord } from '../../src/services/trial/trial-store';
import { writeTrial } from '../../src/services/trial/trial-store';

type WorkerEnv = typeof env & {
  TRIAL_EVENT_BUS: DurableObjectNamespace;
  TRIAL_CLAIM_TOKEN_SECRET: string;
  KV: KVNamespace;
};

const workerEnv = env as unknown as WorkerEnv;

function makeTrialRecord(trialId: string, fingerprint: string): TrialRecord {
  const now = Date.now();
  return {
    trialId,
    projectId: '',
    fingerprint,
    workspaceId: null,
    repoUrl: 'https://github.com/example/repo',
    createdAt: now,
    expiresAt: now + 1000 * 60 * 20,
    claimed: false,
  };
}

async function appendViaBus(trialId: string, event: TrialEvent): Promise<void> {
  const id = workerEnv.TRIAL_EVENT_BUS.idFromName(trialId);
  const stub = workerEnv.TRIAL_EVENT_BUS.get(id);
  const resp = await stub.fetch('https://trial-event-bus/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  expect(resp.status, 'bus append should succeed').toBe(200);
}

/**
 * Read the SSE stream until it has seen at least `minDataFrames` data frames
 * or the stream closes / the timeout elapses. Returns the accumulated body.
 */
async function readStreamUntil(
  resp: Response,
  minDataFrames: number,
  timeoutMs = 3000,
): Promise<string> {
  if (!resp.body) throw new Error('response has no body');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Count `data: ` occurrences (each SSE data frame starts with it).
    const frameCount = (body.match(/^data: /gm) ?? []).length;
    if (frameCount >= minDataFrames) break;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 250),
      ),
    ]);
    if (done) break;
    if (value) body += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return body;
}

describe('TrialEventBus → SSE endpoint (capability)', () => {
  it('events published via the bus stream as unnamed SSE frames that EventSource.onmessage can consume', async () => {
    const trialId = `trial_${crypto.randomUUID().replace(/-/g, '')}`;
    const fingerprintUuid = crypto.randomUUID();

    // 1. Seed KV so readTrial() resolves the record in events.ts.
    await writeTrial(workerEnv as never, makeTrialRecord(trialId, fingerprintUuid));

    // 2. Publish a real-shaped TrialEvent via the DO before opening the stream
    //    — tests the immediate-return path of the DO poll loop.
    const knowledgeEvent: TrialEvent = {
      type: 'trial.knowledge',
      key: 'description',
      value: 'capability-test description',
      at: Date.now(),
    };
    await appendViaBus(trialId, knowledgeEvent);

    // 3. Sign the fingerprint cookie and hit the SSE endpoint.
    const secret = workerEnv.TRIAL_CLAIM_TOKEN_SECRET;
    const signed = await signFingerprint(fingerprintUuid, secret);
    const cookie = `${TRIAL_COOKIE_FINGERPRINT_NAME}=${encodeURIComponent(signed)}`;

    const resp = await SELF.fetch(
      `https://api.test.example.com/api/trial/${trialId}/events`,
      {
        method: 'GET',
        headers: { cookie, accept: 'text/event-stream' },
      },
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/event-stream/);

    // 4. Publish a second event AFTER the stream is open to also exercise
    //    the long-poll wake path.
    const progressEvent: TrialEvent = {
      type: 'trial.progress',
      step: 'capability-check',
      at: Date.now(),
    };
    await appendViaBus(trialId, progressEvent);

    const body = await readStreamUntil(resp, 2, 3000);

    // --- Regression guard: no named events -------------------------------
    // If ANY `event:` line appears, the named-event bug has returned and
    // browser EventSource.onmessage will silently swallow these frames.
    const namedEventLines = body.match(/^event: /gm) ?? [];
    expect(namedEventLines).toHaveLength(0);

    // --- Capability: frames are parseable and carry the bus payload ------
    const dataLines = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));

    expect(dataLines.length).toBeGreaterThanOrEqual(2);

    const parsed = dataLines.map((line) => JSON.parse(line) as TrialEvent);
    const types = parsed.map((e) => e.type);
    expect(types).toContain('trial.knowledge');
    expect(types).toContain('trial.progress');

    const knowledgeFrame = parsed.find(
      (e): e is Extract<TrialEvent, { type: 'trial.knowledge' }> =>
        e.type === 'trial.knowledge',
    );
    expect(knowledgeFrame).toBeDefined();
    expect(knowledgeFrame?.key).toBe('description');
    expect(knowledgeFrame?.value).toBe('capability-test description');
  });
});
