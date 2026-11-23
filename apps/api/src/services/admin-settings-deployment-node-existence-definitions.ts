import {
  type AdminSettingDefinition,
  integerDefinition,
  switchDefinition,
} from './admin-setting-definitions';

/**
 * Provider-existence reconciliation of running deployment nodes
 * (`services/deployment-node-provider-existence.ts`). Throughput at these defaults is stated in
 * that module's header.
 */
export const DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS = {
  enabled: true,
  checkIntervalSeconds: 900,
  confirmIntervalSeconds: 600,
  sweepBudgetMs: 20000,
  maxProbesPerSweep: 50,
  requestTimeoutMs: 5000,
} as const;

export type DeploymentNodeExistenceSettingName =
  `deploymentNodeExistence.${keyof typeof DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS}`;

export const DEPLOYMENT_NODE_EXISTENCE_SETTINGS: readonly AdminSettingDefinition[] = [
  switchDefinition(
    'deploymentNodeExistence.enabled',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.enabled,
    'Operations',
    'Check that each running app deployment server still exists at its cloud provider, and release a server the provider has deleted (with its app DNS records) after two confirmed "not found" answers.',
    // Fail closed: when the settings store cannot be read, release nothing.
    { unavailableValue: false }
  ),
  integerDefinition(
    'deploymentNodeExistence.checkIntervalSeconds',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.checkIntervalSeconds,
    'Operations',
    'Seconds between provider-existence checks of one running deployment server.',
    { min: 300, max: 86400 }
  ),
  integerDefinition(
    'deploymentNodeExistence.confirmIntervalSeconds',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.confirmIntervalSeconds,
    'Operations',
    'Minimum seconds between the first provider "not found" for a deployment server and the second one that releases it. A first "not found" more than three intervals old starts over.',
    { min: 300, max: 86400 }
  ),
  integerDefinition(
    'deploymentNodeExistence.sweepBudgetMs',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.sweepBudgetMs,
    'Operations',
    'Deadline in milliseconds for one provider-existence sweep. Servers not reached are checked on the next sweep.',
    { min: 1000, max: 120000 }
  ),
  integerDefinition(
    'deploymentNodeExistence.maxProbesPerSweep',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.maxProbesPerSweep,
    'Operations',
    "Maximum deployment servers one provider-existence sweep looks up. Bounds provider API use per 5-minute cron tick; each one also costs about two database queries, inside the cron invocation's query limit.",
    { min: 1, max: 200 }
  ),
  integerDefinition(
    'deploymentNodeExistence.requestTimeoutMs',
    DEPLOYMENT_NODE_EXISTENCE_RUNTIME_DEFAULTS.requestTimeoutMs,
    'Operations',
    'Timeout in milliseconds for one provider lookup. A lookup that times out never counts as "not found".',
    { min: 500, max: 30000 }
  ),
];
