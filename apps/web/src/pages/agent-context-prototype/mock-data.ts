export type ContextSection = 'overview' | 'memory' | 'policies' | 'actions' | 'missions';

export interface MemoryEntity {
  id: string;
  name: string;
  type: 'preference' | 'context' | 'workflow' | 'expertise' | 'custom';
  observationCount: number;
  confidence: number;
  source: 'explicit' | 'inferred' | 'behavioral';
  lastConfirmed: string;
  summary: string;
  sourceLabel: string;
}

export interface ProjectPolicy {
  id: string;
  title: string;
  category: 'rule' | 'constraint' | 'delegation' | 'preference';
  content: string;
  source: 'explicit' | 'inferred';
  confidence: number;
  active: boolean;
  enforcement: 'instruction-only' | 'not-enforced' | 'future-runtime';
  sourceLabel: string;
  updatedAt: string;
}

export interface AgentAction {
  id: string;
  tool: string;
  label: string;
  actor: string;
  target: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'pending';
  summary: string;
  timestamp: string;
  source: string;
}

export interface MissionItem {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  summary: string;
  tasks: number;
  handoffs: number;
  updatedAt: string;
}

export const prototypeProject = {
  name: 'SAM / simple-agent-manager',
  repo: 'raphaeltm/simple-agent-manager',
  branch: 'prototype/project-agent-context',
  description:
    'Project-scoped inspection surface for what agents remember, what they are instructed to follow, and the durable actions they recently took.',
};

export const memoryEntities: MemoryEntity[] = [
  {
    id: 'mem-1',
    name: 'AgentBehavior',
    type: 'preference',
    observationCount: 14,
    confidence: 0.96,
    source: 'explicit',
    lastConfirmed: 'Today 18:12',
    sourceLabel: 'From chat: project-scoped Agent Context discussion',
    summary:
      'Raphael strongly dislikes unsupported debugging guesses and expects agents to ground theories in production evidence, direct verification, and source-linked explanations before changing code.',
  },
  {
    id: 'mem-2',
    name: 'PrototypeUXScrollingBoundaryWithAnIntentionallyRidiculouslyLongEntityNameThatMustWrapCleanly',
    type: 'workflow',
    observationCount: 3,
    confidence: 0.95,
    source: 'explicit',
    lastConfirmed: 'Today 18:32',
    sourceLabel: 'Policy source: prototype screenshots must account for custom app scrolling wrapper',
    summary:
      'SAM web surfaces use a custom scrolling wrapper instead of body/html scrolling. Prototype pages must verify overflow inside the app container with long data, mobile viewport, and click-through recordings.',
  },
  {
    id: 'mem-3',
    name: 'Architecture',
    type: 'context',
    observationCount: 27,
    confidence: 0.92,
    source: 'behavioral',
    lastConfirmed: 'May 21',
    sourceLabel: 'From previous architecture sessions',
    summary:
      'SAM platform policy should mean server-enforced MCP authorization for platform-owned tools, distinct from remembered project policies and distinct from coding-agent permissionMode.',
  },
  {
    id: 'mem-4',
    name: 'OneLetterEntityX',
    type: 'custom',
    observationCount: 1,
    confidence: 0.7,
    source: 'inferred',
    lastConfirmed: 'Never',
    sourceLabel: 'Imported from old conversation, needs review',
    summary: 'Tiny edge case entity with minimal content.',
  },
  {
    id: 'mem-5',
    name: 'ContentStyle',
    type: 'preference',
    observationCount: 5,
    confidence: 0.9,
    source: 'explicit',
    lastConfirmed: 'May 18',
    sourceLabel: 'From content strategy review',
    summary:
      'Do not talk about missions, policy propagation, or handoff packets in public content unless the user explicitly asks; these are internal control-plane concepts and mostly not product messaging.',
  },
];

export const policies: ProjectPolicy[] = [
  {
    id: 'pol-1',
    title: 'Keep agent control surfaces project-scoped, not top-level nav',
    category: 'preference',
    content:
      'When designing visibility for hidden agent systems such as memory, policies, missions, and tool activity, keep the surface project-scoped and contextual rather than adding a broad top-level Agent Control nav item. Prefer simple UX that exposes internals only when needed for trust, debugging, or inspection.',
    source: 'explicit',
    confidence: 0.95,
    active: true,
    enforcement: 'instruction-only',
    sourceLabel: 'Current chat session',
    updatedAt: 'Today 18:22',
  },
  {
    id: 'pol-2',
    title:
      'Missing credentials block merge - notify human, do not skip verification even when a UI screen renders correctly and an endpoint returns 200',
    category: 'rule',
    content:
      'When staging verification is blocked by missing credentials, secrets, or infrastructure configuration, do not merge. Comment on the PR, label it needs-human-review, request human input, and stop. Missing credentials are never a reason to skip feature verification.',
    source: 'explicit',
    confidence: 0.95,
    active: true,
    enforcement: 'instruction-only',
    sourceLabel: 'Policy 86348737-b144-41aa-bd8e-58950a4f90af',
    updatedAt: 'May 6',
  },
  {
    id: 'pol-3',
    title: 'Prototype artifacts are not production deliverables by default',
    category: 'rule',
    content:
      'Prototype, spike, and demo artifacts may use mock data and unauthenticated routes for fast exploration, but agents must not ship prototype-only routes, fixture-backed UI, demo navigation, or scaffolded experiments to production unless Raphael explicitly asks to ship the prototype itself.',
    source: 'inferred',
    confidence: 0.9,
    active: true,
    enforcement: 'instruction-only',
    sourceLabel: 'Workflow policy from repeated prototype tasks',
    updatedAt: 'May 12',
  },
  {
    id: 'pol-4',
    title: '<script>alert("xss")</script> should render as text, never markup',
    category: 'constraint',
    content:
      'Stress-test policy content with HTML-like strings, ampersands & entities, long URLs like https://example.com/really/deep/path/that/keeps/going?with=query&and=more&values=1234567890 to confirm safe wrapping and escaping.',
    source: 'explicit',
    confidence: 0.91,
    active: true,
    enforcement: 'not-enforced',
    sourceLabel: 'Mock stress data',
    updatedAt: 'Today 18:41',
  },
  {
    id: 'pol-5',
    title: 'Old policy that has been deactivated but should remain inspectable for provenance',
    category: 'delegation',
    content:
      'This inactive policy demonstrates how disabled guidance should appear without disappearing from the audit trail.',
    source: 'inferred',
    confidence: 0.61,
    active: false,
    enforcement: 'instruction-only',
    sourceLabel: 'Superseded by newer delegation preference',
    updatedAt: 'Apr 27',
  },
];

export const actions: AgentAction[] = [
  {
    id: 'act-1',
    tool: 'add_policy',
    label: 'Added project policy',
    actor: 'Codex task 01KSM4T5GNH6FX3XTGVQ13CE4Y',
    target: 'Policy: project-scoped agent control surfaces',
    status: 'succeeded',
    summary:
      'Captured Raphael\'s correction that hidden-agent visibility belongs inside project context, not top-level app navigation.',
    timestamp: '2 min ago',
    source: 'Current chat session',
  },
  {
    id: 'act-2',
    tool: 'search_knowledge',
    label: 'Searched project memory',
    actor: 'Codex conversation agent',
    target: 'Knowledge graph',
    status: 'failed',
    summary:
      'Search query was too broad and hit SQLite LIKE/GLOB pattern complexity. Agent retried with narrower searches.',
    timestamp: '12 min ago',
    source: 'Tool result',
  },
  {
    id: 'act-3',
    tool: 'dispatch_task',
    label: 'Dispatched child task',
    actor: 'SAM project agent',
    target: 'Prototype visual audit follow-up with an intentionally long branch name that should truncate',
    status: 'pending',
    summary:
      'Queued task with branch prototype/project-agent-context. Awaiting workspace. This row is mock data for pending-state layout.',
    timestamp: '19 min ago',
    source: 'MCP event mock',
  },
  {
    id: 'act-4',
    tool: 'update_policy',
    label: 'Updated policy confidence',
    actor: 'Project Orchestrator',
    target: 'Prototype artifacts are not production deliverables by default',
    status: 'blocked',
    summary:
      'Would require human confirmation because changing a hard workflow rule has broad impact. This previews a future approval state.',
    timestamp: '41 min ago',
    source: 'Future platform policy example',
  },
  {
    id: 'act-5',
    tool: 'publish_handoff',
    label: 'Published handoff packet',
    actor: 'Research agent',
    target: 'Mission: clarify hidden system state',
    status: 'succeeded',
    summary:
      'Recorded findings that project policies are instruction-only while SAM platform policy is an unimplemented server-enforced authorization idea.',
    timestamp: '1 hr ago',
    source: 'Mission state',
  },
];

export const missions: MissionItem[] = [
  {
    id: 'mis-1',
    title: 'Document hidden system features and their functionality',
    status: 'active',
    summary:
      'Conversation-led investigation into policies, knowledge, missions, MCP tools, and which pieces are visible to the user.',
    tasks: 3,
    handoffs: 2,
    updatedAt: 'Today 18:43',
  },
  {
    id: 'mis-2',
    title:
      'Very long mission title that should wrap over multiple lines without forcing horizontal page scroll or crushing the status controls',
    status: 'blocked',
    summary:
      'Blocked by missing runtime enforcement primitives. Kept here to verify long-title mission cards on mobile.',
    tasks: 18,
    handoffs: 37,
    updatedAt: 'Yesterday',
  },
  {
    id: 'mis-3',
    title: 'Policy propagation phase 4 rollout',
    status: 'completed',
    summary:
      'Historical mission-like work that shipped project policy storage, get_instructions injection, and propagation to mission child tasks.',
    tasks: 7,
    handoffs: 0,
    updatedAt: 'Apr 26',
  },
];
