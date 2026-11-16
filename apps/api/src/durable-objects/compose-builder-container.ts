import { Container } from '@cloudflare/containers';
import {
  appendDeploymentPublishJobEvent,
  type CloudflareBuildStopGuard,
  isCloudflareBuildCapacityError,
  PUBLISH_JOB_TERMINAL_STATUSES,
  recoverReservedCloudflareBuild,
  releaseCloudflareBuildReservation,
  startReservedCloudflareBuild,
} from '@simple-agent-manager/app-deployment';
import { log } from '@simple-agent-manager/worker-core';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { createCloudflareBuildPorts } from '../app-deployment-ports/cloudflare-builder';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveAdminSetting } from '../services/admin-settings';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../services/project-lifecycle-events';
import { signPublishJobToken } from '../services/publish-job-token';

const PORT = 8080;
const STATE_KEY = 'buildJob';
interface BuildState {
  jobId: string;
  attempt: number;
  deadline: number;
  stopRetryMs: number;
  stopRequested?: boolean;
  version?: string;
  accepted?: boolean;
  reservationEpoch?: string | null;
}

/** One DinD microVM per publishJobId, never reused across jobs/projects.
 * Guest code cannot extend the persisted deadline or access Worker bindings. */
export class ComposeBuilderContainer extends Container<Env> {
  defaultPort = PORT;
  sleepAfter: string | number = '20m'; // Upper safety bound; set from each admitted job below.
  // Deployment builds have the same unrestricted Internet access as VM workspaces.
  // Keep transfers direct: no SDK outbound proxy or HTTPS interception. The
  // one-job microVM and scoped callback token, not an egress filter, are the boundary.
  enableInternet = true;
  private operation: Promise<unknown> = Promise.resolve();
  private startAbort?: AbortController;
  private startupInProgress = false;
  private kickoff: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.catch(() => undefined);
    return result;
  }
  private fetchBootstrap(url: string, init: RequestInit & { signal: AbortSignal }) {
    init.signal.throwIfAborted();
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Builder stopped before acceptance');
    // Raw workerd port transport never invokes the SDK's implicit restart path.
    return container.getTcpPort(PORT).fetch(url, init);
  }
  private async loadJob(jobId: string, attempt: number) {
    const db = drizzle(this.env.DATABASE, { schema });
    const [job] = await db
      .select()
      .from(schema.deploymentPublishJobs)
      .where(
        and(
          eq(schema.deploymentPublishJobs.id, jobId),
          eq(schema.deploymentPublishJobs.attempt, attempt),
          eq(schema.deploymentPublishJobs.executor, 'cloudflare'),
          eq(schema.deploymentPublishJobs.contextShadow, false)
        )
      )
      .limit(1);
    return { db, job };
  }
  /** Acknowledge persisted kickoff promptly; cold startup is owned by a DO
   * alarm, not the source HTTP waitUntil's 30-second lifetime. */
  async startJob(jobId: string, attempt: number, expectedEpoch: string | null = null) {
    return this.serialized(async () => {
      let { job } = await this.loadJob(jobId, attempt);
      if ((job?.executorNotBefore ?? null) !== expectedEpoch)
        throw errors.conflict('Builder reservation changed');
      if (job?.status === 'context_ready' && job.executorInstanceId === job.id) {
        await recoverReservedCloudflareBuild(
          drizzle(this.env.DATABASE, { schema }),
          jobId,
          attempt
        );
        // A competing terminal/progress update may have won the repair CAS.
        // Inspect it before either the accepted short-circuit or new kickoff.
        ({ job } = await this.loadJob(jobId, attempt));
      }
      if (
        !job ||
        job.executorInstanceId !== jobId ||
        !job.executorDeadlineAt ||
        PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)
      )
        throw errors.conflict('Builder reservation is no longer current');
      const deadline = Date.parse(job.executorDeadlineAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now())
        throw errors.conflict('Builder deadline elapsed');
      let previous = await this.ctx.storage.get<BuildState>(STATE_KEY);
      if (previous && (previous.jobId !== jobId || previous.attempt !== attempt))
        throw errors.conflict('Builder identity cannot be reused');
      if ((previous?.reservationEpoch ?? null) !== expectedEpoch) previous = undefined;
      if (previous?.accepted) return { accepted: true, version: previous.version };
      const stopRetryMs =
        previous?.stopRetryMs ??
        Number(await resolveAdminSetting(this.env, 'deployments.builderCapacityBackoffMs'));
      await this.ctx.storage.put(STATE_KEY, {
        ...previous,
        jobId,
        attempt,
        deadline,
        stopRetryMs,
        reservationEpoch: expectedEpoch,
      });
      await this.schedule(new Date(deadline), 'enforceDeadline');
      await this.schedule(new Date(), 'launchBuilder', {
        jobId,
        attempt,
        notBefore: expectedEpoch,
      });
      return { accepted: true };
    });
  }
  launchBuilder(identity: { jobId: string; attempt: number; notBefore?: string | null }) {
    // SDK alarms await callbacks sequentially. Do not hold the hard deadline
    // behind a stalled D1 read or other kickoff work.
    this.ctx.waitUntil(
      this.runBuilder(identity).catch(() => {
        log.warn('cloudflare_builder.kickoff_pending', { publishJobId: identity.jobId });
      })
    );
  }
  async runBuilder(identity: { jobId: string; attempt: number; notBefore?: string | null }) {
    // Alarm delivery and cron recovery may overlap. Coalesce the full operation,
    // including stop/requeue, so stale deliveries cannot defeat capacity backoff.
    const run = this.kickoff.then(async () => {
      let { job } = await this.loadJob(identity.jobId, identity.attempt);
      if ((job?.executorNotBefore ?? null) !== (identity.notBefore ?? null)) return;
      if (job?.status === 'context_ready' && job.executorInstanceId === job.id) {
        job =
          (await recoverReservedCloudflareBuild(
            drizzle(this.env.DATABASE, { schema }),
            identity.jobId,
            identity.attempt
          )) ?? undefined;
      }
      if (!job || job.status !== 'starting' || job.executorInstanceId !== job.id) return;
      const ports = createCloudflareBuildPorts(this.env);
      await startReservedCloudflareBuild(
        this.env.DATABASE,
        {
          ...ports,
          builder: {
            start: async () => {
              try {
                await this.launchNow(identity.jobId, identity.attempt, identity.notBefore ?? null);
                return 'started';
              } catch (error) {
                if (isCloudflareBuildCapacityError(error)) return 'capacity';
                throw error;
              }
            },
            stop: async (_job, capacity) => {
              await this.stopJob(capacity);
            },
          },
        },
        job
      );
    });
    this.kickoff = run.catch(() => undefined);
    return run;
  }
  private async launchNow(jobId: string, attempt: number, expectedEpoch: string | null) {
    return this.serialized(async () => {
      const { job } = await this.loadJob(jobId, attempt);
      if (
        !job ||
        (job.executorNotBefore ?? null) !== expectedEpoch ||
        job.executorInstanceId !== jobId ||
        !job.executorDeadlineAt ||
        !job.agentProfileId ||
        PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)
      )
        throw errors.conflict('Builder reservation is no longer current');
      let previous = await this.ctx.storage.get<BuildState>(STATE_KEY);
      if (previous && (previous.jobId !== jobId || previous.attempt !== attempt))
        throw errors.conflict('Builder identity cannot be reused');
      if ((previous?.reservationEpoch ?? null) !== expectedEpoch) previous = undefined;
      // RUN can bind the former bootstrap port after the controller closes it.
      // Never contact that port again after acceptance; status is callback-only.
      if (previous?.accepted) return { version: previous.version };
      const deadline = Date.parse(job.executorDeadlineAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now())
        throw errors.conflict('Builder deadline elapsed');
      const state: BuildState = {
        jobId,
        attempt,
        deadline,
        stopRetryMs:
          previous?.stopRetryMs ??
          Number(await resolveAdminSetting(this.env, 'deployments.builderCapacityBackoffMs')),
        stopRequested: previous?.stopRequested,
        reservationEpoch: expectedEpoch,
      };
      await this.ctx.storage.put(STATE_KEY, state);
      // Schedule before startup; Container's scheduler owns the underlying alarm.
      await this.schedule(new Date(deadline), 'enforceDeadline');
      const { startTimeoutMs, callbackTimeoutMs, callbackAttempts, callbackRetryDelayMs } =
        await Promise.all([
          resolveAdminSetting(this.env, 'deployments.builderDaemonReadyTimeoutMs'),
          resolveAdminSetting(this.env, 'deployments.builderCallbackTimeoutMs'),
          resolveAdminSetting(this.env, 'deployments.builderCallbackAttempts'),
          resolveAdminSetting(this.env, 'deployments.builderCallbackRetryDelayMs'),
        ]).then(([start, timeout, attempts, delay]) => ({
          startTimeoutMs: Number(start),
          callbackTimeoutMs: Number(timeout),
          callbackAttempts: Number(attempts),
          callbackRetryDelayMs: Number(delay),
        }));
      this.sleepAfter = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      // Only non-secret control budgets enter the process environment.
      this.envVars = {
        SAM_BUILDER_BOOTSTRAP_TIMEOUT_MS: String(startTimeoutMs),
        SAM_BUILDER_CONTROL_TIMEOUT_MS: String(callbackTimeoutMs),
      };
      this.startAbort = new AbortController();
      const signal = AbortSignal.any([
        this.startAbort.signal,
        AbortSignal.timeout(Math.min(startTimeoutMs, deadline - Date.now())),
      ]);
      this.startupInProgress = true;
      try {
        await this.startAndWaitForPorts({
          ports: [PORT],
          cancellationOptions: {
            abort: signal,
            instanceGetTimeoutMS: startTimeoutMs,
            portReadyTimeoutMS: startTimeoutMs,
          },
        });
      } finally {
        this.startupInProgress = false;
        if (signal.aborted) {
          // The SDK can start after awaiting internal work even if the signal
          // was already aborted. Reconcile locally before any D1 failure write.
          await this.stopContainer(state);
          await this.schedule(new Date(), 'enforceDeadline');
        }
      }
      signal.throwIfAborted();
      // Private SDK transport to this microVM's port; this is not an Internet HTTP endpoint.
      const health = await this.fetchBootstrap('http://builder/health', { signal });
      const version: unknown = await health.json();
      if (
        !health.ok ||
        !version ||
        typeof version !== 'object' ||
        !('version' in version) ||
        typeof version.version !== 'string'
      )
        throw new Error('Builder version unavailable');
      if (
        this.env.VM_AGENT_REQUIRED_VERSION &&
        version.version !== this.env.VM_AGENT_REQUIRED_VERSION
      )
        throw new Error('Builder version does not match deployed agent release');
      await this.ctx.storage.put(STATE_KEY, {
        ...state,
        version: version.version,
        stopRequested: false,
      });
      // Cancellation can commit while startup/health await network I/O.
      const { job: current } = await this.loadJob(jobId, attempt);
      if (!current || PUBLISH_JOB_TERMINAL_STATUSES.has(current.status))
        throw errors.conflict('Builder job revoked during startup');
      const token = await signPublishJobToken(
        this.env,
        {
          jobId,
          attempt,
          projectId: job.projectId,
          environmentId: job.environmentId,
          agentProfileId: job.agentProfileId,
        },
        deadline
      );
      // Launch never traverses public HTTP; Container SDK routes inside its private port transport.
      const response = await this.fetchBootstrap('http://builder/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          jobId,
          attempt,
          projectId: job.projectId,
          deadlineAt: job.executorDeadlineAt,
          controlPlaneUrl: `https://api.${this.env.BASE_DOMAIN}`,
          token,
          callbackTimeoutMs,
          callbackAttempts,
          callbackRetryDelayMs,
        }),
      });
      if (response.status !== 202) throw new Error('Builder rejected launch');
      await this.ctx.storage.put(STATE_KEY, {
        ...state,
        version: version.version,
        accepted: true,
        stopRequested: false,
      });
      this.ctx.waitUntil(
        appendDeploymentPublishJobEvent(drizzle(this.env.DATABASE, { schema }), {
          publishJobId: jobId,
          expectedAttempt: attempt,
          projectId: job.projectId,
          environmentId: job.environmentId,
          workspaceId: job.workspaceId,
          nodeId: job.nodeId,
          eventType: 'publish.builder.accepted',
          message: 'Cloudflare builder accepted job',
          detail: { version: version.version },
        }).catch(() => {
          log.warn('cloudflare_builder.accepted_event_pending', { publishJobId: jobId });
        })
      );
      return { version: version.version };
    });
  }
  private async stopContainer(state: BuildState | undefined) {
    if (state) await this.ctx.storage.put(STATE_KEY, { ...state, stopRequested: true });
    // Calling destroy on an inactive guest can activate platform compute. Read
    // workerd's synchronous running flag, never a fetch/start/state SDK path.
    if (this.ctx.container?.running) await this.destroy();
    this.deleteSchedules('launchBuilder'); // Includes schedules persisted by older code.
    this.deleteSchedules('enforceDeadline');
    if (this.startupInProgress && state)
      await this.schedule(new Date(Date.now() + state.stopRetryMs), 'enforceDeadline');
  }
  async stopJob(capacity?: CloudflareBuildStopGuard) {
    if (!capacity) this.startAbort?.abort();
    return this.serialized(async () => {
      const state = await this.ctx.storage.get<BuildState>(STATE_KEY);
      const db = drizzle(this.env.DATABASE, { schema });
      if (capacity) {
        const { job } = await this.loadJob(capacity.jobId, capacity.attempt);
        if (
          !job ||
          job.executorInstanceId !== job.id ||
          (job.executorNotBefore ?? null) !== capacity.notBefore ||
          (job.status !== 'starting' && !PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)) ||
          (state?.accepted &&
            (state.reservationEpoch ?? null) === capacity.notBefore &&
            !PUBLISH_JOB_TERMINAL_STATUSES.has(job.status))
        )
          return;
        // A rejected old epoch must not even abort a newer startup.
        this.startAbort?.abort();
      }
      await this.stopContainer(state);
      if (capacity) {
        await releaseCloudflareBuildReservation(
          db,
          capacity.jobId,
          capacity.attempt,
          capacity.retryAt,
          capacity.notBefore
        );
      } else if (state) {
        await releaseCloudflareBuildReservation(db, state.jobId, state.attempt);
      }
    });
  }
  async enforceDeadline() {
    const state = await this.ctx.storage.get<BuildState>(STATE_KEY);
    // Destruction must not wait for D1 or lifecycle publication. A database
    // outage may delay the verdict, but cannot extend arbitrary RUN execution.
    this.startAbort?.abort();
    try {
      // Bypass the startup queue: database reads in that queue may be stalled.
      // The execution deadline owns destruction independently of D1 health.
      await this.stopContainer(state);
    } catch (error) {
      // Container SDK consumes one-shot schedules even when a callback throws.
      // Re-arm explicitly; preserve the original deadline rather than extending it.
      if (state) await this.schedule(new Date(Date.now() + state.stopRetryMs), 'enforceDeadline');
      throw error;
    }
    if (!state || this.startupInProgress) return;
    const { db, job } = await this.loadJob(state.jobId, state.attempt);
    if (job && !PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)) {
      const changed = await appendDeploymentPublishJobEvent(db, {
        publishJobId: job.id,
        expectedAttempt: state.attempt,
        projectId: job.projectId,
        environmentId: job.environmentId,
        workspaceId: job.workspaceId,
        nodeId: job.nodeId,
        status: 'failed',
        terminal: true,
        eventType: 'publish.builder.deadline',
        currentStep: 'deadline',
        message: 'Cloudflare build hard deadline exceeded',
        errorCode: 'deadline_exceeded',
      });
      await releaseCloudflareBuildReservation(db, state.jobId, state.attempt);
      if (changed)
        await recordDeploymentPublishJobLifecycleEventBestEffort(this.env, {
          projectId: job.projectId,
          publishJobId: job.id,
          environmentId: job.environmentId,
          status: 'failed',
          terminal: true,
          currentStep: 'deadline',
          source: 'cloudflare_builder.deadline',
          occurredAt: Date.now(),
        });
    } else if (job) {
      await releaseCloudflareBuildReservation(db, state.jobId, state.attempt);
    }
  }
  override async onStop() {
    // SDK startup synchronizes a previous guest's pending stop event before it
    // starts the next guest. The current startup owns its failure verdict and
    // deadline; that older notification cannot revoke either.
    if (this.startupInProgress || this.ctx.container?.running) return;
    const state = await this.ctx.storage.get<BuildState>(STATE_KEY);
    if (!state) return;
    const { db, job } = await this.loadJob(state.jobId, state.attempt);
    if (job && !state.stopRequested && !PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)) {
      const changed = await appendDeploymentPublishJobEvent(db, {
        publishJobId: job.id,
        expectedAttempt: state.attempt,
        projectId: job.projectId,
        environmentId: job.environmentId,
        workspaceId: job.workspaceId,
        nodeId: job.nodeId,
        status: 'failed',
        terminal: true,
        eventType: 'publish.builder.exited',
        currentStep: 'builder_exit',
        message: 'Cloudflare builder exited before completing the job',
        errorCode: 'builder_exited',
      });
      if (changed)
        await recordDeploymentPublishJobLifecycleEventBestEffort(this.env, {
          projectId: job.projectId,
          publishJobId: job.id,
          environmentId: job.environmentId,
          status: 'failed',
          terminal: true,
          currentStep: 'builder_exit',
          source: 'cloudflare_builder.exit',
          occurredAt: Date.now(),
        });
    }
    await releaseCloudflareBuildReservation(db, state.jobId, state.attempt);
  }
}
