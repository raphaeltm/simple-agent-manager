/**
 * SAM add_knowledge tool — add knowledge entity/observation to a project's graph.
 */
import { KNOWLEDGE_ENTITY_TYPES, KNOWLEDGE_SOURCE_TYPES } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

const MAX_OBSERVATION_LENGTH = 1000;
const MAX_ENTITY_NAME_LENGTH = 200;

export const addKnowledgeDef: AnthropicToolDef = {
  name: 'add_knowledge',
  description:
    'Add knowledge to a project\'s knowledge graph. Creates the entity if it doesn\'t exist, ' +
    'then adds observations (facts) to it. Use this to remember user preferences, project context, ' +
    'architectural decisions, and other persistent information.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to add knowledge to.',
      },
      entityName: {
        type: 'string',
        description: 'The name of the knowledge entity (e.g., "User", "Architecture", "CodeStyle").',
      },
      entityType: {
        type: 'string',
        enum: [...KNOWLEDGE_ENTITY_TYPES],
        description: 'The type of entity (preference, style, context, expertise, workflow, personality, custom).',
      },
      observations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of observation strings to add to the entity. Each is a fact or preference.',
      },
      sourceType: {
        type: 'string',
        enum: [...KNOWLEDGE_SOURCE_TYPES],
        description: 'How this knowledge was acquired. Defaults to "explicit".',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score (0.0 to 1.0). Defaults to 0.9 for explicit, 0.7 for inferred.',
      },
    },
    required: ['projectId', 'entityName', 'entityType', 'observations'],
  },
};

export async function addKnowledge(
  input: {
    projectId: string;
    entityName: string;
    entityType: string;
    observations: string[];
    sourceType?: string;
    confidence?: number;
  },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  const entityName = input.entityName?.trim().slice(0, MAX_ENTITY_NAME_LENGTH);
  if (!entityName) {
    return { error: 'entityName is required.' };
  }
  if (!input.entityType || !KNOWLEDGE_ENTITY_TYPES.includes(input.entityType as (typeof KNOWLEDGE_ENTITY_TYPES)[number])) {
    return { error: `entityType must be one of: ${KNOWLEDGE_ENTITY_TYPES.join(', ')}` };
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    return { error: 'observations must be a non-empty array of strings.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

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

  const sourceType = input.sourceType && KNOWLEDGE_SOURCE_TYPES.includes(input.sourceType as (typeof KNOWLEDGE_SOURCE_TYPES)[number])
    ? input.sourceType
    : 'explicit';
  const defaultConfidence = sourceType === 'explicit' ? 0.9 : 0.7;
  const confidence = typeof input.confidence === 'number'
    ? Math.min(Math.max(0, input.confidence), 1)
    : defaultConfidence;

  // Get or create entity
  const existingEntity = await projectDataService.getKnowledgeEntityByName(env, input.projectId, entityName);
  let entityId: string;
  if (!existingEntity) {
    const created = await projectDataService.createKnowledgeEntity(
      env, input.projectId, entityName, input.entityType, null,
    );
    entityId = created.id;
  } else {
    entityId = existingEntity.id;
  }

  // Add each observation
  const addedObservations: Array<{ id: string }> = [];
  for (const obs of input.observations) {
    const trimmed = obs?.trim().slice(0, MAX_OBSERVATION_LENGTH);
    if (!trimmed) continue;
    const result = await projectDataService.addKnowledgeObservation(
      env, input.projectId, entityId, trimmed, confidence, sourceType, null,
    );
    addedObservations.push({ id: result.id });
  }

  return {
    entityId,
    entityName,
    entityType: input.entityType,
    observationsAdded: addedObservations.length,
    observationIds: addedObservations.map(o => o.id),
    confidence,
    sourceType,
  };
}
