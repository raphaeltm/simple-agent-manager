/**
 * Pure mapping from the composable-credential primitives to the "accounts" the
 * settings UI shows: which accounts exist, which one is the default, which
 * projects pin one, and which are connected but unused.
 *
 * Project resolution mirrors `resolveEnvironment` in
 * `packages/shared/src/composable-credentials/resolver.ts`, the function the
 * runtime uses:
 *   1. a project-scoped attachment wins; an inactive one, or one whose
 *      configuration/credential is inactive, BLOCKS the project (no fallback);
 *   2. otherwise the first active user-scoped attachment (the default);
 *   3. otherwise the platform, when the resolution status reports one.
 * Keep the two in step: a coverage bar that disagrees with the resolver tells a
 * user the wrong account will be billed.
 */
import type {
  CCConsumerResolutionStatus,
  CredentialLimitCredentialSummary,
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
  const platformFallback =
    resolution?.source === 'platform' || resolution?.source === 'platform-proxy';
  const resolutions = new Map<string, ProjectResolution>();
  for (const project of snapshot.projects) {
    resolutions.set(
      project.id,
      resolveProject(
        project.id,
        attachments,
        configurations,
        accounts,
        defaultAccount,
        platformFallback
      )
    );
  }

  return {
    provider,
    accounts,
    defaultAccount,
    platformFallback,
    resolutions,
    segments: buildSegments(snapshot.projects, resolutions),
  };
}

function resolveProject(
  projectId: string,
  attachments: CCAttachmentListItem[],
  configurations: CCConfigurationListItem[],
  accounts: AccountView[],
  defaultAccount: AccountView | null,
  platformFallback: boolean
): ProjectResolution {
  const pin = attachments.find((att) => att.projectId === projectId);
  if (pin) {
    // Same checks, in the same order, as the resolver's `materialize`: anything
    // that fails stops the chain for this project.
    const account =
      accounts.find((candidate) => candidate.configurationId === pin.configurationId) ?? null;
    if (!pin.isActive) return { source: 'blocked', account, reason: 'paused' };
    const configuration = configurations.find((cfg) => cfg.id === pin.configurationId);
    if (!configuration?.isActive) return { source: 'blocked', account, reason: 'inactive' };
    if (configuration.credentialId === null) return { source: 'platform' }; // platform binding
    if (!account?.active) return { source: 'blocked', account, reason: 'inactive' };
    return { source: 'pinned', account };
  }
  if (defaultAccount?.active) return { source: 'default', account: defaultAccount };
  return platformFallback ? { source: 'platform' } : { source: 'none' };
}

function buildSegments(
  projects: AccountProject[],
  resolutions: Map<string, ProjectResolution>
): CoverageSegment[] {
  const byKey = new Map<string, CoverageSegment>();
  for (const project of projects) {
    const resolution = resolutions.get(project.id);
    if (!resolution) continue;
    const seed = segmentSeed(resolution);
    const existing = byKey.get(seed.key);
    if (existing) existing.projectIds.push(project.id);
    else byKey.set(seed.key, { ...seed, projectIds: [project.id] });
  }
  const order: CoverageSegment['role'][] = ['default', 'pinned', 'blocked', 'platform', 'none'];
  return [...byKey.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

function segmentSeed(resolution: ProjectResolution): Omit<CoverageSegment, 'projectIds'> {
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
        label: 'Blocked',
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
        label: 'No account',
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
