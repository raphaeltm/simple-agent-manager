import { type GcpApiScope, pollGcpOperation } from './gcp-api';
import {
  SAM_AGENT_FIREWALL_RULE_NAME,
  SAM_APP_ROUTE_FIREWALL_RULE_NAME,
  SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
  SAM_NETWORK_TAG,
} from './gcp-metadata';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import { parseProviderJson, validateGcpOperation } from './validation';

export interface GcpFirewallConfig {
  readonly agentSourceRanges: readonly string[];
  readonly agentPorts: readonly string[];
  readonly appRouteSourceRanges: readonly string[];
  readonly appRoutePorts: readonly string[];
}

/**
 * Ensure firewall rules for both Cloudflare-routed VM-agent traffic and
 * direct public app-route traffic served by Caddy.
 */
export async function ensureGcpFirewallRules(
  scope: GcpApiScope,
  config: GcpFirewallConfig,
  context?: ProviderRequestContext
): Promise<void> {
  await ensureFirewallRule(
    scope,
    SAM_AGENT_FIREWALL_RULE_NAME,
    config.agentPorts,
    config.agentSourceRanges,
    'Allow configured inbound access to SAM VM agent (managed by Simple Agent Manager)',
    SAM_NETWORK_TAG,
    context
  );
  throwIfProviderRequestAborted(context);
  await ensureFirewallRule(
    scope,
    SAM_APP_ROUTE_FIREWALL_RULE_NAME,
    config.appRoutePorts,
    config.appRouteSourceRanges,
    'Allow public HTTP/HTTPS access to SAM deployment app routes (managed by Simple Agent Manager)',
    SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
    context
  );
}

async function ensureFirewallRule(
  scope: GcpApiScope,
  name: string,
  ports: readonly string[],
  sourceRanges: readonly string[],
  description: string,
  targetTag: string,
  context?: ProviderRequestContext
): Promise<void> {
  throwIfProviderRequestAborted(context);
  const headers = await scope.authHeaders(context);
  const url = `${scope.projectUrl}/global/firewalls`;

  try {
    const res = await providerFetch(
      'gcp',
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(
          buildFirewallRuleBody(scope, name, ports, sourceRanges, description, targetTag)
        ),
      },
      scope.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const op = validateGcpOperation(
      await parseProviderJson(res, 'gcp', 'ensureFirewallRule'),
      'ensureFirewallRule',
      { requireName: true }
    );
    throwIfProviderRequestAborted(context);
    // Firewall operations are global, poll via global operations endpoint
    await pollGcpOperation(
      scope,
      `${scope.projectUrl}/global/operations/${op.name}`,
      { validationContext: 'pollGlobalOperation', timeoutSubject: 'GCP global operation' },
      context
    );
  } catch (err) {
    rethrowIfProviderRequestAborted(err, context);
    // 409 = already exists — that's fine
    if (err instanceof ProviderError && err.statusCode === 409) return;
    throw err;
  }
}

function buildFirewallRuleBody(
  scope: GcpApiScope,
  name: string,
  ports: readonly string[],
  sourceRanges: readonly string[],
  description: string,
  targetTag: string
) {
  return {
    name,
    network: `${scope.projectUrl}/global/networks/default`,
    direction: 'INGRESS',
    priority: 1000,
    targetTags: [targetTag],
    allowed: [{ IPProtocol: 'tcp', ports: [...ports] }],
    sourceRanges: [...sourceRanges],
    description,
  };
}
