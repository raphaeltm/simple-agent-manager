/**
 * Child-task description assembly for MCP dispatch: the caller's description,
 * optional references, and (inside a mission) the inherited active policies,
 * capped at the dispatch description limit after concatenation.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import { coordinationChannelSection } from './dispatch-coordination-channel';

export interface BuildDispatchDescriptionInput {
  projectId: string;
  description: string;
  references: readonly string[];
  missionId: string | null;
  coordinationChannel: string | null;
  maxLength: number;
}

export async function buildDispatchDescription(
  env: Env,
  input: BuildDispatchDescriptionInput
): Promise<string> {
  let fullDescription = input.description;
  if (input.references.length > 0) {
    fullDescription += '\n\n## References\n' + input.references.map((r) => `- ${r}`).join('\n');
  }
  // Before inherited policies, so a long policy list cannot truncate it away.
  if (input.coordinationChannel) {
    fullDescription += '\n\n' + coordinationChannelSection(input.coordinationChannel);
  }

  // ── Propagate active project policies to child tasks ──────────────────
  // When dispatching within a mission, append active policies so sub-agents
  // inherit the same rules/constraints without needing to call get_instructions.
  if (input.missionId) {
    try {
      const activePolicies = await projectDataService.getActivePolicies(env, input.projectId);
      if (activePolicies.length > 0) {
        const categoryLabels: Record<string, string> = {
          rule: 'RULE',
          constraint: 'CONSTRAINT',
          delegation: 'DELEGATION',
          preference: 'PREFERENCE',
        };
        const policyLines = activePolicies.map(
          (p) =>
            `- [${categoryLabels[p.category] || p.category.toUpperCase()}] ${p.title}: ${p.content}`
        );
        fullDescription += '\n\n## Project Policies (inherited)\n' + policyLines.join('\n');
      }
    } catch (err) {
      log.warn('mcp.dispatch_task.policy_propagation_failed', {
        projectId: input.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Enforce length limit on the final description (after reference + policy concatenation)
  if (fullDescription.length > input.maxLength) {
    fullDescription = fullDescription.slice(0, input.maxLength);
  }
  return fullDescription;
}
