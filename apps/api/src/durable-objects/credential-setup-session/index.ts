/**
 * CredentialSetupSession — per-session Durable Object that drives one guided
 * Codex login inside a short-lived Cloudflare Sandbox.
 *
 * One DO per setup session (keyed by the session id, which is ALSO the sandbox
 * id — 1:1, never shared across users). The DO owns the lifecycle state machine:
 *
 *   creating -> provisioning -> waiting_for_user -> capturing -> saving
 *            -> completed | failed | cancelled | expired
 *
 * It provisions the sandbox (per-session CODEX_HOME + config.toml), then an
 * alarm loop polls `$CODEX_HOME/auth.json`. When the user finishes the ChatGPT
 * device-auth sign-in in the (browser-visible) terminal, codex writes auth.json;
 * the DO reads it server-side, validates + saves it as an encrypted credential
 * via the shared credential-save path, then tears the sandbox down.
 *
 * SECURITY: the captured credential is read server-side and never transits this
 * DO's SQLite, the D1 row, logs, or the browser. Only non-secret lifecycle
 * metadata is persisted. Every terminal state runs teardown (release pool lease,
 * delete auth.json, destroy sandbox, mark D1) so a vanished browser leaves no
 * orphan (rules 43/47).
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
  codexHome: string;
  ttlMs: number;
  capturePollMs: number;
}

export interface SetupSessionStateResult {
  id: string;
  status: SetupSessionStatus;
  expiresAt: number;
  errorCode: string | null;
  errorMessage: string | null;
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

/** Relative path of the captured credential file inside CODEX_HOME. */
const AUTH_FILE = 'auth.json';

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
      params.codexHome,
      expiresAt,
      params.capturePollMs
    );
    await this.ctx.storage.setAlarm(now); // immediate — provision on first tick
    return { id: params.id, status: 'provisioning', expiresAt, errorCode: null, errorMessage: null };
  }

  /** Read authoritative state (used by GET status when the DO is preferred over D1). */
  async getState(): Promise<SetupSessionStateResult | null> {
    const row = this.readRow();
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as SetupSessionStatus,
      expiresAt: row.expires_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }

  /** User- or sweep-initiated cancel. Tears down unless already terminal. */
  async cancel(): Promise<SetupSessionStateResult> {
    const row = this.readRow();
    if (!row) {
      return { id: '', status: 'cancelled', expiresAt: 0, errorCode: null, errorMessage: null };
    }
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
    try {
      const sandbox = await getSandboxInstance(this.env, row.id);
      // Per-session CODEX_HOME + config that forces file-based credential storage
      // (headless container has no OS keychain). mkdir first so codex can write.
      await sandbox.exec(`mkdir -p ${shellQuote(row.codex_home)}`, {
        timeout: getSandboxConfig(this.env).execTimeoutMs,
      });
      await sandbox.writeFile(
        `${row.codex_home}/config.toml`,
        'cli_auth_credentials_store = "file"\n'
      );
    } catch (err) {
      log.error('credential_setup.provision_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.teardown(
        row,
        'failed',
        'sandbox_provision_failed',
        'Failed to prepare the sign-in terminal'
      );
      return;
    }
    this.setStatus(row.id, 'waiting_for_user');
    await this.updateD1Status(row.id, 'waiting_for_user', { started: true });
    await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
  }

  private async attemptCapture(row: SetupSessionRow): Promise<void> {
    const sandbox = await getSandboxInstance(this.env, row.id);
    const authPath = `${row.codex_home}/${AUTH_FILE}`;

    const existence = await sandbox.exists(authPath);
    if (!existence.exists) {
      await this.ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
      return;
    }

    if (row.status !== 'capturing') {
      this.setStatus(row.id, 'capturing');
      await this.updateD1Status(row.id, 'capturing');
    }

    const file = await sandbox.readFile(authPath);
    const content = file.content ?? '';

    // A partial write (codex mid-flush) parses as invalid — treat as not-ready
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

    this.setStatus(row.id, 'saving');
    await this.updateD1Status(row.id, 'saving');
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
      await this.teardown(row, 'failed', 'capture_save_failed', 'Failed to save the captured credential');
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

    // 1. Delete captured credential file + scrub the setup dir.
    try {
      const sandbox = await getSandboxInstance(this.env, row.id);
      await sandbox.exec(`rm -rf ${shellQuote(row.codex_home)}`, {
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
    return this.sql
      .exec<SetupSessionRow>('SELECT * FROM setup_session LIMIT 1')
      .toArray()[0];
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
