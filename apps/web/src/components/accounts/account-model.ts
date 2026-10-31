/**
 * Pure mapping from the composable-credential primitives to the "accounts" the
 * settings UI shows: which accounts exist, which one is the default, which
 * projects pin one, and which are connected but unused.
 *
 * Which account a project uses is answered by `resolveEnvironment`
 * (`packages/shared/src/composable-credentials/resolver.ts`), the same function
 * the runtime uses, run over the rows the API lists:
 *   1. a project-scoped attachment wins; an inactive one, or one whose
 *      configuration/credential is inactive, BLOCKS the project (no fallback);
 *   2. otherwise the first active user-scoped attachment (the default);
 *   3. otherwise the platform, when the resolution status reports one.
 */
import {
  type CCCompositionSnapshot,
  type CCConsumerRef,
  type CCConsumerResolutionStatus,
  type CCResolvedEnvironment,
  type CredentialLimitCredentialSummary,
  resolveEnvironment,
} from '@simple-agent-manager/shared';

import type {
  CCAttachmentListItem,
  CCConfigurationListItem,
  CCCredentialListItem,
} from '../../lib/api';
import {
  type AccountKind,
  type AccountProvider,
  accountProvidersOfKind,
  accountSwatch,
} from './provider-meta';

export type AccountRole = 'default' | 'pinned' | 'unattached';

export interface AccountView {
  /** Configuration id — one account per consumer binding. */
  id: string;
  configurationId: string;
  credentialId: string;
  kind: AccountKind;
  /** Agent type or cloud provider id. */
  target: string;
  label: string;
  credentialKind: string;
  createdAt: string;
  /** Both the configuration and the credential are active. */
  active: boolean;
  role: AccountRole;
  /** Projects pinned to this account with an active attachment. */
  pinnedProjectIds: string[];
  /** Projects whose pin to this account is paused (blocks the project). */
  pausedProjectIds: string[];
  swatch: string;
  usage: CredentialLimitCredentialSummary | null;
  /** Format validation reported by the resolver for the default account. */
  validation: CCConsumerResolutionStatus['validation'] | null;
}

export interface AccountProject {
  id: string;
  name: string;
}

export type ProjectResolution =
  | { source: 'pinned'; account: AccountView }
  | { source: 'blocked'; account: AccountView | null; reason: 'paused' | 'inactive' }
  | { source: 'default'; account: AccountView }
  | { source: 'platform' }
  | { source: 'none' };

export interface CoverageSegment {
  key: string;
  label: string;
  role: 'default' | 'pinned' | 'blocked' | 'platform' | 'none';
  color: string;
  projectIds: string[];
}

export interface ProviderAccounts {
  provider: AccountProvider;
  accounts: AccountView[];
  defaultAccount: AccountView | null;
  /** True when the resolver falls back to a SAM platform credential or proxy. */
  platformFallback: boolean;
  resolutions: Map<string, ProjectResolution>;
  segments: CoverageSegment[];
}

export interface AccountsSnapshot {
  credentials: CCCredentialListItem[];
  configurations: CCConfigurationListItem[];
  attachments: CCAttachmentListItem[];
  projects: AccountProject[];
  resolution: CCConsumerResolutionStatus[];
  limits: CredentialLimitCredentialSummary[];
}

export interface AccountsModel {
  agents: ProviderAccounts[];
  clouds: ProviderAccounts[];
  /** Credentials no configuration points at — only manageable in Advanced. */
  unlinkedCredentialCount: number;
}

const ROLE_ORDER: Record<AccountRole, number> = { default: 0, pinned: 1, unattached: 2 };

function isKind(value: string): value is AccountKind {
  return value === 'agent' || value === 'compute';
}

function buildProvider(
  provider: AccountProvider,
  snapshot: AccountsSnapshot,
  credentialsById: Map<string, CCCredentialListItem>
): ProviderAccounts {
  const configurations = snapshot.configurations.filter(
    (cfg) => cfg.consumerKind === provider.kind && cfg.consumerTarget === provider.id
  );
  const attachments = snapshot.attachments.filter(
    (att) => att.consumerKind === provider.kind && att.consumerTarget === provider.id
  );
  const defaultAttachment = attachments.find((att) => att.projectId === null && att.isActive);
  const resolution = snapshot.resolution.find(
    (status) => status.consumerKind === provider.kind && status.consumerId === provider.id
  );

  const unsorted: AccountView[] = [];
  for (const cfg of configurations) {
    if (!cfg.credentialId) continue; // platform/proxy bindings are not user accounts
    const credential = credentialsById.get(cfg.credentialId);
    if (!credential) continue;
    const projectAttachments = attachments.filter(
      (att) => att.configurationId === cfg.id && att.projectId !== null
    );
    const isDefault = defaultAttachment?.configurationId === cfg.id;
    const pinnedProjectIds = projectAttachments
      .filter((att) => att.isActive)
      .map((att) => att.projectId as string);
    const pausedProjectIds = projectAttachments
      .filter((att) => !att.isActive)
      .map((att) => att.projectId as string);
    let role: AccountRole = 'unattached';
    if (isDefault) role = 'default';
    else if (projectAttachments.length > 0) role = 'pinned';
    unsorted.push({
      id: cfg.id,
      configurationId: cfg.id,
      credentialId: credential.id,
      kind: provider.kind,
      target: provider.id,
      label: credential.name,
      credentialKind: credential.kind,
      createdAt: credential.createdAt,
      active: cfg.isActive && credential.isActive,
      role,
      pinnedProjectIds,
      pausedProjectIds,
      swatch: '',
      usage: snapshot.limits.find((limit) => limit.credentialId === credential.id) ?? null,
      validation:
        isDefault && resolution?.source === 'user-attachment'
          ? (resolution.validation ?? null)
          : null,
    });
  }

  const accounts = unsorted
    .sort((a, b) => {
      const byRole = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      if (byRole !== 0) return byRole;
      const byPins = b.pinnedProjectIds.length - a.pinnedProjectIds.length;
      if (byPins !== 0) return byPins;
      return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    })
    .map((account, index) => ({ ...account, swatch: accountSwatch(provider.hue, index) }));

  const defaultAccount = accounts.find((account) => account.role === 'default') ?? null;
  const consumer: CCConsumerRef =
    provider.kind === 'agent'
      ? { kind: 'agent', agentType: provider.id }
      : { kind: 'compute', provider: provider.id };
  const composition = toComposition(
    consumer,
    configurations,
    attachments,
    credentialsById,
    resolution
  );
  const accountsByConfiguration = new Map(
    accounts.map((account) => [account.configurationId, account])
  );
  const userLevel = resolveEnvironment(composition, consumer, { userId: OWNER });
  const platformFallback = userLevel !== null && isPlatformManaged(userLevel);
  const resolutions = new Map<string, ProjectResolution>();
  for (const project of snapshot.projects) {
    const resolved = resolveEnvironment(composition, consumer, {
      userId: OWNER,
      projectId: project.id,
    });
    const pin = attachments.find((att) => att.projectId === project.id);
    resolutions.set(project.id, toResolution(resolved, pin, accountsByConfiguration));
  }

  return {
    provider,
    accounts,
    defaultAccount,
    platformFallback,
    resolutions,
    segments: buildSegments(provider.kind, snapshot.projects, resolutions),
  };
}

/** Every listed row belongs to the caller, so one stand-in owner id is exact. */
const OWNER = 'me';

/**
 * The listed rows as the snapshot `resolveEnvironment` reads. Resolution looks
 * only at ids and active flags; secrets never reach the browser, so each
 * credential carries an empty placeholder. The platform default comes from the
 * resolution status, which the API computes with the platform rows it can see.
 */
function toComposition(
  consumer: CCConsumerRef,
  configurations: CCConfigurationListItem[],
  attachments: CCAttachmentListItem[],
  credentialsById: Map<string, CCCredentialListItem>,
  resolution: CCConsumerResolutionStatus | undefined
): CCCompositionSnapshot {
  const placeholder = (id: string, isActive: boolean) => ({
    id,
    ownerId: OWNER,
    name: id,
    kind: 'api-key' as const,
    secret: { kind: 'api-key' as const, apiKey: '' },
    isActive,
  });
  const platform: CCCompositionSnapshot['platform'] = {};
  const key =
    consumer.kind === 'agent' ? `agent:${consumer.agentType}` : `compute:${consumer.provider}`;
  if (resolution?.source === 'platform-proxy') platform[key] = { mode: 'proxy' };
  if (resolution?.source === 'platform') {
    platform[key] = { mode: 'credential', credential: placeholder('platform', true) };
  }
  return {
    credentials: configurations
      .map((cfg) => (cfg.credentialId ? credentialsById.get(cfg.credentialId) : undefined))
      .filter((cred): cred is CCCredentialListItem => Boolean(cred))
      .map((cred) => placeholder(cred.id, cred.isActive)),
    configurations: configurations.map((cfg) => ({
      id: cfg.id,
      ownerId: OWNER,
      name: cfg.name,
      consumer,
      credentialId: cfg.credentialId,
      settings: {},
      isActive: cfg.isActive,
    })),
    attachments: attachments.map((att) => ({
      id: att.id,
      configurationId: att.configurationId,
      consumer,
      target:
        att.projectId === null
          ? { scope: 'user' as const, userId: OWNER }
          : { scope: 'project' as const, userId: OWNER, projectId: att.projectId },
      isActive: att.isActive,
    })),
    platform,
  };
}

/** Resolved, but to SAM's platform credential or proxy rather than one of yours. */
function isPlatformManaged(resolved: CCResolvedEnvironment): boolean {
  return (
    resolved.source === 'platform' ||
    resolved.source === 'platform-proxy' ||
    resolved.credential === null
  );
}

function toResolution(
  resolved: CCResolvedEnvironment | null,
  pin: CCAttachmentListItem | undefined,
  accountsByConfiguration: Map<string, AccountView>
): ProjectResolution {
  if (resolved === null) {
    // Nothing resolved: a pin that exists stopped the chain, else nothing was set.
    if (!pin) return { source: 'none' };
    return {
      source: 'blocked',
      account: accountsByConfiguration.get(pin.configurationId) ?? null,
      reason: pin.isActive ? 'inactive' : 'paused',
    };
  }
  if (isPlatformManaged(resolved)) return { source: 'platform' };
  const account = resolved.configuration && accountsByConfiguration.get(resolved.configuration.id);
  if (!account) return { source: 'platform' };
  return resolved.source === 'project-attachment'
    ? { source: 'pinned', account }
    : { source: 'default', account };
}

function buildSegments(
  kind: AccountKind,
  projects: AccountProject[],
  resolutions: Map<string, ProjectResolution>
): CoverageSegment[] {
  const byKey = new Map<string, CoverageSegment>();
  for (const project of projects) {
    const resolution = resolutions.get(project.id);
    if (!resolution) continue;
    const seed = segmentSeed(kind, resolution);
    const existing = byKey.get(seed.key);
    if (existing) existing.projectIds.push(project.id);
    else byKey.set(seed.key, { ...seed, projectIds: [project.id] });
  }
  const order: CoverageSegment['role'][] = ['default', 'pinned', 'blocked', 'platform', 'none'];
  return [...byKey.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

function segmentSeed(
  kind: AccountKind,
  resolution: ProjectResolution
): Omit<CoverageSegment, 'projectIds'> {
  switch (resolution.source) {
    case 'default':
      return {
        key: resolution.account.id,
        label: resolution.account.label,
        role: 'default',
        color: resolution.account.swatch,
      };
    case 'pinned':
      return {
        key: resolution.account.id,
        label: resolution.account.label,
        role: 'pinned',
        color: resolution.account.swatch,
      };
    case 'blocked':
      return {
        key: 'blocked',
        label: 'Paused pin',
        role: 'blocked',
        color: 'var(--sam-color-danger)',
      };
    case 'platform':
      return {
        key: 'platform',
        label: 'SAM platform',
        role: 'platform',
        color: 'var(--sam-color-fg-muted)',
      };
    case 'none':
      return {
        key: 'none',
        // A project needs one cloud, not every cloud: no account here is normal.
        label: kind === 'compute' ? 'Not used' : 'No account',
        role: 'none',
        color: 'var(--sam-color-border-default)',
      };
  }
}

export function buildAccountsModel(snapshot: AccountsSnapshot): AccountsModel {
  const credentialsById = new Map(snapshot.credentials.map((cred) => [cred.id, cred]));
  const linked = new Set(
    snapshot.configurations
      .filter((cfg) => isKind(cfg.consumerKind))
      .map((cfg) => cfg.credentialId)
      .filter((id): id is string => Boolean(id))
  );
  return {
    agents: accountProvidersOfKind('agent').map((provider) =>
      buildProvider(provider, snapshot, credentialsById)
    ),
    clouds: accountProvidersOfKind('compute').map((provider) =>
      buildProvider(provider, snapshot, credentialsById)
    ),
    unlinkedCredentialCount: snapshot.credentials.filter((cred) => !linked.has(cred.id)).length,
  };
}

/** Projects that resolve to an account (default or pinned) for this provider. */
export function coveredProjectCount(group: ProviderAccounts, accountId: string): number {
  return group.segments.find((segment) => segment.key === accountId)?.projectIds.length ?? 0;
}

/** A provider row is worth showing when it has accounts or SAM covers it. */
export function isProviderInUse(group: ProviderAccounts): boolean {
  return group.accounts.length > 0 || group.platformFallback;
}

/** What a project falls back to once its pin is removed. */
export type DefaultFallback =
  { kind: 'default'; label: string } | { kind: 'platform' } | { kind: 'none' };

export function defaultFallback(group: ProviderAccounts): DefaultFallback {
  if (group.defaultAccount?.active) return { kind: 'default', label: group.defaultAccount.label };
  return group.platformFallback ? { kind: 'platform' } : { kind: 'none' };
}

/** The confirmation copy for moving one project off its pinned account. */
export function describeUnpin(
  projectName: string,
  accountLabel: string,
  providerName: string,
  fallback: DefaultFallback
): string {
  const lead = `${projectName} will stop using ${accountLabel}`;
  switch (fallback.kind) {
    case 'default':
      return `${lead} and use your default ${providerName} account, ${fallback.label}.`;
    case 'platform':
      return `${lead} and use SAM’s platform ${providerName} account.`;
    case 'none':
      return `${lead} and have no ${providerName} account until you connect one.`;
  }
}
