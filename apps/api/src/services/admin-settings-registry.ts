import type { AdminSettingDefinition } from './admin-setting-definitions';
import { CORE_SETTINGS } from './admin-settings-core-definitions';
import { DEPLOYMENT_PUBLISH_SETTINGS } from './admin-settings-deployment-publish-definitions';
import { FEATURE_SETTINGS } from './admin-settings-features-definitions';
import { GCP_CATALOG_SETTINGS } from './admin-settings-gcp-catalog-definitions';
import { LIFECYCLE_LATENCY_SETTINGS } from './admin-settings-lifecycle-latency-definitions';
import { NODE_TUNNEL_SETTINGS } from './admin-settings-node-tunnel-definitions';
import { OPERATIONS_TELEMETRY_SETTINGS } from './admin-settings-operations-telemetry-definitions';
import { OPERATOR_SETTINGS } from './admin-settings-operator-definitions';
import { OUTBOUND_SETTINGS } from './admin-settings-outbound-definitions';
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
  ...DEPLOYMENT_PUBLISH_SETTINGS,
  ...CORE_SETTINGS,
  ...NODE_TUNNEL_SETTINGS,
  ...FEATURE_SETTINGS,
  ...GCP_CATALOG_SETTINGS,
  ...OPERATOR_SETTINGS,
  ...LIFECYCLE_LATENCY_SETTINGS,
  ...OPERATIONS_TELEMETRY_SETTINGS,
  ...OUTBOUND_SETTINGS,
  ...llmEndpointSettingDefinitions(),
  ...AI_PROXY_SETTINGS,
];

export const ADMIN_SETTINGS_REGISTRY: readonly AdminSettingDefinition[] = Object.freeze(
  definitions.map((definition) =>
    Object.freeze({
      ...definition,
      ...(definition.range ? { range: Object.freeze(definition.range) } : {}),
      ...(definition.choices ? { choices: Object.freeze(definition.choices) } : {}),
      ...(definition.credential ? { credential: Object.freeze(definition.credential) } : {}),
    })
  )
);

/** Never resolve untrusted names through inherited object properties. */
export function findAdminSetting(name: string): AdminSettingDefinition | undefined {
  return ADMIN_SETTINGS_REGISTRY.find((definition) => definition.name === name);
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
