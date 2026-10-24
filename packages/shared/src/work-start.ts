/**
 * What starting work on an idea will actually do, derived from the same layering the
 * server uses. One definition, imported by the web Start work sheet and by the API, so
 * the sentence the person reads and the task the server creates cannot disagree.
 *
 * The honest question this answers is "will SAM run this as a task or as a conversation",
 * not "can the agent change code": a VM conversation profile has the repository checked
 * out and can absolutely change code, it just never completes a task or pushes on its
 * own. Copy built on this must say what SAM will do, not guess at the agent's powers.
 */
import { DEFAULT_WORKSPACE_PROFILE } from './constants/defaults';
import type { AgentProfileRuntime } from './types/agent-settings';
import type { LinkRelation } from './types/links';
import type { TaskMode } from './types/task';
import type { WorkspaceProfile } from './types/workspace';

/** `task-execution`: SAM runs it as a task. `conversation`: SAM runs it as a chat. */
export type WorkStartCapability = 'task-execution' | 'conversation';

/**
 * The placement fields of one layer (a skill or an agent profile). Deliberately
 * structural: callers pass an `AgentProfile`, a `Skill`, or a stored row directly.
 */
export interface WorkStartLayer {
  runtime?: AgentProfileRuntime | null;
  taskMode?: string | null;
  workspaceProfile?: string | null;
}

export interface WorkStartPlan {
  /**
   * The mode the caller sends explicitly on start. Both submit branches honour an
   * explicit mode, so what the sheet promises and what the server creates are the same
   * value rather than two resolutions that could drift.
   */
  taskMode: TaskMode;
  /** The same fact, named: what SAM will do with this profile. */
  capability: WorkStartCapability;
}

export interface WorkStartPlanInput {
  profile?: WorkStartLayer | null;
  /** A selected skill overrides the profile, exactly as `resolveSkillProfile` does. */
  skill?: WorkStartLayer | null;
  projectDefaultWorkspaceProfile?: string | null;
}

function asWorkspaceProfile(value: string | null | undefined): WorkspaceProfile | null {
  return value === 'full' || value === 'lightweight' ? value : null;
}

function asTaskMode(value: string | null | undefined): TaskMode | null {
  return value === 'task' || value === 'conversation' ? value : null;
}

/**
 * Mirrors `resolveSkillProfile` (skill over profile),
 * `resolveWorkspaceProfile` (profile → project → `DEFAULT_WORKSPACE_PROFILE`) and
 * `resolveTaskMode` with `taskModeDefault: 'workspace-profile'`, which is the policy
 * `POST /tasks/submit` passes. Keep those four in step: if the submit path changes its
 * layering, this changes with it or the sheet starts promising the wrong thing.
 *
 * The runtime is deliberately NOT part of the result. The server resolves it from the
 * profile and the project's credentials, and nothing here should encourage a caller to
 * send one — that is how the July "Execute silently turned an Instant profile into a VM"
 * bug happened. The layer's `runtime` is still read, because a skill that pins one is
 * part of what the person chose, but only to keep the override chain honest.
 *
 * `cf-container` is NOT forced to `conversation`. `submitInstantTask` honours a `task`
 * mode inside a container, so claiming otherwise would be a lie about a real capability.
 */
export function resolveWorkStartPlan(input: WorkStartPlanInput): WorkStartPlan {
  const { profile, skill } = input;
  const workspaceProfile =
    asWorkspaceProfile(skill?.workspaceProfile) ??
    asWorkspaceProfile(profile?.workspaceProfile) ??
    asWorkspaceProfile(input.projectDefaultWorkspaceProfile) ??
    DEFAULT_WORKSPACE_PROFILE;
  const taskMode =
    asTaskMode(skill?.taskMode) ??
    asTaskMode(profile?.taskMode) ??
    (workspaceProfile === 'lightweight' ? 'conversation' : 'task');
  return { taskMode, capability: taskMode === 'task' ? 'task-execution' : 'conversation' };
}

/**
 * How the new chat is recorded against the idea. `works_on` is a strong link (the idea
 * owns the chat's files and pull requests); `discusses` is weak, so a conversation never
 * pulls another session's work into the idea.
 */
export function workStartRelationFor(
  taskMode: TaskMode
): Extract<LinkRelation, 'works_on' | 'discusses'> {
  return taskMode === 'task' ? 'works_on' : 'discusses';
}
