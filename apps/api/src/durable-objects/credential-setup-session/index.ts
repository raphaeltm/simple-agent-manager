/**
 * CredentialSetupSession — per-session Durable Object that drives one guided
 * agent login inside a short-lived Cloudflare Sandbox.
 * FILE SIZE EXCEPTION: This monolithic lifecycle DO is intentionally kept intact
 * for the PR refresh; split state-machine concerns in a dedicated follow-up.
 *
 * One DO per setup session (keyed by the session id, which is ALSO the sandbox
 * id — 1:1, never shared across users). The DO owns the lifecycle state machine:
 *
 *   creating -> provisioning -> admitting -> waiting_for_user -> exchanging -> capturing -> saving
 *            -> completed | failed | cancelled | expired
 *
 * It provisions a per-session credential home, starts the provider setup driver,
 * surfaces only non-secret URL/code details, then polls for the captured
 * credential file. The DO reads the credential server-side, validates + saves it
 * as an encrypted credential via the shared credential-save path, then tears the
 * sandbox down.
 *
 * SECURITY: the captured credential is read server-side and never transits this
 * DO's SQLite, the D1 row, logs, or the browser. Only non-secret lifecycle
 * metadata is persisted. Every terminal state runs teardown so a vanished browser
 * leaves no orphan (rules 43/47):
 *   1. Arm a recovery alarm, then synchronously claim the terminal status in DO
 *      SQLite and mark cleanup pending with its pre-claim status.
 *   2. Mark the D1 row terminal BEFORE any sandbox I/O, so an isolate that dies
 *      mid-teardown never leaves D1 active for the create route's one-active lookup.
 *   3. `./cleanup.ts`: scrub the setup dir (skipped when teardown starts from
 *      `provisioning`), destroy the sandbox, release the pool slot, repair D1, then
 *      clear the marker and the alarm. The alarm joins a cleanup already running in
 *      this isolate instead of starting a second one.
 * If the isolate dies during step 3, `alarm()` finds a terminal row with
 * `cleanup_pending = 1` and resumes the cleanup with at most
 * its snapshotted recovery work cap, plus at most two success continuations. SDK
 * flights wait for settlement or an immutable watchdog without spending attempts.
 *
 * Storage: embedded SQLite (wrangler `new_sqlite_classes`). The constructor runs
 * the additive DDL in `./schema.ts`, which the DO migration safety check scans.
 */
import type { AgentType, CredentialKind } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  OWN_AGENT_ACCOUNT_PROJECT_CAPABILITY,
  requireProjectCapability,
} from '../../middleware/project-auth';
import { saveAgentCredentialForUser } from '../../services/agent-credential-save';
import {
  getClaudeOauthTokenMaxLength,
  getClaudeVerificationCodeMaxLength,
  isTerminalSetupStatus,
  SANDBOX_PERMANENT_STARTUP_MESSAGE,
  type SetupSessionStatus,
} from '../../services/credential-setup-config';
import { deferAlarmWhenDisabled } from '../../services/operational-kill-switch';
import { getSandboxInstance, shellQuote } from '../../services/sandbox';
import { CredentialValidator } from '../../services/validation';
import { runSetupSessionCleanup } from './cleanup';
import {
  claimCleanupAttempt,
  cleanupAttemptLimit,
  deferPendingCleanup,
  ensureCleanupWake,
  joinCleanupFlight,
  snapshotCleanupPolicy,
} from './cleanup-recovery';
import { type SetupSessionD1Extra, updateSetupSessionD1Status } from './d1-status';
import { type DeviceAuthState, driverFailure } from './driver-state';
import {
  armCleanupAlarmBestEffort,
  beginSandboxFlight,
  readDeviceAuthState,
  runProvisioningSandboxSteps,
  trackSandboxFlight,
} from './lifecycle-io';
import {
  type DeviceAuthDetailsRow,
  ensureSetupSessionSchema,
  type SetupSessionRow,
} from './schema';

export interface CreateSetupSessionParams {
  id: string;
  userId: string;
  projectId: string | null;
  scope: string;
  agentType: AgentType;
  credentialKind: CredentialKind;
  provider: string;
  agentName: string;
  poolLeaseId: string;
  setupHome: string;
  ttlMs: number;
  capturePollMs: number;
}

export interface SetupSessionStateResult {
  id: string;
  status: SetupSessionStatus;
  expiresAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  verificationUrl: string | null;
  userCode: string | null;
}

/** Relative paths of captured credential files inside the per-session setup home. */
const CODEX_AUTH_FILE = 'auth.json';
const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token.txt';
const CLAUDE_VERIFICATION_CODE_FILE = 'verification-code.txt';
const CLAUDE_VERIFICATION_CODE_PATTERN = /^[A-Za-z0-9._~#-]+$/;
const DEVICE_AUTH_STATE_FILE = 'device-auth-state.json';

function setupDisplayName(agentType: string): string {
  return agentType === 'claude-code' ? 'Claude Code' : 'Codex';
}

function requiresUserCode(agentType: string): boolean {
  return agentType === 'openai-codex';
}

function credentialFileName(agentType: string): string {
  return agentType === 'claude-code' ? CLAUDE_OAUTH_TOKEN_FILE : CODEX_AUTH_FILE;
}

export class CredentialSetupSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /**
   * The cleanup this isolate is running, if any. In memory on purpose: after an
   * isolate death it is gone, and the recovery alarm then runs the cleanup itself.
   */
  private cleanupInFlight: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      ensureSetupSessionSchema(this.sql);
    });
  }

  /**
   * Initialize the session and kick off provisioning via an immediate alarm.
   * Returns fast (status `provisioning`) so the HTTP create request does not
   * block on Sandbox cold start — the alarm loop does the slow work (rule 43).
   * The D1 row is created by the route (for atomic one-active enforcement)
   * before this is called.
   */
  async create(params: CreateSetupSessionParams): Promise<SetupSessionStateResult> {
    const now = Date.now();
    const expiresAt = now + params.ttlMs;
    this.sql.exec(
      `INSERT OR REPLACE INTO setup_session (
        id, user_id, project_id, scope, agent_type, credential_kind, provider,
        agent_name, status, pool_lease_id, codex_home, expires_at, capture_poll_ms,
        error_code, error_message, completed_at, cleanup_sandbox_io_pending
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      params.id,
      params.userId,
      params.projectId,
      params.scope,
      params.agentType,
      params.credentialKind,
      params.provider,
      params.agentName,
      params.poolLeaseId,
      params.setupHome,
      expiresAt,
      params.capturePollMs
    );
    await this.ctx.storage.setAlarm(now); // immediate — provision on first tick
    return {
      id: params.id,
      status: 'provisioning',
      expiresAt,
      errorCode: null,
      errorMessage: null,
      verificationUrl: null,
      userCode: null,
    };
  }

  /** Read authoritative state (used by GET status when the DO is preferred over D1). */
  getState(): SetupSessionStateResult | null {
    const row = this.readRow();
    if (!row) return null;
    const deviceAuth =
      row.status === 'waiting_for_user' || row.status === 'exchanging'
        ? this.readDeviceAuthDetails()
        : null;
    return {
      id: row.id,
      status: row.status as SetupSessionStatus,
      expiresAt: row.expires_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      verificationUrl: deviceAuth?.verification_url ?? null,
      userCode: deviceAuth?.user_code ?? null,
    };
  }

  /** User- or sweep-initiated cancel. Tears down unless already terminal. */
  async cancel(): Promise<SetupSessionStateResult> {
    const row = this.readRow();
    if (!row) {
      return {
        id: '',
        status: 'cancelled',
        expiresAt: 0,
        errorCode: null,
        errorMessage: null,
        verificationUrl: null,
        userCode: null,
      };
    }
    // Saving is the commit point: the encrypted credential write may already be
    // in flight and cannot be safely rolled back by a concurrent cancel.
    if (row.status === 'saving')
      return (
        this.getState() ?? {
          id: row.id,
          status: 'saving',
          expiresAt: row.expires_at,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          verificationUrl: null,
          userCode: null,
        }
      );
    if (!isTerminalSetupStatus(row.status)) {
      await this.teardown('cancelled');
    }
    const after = this.readRow();
    return {
      id: row.id,
      status: (after?.status ?? 'cancelled') as SetupSessionStatus,
      expiresAt: row.expires_at,
      errorCode: after?.error_code ?? null,
      errorMessage: after?.error_message ?? null,
      verificationUrl: null,
      userCode: null,
    };
  }

  /** Forward the browser-displayed short-lived code to the sandboxed Claude CLI. */
  async submitVerificationCode(code: string): Promise<SetupSessionStateResult> {
    const row = this.readRow();
    if (!row) throw new Error('Setup session not found');
    if (row.agent_type !== 'claude-code') {
      throw new Error('Verification code submission is only supported for Claude Code setup');
    }
    if (row.status !== 'waiting_for_user') {
      throw new Error('Claude Code setup is not waiting for a verification code');
    }

    const normalizedCode = code.trim().replace(/\s+/g, '');
    if (
      normalizedCode.length === 0 ||
      normalizedCode.length > getClaudeVerificationCodeMaxLength(this.env) ||
      !CLAUDE_VERIFICATION_CODE_PATTERN.test(normalizedCode)
    ) {
      throw new Error('Invalid Claude verification code');
    }

    await this.withSandboxFlight(row, async () => {
      const sandbox = await getSandboxInstance(this.env, row.id);
      if (this.readRow()?.status !== 'waiting_for_user')
        throw new Error('Claude Code setup is no longer waiting for a verification code');
      await sandbox.writeFile(`${row.codex_home}/${CLAUDE_VERIFICATION_CODE_FILE}`, normalizedCode);
    });
    if (this.readRow()?.status !== 'waiting_for_user')
      throw new Error('Claude Code setup is no longer waiting for a verification code');
    this.setStatus(row.id, 'exchanging');
    await this.updateD1Status(row.id, 'exchanging');
    if (this.readRow()?.status !== 'exchanging')
      return this.getState() ?? this.terminalState(row, 'cancelled');
    await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
    return this.getState() ?? this.terminalState(row, 'exchanging');
  }

  /**
   * Alarm loop: provisions on the first tick, then polls for the captured
   * auth.json, and enforces the TTL. Every branch either reschedules the alarm
   * or reaches a terminal teardown, so a session cannot get stuck armed.
   */
  async alarm(): Promise<void> {
    try {
      await this.alarmTick();
    } finally {
      const row = this.readRow();
      if (row) await ensureCleanupWake(this.ctx, this.sql, row);
    }
  }

  private async alarmTick(): Promise<void> {
    if (await deferAlarmWhenDisabled(this.env, this.ctx.storage, 'CredentialSetupSession')) return;

    const row = this.readRow();
    if (!row) return; // torn down / never created — nothing to do
    if (isTerminalSetupStatus(row.status)) {
      // A terminal row only needs work when its teardown cleanup never finished (the
      // isolate died mid-teardown). Otherwise terminal is a fixed point.
      if (row.cleanup_pending === 1) await this.resumeCleanup(row);
      return;
    }

    // TTL guard — fail closed to expired.
    if (Date.now() >= row.expires_at) {
      await this.teardown(
        'expired',
        'setup_session_expired',
        'Setup session timed out before sign-in completed'
      );
      return;
    }

    try {
      if (row.status === 'provisioning') {
        await this.provision(row);
        return;
      }
      if (row.status === 'admitting') {
        await this.pollDeviceAuth(row);
        return;
      }
      if (row.status === 'saving') {
        await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
        return;
      }
      // waiting_for_user | exchanging | capturing — observe driver failure and capture output.
      const driverState = await this.readDeviceAuthState(row);
      if (isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return;
      if (driverState?.status === 'failed') {
        const failure = driverFailure(driverState, setupDisplayName(row.agent_type));
        log.warn('credential_setup.driver_failed', {
          sessionId: row.id,
          phase: row.status,
          errorCode: failure.code,
          diagnostics: driverState.diagnostics ?? {},
        });
        await this.teardown('failed', failure.code, failure.message);
        return;
      }
      await this.attemptCapture(row);
    } catch (err) {
      // Unexpected transient error — log and reschedule; the TTL guard bounds
      // total retries so this cannot loop forever.
      log.warn('credential_setup.alarm_error', {
        sessionId: row.id,
        status: row.status,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
    }
  }

  private async provision(row: SetupSessionRow): Promise<void> {
    const displayName = setupDisplayName(row.agent_type);
    const settle = beginSandboxFlight(this.sql, row.id, () =>
      armCleanupAlarmBestEffort(this.ctx, row)
    );
    try {
      const currentFlight = await runProvisioningSandboxSteps(
        this.env,
        row,
        () => this.readRow()?.status === 'provisioning',
        this.startSetupDriverCommand(row, `${row.codex_home}/${DEVICE_AUTH_STATE_FILE}`)
      );
      await settle(); // D1 bookkeeping cannot restart sandbox work.
      if (!currentFlight) return;
      const current = this.readRow();
      if (!current || current.status !== 'provisioning') return;
      this.setStatus(current.id, 'admitting');
      await this.updateD1Status(current.id, 'admitting', { started: true });
      if (this.readRow()?.status !== 'admitting') return;
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
    } catch (err) {
      await settle();
      const message = err instanceof Error ? err.message : String(err);
      // The Sandbox SDK answers a container start that can never succeed (no such image,
      // no matching container application, out of memory) with its permanent-startup
      // error instead of retrying, so it arrives here within seconds.
      const runtimeUnavailable = message.includes(SANDBOX_PERMANENT_STARTUP_MESSAGE);
      log.error('credential_setup.provision_failed', {
        sessionId: row.id,
        agentType: row.agent_type,
        runtimeUnavailable,
        error: message,
      });
      await this.teardown(
        'failed',
        runtimeUnavailable ? 'sandbox_runtime_unavailable' : 'sandbox_provision_failed',
        runtimeUnavailable
          ? `${displayName} sign-in is unavailable right now: the sign-in sandbox could not start`
          : `Failed to prepare ${displayName} sign-in`
      );
      return;
    } finally {
      await settle();
    }
  }

  private startSetupDriverCommand(row: SetupSessionRow, statePath: string): string {
    if (row.agent_type === 'claude-code') {
      const credentialPath = `${row.codex_home}/${CLAUDE_OAUTH_TOKEN_FILE}`;
      const verificationCodePath = `${row.codex_home}/${CLAUDE_VERIFICATION_CODE_FILE}`;
      const enterDelayEnv = this.env.CLAUDE_SETUP_ENTER_DELAY_MS
        ? ` CLAUDE_SETUP_ENTER_DELAY_MS=${shellQuote(this.env.CLAUDE_SETUP_ENTER_DELAY_MS)}`
        : '';
      const exchangeTimeoutEnv = this.env.CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS
        ? ` CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS=${shellQuote(this.env.CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS)}`
        : '';
      const rejectionSettleEnv = this.env.CLAUDE_SETUP_REJECTION_SETTLE_MS
        ? ` CLAUDE_SETUP_REJECTION_SETTLE_MS=${shellQuote(this.env.CLAUDE_SETUP_REJECTION_SETTLE_MS)}`
        : '';
      const extraConfigEnv = [
        'CLAUDE_SETUP_VERIFICATION_POLL_MS',
        'CLAUDE_SETUP_TTY_COLUMNS',
        'CLAUDE_SETUP_OUTPUT_BUFFER_BYTES',
        'CLAUDE_VERIFICATION_CODE_MAX_LENGTH',
        'CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH',
        'CLAUDE_OAUTH_TOKEN_MAX_LENGTH',
      ]
        .flatMap((name) => {
          const value = this.env[name as keyof Env];
          return typeof value === 'string' && value.length > 0
            ? [` ${name}=${shellQuote(value)}`]
            : [];
        })
        .join('');
      return (
        `nohup env CLAUDE_CONFIG_DIR=${shellQuote(row.codex_home)} ` +
        'DISABLE_AUTOUPDATER=1 NO_COLOR=1 TERM=dumb' +
        `${enterDelayEnv}${exchangeTimeoutEnv}${rejectionSettleEnv}${extraConfigEnv} ` +
        `node /usr/local/bin/sam-claude-setup-token.mjs ${shellQuote(statePath)} ` +
        `${shellQuote(credentialPath)} ${shellQuote(verificationCodePath)} >/dev/null 2>&1 &`
      );
    }

    const requestTimeoutEnv = this.env.CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS
      ? ` CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS=${shellQuote(
          this.env.CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS
        )}`
      : '';
    return (
      `nohup env CODEX_HOME=${shellQuote(row.codex_home)}${requestTimeoutEnv} ` +
      `node /usr/local/bin/sam-codex-device-auth.mjs ${shellQuote(statePath)} ` +
      '>/dev/null 2>&1 &'
    );
  }

  private async pollDeviceAuth(row: SetupSessionRow): Promise<void> {
    const state = await this.readDeviceAuthState(row);
    const current = this.readRow();
    if (!current || current.status !== 'admitting') return;
    if (!state || state.status === 'starting') {
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }
    if (state.status === 'failed') {
      const failure = driverFailure(state, setupDisplayName(row.agent_type));
      log.warn('credential_setup.device_auth_failed', {
        sessionId: row.id,
        agentType: row.agent_type,
        errorCode: failure.code,
        diagnostics: state.diagnostics ?? {},
      });
      await this.teardown('failed', failure.code, failure.message);
      return;
    }
    if (
      state.status === 'waiting_for_user' &&
      state.verificationUrl &&
      (!requiresUserCode(row.agent_type) || state.userCode)
    ) {
      this.sql.exec(
        `INSERT OR REPLACE INTO device_auth_details
         (singleton, verification_url, user_code) VALUES (1, ?, ?)`,
        state.verificationUrl,
        state.userCode ?? null
      );
      this.setStatus(current.id, 'waiting_for_user');
      await this.updateD1Status(current.id, 'waiting_for_user');
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }
    if (state.status === 'completed') {
      await this.attemptCapture(current);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
  }

  private readDeviceAuthState(row: SetupSessionRow): Promise<DeviceAuthState | null> {
    return this.withSandboxFlight(row, () =>
      readDeviceAuthState(
        this.env,
        row,
        () => !isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled'),
        `${row.codex_home}/${DEVICE_AUTH_STATE_FILE}`
      )
    );
  }

  private withSandboxFlight<T>(row: SetupSessionRow, run: () => Promise<T>): Promise<T> {
    return trackSandboxFlight(
      this.sql,
      this.ctx,
      row.id,
      () => armCleanupAlarmBestEffort(this.ctx, row),
      run
    );
  }

  private readDeviceAuthDetails(): DeviceAuthDetailsRow | null {
    return (
      this.sql
        .exec<DeviceAuthDetailsRow>(
          `SELECT verification_url, user_code
           FROM device_auth_details WHERE singleton = 1`
        )
        .toArray()[0] ?? null
    );
  }

  private async attemptCapture(row: SetupSessionRow): Promise<void> {
    const capture = await this.withSandboxFlight(row, async () => {
      if (isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return null;
      const sandbox = await getSandboxInstance(this.env, row.id);
      if (isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return null;
      const credentialPath = `${row.codex_home}/${credentialFileName(row.agent_type)}`;

      const existence = await sandbox.exists(credentialPath);
      if (isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return null;
      return existence.exists ? { sandbox, credentialPath } : null;
    });
    if (!capture) {
      if (!isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled'))
        await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }
    const currentCapture = this.readRow();
    if (!currentCapture || isTerminalSetupStatus(currentCapture.status)) return;
    if (currentCapture.status !== 'capturing') {
      this.setStatus(row.id, 'capturing');
      await this.updateD1Status(row.id, 'capturing');
    }
    const file = await this.withSandboxFlight(row, async () => {
      if (isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return null;
      return capture.sandbox.readFile(capture.credentialPath);
    });
    if (!file || isTerminalSetupStatus(this.readRow()?.status ?? 'cancelled')) return;
    let content = file.content ?? '';
    if (row.agent_type === 'claude-code') content = content.trim();

    // A partial write (provider CLI mid-flush) parses as invalid — treat as not-ready
    // and keep polling; the TTL bounds retries. Only a VALID file triggers save.
    const validation = CredentialValidator.validateCredential(
      content,
      row.credential_kind as CredentialKind,
      row.agent_type as AgentType,
      getClaudeOauthTokenMaxLength(this.env)
    );
    if (!validation.valid) {
      log.info('credential_setup.auth_file_not_ready', {
        sessionId: row.id,
        reason: 'validation_pending',
      });
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }

    let current = this.readRow();
    if (!current || isTerminalSetupStatus(current.status)) return;
    this.setStatus(current.id, 'saving');
    await this.updateD1Status(current.id, 'saving');
    current = this.readRow();
    if (!current || current.status !== 'saving') return;
    try {
      // Login may take minutes: membership or role can change while waiting.
      if (row.project_id !== null) {
        await requireProjectCapability(
          drizzle(this.env.DATABASE),
          row.project_id,
          row.user_id,
          OWN_AGENT_ACCOUNT_PROJECT_CAPABILITY
        );
      }
      await saveAgentCredentialForUser({
        env: this.env,
        userId: row.user_id,
        projectId: row.project_id,
        agentType: row.agent_type as AgentType,
        credentialKind: row.credential_kind as CredentialKind,
        credential: content,
        provider: row.provider,
        agentName: row.agent_name,
        autoActivate: true,
      });
    } catch (err) {
      log.error('credential_setup.save_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.teardown(
        'failed',
        'capture_save_failed',
        'Failed to save the captured credential'
      );
      return;
    }

    await this.teardown('completed');
  }

  // ---------------------------------------------------------------------------
  // Teardown — establish a durable wake before committing a terminal claim.
  // ---------------------------------------------------------------------------

  private async teardown(
    finalStatus: 'completed' | 'failed' | 'cancelled' | 'expired',
    errorCode?: string,
    errorMessage?: string
  ): Promise<void> {
    if (this.cleanupInFlight) {
      await this.cleanupInFlight;
      return this.teardown(finalStatus, errorCode, errorMessage);
    }
    await this.trackCleanup(this.claimAndFinishTeardown(finalStatus, errorCode, errorMessage));
  }

  private async claimAndFinishTeardown(
    finalStatus: 'completed' | 'failed' | 'cancelled' | 'expired',
    errorCode?: string,
    errorMessage?: string
  ): Promise<void> {
    const before = this.readRow();
    if (!before || isTerminalSetupStatus(before.status)) return;
    // Failure leaves D1 active for the existing sweep; no terminal orphan is created.
    await armCleanupAlarmBestEffort(this.ctx, before, true);
    // Recheck after arming: cancellation cannot cross the saving commit point.
    const current = this.readRow();
    if (
      !current ||
      isTerminalSetupStatus(current.status) ||
      (finalStatus === 'cancelled' && current.status === 'saving')
    )
      return;
    this.setStatus(current.id, finalStatus, { errorCode, errorMessage, completed: true });
    // Record that cleanup is owed, and from which status (it decides whether to scrub),
    // so the recovery alarm can resume a cleanup that a dead isolate never finished.
    this.sql.exec(
      `UPDATE setup_session
       SET cleanup_pending = 1, cleanup_from_status = ?, cleanup_attempts = 0
       WHERE id = ?`,
      current.status,
      current.id
    );
    this.sql.exec(`DELETE FROM device_auth_details WHERE singleton = 1`);
    const claimed = this.readRow();
    if (!claimed) return;
    // The registered flight also covers D1, so a firing alarm joins this run.
    await this.finishTeardown(claimed, finalStatus, errorCode, errorMessage);
  }

  private async finishTeardown(
    claimed: SetupSessionRow,
    finalStatus: SetupSessionStatus,
    errorCode?: string,
    errorMessage?: string
  ): Promise<void> {
    // D1 terminal FIRST: the create route's one-active lookup reads D1, so an isolate
    // death during the sandbox I/O must not leave this row active.
    await this.updateD1Status(claimed.id, finalStatus, {
      errorCode,
      errorMessage,
      completed: true,
    });
    await this.runCleanup(claimed, false);
  }

  /** Alarm path: resume a cleanup that an earlier isolate claimed but never finished. */
  private async resumeCleanup(row: SetupSessionRow): Promise<void> {
    const inline = this.cleanupInFlight;
    if (inline) {
      // The recovery alarm fires one poll interval after the claim, usually while this
      // isolate's own cleanup is still awaiting sandbox I/O. Join it rather than run a
      // second destroy and release (rule 45), but inline D1/pool I/O can stall.
      await joinCleanupFlight(this.ctx, this.env, this.sql, row, inline);
      return;
    }
    // cap + 1 is a durable quarantine marker. Keep cleanup_pending=1 as evidence
    // that teardown is unresolved, but never restart work or repeat the alert.
    if ((row.cleanup_attempts ?? 0) > cleanupAttemptLimit(row)) {
      await this.deleteAlarmBestEffort();
      return;
    }
    await this.trackCleanup(this.resumeClaimedCleanup(row));
  }

  private async resumeClaimedCleanup(row: SetupSessionRow): Promise<void> {
    // Re-arm before I/O so a death during this run is retried as well.
    await armCleanupAlarmBestEffort(this.ctx, row);
    await this.runCleanup(row, true);
  }

  private async runCleanup(row: SetupSessionRow, resumed: boolean): Promise<void> {
    if (resumed) row = await snapshotCleanupPolicy(this.env, this.sql, row);
    return runSetupSessionCleanup(
      {
        env: this.env,
        sql: this.sql,
        deferPending: (current) => deferPendingCleanup(this.ctx, this.env, this.sql, current),
        claimAttempt: (current) => claimCleanupAttempt(this.ctx, this.env, this.sql, current),
        deleteAlarm: () => this.deleteAlarmBestEffort(),
        waitUntil: (work) => this.ctx.waitUntil(work),
        rearmAlarm: () => armCleanupAlarmBestEffort(this.ctx, row),
      },
      row,
      resumed
    );
  }

  /** Record `run` as this isolate's cleanup. Call it before `run`'s caller awaits anything. */
  private trackCleanup(run: Promise<void>): Promise<void> {
    const flight = run.finally(() => {
      if (this.cleanupInFlight === flight) this.cleanupInFlight = null;
    });
    this.cleanupInFlight = flight;
    return flight;
  }

  private async deleteAlarmBestEffort(): Promise<void> {
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // no alarm armed — fine
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private terminalState(
    row: SetupSessionRow,
    status: SetupSessionStatus,
    errorCode: string | null = null,
    errorMessage: string | null = null
  ): SetupSessionStateResult {
    return {
      id: row.id,
      status,
      expiresAt: row.expires_at,
      errorCode,
      errorMessage,
      verificationUrl: null,
      userCode: null,
    };
  }

  private readRow(): SetupSessionRow | undefined {
    return this.sql.exec<SetupSessionRow>('SELECT * FROM setup_session LIMIT 1').toArray()[0];
  }

  private setStatus(
    id: string,
    status: SetupSessionStatus,
    extra?: { errorCode?: string; errorMessage?: string; completed?: boolean }
  ): void {
    const completedAt = extra?.completed ? Date.now() : null;
    this.sql.exec(
      `UPDATE setup_session
       SET status = ?, error_code = ?, error_message = ?, completed_at = COALESCE(?, completed_at)
       WHERE id = ?`,
      status,
      extra?.errorCode ?? null,
      extra?.errorMessage ?? null,
      completedAt,
      id
    );
  }

  private updateD1Status(
    id: string,
    status: SetupSessionStatus,
    extra?: SetupSessionD1Extra
  ): Promise<boolean> {
    return updateSetupSessionD1Status(this.env, id, status, extra);
  }
}
