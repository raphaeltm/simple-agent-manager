/**
 * Which of my accounts a profile's run uses, and why — the "Runs on X" line and
 * its breakdown in the profile editor.
 *
 * The answer comes from `explainResolution`
 * (`packages/shared/src/composable-credentials/resolver.ts`), the same function
 * the agent-key callback, admission and the AI proxy run, over the rows the API
 * lists. Tiers: profile pin → project pin → default → SAM platform.
 */
import {
  type CCConsumerRef,
  type CCProfileAttachmentItem,
  type CCResolutionStepReason,
  type CCResolutionStepState,
  type CCResolutionTier,
  type CCResolutionTrace,
  explainResolution,
} from '@simple-agent-manager/shared';

import { type AccountsSnapshot, type AccountView, OWNER, toComposition } from './account-model';

export interface ProfileAccountTarget {
  profileId: string;
  /** The profile's agent. */
  agentType: string;
  /** Null for a global profile: there is no project pin to consider. */
  projectId: string | null;
  /** The agent the run actually starts (a skill can switch it). Defaults to `agentType`. */
  runAgentType?: string;
}

export interface ExplainedStep {
  tier: CCResolutionTier;
  state: CCResolutionStepState;
  reason: CCResolutionStepReason | null;
  account: AccountView | null;
  /** For a skipped profile pin: the agent it was chosen for. */
  pinnedAgentType?: string;
}

export type ProfileAccountOutcome =
  | { kind: 'account'; account: AccountView; tier: 'profile' | 'project' | 'user' }
  | { kind: 'platform' }
  | {
      kind: 'halted';
      tier: CCResolutionTier;
      reason: CCResolutionStepReason | null;
      account: AccountView | null;
    }
  | { kind: 'none' };

export interface ProfileAccountExplanation {
  runAgentType: string;
  steps: ExplainedStep[];
  outcome: ProfileAccountOutcome;
  /** What the run would use without my profile pin ("my usual account"). */
  usual: ProfileAccountOutcome;
  /** My pin on this profile for the run's agent, if any. */
  pin: CCProfileAttachmentItem | null;
  /** Something is off: a pin skipped or stopped the run, or no account resolves. */
  needsAttention: boolean;
}

function consumerSnapshot(
  snapshot: AccountsSnapshot,
  agentType: string,
  profilePins: CCProfileAttachmentItem[]
) {
  const consumer: CCConsumerRef = { kind: 'agent', agentType };
  const credentialsById = new Map(snapshot.credentials.map((cred) => [cred.id, cred]));
  const configurations = snapshot.configurations.filter(
    (cfg) => cfg.consumerKind === 'agent' && cfg.consumerTarget === agentType
  );
  const attachments = snapshot.attachments.filter(
    (att) => att.consumerKind === 'agent' && att.consumerTarget === agentType
  );
  const resolution = snapshot.resolution.find(
    (status) => status.consumerKind === 'agent' && status.consumerId === agentType
  );
  return {
    consumer,
    composition: toComposition(
      consumer,
      configurations,
      attachments,
      credentialsById,
      resolution,
      profilePins
    ),
  };
}

function toOutcome(
  trace: CCResolutionTrace,
  accounts: Map<string, AccountView>
): ProfileAccountOutcome {
  if (trace.halted) {
    const step = trace.steps.find((candidate) => candidate.state === 'halted');
    return {
      kind: 'halted',
      tier: step?.tier ?? 'profile',
      reason: step?.reason ?? null,
      account: step?.configurationId ? (accounts.get(step.configurationId) ?? null) : null,
    };
  }
  const resolved = trace.resolved;
  if (!resolved) return { kind: 'none' };
  if (resolved.source === 'platform' || resolved.source === 'platform-proxy') {
    return { kind: 'platform' };
  }
  const account = resolved.configuration ? accounts.get(resolved.configuration.id) : undefined;
  if (!account) return { kind: 'platform' };
  const tier =
    resolved.source === 'profile-attachment'
      ? 'profile'
      : resolved.source === 'project-attachment'
        ? 'project'
        : 'user';
  return { kind: 'account', account, tier };
}

export function explainProfileAccount(
  snapshot: AccountsSnapshot,
  accounts: AccountView[],
  target: ProfileAccountTarget
): ProfileAccountExplanation {
  const runAgentType = target.runAgentType ?? target.agentType;
  const profilePins = snapshot.profilePins.filter((pin) => pin.agentProfileId === target.profileId);
  const accountsByConfiguration = new Map(
    accounts.map((account) => [account.configurationId, account])
  );
  const { consumer, composition } = consumerSnapshot(snapshot, runAgentType, profilePins);
  const projectId = target.projectId ?? undefined;
  const trace = explainResolution(composition, consumer, {
    userId: OWNER,
    projectId,
    profileId: target.profileId,
    profileAgentType: runAgentType,
  });
  const usualTrace = explainResolution(composition, consumer, { userId: OWNER, projectId });

  const steps = trace.steps.map((step): ExplainedStep => ({
    tier: step.tier,
    state: step.state,
    reason: step.reason,
    account: step.configurationId
      ? (accountsByConfiguration.get(step.configurationId) ?? null)
      : null,
    ...(step.pinnedAgentType ? { pinnedAgentType: step.pinnedAgentType } : {}),
  }));
  const outcome = toOutcome(trace, accountsByConfiguration);
  const profileStep = steps.find((step) => step.tier === 'profile');
  return {
    runAgentType,
    steps,
    outcome,
    usual: toOutcome(usualTrace, accountsByConfiguration),
    pin: profilePins.find((pin) => pin.consumerTarget === runAgentType) ?? null,
    needsAttention:
      outcome.kind === 'halted' || outcome.kind === 'none' || profileStep?.state === 'skipped',
  };
}

/** Short label for an outcome: the account's name, or what stands in for one. */
export function outcomeLabel(outcome: ProfileAccountOutcome): string {
  switch (outcome.kind) {
    case 'account':
      return outcome.account.label;
    case 'platform':
      return 'SAM’s platform account';
    case 'halted':
      return outcome.account ? `${outcome.account.label} (paused)` : 'a paused account';
    case 'none':
      return 'no account';
  }
}
