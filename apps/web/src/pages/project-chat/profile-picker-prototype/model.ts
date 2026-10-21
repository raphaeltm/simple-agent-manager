/**
 * PROTOTYPE — new-chat profile picker directions (2026-10-21). Do not merge to main.
 * See .claude/rules/37-prototype-development.md.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { getModelsForAgent } from '@simple-agent-manager/shared';

export type PickerVariant = 'a' | 'b' | 'c';

export function getPickerVariant(search: string): PickerVariant | null {
  const value = new URLSearchParams(search).get('pp');
  return value === 'a' || value === 'b' || value === 'c' ? value : null;
}

export interface ProfileUsageEntry {
  profileId: string;
  count30d: number;
  count14d: number;
  lastUsedAt: string;
}

export interface AutomationUsageEntry {
  profileId: string;
  count30d: number;
}

export interface ProfileUsage {
  usage: ProfileUsageEntry[];
  automationUsage: AutomationUsageEntry[];
}

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  'openai-codex': 'Codex',
  opencode: 'OpenCode',
};

const EFFORT_LABELS: Record<string, string> = {
  low: 'low effort',
  medium: 'medium effort',
  high: 'high effort',
  xhigh: 'extra-high effort',
  max: 'max effort',
};

export function agentLabel(agentType: string): string {
  return AGENT_LABELS[agentType] ?? agentType;
}

/** One letter that tells brains apart: O(pus), S(ol), A(stra), F(able), L(una)… */
export function profileGlyph(profile: Pick<AgentProfile, 'agentType' | 'model'>): string {
  const words = (modelLabel(profile) ?? agentLabel(profile.agentType)).split(/[\s-]+/);
  const word =
    words.find((value) => /^[a-z]/i.test(value) && !/^gpt$/i.test(value)) ?? words[0] ?? '?';
  return word.charAt(0).toUpperCase();
}

export function modelLabel(profile: Pick<AgentProfile, 'agentType' | 'model'>): string | null {
  if (!profile.model) return null;
  const known = getModelsForAgent(profile.agentType).find((model) => model.id === profile.model);
  const raw = known?.name ?? profile.model.split('/').pop() ?? profile.model;
  return raw.replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '');
}

export function effortLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  return EFFORT_LABELS[effort] ?? null;
}

export function isBuildProfile(profile: Pick<AgentProfile, 'taskMode'>): boolean {
  return profile.taskMode === 'task';
}

/** "Claude · Opus 5.5 · max effort" */
export function profileSubtitle(profile: AgentProfile): string {
  return [agentLabel(profile.agentType), modelLabel(profile), effortLabel(profile.effort)]
    .filter(Boolean)
    .join(' · ');
}

/** Plain-language consequences of starting with this profile. */
export function profileConsequence(profile: AgentProfile): string {
  if (profile.runtime === 'cf-container') return 'Chat · starts instantly';
  if (isBuildProfile(profile)) return 'Builds and opens PRs · full workspace';
  return 'Chat · light workspace';
}

function usageById(usage: ProfileUsage | undefined) {
  return new Map((usage?.usage ?? []).map((entry) => [entry.profileId, entry]));
}

/** Most recently used first; profiles never used keep catalog order. */
export function recentProfiles(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined,
  limit: number
): AgentProfile[] {
  const byId = usageById(usage);
  return profiles
    .filter((profile) => byId.has(profile.id))
    .sort((a, b) =>
      (byId.get(b.id)?.lastUsedAt ?? '').localeCompare(byId.get(a.id)?.lastUsedAt ?? '')
    )
    .slice(0, limit);
}

/** Usage-ranked: 30-day count, recent fortnight weighted double. */
export function rankedProfiles(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined
): AgentProfile[] {
  const byId = usageById(usage);
  const score = (profile: AgentProfile) => {
    const entry = byId.get(profile.id);
    return entry ? entry.count30d + entry.count14d : 0;
  };
  return [...profiles].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

export function predictedProfileId(profiles: AgentProfile[], usage: ProfileUsage | undefined) {
  return recentProfiles(profiles, usage, 1)[0]?.id ?? profiles[0]?.id ?? null;
}

export function manualCount(usage: ProfileUsage | undefined, profileId: string): number {
  return usageById(usage).get(profileId)?.count30d ?? 0;
}

export function automationCount(usage: ProfileUsage | undefined, profileId: string): number {
  return usage?.automationUsage.find((entry) => entry.profileId === profileId)?.count30d ?? 0;
}

/** Profiles you have not picked by hand for 30 days. */
export function idleProfiles(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined
): AgentProfile[] {
  return profiles.filter((profile) => manualCount(usage, profile.id) === 0);
}

/** Pairs that share agent, model and effort — candidates to merge. */
export function lookalikePairs(profiles: AgentProfile[]): Array<[AgentProfile, AgentProfile]> {
  const pairs: Array<[AgentProfile, AgentProfile]> = [];
  profiles.forEach((profile, index) => {
    profiles.slice(index + 1).forEach((other) => {
      if (
        profile.agentType === other.agentType &&
        profile.model === other.model &&
        profile.effort === other.effort &&
        profile.taskMode === other.taskMode
      ) {
        pairs.push([profile, other]);
      }
    });
  });
  return pairs;
}
