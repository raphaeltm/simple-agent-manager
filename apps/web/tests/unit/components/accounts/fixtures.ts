/**
 * Composable-credential rows for account UI tests. Each helper builds the rows
 * the real API returns, so tests feed the same shapes `useAccountsData` reads.
 */
import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';

import type {
  CCAttachmentListItem,
  CCConfigurationListItem,
  CCCredentialListItem,
} from '../../../../src/lib/api';

const STAMP = '2026-10-01T00:00:00.000Z';

export interface AccountRows {
  credentials: CCCredentialListItem[];
  configurations: CCConfigurationListItem[];
  attachments: CCAttachmentListItem[];
}

export interface AccountSpec {
  id: string;
  name: string;
  kind: 'agent' | 'compute';
  target: string;
  credentialKind?: string;
  createdAt?: string;
  credentialActive?: boolean;
  configurationActive?: boolean;
  /** Attach as the user default (projectId null). */
  isDefault?: boolean;
  /** Project ids pinned to this account; `{ id, active: false }` pauses the pin. */
  pins?: Array<string | { id: string; active: boolean }>;
}

/** One account = one credential + one configuration + its attachments. */
export function accountRows(spec: AccountSpec): AccountRows {
  const createdAt = spec.createdAt ?? STAMP;
  const configurationId = `cfg-${spec.id}`;
  const attachments: CCAttachmentListItem[] = [];
  if (spec.isDefault) {
    attachments.push({
      id: `att-${spec.id}-default`,
      configurationId,
      consumerKind: spec.kind,
      consumerTarget: spec.target,
      projectId: null,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    });
  }
  for (const pin of spec.pins ?? []) {
    const { id, active } = typeof pin === 'string' ? { id: pin, active: true } : pin;
    attachments.push({
      id: `att-${spec.id}-${id}`,
      configurationId,
      consumerKind: spec.kind,
      consumerTarget: spec.target,
      projectId: id,
      isActive: active,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return {
    credentials: [
      {
        id: `cred-${spec.id}`,
        name: spec.name,
        kind: spec.credentialKind ?? (spec.kind === 'agent' ? 'api-key' : 'cloud-provider'),
        isActive: spec.credentialActive ?? true,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    configurations: [
      {
        id: configurationId,
        name: spec.name,
        consumerKind: spec.kind,
        consumerTarget: spec.target,
        credentialId: `cred-${spec.id}`,
        settingsJson: null,
        isActive: spec.configurationActive ?? true,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    attachments,
  };
}

export function mergeRows(...rows: AccountRows[]): AccountRows {
  return {
    credentials: rows.flatMap((row) => row.credentials),
    configurations: rows.flatMap((row) => row.configurations),
    attachments: rows.flatMap((row) => row.attachments),
  };
}

export function resolutionStatus(
  overrides: Partial<CCConsumerResolutionStatus> &
    Pick<CCConsumerResolutionStatus, 'consumerId' | 'consumerKind' | 'source'>
): CCConsumerResolutionStatus {
  return {
    consumerName: overrides.consumerId,
    credentialName: null,
    halted: false,
    ...overrides,
  };
}

export const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
  { id: 'p-client', name: 'Acme client portal' },
  { id: 'p-labs', name: 'Labs' },
];
