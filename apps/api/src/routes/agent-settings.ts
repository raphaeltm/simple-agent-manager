import type {
  AgentPermissionMode,
  AgentProviderMode,
  AgentSettingsResponse,
  OpenCodeProvider,
} from '@simple-agent-manager/shared';
import {
  isValidAgentType,
  OPENCODE_PROVIDERS,
  resolveOpenCodeProvider,
  VALID_AGENT_PROVIDER_MODES,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  AGENT_SETTINGS_VALIDATION_DEFAULTS,
  type AgentSettingsValidationLimits,
  createSaveAgentSettingsSchema,
  formatIssues,
} from '../schemas';

export const agentSettingsRoutes = new Hono<{ Bindings: Env }>();
type AgentSettingsBody = v.InferOutput<ReturnType<typeof createSaveAgentSettingsSchema>>;

// All agent settings routes require authentication
agentSettingsRoutes.use('/*', requireAuth(), requireApproved());

function parseJsonColumn(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function stringArrayFromJson(raw: string | null): string[] | null {
  const parsed = parseJsonColumn(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    return null;
  }
  return parsed;
}

function stringRecordFromJson(raw: string | null): Record<string, string> | null {
  const parsed = parseJsonColumn(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return null;
    }
    result[key] = value;
  }
  return result;
}

function isAgentPermissionMode(raw: string | null): raw is AgentPermissionMode {
  return raw !== null && VALID_PERMISSION_MODES.some((mode) => mode === raw);
}

function isOpenCodeProvider(raw: string | null): raw is OpenCodeProvider {
  return raw !== null && Object.prototype.hasOwnProperty.call(OPENCODE_PROVIDERS, raw);
}

function permissionModeFromDb(raw: string | null): AgentPermissionMode | null {
  return isAgentPermissionMode(raw) ? raw : null;
}

function opencodeProviderFromDb(raw: string | null): OpenCodeProvider | null {
  return isOpenCodeProvider(raw) ? resolveOpenCodeProvider(raw) : null;
}

function isAgentProviderMode(raw: string | null): raw is AgentProviderMode {
  return raw !== null && (VALID_AGENT_PROVIDER_MODES as readonly string[]).includes(raw);
}

function providerModeFromDb(raw: string | null): AgentProviderMode | null {
  return isAgentProviderMode(raw) ? raw : null;
}

function getAgentSettingsValidationLimits(env: Env): AgentSettingsValidationLimits {
  if (!env.AGENT_SETTINGS_VALIDATION_LIMITS) {
    return AGENT_SETTINGS_VALIDATION_DEFAULTS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.AGENT_SETTINGS_VALIDATION_LIMITS);
  } catch {
    return AGENT_SETTINGS_VALIDATION_DEFAULTS;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return AGENT_SETTINGS_VALIDATION_DEFAULTS;
  }

  const limits = { ...AGENT_SETTINGS_VALIDATION_DEFAULTS };
  const overrides = parsed as Partial<Record<keyof AgentSettingsValidationLimits, unknown>>;
  const limitKeys = Object.keys(limits) as Array<keyof AgentSettingsValidationLimits>;

  for (const key of limitKeys) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      limits[key] = Math.trunc(value);
    }
  }

  return limits;
}

async function parseAgentSettingsBody(
  c: Context<{ Bindings: Env }>
): Promise<AgentSettingsBody | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes('JSON'))) {
      return c.json(
        {
          error: 'BAD_REQUEST',
          message: 'Invalid JSON in request body',
        },
        400
      );
    }
    throw err;
  }

  const parsed = v.safeParse(
    createSaveAgentSettingsSchema(getAgentSettingsValidationLimits(c.env)),
    body
  );
  if (!parsed.success) {
    return c.json(
      {
        error: 'BAD_REQUEST',
        message: formatIssues(parsed.issues),
      },
      400
    );
  }

  return parsed.output;
}

/**
 * Convert a DB row to an API response.
 * JSON-encoded columns (allowedTools, deniedTools, additionalEnv) are parsed.
 */
function toResponse(row: schema.AgentSettingsRow): AgentSettingsResponse {
  return {
    agentType: row.agentType,
    model: row.model,
    permissionMode: permissionModeFromDb(row.permissionMode),
    allowedTools: stringArrayFromJson(row.allowedTools),
    deniedTools: stringArrayFromJson(row.deniedTools),
    additionalEnv: stringRecordFromJson(row.additionalEnv),
    opencodeProvider: opencodeProviderFromDb(row.opencodeProvider),
    opencodeBaseUrl: row.opencodeBaseUrl ?? null,
    opencodeProviderName: row.opencodeProviderName ?? null,
    providerMode: providerModeFromDb(row.providerMode),
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
      opencodeProvider: null,
      opencodeBaseUrl: null,
      opencodeProviderName: null,
      providerMode: null,
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

  const parsedBody = await parseAgentSettingsBody(c);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }
  const body = parsedBody;

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

  // Clear opencodeBaseUrl when switching to a provider that doesn't need it
  const requiresBaseUrl = (provider: OpenCodeProvider | null | undefined) =>
    provider ? OPENCODE_PROVIDERS[provider].requiresBaseUrl : false;

  const values = {
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
    allowedTools: body.allowedTools ? JSON.stringify(body.allowedTools) : null,
    deniedTools: body.deniedTools ? JSON.stringify(body.deniedTools) : null,
    additionalEnv: body.additionalEnv ? JSON.stringify(body.additionalEnv) : null,
    opencodeProvider: body.opencodeProvider ?? null,
    opencodeBaseUrl: requiresBaseUrl(body.opencodeProvider)
      ? (body.opencodeBaseUrl ?? null)
      : null,
    opencodeProviderName: body.opencodeProviderName ?? null,
    providerMode: body.providerMode ?? null,
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
  const saved = rows[0];
  if (!saved) {
    throw errors.internal('Agent settings save did not return a row');
  }
  return c.json(toResponse(saved), status);
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
