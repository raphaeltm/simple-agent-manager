/** Real pinned Codex command → ACP → VM activity HTTP → ProjectData → sleep sweep. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import {
  getSessionState,
  upsertActivityState,
} from '@simple-agent-manager/project-data/internal/do/session-state';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { resolveSessionStaleTurnMs } from '../../src/services/session-sleep-eligibility';
import { createMemoryKv, createSchemaTables } from '../helpers/sqlite-d1';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const {
  createSessionSleepFixture,
  sleepBoundaryMocks: mocks,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));
const MINUTE = 60_000;

it.skipIf(!process.env.SAM_PINNED_CODEX_ADAPTER || !process.env.SAM_PINNED_CODEX_CLI)(
  'keeps an actual quiet command awake beyond the resolved stale bound, then sleeps after completion',
  async () => {
    const fixture = createSessionSleepFixture('in_progress', () => null);
    // Real network/process timers, controlled policy clock only.
    vi.useRealTimers();
    vi.useFakeTimers({ now: START, toFake: ['Date'] });
    const stateDb = new Database(':memory:');
    const sql = createSqlStorage(stateDb);
    runMigrations(sql);
    createSchemaTables(fixture.sqlite, [
      schema.platformSettings,
      schema.platformCredentials,
      schema.nodeLifecycleDecisions,
    ]);
    fixture.sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    fixture.env.KV = createMemoryKv();
    delete fixture.env.SESSION_SLEEP_AFTER_MS;
    mocks.getSessionState.mockImplementation(() =>
      Promise.resolve(getSessionState(sql, 'agent-1'))
    );
    fixture.sqlite
      .prepare(
        "UPDATE tasks SET chat_session_id='chat-1', task_mode='conversation' WHERE id='task-1'"
      )
      .run();
    fixture.sqlite
      .prepare(
        "UPDATE session_snapshots SET sleep_status='scheduled', sleep_after=?, runtime='vm', workspace_id='workspace-1', node_id='node-1', agent_session_id='agent-1' WHERE id='snapshot-1'"
      )
      .run(START.toISOString());
    const directory = mkdtempSync(join(tmpdir(), 'sam-sleep-probe-'));
    const release = join(directory, 'release');
    const adapterPidFile = join(directory, 'adapter.pid');
    let now = START.getTime();
    let activeResolve: () => void = () => {};
    let idleResolve: () => void = () => {};
    const active = new Promise<void>((resolve) => {
      activeResolve = resolve;
    });
    const idle = new Promise<void>((resolve) => {
      idleResolve = resolve;
    });
    let cleanupResolve: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });
    let activeReports = 0;
    let callbackError: unknown;
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(body);
        if (payload.probePhase === 'cleanup_complete') {
          cleanupResolve();
          response.writeHead(204).end();
          return;
        }
        upsertActivityState(sql, 'agent-1', {
          activity: payload.activity,
          now,
          observedAt: now,
          promptStartedAt: payload.promptStartedAt,
          runtimeWorkState: payload.runtimeWorkState,
          runtimeWorkCount: payload.runtimeWorkCount,
          runtimeWorkSource: payload.runtimeWorkSource,
          runtimeWorkProgressAt: payload.runtimeWorkProgressAt,
        });
        if (payload.runtimeWorkState === 'active') {
          activeReports++;
          activeResolve();
        }
        if (activeReports && payload.activity === 'idle' && payload.runtimeWorkState === 'inactive')
          idleResolve();
        response.writeHead(204).end();
      } catch (error) {
        callbackError = error;
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing callback port');
    const child = spawn(
      'go',
      [
        'test',
        './internal/acp',
        '-run',
        '^TestPinnedQuietCommandSleepProbe$',
        '-count=1',
        '-timeout=45s',
      ],
      {
        cwd: new URL('../../../../packages/vm-agent/', import.meta.url),
        env: {
          ...process.env,
          SAM_SLEEP_PROBE_CALLBACK_URL: `http://127.0.0.1:${address.port}`,
          SAM_SLEEP_PROBE_RELEASE_FILE: release,
          SAM_SLEEP_PROBE_START_MS: String(START.getTime()),
          SAM_SLEEP_PROBE_PID_FILE: adapterPidFile,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    child.stderr.on('data', (data) => {
      output += String(data);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    const prematureExit = exited.then((code) => {
      throw new Error(`probe exited early (${code}): ${output}`);
    });
    try {
      await Promise.race([active, prematureExit]);
      await Promise.race([cleanup, prematureExit]);
      const staleMs = await resolveSessionStaleTurnMs(fixture.env);
      expect(staleMs).toBe(30 * MINUTE);
      now += staleMs! + MINUTE;
      vi.setSystemTime(now);
      // Let a genuine VM heartbeat arrive at the advanced policy clock.
      const before = activeReports;
      await vi.waitFor(() => expect(activeReports).toBeGreaterThan(before), { timeout: 2000 });
      expect(await runSessionSleepSweep(fixture.env, new Date(now))).toMatchObject({
        selected: 1,
        deferred: 1,
        slept: 0,
      });
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(getSessionState(sql, 'agent-1')?.runtimeWorkState).toBe('active');
      writeFileSync(release, 'finish');
      await Promise.race([idle, prematureExit]);
      expect(await exited, output).toBe(0);
      expect(callbackError).toBeUndefined();
      now += 15 * MINUTE;
      vi.setSystemTime(now);
      const finishedSweep = await runSessionSleepSweep(fixture.env, new Date(now));
      expect(
        finishedSweep.slept,
        JSON.stringify({
          finishedSweep,
          state: getSessionState(sql, 'agent-1'),
          snapshot: fixture.sqlite
            .prepare('SELECT sleep_status,sleep_after,sleep_error FROM session_snapshots')
            .get(),
        })
      ).toBe(1);
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledOnce();
      const decision = fixture.sqlite
        .prepare(
          "SELECT reason, detail_json FROM node_lifecycle_decisions WHERE source='session_sleep' ORDER BY created_at DESC LIMIT 1"
        )
        .get() as { reason: string; detail_json: string };
      expect(decision.reason).toBe('idle');
      expect(JSON.parse(decision.detail_json)).toMatchObject({
        agentSessionId: 'agent-1',
        runtimeWorkState: 'inactive',
        activity: 'idle',
      });
    } finally {
      writeFileSync(release, 'finish');
      // Let the command and the Go fixture run their cleanup before removing
      // the release file. Bound failure cleanup and target only owned groups.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = await Promise.race([
        exited.then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(timer);
      if (!clean) {
        try {
          process.kill(-Number(readFileSync(adapterPidFile, 'utf8')), 'SIGKILL');
        } catch {
          /* already exited or not started */
        }
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
        await exited.catch(() => undefined);
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stateDb.close();
      fixture.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000
);
