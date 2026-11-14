import { Container } from '@cloudflare/containers';
import {
  appendDeploymentPublishJobEvent,
  isCloudflareBuildCapacityError,
  PUBLISH_JOB_TERMINAL_STATUSES,
  releaseCloudflareBuildReservation,
  startReservedCloudflareBuild,
} from '@simple-agent-manager/app-deployment';
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
}

/** One DinD microVM per publishJobId, never reused across jobs/projects.
 * Guest code cannot extend the persisted deadline or access Worker bindings. */
export class ComposeBuilderContainer extends Container<Env> {
  defaultPort = PORT;
  sleepAfter: string | number = '20m'; // Upper safety bound; set from each admitted job below.
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [
    `api.${this.env.BASE_DOMAIN}`,
    `${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    'registry-1.docker.io',
    'auth.docker.io',
    'production.cloudflare.docker.com',
    'docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com',
    'registry.npmjs.org',
    'deb.debian.org',
    'security.debian.org',
    'dl-cdn.alpinelinux.org',
    'pypi.org',
    'files.pythonhosted.org',
  ];
  private operation: Promise<unknown> = Promise.resolve();
  private startAbort?: AbortController;
  private kickoff: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.catch(() => undefined);
    return result;
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
  async startJob(jobId: string, attempt: number) {
    const { job } = await this.loadJob(jobId, attempt);
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
    const previous = await this.ctx.storage.get<BuildState>(STATE_KEY);
    if (previous && (previous.jobId !== jobId || previous.attempt !== attempt))
      throw errors.conflict('Builder identity cannot be reused');
    if (previous?.accepted) return { accepted: true, version: previous.version };
    const stopRetryMs =
      previous?.stopRetryMs ??
      Number(await resolveAdminSetting(this.env, 'deployments.builderCapacityBackoffMs'));
    await this.ctx.storage.put(STATE_KEY, { ...previous, jobId, attempt, deadline, stopRetryMs });
    await this.schedule(new Date(deadline), 'enforceDeadline');
    await this.schedule(new Date(), 'launchBuilder', { jobId, attempt });
    return { accepted: true };
  }
  async launchBuilder(identity: { jobId: string; attempt: number }) {
    // Alarm delivery and cron recovery may overlap. Coalesce the full operation,
    // including stop/requeue, so stale deliveries cannot defeat capacity backoff.
    const run = this.kickoff.then(async () => {
      const { job } = await this.loadJob(identity.jobId, identity.attempt);
      if (!job || job.status !== 'starting' || job.executorInstanceId !== job.id) return;
      const ports = createCloudflareBuildPorts(this.env);
      await startReservedCloudflareBuild(
        this.env.DATABASE,
        {
          ...ports,
          builder: {
            start: async () => {
              try {
                await this.launchNow(identity.jobId, identity.attempt);
                return 'started';
              } catch (error) {
                if (isCloudflareBuildCapacityError(error)) return 'capacity';
                throw error;
              }
            },
            stop: async () => {
              await this.stopJob();
            },
          },
        },
        job
      );
    });
    this.kickoff = run.catch(() => undefined);
    return run;
  }
  private async launchNow(jobId: string, attempt: number) {
    return this.serialized(async () => {
      const { job } = await this.loadJob(jobId, attempt);
      if (
        !job ||
        job.executorInstanceId !== jobId ||
        !job.executorDeadlineAt ||
        !job.agentProfileId ||
        PUBLISH_JOB_TERMINAL_STATUSES.has(job.status)
      )
        throw errors.conflict('Builder reservation is no longer current');
      const previous = await this.ctx.storage.get<BuildState>(STATE_KEY);
      if (previous && (previous.jobId !== jobId || previous.attempt !== attempt))
        throw errors.conflict('Builder identity cannot be reused');
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
      await this.startAndWaitForPorts({
        ports: [PORT],
        cancellationOptions: {
          abort: signal,
          instanceGetTimeoutMS: startTimeoutMs,
          portReadyTimeoutMS: startTimeoutMs,
        },
      });
      const health = await this.containerFetch('http://builder/health', { signal });
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
      const response = await this.containerFetch('http://builder/start', {
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
      await appendDeploymentPublishJobEvent(drizzle(this.env.DATABASE, { schema }), {
        publishJobId: jobId,
        expectedAttempt: attempt,
        projectId: job.projectId,
        environmentId: job.environmentId,
        workspaceId: job.workspaceId,
        nodeId: job.nodeId,
        currentStep: 'builder_accepted',
        eventType: 'publish.builder.accepted',
        message: 'Cloudflare builder accepted job',
        detail: { version: version.version },
      });
      return { version: version.version };
    });
  }
  async stopJob() {
    this.startAbort?.abort();
    return this.serialized(async () => {
      const state = await this.ctx.storage.get<BuildState>(STATE_KEY);
      if (state) await this.ctx.storage.put(STATE_KEY, { ...state, stopRequested: true });
      await this.destroy();
      if (state)
        await releaseCloudflareBuildReservation(
          drizzle(this.env.DATABASE, { schema }),
          state.jobId,
          state.attempt
        );
    });
  }
  async enforceDeadline() {
    const state = await this.ctx.storage.get<BuildState>(STATE_KEY);
    // Destruction must not wait for D1 or lifecycle publication. A database
    // outage may delay the verdict, but cannot extend arbitrary RUN execution.
    this.startAbort?.abort();
    try {
      await this.stopJob();
    } catch (error) {
      // Container SDK consumes one-shot schedules even when a callback throws.
      // Re-arm explicitly; preserve the original deadline rather than extending it.
      if (state) await this.schedule(new Date(Date.now() + state.stopRetryMs), 'enforceDeadline');
      throw error;
    }
    if (!state) return;
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
    }
  }
  override async onStop() {
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
