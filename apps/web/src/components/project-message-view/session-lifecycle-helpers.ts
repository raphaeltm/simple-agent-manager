import type { SessionStateSnapshot } from '../../lib/api';

export type FilePanelState = {
  mode: 'browse' | 'view' | 'diff' | 'git-status';
  path?: string;
  line?: number | null;
} | null;

export function parsePlanContent(content: string): SessionStateSnapshot['currentPlan'] | null {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hashPlanContent(plan: SessionStateSnapshot['currentPlan']): string {
  if (!plan) return 'none';
  const serialized = JSON.stringify(plan);
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
  }
  return `${plan.length}:${hash.toString(36)}`;
}

export function getPlanFingerprint(state: SessionStateSnapshot | null | undefined): string {
  if (!state) return 'no-state';
  return state.planUpdatedAt
    ? `updated:${state.planUpdatedAt}`
    : `content:${hashPlanContent(state.currentPlan)}`;
}
