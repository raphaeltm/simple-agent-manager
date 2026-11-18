/**
 * Usage-limit mocks (`/api/credentials/limits`) shared by the profile audits and the
 * documentation screenshot specs that show how much of an account's usage is left.
 */
import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';

const MINUTE = 60_000;

/** Least to most severe, as the API orders a credential's overall level. */
const LEVEL_ORDER: CredentialLimitLevel[] = ['ok', 'warning', 'critical', 'rejected'];

/** Window length from its type: five-hour/primary windows are 300 minutes, weekly 10080. */
function windowMinutes(windowType: string): number | null {
  if (windowType.endsWith('five_hour') || windowType.endsWith('primary')) return 300;
  if (windowType.endsWith('seven_day') || windowType.endsWith('secondary')) return 10080;
  return null;
}

/** One limit window, sampled two minutes before `now`, resetting three hours after it. */
export function limitWindow(
  windowType: string,
  utilizationPercent: number,
  overrides: Partial<CredentialLimitWindowSummary> = {},
  now = Date.now()
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: windowType.startsWith('claude') ? 'anthropic' : 'openai',
    source: 'mock',
    status: 'allowed',
    level: 'ok',
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowMinutes(windowType),
    resetsAt: now + 180 * MINUTE,
    observedAt: now - 2 * MINUTE,
    updatedAt: now - 2 * MINUTE,
    ...overrides,
  };
}

/**
 * The limits of one stored credential (`cc_credentials:<id>`), as the API reports them: its
 * level is the most severe level among its windows.
 */
export function credentialUsage(
  credentialId: string,
  agentType: string,
  windows: CredentialLimitWindowSummary[]
): CredentialLimitCredentialSummary {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialName: null,
    credentialSource: 'user',
    provider: windows[0]!.provider,
    providerMode: 'oauth',
    agentType,
    level: windows.reduce<CredentialLimitLevel>(
      (worst, window) =>
        LEVEL_ORDER.indexOf(window.level) > LEVEL_ORDER.indexOf(worst) ? window.level : worst,
      'ok'
    ),
    observedAt: Math.max(...windows.map((window) => window.observedAt)),
    windows,
  };
}
