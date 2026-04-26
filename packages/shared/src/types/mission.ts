// =============================================================================
// Mission Types (Phase 2: Orchestration Primitives)
// =============================================================================

// ─── Mission ──────────��──────────────────────────────────────────────────────

export const MISSION_STATUSES = [
  'planning',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value);
}

export interface Mission {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  description: string | null;
  status: MissionStatus;
  rootTaskId: string | null;
  /** JSON-serialized budget config. Enforcement comes in later phases. */
  budgetConfig: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMissionRequest {
  title: string;
  description?: string;
  rootTaskId?: string;
  budgetConfig?: MissionBudgetConfig;
}

export interface MissionBudgetConfig {
  maxActiveTasks?: number;
  maxDescendantsPerSubtree?: number;
  maxRetriesPerTask?: number;
  maxWallClockMs?: number;
  maxVmMinutes?: number;
  maxWorkspaces?: number;
}

// ─── Scheduler State ──���──────────────────────────────────────────────────────

export const SCHEDULER_STATES = [
  'schedulable',
  'blocked_dependency',
  'blocked_budget',
  'blocked_resource',
  'blocked_human',
  'waiting_delivery',
  'stalled',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type SchedulerState = (typeof SCHEDULER_STATES)[number];

export function isSchedulerState(value: unknown): value is SchedulerState {
  return typeof value === 'string' && (SCHEDULER_STATES as readonly string[]).includes(value);
}

// ─── Mission State Entries ────────────��─────────────────────────────────��────

export const MISSION_STATE_ENTRY_TYPES = [
  'decision',
  'assumption',
  'fact',
  'contract',
  'artifact_ref',
  'risk',
  'todo',
] as const;

export type MissionStateEntryType = (typeof MISSION_STATE_ENTRY_TYPES)[number];

export function isMissionStateEntryType(value: unknown): value is MissionStateEntryType {
  return typeof value === 'string' && (MISSION_STATE_ENTRY_TYPES as readonly string[]).includes(value);
}

export interface MissionStateEntry {
  id: string;
  missionId: string;
  type: MissionStateEntryType;
  title: string;
  content: string;
  publishedBy: string;
  publishedByTaskId: string | null;
  /** ID of the entry this supersedes (for corrections/updates). */
  supersedes: string | null;
  confidence: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublishMissionStateRequest {
  missionId: string;
  type: MissionStateEntryType;
  title: string;
  content: string;
  supersedes?: string;
  confidence?: number;
}

// ─── Handoff Packets ────────────────────────────���────────────────────────────

export interface HandoffPacket {
  id: string;
  missionId: string;
  fromTaskId: string;
  toTaskId: string | null;
  summary: string;
  facts: HandoffFact[];
  openQuestions: string[];
  artifactRefs: HandoffArtifactRef[];
  suggestedActions: string[];
  version: number;
  createdAt: number;
}

export interface HandoffFact {
  key: string;
  value: string;
}

export interface HandoffArtifactRef {
  type: 'pr' | 'file' | 'library_file' | 'branch' | 'url';
  ref: string;
  description?: string;
}

export interface PublishHandoffRequest {
  missionId: string;
  toTaskId?: string;
  summary: string;
  facts?: HandoffFact[];
  openQuestions?: string[];
  artifactRefs?: HandoffArtifactRef[];
  suggestedActions?: string[];
}

// ─── API response types ──────────────────────────────────────────────────────

export interface MissionWithTasks extends Mission {
  tasks: MissionTaskSummary[];
}

export interface MissionTaskSummary {
  id: string;
  title: string;
  status: string;
  schedulerState: SchedulerState | null;
  parentTaskId: string | null;
  dispatchDepth: number;
}
