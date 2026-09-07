/** Teaching model, not production scheduling code. One user / compatible pool.
 * Each step compresses asynchronous work. Toy limits are intentionally explicit.
 * Source map: the accompanying how-sam-scheduler-works article.
 */
export const LAB = {
  slotsPerNode: 2,
  bootSteps: 3,
  runSteps: 6,
  waitSteps: 12,
  maxTasks: 32,
  playMs: 1400,
};
export type Kind = 'chat' | 'code' | 'review' | 'instant';
export type Scenario = 'mixed' | 'cold' | 'pressure' | 'sleep';
export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'sleeping';
export interface Task {
  id: number;
  kind: Kind;
  state: TaskState;
  node: number | null;
  remaining: number;
  waited: number;
  reason: string;
}
export interface Node {
  id: number;
  size: 'small' | 'large';
  state: 'absent' | 'booting' | 'active' | 'warm';
  boot: number;
}
export interface Lab {
  tick: number;
  tasks: Task[];
  nodes: Node[];
  providerAvailable: boolean;
  maxNodes: number;
  events: string[];
  scenario: Scenario;
}
export const KINDS: Record<Kind, { label: string; glyph: string; detail: string }> = {
  chat: { label: 'Chat', glyph: '◌', detail: 'VM · small minimum' },
  code: { label: 'Code', glyph: '⌘', detail: 'VM · large minimum' },
  review: { label: 'Review', glyph: '◇', detail: 'VM · small minimum' },
  instant: { label: 'Instant', glyph: 'ϟ', detail: 'Explicit CF container' },
};
export const SCENARIOS: Record<Scenario, { title: string; hint: string }> = {
  mixed: {
    title: 'A little of everything',
    hint: 'Send a mixed burst, then step. Three VM tasks can share two compatible nodes; an explicit Instant request takes another runtime path.',
  },
  cold: {
    title: 'One boot, several tasks',
    hint: 'No VMs are ready. Send a mixed burst and step: one task holds the provisioning lease, and other VM tasks wait and recheck.',
  },
  pressure: {
    title: 'The cloud says “full”',
    hint: 'Provider-account capacity is unavailable. Send a burst: the small node still accepts compatible work, but Code waits. Restore provider capacity or step until its deadline.',
  },
  sleep: {
    title: 'Release the workspace. Keep the node.',
    hint: 'This chat has handed control back with no work in flight. Sleep it, then submit more work to see warm reuse. Sleep preserves the conversation.',
  },
};
export function createLab(scenario: Scenario = 'mixed'): Lab {
  const lab: Lab = {
    tick: 0,
    scenario,
    tasks: [],
    providerAvailable: scenario !== 'pressure',
    maxNodes: 3,
    nodes: [
      { id: 1, size: 'small', state: scenario === 'cold' ? 'absent' : 'warm', boot: 0 },
      { id: 2, size: 'large', state: scenario === 'mixed' ? 'warm' : 'absent', boot: 0 },
      { id: 3, size: 'large', state: 'absent', boot: 0 },
    ],
    events: ['Ready. Choose a workload and advance one step.'],
  };
  if (scenario === 'sleep') {
    lab.tasks.push({
      id: 1,
      kind: 'chat',
      state: 'running',
      node: 1,
      remaining: 0,
      waited: 0,
      reason: 'Turn ended · nothing in flight',
    });
    const firstNode = lab.nodes[0];
    if (firstNode) firstNode.state = 'active';
  }
  return lab;
}
export function record(lab: Lab, message: string): void {
  lab.events = [`${String(lab.tick).padStart(2, '0')} / ${message}`, ...lab.events].slice(0, 5);
}
export function submit(lab: Lab, kind: Kind): void {
  if (lab.tasks.length >= LAB.maxTasks) return;
  lab.tasks.push({
    id: lab.tasks.length + 1,
    kind,
    state: 'queued',
    node: null,
    remaining: LAB.runSteps,
    waited: 0,
    reason: 'Accepted · awaiting placement',
  });
  record(lab, `${KINDS[kind].label} accepted. Its task record exists before compute does.`);
}
export function sleepIdle(lab: Lab): void {
  const task = lab.tasks.find(
    (t) => t.state === 'running' && t.kind === 'chat' && t.remaining === 0
  );
  if (!task) return;
  task.state = 'sleeping';
  task.reason = 'Conversation preserved · workspace released';
  record(
    lab,
    `Chat #${task.id} sleeps. Verified snapshot and workspace release are compressed into this step.`
  );
  refreshNodes(lab);
}
function refreshNodes(lab: Lab): void {
  for (const node of lab.nodes) {
    if (node.state === 'active' || node.state === 'warm') {
      node.state = lab.tasks.some((t) => t.state === 'running' && t.node === node.id)
        ? 'active'
        : 'warm';
    }
  }
}
function place(lab: Lab, task: Task): boolean {
  const candidates = lab.nodes
    .filter(
      (n) =>
        (n.state === 'warm' || n.state === 'active') &&
        (task.kind !== 'code' || n.size === 'large') &&
        lab.tasks.filter((t) => t.state === 'running' && t.node === n.id).length < LAB.slotsPerNode
    )
    .sort((a, b) => Number(b.state === 'warm') - Number(a.state === 'warm'));
  const node = candidates[0];
  if (!node) return false;
  const warm = node.state === 'warm';
  task.node = node.id;
  task.state = 'running';
  task.reason = `${warm ? 'Warm reuse' : 'Shared node'} · workspace slot reserved`;
  node.state = 'active';
  record(
    lab,
    `${KINDS[task.kind].label} #${task.id} reserves a slot on VM ${node.id}. ${warm ? 'No VM boot needed.' : 'Existing compute reused.'}`
  );
  return true;
}
export function step(lab: Lab): void {
  lab.tick++;
  for (const node of lab.nodes) {
    if (node.state === 'booting' && --node.boot <= 0) {
      node.state = 'warm';
      record(
        lab,
        `VM ${node.id} is ready. Release the provisioning lease; waiters recheck placement.`
      );
    }
  }
  for (const task of lab.tasks) {
    if (task.state !== 'running' || task.remaining === 0) continue;
    task.remaining--;
    if (task.remaining === 0) {
      if (task.kind === 'chat') {
        task.reason = 'Turn ended · nothing in flight';
        record(lab, `Chat #${task.id} is idle. Sleep can now release its workspace safely.`);
      } else {
        task.state = 'completed';
        task.reason = 'Completed · workspace released';
        record(
          lab,
          `${KINDS[task.kind].label} #${task.id} completed. Cleanup is compressed into this step.`
        );
      }
    }
  }
  refreshNodes(lab);
  for (const task of lab.tasks.filter((t) => t.state === 'queued')) {
    if (task.kind === 'instant') {
      task.state = 'running';
      task.reason = 'Explicit cf-container · separate runtime';
      record(lab, `Instant #${task.id} starts in a Cloudflare container, outside VM admission.`);
      continue;
    }
    if (place(lab, task)) continue;
    if (++task.waited >= LAB.waitSteps) {
      task.state = 'failed';
      task.reason = 'VM capacity wait deadline expired';
      record(
        lab,
        `${KINDS[task.kind].label} #${task.id} hit its capacity deadline. Visible failure, not an endless spinner.`
      );
      continue;
    }
    const previousReason = task.reason;
    if (lab.nodes.some((n) => n.state === 'booting'))
      task.reason = 'Waiting · provisioning lease held';
    else if (!lab.providerAvailable) task.reason = 'Waiting · provider capacity cooldown';
    else if (lab.nodes.filter((n) => n.state !== 'absent').length >= lab.maxNodes)
      task.reason = 'Waiting · node limit reached';
    else {
      // Choose a large machine for a pending large request so the cold burst
      // demonstrates compatible sharing. Production resolves concrete offerings.
      const needsLarge = lab.tasks.some((t) => t.state === 'queued' && t.kind === 'code');
      const node = lab.nodes.find(
        (n) => n.state === 'absent' && (!needsLarge || n.size === 'large')
      );
      if (node) {
        node.state = 'booting';
        node.boot = LAB.bootSteps;
        task.reason = 'Waiting · owns provisioning lease';
        record(lab, `One provisioning lease granted. Boot VM ${node.id}; other requests wait.`);
      } else task.reason = 'Waiting · no compatible offering in this lab';
    }
    if (task.reason !== previousReason)
      record(
        lab,
        `${KINDS[task.kind].label} #${task.id}: ${task.reason}. Retry is scheduled; the task is saved.`
      );
  }
  refreshNodes(lab);
}
