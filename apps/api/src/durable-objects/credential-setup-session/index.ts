/**
 * CredentialSetupSession — per-session Durable Object that drives one guided
 * agent login inside a short-lived Cloudflare Sandbox.
 *
 * One DO per setup session (keyed by the session id, which is ALSO the sandbox
 * id — 1:1, never shared across users). The DO owns the lifecycle state machine:
 *
 *   creating -> provisioning -> waiting_for_user -> capturing -> saving
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
 * metadata is persisted. Every terminal state runs teardown (release pool lease,
 * delete credential files, destroy sandbox, mark D1) so a vanished browser leaves
 * no orphan (rules 43/47).
 *
 * Storage: embedded SQLite (wrangler `new_sqlite_classes`). DDL is inlined in
 * the constructor (CREATE TABLE IF NOT EXISTS) — no separate DO migration file,
 * mirroring TrialCounter.
 */
import type { AgentType, CredentialKind } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { saveAgentCredentialForUser } from '../../services/agent-credential-save';
import {
  isTerminalSetupStatus,
  type SetupSessionStatus,
} from '../../services/credential-setup-config';
import {
  destroySandboxInstance,
  getSandboxConfig,
  getSandboxInstance,
  shellQuote,
} from '../../services/sandbox';
import { releaseSetupSlot } from '../../services/setup-session-pool';
import { CredentialValidator } from '../../services/validation';

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

// `type` (not `interface`) so it carries an implicit index signature and
// satisfies the `Record<string, SqlStorageValue>` constraint on sql.exec<T>().
type SetupSessionRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  scope: string;
  agent_type: string;
  credential_kind: string;
  provider: string;
  agent_name: string;
  status: string;
  pool_lease_id: string | null;
  codex_home: string;
  expires_at: number;
  capture_poll_ms: number;
  error_code: string | null;
  error_message: string | null;
  completed_at: number | null;
};

type DeviceAuthDetailsRow = {
  verification_url: string;
  user_code: string | null;
};

/** Relative paths of captured credential files inside the per-session setup home. */
const CODEX_AUTH_FILE = 'auth.json';
const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token.txt';
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

interface DeviceAuthState {
  status: 'starting' | 'waiting_for_user' | 'completed' | 'failed';
  verificationUrl?: string;
  userCode?: string;
  error?: string | null;
}

export class CredentialSetupSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS setup_session (
          id              TEXT PRIMARY KEY NOT NULL,
          user_id         TEXT NOT NULL,
          project_id      TEXT,
          scope           TEXT NOT NULL,
          agent_type      TEXT NOT NULL,
          credential_kind TEXT NOT NULL,
          provider        TEXT NOT NULL,
          agent_name      TEXT NOT NULL,
          status          TEXT NOT NULL,
          pool_lease_id   TEXT,
          codex_home      TEXT NOT NULL,
          expires_at      INTEGER NOT NULL,
          capture_poll_ms INTEGER NOT NULL,
          error_code      TEXT,
          error_message   TEXT,
          completed_at    INTEGER
        )`
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS device_auth_details (
          singleton        INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          verification_url TEXT NOT NULL,
          user_code        TEXT
        )`
      );
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
        error_code, error_message, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, NULL, NULL, NULL)`,
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
    const deviceAuth = row.status === 'waiting_for_user' ? this.readDeviceAuthDetails() : null;
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
      await this.teardown(row, 'cancelled');
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

  /**
   * Alarm loop: provisions on the first tick, then polls for the captured
   * auth.json, and enforces the TTL. Every branch either reschedules the alarm
   * or reaches a terminal teardown, so a session cannot get stuck armed.
   */
  async alarm(): Promise<void> {
    const row = this.readRow();
    if (!row) return; // torn down / never created — nothing to do
    if (isTerminalSetupStatus(row.status)) return;

    // TTL guard — fail closed to expired.
    if (Date.now() >= row.expires_at) {
      await this.teardown(
        row,
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
      // waiting_for_user | capturing | saving — poll for the credential file.
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

  // ---------------------------------------------------------------------------
  // State-machine steps
  // ---------------------------------------------------------------------------

  private async provision(row: SetupSessionRow): Promise<void> {
    const displayName = setupDisplayName(row.agent_type);
    try {
      const sandbox = await getSandboxInstance(this.env, row.id);
      // Per-session setup home. For Codex this is CODEX_HOME; for Claude Code it
      // is CLAUDE_CONFIG_DIR. mkdir first so provider CLIs can write there.
      // Built in a variable (not inline in .exec) so the SQL-injection AST rule
      // doesn't false-match this SHELL command — the path is already shellQuote()d.
      const mkdirCmd = `mkdir -p ${shellQuote(row.codex_home)}`;
      await sandbox.exec(mkdirCmd, {
        timeout: getSandboxConfig(this.env).execTimeoutMs,
      });
      if (row.agent_type === 'openai-codex') {
        await sandbox.writeFile(
          `${row.codex_home}/config.toml`,
          'cli_auth_credentials_store = "file"\n'
        );
      }
      const statePath = `${row.codex_home}/${DEVICE_AUTH_STATE_FILE}`;
      const startCommand = this.startSetupDriverCommand(row, statePath);
      await sandbox.exec(startCommand, {
        timeout: getSandboxConfig(this.env).execTimeoutMs,
      });
    } catch (err) {
      log.error('credential_setup.provision_failed', {
        sessionId: row.id,
        agentType: row.agent_type,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.teardown(
        row,
        'failed',
        'sandbox_provision_failed',
        `Failed to prepare ${displayName} sign-in`
      );
      return;
    }
    const current = this.readRow();
    if (!current || current.status !== 'provisioning') return;
    this.setStatus(current.id, 'admitting');
    await this.updateD1Status(current.id, 'admitting', { started: true });
    await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
  }

  private startSetupDriverCommand(row: SetupSessionRow, statePath: string): string {
    if (row.agent_type === 'claude-code') {
      const credentialPath = `${row.codex_home}/${CLAUDE_OAUTH_TOKEN_FILE}`;
      return (
        `nohup env CLAUDE_CONFIG_DIR=${shellQuote(row.codex_home)} ` +
        'DISABLE_AUTOUPDATER=1 NO_COLOR=1 TERM=dumb ' +
        `node /usr/local/bin/sam-claude-setup-token.mjs ${shellQuote(statePath)} ` +
        `${shellQuote(credentialPath)} >/dev/null 2>&1 &`
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
      log.warn('credential_setup.device_auth_failed', {
        sessionId: row.id,
        agentType: row.agent_type,
      });
      await this.teardown(
        current,
        'failed',
        'device_auth_start_failed',
        `${setupDisplayName(row.agent_type)} could not start the sign-in flow`
      );
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

  private async readDeviceAuthState(row: SetupSessionRow): Promise<DeviceAuthState | null> {
    try {
      const sandbox = await getSandboxInstance(this.env, row.id);
      const path = `${row.codex_home}/${DEVICE_AUTH_STATE_FILE}`;
      const existence = await sandbox.exists(path);
      if (!existence.exists) return null;
      const file = await sandbox.readFile(path);
      return JSON.parse(file.content ?? '') as DeviceAuthState;
    } catch {
      return null;
    }
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
    const sandbox = await getSandboxInstance(this.env, row.id);
    const credentialPath = `${row.codex_home}/${credentialFileName(row.agent_type)}`;

    const existence = await sandbox.exists(credentialPath);
    if (!existence.exists) {
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }

    let current = this.readRow();
    if (!current || isTerminalSetupStatus(current.status)) return;
    if (current.status !== 'capturing') {
      this.setStatus(current.id, 'capturing');
      await this.updateD1Status(current.id, 'capturing');
    }

    const file = await sandbox.readFile(credentialPath);
    let content = file.content ?? '';
    if (row.agent_type === 'claude-code') content = content.trim();

    // A partial write (provider CLI mid-flush) parses as invalid — treat as not-ready
    // and keep polling; the TTL bounds retries. Only a VALID file triggers save.
    const validation = CredentialValidator.validateCredential(
      content,
      row.credential_kind as CredentialKind,
      row.agent_type as AgentType
    );
    if (!validation.valid) {
      log.info('credential_setup.auth_file_not_ready', {
        sessionId: row.id,
        reason: 'validation_pending',
      });
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }

    current = this.readRow();
    if (!current || isTerminalSetupStatus(current.status)) return;
    this.setStatus(current.id, 'saving');
    await this.updateD1Status(current.id, 'saving');
    current = this.readRow();
    if (!current || current.status !== 'saving') return;
    try {
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
        row,
        'failed',
        'capture_save_failed',
        'Failed to save the captured credential'
      );
      return;
    }

    await this.teardown(row, 'completed');
  }

  // ---------------------------------------------------------------------------
  // Teardown — always completes every step (best-effort), never throws.
  // ---------------------------------------------------------------------------

  private async teardown(
    row: SetupSessionRow,
    finalStatus: 'completed' | 'failed' | 'cancelled' | 'expired',
    errorCode?: string,
    errorMessage?: string
  ): Promise<void> {
    // Atomically claim teardown (rule 45): if a concurrent cancel()/sweep already
    // terminalized this session while this call awaits sandbox I/O, no-op — the
    // read + setStatus below are synchronous (no await between), so the claim is
    // atomic within this DO instance and cleanup + the final write happen once.
    const current = this.readRow();
    if (!current || isTerminalSetupStatus(current.status)) return;
    this.setStatus(current.id, finalStatus, { errorCode, errorMessage, completed: true });
    this.sql.exec(`DELETE FROM device_auth_details WHERE singleton = 1`);

    // 1. Delete captured credential file + scrub the setup dir.
    try {
      const sandbox = await getSandboxInstance(this.env, row.id);
      // Variable (not inline) — same SQL-injection-AST-false-positive avoidance.
      const scrubCmd = `rm -rf ${shellQuote(row.codex_home)}`;
      await sandbox.exec(scrubCmd, {
        timeout: getSandboxConfig(this.env).execTimeoutMs,
      });
    } catch (err) {
      log.warn('credential_setup.scrub_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 2. Destroy the sandbox container.
    try {
      await destroySandboxInstance(this.env, row.id, { sandboxId: row.id });
    } catch (err) {
      log.warn('credential_setup.sandbox_destroy_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 3. Release the concurrency slot.
    try {
      await releaseSetupSlot(this.env, row.pool_lease_id);
    } catch (err) {
      log.warn('credential_setup.pool_release_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 4. Mark D1 terminal (DO status already claimed atomically above), disarm alarm.
    await this.updateD1Status(row.id, finalStatus, { errorCode, errorMessage, completed: true });
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // no alarm armed — fine
    }
    log.info('credential_setup.torn_down', { sessionId: row.id, finalStatus, errorCode });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  private async updateD1Status(
    id: string,
    status: SetupSessionStatus,
    extra?: { errorCode?: string; errorMessage?: string; completed?: boolean; started?: boolean }
  ): Promise<void> {
    const now = new Date().toISOString();
    const set = ['status = ?', 'updated_at = ?'];
    const binds: unknown[] = [status, now];
    if (extra?.started) {
      set.push('started_at = COALESCE(started_at, ?)');
      binds.push(now);
    }
    if (extra?.completed) {
      set.push('completed_at = ?');
      binds.push(now);
    }
    if (extra?.errorCode !== undefined) {
      set.push('error_code = ?');
      binds.push(extra.errorCode);
    }
    if (extra?.errorMessage !== undefined) {
      set.push('error_message = ?');
      binds.push(extra.errorMessage);
    }
    binds.push(id);
    try {
      await this.env.DATABASE.prepare(
        `UPDATE agent_credential_setup_sessions SET ${set.join(', ')} WHERE id = ?`
      )
        .bind(...binds)
        .run();
    } catch (err) {
      log.warn('credential_setup.d1_update_failed', {
        sessionId: id,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
