/**
 * Per-session rate limit for the agent Insights tool (`project_insights` on sam-mcp, Insights slice
 * I). Runtime settings rather than Worker vars (`.claude/rules/07`, "Dynamic runtime settings");
 * listed under "Operations" in Admin → Settings. The definitions carry no imports so the admin
 * settings registry can depend on them.
 */
import type { OperationContext } from './types';

export const INSIGHTS_AGENT_SETTINGS = [
  {
    name: 'insights.agentToolCallsPerWindow',
    defaultValue: 30,
    description:
      'Calls one agent chat may make to the project_insights tool per window. Further calls are refused until the window ends.',
    range: { min: 1, max: 1000 },
  },
  {
    name: 'insights.agentToolWindowSeconds',
    defaultValue: 600,
    description: 'Length in seconds of the project_insights per-chat rate-limit window.',
    range: { min: 10, max: 86_400 },
  },
] as const;

export type InsightsAgentSettingName = (typeof INSIGHTS_AGENT_SETTINGS)[number]['name'];

export interface InsightsAgentRateLimit {
  callsPerWindow: number;
  windowSeconds: number;
}

/** Each value falls back to its code default when settings storage cannot be read. */
export async function getInsightsAgentRateLimit(
  ctx: Pick<OperationContext, 'ports'>
): Promise<InsightsAgentRateLimit> {
  let values: unknown[];
  try {
    values = (
      await ctx.ports.settings.resolveDetailsMany(INSIGHTS_AGENT_SETTINGS.map((s) => s.name))
    ).map((row) => row.value);
  } catch {
    values = INSIGHTS_AGENT_SETTINGS.map((s) => s.defaultValue);
  }
  const [calls, window] = INSIGHTS_AGENT_SETTINGS.map((setting, index) => {
    const value = values[index];
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= setting.range.min &&
      value <= setting.range.max
      ? value
      : setting.defaultValue;
  });
  return {
    callsPerWindow: calls ?? INSIGHTS_AGENT_SETTINGS[0].defaultValue,
    windowSeconds: window ?? INSIGHTS_AGENT_SETTINGS[1].defaultValue,
  };
}
