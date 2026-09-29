import {
  ACP_INTERACTION_ATTENTION_SOURCE,
  ACP_INTERACTION_PROTOCOL_VERSION,
  type AcpInteractionAnswerDecision,
  AcpInteractionAnswerDecisionSchema,
  type AcpInteractionSafeSummary,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { createModuleLogger } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  type AcpInteractionConfig,
  getAcpInteractionConfig,
} from '../services/acp-interaction-config';
import {
  deliverAcpInteractionAnswer,
  resolveAcpInteractionDeliveryTarget,
} from '../services/acp-interaction-delivery';
import { decrypt, encrypt } from '../services/encryption';
import {
  detailBoundsViolation,
  type InteractionRow,
  type InteractionStoreAnswerInput,
  type InteractionStoreAnswerResult,
  type InteractionStoreCreateInput,
  type InteractionStoreCreateResult,
  type InteractionStoreSettleInput,
  type InteractionStoreSnapshot,
  nowMs,
  parseSummary,
  sha256,
  terminalState,
} from './interaction-store-model';
import type { ProjectData } from './project-data';

const log = createModuleLogger('interaction_store');

type CreateValidationResult = Exclude<
  InteractionStoreCreateResult,
  { status: 'created' | 'existing' }
>;

type EncryptedNullablePayload = {
  ciphertext: string | null;
  iv: string | null;
};

type StoredJsonValue =
  | null
  | boolean
  | number
  | string
  | object;

export type {
  InteractionStoreAnswerInput,
  InteractionStoreCreateInput,
  InteractionStoreSettleInput,
} from './interaction-store-model';

export class InteractionStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS interactions (
          interaction_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          chat_session_id TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          generation TEXT NOT NULL,
          runtime_identity TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          encrypted_detail TEXT,
          detail_iv TEXT,
          detail_purged_at INTEGER,
          safe_summary_json TEXT NOT NULL,
          upstream_request_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL,
          answered_at INTEGER,
          answer_key TEXT,
          answer_body_hash TEXT,
          decision_kind TEXT,
          decision_hash TEXT,
          encrypted_answer TEXT,
          answer_iv TEXT,
          encrypted_decision TEXT,
          decision_iv TEXT,
          delivery_state TEXT,
          delivery_attempts INTEGER NOT NULL DEFAULT 0,
          delivery_deadline_at INTEGER,
          last_delivery_error TEXT,
          attention_marker_id TEXT,
          attention_projection_state TEXT,
          terminal_at INTEGER,
          purge_at INTEGER
        )`
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY NOT NULL,
          interaction_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_interactions_state_deadline
           ON interactions(state, deadline_at)`
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_interactions_delivery_due
           ON interactions(delivery_state, delivery_deadline_at)`
      );
      this.addMissingDecisionColumns();
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_purge ON interactions(purge_at)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(due_at)`);
    });
  }

  async create(input: InteractionStoreCreateInput): Promise<InteractionStoreCreateResult> {
    const config = getAcpInteractionConfig(this.env);
    const now = nowMs();
    const existing = this.read(input.interactionId);
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) {
        return { status: 'conflict', reason: 'interaction id already exists with another payload' };
      }
      return { status: 'existing', summary: parseSummary(existing) };
    }
    const validation = this.validateCreateInput(input, config, now);
    if (validation) return validation;

    const detailPlaintext = canonicalJson(input.detail);
    const encrypted = await encrypt(detailPlaintext, getCredentialEncryptionKey(this.env));
    const safeSummary = canonicalJson(input.safeSummary);
    this.sql.exec(
      `INSERT INTO interactions (
        interaction_id, project_id, chat_session_id, agent_session_id, kind, state,
        generation, runtime_identity, payload_hash, encrypted_detail, detail_iv,
        safe_summary_json, upstream_request_id, created_at, updated_at, deadline_at,
        delivery_attempts, attention_projection_state
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      input.interactionId,
      input.projectId,
      input.chatSessionId,
      input.agentSessionId,
      input.kind,
      input.generation,
      input.runtimeIdentity,
      input.payloadHash,
      encrypted.ciphertext,
      encrypted.iv,
      safeSummary,
      input.upstreamRequestId ?? null,
      now,
      now,
      input.deadlineAt
    );
    this.enqueue(`projection:${input.interactionId}`, input.interactionId, 'projection', now);
    this.enqueue(`expire:${input.interactionId}`, input.interactionId, 'expiry', input.deadlineAt);
    await this.scheduleNextAlarm();
    return { status: 'created', summary: parseSummary(this.readRequired(input.interactionId)) };
  }

  private validateCreateInput(
    input: InteractionStoreCreateInput,
    config: AcpInteractionConfig,
    now: number
  ): CreateValidationResult | null {
    if (!config.enabled) return { status: 'disabled', reason: 'ACP interactions are disabled' };
    if (input.protocolVersion !== ACP_INTERACTION_PROTOCOL_VERSION) {
      return { status: 'invalid', reason: 'unsupported protocol version' };
    }
    if (input.deadlineAt <= now) return { status: 'expired', reason: 'deadline is already past' };
    if (input.deadlineAt - now > config.maxDeadlineMs) {
      return { status: 'invalid', reason: 'deadline exceeds configured maximum' };
    }
    if (this.pendingCount() >= config.maxPendingPerSession) {
      return { status: 'too_many_pending', reason: 'too many pending interactions for session' };
    }
    const detailPlaintext = canonicalJson(input.detail);
    if (new TextEncoder().encode(detailPlaintext).byteLength > config.requestMaxBytes) {
      return { status: 'invalid', reason: 'request detail exceeds configured maximum' };
    }
    const boundsViolation = detailBoundsViolation(input.detail, config);
    if (boundsViolation) return { status: 'invalid', reason: boundsViolation };
    return null;
  }

  async answer(input: InteractionStoreAnswerInput): Promise<InteractionStoreAnswerResult> {
    const config = getAcpInteractionConfig(this.env);
    const row = this.read(input.interactionId);
    if (row?.project_id !== input.projectId || row.chat_session_id !== input.chatSessionId) {
      return { status: 'not_found', reason: 'interaction not found' };
    }
    if (row.state !== 'pending') {
      return this.answerResultForCommittedRow(row, input);
    }
    const answerPlaintext = canonicalJson(input.decision);
    if (new TextEncoder().encode(answerPlaintext).byteLength > config.answerMaxBytes) {
      return { status: 'payload_too_large', reason: 'answer exceeds configured maximum' };
    }
    const encryptionKey = getCredentialEncryptionKey(this.env);
    const encryptedDecision = await encrypt(answerPlaintext, encryptionKey);
    const encryptedAnswer: EncryptedNullablePayload = input.decision.encryptedAnswer
      ? await encrypt(canonicalJson(input.decision.encryptedAnswer), encryptionKey)
      : { ciphertext: null, iv: null };
    const now = nowMs();
    const deliveryDeadlineAt = Math.min(now + config.deliveryWindowMs, row.deadline_at);
    const purgeAt = now + config.sensitivePurgeMs;
    this.sql.exec(
      `UPDATE interactions
       SET state = 'answered',
           updated_at = ?,
           answered_at = ?,
           answer_key = ?,
           answer_body_hash = ?,
           decision_kind = ?,
           decision_hash = ?,
           encrypted_answer = ?,
           answer_iv = ?,
           encrypted_decision = ?,
           decision_iv = ?,
           delivery_state = 'pending',
           delivery_deadline_at = ?,
           purge_at = ?
       WHERE interaction_id = ? AND state = 'pending'`,
      now,
      now,
      input.answerKey,
      input.answerBodyHash,
      input.decision.kind,
      input.decision.answerHash,
      encryptedAnswer.ciphertext,
      encryptedAnswer.iv,
      encryptedDecision.ciphertext,
      encryptedDecision.iv,
      deliveryDeadlineAt,
      purgeAt,
      input.interactionId
    );
    this.enqueue(`delivery:${input.interactionId}`, input.interactionId, 'delivery', now);
    this.enqueue(`purge:${input.interactionId}`, input.interactionId, 'purge', purgeAt);
    await this.scheduleNextAlarm();
    const updated = this.readRequired(input.interactionId);
    if (
      updated.answer_key !== input.answerKey ||
      updated.answer_body_hash !== input.answerBodyHash
    ) {
      return this.answerResultForCommittedRow(updated, input);
    }
    return {
      status: 'answered',
      summary: parseSummary(updated),
      delivery: { generation: updated.generation, runtimeIdentity: updated.runtime_identity },
    };
  }

  private answerResultForCommittedRow(
    row: InteractionRow,
    input: InteractionStoreAnswerInput
  ): InteractionStoreAnswerResult {
    if (row.answer_key === input.answerKey && row.answer_body_hash === input.answerBodyHash) {
      return {
        status: 'already_answered',
        summary: parseSummary(row),
        delivery: { generation: row.generation, runtimeIdentity: row.runtime_identity },
      };
    }
    if (row.answer_key === input.answerKey) {
      return { status: 'answer_key_conflict', reason: 'answer key was reused with another body' };
    }
    if (row.answer_key) return { status: 'conflict', reason: 'another decision is already committed' };
    return { status: 'stale', reason: `interaction is ${row.state}` };
  }

  settle(input: InteractionStoreSettleInput): { status: 'settled' | 'not_found' | 'stale' } {
    const row = this.read(input.interactionId);
    if (!row) return { status: 'not_found' };
    if (row.generation !== input.generation || row.runtime_identity !== input.runtimeIdentity) {
      return { status: 'stale' };
    }
    if (row.state !== 'pending') return { status: 'settled' };
    const now = nowMs();
    this.markTerminal(row.interaction_id, 'cancelled', now, input.reason);
    return { status: 'settled' };
  }

  snapshot(cursor: string | null = null): InteractionStoreSnapshot {
    const config = getAcpInteractionConfig(this.env);
    const pending = this.sql
      .exec<InteractionRow>(
        `SELECT * FROM interactions
         WHERE state IN ('pending', 'answered')
         ORDER BY created_at ASC
         LIMIT ?`,
        config.maxPendingPerSession + config.snapshotLastSettled
      )
      .toArray()
      .map(parseSummary);
    const settledRows = this.sql
      .exec<InteractionRow>(
        `SELECT * FROM interactions
         WHERE state NOT IN ('pending', 'answered')
           AND (? IS NULL OR updated_at < ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
        cursor,
        cursor ? Number.parseInt(cursor, 10) : null,
        config.snapshotLastSettled + 1
      )
      .toArray();
    const pageRows = settledRows.slice(0, config.snapshotLastSettled);
    return {
      pending,
      settled: pageRows.map(parseSummary),
      cursor:
        settledRows.length > config.snapshotLastSettled
          ? String(pageRows[pageRows.length - 1]?.updated_at ?? '')
          : null,
    };
  }

  async detail(
    interactionId: string
  ): Promise<{ summary: AcpInteractionSafeSummary; detail: StoredJsonValue } | null> {
    const row = this.read(interactionId);
    if (!row) return null;
    let detail: StoredJsonValue = null;
    if (row.encrypted_detail?.length && row.detail_iv?.length) {
      const plaintext = await decrypt(
        row.encrypted_detail,
        row.detail_iv,
        getCredentialEncryptionKey(this.env)
      );
      const parsedDetail = JSON.parse(plaintext) as unknown;
      detail = parsedDetail as StoredJsonValue;
    }
    return { summary: parseSummary(row), detail };
  }

  async alarm(): Promise<void> {
    const now = nowMs();
    await this.processDueExpiry(now);
    await this.processDueOutbox(now);
    await this.processDuePurge(now);
    this.compactSettled(now);
    await this.scheduleNextAlarm();
  }

  recordDelivery(
    interactionId: string,
    outcome: 'confirmed' | 'unconfirmed' | 'interrupted',
    error: string | null = null
  ): { status: 'recorded' | 'not_found' } {
    const row = this.read(interactionId);
    if (!row) return { status: 'not_found' };
    const now = nowMs();
    const state = deliveryStateForOutcome(outcome);
    this.sql.exec(
      `UPDATE interactions
       SET state = ?, delivery_state = ?, updated_at = ?, terminal_at = ?, last_delivery_error = ?
       WHERE interaction_id = ? AND state = 'answered'`,
      state,
      outcome,
      now,
      now,
      error,
      interactionId
    );
    this.enqueue(`resolve:${interactionId}`, interactionId, 'projection_resolve', now);
    return { status: 'recorded' };
  }

  purge(): void {
    this.sql.exec(`DELETE FROM outbox`);
    this.sql.exec(`DELETE FROM interactions`);
  }

  private addMissingDecisionColumns(): void {
    try {
      this.sql.exec('ALTER TABLE interactions ADD COLUMN encrypted_decision TEXT');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column')) {
        log.warn('interaction_store.add_encrypted_decision_column_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    try {
      this.sql.exec('ALTER TABLE interactions ADD COLUMN decision_iv TEXT');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column')) {
        log.warn('interaction_store.add_decision_iv_column_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  private read(interactionId: string): InteractionRow | null {
    return (
      this.sql
        .exec<InteractionRow>(
          `SELECT * FROM interactions WHERE interaction_id = ? LIMIT 1`,
          interactionId
        )
        .toArray()[0] ?? null
    );
  }

  private readRequired(interactionId: string): InteractionRow {
    const row = this.read(interactionId);
    if (!row) throw new Error('interaction row disappeared after write');
    return row;
  }

  private pendingCount(): number {
    const row = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM interactions WHERE state IN ('pending', 'answered')`
      )
      .toArray()[0];
    return row?.count ?? 0;
  }

  private enqueue(id: string, interactionId: string, kind: string, dueAt: number): void {
    const now = nowMs();
    this.sql.exec(
      `INSERT INTO outbox (id, interaction_id, kind, due_at, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET due_at = excluded.due_at, updated_at = excluded.updated_at`,
      id,
      interactionId,
      kind,
      dueAt,
      now,
      now
    );
  }

  private async processDueExpiry(now: number): Promise<void> {
    for (const row of this.sql
      .exec<InteractionRow>(
        `SELECT * FROM interactions
         WHERE state = 'pending' AND deadline_at <= ?
         ORDER BY deadline_at ASC
         LIMIT 25`,
        now
      )
      .toArray()) {
      this.markTerminal(row.interaction_id, 'expired', now, 'deadline');
    }
  }

  private async processDueOutbox(now: number): Promise<void> {
    const due = this.sql
      .exec<{ id: string; interaction_id: string; kind: string; attempts: number }>(
        `SELECT id, interaction_id, kind, attempts FROM outbox
         WHERE due_at <= ?
         ORDER BY due_at ASC
         LIMIT 25`,
        now
      )
      .toArray();
    for (const job of due) {
      try {
        if (job.kind === 'projection') await this.projectAttention(job.interaction_id);
        else if (job.kind === 'projection_resolve')
          await this.resolveProjectedAttention(job.interaction_id);
        else if (job.kind === 'delivery') await this.processDeliveryJob(job.interaction_id, now);
        this.sql.exec(`DELETE FROM outbox WHERE id = ?`, job.id);
      } catch (error) {
        const retryAt = now + getAcpInteractionConfig(this.env).retrySteadyMs;
        this.sql.exec(
          `UPDATE outbox SET attempts = attempts + 1, due_at = ?, updated_at = ? WHERE id = ?`,
          retryAt,
          now,
          job.id
        );
        log.warn('interaction_store.outbox_retry', {
          interactionId: job.interaction_id,
          kind: job.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async processDeliveryJob(interactionId: string, now: number): Promise<void> {
    const row = this.read(interactionId);
    if (row?.state !== 'answered') return;
    if (!row.encrypted_decision || !row.decision_iv) {
      this.recordDelivery(interactionId, 'unconfirmed', 'missing encrypted decision for retry');
      return;
    }
    if (row.delivery_deadline_at !== null && now >= row.delivery_deadline_at) {
      this.recordDelivery(interactionId, 'unconfirmed', 'delivery deadline elapsed');
      return;
    }
    const target = await resolveAcpInteractionDeliveryTarget(
      this.env,
      row.project_id,
      row.chat_session_id
    );
    if (target.status === 'interrupted') {
      this.recordDelivery(interactionId, 'interrupted', target.reason);
      return;
    }
    if (target.status === 'retry') {
      this.rescheduleDelivery(row, now, target.reason);
      return;
    }
    const plaintext = await decrypt(
      row.encrypted_decision,
      row.decision_iv,
      getCredentialEncryptionKey(this.env)
    );
    const decision = v.parse(AcpInteractionAnswerDecisionSchema, JSON.parse(plaintext) as unknown);
    if (target.status !== 'ready') {
      this.rescheduleDelivery(row, now, 'target not ready');
      return;
    }
    const delivery = await deliverAcpInteractionAnswer(this.env, target.target, {
      interactionId,
      generation: row.generation,
      runtimeIdentity: row.runtime_identity,
      decision,
    });
    if (delivery.outcome === 'confirmed') {
      this.recordDelivery(interactionId, 'confirmed', null);
      return;
    }
    if (delivery.outcome === 'interrupted') {
      this.recordDelivery(interactionId, 'interrupted', delivery.reason);
      return;
    }
    this.rescheduleDelivery(row, now, delivery.reason);
  }

  private rescheduleDelivery(row: InteractionRow, now: number, reason: string): void {
    const config = getAcpInteractionConfig(this.env);
    const attempts = row.delivery_attempts + 1;
    const delay =
      config.retryDelaysMs[Math.min(attempts - 1, config.retryDelaysMs.length - 1)] ??
      config.retrySteadyMs;
    const dueAt = Math.min(now + delay, row.delivery_deadline_at ?? now + delay);
    if (row.delivery_deadline_at !== null && dueAt >= row.delivery_deadline_at) {
      this.recordDelivery(row.interaction_id, 'unconfirmed', reason);
      return;
    }
    this.sql.exec(
      `UPDATE interactions
       SET delivery_attempts = ?, last_delivery_error = ?, updated_at = ?
       WHERE interaction_id = ? AND state = 'answered'`,
      attempts,
      reason,
      now,
      row.interaction_id
    );
    this.enqueue(`delivery:${row.interaction_id}`, row.interaction_id, 'delivery', dueAt);
  }

  private async processDuePurge(now: number): Promise<void> {
    this.sql.exec(
      `UPDATE interactions
       SET encrypted_detail = NULL,
           detail_iv = NULL,
           encrypted_answer = NULL,
           answer_iv = NULL,
           detail_purged_at = ?
       WHERE purge_at IS NOT NULL
         AND purge_at <= ?
         AND detail_purged_at IS NULL`,
      now,
      now
    );
  }

  private compactSettled(now: number): void {
    const config = getAcpInteractionConfig(this.env);
    const cutoff = now - config.summaryRetentionMs;
    this.sql.exec(
      `DELETE FROM interactions
       WHERE state NOT IN ('pending', 'answered')
         AND terminal_at IS NOT NULL
         AND terminal_at < ?
         AND interaction_id NOT IN (
           SELECT interaction_id FROM interactions
           WHERE state NOT IN ('pending', 'answered')
           ORDER BY terminal_at DESC
           LIMIT ?
         )`,
      cutoff,
      config.summaryLastSettled
    );
  }

  private markTerminal(interactionId: string, state: string, at: number, reason: string): void {
    this.sql.exec(
      `UPDATE interactions
       SET state = ?,
           updated_at = ?,
           terminal_at = ?,
           delivery_state = CASE WHEN delivery_state IS NULL THEN 'interrupted' ELSE delivery_state END,
           last_delivery_error = ?
       WHERE interaction_id = ? AND state IN ('pending', 'answered')`,
      state,
      at,
      at,
      reason,
      interactionId
    );
    this.enqueue(`resolve:${interactionId}`, interactionId, 'projection_resolve', at);
  }

  private async projectAttention(interactionId: string): Promise<void> {
    const row = this.read(interactionId);
    if (!row || terminalState(row.state) || row.attention_marker_id?.length) return;
    const stub = this.projectDataStub(row.project_id);
    const summary = parseSummary(row);
    const marker = await stub.createAttentionMarker({
      sessionId: row.chat_session_id,
      taskId: null,
      workspaceId: null,
      kind: 'needs_input',
      source: ACP_INTERACTION_ATTENTION_SOURCE,
      reason: 'acp_interaction_pending',
      metadata: canonicalJson({
        source: ACP_INTERACTION_ATTENTION_SOURCE,
        interactionId: row.interaction_id,
        kind: row.kind,
        state: row.state,
        toolCallId: summary.toolCallId,
      }),
      expiresAt: null,
    });
    this.sql.exec(
      `UPDATE interactions
       SET attention_marker_id = ?, attention_projection_state = 'created', updated_at = ?
       WHERE interaction_id = ?`,
      marker.id,
      nowMs(),
      interactionId
    );
  }

  private async resolveProjectedAttention(interactionId: string): Promise<void> {
    const row = this.read(interactionId);
    if (!row?.attention_marker_id) return;
    const stub = this.projectDataStub(row.project_id);
    await stub.resolveAttentionMarkerById(
      row.attention_marker_id,
      'system',
      `${ACP_INTERACTION_ATTENTION_SOURCE}:${row.state}`
    );
    this.sql.exec(
      `UPDATE interactions
       SET attention_projection_state = 'resolved', updated_at = ?
       WHERE interaction_id = ?`,
      nowMs(),
      interactionId
    );
  }

  private projectDataStub(projectId: string): DurableObjectStub<ProjectData> {
    return this.env.PROJECT_DATA.get(
      this.env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const due = this.sql
      .exec<{ due_at: number }>(
        `SELECT due_at FROM outbox
         UNION ALL
         SELECT deadline_at AS due_at FROM interactions WHERE state = 'pending'
         UNION ALL
         SELECT purge_at AS due_at FROM interactions WHERE purge_at IS NOT NULL
         ORDER BY due_at ASC
         LIMIT 1`
      )
      .toArray()[0]?.due_at;
    if (due) {
      await this.ctx.storage.setAlarm(Math.max(due, nowMs() + 1000));
    }
  }
}

function deliveryStateForOutcome(outcome: 'confirmed' | 'unconfirmed' | 'interrupted'): string {
  if (outcome === 'confirmed') return 'delivery_confirmed';
  if (outcome === 'unconfirmed') return 'delivery_unconfirmed';
  return 'interrupted';
}

export async function interactionDecisionHash(
  decision: AcpInteractionAnswerDecision
): Promise<string> {
  return sha256(canonicalJson(decision));
}
