/**
 * The proposed resolution order, written as plain logic so the prototype shows
 * exactly what the server would do:
 *
 *   1. your account for this profile     (personal profile pin)
 *   2. the profile's team account        (shared by an admin)
 *   3. your account for this project     (personal project pin, exists today)
 *   4. your default account              (exists today)
 *   5. SAM platform AI                   (exists today)
 *
 * A team account set with "members may use their own account" off skips tier 1.
 * A paused pin or a revoked team account HALTS the chain (Rule 28): SAM stops
 * rather than quietly billing a different account.
 */
import type { Account, AgentType, PersonalChoices, Profile, TeamAccount } from './mock-data';
import { AGENT_LABEL, PLATFORM_AGENT_TYPES } from './mock-data';

export type TierId = 'profile' | 'team' | 'project' | 'default' | 'platform';
export type StepState = 'wins' | 'skipped' | 'empty' | 'halts' | 'not-reached';

export interface Step {
  tier: TierId;
  title: string;
  state: StepState;
  detail: string;
}

export type Outcome =
  | { kind: 'account'; label: string; tier: TierId; viaProxy: boolean }
  | { kind: 'halt'; reason: string }
  | { kind: 'none' };

export interface Resolution {
  runAgentType: AgentType;
  steps: Step[];
  outcome: Outcome;
}

interface ResolveInput {
  profile: Profile;
  projectId: string;
  choices: PersonalChoices;
  accounts: Account[];
  teamAccounts: TeamAccount[];
  /** Single-person projects and personal profiles have no team tier. */
  includeTeamTier: boolean;
  /** Another member's view: account names are private, so they are never shown. */
  hideAccountNames?: boolean;
}

type Lookup = { label: string; active: boolean; agentType: AgentType | null };

function lookup(accounts: Account[], id: string, hide: boolean): Lookup {
  const account = accounts.find((a) => a.id === id);
  if (!account) return { label: 'their own account', active: true, agentType: null };
  return { label: hide ? 'their own account' : account.label, active: account.active, agentType: account.agentType };
}

export function resolveAccount(input: ResolveInput): Resolution {
  const { profile, choices, accounts, teamAccounts, includeTeamTier, projectId } = input;
  const hide = input.hideAccountNames ?? false;
  const runAgentType = profile.skillAgentType ?? profile.agentType;
  const runLabel = AGENT_LABEL[runAgentType];
  const team = profile.teamAccountId
    ? (teamAccounts.find((t) => t.id === profile.teamAccountId) ?? null)
    : null;
  const personalAllowed = !team || profile.allowPersonal;

  const steps: Step[] = [];
  let outcome: Outcome | null = null;
  const push = (step: Omit<Step, 'state'> & { state: StepState }) => {
    steps.push(outcome ? { ...step, state: 'not-reached' } : step);
  };

  // Tier 1 — personal profile pin
  const profilePin = choices.profilePins[profile.id];
  const t1 = { tier: 'profile' as const, title: 'Your account for this profile' };
  if (!profilePin) push({ ...t1, state: 'empty', detail: 'None chosen' });
  else if (!personalAllowed)
    push({ ...t1, state: 'skipped', detail: 'An admin requires the team account for this profile' });
  else {
    const acc = lookup(accounts, profilePin, hide);
    if (acc.agentType && acc.agentType !== runAgentType)
      push({ ...t1, state: 'skipped', detail: `Pinned account is for ${AGENT_LABEL[acc.agentType]}; this run uses ${runLabel}` });
    else if (!acc.active) {
      push({ ...t1, state: 'halts', detail: `“${acc.label}” is paused` });
      outcome ??= { kind: 'halt', reason: `The account pinned to this profile is paused. SAM stops instead of switching to another account.` };
    } else {
      push({ ...t1, state: 'wins', detail: acc.label });
      outcome ??= { kind: 'account', label: acc.label, tier: 'profile', viaProxy: false };
    }
  }

  // Tier 2 — the profile's team account
  if (includeTeamTier) {
    const t2 = { tier: 'team' as const, title: 'Team account on this profile' };
    if (!team) push({ ...t2, state: 'empty', detail: 'Members use their own accounts' });
    else if (team.agentType !== runAgentType)
      push({ ...t2, state: 'skipped', detail: `Team account is for ${AGENT_LABEL[team.agentType]}; this run uses ${runLabel}` });
    else if (team.status === 'revoked') {
      push({ ...t2, state: 'halts', detail: `“${team.label}” was removed` });
      outcome ??= { kind: 'halt', reason: `${team.revokedNote ?? 'The team account was removed'}. An admin must choose another team account before this profile can run.` };
    } else {
      push({ ...t2, state: 'wins', detail: `${team.label} · through SAM’s proxy` });
      outcome ??= { kind: 'account', label: team.label, tier: 'team', viaProxy: true };
    }
  }

  // Tier 3 — personal project pin
  const projectPin = choices.projectPins[projectId]?.[runAgentType];
  const t3 = { tier: 'project' as const, title: 'Your account for this project' };
  if (!projectPin) push({ ...t3, state: 'empty', detail: 'None chosen' });
  else {
    const acc = lookup(accounts, projectPin, hide);
    if (!acc.active) {
      push({ ...t3, state: 'halts', detail: `“${acc.label}” is paused` });
      outcome ??= { kind: 'halt', reason: 'The account pinned to this project is paused.' };
    } else {
      push({ ...t3, state: 'wins', detail: acc.label });
      outcome ??= { kind: 'account', label: acc.label, tier: 'project', viaProxy: false };
    }
  }

  // Tier 4 — personal default (paused defaults are skipped, as today)
  const def = choices.defaults[runAgentType];
  const t4 = { tier: 'default' as const, title: `Your default ${runLabel} account` };
  if (!def) push({ ...t4, state: 'empty', detail: 'None connected' });
  else {
    const acc = lookup(accounts, def, hide);
    if (!acc.active) push({ ...t4, state: 'skipped', detail: `“${acc.label}” is paused` });
    else {
      push({ ...t4, state: 'wins', detail: acc.label });
      outcome ??= { kind: 'account', label: acc.label, tier: 'default', viaProxy: false };
    }
  }

  // Tier 5 — platform
  const t5 = { tier: 'platform' as const, title: 'SAM platform AI' };
  if (PLATFORM_AGENT_TYPES.includes(runAgentType)) {
    push({ ...t5, state: 'wins', detail: 'Billed to SAM usage' });
    outcome ??= { kind: 'account', label: 'SAM platform AI', tier: 'platform', viaProxy: true };
  } else push({ ...t5, state: 'empty', detail: `Not available for ${runLabel}` });

  return { runAgentType, steps, outcome: outcome ?? { kind: 'none' } };
}
