/**
 * SAM add_policy tool — add a policy to a project.
 */
import type { PolicyScope } from '@simple-agent-manager/shared';
import {
  isPolicyCategory,
  isPolicyScope,
  POLICY_SCOPES,
  resolvePolicyLimits,
  validatePolicyLifecycle,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

export const addPolicyDef: AnthropicToolDef = {
  name: 'add_policy',
  description:
    'Add a policy to a project. Policies guide agent behavior — rules are mandatory, ' +
    'constraints are limits, delegations define authority, preferences are soft guidance. ' +
    'Confirm with the user before adding policies.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to add the policy to.',
      },
      title: {
        type: 'string',
        description: 'Short title for the policy.',
      },
      content: {
        type: 'string',
        description: 'The full policy text — what the rule/constraint/preference says.',
      },
      category: {
        type: 'string',
        enum: ['rule', 'constraint', 'delegation', 'preference'],
        description: 'The policy category: rule (mandatory), constraint (limit), delegation (authority), preference (soft guidance).',
      },
      scope: {
        type: 'string',
        enum: [...POLICY_SCOPES],
        description:
          "How long this policy applies. 'always' (default) is a standing policy injected into every future session. " +
          "'task' is a one-shot policy captured for a specific piece of work (\"use profile X for the 2026-08-21 wave\") " +
          'and REQUIRES expiresAt, so it cannot outlive the work it was captured for.',
      },
      expiresAt: {
        type: 'number',
        description:
          'Epoch milliseconds after which this policy stops being injected into sessions. Omit for a policy that never expires. ' +
          'Must be in the future. Required when scope is "task".',
      },
    },
    required: ['projectId', 'title', 'content', 'category'],
  },
};

export async function addPolicy(
  input: {
    projectId: string;
    title: string;
    content: string;
    category: string;
    scope?: string;
    expiresAt?: number | null;
  },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.title?.trim()) {
    return { error: 'title is required.' };
  }
  if (!input.content?.trim()) {
    return { error: 'content is required.' };
  }
  if (!isPolicyCategory(input.category)) {
    return { error: 'category must be one of: rule, constraint, delegation, preference' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const limits = resolvePolicyLimits(env);

  // Lifecycle (scope + expiry), validated through the same shared helper the MCP and
  // REST write boundaries use, so this third writer cannot drift from them (rule 24).
  if (input.scope !== undefined && !isPolicyScope(input.scope)) {
    return { error: `scope must be one of: ${POLICY_SCOPES.join(', ')}` };
  }
  const scope: PolicyScope = (input.scope as PolicyScope | undefined) ?? 'always';
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    return { error: 'expiresAt must be a number (epoch milliseconds) or null' };
  }
  const lifecycleError = validatePolicyLifecycle({
    scope,
    expiresAt,
    now: Date.now(),
    maxExpiryMs: limits.maxExpiryMs,
  });
  if (lifecycleError) {
    return { error: lifecycleError };
  }

  // Verify ownership
  const project = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .get();

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  const title = input.title.trim().slice(0, limits.titleMaxLength);
  const content = input.content.trim().slice(0, limits.contentMaxLength);

  const result = await projectDataService.createPolicy(
    env, input.projectId,
    input.category as 'rule' | 'constraint' | 'delegation' | 'preference',
    title, content, 'explicit', null, limits.defaultConfidence,
    scope, expiresAt,
  );

  return {
    id: result.id,
    projectId: input.projectId,
    category: input.category,
    title,
    source: 'explicit',
    confidence: limits.defaultConfidence,
    scope,
    expiresAt,
    createdAt: result.now,
  };
}
