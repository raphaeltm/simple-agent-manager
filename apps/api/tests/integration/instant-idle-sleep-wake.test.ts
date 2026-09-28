/**
 * Vertical slice for idea 01M3JFFC8R6J1YE0HX0J3PS4TN: an Instant (cf-container)
 * session that slept must wake when the user sends a follow-up.
 *
 * Real: the D1 lifecycle rows (SQLite), both sleep writers — the container's own idle
 * trigger (`VmAgentContainer.onActivityExpired` → `persistRuntimeSleeping`) and
 * `sleepWorkspaceSession`, which the scheduled sweep and the Sleep button call — the
 * snapshot lifecycle, ProjectData's durable delivery alarm and inbox (on ProjectData's
 * own migrated SQLite), the delivery adapter and its target resolver, the node-agent
 * transport, and the container Durable Object's in-place wake (`ensureAwake` →
 * `loadRuntimeRecoveryContext` → `persistRuntimeRecovering` → restore →
 * `persistRuntimeRecovered`).
 *
 * Substituted: the vm-agent process inside the container, R2, token signing, and the
 * ProjectData RPC hop — whose session transitions still run ProjectData's real
 * functions against the same SQLite.
 */
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import * as attention from '../../src/durable-objects/project-data/attention';
import { processPromptDeliveryAlarm } from '../../src/durable-objects/project-data/durability-foundation';
import * as mailbox from '../../src/durable-objects/project-data/mailbox';
import {
  acceptPromptDelivery,
  nudgePromptDeliveriesForTarget,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { getSession } from '../../src/durable-objects/project-data/session-reads';
import * as sessions from '../../src/durable-objects/project-data/sessions';
import { VmAgentContainer } from '../../src/durable-objects/vm-agent-container';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { chatRoutes } from '../../src/routes/chat';
import { agentSessionSuspendResumeRoutes } from '../../src/routes/workspaces/agent-session-suspend-resume';
import { agentSessionRoutes } from '../../src/routes/workspaces/agent-sessions';
import { sleepWorkspaceSession } from '../../src/services/session-sleep-execution';
import {
  completeSessionSnapshot,
  prepareSessionSnapshot,
  type SessionSnapshotManifest,
} from '../../src/services/session-snapshots';
import { markVmAgentContainerActiveWorkEndedBestEffort } from '../../src/services/vm-agent-container';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const projectData = vi.hoisted(() => ({ sql: null as SqlStorage | null, idleSince: 0 }));

function projectDataSql(): SqlStorage {
  if (!projectData.sql) throw new Error('ProjectData SQLite is not initialised');
  return projectData.sql;
}

// Only the ProjectData calls these flows make; any other call fails loudly.
vi.mock('../../src/services/project-data', () => ({
  getSession: async (_env: unknown, _projectId: string, sessionId: string) =>
    getSession(projectDataSql(), sessionId),
  sleepSession: async (_env: unknown, _projectId: string, sessionId: string) =>
    sessions.sleepSession(projectDataSql(), sessionId),
  wakeSession: async (
    _env: unknown,
    _projectId: string,
    sessionId: string,
    workspaceId: string,
    taskId: string
  ) => sessions.wakeSession(projectDataSql(), sessionId, workspaceId, taskId),
  // The agent handed control back and nothing it started is still running.
  getSessionState: async () => ({ activity: 'idle', activityAt: projectData.idleSince }),
  getAcpSession: async () => null,
  // The stop and cancel routes, and the teardown behind the stop route.
  stopSession: async (_env: unknown, _projectId: string, sessionId: string) =>
    sessions.stopSession(projectDataSql(), sessionId) !== null,
  recordSessionTurnEnd: async () => {},
  cleanupWorkspaceActivity: async () => {},
  // The attention-answer route.
  prepareAttentionAnswer: async (
    _env: unknown,
    _projectId: string,
    sessionId: string,
    markerId: string,
    answer: string
  ) => attention.prepareAttentionAnswer(projectDataSql(), sessionId, markerId, answer),
  releaseAttentionAnswer: async (
    _env: unknown,
    _projectId: string,
    sessionId: string,
    markerId: string,
    answer: string
  ) => attention.releaseAttentionAnswer(projectDataSql(), sessionId, markerId, answer),
  completeAttentionAnswer: async (
    _env: unknown,
    _projectId: string,
    sessionId: string,
    markerId: string,
    answer: string
  ) => attention.completeAttentionAnswer(projectDataSql(), sessionId, markerId, answer),
}));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user-1',
}));

vi.mock('../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwt')>()),
  signNodeManagementToken: async () => ({ token: 'node-management-token' }),
  signNodeCallbackToken: async () => 'node-callback-token',
  signCallbackToken: async () => 'workspace-callback-token',
}));

const PROJECT_ID = 'project-1';
const USER_ID = 'user-1';
const NODE_ID = 'node-1';
const WORKSPACE_ID = 'workspace-1';
const CHAT_SESSION_ID = 'chat-1';
const AGENT_SESSION_ID = 'agent-1';
const TASK_ID = 'task-1';
const HOME_BYTES = 4;
const HOME_SHA256 = 'ab'.repeat(32);
const AGENT_PATH = `/workspaces/${WORKSPACE_ID}/agent-sessions/${AGENT_SESSION_ID}`;
const CAPABILITIES_PATH = buildVmPromptDeliveryCapabilitiesPath(WORKSPACE_ID);

/**
 * The vm-agent process inside the Instant container. It answers only while the
 * container runs, so a prompt can be accepted only after a real wake.
 */
class ContainerVmAgent {
  running = true;
  starts = 0;
  readonly prompts: string[] = [];
  /** Cancel/stop signals the agent received, by path. */
  readonly signals: string[] = [];
  /** Holds a restore open so a test can observe the wake mid-flight. */
  restoreGate: Promise<void> | null = null;
  private notifyRestoreStarted: (() => void) | null = null;
  readonly restoreStarted = new Promise<void>((resolve) => {
    this.notifyRestoreStarted = resolve;
  });

  constructor(private readonly captureSnapshot: () => Promise<void>) {}

  get runtimeIdentity(): string {
    return `runtime-${this.starts}`;
  }

  start(): void {
    this.running = true;
    this.starts += 1;
  }

  stop(): void {
    this.running = false;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.running) throw new TypeError('Network connection lost.');
    const { pathname } = new URL(request.url);
    if (pathname === CAPABILITIES_PATH) {
      return Response.json(versionedPromptCapabilities(this.runtimeIdentity));
    }
    if (pathname === `${AGENT_PATH}/restore`) {
      this.notifyRestoreStarted?.();
      await this.restoreGate;
      return Response.json({ status: 'restored', degradation: 'none', skipped: [] });
    }
    if (pathname === `${AGENT_PATH}/hibernate`) {
      await this.captureSnapshot();
      return Response.json({ status: 'pending', accepted: true });
    }
    if (pathname === `${AGENT_PATH}/cancel`) {
      this.signals.push(pathname);
      return Response.json({ error: 'no prompt in flight' }, { status: 409 });
    }
    if (pathname === `${AGENT_PATH}/stop`) {
      this.signals.push(pathname);
      return Response.json({ status: 'stopped' });
    }
    if (pathname === `${AGENT_PATH}/suspend`) {
      this.signals.push(pathname);
      return Response.json({ status: 'suspended' });
    }
    if (pathname === `${AGENT_PATH}/prompt`) {
      const body = (await request.json()) as { prompt: string; deliveryId: string };
      this.prompts.push(body.prompt);
      return Response.json(
        acceptedPromptResponse(AGENT_SESSION_ID, body.deliveryId, this.runtimeIdentity, Date.now())
      );
    }
    return Response.json({ error: `unexpected ${request.method} ${pathname}` }, { status: 404 });
  }
}

describe('Instant session wake after idle sleep', () => {
  let d1: Database.Database;
  let projectDataDb: Database.Database;
  let env: Env;
  let container: VmAgentContainer;
  let vmAgent: ContainerVmAgent;
  let deliveries = 0;

  /** What the vm-agent does to capture a snapshot: prepare, upload HOME, complete. */
  async function captureSnapshot(): Promise<void> {
    const db = drizzle(env.DATABASE, { schema });
    const prepared = await prepareSessionSnapshot(db, env, {
      workspaceId: WORKSPACE_ID,
      nodeId: NODE_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      chatSessionId: CHAT_SESSION_ID,
      agentSessionId: AGENT_SESSION_ID,
      runtime: 'cf-container',
    });
    await env.R2.put(prepared.keys.home, 'home');
    const manifest: SessionSnapshotManifest = {
      version: 1,
      chatSessionId: CHAT_SESSION_ID,
      workspaceId: WORKSPACE_ID,
      status: 'available',
      degradation: 'none',
      skipped: [],
      artifacts: { home: { sizeBytes: HOME_BYTES, sha256: HOME_SHA256 } },
      createdAt: new Date().toISOString(),
    };
    await completeSessionSnapshot(db, env, {
      workspaceId: WORKSPACE_ID,
      chatSessionId: CHAT_SESSION_ID,
      agentSessionId: AGENT_SESSION_ID,
      runtime: 'cf-container',
      baseCommit: null,
      status: 'available',
      degradation: 'none',
      captureGeneration: prepared.generation,
      artifactSha256: { homeSha256: HOME_SHA256 },
      manifest,
      artifactSizes: { homeBytes: HOME_BYTES },
    });
  }

  function r2Bucket(): R2Bucket {
    const objects = new Map<string, number>();
    return {
      put: async (key: string, value: string) => {
        objects.set(key, value.length);
      },
      head: async (key: string) => {
        const size = objects.get(key);
        return size === undefined ? null : { size, checksums: {} };
      },
      delete: async (keys: string | string[]) => {
        for (const key of [keys].flat()) objects.delete(key);
      },
    } as unknown as R2Bucket;
  }

  function newContainer(): VmAgentContainer {
    const values = new Map<string, unknown>([
      ['lifecycleStatus', 'running'],
      [
        'launchConfig',
        {
          nodeId: NODE_ID,
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          chatSessionId: CHAT_SESSION_ID,
          repository: 'owner/repo',
          branch: 'main',
          workspaceDir: '/workspaces/repo',
          controlPlaneUrl: 'https://api.example.test',
          vmAgentPort: 8080,
        },
      ],
    ]);
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
    };
    const instance = new VmAgentContainer(
      { storage } as unknown as DurableObjectState<Record<string, never>>,
      env
    );
    // The container runtime the Durable Object drives.
    Object.assign(instance, {
      startAndWaitForPorts: async () => vmAgent.start(),
      stop: async () => vmAgent.stop(),
      destroy: async () => vmAgent.stop(),
      getState: async () => ({ status: vmAgent.running ? 'running' : 'stopped' }),
      containerFetch: (request: Request) => vmAgent.fetch(request),
    });
    return instance;
  }

  function seedLiveInstantSession(): void {
    const now = new Date().toISOString();
    d1.prepare(`INSERT INTO projects (id, user_id, name) VALUES (?, ?, 'SAM')`).run(
      PROJECT_ID,
      USER_ID
    );
    d1.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`
    ).run(PROJECT_ID, USER_ID);
    d1.prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, runtime, node_role,
                          runtime_incarnation_id, created_at, updated_at)
       VALUES (?, ?, 'instant', 'running', 'healthy', 'cf-container', 'workspace',
               'incarnation-1', ?, ?)`
    ).run(NODE_ID, USER_ID, now, now);
    d1.prepare(
      `INSERT INTO workspaces (id, user_id, node_id, project_id, chat_session_id, name,
                               repository, branch, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'instant', 'owner/repo', 'main', 'running', ?, ?)`
    ).run(WORKSPACE_ID, USER_ID, NODE_ID, PROJECT_ID, CHAT_SESSION_ID, now, now);
    d1.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'claude-code', ?, ?)`
    ).run(AGENT_SESSION_ID, WORKSPACE_ID, USER_ID, now, now);
    d1.prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, chat_session_id, status,
                          task_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', 'conversation', ?, ?)`
    ).run(TASK_ID, PROJECT_ID, USER_ID, WORKSPACE_ID, CHAT_SESSION_ID, now, now);
    d1.prepare(
      `INSERT INTO session_summaries (id, project_id, user_id, status, task_id, workspace_id,
                                      message_count, started_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, 2, ?, ?)`
    ).run(CHAT_SESSION_ID, PROJECT_ID, USER_ID, TASK_ID, WORKSPACE_ID, Date.now(), Date.now());
    projectDataSql().exec(
      `INSERT INTO chat_sessions
         (id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
          started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Instant', 'active', 2, ?, ?, ?)`,
      CHAT_SESSION_ID,
      WORKSPACE_ID,
      TASK_ID,
      USER_ID,
      Date.now(),
      Date.now(),
      Date.now()
    );
  }

  /** The user's follow-up, as the prompt route accepts it into ProjectData's inbox. */
  function acceptFollowUp(content: string): string {
    deliveries += 1;
    const deliveryId = `delivery-${deliveries}`;
    acceptPromptDelivery(
      projectDataSql(),
      {},
      {
        deliveryId,
        targetSessionId: CHAT_SESSION_ID,
        displayContent: content,
        senderType: 'human',
        senderId: USER_ID,
        messageClass: 'deliver',
        sourceKind: 'user_followup',
        ttlMs: 60 * 60 * 1000,
      }
    );
    return deliveryId;
  }

  async function sendFollowUp(content: string): Promise<string> {
    const deliveryId = acceptFollowUp(content);
    await runDeliveryAlarm();
    return deliveryId;
  }

  async function runDeliveryAlarm(): Promise<void> {
    const claims: Promise<unknown>[] = [];
    processPromptDeliveryAlarm(projectDataSql(), env, {
      getProjectId: () => PROJECT_ID,
      transactionSync: <T>(callback: () => T) => callback(),
      waitUntil: (promise: Promise<unknown>) => void claims.push(promise),
      recalculateAlarm: async () => {},
      scheduleSummarySync: () => {},
      broadcastEvent: () => {},
      armIdleCleanup: () => {},
      nudgeDeliveries: (sessionId: string) =>
        nudgePromptDeliveriesForTarget(projectDataSql(), sessionId),
    });
    await Promise.all(claims);
  }

  function runtimeRows() {
    return {
      node: d1.prepare(`SELECT status, health_status FROM nodes WHERE id = ?`).get(NODE_ID),
      workspace: d1.prepare(`SELECT status FROM workspaces WHERE id = ?`).get(WORKSPACE_ID),
      agentSession: d1
        .prepare(`SELECT status FROM agent_sessions WHERE id = ?`)
        .get(AGENT_SESSION_ID),
      snapshot: d1
        .prepare(
          `SELECT sleep_status, sleeping_at IS NOT NULL AS asleep
             FROM session_snapshots WHERE chat_session_id = ?`
        )
        .get(CHAT_SESSION_ID),
    };
  }

  const SLEPT_ROWS = {
    node: { status: 'sleeping', health_status: 'unhealthy' },
    workspace: { status: 'sleeping' },
    agentSession: { status: 'sleeping' },
    snapshot: { sleep_status: 'sleeping', asleep: 1 },
  };

  /** A committed in-place wake: the runtime rows are running and the snapshot is awake. */
  const AWAKE_ROWS = {
    node: { status: 'running', health_status: 'healthy' },
    workspace: { status: 'running' },
    agentSession: { status: 'running' },
    snapshot: { sleep_status: null, asleep: 0 },
  };

  function wakeFailures() {
    return {
      markers: projectDataSql()
        .exec(
          `SELECT kind, reason FROM session_attention_markers
            WHERE session_id = ? AND resolved_at IS NULL`,
          CHAT_SESSION_ID
        )
        .toArray(),
      messages: projectDataSql()
        .exec(
          `SELECT content FROM chat_messages
            WHERE session_id = ? AND role = 'system' AND content LIKE 'Wake failed:%'`,
          CHAT_SESSION_ID
        )
        .toArray(),
    };
  }

  function routesApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/projects/:projectId/sessions', chatRoutes);
    app.route('/api/workspaces', agentSessionRoutes);
    app.route('/api/workspaces', agentSessionSuspendResumeRoutes);
    return app;
  }

  /** A chat action as the browser sends it, through the real chat routes. */
  async function postChatAction(action: 'stop' | 'cancel'): Promise<Response> {
    return routesApp().request(
      `/api/projects/${PROJECT_ID}/sessions/${CHAT_SESSION_ID}/${action}`,
      { method: 'POST' },
      env
    );
  }

  /** The workspace page's stop or suspend button for one agent session. */
  async function postWorkspaceAgentAction(
    action: 'stop' | 'suspend',
    agentSessionId = AGENT_SESSION_ID
  ): Promise<Response> {
    return routesApp().request(
      `/api/workspaces/${WORKSPACE_ID}/agent-sessions/${agentSessionId}/${action}`,
      { method: 'POST' },
      env
    );
  }

  /**
   * A second agent session, older than the chat's. The session sleep marks only the newest
   * one `sleeping` (`completeSleepTeardown`), so this row stays `running` on a slept node.
   */
  function seedOlderRunningAgentSession(): string {
    const id = 'agent-0';
    const earlier = new Date(Date.now() - 60_000).toISOString();
    d1.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'claude-code', ?, ?)`
    ).run(id, WORKSPACE_ID, USER_ID, earlier, earlier);
    return id;
  }

  function agentSessionStatus(id: string): unknown {
    return d1.prepare(`SELECT status FROM agent_sessions WHERE id = ?`).pluck().get(id);
  }

  /** The agent asked a question before it slept; the user picks an answer in the chat. */
  async function answerAttentionRequest(): Promise<Response> {
    const marker = attention.createAttentionMarker(projectDataSql(), {
      sessionId: CHAT_SESSION_ID,
      taskId: TASK_ID,
      workspaceId: WORKSPACE_ID,
      kind: 'needs_input',
      source: 'agent',
      metadata: JSON.stringify({ options: ['Ship it', 'Hold'] }),
    });
    return routesApp().request(
      `/api/projects/${PROJECT_ID}/sessions/${CHAT_SESSION_ID}/attention/${marker.id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'Ship it' }),
      },
      env
    );
  }

  /** The workspace page's resume button for one agent session. */
  async function postWorkspaceAgentResume(): Promise<Response> {
    return routesApp().request(
      `/api/workspaces/${WORKSPACE_ID}/agent-sessions/${AGENT_SESSION_ID}/resume`,
      { method: 'POST' },
      env
    );
  }

  /** The snapshot generation the next wake would restore. */
  function restorableGeneration(): unknown {
    return d1
      .prepare(`SELECT snapshot_generation FROM session_snapshots WHERE chat_session_id = ?`)
      .pluck()
      .get(CHAT_SESSION_ID);
  }

  /** The container's own idle timeout (`sleepAfter`) — the trigger in the incident. */
  async function sleepOnContainerIdleTimeout(): Promise<void> {
    await container.onActivityExpired();
  }

  /** The scheduled sweep and the Sleep button both run `sleepWorkspaceSession`. */
  async function sleepThroughSessionSleep(): Promise<void> {
    await sleepWorkspaceSession(env, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      reason: 'idle',
    });
  }

  beforeEach(async () => {
    d1 = new Database(':memory:');
    createAllSchemaTables(d1, schema);
    d1.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    projectDataDb = new Database(':memory:');
    projectData.sql = createSqlStorage(projectDataDb);
    projectData.idleSince = Date.now() - 60_000;
    runMigrations(projectData.sql);
    env = {
      DATABASE: createSqliteD1(d1),
      R2: r2Bucket(),
      BASE_DOMAIN: 'example.test',
      CF_CONTAINER_ENABLED: 'true',
      SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
      TASK_RUN_CLEANUP_DELAY_MS: '0',
    } as unknown as Env;
    vmAgent = new ContainerVmAgent(captureSnapshot);
    container = newContainer();
    Object.assign(env, {
      VM_AGENT_CONTAINER: { idFromName: (name: string) => name, get: () => container },
    });
    deliveries = 0;
    seedLiveInstantSession();
    // The turn-end checkpoint the agent captured after answering its first prompt.
    await captureSnapshot();
  });

  afterEach(() => {
    projectData.sql = null;
    d1.close();
    projectDataDb.close();
  });

  // The third sleep writer, `persistRuntimeSleepingAfterRevokedWake`, leaves the same rows;
  // its round trip into the resumer runs on real D1 in
  // `tests/workers/instant-runtime-recovery-persistence.test.ts`.
  describe.each([
    ['the container idle timeout', sleepOnContainerIdleTimeout],
    ['the session sleep', sleepThroughSessionSleep],
  ])('after %s', (_trigger, sleep) => {
    it('wakes the container in place and delivers the follow-up', async () => {
      await sleep();
      expect(vmAgent.running).toBe(false);
      expect(runtimeRows()).toEqual(SLEPT_ROWS);

      const deliveryId = await sendFollowUp('Pick up where you left off.');

      expect(wakeFailures()).toEqual({ markers: [], messages: [] });
      expect(mailbox.getMessage(projectDataSql(), deliveryId)).toMatchObject({
        deliveryState: 'acked',
      });
      expect(vmAgent.starts).toBe(1);
      expect(vmAgent.prompts).toEqual(['Pick up where you left off.']);
      expect(runtimeRows()).toEqual(AWAKE_ROWS);
      expect(getSession(projectDataSql(), CHAT_SESSION_ID)).toMatchObject({
        status: 'active',
      });
    });
  });

  // Durable delivery commits the wake it starts. These requests wake the container outside it,
  // and until the session's sleep markers clear, every checkpoint the woken agent takes is
  // discarded and the next sleep reuses the old snapshot: the work would be gone at the
  // following wake.
  describe.each([
    ['an attention answer', answerAttentionRequest, ['Ship it']],
    ['the workspace page resume', postWorkspaceAgentResume, []],
  ])('when %s wakes the slept container', (_trigger, wake, prompts) => {
    it('commits the wake, so the next checkpoint survives the next sleep', async () => {
      await sleepOnContainerIdleTimeout();
      const sleptGeneration = restorableGeneration();

      const response = await wake();

      expect(response.status).toBe(200);
      expect(vmAgent.starts).toBe(1);
      expect(vmAgent.prompts).toEqual(prompts);
      expect(runtimeRows()).toEqual(AWAKE_ROWS);
      expect(getSession(projectDataSql(), CHAT_SESSION_ID)).toMatchObject({
        status: 'active',
      });

      // The woken agent's turn ends: its checkpoint completes, which releases the prompt's
      // keepalive (the snapshot-complete route), and the container later idles into sleep.
      await captureSnapshot();
      await markVmAgentContainerActiveWorkEndedBestEffort(
        env,
        NODE_ID,
        'session_snapshot_complete'
      );
      const checkpoint = restorableGeneration();
      expect(checkpoint).not.toBe(sleptGeneration);
      await sleepOnContainerIdleTimeout();

      expect(runtimeRows()).toEqual(SLEPT_ROWS);
      expect(restorableGeneration()).toBe(checkpoint);
    });
  });

  // Control: only a wake from sleep is committed. A crash recovery of a session that never slept
  // leaves the session's status alone, since `wakeSession` would also revive a failed one.
  it('leaves a never-slept session alone when its crashed container recovers', async () => {
    sessions.failSession(projectDataSql(), CHAT_SESSION_ID);
    vmAgent.stop();
    await container.onStop({ exitCode: 1, reason: 'exit' });

    const response = await postWorkspaceAgentResume();

    expect(response.status).toBe(200);
    // Liveness: the crashed container did recover.
    expect(vmAgent.starts).toBe(1);
    expect(runtimeRows().node).toEqual(AWAKE_ROWS.node);
    expect(getSession(projectDataSql(), CHAT_SESSION_ID)).toMatchObject({
      status: 'failed',
    });
  });

  it('does not refuse a follow-up that resolves its target while the wake is in flight', async () => {
    await sleepOnContainerIdleTimeout();
    let releaseRestore!: () => void;
    vmAgent.restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let containerRequests = 0;
    let secondRequestArrived!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      secondRequestArrived = resolve;
    });
    const proxyHttp = container.proxyHttp.bind(container);
    container.proxyHttp = (request, port) => {
      containerRequests += 1;
      if (containerRequests === 2) secondRequestArrived();
      return proxyHttp(request, port);
    };

    // The first follow-up starts the in-place wake; its restore is held open.
    const first = acceptFollowUp('First follow-up');
    const firstAttempt = runDeliveryAlarm();
    await Promise.race([
      vmAgent.restoreStarted,
      firstAttempt.then(() => {
        throw new Error(
          `The first follow-up ended before any wake began: ${JSON.stringify(
            mailbox.getMessage(projectDataSql(), first)
          )}`
        );
      }),
    ]);
    // Midpoint: the wake writer has claimed the rows, and it marks the node unhealthy too.
    expect(runtimeRows()).toMatchObject({
      node: { status: 'recovery', health_status: 'unhealthy' },
      workspace: { status: 'recovery' },
      agentSession: { status: 'recovery' },
      snapshot: { sleep_status: 'sleeping', asleep: 1 },
    });

    // A second follow-up resolves its target against those mid-wake rows and joins the
    // wake at the container, rather than being refused before it gets there.
    const second = acceptFollowUp('Second follow-up');
    const secondAttempt = runDeliveryAlarm();
    await Promise.race([
      secondRequest,
      secondAttempt.then(() => {
        throw new Error(
          `The second follow-up ended before it reached the container: ${JSON.stringify(
            mailbox.getMessage(projectDataSql(), second)
          )}`
        );
      }),
    ]);
    releaseRestore();
    await Promise.all([firstAttempt, secondAttempt]);

    expect(wakeFailures()).toEqual({ markers: [], messages: [] });
    expect(vmAgent.starts).toBe(1);
    expect([...vmAgent.prompts].sort()).toEqual(['First follow-up', 'Second follow-up']);
    for (const deliveryId of [first, second]) {
      expect(mailbox.getMessage(projectDataSql(), deliveryId)).toMatchObject({
        deliveryState: 'acked',
      });
    }
  });

  // Control: the wake must still be refused, visibly, when the runtime is really gone —
  // otherwise the suite passes with the refusal deleted outright.
  it.each([
    ['its node row was removed', () => d1.prepare(`DELETE FROM nodes WHERE id = ?`).run(NODE_ID)],
    [
      'node cleanup is tearing its container down',
      () =>
        d1
          .prepare(`UPDATE nodes SET status = 'destroying', health_status = 'stale' WHERE id = ?`)
          .run(NODE_ID),
    ],
    [
      'node cleanup destroyed its container',
      () =>
        d1
          .prepare(`UPDATE nodes SET status = 'deleted', health_status = 'stale' WHERE id = ?`)
          .run(NODE_ID),
    ],
    [
      'its workspace deletion was confirmed',
      () =>
        d1
          .prepare(`UPDATE workspaces SET runtime_deletion_confirmed_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), WORKSPACE_ID),
    ],
  ])('still reports a slept container as unavailable when %s', async (_gone, destroy) => {
    await sleepOnContainerIdleTimeout();
    destroy();

    const deliveryId = await sendFollowUp('Are you still there?');

    expect(mailbox.getMessage(projectDataSql(), deliveryId)).toMatchObject({
      deliveryState: 'failed',
      terminalReason: 'wake_refused',
    });
    expect(wakeFailures()).toEqual({
      markers: [{ kind: 'wake_failed', reason: 'wake_refused' }],
      messages: [
        {
          content:
            'Wake failed: The sleeping container runtime is gone and cannot wake in place. (container_runtime_unavailable)',
        },
      ],
    });
    expect(vmAgent.starts).toBe(0);
    expect(vmAgent.prompts).toEqual([]);
  });

  // The stop and cancel routes only signal a live agent. A request to a slept container
  // would restore it from its snapshot first: on staging, archiving a slept Instant session
  // woke it, and the wake raced the stop's own teardown into a 500.
  describe('stop and cancel on a slept session', () => {
    /** What the stop route's teardown leaves; the snapshot row goes with the session. */
    const ARCHIVED_ROWS = {
      node: { status: 'deleted', health_status: 'stale' },
      workspace: { status: 'deleted' },
      agentSession: { status: 'stopped' },
      snapshot: undefined,
    };

    it('archives the session without waking its container', async () => {
      await sleepOnContainerIdleTimeout();
      expect(runtimeRows()).toEqual(SLEPT_ROWS);

      const response = await postChatAction('stop');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'stopped', workspaceDeleted: true });
      expect(vmAgent.starts).toBe(0);
      expect(vmAgent.signals).toEqual([]);
      // Liveness: the real teardown ran to the end.
      expect(runtimeRows()).toEqual(ARCHIVED_ROWS);
      expect(getSession(projectDataSql(), CHAT_SESSION_ID)).toMatchObject({
        status: 'stopped',
      });
    });

    it('answers a cancel with nothing in flight without waking its container', async () => {
      await sleepOnContainerIdleTimeout();

      const response = await postChatAction('cancel');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'idle',
        message: 'No prompt in flight to cancel',
      });
      expect(vmAgent.starts).toBe(0);
      expect(vmAgent.signals).toEqual([]);
      expect(runtimeRows()).toEqual(SLEPT_ROWS);
    });

    // Controls: a live agent is still signalled, or these pass with the signals deleted.
    it('still signals a live agent before archiving it', async () => {
      const response = await postChatAction('stop');

      expect(response.status).toBe(200);
      expect(vmAgent.signals).toEqual([`${AGENT_PATH}/cancel`, `${AGENT_PATH}/stop`]);
      expect(runtimeRows()).toEqual(ARCHIVED_ROWS);
    });

    it('still forwards a cancel to a live agent', async () => {
      const response = await postChatAction('cancel');

      expect(response.status).toBe(200);
      expect(vmAgent.signals).toEqual([`${AGENT_PATH}/cancel`]);
    });

    it('leaves the container asleep when the workspace page stops the slept agent', async () => {
      await sleepOnContainerIdleTimeout();

      const response = await postWorkspaceAgentAction('stop');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'sleeping' });
      expect(vmAgent.starts).toBe(0);
      expect(vmAgent.signals).toEqual([]);
      expect(runtimeRows()).toEqual(SLEPT_ROWS);
    });

    // Controls for the workspace page: a live agent is stopped, and an orphaned agent
    // session that is merely not `running` still gets the stop its process may need.
    it('still stops a live agent from the workspace page', async () => {
      const response = await postWorkspaceAgentAction('stop');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'stopped' });
      expect(vmAgent.signals).toEqual([`${AGENT_PATH}/stop`]);
    });

    // The session sleep leaves an older agent session `running` on the slept node, so a check
    // on the agent session's status alone would wake the container to stop or suspend it.
    it.each([
      ['stops', 'stop', 'stopped'],
      ['suspends', 'suspend', 'suspended'],
    ] as const)(
      'leaves the container asleep when the workspace page %s a session the sleep left running',
      async (_verb, action, status) => {
        const leftRunning = seedOlderRunningAgentSession();
        await sleepThroughSessionSleep();
        expect(runtimeRows().node).toEqual(SLEPT_ROWS.node);
        expect(agentSessionStatus(leftRunning)).toBe('running');

        const response = await postWorkspaceAgentAction(action, leftRunning);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status });
        expect(vmAgent.starts).toBe(0);
        expect(vmAgent.signals).toEqual([]);
        // Liveness: the route still recorded the transition it was asked for.
        expect(agentSessionStatus(leftRunning)).toBe(status);
      }
    );

    it('still suspends a live agent from the workspace page', async () => {
      const response = await postWorkspaceAgentAction('suspend');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'suspended' });
      expect(vmAgent.signals).toEqual([`${AGENT_PATH}/suspend`]);
    });

    it('still stops an orphaned agent that is not running from the workspace page', async () => {
      d1.prepare(`UPDATE agent_sessions SET status = 'error' WHERE id = ?`).run(AGENT_SESSION_ID);

      const response = await postWorkspaceAgentAction('stop');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'error' });
      expect(vmAgent.signals).toEqual([`${AGENT_PATH}/stop`]);
    });
  });
});
