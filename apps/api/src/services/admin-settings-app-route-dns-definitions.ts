import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

/**
 * App-route DNS reconciliation (`services/app-route-dns-reconciliation.ts`). The sweep runs on
 * the 5-minute cron; throughput at these defaults is stated in that module's header.
 */
export const APP_ROUTE_DNS_RUNTIME_DEFAULTS = {
  sweepBudgetMs: 20000,
  sweepPageSize: 500,
  sweepMaxDeletes: 100,
} as const;

export type AppRouteDnsSettingName = `appRouteDns.${keyof typeof APP_ROUTE_DNS_RUNTIME_DEFAULTS}`;

export const APP_ROUTE_DNS_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'appRouteDns.sweepBudgetMs',
    APP_ROUTE_DNS_RUNTIME_DEFAULTS.sweepBudgetMs,
    'Operations',
    'DNS API deadline in milliseconds for one dangling app-route DNS sweep. Work left at the deadline resumes on the next sweep from a stored page cursor.',
    { min: 1000, max: 120000 }
  ),
  integerDefinition(
    'appRouteDns.sweepPageSize',
    APP_ROUTE_DNS_RUNTIME_DEFAULTS.sweepPageSize,
    'Operations',
    'App-route A records read per DNS list request by the dangling app-route DNS sweep.',
    { min: 1, max: 5000 }
  ),
  integerDefinition(
    'appRouteDns.sweepMaxDeletes',
    APP_ROUTE_DNS_RUNTIME_DEFAULTS.sweepMaxDeletes,
    'Operations',
    'Maximum dangling app-route DNS records deleted per sweep; the rest are deleted on later sweeps.',
    { min: 1, max: 5000 }
  ),
];
