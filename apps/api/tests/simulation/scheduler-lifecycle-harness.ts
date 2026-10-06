import {
  CURRENT_SCHEDULER_POLICY,
  type NodeStatus,
  type SchedulerSimulationPolicy,
  type SessionActivity,
  type SimEvent,
  type SimNode,
  type SimSession,
  type SimTask,
  type SimulationCommand,
  type SimWorkspace,
} from './scheduler-lifecycle-model';

export class SchedulerLifecycleWorld {
  readonly policy: SchedulerSimulationPolicy;
  readonly nodes = new Map<string, SimNode>();
  readonly workspaces = new Map<string, SimWorkspace>();
  readonly tasks = new Map<string, SimTask>();
  readonly sessions = new Map<string, SimSession>();
  readonly trace: string[] = [];

  now = 60_000;
  private eventSequence = 0;
  private readonly events: SimEvent[] = [];
  private snapshotFailuresRemaining = 0;

  constructor(policy: SchedulerSimulationPolicy = CURRENT_SCHEDULER_POLICY, nodeCapacity = 2) {
    this.policy = policy;
    this.addNode('node-0', 'running', nodeCapacity, 0);
    this.addNode('node-1', 'running', nodeCapacity, 0);
    this.record('world initialized');
  }

  apply(command: SimulationCommand): void {
    this.record(`command ${JSON.stringify(command)}`);
    switch (command.type) {
      case 'submit':
        this.submitTask(command.task, command.project, command.node);
        break;
      case 'complete':
        this.completeTask(command.task);
        break;
      case 'activity':
        this.setActivity(command.task, command.activity);
        break;
      case 'sleep-sweep':
        this.runSleepSweep();
        break;
      case 'cleanup-sweep':
        this.runCleanupSweep();
        break;
      case 'snapshot-failure':
        this.snapshotFailuresRemaining += 1;
        break;
      case 'advance':
        this.now += command.milliseconds;
        break;
      case 'run-event':
        this.runNextEvent(command.choice);
        break;
    }
  }

  submitTask(taskSlot: number, projectSlot: number, nodeChoice: number | 'new'): void {
    const taskId = `task-${taskSlot}`;
    if (this.tasks.has(taskId)) return;

    const task: SimTask = {
      id: taskId,
      projectId: `project-${projectSlot}`,
      status: 'provisioning',
      nodeId: null,
      workspaceId: null,
      sessionId: null,
    };
    this.tasks.set(taskId, task);

    if (nodeChoice === 'new') {
      this.provisionNodeForTask(task);
      return;
    }

    const preferred = this.nodes.get(`node-${nodeChoice % 2}`);
    const selected = this.selectNodeWithCapacity(preferred);
    if (!selected) {
      this.provisionNodeForTask(task);
      return;
    }

    task.nodeId = selected.id;
    if (this.policy.reservePlacementBeforeAsyncCreate) {
      selected.reservedTaskIds.add(task.id);
    }
    this.schedule(0, `workspace-commit:${task.id}`, () => this.commitWorkspace(task.id));
  }

  completeTask(taskSlot: number): void {
    const task = this.tasks.get(`task-${taskSlot}`);
    if (task?.status !== 'running' || !task.sessionId) return;
    const session = this.sessions.get(task.sessionId);
    if (!session || session.terminal) return;

    task.status = 'completed';
    session.terminal = true;
    session.sleepDueAt = this.now;
    this.record(`task completed ${task.id} while activity=${session.activity}`);

    if (this.policy.synchronousTerminalSleep) {
      if (session.snapshotStatus === 'missing') session.snapshotStatus = 'pending';
      this.attemptSleep(session);
    }
  }

  setActivity(taskSlot: number, activity: SessionActivity): void {
    const task = this.tasks.get(`task-${taskSlot}`);
    if (!task?.sessionId) return;
    const session = this.sessions.get(task.sessionId);
    if (!session || session.sleeping) return;
    session.activity = activity;
  }

  runSleepSweep(): void {
    for (const session of this.sessions.values()) {
      if (!session.terminal || session.sleeping || session.sleepDueAt === null) continue;
      if (session.sleepDueAt > this.now) continue;

      if (session.snapshotStatus === 'missing') {
        if (!this.policy.reconcileMissingSnapshots) continue;
        session.snapshotStatus = 'pending';
        this.record(`snapshot reconciled ${session.id}`);
      }

      if (!this.policy.retryIncompleteSnapshots && session.snapshotStatus !== 'available') {
        continue;
      }
      this.attemptSleep(session);
    }
  }

  runCleanupSweep(): void {
    for (const node of this.nodes.values()) {
      if (node.status !== 'running' && node.status !== 'provisioning') continue;
      if (this.activeWorkspaceCount(node.id) > 0) continue;
      if (node.reservedTaskIds.size > 0) continue;
      if (this.now - node.idleSince < 30_000) continue;
      if (this.policy.protectProvisioningClaims && node.claimedTaskIds.size > 0) continue;

      node.status = 'destroying';
      this.record(`node claimed for cleanup ${node.id}`);
      this.schedule(0, `node-delete:${node.id}`, () => {
        if (this.activeWorkspaceCount(node.id) > 0) {
          node.status = 'running';
          node.idleSince = this.now;
          this.record(`node cleanup released ${node.id}`);
          return;
        }
        node.status = 'deleted';
        this.record(`node deleted ${node.id}`);
      });
    }
  }

  runNextEvent(choice = 0): boolean {
    if (this.events.length === 0) return false;
    const earliest = Math.min(...this.events.map((event) => event.dueAt));
    if (earliest > this.now) this.now = earliest;
    const runnable = this.events
      .filter((event) => event.dueAt <= this.now)
      .sort((left, right) => left.id - right.id);
    const selected = runnable[Math.abs(choice) % runnable.length];
    if (!selected) return false;
    this.events.splice(this.events.indexOf(selected), 1);
    this.record(`event ${selected.label}`);
    selected.run();
    return true;
  }

  recover(): void {
    this.record('recovery phase started');
    this.snapshotFailuresRemaining = 0;

    let turns = 0;
    while (turns < 500) {
      turns += 1;
      let changed = false;
      while (this.runNextEvent(0)) changed = true;

      for (const session of this.sessions.values()) {
        if (session.terminal && !session.sleeping && session.activity === 'prompting') {
          session.activity = 'idle';
          changed = true;
        }
      }

      const sleepingBefore = [...this.sessions.values()].filter(
        (session) => session.sleeping
      ).length;
      this.now += 1_000;
      this.runSleepSweep();
      const sleepingAfter = [...this.sessions.values()].filter(
        (session) => session.sleeping
      ).length;
      if (sleepingAfter > sleepingBefore) changed = true;

      if (!changed && this.events.length === 0) break;
    }
    this.record(`recovery phase stopped after ${turns} turns`);
  }

  assertSafety(): void {
    this.assertNodeCapacities();
    this.assertWorkspaceNodesAreActive();
    this.assertTaskNodesAreActive();
    this.assertSingleLiveWorkspacePerTask();
  }

  private assertNodeCapacities(): void {
    for (const node of this.nodes.values()) {
      const active = this.activeWorkspaceCount(node.id);
      if (active > node.capacity) {
        this.fail(`capacity exceeded on ${node.id}: ${active}/${node.capacity}`);
      }
    }
  }

  private assertWorkspaceNodesAreActive(): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.status === 'sleeping' || workspace.status === 'deleted') continue;
      const node = this.nodes.get(workspace.nodeId);
      if (!node || node.status === 'destroying' || node.status === 'deleted') {
        this.fail(
          `active workspace ${workspace.id} is attached to ${node?.status ?? 'missing'} node ${workspace.nodeId}`
        );
      }
    }
  }

  private assertTaskNodesAreActive(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'completed' || !task.nodeId) continue;
      const node = this.nodes.get(task.nodeId);
      if (!node || node.status === 'destroying' || node.status === 'deleted') {
        this.fail(
          `active task ${task.id} is attached to ${node?.status ?? 'missing'} node ${task.nodeId}`
        );
      }
    }
  }

  private assertSingleLiveWorkspacePerTask(): void {
    const liveWorkspaceOwners = new Set<string>();
    for (const workspace of this.workspaces.values()) {
      if (workspace.status === 'deleted') continue;
      if (liveWorkspaceOwners.has(workspace.taskId)) {
        this.fail(`task ${workspace.taskId} owns multiple live workspaces`);
      }
      liveWorkspaceOwners.add(workspace.taskId);
    }
  }

  assertConverged(): void {
    for (const session of this.sessions.values()) {
      if (session.terminal && !session.sleeping) {
        this.fail(
          `terminal session ${session.id} did not converge (snapshot=${session.snapshotStatus}, attempts=${session.attempts})`
        );
      }
    }
    for (const workspace of this.workspaces.values()) {
      const session = this.sessions.get(workspace.sessionId);
      if (session?.terminal && workspace.status !== 'sleeping' && workspace.status !== 'deleted') {
        this.fail(`terminal workspace ${workspace.id} remained ${workspace.status}`);
      }
    }
  }

  traceText(): string {
    return this.trace.slice(-120).join('\n');
  }

  private addNode(id: string, status: NodeStatus, capacity: number, createdAt: number): SimNode {
    const node: SimNode = {
      id,
      status,
      capacity,
      createdAt,
      idleSince: createdAt,
      claimedTaskIds: new Set(),
      reservedTaskIds: new Set(),
    };
    this.nodes.set(id, node);
    return node;
  }

  private selectNodeWithCapacity(preferred: SimNode | undefined): SimNode | null {
    const ordered = preferred
      ? [preferred, ...[...this.nodes.values()].filter((node) => node !== preferred)]
      : [...this.nodes.values()];
    for (const node of ordered) {
      if (node.status !== 'running') continue;
      const reservations = this.policy.reservePlacementBeforeAsyncCreate
        ? node.reservedTaskIds.size + node.claimedTaskIds.size
        : 0;
      if (this.activeWorkspaceCount(node.id) + reservations < node.capacity) return node;
    }
    return null;
  }

  private provisionNodeForTask(task: SimTask): void {
    const nodeId = `node-auto-${task.id}`;
    const node = this.nodes.get(nodeId) ?? this.addNode(nodeId, 'provisioning', 1, this.now);
    node.claimedTaskIds.add(task.id);
    task.nodeId = node.id;
    this.schedule(5_000, `node-ready:${task.id}`, () => {
      const currentTask = this.tasks.get(task.id);
      const currentNode = this.nodes.get(node.id);
      if (!currentTask || !currentNode) return;
      if (currentNode.status === 'deleted') {
        this.record(`node readiness lost for ${task.id}`);
        return;
      }
      currentNode.status = 'running';
      this.schedule(0, `workspace-commit:${task.id}`, () => this.commitWorkspace(task.id));
    });
  }

  private commitWorkspace(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.workspaceId || !task.nodeId) return;
    const node = this.nodes.get(task.nodeId);

    if (
      this.policy.recheckPlacementAtCommit &&
      (node?.status !== 'running' ||
        (!node.reservedTaskIds.has(task.id) && this.activeWorkspaceCount(node.id) >= node.capacity))
    ) {
      if (node) node.reservedTaskIds.delete(task.id);
      task.nodeId = null;
      this.provisionNodeForTask(task);
      return;
    }
    if (!node) return;

    const workspaceId = `workspace-${task.id}`;
    const sessionId = `session-${task.id}`;
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      nodeId: node.id,
      projectId: task.projectId,
      taskId: task.id,
      sessionId,
      status: 'running',
    });
    this.sessions.set(sessionId, {
      id: sessionId,
      projectId: task.projectId,
      taskId: task.id,
      workspaceId,
      activity: 'prompting',
      terminal: false,
      sleeping: false,
      snapshotStatus: 'missing',
      sleepDueAt: null,
      attempts: 0,
    });
    node.claimedTaskIds.delete(task.id);
    node.reservedTaskIds.delete(task.id);
    task.workspaceId = workspaceId;
    task.sessionId = sessionId;
    task.status = 'running';
    this.record(`workspace committed ${workspaceId} to ${node.id}`);
  }

  private attemptSleep(session: SimSession): void {
    if (session.activity === 'prompting') {
      if (this.policy.promptingConsumesSleepAttempt) {
        session.attempts += 1;
        session.snapshotStatus = 'failed';
      }
      session.sleepDueAt = this.now + 1_000;
      this.record(`sleep deferred ${session.id} attempts=${session.attempts}`);
      return;
    }

    session.attempts += 1;
    if (this.snapshotFailuresRemaining > 0) {
      this.snapshotFailuresRemaining -= 1;
      session.snapshotStatus = 'failed';
      session.sleepDueAt = this.now + 1_000;
      this.record(`snapshot failed ${session.id}`);
      return;
    }

    session.snapshotStatus = 'available';
    session.sleeping = true;
    session.sleepDueAt = null;
    const workspace = this.workspaces.get(session.workspaceId);
    if (workspace) {
      workspace.status = 'sleeping';
      const node = this.nodes.get(workspace.nodeId);
      if (node) node.idleSince = this.now;
    }
    this.record(`session slept ${session.id}`);
  }

  private activeWorkspaceCount(nodeId: string): number {
    return [...this.workspaces.values()].filter(
      (workspace) =>
        workspace.nodeId === nodeId &&
        (workspace.status === 'creating' || workspace.status === 'running')
    ).length;
  }

  private schedule(delayMs: number, label: string, run: () => void): void {
    this.events.push({
      id: this.eventSequence,
      dueAt: this.now + delayMs,
      label,
      run,
    });
    this.eventSequence += 1;
    this.record(`scheduled ${label} at ${this.now + delayMs}`);
  }

  private record(message: string): void {
    this.trace.push(`${this.now.toString().padStart(8, '0')} ${message}`);
    if (this.trace.length > 400) this.trace.shift();
  }

  private fail(message: string): never {
    throw new Error(`${message}\n--- scheduler simulation trace ---\n${this.traceText()}`);
  }
}
