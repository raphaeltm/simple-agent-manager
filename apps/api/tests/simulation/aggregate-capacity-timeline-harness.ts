import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

import {
  aggregateWorkspaceReservationRows,
  hasWorkspaceReservationCapacity,
  type WorkspaceReservationNodeCapacity,
} from '../../src/services/workspace-resource-capacity';

type TaskStatus =
  | 'queued'
  | 'provisioning'
  | 'reserving'
  | 'running'
  | 'retry-wait'
  | 'cancelled'
  | 'failed';

type WorkspaceStatus = 'creating' | 'running' | 'deleted' | 'failed';

interface TimelineEvent {
  dueAt: number;
  sequence: number;
  label: string;
  run: () => void;
}

interface TimelineNode extends WorkspaceReservationNodeCapacity {
  id: string;
  status: 'provisioning' | 'running';
  lastHeartbeatAt: number | null;
}

interface TimelineTask {
  id: string;
  status: TaskStatus;
  reservation: ResolvedResourceReservation;
  reservationJson: string;
  nodeId: string | null;
  advisoryAllowed: boolean;
  attempts: number;
}

interface TimelineWorkspace {
  id: string;
  taskId: string;
  nodeId: string;
  status: WorkspaceStatus;
  resolvedReservationJson: string | null;
  committedAt: number;
  nodeHeartbeatAtCommit: number | null;
}

interface ProviderRequest {
  nodeId: string;
  startedAt: number;
  finishedAt: number | null;
}

export interface AggregateCapacityTimelinePolicy {
  recheckCapacityAtCommit: boolean;
  rejectStaleHeartbeats: boolean;
  serializeProvisioning: boolean;
}

export const CURRENT_AGGREGATE_CAPACITY_POLICY: AggregateCapacityTimelinePolicy = {
  recheckCapacityAtCommit: true,
  rejectStaleHeartbeats: true,
  serializeProvisioning: true,
};

export const NO_FINAL_CAPACITY_CAS_POLICY: AggregateCapacityTimelinePolicy = {
  ...CURRENT_AGGREGATE_CAPACITY_POLICY,
  recheckCapacityAtCommit: false,
};

export const ACCEPT_STALE_HEARTBEAT_POLICY: AggregateCapacityTimelinePolicy = {
  ...CURRENT_AGGREGATE_CAPACITY_POLICY,
  rejectStaleHeartbeats: false,
};

export const OVERLAPPING_PROVISIONING_POLICY: AggregateCapacityTimelinePolicy = {
  ...CURRENT_AGGREGATE_CAPACITY_POLICY,
  serializeProvisioning: false,
};

const ACTIVE_WORKSPACE_STATUSES = new Set<WorkspaceStatus>(['creating', 'running']);

/**
 * Single-threaded virtual-time model for resource placement. Events with the
 * same due time are ordered by insertion sequence, so every failure schedule
 * is replayable without wall-clock timers or random interleavings.
 */
export class AggregateCapacityTimeline {
  readonly nodes = new Map<string, TimelineNode>();
  readonly tasks = new Map<string, TimelineTask>();
  readonly workspaces = new Map<string, TimelineWorkspace>();
  readonly providerRequests: ProviderRequest[] = [];
  readonly trace: string[] = [];

  now = 60_000;
  private sequence = 0;
  private readonly events: TimelineEvent[] = [];
  private provisioningNodeId: string | null = null;

  constructor(
    readonly policy: AggregateCapacityTimelinePolicy = CURRENT_AGGREGATE_CAPACITY_POLICY,
    readonly maxWorkspaces = 10,
    readonly heartbeatStaleMs = 30_000
  ) {}

  addNode(
    id: string,
    capacity: WorkspaceReservationNodeCapacity,
    options: { status?: TimelineNode['status']; lastHeartbeatAt?: number | null } = {}
  ): void {
    this.nodes.set(id, {
      id,
      status: options.status ?? 'running',
      lastHeartbeatAt: options.lastHeartbeatAt === undefined ? this.now : options.lastHeartbeatAt,
      ...capacity,
    });
    this.record(`node ${id} added (${options.status ?? 'running'})`);
  }

  seedWorkspace(input: {
    id: string;
    taskId?: string;
    nodeId: string;
    reservationJson: string | null;
    status?: WorkspaceStatus;
  }): void {
    this.workspaces.set(input.id, {
      id: input.id,
      taskId: input.taskId ?? `legacy-${input.id}`,
      nodeId: input.nodeId,
      status: input.status ?? 'running',
      resolvedReservationJson: input.reservationJson,
      committedAt: this.now,
      nodeHeartbeatAtCommit: this.nodes.get(input.nodeId)?.lastHeartbeatAt ?? null,
    });
    this.record(`workspace ${input.id} seeded on ${input.nodeId}`);
  }

  submit(
    id: string,
    reservation: ResolvedResourceReservation,
    options: {
      preferredNodeId?: string;
      commitDelayMs?: number;
      provisionIfUnavailable?: boolean;
    } = {}
  ): void {
    const existing = this.tasks.get(id);
    if (existing && existing.status !== 'retry-wait') return;
    const task =
      existing ??
      ({
        id,
        status: 'queued',
        reservation,
        reservationJson: JSON.stringify(reservation),
        nodeId: null,
        advisoryAllowed: false,
        attempts: 0,
      } satisfies TimelineTask);
    this.tasks.set(id, task);
    task.attempts += 1;

    const node = this.selectNode(reservation, options.preferredNodeId);
    if (!node) {
      task.status = 'retry-wait';
      if (options.provisionIfUnavailable) this.requestProvisioning(task.id);
      this.record(`task ${id} found no reusable node`);
      return;
    }

    task.status = 'reserving';
    task.nodeId = node.id;
    task.advisoryAllowed = true;
    this.schedule(options.commitDelayMs ?? 0, `commit:${id}`, () => this.commit(id));
  }

  retry(
    id: string,
    options: {
      preferredNodeId?: string;
      commitDelayMs?: number;
      provisionIfUnavailable?: boolean;
    } = {}
  ): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'retry-wait') return;
    this.submit(id, task.reservation, options);
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'cancelled';
    this.releaseWorkspace(id, 'deleted');
    this.record(`task ${id} cancelled`);
  }

  fail(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    this.releaseWorkspace(id, 'failed');
    this.record(`task ${id} failed`);
  }

  heartbeat(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.lastHeartbeatAt = this.now;
    node.status = 'running';
    this.record(`heartbeat ${nodeId}`);
  }

  scheduleHeartbeat(nodeId: string, delayMs: number): void {
    this.schedule(delayMs, `heartbeat:${nodeId}`, () => this.heartbeat(nodeId));
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('virtual time advance must be a non-negative safe integer');
    }
    this.now += milliseconds;
    this.record(`advanced by ${milliseconds}ms`);
  }

  runNext(): boolean {
    const next = this.events
      .slice()
      .sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence)[0];
    if (!next) return false;
    this.events.splice(this.events.indexOf(next), 1);
    this.now = Math.max(this.now, next.dueAt);
    this.record(`event ${next.label}`);
    next.run();
    return true;
  }

  runUntilIdle(maxEvents = 100): void {
    let executed = 0;
    while (this.runNext()) {
      executed += 1;
      if (executed > maxEvents) this.failInvariant(`event budget exceeded (${maxEvents})`);
    }
  }

  activeWorkspaces(nodeId: string): TimelineWorkspace[] {
    return [...this.workspaces.values()].filter(
      (workspace) => workspace.nodeId === nodeId && ACTIVE_WORKSPACE_STATUSES.has(workspace.status)
    );
  }

  assertSafety(): void {
    const liveTaskOwners = new Set<string>();
    for (const node of this.nodes.values()) {
      const active = this.activeWorkspaces(node.id);
      if (active.length === 0) continue;
      const usage = aggregateWorkspaceReservationRows(
        active.map((workspace) => ({
          resolvedReservationJson: workspace.resolvedReservationJson,
        }))
      );
      if (usage.activeCount > this.maxWorkspaces) {
        this.failInvariant(`workspace count exceeded on ${node.id}`);
      }
      if (usage.activeCount > 1 && usage.hasInvalidReservation) {
        this.failInvariant(`unknown reservation was co-tenanted on ${node.id}`);
      }
      if (usage.activeCount > 1 && usage.hasExclusiveReservation) {
        this.failInvariant(`exclusive reservation was co-tenanted on ${node.id}`);
      }
      if (usage.minimumMaxCoTenants !== null && usage.activeCount > usage.minimumMaxCoTenants) {
        this.failInvariant(`co-tenant cap exceeded on ${node.id}`);
      }
      this.assertResourceDimension(
        node.id,
        'cpu',
        usage.cpuMillis,
        node.providerInstanceVcpuCount,
        1_000
      );
      this.assertResourceDimension(
        node.id,
        'memory',
        usage.memoryMb,
        node.providerInstanceMemoryMb,
        1
      );
      this.assertResourceDimension(
        node.id,
        'disk',
        usage.diskMb,
        node.providerInstanceDiskGb,
        1_024
      );

      for (const workspace of active) {
        if (liveTaskOwners.has(workspace.taskId)) {
          this.failInvariant(`task ${workspace.taskId} owns multiple active workspaces`);
        }
        liveTaskOwners.add(workspace.taskId);
        if (
          workspace.nodeHeartbeatAtCommit === null ||
          workspace.committedAt - workspace.nodeHeartbeatAtCommit > this.heartbeatStaleMs
        ) {
          this.failInvariant(`task ${workspace.taskId} committed against a stale heartbeat`);
        }
      }
    }
  }

  assertNoProvisioningOverlap(): void {
    for (let index = 0; index < this.providerRequests.length; index += 1) {
      const left = this.providerRequests[index];
      for (const right of this.providerRequests.slice(index + 1)) {
        const leftEnd = left.finishedAt ?? Number.POSITIVE_INFINITY;
        const rightEnd = right.finishedAt ?? Number.POSITIVE_INFINITY;
        if (left.startedAt < rightEnd && right.startedAt < leftEnd) {
          this.failInvariant(`provider requests ${left.nodeId} and ${right.nodeId} overlapped`);
        }
      }
    }
  }

  private selectNode(
    reservation: ResolvedResourceReservation,
    preferredNodeId?: string
  ): TimelineNode | null {
    const preferred = preferredNodeId ? this.nodes.get(preferredNodeId) : undefined;
    const ordered = preferred
      ? [preferred, ...[...this.nodes.values()].filter((node) => node !== preferred)]
      : [...this.nodes.values()];
    for (const node of ordered) {
      if (node.status !== 'running') continue;
      if (this.policy.rejectStaleHeartbeats && !this.hasFreshHeartbeat(node)) continue;
      const usage = aggregateWorkspaceReservationRows(
        this.activeWorkspaces(node.id).map((workspace) => ({
          resolvedReservationJson: workspace.resolvedReservationJson,
        }))
      );
      if (hasWorkspaceReservationCapacity(node, usage, reservation, this.maxWorkspaces)) {
        return node;
      }
    }
    return null;
  }

  private commit(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'cancelled' || task.status === 'failed') return;
    if ([...this.workspaces.values()].some((workspace) => workspace.taskId === taskId)) {
      task.status = 'running';
      this.record(`task ${taskId} retry observed its existing workspace`);
      return;
    }
    const node = task.nodeId ? this.nodes.get(task.nodeId) : null;
    if (!node || node.status !== 'running') {
      task.status = 'retry-wait';
      return;
    }
    const usage = aggregateWorkspaceReservationRows(
      this.activeWorkspaces(node.id).map((workspace) => ({
        resolvedReservationJson: workspace.resolvedReservationJson,
      }))
    );
    const heartbeatAllowed = !this.policy.rejectStaleHeartbeats || this.hasFreshHeartbeat(node);
    const capacityAllowed = hasWorkspaceReservationCapacity(
      node,
      usage,
      task.reservation,
      this.maxWorkspaces
    );
    if (this.policy.recheckCapacityAtCommit && (!heartbeatAllowed || !capacityAllowed)) {
      task.status = 'retry-wait';
      this.record(`task ${taskId} lost final capacity race`);
      return;
    }
    if (!task.advisoryAllowed) {
      task.status = 'retry-wait';
      return;
    }

    this.workspaces.set(`workspace-${taskId}`, {
      id: `workspace-${taskId}`,
      taskId,
      nodeId: node.id,
      status: 'creating',
      resolvedReservationJson: task.reservationJson,
      committedAt: this.now,
      nodeHeartbeatAtCommit: node.lastHeartbeatAt,
    });
    task.status = 'running';
    this.record(`task ${taskId} committed on ${node.id}`);
  }

  private requestProvisioning(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (this.policy.serializeProvisioning && this.provisioningNodeId) {
      task.status = 'retry-wait';
      this.record(`task ${taskId} joined provisioning ${this.provisioningNodeId}`);
      return;
    }

    const nodeId = `node-provisioned-${this.providerRequests.length}`;
    this.addNode(
      nodeId,
      {
        providerInstanceVcpuCount: 8,
        providerInstanceMemoryMb: 16_384,
        providerInstanceDiskGb: 160,
      },
      { status: 'provisioning', lastHeartbeatAt: null }
    );
    this.providerRequests.push({ nodeId, startedAt: this.now, finishedAt: null });
    if (this.policy.serializeProvisioning) this.provisioningNodeId = nodeId;
    task.status = 'provisioning';
    this.schedule(5_000, `provider-ready:${nodeId}`, () => {
      const node = this.nodes.get(nodeId);
      const request = this.providerRequests.find((entry) => entry.nodeId === nodeId);
      if (!node || !request) return;
      node.status = 'running';
      node.lastHeartbeatAt = this.now;
      request.finishedAt = this.now;
      if (this.provisioningNodeId === nodeId) this.provisioningNodeId = null;
      if (task.status !== 'cancelled' && task.status !== 'failed') task.status = 'retry-wait';
      this.record(`provider ready ${nodeId}`);
    });
  }

  private releaseWorkspace(taskId: string, status: 'deleted' | 'failed'): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.taskId === taskId && ACTIVE_WORKSPACE_STATUSES.has(workspace.status)) {
        workspace.status = status;
      }
    }
  }

  private hasFreshHeartbeat(node: TimelineNode): boolean {
    return (
      node.lastHeartbeatAt !== null && this.now - node.lastHeartbeatAt <= this.heartbeatStaleMs
    );
  }

  private assertResourceDimension(
    nodeId: string,
    label: string,
    used: number,
    available: number | null | undefined,
    multiplier: number
  ): void {
    if (typeof available === 'number' && used > available * multiplier) {
      this.failInvariant(
        `${label} capacity exceeded on ${nodeId}: ${used}/${available * multiplier}`
      );
    }
  }

  private schedule(delayMs: number, label: string, run: () => void): void {
    this.events.push({
      dueAt: this.now + delayMs,
      sequence: this.sequence,
      label,
      run,
    });
    this.sequence += 1;
    this.record(`scheduled ${label} at ${this.now + delayMs}`);
  }

  private record(message: string): void {
    this.trace.push(`${String(this.now).padStart(8, '0')} ${message}`);
    if (this.trace.length > 200) this.trace.shift();
  }

  private failInvariant(message: string): never {
    throw new Error(`${message}\n--- aggregate capacity timeline ---\n${this.trace.join('\n')}`);
  }
}
