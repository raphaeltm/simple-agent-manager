import type { AdminSettingDefinition } from './admin-setting-definitions';
import { ACCOUNT_LINKING_SETTINGS } from './admin-settings-account-linking-definitions';
import { CORE_SETTINGS } from './admin-settings-core-definitions';
import { DEPLOYMENT_PUBLISH_SETTINGS } from './admin-settings-deployment-publish-definitions';
import { FEATURE_SETTINGS } from './admin-settings-features-definitions';
import { GCP_CATALOG_SETTINGS } from './admin-settings-gcp-catalog-definitions';
import { INFOMANIAK_SETTINGS } from './admin-settings-infomaniak-definitions';
import { INSTRUCTION_BUDGET_SETTINGS } from './admin-settings-instructions-definitions';
import { LIFECYCLE_LATENCY_SETTINGS } from './admin-settings-lifecycle-latency-definitions';
import { MESSAGE_MERGE_SETTINGS } from './admin-settings-message-merge-definitions';
import { NODE_TUNNEL_SETTINGS } from './admin-settings-node-tunnel-definitions';
import { OPERATIONS_TELEMETRY_SETTINGS } from './admin-settings-operations-telemetry-definitions';
import { OPERATOR_SETTINGS } from './admin-settings-operator-definitions';
import { ORCHESTRATOR_SETTINGS } from './admin-settings-orchestrator-definitions';
import { OUTBOUND_SETTINGS } from './admin-settings-outbound-definitions';
import { OVERVIEW_BRIEF_SETTINGS } from './admin-settings-overview-brief-definitions';
import { PROJECT_EVENT_SETTINGS } from './admin-settings-project-event-definitions';
import { AI_PROXY_SETTINGS } from './ai-proxy-settings';
import { llmEndpointSettingDefinitions } from './llm-endpoint-settings';
export {
  type AdminSettingDefinition,
  type AdminSettingName,
  type AdminSettingType,
  type AdminSettingValue,
  DEFAULT_COMMENT_CONTEXT_MAX_ROWS,
  DEFAULT_COMMENT_CONTEXT_MESSAGES,
  DEFAULT_COMMENT_MENTIONS_MAX,
  DEFAULT_PROFILE_PIN_CANDIDATE_LIMIT,
  DEFAULT_PROFILE_USAGE_WINDOW_DAYS,
  DEFAULT_SESSION_ACCESS_MAX_GRANTS,
  IDEA_UPDATE_DEFAULTS,
  MAX_SAM_OPERATOR_EVENT_PAGE_SIZE,
  OPERATOR_DEFAULTS,
} from './admin-setting-definitions';
const definitions = [
  ...ACCOUNT_LINKING_SETTINGS,
  ...llmEndpointSettingDefinitions(),
  ...AI_PROXY_SETTINGS,
  ...MESSAGE_MERGE_SETTINGS,
  ...PROJECT_EVENT_SETTINGS,
  ...DEPLOYMENT_PUBLISH_SETTINGS,
  ...CORE_SETTINGS,
  ...NODE_TUNNEL_SETTINGS,
  ...FEATURE_SETTINGS,
  ...GCP_CATALOG_SETTINGS,
  ...INFOMANIAK_SETTINGS,
  ...OPERATOR_SETTINGS,
  ...ORCHESTRATOR_SETTINGS,
  ...LIFECYCLE_LATENCY_SETTINGS,
  ...OPERATIONS_TELEMETRY_SETTINGS,
  ...OUTBOUND_SETTINGS,
  ...INSTRUCTION_BUDGET_SETTINGS,
  ...OVERVIEW_BRIEF_SETTINGS,
];

function frozenDefinition(definition: AdminSettingDefinition): AdminSettingDefinition {
  return Object.freeze({
    ...definition,
    ...(definition.range ? { range: Object.freeze(definition.range) } : {}),
    ...(definition.choices ? { choices: Object.freeze(definition.choices) } : {}),
    ...(definition.credential ? { credential: Object.freeze(definition.credential) } : {}),
  });
}

/** Settings every build has. */
export const ADMIN_SETTINGS_REGISTRY: readonly AdminSettingDefinition[] = Object.freeze(
  definitions.map(frozenDefinition)
);

let registry: readonly AdminSettingDefinition[] = ADMIN_SETTINGS_REGISTRY;
let installed = new WeakSet<AdminSettingDefinition>();

/**
 * Adds settings only a separately built entry has (the self-host build's speech endpoints,
 * selfhost/speech/). Called once at entry initialization, before any request. The Cloudflare
 * Worker installs nothing, so its registry is exactly `ADMIN_SETTINGS_REGISTRY`. Installing the
 * same definition objects again is a no-op; a name that is already registered otherwise throws.
 */
export function installAdminSettingDefinitions(added: readonly AdminSettingDefinition[]): void {
  const fresh = added.filter((definition) => !installed.has(definition));
  const names = new Set(registry.map((definition) => definition.name));
  for (const definition of fresh) {
    if (names.has(definition.name)) {
      throw new Error(`Admin setting ${definition.name} is already registered`);
    }
    names.add(definition.name);
  }
  for (const definition of fresh) installed.add(definition);
  registry = Object.freeze([...registry, ...fresh.map(frozenDefinition)]);
}

/** Test seam: back to the settings every build has. */
export function resetInstalledAdminSettingDefinitionsForTests(): void {
  registry = ADMIN_SETTINGS_REGISTRY;
  installed = new WeakSet();
}

/** Every setting this build has: the shared registry plus any installed by the build's entry. */
export function adminSettingsRegistry(): readonly AdminSettingDefinition[] {
  return registry;
}

/** Never resolve untrusted names through inherited object properties. */
export function findAdminSetting(name: string): AdminSettingDefinition | undefined {
  return registry.find((definition) => definition.name === name);
}

/** Metadata only. Secret effective values must be separately projected to configured/source. */
export function publicAdminSettingDefinition(definition: AdminSettingDefinition) {
  return {
    name: definition.name,
    type: definition.type,
    defaultValue: definition.defaultValue,
    category: definition.category,
    description: definition.description,
    secret: definition.secret,
    risky: definition.risky,
    range: definition.range,
    choices: definition.choices,
  };
}
