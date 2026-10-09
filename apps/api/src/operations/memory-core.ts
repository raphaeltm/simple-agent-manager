import { KNOWLEDGE_ENTITY_TYPES, type KnowledgeEntityType } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { normalizeSearchQuery } from '../lib/search-query-limits';
import * as agentProfileService from '../services/agent-profiles';
import * as projectDataService from '../services/project-data';
import { operationLink, operationPageLimit } from './connector-read-core';
import { OperationError } from './errors';
import { getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export async function searchKnowledge(
  ctx: OperationContext,
  input: {
    projectId: string;
    query: string;
    entityType?: string;
    minConfidence?: number;
    limit?: number;
  }
) {
  const limits = getPlatformOperationLimits(ctx.env);
  const inputQuery = typeof input.query === 'string' ? input.query.trim() : '';
  if (!inputQuery) throw new OperationError('invalid_input', 'query is required');
  const normalizedQuery = normalizeSearchQuery(inputQuery, ctx.env);
  let entityType: KnowledgeEntityType | null = null;
  if (input.entityType !== undefined) {
    if (
      typeof input.entityType !== 'string' ||
      !(KNOWLEDGE_ENTITY_TYPES as readonly string[]).includes(input.entityType)
    ) {
      throw new OperationError(
        'invalid_input',
        `Invalid entityType. Valid: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}`
      );
    }
    entityType = input.entityType as KnowledgeEntityType;
  }
  let minConfidence: number | null = null;
  if (input.minConfidence !== undefined) {
    if (
      typeof input.minConfidence !== 'number' ||
      !Number.isFinite(input.minConfidence) ||
      input.minConfidence < 0 ||
      input.minConfidence > 1
    ) {
      throw new OperationError(
        'invalid_input',
        'minConfidence must be a number between 0.0 and 1.0'
      );
    }
    minConfidence = input.minConfidence;
  }
  let limit = limits.knowledgeSearchLimit;
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit))
      throw new OperationError('invalid_input', 'limit must be a number');
    limit = Math.min(Math.max(1, Math.round(input.limit)), limits.knowledgeSearchLimit);
  }
  try {
    const results = await projectDataService.searchKnowledgeObservations(
      ctx.env,
      input.projectId,
      normalizedQuery.query,
      entityType,
      minConfidence,
      limit
    );
    return { results, count: results.length, ...normalizedQuery };
  } catch (error) {
    throw new OperationError(
      'unavailable',
      `Failed to search knowledge: ${(error as Error).message}`
    );
  }
}

export async function listProfiles(
  ctx: OperationContext,
  projectId: string,
  input: { limit?: number; cursor?: string; query?: string } = {}
) {
  const db = drizzle(ctx.env.DATABASE, { schema });
  let profiles;
  try {
    profiles = await agentProfileService.listProfiles(db, projectId, ctx.actor.userId, ctx.env);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 403 || status === 409) {
      throw new OperationError('invalid_input', (error as Error).message);
    }
    throw new OperationError('unavailable', `Failed to list profiles: ${(error as Error).message}`);
  }
  const external = ctx.actor.via !== 'workspace-agent';
  const matching = external
    ? profiles
        .filter(
          (profile) =>
            !input.query ||
            `${profile.name} ${profile.description ?? ''}`
              .toLowerCase()
              .includes(input.query.toLowerCase())
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((profile) => !input.cursor || profile.id > input.cursor)
    : profiles;
  const limit = operationPageLimit(ctx, input.limit);
  const page = external ? matching.slice(0, limit) : matching;
  return {
    ...(external ? { nextCursor: matching.length > limit ? (page.at(-1)?.id ?? null) : null } : {}),
    profiles: page.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      agentType: profile.agentType,
      model: profile.model,
      effort: profile.effort,
      isBuiltin: profile.isBuiltin,
      ...(ctx.actor.via !== 'workspace-agent'
        ? {
            runtime: profile.runtime,
            taskMode: profile.taskMode,
            link: operationLink(ctx, projectId),
          }
        : {}),
    })),
    count: page.length,
  };
}
