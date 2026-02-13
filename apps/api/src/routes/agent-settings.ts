import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import {
  isValidAgentType,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import type {
  AgentSettingsResponse,
  SaveAgentSettingsRequest,
  AgentPermissionMode,
} from '@simple-agent-manager/shared';

export const agentSettingsRoutes = new Hono<{ Bindings: Env }>();

// All agent settings routes require authentication
agentSettingsRoutes.use('/*', requireAuth());

/**
 * Convert a DB row to an API response.
 * JSON-encoded columns (allowedTools, deniedTools, additionalEnv) are parsed.
 */
function toResponse(row: schema.AgentSettingsRow): AgentSettingsResponse {
  return {
    agentType: row.agentType,
    model: row.model,
    permissionMode: row.permissionMode as AgentPermissionMode | null,
    allowedTools: row.allowedTools ? JSON.parse(row.allowedTools) : null,
    deniedTools: row.deniedTools ? JSON.parse(row.deniedTools) : null,
    additionalEnv: row.additionalEnv ? JSON.parse(row.additionalEnv) : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

/**
 * GET /api/agent-settings/:agentType
 * Retrieve user's settings for a specific agent type.
 */
agentSettingsRoutes.get('/:agentType', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest(`Invalid agent type: ${agentType}`);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select()
    .from(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, userId),
        eq(schema.agentSettings.agentType, agentType)
      )
    )
    .limit(1);

  if (!rows[0]) {
    // Return default empty settings (no row exists yet)
    return c.json({
      agentType,
      model: null,
      permissionMode: null,
      allowedTools: null,
      deniedTools: null,
      additionalEnv: null,
      createdAt: null,
      updatedAt: null,
    } as AgentSettingsResponse);
  }

  return c.json(toResponse(rows[0]));
});

/**
 * PUT /api/agent-settings/:agentType
 * Upsert user's settings for a specific agent type.
 */
agentSettingsRoutes.put('/:agentType', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest(`Invalid agent type: ${agentType}`);
  }

  const body = await c.req.json<SaveAgentSettingsRequest>();

  // Validate permissionMode if provided
  if (body.permissionMode !== undefined && body.permissionMode !== null) {
    if (!VALID_PERMISSION_MODES.includes(body.permissionMode as any)) {
      throw errors.badRequest(
        `Invalid permission mode: ${body.permissionMode}. Must be one of: ${VALID_PERMISSION_MODES.join(', ')}`
      );
    }
  }

  // Validate allowedTools / deniedTools are arrays of strings if provided
  if (body.allowedTools !== undefined && body.allowedTools !== null) {
    if (!Array.isArray(body.allowedTools) || !body.allowedTools.every((t) => typeof t === 'string')) {
      throw errors.badRequest('allowedTools must be an array of strings');
    }
  }
  if (body.deniedTools !== undefined && body.deniedTools !== null) {
    if (!Array.isArray(body.deniedTools) || !body.deniedTools.every((t) => typeof t === 'string')) {
      throw errors.badRequest('deniedTools must be an array of strings');
    }
  }

  // Validate additionalEnv is a record of string -> string
  if (body.additionalEnv !== undefined && body.additionalEnv !== null) {
    if (typeof body.additionalEnv !== 'object' || Array.isArray(body.additionalEnv)) {
      throw errors.badRequest('additionalEnv must be an object');
    }
    for (const [key, value] of Object.entries(body.additionalEnv)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw errors.badRequest('additionalEnv must be a Record<string, string>');
      }
    }
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date();

  // Check if settings already exist
  const existing = await db
    .select({ id: schema.agentSettings.id })
    .from(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, userId),
        eq(schema.agentSettings.agentType, agentType)
      )
    )
    .limit(1);

  const values = {
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
    allowedTools: body.allowedTools ? JSON.stringify(body.allowedTools) : null,
    deniedTools: body.deniedTools ? JSON.stringify(body.deniedTools) : null,
    additionalEnv: body.additionalEnv ? JSON.stringify(body.additionalEnv) : null,
    updatedAt: now,
  };

  if (existing[0]) {
    // Update existing row
    await db
      .update(schema.agentSettings)
      .set(values)
      .where(eq(schema.agentSettings.id, existing[0].id));
  } else {
    // Insert new row
    await db.insert(schema.agentSettings).values({
      id: ulid(),
      userId,
      agentType,
      ...values,
      createdAt: now,
    });
  }

  // Re-fetch and return
  const rows = await db
    .select()
    .from(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, userId),
        eq(schema.agentSettings.agentType, agentType)
      )
    )
    .limit(1);

  const status = existing[0] ? 200 : 201;
  return c.json(toResponse(rows[0]!), status);
});

/**
 * DELETE /api/agent-settings/:agentType
 * Reset user's settings for a specific agent type (delete the row).
 */
agentSettingsRoutes.delete('/:agentType', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest(`Invalid agent type: ${agentType}`);
  }

  const db = drizzle(c.env.DATABASE, { schema });
  await db
    .delete(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, userId),
        eq(schema.agentSettings.agentType, agentType)
      )
    );

  return c.json({ success: true });
});
