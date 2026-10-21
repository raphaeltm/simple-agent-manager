/**
 * Pure helpers for the new-chat profile picker (idea 01M5EW9H86VD88S7E3WWA1D9X1):
 * plain-language profile labels, the person's recent profiles, picker sections and the
 * default selection. Usage and hidden profiles come from GET .../agent-profiles/picker.
 */
import type { AgentProfile, ProfilePickerState } from '@simple-agent-manager/shared';
import { getModelsForAgent } from '@simple-agent-manager/shared';

/** Picker state as the composer sees it while the request is in flight or has failed. */
export type PickerSelectionInput =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; state: ProfilePickerState };

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

/** "Opus 5.5" for `claude-opus-5-5`; falls back to the raw id when the catalog has no entry. */
export function modelLabel(profile: Pick<AgentProfile, 'agentType' | 'model'>): string | null {
  if (!profile.model) return null;
  const known = getModelsForAgent(profile.agentType).find((model) => model.id === profile.model);
  const raw = known?.name ?? profile.model.split('/').pop() ?? profile.model;
  return raw.replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '');
}

export function effortLabel(effort: string | null | undefined): string | null {
  return effort ? (EFFORT_LABELS[effort] ?? null) : null;
}

/** "Claude · Opus 5.5 · max effort" — what will actually run. */
export function profileSubtitle(profile: AgentProfile): string {
  return [agentLabel(profile.agentType), modelLabel(profile), effortLabel(profile.effort)]
    .filter(Boolean)
    .join(' · ');
}

/** One letter that tells models apart: O(pus), S(ol), A(stra), F(able), L(una)… */
export function profileGlyph(profile: Pick<AgentProfile, 'agentType' | 'model'>): string {
  const words = (modelLabel(profile) ?? agentLabel(profile.agentType)).split(/[\s-]+/);
  const word =
    words.find((value) => /^\p{L}/u.test(value) && !/^gpt$/i.test(value)) ?? words[0] ?? '?';
  return (Array.from(word)[0] ?? '?').toUpperCase();
}

/** Profiles that build and open pull requests rather than chat. */
export function isBuildProfile(profile: Pick<AgentProfile, 'taskMode'>): boolean {
  return profile.taskMode === 'task';
}

export function visibleProfiles(
  profiles: AgentProfile[],
  state: ProfilePickerState | undefined
): AgentProfile[] {
  const hidden = new Set(state?.hiddenProfileIds ?? []);
  return profiles.filter((profile) => !hidden.has(profile.id));
}

/** Visible profiles the person used in the window, most recent first. */
export function recentProfiles(
  profiles: AgentProfile[],
  state: ProfilePickerState | undefined,
  limit: number
): AgentProfile[] {
  const byId = new Map(visibleProfiles(profiles, state).map((profile) => [profile.id, profile]));
  const recent: AgentProfile[] = [];
  for (const entry of state?.usage ?? []) {
    const profile = byId.get(entry.profileId);
    if (profile) recent.push(profile);
    if (recent.length >= limit) break;
  }
  return recent;
}

/**
 * Pre-selection for a new chat: the last-used visible profile, else the first visible
 * one, else the first profile. Never replaces a choice the person already made.
 * Returns null while picker state is loading so the alphabetical profile never flashes
 * in before the real default arrives.
 */
export function selectProfileId(
  current: string | null,
  profiles: AgentProfile[],
  picker: PickerSelectionInput
): string | null {
  if (current && profiles.some((profile) => profile.id === current)) return current;
  if (profiles.length === 0) return null;
  if (picker.status === 'loading') return null;
  const state = picker.status === 'ready' ? picker.state : undefined;
  return (
    recentProfiles(profiles, state, 1)[0]?.id ??
    visibleProfiles(profiles, state)[0]?.id ??
    profiles[0]?.id ??
    null
  );
}

export interface ProfileCardSet {
  /** "Recent" when the person has usage in the window, otherwise their first profiles. */
  kind: 'recent' | 'profiles';
  items: AgentProfile[];
  /** Build profiles not already shown, for the wider desktop layout. */
  builders: AgentProfile[];
}

export function profileCardSet(
  profiles: AgentProfile[],
  state: ProfilePickerState | undefined,
  limit: number
): ProfileCardSet {
  const recent = recentProfiles(profiles, state, limit);
  const visible = visibleProfiles(profiles, state);
  const items = recent.length > 0 ? recent : visible.slice(0, limit);
  const shown = new Set(items.map((profile) => profile.id));
  return {
    kind: recent.length > 0 ? 'recent' : 'profiles',
    items,
    builders: visible
      .filter((profile) => isBuildProfile(profile) && !shown.has(profile.id))
      .slice(0, limit),
  };
}

export interface PickerSection {
  id: 'results' | 'recent' | 'chat' | 'build' | 'hidden';
  label: string;
  items: AgentProfile[];
}

export function pickerSections(
  profiles: AgentProfile[],
  state: ProfilePickerState | undefined,
  query: string,
  recentLimit: number
): PickerSection[] {
  const hidden = new Set(state?.hiddenProfileIds ?? []);
  const trimmed = query.trim().toLowerCase();
  if (trimmed) {
    return [
      {
        id: 'results',
        label: 'Results',
        items: profiles.filter((profile) =>
          `${profile.name} ${profile.description ?? ''} ${profileSubtitle(profile)}`
            .toLowerCase()
            .includes(trimmed)
        ),
      },
    ];
  }
  const recent = recentProfiles(profiles, state, recentLimit);
  const recentIds = new Set(recent.map((profile) => profile.id));
  const rest = profiles.filter((profile) => !recentIds.has(profile.id) && !hidden.has(profile.id));
  return [
    { id: 'recent' as const, label: 'Recent', items: recent },
    { id: 'chat' as const, label: 'Chat & explore', items: rest.filter((p) => !isBuildProfile(p)) },
    { id: 'build' as const, label: 'Build & open PRs', items: rest.filter(isBuildProfile) },
    {
      id: 'hidden' as const,
      label: 'Hidden from new chat',
      items: profiles.filter((profile) => hidden.has(profile.id)),
    },
  ].filter((section) => section.items.length > 0);
}

/**
 * Visible profiles the person has not picked in the usage window. Only offered once
 * they have some usage, and never all of their visible profiles, so the suggestion
 * cannot empty the picker.
 */
export function idleProfiles(
  profiles: AgentProfile[],
  state: ProfilePickerState | undefined
): AgentProfile[] {
  const usage = state?.usage ?? [];
  if (usage.length === 0) return [];
  const used = new Set(usage.map((entry) => entry.profileId));
  const visible = visibleProfiles(profiles, state);
  const idle = visible.filter((profile) => !used.has(profile.id));
  return idle.length < visible.length ? idle : [];
}
