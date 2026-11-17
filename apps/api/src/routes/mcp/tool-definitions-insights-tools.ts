/**
 * MCP tool definition — `project_insights` (Insights slice I). The tool runs the catalog operation
 * `sam_project_insights` (`packages/operations/src/insights-agent.ts`); this JSON schema mirrors
 * that operation's input minus `projectId`, which always comes from the MCP token. A test keeps the
 * two in step (`tests/unit/routes/mcp/project-insights-tool.test.ts`).
 */
import { PROJECT_INSIGHTS_METHODS } from '@simple-agent-manager/operations';
import { INSIGHTS_RANGES, INSIGHTS_SETUP_GROUPINGS } from '@simple-agent-manager/shared';

export const INSIGHTS_TOOLS = [
  {
    name: 'project_insights',
    description:
      "Numbers about this project's runs, for sizing and planning work. method: receipt (taskId: one run's phases, CI state, peak memory vs requested, tokens), flow (range: CI first-try pass rate, flaky checks, why runs stopped), setups (range, groupBy: memory p90 vs requested, median to PR, tokens per merged PR per profile/skill/model), phases (skillId or agentProfileId: usual phase durations), accounts (range: account limit windows and limit stalls). Rate-limited per chat.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', enum: [...PROJECT_INSIGHTS_METHODS] },
        taskId: { type: 'string', description: 'receipt: the task to read.' },
        range: {
          type: 'string',
          enum: [...INSIGHTS_RANGES],
          description: 'flow, setups, accounts: window (default 30d).',
        },
        groupBy: {
          type: 'string',
          enum: [...INSIGHTS_SETUP_GROUPINGS],
          description: 'setups: grouping (default profile).',
        },
        skillId: { type: 'string', description: 'phases: one skill (or agentProfileId).' },
        agentProfileId: { type: 'string', description: 'phases: one agent profile.' },
        operation: {
          type: 'string',
          description: 'phases: only workspace, wake, sleep, runner_start or runner_wake.',
        },
        phaseNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'phases: only these phases (default all).',
        },
        windowDays: { type: 'number', description: 'phases: days back (default 30).' },
      },
      required: ['method'],
      additionalProperties: false,
    },
  },
];
