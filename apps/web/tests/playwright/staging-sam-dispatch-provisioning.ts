import type { Json } from './staging-sam-dispatch-evidence';

export const DISPATCH_WORK_MS = 25 * 60_000;
export const PRIVATE_TURN_MS = 150_000;
export const STOP_CONFIRMATION_MS = 90_000;
// Full readiness gets at most 900s of the work budget; downstream work cannot
// consume the separate cleanup allowance. Recovery is optional, never unbounded.
export const observationReserveMs = (stopOnly: boolean, followup: boolean, recovery = false) =>
  stopOnly
    ? 210_000
    : followup
      ? PRIVATE_TURN_MS + STOP_CONFIRMATION_MS + (recovery ? PRIVATE_TURN_MS : 0)
      : 600_000;
export function privateTurnReserveMs(kind: string): number {
  if (kind === 'followup') return PRIVATE_TURN_MS * 2 + STOP_CONFIRMATION_MS;
  if (kind === 'followup-recovery') return PRIVATE_TURN_MS + STOP_CONFIRMATION_MS;
  if (kind === 'stop') return STOP_CONFIRMATION_MS;
  return 0;
}
export function dispatchObservationBudget(
  deadline: number,
  acceptedAt: number,
  beganAt: number,
  stopOnly: boolean,
  followup: boolean,
  recovery: boolean
) {
  const workCutoff = deadline - observationReserveMs(stopOnly, followup, recovery);
  const readinessCutoff = acceptedAt + 900_000;
  return {
    phase: followup ? 'followup-answer' : 'initial-readiness',
    beganAt,
    endsAt: followup ? workCutoff : Math.min(workCutoff, readinessCutoff),
    platformReadinessEndsAt: followup ? null : readinessCutoff,
    limitedBy: followup || workCutoff < readinessCutoff ? 'test-work-reserve' : 'readiness',
  };
}

interface D1Input {
  account: string;
  token: string;
  timeout: number;
}
export async function scopedDispatchQuery(
  input: D1Input,
  sql: string,
  params: unknown[]
): Promise<Json[]> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${input.account}/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(input.timeout),
      }
    );
    if (!response.ok) throw new Error('D1 status');
    const body = (await response.json()) as Json;
    if (body.success !== true || !Array.isArray(body.result?.[0]?.results))
      throw new Error('D1 shape');
    return body.result[0].results;
  } catch {
    throw new Error('Scoped D1 evidence unavailable');
  }
}

// Fixed protocol vocabulary from vm-agent/internal/server/lifecycle_timings.go.
const phases = new Set([
  'packages',
  'docker',
  'docker-model-runner',
  'firewall',
  'tls-permissions',
  'nodejs-install',
  'devcontainer-cli',
  'image-prepull',
  'journald-config',
  'docker-restart',
  'metadata-block',
]);
export function provisioningSummary(payload: Json) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  return {
    paginationPresent: typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0,
    events: events.slice(0, 100).flatMap((event: Json) => {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return [];
      const phase = typeof event.type === 'string' ? event.type.replace(/^provision\./, '') : '';
      const status = event.detail?.status;
      const created = typeof event.createdAt === 'string' ? Date.parse(event.createdAt) : NaN;
      if (
        !event.type?.startsWith('provision.') ||
        !phases.has(phase) ||
        !['started', 'completed', 'failed', 'skipped'].includes(status) ||
        !Number.isFinite(created)
      )
        return [];
      const duration = event.detail?.durationMs;
      return [
        {
          phase,
          status,
          createdAt: new Date(created).toISOString(),
          ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
            ? { durationMs: duration }
            : {}),
        },
      ];
    }),
  };
}

export interface ProvisioningInput extends D1Input {
  ledger: Json;
  userId: string;
  projectId: string;
  profileName: string;
  marker: string;
  baselineNodes: Set<string>;
  stagingApi: string;
  get: (url: string) => Promise<Json>;
  save: () => Promise<void>;
}
export async function captureOwnedProvisioning(input: ProvisioningInput, events = false) {
  const { ledger } = input;
  if (!ledger.cleanupTargetVerified || !ledger.taskId || !ledger.sessionId || !input.userId) return;
  try {
    // Select scalar evidence only. Run marker, user, session and profile must all
    // agree before a pre-workspace node identity can become a cleanup target.
    const rows = await scopedDispatchQuery(
      input,
      `SELECT t.auto_provisioned_node_id AS nodeId,
      n.id AS ownedNodeId,n.status AS nodeStatus,n.health_status AS health,
      n.agent_ready_at AS readyAt,n.last_heartbeat_at AS heartbeatAt,
      t.status AS taskStatus,t.execution_step AS executionStep
      FROM tasks t LEFT JOIN nodes n ON n.id=t.auto_provisioned_node_id AND n.user_id=t.user_id
      WHERE t.id=? AND t.project_id=? AND t.user_id=? AND t.chat_session_id=?
        AND t.agent_profile_hint IN (?,?) AND instr(t.description,?)>0 LIMIT 2`,
      [
        ledger.taskId,
        input.projectId,
        input.userId,
        ledger.sessionId,
        ledger.profileId,
        input.profileName,
        input.marker,
      ]
    );
    if (rows.length !== 1) throw new Error('Ownership evidence mismatch');
    const row = rows[0]!;
    if (
      row.nodeId &&
      (row.nodeId !== row.ownedNodeId || (ledger.nodeId && ledger.nodeId !== row.nodeId))
    )
      throw new Error('Node ownership evidence mismatch');
    if (row.nodeId) {
      ledger.nodeId = row.nodeId;
      ledger.provisioningNodeVerified = true;
      ledger.provisioningNodeWasPresent = input.baselineNodes.has(row.nodeId);
    }
    ledger.provisioning = { status: 'verified', ...row };
    await input.save(); // Persist identity before fetching optional diagnostics.
    if (events && row.nodeId) {
      ledger.provisioning.events = provisioningSummary(
        await input.get(`${input.stagingApi}/api/nodes/${row.nodeId}/events?limit=100`)
      );
    }
  } catch {
    ledger.provisioningDiagnosticStatus = 'unavailable';
  } finally {
    await input.save();
  }
}

export async function verifyNoWorkspaceAfterStop(
  ledger: Json,
  projectApi: string,
  stagingApi: string,
  get: (url: string) => Promise<Json>
): Promise<boolean> {
  if (!ledger.cleanupTargetVerified || ledger.cleanup.stopOwnedWork !== 'confirmed') return false;
  const task = await get(`${projectApi}/tasks/${ledger.taskId}`);
  const session = await get(`${projectApi}/sessions/${ledger.sessionId}?limit=1`);
  const workspaces = (await get(`${stagingApi}/api/workspaces`)) as unknown as Json[];
  return (
    task.id === ledger.taskId &&
    task.status === 'cancelled' &&
    task.workspaceId === null &&
    session.session.id === ledger.sessionId &&
    session.session.status === 'stopped' &&
    !workspaces.some((workspace) => workspace.chatSessionId === ledger.sessionId)
  );
}
