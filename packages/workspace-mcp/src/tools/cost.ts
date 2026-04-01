/**
 * Cost & Resource Awareness tools.
 *
 * - check_cost_estimate: VM hourly rate, runtime, estimated total
 * - get_remaining_budget: remaining project cost budget if configured
 */

import * as fs from 'node:fs/promises';

import type { ApiClient } from '../api-client.js';
import type { WorkspaceMcpConfig } from '../config.js';

/** VM size pricing in USD/hour. Configurable via SAM_VM_PRICING_JSON env var. */
function getVmPricing(): Record<string, number> {
  const envPricing = process.env['SAM_VM_PRICING_JSON'];
  if (envPricing) {
    try {
      return JSON.parse(envPricing) as Record<string, number>;
    } catch {
      // Fall through to defaults
    }
  }
  // Default pricing (Hetzner approximate rates)
  return {
    small: 0.007,
    medium: 0.017,
    large: 0.033,
    'x-large': 0.065,
  };
}

export async function checkCostEstimate(
  _config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  // Get VM size from env
  const vmSize = process.env['SAM_VM_SIZE'] ?? 'unknown';

  // Get uptime from /proc/uptime
  let uptimeSeconds = 0;
  try {
    const content = await fs.readFile('/proc/uptime', 'utf-8');
    const match = content.match(/^([\d.]+)/);
    if (match?.[1]) {
      uptimeSeconds = Math.floor(parseFloat(match[1]));
    }
  } catch {
    // Not available
  }

  const uptimeHours = uptimeSeconds / 3600;
  const pricing = getVmPricing();
  const hourlyRate = pricing[vmSize] ?? null;
  const estimatedCost = hourlyRate !== null ? hourlyRate * uptimeHours : null;

  return {
    vmSize,
    hourlyRate,
    uptimeSeconds,
    uptimeFormatted: formatDuration(uptimeSeconds),
    estimatedCostUsd: estimatedCost !== null
      ? Math.round(estimatedCost * 10000) / 10000
      : null,
    pricingSource: process.env['SAM_VM_PRICING_JSON']
      ? 'SAM_VM_PRICING_JSON env var'
      : 'default estimates',
    note: hourlyRate === null
      ? `Unknown VM size "${vmSize}" — pricing not available. Set SAM_VM_PRICING_JSON to configure.`
      : undefined,
  };
}

export async function getRemainingBudget(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  // Try to get budget info from control plane
  if (config.apiUrl && config.mcpToken && config.projectId) {
    try {
      const budget = await apiClient.callApi<{
        budgetUsd: number | null;
        spentUsd: number;
        remainingUsd: number | null;
      }>(`/api/workspace-context/${config.projectId}/budget`);
      return budget;
    } catch {
      // Budget endpoint may not exist yet — return a best-effort response
    }
  }

  return {
    budgetUsd: null,
    spentUsd: null,
    remainingUsd: null,
    note: 'Project cost budgets are not yet configured. This feature will be available in a future update.',
  };
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
