/**
 * Trial event bridge — hooks that fan ACP / MCP events into `trial.*` SSE.
 *
 * These are fire-and-forget, catch-everything helpers designed to be dropped
 * into hot paths (ProjectData DO, MCP handlers) without any risk of blocking
 * or crashing the primary flow. Every call path:
 *   1. Looks up the trial record for the project (KV round-trip).
 *   2. If no trial exists, returns silently (this is the common case — most
 *      projects are NOT trials).
 *   3. Emits the appropriate `trial.*` event via the TrialEventBus DO.
 *
 * The non-trial short-circuit means the overhead on normal project traffic
 * is a single `env.KV.get()` — acceptable, and scopable-down later by caching
 * a boolean flag on the ProjectData DO if needed.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { emitTrialEventForProject } from './trial-runner';
import { readTrialByProject } from './trial-store';

/**
 * Emit `trial.ready` or `trial.error` when an ACP session transitions.
 *
 * Ready is inferred from the first `running` transition on a trial's discovery
 * session — that's when the VM agent has confirmed the agent process is
 * attached and actively producing turns. `trial.error` is emitted on `failed`.
 *
 * Safe to call on non-trial projects; the helper silently no-ops.
 */
export async function bridgeAcpSessionTransition(
  env: Env,
  projectId: string,
  toStatus: string,
  opts: { workspaceUrl?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  try {
    const record = await readTrialByProject(env, projectId);
    if (!record) return;

    if (toStatus === 'running') {
      const now = Date.now();
      const workspaceUrl =
        opts.workspaceUrl ??
        (record.workspaceId ? `https://ws-${record.workspaceId}.${env.BASE_DOMAIN}` : '');
      const updateResult = await env.DATABASE.prepare(
        `UPDATE trials
         SET status = 'ready',
             project_id = COALESCE(project_id, ?)
         WHERE id = ?
           AND status = 'pending'
           AND claimed_by_user_id IS NULL
           AND expires_at > ?`
      ).bind(projectId, record.trialId, now).run().catch((err) => {
        log.warn('trial_bridge.ready_d1_update_failed', {
          trialId: record.trialId,
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
      if (getD1Changes(updateResult) === 0) {
        const current = await env.DATABASE.prepare(
          `SELECT status, expires_at, claimed_by_user_id
           FROM trials
           WHERE id = ?`
        ).bind(record.trialId).first<{ status: string; expires_at: number; claimed_by_user_id: string | null }>();
        if (current?.status !== 'ready' || current.expires_at <= now || current.claimed_by_user_id !== null) {
          log.warn('trial_bridge.ready_transition_skipped', {
            trialId: record.trialId,
            projectId,
            status: current?.status ?? null,
            expiresAt: current?.expires_at ?? null,
            claimedByUserId: current?.claimed_by_user_id ?? null,
          });
          return;
        }
      }
      await emitTrialEventForProject(env, projectId, {
        type: 'trial.ready',
        trialId: record.trialId,
        projectId: record.projectId,
        workspaceUrl,
        at: Date.now(),
      });
      return;
    }

    if (toStatus === 'failed') {
      await emitTrialEventForProject(env, projectId, {
        type: 'trial.error',
        // TrialErrorCode is a shared enum; pass a free-form string through
        // the same cast-through-unknown pattern used by the DO failure path.
        error: 'acp_session_failed' as never,
        message: opts.errorMessage ?? 'Discovery agent session failed',
        at: Date.now(),
      });
    }
  } catch (err) {
    log.warn('trial_bridge.acp_transition_failed', {
      projectId,
      toStatus,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getD1Changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | null | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

/**
 * Emit `trial.knowledge` when the discovery agent adds a knowledge observation
 * via MCP. Called from `handleAddKnowledge` in the MCP tool handler.
 */
export async function bridgeKnowledgeAdded(
  env: Env,
  projectId: string,
  entity: string,
  observation: string,
): Promise<void> {
  try {
    const record = await readTrialByProject(env, projectId);
    if (!record) return;
    await emitTrialEventForProject(env, projectId, {
      type: 'trial.knowledge',
      entity,
      observation,
      at: Date.now(),
    });
  } catch (err) {
    log.warn('trial_bridge.knowledge_failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit `trial.agent_activity` when the discovery agent produces output.
 * Called from the message persistence path for assistant/tool/thinking roles.
 *
 * Truncates long text to keep SSE payloads small — the feed only needs a
 * summary of what the agent is doing, not the full output.
 */
export async function bridgeAgentActivity(
  env: Env,
  projectId: string,
  messages: Array<{
    role: string;
    content: string;
    toolMetadata?: unknown;
  }>,
): Promise<void> {
  try {
    const record = await readTrialByProject(env, projectId);
    if (!record) return;

    for (const msg of messages) {
      // Only surface agent-facing roles, skip user messages
      if (msg.role !== 'assistant' && msg.role !== 'tool' && msg.role !== 'thinking') continue;
      // Skip empty content
      const text = (msg.content || '').trim();
      if (!text) continue;

      const toolName =
        msg.role === 'tool'
          ? maybeJsonRecord(msg.toolMetadata)?.toolName
          : undefined;

      await emitTrialEventForProject(env, projectId, {
        type: 'trial.agent_activity',
        role: msg.role as 'assistant' | 'tool' | 'thinking',
        text: text.length > 200 ? text.slice(0, 200) + '…' : text,
        ...(typeof toolName === 'string' && toolName ? { toolName } : {}),
        at: Date.now(),
      });
    }
  } catch (err) {
    log.warn('trial_bridge.agent_activity_failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit `trial.idea` when the discovery agent creates an idea via MCP.
 */
export async function bridgeIdeaCreated(
  env: Env,
  projectId: string,
  ideaId: string,
  title: string,
  summary: string,
): Promise<void> {
  try {
    const record = await readTrialByProject(env, projectId);
    if (!record) return;
    await emitTrialEventForProject(env, projectId, {
      type: 'trial.idea',
      ideaId,
      title,
      summary,
      at: Date.now(),
    });
  } catch (err) {
    log.warn('trial_bridge.idea_failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
