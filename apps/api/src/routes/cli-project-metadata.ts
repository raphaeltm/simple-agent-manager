import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas/_validator';
import { createProfile, getProfile } from '../services/agent-profiles';
import { cliOperationReceipt } from '../services/cli-operation-receipts';
import { createSkill, getSkill } from '../services/skills';
import { normalizeProjectName } from './projects/_helpers';

// Deliberately separate from the full UI configuration schemas. Mixed benign /
// sensitive payloads are rejected at the server boundary, including nested keys.
const createSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1)),
  description: v.optional(v.nullable(v.string())),
});
const updateSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  description: v.optional(v.nullable(v.string())),
  expectedUpdatedAt: v.string(),
});
export const cliProjectMetadataRoutes = new Hono<{ Bindings: Env }>();
for (const family of ['profiles', 'skills'] as const) {
  cliProjectMetadataRoutes.post(
    `/${family}`,
    requireAuth(),
    requireApproved(),
    jsonValidator(createSchema),
    async (c, next) => {
      await requireProjectCapability(
        drizzle(c.env.DATABASE, { schema }),
        requireRouteParam(c, 'projectId'),
        getUserId(c),
        'project:update'
      );
      return cliOperationReceipt(c, next);
    },
    async (c) => {
      const db = drizzle(c.env.DATABASE, { schema });
      const projectId = requireRouteParam(c, 'projectId');
      const body = c.req.valid('json');
      const created =
        family === 'profiles'
          ? await createProfile(db, projectId, getUserId(c), body, c.env)
          : await createSkill(db, projectId, getUserId(c), body, c.env);
      return c.json(created, 201);
    }
  );
  cliProjectMetadataRoutes.patch(
    `/${family}/:id`,
    requireAuth(),
    requireApproved(),
    jsonValidator(updateSchema),
    async (c) => {
      const projectId = requireRouteParam(c, 'projectId');
      const id = requireRouteParam(c, 'id');
      const userId = getUserId(c);
      const db = drizzle(c.env.DATABASE, { schema });
      await requireProjectCapability(db, projectId, userId, 'project:update');
      const before =
        family === 'profiles'
          ? await getProfile(db, projectId, id, userId)
          : await getSkill(db, projectId, id, userId);
      if (before.projectId !== projectId)
        throw errors.badRequest('Global resources require their own scope');
      if (family === 'skills' && 'isBuiltin' in before && before.isBuiltin)
        throw errors.badRequest('Builtin skills cannot be modified');
      const body = c.req.valid('json');
      if (body.name === undefined && body.description === undefined)
        throw errors.badRequest('No metadata fields specified');
      // Table identifiers are fixed by the registered route, never caller input.
      const table = family === 'profiles' ? 'agent_profiles' : 'skills';
      if (body.name !== undefined) {
        const duplicate = await c.env.DATABASE.prepare(
          `SELECT id FROM ${table} WHERE project_id = ? AND lower(name) = lower(?) AND id != ?`
        )
          .bind(projectId, body.name, id)
          .first();
        if (duplicate) throw errors.conflict('Name already exists in project');
      }
      const fields: string[] = ['updated_at = ?'];
      const values: (string | null)[] = [nextMetadataTimestamp(body.expectedUpdatedAt)];
      if (body.name !== undefined) {
        fields.push('name = ?');
        values.push(body.name);
      }
      if (body.description !== undefined) {
        fields.push('description = ?');
        values.push(body.description);
      }
      const result = await c.env.DATABASE.prepare(
        `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ? AND project_id = ? AND updated_at = ?`
      )
        .bind(...values, id, projectId, body.expectedUpdatedAt)
        .run();
      if (!result.meta.changes)
        throw errors.conflict('Resource changed; inspect and explicitly retry');
      return c.json(
        family === 'profiles'
          ? await getProfile(db, projectId, id, userId)
          : await getSkill(db, projectId, id, userId)
      );
    }
  );
}
cliProjectMetadataRoutes.patch(
  '/settings',
  requireAuth(),
  requireApproved(),
  jsonValidator(updateSchema),
  async (c) => {
    const projectId = requireRouteParam(c, 'projectId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, getUserId(c), 'project:update');
    const body = c.req.valid('json');
    if (body.name === undefined && body.description === undefined)
      throw errors.badRequest('No metadata fields specified');
    const fields: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [nextMetadataTimestamp(body.expectedUpdatedAt)];
    if (body.name !== undefined) {
      const normalizedName = normalizeProjectName(body.name);
      const duplicate = await c.env.DATABASE.prepare(
        `SELECT id FROM projects
         WHERE user_id = (SELECT user_id FROM projects WHERE id = ?)
           AND normalized_name = ? AND id != ?`
      )
        .bind(projectId, normalizedName, projectId)
        .first();
      if (duplicate) throw errors.conflict('Project name must be unique per user');
      fields.push('name = ?', 'normalized_name = ?');
      values.push(body.name, normalizedName);
    }
    if (body.description !== undefined) {
      fields.push('description = ?');
      values.push(body.description);
    }
    const result = await c.env.DATABASE.prepare(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = ? AND updated_at = ?`
    )
      .bind(...values, projectId, body.expectedUpdatedAt)
      .run();
    if (!result.meta.changes)
      throw errors.conflict('Project changed; inspect and explicitly retry');
    return c.json({
      updated: true,
      projectId,
      fields: { name: body.name, description: body.description },
    });
  }
);

function nextMetadataTimestamp(expected: string): string {
  const previous = Date.parse(expected);
  return new Date(
    Number.isFinite(previous) ? Math.max(Date.now(), previous + 1) : Date.now()
  ).toISOString();
}
